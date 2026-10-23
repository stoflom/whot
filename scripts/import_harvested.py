#!/usr/bin/env python3
"""import_harvested.py — attach harvested persons to existing faces (design §9).

Merges one harvest staging DB (§8, schema v1.2) into a **vacuumed copy** of
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
decode space (§9.2) and matched per whot face by the per-face claim
model — a face accepts the above-threshold claims (IoU =
|A∩B|/|A∪B| >= --min-overlap, default 0.50) that agree on one person.
UnknownN clusters are merged whole only on unanimous evidence (§9.5).

Usage:
  scripts/import_harvested.py STAGING.db [--faces-db data/faces.db]
      [--min-overlap 0.50] [--overwrite] [--dry-run] [-q]

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
import pathmap      # legacy path-map file (scripts-design §8.6, #85)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STAGING_SCHEMA_VERSION = "1.2"     # §8.2, exact-match (J3)
FACES_SCHEMA_VERSION = "1.6"       # database/schema.sql, exact-match
GROUP_ROOTS = {"people", "person"}  # stripped from harvested paths (§9.4)
UNKNOWN_NAME_RE = re.compile(r"^Unknown\d+$")


# module-level console: library callers (tests) get plain status output;
# main() swaps in the -q-aware instance (scripts-design §10.7)
_CONSOLE = cli_console.Console()

UNUSABLE_THRESHOLD = 0.20      # >20% unusable staging faces => loud warning (#83)


def coverage_pct(unusable: int, total: int,
                 threshold: float = UNUSABLE_THRESHOLD) -> float | None:
    """Share of unusable staging faces in percent, or None while healthy
    (§8.6).  Pure function — threshold logic testable without a run."""
    if total <= 0 or unusable * (1.0 / threshold) <= total:
        return None
    return 100.0 * unusable / total


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
                db_w: int, db_h: int,
                inversion: str = "none",
                rotation: int = 0) -> tuple[float, float, float, float] | None:
    """Harvested box -> decode-space box (§9.2). None when degenerate.

    Normalised fractions are multiplied by the db's decode dims — what
    import_roll stored: the *displayed* image, EXIF orientation applied
    by the decoder, gui-design §4.29.  A normalised box is a fraction of
    the photo (scale-invariant), so the decode dims are always the right
    scale; the source-stated stDim is kept in staging (H4) but does not
    scale — it mis-scales same-photo exports with differently-sized
    files (v5.1, #115).  Pixel boxes are already in the displayed space.
    A recorded inversion maps the box via the inverse flip.

    #118 (v5.2): `rotation` is the source file's EXIF display rotation
    (CW) as harvested.  Legacy tools record boxes in RAW (file) space —
    pixel boxes in RAW pixels, normalised ones as fractions of the RAW
    dims — while the db's decode dims are the DISPLAYED dims, which for a
    90/270° rotation are the RAW dims swapped.  So the box is scaled by
    the RAW dims and then mapped raw->display (the same math the GUI
    applies, src/rotation.ts, #122) BEFORE the inversion, which is
    expressed in display space.
    """
    if unit not in ("normalized", "pixels"):
        return None
    # RAW (file) dims: the db decode dims with 90/270° swapped
    swapped = rotation in (90, 270)
    W = float(db_h) if swapped else float(db_w)
    H = float(db_w) if swapped else float(db_h)
    if unit == "normalized":
        x, y, w, h = x * W, y * H, w * W, h * H
    if rotation == 90:
        x, y, w, h = H - y - h, x, h, w
    elif rotation == 180:
        x, y = W - x - w, H - y - h
    elif rotation == 270:
        x, y, w, h = y, W - x - w, h, w
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
    # v4.0 (#87): the name-leaf drop is case-insensitive too — the whole
    # person/group identity compares casefold, so 'WINNIE PELSER' in a
    # path is the leaf of person 'winnie pelser'
    if person is not None and parts and parts[-1].casefold() == person.casefold():
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


def next_free_name_ci(taken_cf: set[str], name: str) -> str:
    """Like next_free_name, but *taken_cf* holds casefolded names and the
    comparison is case-insensitive (§9.4 v4.0, #87): 'Winnie Pelser' and
    'winnie pelser' collide, and 'winnie pelser 2' shadows 'W. 2'."""
    if name.casefold() not in taken_cf:
        return name
    n = 2
    while f"{name} {n}".casefold() in taken_cf:
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
        "SELECT f.*, p.name AS person_name, s.name AS source_name FROM faces f"
        " JOIN persons p ON p.id = f.person_id"
        " JOIN sources s ON s.id = f.source_id")]
    persons = {r["id"]: r["name"] for r in con.execute(
        "SELECT id, name FROM persons")}
    groups: dict[int, set[str]] = {}
    for r in con.execute("SELECT person_id, path FROM person_groups"):
        groups.setdefault(r["person_id"], set()).add(r["path"])
    return images, faces, persons, groups


def _img_where(img_row: dict | None) -> str:
    """Full, actionable location of a staging image (#85): the stated path
    when the source gave one, else name + size + source reference."""
    if not img_row:
        return "<image row missing>"
    if img_row.get("path"):
        return str(img_row["path"])
    return (f"{img_row.get('name')!r} ({img_row.get('file_size')} bytes,"
            f" {img_row.get('source_ref')})")


def rescue_hashes(stcon: sqlite3.Connection, rules: list,
                  ui: cli_console.Console | None = None,
                  rep: "Report | None" = None,
                  excludes: list[str] | None = None) -> dict[int, str]:
    """Re-hash staging images whose file is reachable now (§8.6, #85).

    Two rescue classes, both lookup aids — identity stays the BLAKE3 hash
    (J2/H3), ambiguity is skipped, never guessed:

    1. image has a stated path but no hash (file moved since the harvest,
       or `--no-hash`): try the path as-is, then through the path map;
    2. image is pathless (digiKam never resolved it): resolve
       `(name, file_size)` uniquely under the path map's local roots.

    Returns `{staging_image_id: hash}` — an in-memory overlay; the staging
    DB is never written (H1/H2).
    """
    rows = stcon.execute(
        "SELECT id, path, name, file_size FROM images"
        " WHERE content_hash IS NULL").fetchall()
    if not rows:
        return {}
    rescued: dict[int, str] = {}

    def _hash(path: str) -> str | None:
        try:
            from blake3 import blake3          # same lazy import as harvest
        except ImportError:
            return None
        h = blake3()
        try:
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
        except OSError:
            return None
        return h.hexdigest()

    def _note(kind: str, iid: int, where: str, digest: str) -> None:
        rescued[iid] = digest
        if rep is not None:
            rep.add(kind)
            rep.details.append(f"{kind}: image {where} -> hash {digest[:12]}…")
        if ui is not None:
            ui.status(f"  rescued {where} -> {digest[:12]}…")

    # 1) stated paths (original, then through the path map); excluded
    #    prefixes (#86) are never rescued
    n_walk = 0
    for iid, path, name, size in rows:
        if path is None:
            n_walk += 1
            continue
        if pathmap.is_excluded(path, excludes or []):
            continue
        for cand in dict.fromkeys(
                [path, pathmap.apply_path_map(path, rules or [])]):
            if cand and Path(cand).is_file():
                digest = _hash(cand)
                if digest:
                    _note("rescued-path", iid, cand, digest)
                break

    # 2) pathless: (name, size) index over the path map's local roots,
    #    unique match only — exactly the harvester's name-size rule (§8.3)
    if n_walk and rules:
        idx: dict[tuple[str, int], list[str]] = {}
        for root in pathmap.local_roots(rules):
            if not root.is_dir():
                continue
            for dirpath, _dirs, files in os.walk(root):
                for fn in files:
                    fp = str(Path(dirpath) / fn)
                    try:
                        sz = os.stat(fp).st_size
                    except OSError:
                        continue
                    idx.setdefault((fn.casefold(), sz), []).append(fp)
        for iid, path, name, size in rows:
            if path is not None or iid in rescued or not name or size is None:
                continue   # pathless: nothing to exclude against (#86)
            cands = idx.get((name.casefold(), size), [])
            if len(cands) == 1:
                digest = _hash(cands[0])
                if digest:
                    _note("rescued-name-size", iid, cands[0], digest)
    return rescued


def plan_import(stcon: sqlite3.Connection, dbcon: sqlite3.Connection,
                min_overlap: float, overwrite: bool,
                rep: Report,
                rescues: dict[int, str] | None = None) -> dict:
    """Match + resolve everything read-only; returns the execution plan.

    Nothing here writes: the plan is executed against the target copy (or
    discarded by --dry-run), which keeps dry runs byte-for-byte honest.

    `rescues` (§8.6, #85) overlays hashes recovered by `rescue_hashes`
    onto the pathless/unhashed staging images before matching.
    """
    images, sfaces, spersons, sgroups = load_staging(stcon)
    for iid, digest in (rescues or {}).items():
        if iid in images and not images[iid].get("content_hash"):
            images[iid]["content_hash"] = digest

    hash2img = {r["content_hash"]: dict(r) for r in dbcon.execute(
        "SELECT id, content_hash, width, height, inversion FROM images"
        " WHERE content_hash IS NOT NULL")}
    faces_by_image: dict[int, list[dict]] = {}
    for r in dbcon.execute("SELECT id, image_id, x, y, w, h, person_id,"
                           " link_status, state FROM faces"):
        faces_by_image.setdefault(r["image_id"], []).append(dict(r))
    db_face_by_id = {f["id"]: f for fl in faces_by_image.values() for f in fl}
    sf_by_id = {sf["id"]: sf for sf in sfaces}

    # ---- claims: every above-threshold rect against every db face (§9.3 v4.0)
    # IoU is face identity, never a ranking criterion (#87): no greedy
    # pass, no winner-picking. hash-missing / image-not-in-db are reported
    # ONCE PER IMAGE with the full stated path (#85).
    claims: dict[int, list[tuple[int, float]]] = {}   # dbfid -> [(sfid, iou)]
    reported_missing: set[int] = set()
    reported_absent: set[int] = set()
    rotations_landed: set[int] = set()                # #118: db image ids
    for sf in sfaces:
        rep.add("staging_faces")
        img_row = images.get(sf["image_id"])
        ch = (img_row or {}).get("content_hash")
        if not ch:
            rep.add("hash-missing")
            if sf["image_id"] not in reported_missing:
                reported_missing.add(sf["image_id"])
                rep.details.append(
                    f"hash-missing: image {_img_where(img_row)} — never"
                    f" certainly resolved, so not hashable (J2)")
            continue
        dbimg = hash2img.get(ch)
        if dbimg is None:
            rep.add("image-not-in-db")
            if sf["image_id"] not in reported_absent:
                reported_absent.add(sf["image_id"])
                rep.details.append(
                    f"image-not-in-db: image {_img_where(img_row)} hash"
                    f" {ch[:12]}… not in faces.db (J2)")
            continue
        # #118: the harvested EXIF display rotation maps the box from RAW
        # space into the db's displayed (decode) space; it is also landed
        # on the matched image (first write wins — a user-set GUI
        # rotation is never overridden)
        rot = (img_row or {}).get("rotation") or 0
        if rot and dbimg["id"] not in rotations_landed:
            rotations_landed.add(dbimg["id"])
            dbcon.execute("UPDATE images SET rotation=? WHERE id=?"
                          " AND rotation=0", (rot, dbimg["id"]))
        box = convert_box(sf["x"], sf["y"], sf["w"], sf["h"], sf["unit"],
                          dbimg["width"], dbimg["height"],
                          dbimg["inversion"] or "none", rotation=rot)
        if box is None:
            rep.skip("degenerate-box",
                     f"staging face {sf['id']} person {sf['person_name']!r}")
            continue
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
            claims.setdefault(dbfid, []).append((sf["id"], score))

    # ---- person resolution (§9.4, v4.0 #87): case-insensitive, whot wins,
    # else first source (lowest staging persons.id = harvest load order)
    person_name_by_id = {r["id"]: r["name"]
                         for r in dbcon.execute("SELECT id, name FROM persons")}
    existing_name_of: dict[int, str] = {}
    existing_by_cf: dict[str, list[int]] = {}        # casefolded name -> ids
    imported_by_cf_base: dict[str, list[int]] = {}   # casefolded base -> ids (#82)
    for r in dbcon.execute("SELECT id, name, state FROM persons ORDER BY id"):
        existing_name_of[r["id"]] = r["name"]
        existing_by_cf.setdefault(r["name"].casefold(), []).append(r["id"])
        if r["state"] == "imported":
            m = re.match(r"^(.*) \d+$", r["name"])
            if m:
                imported_by_cf_base.setdefault(m.group(1).casefold(), []) \
                    .append(r["id"])
    existing_groups_cf: dict[int, set[str]] = {}
    for r in dbcon.execute("SELECT person_id, path FROM person_groups"):
        existing_groups_cf.setdefault(r["person_id"], set()) \
            .add(r["path"].casefold())

    def translated_groups(spid: int) -> set[str]:
        """§9.4 v2.1 translation: root stripped, name-leaf dropped."""
        name = spersons[spid]
        out: set[str] = set()
        for pth in sgroups.get(spid, ()):
            stripped = strip_group_root(pth, name)
            if stripped:
                out.add(stripped)
        return out

    claiming_spids = sorted({sf_by_id[sfid]["person_id"]
                             for cl in claims.values() for sfid, _ in cl})
    target_of: dict[int, tuple] = {}      # spid -> ('reused', pid) | ('new', rep_spid)
    new_persons: dict[int, tuple] = {}    # rep spid -> (final name, groups, orig)
    reused: dict[int, int] = {}           # spid -> existing person id
    new_by_identity: dict[tuple, int] = {}  # (cf name, cf groups) -> rep spid
    taken_cf = {n.casefold() for n in existing_name_of.values()}
    for spid in claiming_spids:           # ascending id = first source wins
        name = spersons[spid]
        gs = translated_groups(spid)
        n_cf, g_cf = name.casefold(), {g.casefold() for g in gs}
        # 1) whot wins: case-insensitive name+group match (exact spelling first)
        hit = None
        matching = [cid for cid in existing_by_cf.get(n_cf, [])
                    if existing_groups_cf.get(cid, set()) == g_cf]
        if matching:
            exact = [cid for cid in matching if existing_name_of[cid] == name]
            hit = (exact or matching)[0]
        # 2) this importer's own suffixed generation (#82, §9.8)
        if hit is None:
            for cid in imported_by_cf_base.get(n_cf, []):
                if existing_groups_cf.get(cid, set()) == g_cf:
                    hit = cid
                    break
        if hit is not None:
            reused[spid] = hit
            target_of[spid] = ("reused", hit)
            continue
        # 3) merge staging siblings with the same case-insensitive identity;
        #    the first (lowest id = first source) defines the spelling
        ident = (n_cf, frozenset(g_cf))
        rep_spid = new_by_identity.get(ident)
        if rep_spid is None:
            new_by_identity[ident] = spid
            final = next_free_name_ci(taken_cf, name)
            taken_cf.add(final.casefold())
            new_persons[spid] = (final, gs, name)
            target_of[spid] = ("new", spid)
        else:
            target_of[spid] = ("new", rep_spid)

    # ---- per-face decisions (§9.3 v4.0): agreement, not IoU, decides
    hash_by_img = {v["id"]: k for k, v in hash2img.items()}

    def claimant_desc(sfid: int, score: float) -> str:
        sf = sf_by_id[sfid]
        spid = sf["person_id"]
        tgt = target_of.get(spid)
        disp = spersons[spid]
        if tgt is not None:
            disp = (person_name_by_id.get(tgt[1]) if tgt[0] == "reused"
                    else new_persons[tgt[1]][0])
        gset = ", ".join(sorted(translated_groups(spid))) or "ungrouped"
        return (f"'{disp}|{gset}' ({sf.get('source_name')}, IoU {score:.2f}"
                f"{', picked' if sf.get('picked') else ''})")

    moves: list[dict] = []
    cluster_deletes: set[int] = set()
    contested_clusters: set[int] = set()
    for dbfid in sorted(claims):
        dbf = db_face_by_id[dbfid]
        cl = claims[dbfid]
        descs = [claimant_desc(sfid, s) for sfid, s in cl]
        if not (overwrite or (dbf["link_status"] == "provisional"
                              and dbf["state"] != "discarded")):
            # J4: user work is untouchable — the claims are recorded, not applied
            rep.add("status-protected")
            rep.details.append(
                f"status-protected: db face {dbfid} (image hash "
                f"{hash_by_img.get(dbf['image_id'], '?')[:12]}…): "
                + " vs ".join(descs)
                + f" — face is {dbf['link_status']}/{dbf['state']},"
                  " needs --overwrite")
            continue
        tgts = {target_of[sf_by_id[sfid]["person_id"]] for sfid, _ in cl}
        if len(tgts) > 1:
            # a face belongs to one person (#87 rule 3): log, touch nothing
            rep.add("contested")
            cur = person_name_by_id.get(dbf["person_id"]) or "nobody"
            rep.details.append(
                f"contested: db face {dbfid} (image hash "
                f"{hash_by_img.get(dbf['image_id'], '?')[:12]}…): "
                + " vs ".join(descs)
                + f" — face left with {cur}")
            if dbf["person_id"] is not None:
                contested_clusters.add(dbf["person_id"])
            continue
        tgt = next(iter(tgts))
        # §9.8 (#82): a face already on its resolved target is a no-op
        if tgt[0] == "reused" and dbf["person_id"] == tgt[1]:
            rep.add("already-there")
            continue
        moves.append({"db_face": dbfid, "person": tgt,
                      "current": dbf["person_id"]})
        rep.add("matched")
        winner = (person_name_by_id.get(tgt[1]) if tgt[0] == "reused"
                  else new_persons[tgt[1]][0])
        rep.details.append(
            f"linked: db face {dbfid} <- '{winner}' ({len(cl)} claim(s): "
            + "; ".join(descs) + ")")

    # ---- cluster co-move (§9.5 v4.0): post-pass over the decisions
    by_current: dict[object, list[dict]] = {}
    for mv in moves:
        by_current.setdefault(mv["current"], []).append(mv)
    for current, cms in by_current.items():
        if current is None:
            continue
        cname = person_name_by_id.get(current)
        if not (cname and UNKNOWN_NAME_RE.match(cname)):
            continue                     # real/unowned faces decide alone
        cluster_deletes.add(current)      # deleted in execute if emptied
        if current in contested_clusters:
            continue                     # contradictory evidence: no co-move
        tgts = {mv["person"] for mv in cms}
        if len(tgts) > 1:
            continue                     # defensive; per-face rule prevents this
        decided = {mv["db_face"] for mv in cms}
        tgt = next(iter(tgts))
        # as if the user assigned the whole group: unclaimed mates follow (J4)
        for r in dbcon.execute(
                "SELECT id, link_status, state FROM faces"
                " WHERE person_id=?", (current,)):
            if r["id"] in decided or r["id"] in claims:
                continue
            if overwrite or (r["link_status"] == "provisional"
                             and r["state"] != "discarded"):
                moves.append({"db_face": r["id"], "person": tgt,
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

    # importer-shell sweep (§9.8 v3.0, #82): persons THIS script created
    # (state='imported') that ended up with zero faces — emptied by a
    # later re-run, or left behind by an interrupted one.  User persons
    # (state='created') are never touched.
    cur = dbcon.execute(
        "DELETE FROM persons WHERE state='imported' AND NOT EXISTS ("
        "  SELECT 1 FROM faces f WHERE f.person_id = persons.id)")
    if cur.rowcount:
        rep.add("importer_shells_deleted", cur.rowcount)

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
    ap.add_argument("--min-overlap", type=float, default=0.50,
                    help="minimum IoU between harvested and detected face "
                         "(default 0.50, §9.3)")
    ap.add_argument("--overwrite", action="store_true",
                    help="treat the user's prior links as invalid: every "
                         "face is eligible (J4); links become provisional "
                         "again (J5)")
    ap.add_argument("--dry-run", action="store_true",
                    help="full pipeline, no writes anywhere (no copy)")
    ap.add_argument("--path-map", action="append", metavar="FILE", default=[],
                    help="path-map file: 'OLD_PREFIX = NEW_PREFIX' lines "
                         "rewriting legacy roots onto the local archive "
                         "(§8.6, #85; also PATH_MAP in .env) — enables the"
                         " rescue pass for unhashable staging images")
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

    # path map (#85, §8.6): --path-map files + PATH_MAP in .env; a broken
    # file is an error, never silently ignored
    path_map: list = []
    path_excludes: list[str] = []
    try:
        for spec in [*args.path_map,
                     *[s for s in (env.get("PATH_MAP") or "").split(os.pathsep)
                       if s]]:
            rules, excl = pathmap.load_path_map(Path(spec.strip()).expanduser())
            path_map += rules
            path_excludes += excl
    except (OSError, ValueError) as e:
        ui.error(f"error: path map: {e}")
        return 1

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
            rescues: dict[int, str] = {}
            if path_map:
                ui.status("rescue pass: re-hashing reachable staging images"
                          " (§8.6, #85) ...")
                ui.start_beat("rescue pass")
                rescues = rescue_hashes(stcon, path_map, ui, rep,
                                        excludes=path_excludes)
                ui.stop_beat()
                ui.status(f"rescued {len(rescues)} staging image(s)")
            ui.start_beat("planning import")
            plan = plan_import(stcon, dbcon, args.min_overlap,
                               args.overwrite, rep, rescues=rescues)
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

    # coverage warning (#83, §8.6): >20% unusable staging faces scream —
    # stderr, never -q-suppressed; percentages always in the summary
    staging_total = rep.counters.get("staging_faces", 0)
    unusable = (rep.counters.get("hash-missing", 0) +
                rep.counters.get("image-not-in-db", 0))
    pct = coverage_pct(unusable, staging_total)
    if pct is not None:
        ui.error(f"WARNING: {pct:.0f}% of staging faces unusable"
                 f" ({unusable} of {staging_total}): hash-missing or not in"
                 f" faces.db — re-run the harvest with fuller --images/"
                 f" --lr-root coverage, or extend --path-map (§8.6).")

    # ---- report (§9.6): the final summary — always printed (§10.1)
    lines = [""]
    if staging_total:
        lines.append(
            f"  {'usable faces':<22} {staging_total - unusable}/{staging_total}"
            f" ({100.0 * (staging_total - unusable) / staging_total:.0f}%)")
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
