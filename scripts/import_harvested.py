#!/usr/bin/env python3
"""import_harvested.py — attach harvested persons to existing faces (design §9).

Merges one harvest staging DB (§8, schema v1.1) into a **vacuumed copy** of
faces.db.  Recovery of legacy work, not an import: it never creates images
or faces, never adds detections.  Invariants:

  J1  the original faces.db is never written — the target is a fresh
      VACUUM INTO copy (data/faces-YYYYmmdd-HHMMSS.db); report files are
      written next to the copy.  The user opens the app against the copy
      (e.g. via a symlink) and decides whether to promote it.
  J2  image identity is the BLAKE3 hash, exactly: a harvested face
      participates only when staging images.content_hash EQUALS
      faces.db images.content_hash.  No path/size fallbacks.
  J3  only faces with geometry (the staging schema is v1.1; other
      versions are refused).
  J4  only faces that are link_status='provisional' AND state != 'discarded'
      receive a person — unless --overwrite, which makes every face
      eligible (the user's prior link is assumed invalid).  No user entity
      is ever deleted.
  J5  a face the script assigns gets link_status='provisional',
      reassigned=0: the harvested link is a suggestion the user confirms
      in the GUI.

Matching (§9.3): harvested rectangles are converted into the canonical
decode space (§9.2) and matched one-to-one per image by
IoU = |A∩B|/|A∪B| >= --min-overlap (default 0.60), greedy best-first.
UnknownN clusters are merged whole only on unanimous evidence (§9.5).

Usage:
  scripts/import_harvested.py STAGING.db [--faces-db data/faces.db]
      [--min-overlap 0.60] [--overwrite] [--dry-run] [-q]

Console (scripts-design §10): startup header, status updates, final summary;
-q/--quiet prints only the header and the final summary.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
from pathlib import Path

import cli_console  # shared header/status/quiet console (scripts-design §10)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STAGING_SCHEMA_VERSION = "1.1"     # §8.2, exact-match (J3)
FACES_SCHEMA_VERSION = "1.5"       # database/schema.sql, exact-match
GROUP_ROOTS = {"people", "person"}  # stripped from harvested paths (§9.4)
UNKNOWN_NAME_RE = re.compile(r"^Unknown\d+$")


# module-level console: library callers (tests) get plain status output;
# main() swaps in the -q-aware instance (scripts-design §10.7)
_CONSOLE = cli_console.Console()


def log(msg: str) -> None:
    _CONSOLE.status(msg)


def now() -> str:
    """UTC, same convention as import_roll.py (design #40)."""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())


# ---------------------------------------------------------------------- env

def load_env(path: Path) -> dict[str, str]:
    """Parse KEY=VALUE lines with ${VAR} references; no external dependency."""
    raw: dict[str, str] = {}
    if not path.exists():
        return raw
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        raw[key.strip()] = val.strip().strip('"').strip("'")
    for _ in range(4):                      # resolve nested ${VAR}
        for k, v in raw.items():
            if "${" in v:
                for ref, rv in raw.items():
                    v = v.replace("${" + ref + "}", rv)
                raw[k] = v
    for k, v in raw.items():                # then references to the real
        if "${" in v:                       # environment (${HOME}, ${USER})
            for ref, rv in os.environ.items():
                v = v.replace("${" + ref + "}", rv)
            raw[k] = v
    return raw


# ---------------------------------------------------------- pure geometry (§9.2/9.3)

def iou(a: tuple[float, float, float, float],
        b: tuple[float, float, float, float]) -> float:
    """|A∩B| / |A∪B| for corner boxes (x, y, w, h); 0.0 when disjoint."""
    ax2, ay2 = a[0] + a[2], a[1] + a[3]
    bx2, by2 = b[0] + b[2], b[1] + b[3]
    ix = max(0.0, min(ax2, bx2) - max(a[0], b[0]))
    iy = max(0.0, min(ay2, by2) - max(a[1], b[1]))
    inter = ix * iy
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def convert_box(x: float, y: float, w: float, h: float, unit: str,
                img_w: int | None, img_h: int | None,
                db_w: int, db_h: int,
                inversion: str = "none") -> tuple[float, float, float, float] | None:
    """Harvested box -> decode-space box (§9.2). None when degenerate.

    Normalised fractions are multiplied by the file dimensions (the
    source-stated img_w/img_h when given, else the db's decode dims —
    equal to the file dims while inversion='none', which is what
    import_roll writes).  Pixel boxes are already file-space.  A recorded
    inversion maps file space -> decode space via the inverse flip.
    """
    if unit == "normalized":
        W = float(img_w or db_w)
        H = float(img_h or db_h)
        x, y, w, h = x * W, y * H, w * W, h * H
    elif unit != "pixels":
        return None
    if inversion in ("lr", "both"):
        x = db_w - (x + w)
    if inversion in ("tb", "both"):
        y = db_h - (y + h)
    if w <= 0 or h <= 0:
        return None
    return (x, y, w, h)


def strip_group_root(path: str, person: str | None = None) -> str | None:
    """Staging keyword path -> faces.db group path (§9.4).

    'People|Family|X' -> 'Family|X'. None when nothing remains.

    v2.1 (#80): staging paths are keyword/tag paths whose LAST segment
    is the person's own name by construction (§8); faces.db group
    paths name the groups ABOVE the person, never the person itself
    (gui-design §3/§4.1). With the person's name given, a trailing
    segment equal to it is dropped: 'People|Family|Winnie Pelser' ->
    'Family', 'People|Winnie Pelser' -> ungrouped (None). A trailing
    segment that does not equal the name is kept (capture, never
    guessed — §8 H4).
    """
    parts = [p for p in path.split("|") if p != ""]
    if parts and parts[0].casefold() in GROUP_ROOTS:
        parts = parts[1:]
    if person is not None and parts and parts[-1] == person:
        parts = parts[:-1]
    return "|".join(parts) if parts else None


def next_free_name(taken: set[str], name: str) -> str:
    """Smallest 'Name 2', 'Name 3', ... not in *taken* (§9.4 collision)."""
    if name not in taken:
        return name
    n = 2
    while f"{name} {n}" in taken:
        n += 1
    return f"{name} {n}"


# ---------------------------------------------------------------- connections

def open_ro(db_path: Path, immutable: bool = False) -> sqlite3.Connection:
    uri = "file:" + urllib.parse.quote(str(db_path)) + "?mode=ro" \
        + ("&immutable=1" if immutable else "")
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    return con


def check_version(con: sqlite3.Connection, want: str, what: str) -> None:
    row = con.execute("SELECT version FROM schema_version").fetchone()
    got = row[0] if row else None
    if got != want:
        raise SystemExit(
            f"{what} schema version mismatch: want {want}, got {got!r} — "
            f"refusing to continue (exact match, no migrations)")


def make_target_copy(faces_db: Path) -> Path:
    """VACUUM INTO a fresh datetime-stamped sibling (J1). Never overwrites."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = faces_db.parent / f"faces-{stamp}.db"
    n = 1
    while target.exists():
        n += 1
        target = faces_db.parent / f"faces-{stamp}-{n}.db"
    src = open_ro(faces_db)
    try:
        src.execute("VACUUM INTO ?", (str(target),))
    finally:
        src.close()
    return target


# ------------------------------------------------------------------- planning

class Report:
    """Counters plus per-item detail lines (§9.6)."""

    def __init__(self) -> None:
        self.counters: dict[str, int] = {}
        self.details: list[str] = []

    def add(self, key: str, n: int = 1) -> None:
        self.counters[key] = self.counters.get(key, 0) + n

    def skip(self, reason: str, info: str) -> None:
        self.add(reason)
        self.details.append(f"{reason}: {info}")

    def to_json(self) -> str:
        return json.dumps({"counters": self.counters,
                           "details": self.details}, indent=2)


def load_staging(con: sqlite3.Connection):
    """(images, faces, persons, groups) out of the staging DB (read-only)."""
    images = {r["id"]: dict(r) for r in con.execute("SELECT * FROM images")}
    faces = [dict(r) for r in con.execute(
        "SELECT f.*, p.name AS person_name FROM faces f"
        " JOIN persons p ON p.id = f.person_id")]
    persons = {r["id"]: r["name"] for r in con.execute(
        "SELECT id, name FROM persons")}
    groups: dict[int, set[str]] = {}
    for r in con.execute("SELECT person_id, path FROM person_groups"):
        groups.setdefault(r["person_id"], set()).add(r["path"])
    return images, faces, persons, groups


def plan_import(stcon: sqlite3.Connection, dbcon: sqlite3.Connection,
                min_overlap: float, overwrite: bool,
                rep: Report) -> dict:
    """Match + resolve everything read-only; returns the execution plan.

    Nothing here writes: the plan is executed against the target copy (or
    discarded by --dry-run), which keeps dry runs byte-for-byte honest.
    """
    images, sfaces, spersons, sgroups = load_staging(stcon)

    hash2img = {r["content_hash"]: dict(r) for r in dbcon.execute(
        "SELECT id, content_hash, width, height, inversion FROM images"
        " WHERE content_hash IS NOT NULL")}
    faces_by_image: dict[int, list[dict]] = {}
    for r in dbcon.execute("SELECT id, image_id, x, y, w, h, person_id,"
                           " link_status, state FROM faces"):
        faces_by_image.setdefault(r["image_id"], []).append(dict(r))
    db_face_by_id = {f["id"]: f for fl in faces_by_image.values() for f in fl}
    sf_by_id = {sf["id"]: sf for sf in sfaces}

    # ---- candidate pairs, per staging face (§9.2/9.3)
    pairs_by_image: dict[int, list[tuple[float, int, int]]] = {}
    for sf in sfaces:
        rep.add("staging_faces")
        img_row = images.get(sf["image_id"])
        ch = (img_row or {}).get("content_hash")
        if not ch:
            where = (img_row or {}).get("path") or \
                f"{(img_row or {}).get('name')!r} " \
                f"({(img_row or {}).get('source_ref')})"
            rep.skip("hash-missing",
                     f"staging face {sf['id']} (image {where}) — never"
                     f" certainly resolved, so not hashable (J2)")
            continue
        dbimg = hash2img.get(ch)
        if dbimg is None:
            rep.skip("image-not-in-db",
                     f"staging face {sf['id']} person {sf['person_name']!r}:"
                     f" hash {ch[:12]}… not in faces.db (J2)")
            continue
        box = convert_box(sf["x"], sf["y"], sf["w"], sf["h"], sf["unit"],
                          sf["img_w"], sf["img_h"],
                          dbimg["width"], dbimg["height"],
                          dbimg["inversion"] or "none")
        if box is None:
            rep.skip("degenerate-box",
                     f"staging face {sf['id']} person {sf['person_name']!r}")
            continue
        sf["_box"] = box
        hits = [(iou(box, (f["x"], f["y"], f["w"], f["h"])), f["id"])
                for f in faces_by_image.get(dbimg["id"], [])]
        hits = [h for h in hits if h[0] >= min_overlap]
        if not hits:
            rep.skip("below-threshold",
                     f"staging face {sf['id']} person {sf['person_name']!r}"
                     f" image hash {ch[:12]}…: no face of"
                     f" {len(faces_by_image.get(dbimg['id'], []))} reaches"
                     f" IoU {min_overlap:.2f}")
            continue
        for score, dbfid in hits:
            pairs_by_image.setdefault(dbimg["id"], []).append(
                (score, sf["id"], dbfid))

    # ---- greedy one-to-one per image, eligibility gate (J4)
    assigned: dict[int, int] = {}              # staging face id -> db face id
    protected: set[int] = set()
    for pairs in pairs_by_image.values():
        pairs.sort(key=lambda t: (-t[0], t[2]))   # best IoU first, id tiebreak
        used_sf: set[int] = set()
        used_db: set[int] = set()
        for score, sfid, dbfid in pairs:
            if sfid in used_sf or dbfid in used_db:
                continue
            dbf = db_face_by_id[dbfid]
            if not (overwrite or (dbf["link_status"] == "provisional"
                                  and dbf["state"] != "discarded")):
                # identity is identity: never fall back to a lesser match
                used_sf.add(sfid)
                used_db.add(dbfid)
                protected.add(sfid)
                rep.skip("status-protected",
                         f"staging face {sfid} matched db face {dbfid}"
                         f" (IoU {score:.2f}), but that face's link is"
                         f" {dbf['link_status']}/{dbf['state']} — needs"
                         f" --overwrite")
                continue
            used_sf.add(sfid)
            used_db.add(dbfid)
            assigned[sfid] = dbfid
            rep.add("matched")
        for sfid in {sf for _, sf, _ in pairs} - used_sf - protected:
            rep.skip("already-claimed",
                     f"staging face {sfid}: every candidate db face was"
                     f" won by a better match")

    # ---- person resolution (§9.4)
    existing_by_name: dict[str, list[int]] = {}
    for r in dbcon.execute("SELECT id, name FROM persons"):
        existing_by_name.setdefault(r["name"], []).append(r["id"])
    existing_groups: dict[int, set[str]] = {}
    for r in dbcon.execute("SELECT person_id, path FROM person_groups"):
        existing_groups.setdefault(r["person_id"], set()).add(r["path"])

    taken_names = set(existing_by_name)
    target_of: dict[int, tuple] = {}           # staging person id -> (kind, key)
    new_persons: dict[int, tuple] = {}         # spid -> (final name, groups)
    reused: dict[int, int] = {}                # spid -> existing person id
    for sfid in assigned:
        spid = sf_by_id[sfid]["person_id"]
        if spid in target_of:
            continue
        name = spersons[spid]
        groups_g = set()
        for p in sgroups.get(spid, ()):        # root+leaf stripped (§9.4 v2.1)
            stripped = strip_group_root(p, name)
            if stripped:
                groups_g.add(stripped)
        hit = None
        for cid in existing_by_name.get(name, []):
            if existing_groups.get(cid, set()) == groups_g:
                hit = cid                      # exact (name, group) match only
                break
        if hit is not None:
            reused[spid] = hit
            target_of[spid] = ("reused", hit)
        else:
            final = next_free_name(taken_names, name)
            taken_names.add(final)
            new_persons[spid] = (final, groups_g, name)
            target_of[spid] = ("new", spid)

    # ---- cluster logic (§9.5): group the moves by the CURRENT person
    by_current: dict[object, list[tuple[int, int]]] = {}
    for sfid, dbfid in assigned.items():
        by_current.setdefault(db_face_by_id[dbfid]["person_id"], []) \
            .append((sfid, dbfid))

    moves: list[dict] = []
    cluster_deletes: set[int] = set()
    for current, pairs in by_current.items():
        current_name = None
        if current is not None:
            row = dbcon.execute("SELECT name FROM persons WHERE id=?",
                                (current,)).fetchone()
            current_name = row[0] if row else None
        is_unknown = current_name is not None and \
            bool(UNKNOWN_NAME_RE.match(current_name))
        targets = {target_of[sf_by_id[sfid]["person_id"]]
                   for sfid, _ in pairs}
        if is_unknown and len(targets) > 1:
            # contradictory evidence: leave the whole cluster alone (§9.5)
            rep.skip("cluster-disagreement",
                     f"{current_name} (id {current}): matched faces resolve"
                     f" to {len(targets)} different persons — cluster"
                     f" skipped, nothing moved")
            continue
        if is_unknown:
            # as if the user assigned the whole group — but J4: only
            # eligible faces may receive a person, so protected faces stay
            # with the UnknownN (which then survives, not being empty)
            for r in dbcon.execute(
                    "SELECT id, link_status, state FROM faces"
                    " WHERE person_id=?", (current,)):
                if overwrite or (r["link_status"] == "provisional"
                                 and r["state"] != "discarded"):
                    moves.append({"db_face": r["id"],
                                  "person": target_of[
                                      sf_by_id[pairs[0][0]]["person_id"]],
                                  "current": current})
            cluster_deletes.add(current)
        else:
            for sfid, dbfid in pairs:
                moves.append({"db_face": dbfid,
                              "person": target_of[sf_by_id[sfid]["person_id"]],
                              "current": current})
    return {"new_persons": new_persons, "reused": reused,
            "moves": moves, "cluster_deletes": cluster_deletes}


# ------------------------------------------------------------------ execution

def execute_plan(dbcon: sqlite3.Connection, plan: dict, rep: Report) -> None:
    """Run the plan against the (copy of the) faces DB, one transaction."""
    now_ts = now()
    person_id_of: dict[tuple, int] = {}

    def resolve_person(kind, key) -> int:
        """Get-or-create the target person; counters here, not in planning:
        a cluster skipped for disagreement must not report phantom persons."""
        if (kind, key) in person_id_of:
            return person_id_of[(kind, key)]
        if kind == "reused":
            rep.add("persons_reused")
            person_id_of[(kind, key)] = key
            return key
        final, groups, orig = plan["new_persons"][key]
        cur = dbcon.execute(
            "INSERT INTO persons(name, state, created_at) VALUES(?,"
            " 'imported', ?)", (final, now_ts))
        pid = cur.lastrowid
        for g in sorted(groups):
            dbcon.execute(
                "INSERT OR IGNORE INTO person_groups(person_id, path)"
                " VALUES(?,?)", (pid, g))
        rep.add("persons_created")
        if final != orig:
            rep.add("seq_renamed")
            rep.details.append(
                f"name-collision: person {orig!r} created as {final!r}"
                f" (§9.4)")
        person_id_of[(kind, key)] = pid
        return pid

    def relabel(face_id: int, pid: int, person_name: str) -> None:
        """seq + derived name follow the GUI move semantics (§4.7)."""
        row = dbcon.execute(
            "SELECT description FROM faces WHERE id=?", (face_id,)).fetchone()
        desc = row[0] or ""
        seq = dbcon.execute(
            "SELECT COALESCE(MAX(seq),0) FROM faces WHERE person_id=?"
            " AND COALESCE(description,'')=COALESCE(?,'')",
            (pid, desc)).fetchone()[0] + 1
        name = f"{person_name}-{desc}-{seq}" if desc else f"{person_name}-{seq}"
        dbcon.execute(
            "UPDATE faces SET person_id=?, seq=?, name=?,"
            " link_status='provisional', reassigned=0 WHERE id=?",
            (pid, seq, name, face_id))

    moved_ids: list[int] = []
    moved_to: dict[int, int] = {}
    for mv in plan["moves"]:
        kind, key = mv["person"]
        pid = resolve_person(kind, key)
        person_name = dbcon.execute("SELECT name FROM persons WHERE id=?",
                                    (pid,)).fetchone()[0]
        relabel(mv["db_face"], pid, person_name)
        moved_ids.append(mv["db_face"])
        moved_to[mv["db_face"]] = pid
        rep.add("faces_moved")

    # emptied UnknownN shells are deleted (§4.13); the cluster's non-
    # eligible faces (if any) keep it alive, so only truly empty ones go
    for current in sorted(plan["cluster_deletes"]):
        left = dbcon.execute("SELECT COUNT(*) FROM faces WHERE person_id=?",
                             (current,)).fetchone()[0]
        if left == 0:
            dbcon.execute("DELETE FROM persons WHERE id=?", (current,))
            rep.add("unknown_deleted")
            rep.add("clusters_merged")

    # housekeeping: stale primary pointers and refcrop rows (§4.5/§4.6)
    if moved_ids:
        marks = ",".join("?" * len(moved_ids))
        cur = dbcon.execute(
            f"UPDATE persons SET primary_face_id=NULL, primary_pinned=0"
            f" WHERE primary_face_id IN ({marks})", moved_ids)
        rep.add("primaries_cleared", cur.rowcount if cur.rowcount > 0 else 0)
        for fid in moved_ids:
            cur = dbcon.execute(
                "DELETE FROM person_refcrops WHERE face_id=? AND person_id"
                " != ?", (fid, moved_to[fid]))
            rep.add("refcrops_cleared",
                    cur.rowcount if cur.rowcount > 0 else 0)

    # primary backfill (§9.5 v2.1, #80): the §4.5 machine rule — the same
    # statement as import_roll.assign_missing_primaries (duplicated,
    # stdlib-only, like annotation_snapshot); fills every empty slot so
    # the copy opens with usable person icons. User picks elsewhere are
    # pinned/untouched: only NULL slots are filled.
    dbcon.execute("""
        UPDATE persons SET primary_face_id = (
            SELECT f.id FROM faces f
             WHERE f.person_id = persons.id AND f.state != 'discarded'
               AND f.link_status != 'rejected'
             ORDER BY f.confidence DESC, f.id LIMIT 1)
        WHERE primary_face_id IS NULL
          AND EXISTS (SELECT 1 FROM faces f
                       WHERE f.person_id = persons.id AND f.state != 'discarded'
                         AND f.link_status != 'rejected')
    """)
    dbcon.commit()


# ---------------------------------------------------------------------- CLI

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("staging", type=Path,
                    help="harvest staging DB (§8, schema v1.1)")
    ap.add_argument("--faces-db", metavar="PATH", default=None,
                    help="source faces.db (default: FACES_DB from .env)")
    ap.add_argument("--min-overlap", type=float, default=0.60,
                    help="minimum IoU between harvested and detected face "
                         "(default 0.60, §9.3)")
    ap.add_argument("--overwrite", action="store_true",
                    help="treat the user's prior links as invalid: every "
                         "face is eligible (J4); links become provisional "
                         "again (J5)")
    ap.add_argument("--dry-run", action="store_true",
                    help="full pipeline, no writes anywhere (no copy)")
    cli_console.add_quiet_arg(ap)
    args = ap.parse_args(argv)

    global _CONSOLE
    _CONSOLE = ui = cli_console.Console(quiet=args.quiet)

    if not (0.0 < args.min_overlap <= 1.0):
        ui.error("error: --min-overlap must be in (0, 1]")
        return 1

    env = load_env(PROJECT_ROOT / ".env")
    faces_db = Path(args.faces_db).expanduser() if args.faces_db \
        else PROJECT_ROOT / env.get("FACES_DB", "data/faces.db")
    if not faces_db.is_absolute():
        faces_db = (PROJECT_ROOT / faces_db).resolve()

    mode = "DRY RUN — no copy, no writes" if args.dry_run else "import into copy"
    ui.header(f"WhoT import_harvested — {mode}",
              f"staging     : {args.staging}",
              f"faces db    : {faces_db}",
              f"min overlap : {args.min_overlap}",
              f"overwrite   : {'yes' if args.overwrite else 'no'}")

    if not args.staging.exists():
        ui.error(f"error: staging DB not found: {args.staging}")
        return 1
    if not faces_db.exists():
        ui.error(f"error: faces.db not found: {faces_db}")
        return 1

    stcon = open_ro(args.staging)
    try:
        check_version(stcon, STAGING_SCHEMA_VERSION, "harvest staging")
        dbcon_src = open_ro(faces_db)
        try:
            check_version(dbcon_src, FACES_SCHEMA_VERSION, "faces.db")
        finally:
            dbcon_src.close()

        rep = Report()
        if args.dry_run:
            dbcon = open_ro(faces_db)
            target = None
            ui.status(f"DRY RUN — no copy, no writes (source: {faces_db})")
        else:
            ui.start_beat("vacuuming copy of faces.db")
            target = make_target_copy(faces_db)
            ui.stop_beat()
            ui.status(f"target copy: {target}  (J1: the original is untouched)")
            dbcon = sqlite3.connect(target)
            dbcon.row_factory = sqlite3.Row
            dbcon.execute("PRAGMA foreign_keys = ON")
        try:
            ui.start_beat("planning import")
            plan = plan_import(stcon, dbcon, args.min_overlap,
                               args.overwrite, rep)
            ui.stop_beat()
            if not args.dry_run:
                ui.start_beat("executing plan")
                execute_plan(dbcon, plan, rep)
                ui.stop_beat()
        finally:
            ui.stop_beat()
            dbcon.close()
    finally:
        stcon.close()

    # ---- report (§9.6): the final summary — always printed (§10.1)
    lines = [""]
    lines += [f"  {k:<22} {rep.counters[k]}" for k in sorted(rep.counters)]
    if rep.details:
        lines.append(f"\ndetails ({len(rep.details)}):")
        lines += [f"  {d}" for d in rep.details[:40]]
        if len(rep.details) > 40:
            lines.append(f"  … {len(rep.details) - 40} more (see the JSON report)")
    if target is not None:
        jpath = target.with_suffix(".import.json")
        lpath = target.with_suffix(".import.log")
        jpath.write_text(rep.to_json())
        lpath.write_text("\n".join(
            [f"# import_harvested {now()}  staging={args.staging}"
             f"  overwrite={args.overwrite}"
             f"  min_overlap={args.min_overlap}"] +
            [f"{k}={v}" for k, v in sorted(rep.counters.items())] +
            ["", *rep.details]) + "\n")
        lines.append(f"\nreport: {lpath}\n        {jpath}")
        lines.append("open the app against the copy (symlink) and decide"
                     " whether to promote it")
    ui.summary(*lines)
    return 0


if __name__ == "__main__":
    sys.exit(main())
