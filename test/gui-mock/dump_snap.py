#!/usr/bin/env python3
"""Dump the WhoT faces.db snapshot into snap.json for the Tauri mock backend.

Read-only: the database is opened with mode=ro and never written to.

Usage:
    python3 dump_snap.py [--db PATH]

Writes snap.json next to this script (gitignored).
"""
import argparse
import json
import pathlib
import sqlite3
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=str(REPO / "data" / "faces.db"),
                    help="path to faces.db (default: <repo>/data/faces.db)")
    args = ap.parse_args()

    db = pathlib.Path(args.db)
    if not db.exists():
        sys.exit(f"database not found: {db}")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row

    persons = []
    for p in con.execute("select * from persons order by id"):
        groups = [r[0] for r in con.execute(
            "select path from person_groups where person_id=?", (p["id"],))]
        persons.append({
            "id": p["id"], "name": p["name"], "state": p["state"], "note": p["note"],
            "primary_face_id": p["primary_face_id"], "primary_pinned": p["primary_pinned"],
            "created_at": p["created_at"], "groups": groups,
            "counts": {
                "total": con.execute(
                    "select count(*) from faces where person_id=?", (p["id"],)).fetchone()[0],
                "provisional": con.execute(
                    "select count(*) from faces where person_id=? and link_status='provisional'",
                    (p["id"],)).fetchone()[0],
                "confirmed": con.execute(
                    "select count(*) from faces where person_id=? and link_status='confirmed'",
                    (p["id"],)).fetchone()[0],
                "rejected": con.execute(
                    "select count(*) from faces where person_id=? and link_status='rejected'",
                    (p["id"],)).fetchone()[0],
            },
        })

    faces = [{
        "id": f["id"], "image_id": f["image_id"], "person_id": f["person_id"],
        "x": f["x"], "y": f["y"], "w": f["w"], "h": f["h"], "name": f["name"],
        "seq": f["seq"], "description": f["description"], "confidence": f["confidence"],
        "link_status": f["link_status"], "state": f["state"],
        "import_id": f["detected_in_import_id"], "created_at": f["created_at"],
    } for f in con.execute("select * from faces order by id")]

    images = [{
        "id": i["id"], "primary_path": i["primary_path"], "width": i["width"],
        "height": i["height"], "orientation": i["orientation"], "rtype": i["type"],
        "state": i["state"], "first_import_id": i["first_import_id"],
        "last_import_id": i["last_import_id"],
    } for i in con.execute("select * from images order by id")]

    imports = [{"id": r["id"], "path": r["path"], "started_at": r["started_at"]}
               for r in con.execute("select * from imports order by id")]

    config = REPO / "config" / "whotrc.json"
    settings = json.loads(config.read_text()) if config.exists() else {}
    snap = {"persons": persons, "faces": faces, "images": images,
            "imports": imports, "settings": settings}
    out = pathlib.Path(__file__).resolve().parent / "snap.json"
    out.write_text(json.dumps(snap))
    print(f"wrote {out}: faces={len(faces)} persons={len(persons)} images={len(images)}")


if __name__ == "__main__":
    main()
