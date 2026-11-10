#!/usr/bin/env python3
"""Dump the WhoT faces.db snapshot into snap.json for the Tauri mock backend.

Read-only: the database is opened with mode=ro and never written to.

Usage:
    python3 dump_snap.py [--db PATH] [--raw]

Writes snap.json next to this script (gitignored).

The output is SANITIZED by default (#236): no personal names, surnames,
notes or user-home paths survive — the documented contract lives in the
README (test/gui-mock/README.md, "Sanitization"). `--raw` dumps the
snapshot unsanitized for local debugging fidelity; never commit or
share a --raw dump.
"""
import argparse
import json
import pathlib
import re
import sqlite3
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]


# --- sanitization (the README "Sanitization" contract) -------------------

# structural names that are not personal data and never rewritten
# (#165 legacy bin `Rejected` + the #266 writer-owned cluster family
# `RejectedN` — both stay verbatim)
RESERVED_PERSON_NAMES = {"Rejected"}
RESERVED_PERSON_RE = re.compile(r"^Rejected\d+$")
RESERVED_SEGMENTS = {"Accepted", "New", "Rejected"}
GENERIC_HOME = "tester"
GENERIC_KEY = "person"
# stray personal words outside the person-name/segment corpus (the DB's
# free-text spots carry first names that are not their holder's own
# name-token list)
CURATED_NAME_TOKENS = {"Dawid"}

# generic person names: John Smith1, John Smith2, ...
GENERIC_FIRST = "John"
GENERIC_LAST = "Smith"

UNKNOWN_RE = re.compile(r"^Unknown\d+$")
HOME_RE = re.compile(r"^(/home/)[^/]+")


def _name_tokens(name):
    """Words of a personal name that identify (>= 3 chars)."""
    return [w for w in re.split(r"[^A-Za-zÀ-ÿ]+", name) if len(w) >= 3]


