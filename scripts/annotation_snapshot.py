#!/usr/bin/env python3
"""annotation_snapshot.py — one-off export/restore of manual annotations.

Supports the schema v1.5 drop & recreate (design v1.3; AGENTS.md: no
migrations). Export reads the OLD database (pre-1.5 or 1.5) and writes the
manual work — named persons, groups, notes, primary picks, per-face
link_status/description/person moves and pinned refcrops — keyed by stable
face identity (image BLAKE3 content hash + rectangle). Restore applies it to
a freshly recreated + re-imported database, matching faces exactly first and
falling back to rectangle IoU on the same image.

Usage:
  annotation_snapshot.py export  [db]                > annotations.json
  annotation_snapshot.py restore annotations.json [db] [--iou 0.75]

Export never writes to the database (read-only connection). Restore requires
a schema v1.5 target (schema_version gate), runs in one transaction and
prints a summary; unmatched faces are reported, never silently dropped.

Exit codes: 0 ok, 1 failure / incompatible schema. stdlib only.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# must match database/schema.sql and scripts/import_roll.py / db.rs
SCHEMA_VERSION = "1.5"
FORMAT = 1


# ---------------------------------------------------------------- helpers

def load_env(path: Path) -> dict[str, str]:
    """Minimal .env reader (mirrors import_roll.load_env, stdlib-only)."""
    raw: dict[str, str] = {}
    if not path.is_file():
        return raw
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        raw[key.strip()] = val.strip().strip('"').strip("'")
    for _ in range(4):
        for k, v in raw.items():
            if "${" in v:
                for ref, rv in raw.items():
                    v = v.replace("${" + ref + "}", rv)
                raw[k] = v
    return raw


def default_db() -> Path:
    env = load_env(PROJECT_ROOT / ".env")
    return PROJECT_ROOT / env.get("FACES_DB", "data/faces.db")


def detect_schema(con: sqlite3.Connection) -> str:
    """schema_version value, or 'pre-1.5' when the marker table is absent."""
    try:
        row = con.execute("SELECT version FROM schema_version").fetchone()
        return row[0] if row else "unknown"
    except sqlite3.Error:
        return "pre-1.5"


def require_schema(con: sqlite3.Connection, db: Path) -> None:
    """Compatibility gate for RESTORE: the target must be v1.5 (like
    import_roll.check_schema)."""
    try:
        row = con.execute("SELECT version FROM schema_version").fetchone()
    except sqlite3.Error:
        sys.exit(
            f"{db} has no schema_version marker — not a WhoT v{SCHEMA_VERSION} database.\n"
            f"Create it with: sqlite3 {db} < database/schema.sql"
        )
    if row is None or row[0] != SCHEMA_VERSION:
        got = row[0] if row else "empty schema_version table"
        sys.exit(
            f"{db} schema v{got} does not match restore target (v{SCHEMA_VERSION}).\n"
            f"Recreate with: sqlite3 {db} < database/schema.sql"
        )


def derive_name(person: str, desc: str | None, seq: int) -> str:
    return f"{person}-{desc}-{seq}" if desc else f"{person}-{seq}"


def restore_refcrop_n() -> int:
    """refcrop_n from whotrc.json when present (default 5, like db.rs)."""
    try:
        env = load_env(PROJECT_ROOT / ".env")
        cfg = json.loads((PROJECT_ROOT / env.get("CONFIG_FILE", "config/whotrc.json")).read_text())
        return max(1, int(cfg.get("refcrop_n", 5)))
    except (OSError, ValueError, json.JSONDecodeError):
        return 5


def backfill_primary(con: sqlite3.Connection, pid: int) -> None:
    """Machine primary, mirroring db.rs backfill_primary: the highest-confidence
    confirmed, non-discarded face; only when the person has none."""
    con.execute(
        "UPDATE persons SET primary_face_id = ("
        "  SELECT f.id FROM faces f"
        "  WHERE f.person_id = persons.id"
        "    AND f.state != 'discarded' AND f.link_status != 'rejected'"
        "  ORDER BY f.confidence DESC, f.id LIMIT 1)"
        " WHERE id = ? AND primary_face_id IS NULL"
        "   AND EXISTS (SELECT 1 FROM faces f WHERE f.person_id = persons.id"
        "               AND f.state != 'discarded' AND f.link_status != 'rejected')",
        (pid,))


def recompute_refcrops(con: sqlite3.Connection, pid: int, n: int) -> int:
    """Rebuild the person's auto refcrops, mirroring db.rs recompute_refcrops:
    top-n per description group by confidence, excluding the primary face and
    pinned faces; pinned rows keep their seq slots. Returns the row count."""
    con.execute("DELETE FROM person_refcrops WHERE person_id = ? AND pinned = 0", (pid,))
    primary = con.execute(
        "SELECT primary_face_id FROM persons WHERE id = ?", (pid,)).fetchone()[0]
    pinned: dict[str, set[int]] = {}
    for group, seq in con.execute(
            "SELECT description, seq FROM person_refcrops WHERE person_id = ?", (pid,)):
        pinned.setdefault(group, set()).add(seq)
    rows = con.execute(
        "SELECT face_id, name, description, preview, rn FROM ("
        "  SELECT f.id AS face_id, f.name, COALESCE(f.description, '') AS description,"
        "         f.preview,"
        "         ROW_NUMBER() OVER (PARTITION BY COALESCE(f.description, '')"
        "                            ORDER BY f.confidence DESC, f.id) AS rn"
        "  FROM faces f"
        "  WHERE f.person_id = ? AND f.state != 'discarded' AND f.link_status = 'confirmed'"
        "    AND f.id IS NOT ?"
        "    AND NOT EXISTS (SELECT 1 FROM person_refcrops pr"
        "                    WHERE pr.face_id = f.id AND pr.pinned = 1)"
        "  ) WHERE rn <= ? ORDER BY rn",
        (pid, primary, n)).fetchall()
    next_seq: dict[str, int] = {}
    count = 0
    for face_id, name, group, crop, rn in rows:
        if crop is None:
            continue  # a preview-less face cannot become a refcrop (#39)
        cursor = next_seq.get(group, 1)
        seq = max(rn, cursor)
        while seq in pinned.get(group, ()):  # pinned rows keep their slots
            seq += 1
        next_seq[group] = seq + 1
        con.execute(
            "INSERT OR REPLACE INTO person_refcrops"
            " (person_id, face_id, description, pinned, seq, filename, crop)"
            " VALUES (?, ?, ?, 0, ?, ?, ?)",
            (pid, face_id, group, seq, f"{name}-{seq}.jpg", crop))
        count += 1
    return count


def iou(a: tuple, b: tuple) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def is_known(name: str | None) -> bool:
    # SQLite LIKE is ASCII-case-insensitive, matching the importer's corpora
    return bool(name) and not name.lower().startswith("unknown")


# ---------------------------------------------------------------- export

def do_export(db: Path) -> dict:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    schema = detect_schema(con)

    persons = []
    for pid, name, state, note, prim_pinned in con.execute(
        "SELECT id, name, state, note, primary_pinned FROM persons "
        "WHERE name NOT LIKE 'Unknown%' ORDER BY name"
    ):
        groups = [r[0] for r in con.execute(
            "SELECT path FROM person_groups WHERE person_id = ? ORDER BY path", (pid,))]
        prim = con.execute(
            "SELECT i.content_hash, f.x, f.y, f.w, f.h FROM faces f "
            "JOIN images i ON i.id = f.image_id WHERE f.id = "
            "(SELECT primary_face_id FROM persons WHERE id = ?)", (pid,)).fetchone()
        persons.append({
            "name": name, "state": state, "note": note, "groups": groups,
            "primary": dict(zip(("hash", "x", "y", "w", "h"), prim)) if prim else None,
            "primary_pinned": prim_pinned,
        })

    # every face with a user decision (defaults are reproduced by re-import)
    faces = []
    for h, x, y, w, hh, pname, status, desc, seq in con.execute(
        "SELECT i.content_hash, f.x, f.y, f.w, f.h, p.name, f.link_status, "
        "       f.description, f.seq FROM faces f "
        "JOIN images i ON i.id = f.image_id LEFT JOIN persons p ON p.id = f.person_id"
    ):
        if status != "provisional" or desc is not None or is_known(pname):
            faces.append({"hash": h, "x": x, "y": y, "w": w, "h": hh,
                          "person": pname if is_known(pname) else None,
                          "link_status": status, "description": desc, "seq": seq})

    # pins: v1.5 uses the pinned column, legacy rows used the 'pin:' prefix
    pins = []
    skipped_unknown = 0
    cols = {r[1] for r in con.execute("PRAGMA table_info(person_refcrops)")}
    if "pinned" in cols:
        pin_rows = con.execute(
            "SELECT i.content_hash, f.x, f.y, f.w, f.h, p.name, pr.description "
            "FROM person_refcrops pr JOIN faces f ON f.id = pr.face_id "
            "JOIN images i ON i.id = f.image_id JOIN persons p ON p.id = pr.person_id "
            "WHERE pr.pinned = 1").fetchall()
        strip_prefix = False
    else:
        pin_rows = con.execute(
            "SELECT i.content_hash, f.x, f.y, f.w, f.h, p.name, pr.description "
            "FROM person_refcrops pr JOIN faces f ON f.id = pr.face_id "
            "JOIN images i ON i.id = f.image_id JOIN persons p ON p.id = pr.person_id "
            "WHERE pr.description LIKE 'pin:%'").fetchall()
        strip_prefix = True
    for h, x, y, w, hh, pname, group in pin_rows:
        if not is_known(pname):
            skipped_unknown += 1
            continue
        if strip_prefix:
            group = group[4:]
        pins.append({"hash": h, "x": x, "y": y, "w": w, "h": hh,
                     "person": pname, "group": group})
    con.close()

    return {"format": FORMAT, "source_schema": schema,
            "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),  # #40: UTC
            "persons": persons, "faces": faces, "pins": pins,
            "skipped_unknown_pins": skipped_unknown}


# ---------------------------------------------------------------- restore

def do_restore(data: dict, db: Path, iou_threshold: float = 0.75) -> dict:
    if data.get("format") != FORMAT:
        sys.exit(f"unsupported snapshot format: {data.get('format')!r}")
    con = sqlite3.connect(db)
    con.execute("PRAGMA foreign_keys = ON")
    require_schema(con, db)

    # face identity index: exact (hash + rect), IoU candidates per image
    exact: dict[tuple, int] = {}
    by_hash: dict[str, list[tuple]] = {}
    for fid, h, x, y, w, hh in con.execute(
        "SELECT f.id, i.content_hash, f.x, f.y, f.w, f.h FROM faces f "
        "JOIN images i ON i.id = f.image_id"
    ):
        exact[(h, x, y, w, hh)] = fid
        by_hash.setdefault(h, []).append((fid, (x, y, w, hh)))

    used: set[int] = set()
    resolved: dict[tuple, int] = {}

    def resolve(key: tuple, claim: bool) -> int | None:
        if key in resolved:
            return resolved[key]
        fid = exact.get(key)
        if fid is not None and (not claim or fid not in used):
            if claim:
                used.add(fid)
            resolved[key] = fid
            return fid
        if claim:  # tiny detector jitter: IoU fallback on the same image
            best, best_iou = None, 0.0
            for cand, rect in by_hash.get(key[0], []):
                if cand in used:
                    continue
                score = iou(key[1:], rect)
                if score > best_iou:
                    best, best_iou = cand, score
            if best is not None and best_iou >= iou_threshold:
                used.add(best)
                resolved[key] = best
                return best
        return None

    def key_of(rec: dict) -> tuple:
        return (rec["hash"], rec["x"], rec["y"], rec["w"], rec["h"])

    stats = {"persons": 0, "faces": 0, "unmatched_faces": 0,
             "moved_faces": 0, "primary": 0, "pins": 0, "unmatched_pins": 0,
             "shells_deleted": 0, "refcrops": 0}
    # #40: UTC, same convention as the importer's datetime('now')
    now = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    try:
        restored: dict[str, int] = {}
        for p in data["persons"]:
            row = con.execute("SELECT id FROM persons WHERE name = ?", (p["name"],)).fetchone()
            if row:
                pid = row[0]
            else:
                pid = con.execute(
                    "INSERT INTO persons(name, state, created_at) VALUES (?, ?, ?)",
                    (p["name"], p["state"] or "created", now)).lastrowid
            con.execute("DELETE FROM person_groups WHERE person_id = ?", (pid,))
            for g in p["groups"]:
                con.execute("INSERT OR IGNORE INTO person_groups(person_id, path) VALUES (?, ?)",
                            (pid, g))
            if p["note"] is not None:
                con.execute("UPDATE persons SET note = ? WHERE id = ?", (p["note"], pid))
            restored[p["name"]] = pid
            stats["persons"] += 1

        for f in data["faces"]:
            fid = resolve(key_of(f), claim=True)
            if fid is None:
                stats["unmatched_faces"] += 1
                continue
            pname = f.get("person")
            if pname in restored:
                con.execute(
                    "UPDATE faces SET person_id = ?, seq = ?, link_status = ?, "
                    "description = ?, reassigned = 1, name = ? WHERE id = ?",
                    (restored[pname], f["seq"], f["link_status"], f["description"],
                     derive_name(pname, f["description"], f["seq"]), fid))
                stats["moved_faces"] += 1
            else:
                # stays wherever the re-import put it; keep its current seq/person
                cur = con.execute(
                    "SELECT p.name, f.seq FROM faces f LEFT JOIN persons p ON p.id = f.person_id "
                    "WHERE f.id = ?", (fid,)).fetchone()
                new_name = derive_name(cur[0] or "?", f["description"], cur[1])
                con.execute(
                    "UPDATE faces SET link_status = ?, description = ?, name = ? WHERE id = ?",
                    (f["link_status"], f["description"], new_name, fid))
            stats["faces"] += 1

        for p in data["persons"]:
            if not p.get("primary"):
                continue
            pr = p["primary"]
            fid = resolve((pr["hash"], pr["x"], pr["y"], pr["w"], pr["h"]), claim=False)
            if fid is None:
                continue
            con.execute(
                "UPDATE persons SET primary_face_id = ?, primary_pinned = ? WHERE id = ?",
                (fid, p["primary_pinned"], restored[p["name"]]))
            stats["primary"] += 1

        for pin in data["pins"]:
            pid = restored.get(pin["person"])
            fid = resolve(key_of(pin), claim=False) if pid is not None else None
            if pid is None or fid is None:
                stats["unmatched_pins"] += 1
                continue
            crop = con.execute("SELECT preview FROM faces WHERE id = ?", (fid,)).fetchone()
            if not crop or crop[0] is None:
                stats["unmatched_pins"] += 1
                continue
            group = pin.get("group", "")
            seq = con.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM person_refcrops "
                "WHERE person_id = ? AND description = ?", (pid, group)).fetchone()[0]
            face_name = con.execute("SELECT name FROM faces WHERE id = ?", (fid,)).fetchone()[0]
            con.execute(
                "INSERT OR REPLACE INTO person_refcrops "
                "(person_id, face_id, description, pinned, seq, filename, crop) "
                "VALUES (?, ?, ?, 1, ?, ?, ?)",
                (pid, fid, group, seq, f"{face_name}-{seq}.jpg", crop[0]))
            stats["pins"] += 1

        # v1.12 housekeeping (#37): the restore moves faces directly, so run
        # the derived-state maintenance the GUI would otherwise do on the
        # first mutation — machine primary + refcrops for each restored
        # person (after the pins, so pinned rows keep their seq slots), then
        # delete the UnknownN shells the restore emptied.
        n = restore_refcrop_n()
        for pid in restored.values():
            backfill_primary(con, pid)
        for pid in restored.values():
            stats["refcrops"] += recompute_refcrops(con, pid, n)
        cur = con.execute(
            "DELETE FROM persons WHERE name LIKE 'Unknown%' "
            "AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.person_id = persons.id)")
        stats["shells_deleted"] = cur.rowcount

        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()
    return stats


# ---------------------------------------------------------------- cli

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("export", help="old DB -> JSON (read-only)")
    ex.add_argument("db", nargs="?", type=Path, default=None)
    re = sub.add_parser("restore", help="JSON -> recreated + re-imported DB")
    re.add_argument("snapshot", type=Path)
    re.add_argument("db", nargs="?", type=Path, default=None)
    re.add_argument("--iou", type=float, default=0.75,
                    help="min rectangle IoU for fuzzy face matching (default 0.75)")
    args = ap.parse_args(argv)

    if args.cmd == "export":
        db = args.db or default_db()
        if not db.is_file():
            sys.exit(f"no database at {db}")
        data = do_export(db)
        json.dump(data, sys.stdout, indent=1)
        print()
        print(f"# {db}: schema {data['source_schema']}, "
              f"{len(data['persons'])} persons, {len(data['faces'])} faces, "
              f"{len(data['pins'])} pins", file=sys.stderr)
        return 0

    db = args.db or default_db()
    if not db.is_file():
        sys.exit(f"no database at {db}")
    stats = do_restore(json.loads(args.snapshot.read_text()), db, args.iou)
    print(f"restored into {db}: " + ", ".join(f"{k}={v}" for k, v in stats.items()))
    if stats["unmatched_faces"] or stats["unmatched_pins"]:
        print("WARNING: some exported records could not be matched — review them "
              "(detector jitter? try --iou lower)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