def sanitize_snap(snap):
    """Sanitize a dumped snapshot (see the README contract) and return it.

    Pure: reads only the snapshot structure. Deterministic,
    identity-preserving and structure-preserving: every real name maps
    to one stable generic (`John Smith{n}` by person id, one `Group{n}`
    per distinct path segment, one `Dir{n}` per distinct directory
    segment — each in first-seen order), and no count or id changes in
    any way.
    """
    raw_persons = snap["persons"]
    raw_paths = [g for p in raw_persons for g in p["groups"]]

    # --- the replacement dictionary, BEFORE anything is masked ---------
    tokens = set()
    person_tokens = set()
    for i, p in enumerate(raw_persons):
        n = p["name"]
        if not UNKNOWN_RE.match(n) and n not in RESERVED_PERSON_NAMES \
                and not RESERVED_PERSON_RE.match(n):
            tokens.update(_name_tokens(n))
            # the raw person-name words (still unmasked here) also drive
            # the DIRECTORY renames further below; the snapshot's person
            # rows are masked in place, so capture them up front
            person_tokens.update(w.lower() for w in _name_tokens(n))
    for path in raw_paths:
        for seg in path.split("|"):
            if seg not in RESERVED_SEGMENTS:
                tokens.update(w.lower() for w in _name_tokens(seg))
    tokens.update(w.lower() for w in CURATED_NAME_TOKENS)
    person_tokens.update(w.lower() for w in CURATED_NAME_TOKENS)
    token_re = (
        re.compile(r"\b(" + "|".join(re.escape(t) for t in sorted(tokens, key=len, reverse=True)) + r")\b",
                   re.IGNORECASE)
        if tokens else None)

    # --- persons: John Smith{n} in id order (the snapshot is sorted) ---
    person_name = {}
    serial = 0
    for p in raw_persons:
        # stable per distinct name (persons.name is UNIQUE in the schema)
        if p["name"] not in person_name and not UNKNOWN_RE.match(p["name"]) \
                and p["name"] not in RESERVED_PERSON_NAMES \
                and not RESERVED_PERSON_RE.match(p["name"]):
            serial += 1
            person_name[p["name"]] = f"{GENERIC_FIRST} {GENERIC_LAST}{serial}"
    for p in raw_persons:
        p["name"] = person_name.get(p["name"], p["name"])
        if token_re and p.get("note"):
            p["note"] = token_re.sub(GENERIC_KEY, p["note"])

    # --- group paths: one generic per distinct segment, injective ------
    seg_name = {}
    for path in raw_paths:
        for seg in path.split("|"):
            if seg not in RESERVED_SEGMENTS and seg not in seg_name:
                seg_name[seg] = f"Group{len(seg_name) + 1}"
    for p in raw_persons:
        p["groups"] = [
            "|".join(seg_name.get(seg, seg) for seg in g.split("|"))
            for g in p["groups"]
        ]

    # --- faces: labels rebuilt on the mock's own renumber formula ------
    by_id = {p["id"]: p for p in raw_persons}
    for f in snap["faces"]:
        desc = f.get("description")
        if token_re and desc:
            f["description"] = token_re.sub(GENERIC_KEY, desc)
        p = by_id.get(f.get("person_id"))
        if p is None:
            # no person holder — mask the tokens, keep the stored shape
            if token_re and f.get("name"):
                f["name"] = token_re.sub(GENERIC_KEY, f["name"])
        else:
            desc2 = f.get("description")
            f["name"] = f"{p['name']}" + (f"-{desc2}" if desc2 else "") + f"-{f['seq']}"

    # --- paths -----------------------------------------------------------
    # the home component rewritten; then DIRECTORY segments carrying a
    # person-name word (the annotator used personal names as directory
    # labels, e.g. `Marianne-LLD`) get one `Dir{n}` per distinct segment,
    # injective by first-seen order (images by id; imports share the
    # segment map built from the images). Filenames and the generic
    # directory structure stay untouched; the branches' alpha-sort may
    # shift for the renamed segments — always self-consistent within
    # the snapshot (the checks discover these branches by path, never
    # by literal).
    dir_token_re = (
        re.compile(r"(?<![\wÀ-ÿ])(" +
                   "|".join(re.escape(t) for t in sorted(person_tokens, key=len, reverse=True)) +
                   r")(?![\wÀ-ÿ])", re.IGNORECASE)
        if person_tokens else None)

    dir_name = {}

    def sanitize_path(p, is_dir=False):
        """home rewrite + person-name directory segments (map shared
        with all paths; imports inherit the images' numbering). An
        image path's last segment is a FILE name (never renamed); an
        `is_dir` path (the import rows) has no file name — every
        segment is a directory."""
        p = HOME_RE.sub("/home/" + GENERIC_HOME, p, count=1)
        if dir_token_re is None:
            return p
        segs = [s for s in p.split("/") if s != ""]
        # for an image path the last segment is the file name — never
        # a rename candidate
        to_check = range(len(segs)) if is_dir else range(len(segs) - 1)
        for i in to_check:
            seg = segs[i]
            if seg and dir_token_re.search(seg):
                if seg not in dir_name:
                    dir_name[seg] = f"Dir{len(dir_name) + 1}"
                segs[i] = dir_name[seg]
        return "/" + "/".join(segs) if p.startswith("/") else "/".join(segs)

    out_paths = [sanitize_path(img["primary_path"]) for img in snap["images"]]
    for img, p in zip(snap["images"], out_paths):
        img["primary_path"] = p
    for imp in snap["imports"]:
        imp["path"] = sanitize_path(imp["path"], is_dir=True)

    return snap


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=str(REPO / "data" / "faces.db"),
                    help="path to faces.db (default: <repo>/data/faces.db)")
    ap.add_argument("--raw", action="store_true",
                    help="dump unsanitized (debugging fidelity; never commit or share)")
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
        "rotation": f["rotation"],
        "import_id": f["detected_in_import_id"], "created_at": f["created_at"],
    } for f in con.execute("select * from faces order by id")]

    images = [{
        "id": i["id"], "primary_path": i["primary_path"], "width": i["width"],
        "height": i["height"], "orientation": i["orientation"], "rotation": i["rotation"], "rtype": i["type"],
        "state": i["state"], "first_import_id": i["first_import_id"],
        "last_import_id": i["last_import_id"],
    } for i in con.execute("select * from images order by id")]

    imports = [{"id": r["id"], "path": r["path"], "started_at": r["started_at"]}
               for r in con.execute("select * from imports order by id")]

    config = REPO / "config" / "whotrc.json"
    settings = json.loads(config.read_text()) if config.exists() else {}
    snap = {"persons": persons, "faces": faces, "images": images,
            "imports": imports, "settings": settings}
    if not args.raw:
        sanitize_snap(snap)
    out = pathlib.Path(__file__).resolve().parent / "snap.json"
    out.write_text(json.dumps(snap))
    mode = "raw" if args.raw else "sanitized"
    print(f"wrote {out} ({mode}): faces={len(faces)} persons={len(persons)} images={len(images)}")


if __name__ == "__main__":
    main()
