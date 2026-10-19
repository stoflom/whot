#!/usr/bin/env python3
"""

The archival sources — darktable sidecar XMP, digiKam's core and recognition
databases, the Lightroom catalog and Lightroom's own sidecars — already know a
great deal about who is in the archive. This stage reads them (all external
DBs read-only) and writes what they know into the per-run staging DB created
by `import_common.py`. It never touches the review DB; promote (#34) is a
separate step.

Design: app/app-design.md §5.1, §5.1b.

THE PARSERS LIVE IN THIS STAGE
------------------------------
The sidecar/digiKam/Lightroom readers (`sidecar_face_data`,
`sidecar_people_paths`, `IMAGE_EXTS`, `RAW_PREF_EXTS`, `DK_RECT_PAT`) are
implemented below, so stage 2 is self-contained (app-design §2.1). The reads
follow what the source applications actually store; the writes are expressed
against the v3 schema — content-keyed `images` + `image_paths`, `person_refs`
with a kind, path-keyed `dktags`, and `dkt_image_tags` joining tag to image
by content id.

Two consequences of the v3 shape worth stating:

* A face only attaches to an image that is already staged (hashed by
  stage 1). An unmatched sidecar still contributes person_paths and presence
  is skipped — there is nothing content-addressed to key a face on.
* digiKam records no usable path for almost every image: 130,672 of 130,674
  rows have Images.album = NULL, so the album cannot reconstruct one. Images
  are matched on a reconstructed path where it exists, and otherwise on
  **(basename, byte size)** — never basename alone, since 69.7% of basenames
  collide archive-wide. An ambiguous candidate is reported, not guessed.

The Lightroom loaders have one more constraint, and it is the reason they are
portable at all: v1 already ran them, so the review DB holds 10,522
`lightroom-catalog` faces and 2,649 `lightroom-sidecars` faces whose
`face_key`s are built from what v1 wrote. `face_key` hashes
(image, person, source, source_ref, box), so `source_ref = 'face:<id_local>'`,
`source_ref = NULL` and the `round()` from normalised corners to pixels are
contract, not preference — changing any of them re-keys 13,171 faces and
orphans the user's decisions on 9,657 of them.

Issues here are written as v3 rows via `face_db2.add_issue()` with a dedupe
key, not carried from v1.

Usage:
    cd scripts && python3 import_harvest.py --run <run_id> \\
        --images ~/Pictures --sources sidecars-mwgrs,digikam-core,...
    cd scripts && python3 import_harvest.py --run <run_id> \\
        --images /mnt/archive/LIVE/PICTURES/PicFiles \\
        --lightroom-catalog ~/archive/StofLomPictures-v13-3.lrcat \\
        --lr-root 'D:/LIVE/=/mnt/archive/LIVE' \\
        --sources lightroom-catalog,lightroom-sidecars
    cd scripts && python3 import_harvest.py --db /tmp/staging.db --dry-run
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

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import envlib          # noqa: E402
import face_db2 as fdb  # noqa: E402
import import_common as ic  # noqa: E402

# Every source this stage can read.  The Lightroom readers landed with gh #39
# (app/app-design.md §5.1b), so there is no longer a deferred set: a source
# either has a reader here or is not canonical.
ALL_SOURCES = (
    "sidecars-mwgrs",
    "sidecars-mpri",
    "sidecars-catsets",
    "digikam-core",
    "digikam-recognition",
    "digikam-faces",
    "lightroom-catalog",
    "lightroom-sidecars",
)

# A face the user picked by hand in Lightroom scores higher than one the
# catalog merely suggested.  Both are still approval='imported': stage 3 is the
# arbiter either way (§6.2), so this is a prior, not a verdict.
LR_PICK_SCORE = 0.9
LR_SUGGEST_SCORE = 0.75

# `face_key` hashes (image, person, source, source_ref, box).  The bootstrap
# harvest already wrote 10,522 Lightroom faces into the review DB, 9,657 of
# them confirmed by the user, so these formats are
# not a choice: 'face:<id_local>' and the pixel rounding below are what those
# keys were built from, and changing either re-keys every one of them.
LR_FACE_REF = "face:{}"
LR_PERSON_REF = "keyword:{}"       # over AgLibraryKeyword.id_global (a UUID)

# digiKam tag paths are joined with "|", matching the live v3 dktags table.
TAG_SEP = "|"


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------
# sidecar XMP parse — these are the only implementations of the sidecar
# readers, so they live with the one stage that uses them (app-design 2.1).
# --------------------------------------------------------------------------

# RAW master extensions, preferred when mapping a Lightroom-style sidecar
# (<name>.xmp) onto a same-base-name image that exists in several formats
# (the same-name JPG is normally an export of the processed RAW).
RAW_PREF_EXTS = (".pef", ".cr3", ".cr2", ".dng", ".nef", ".arw",
                 ".orf", ".rw2", ".x3f", ".rwl", ".hif", ".srf")

# mwg-rs face regions appear in TWO serializations:
#   A (attribute form, digiKam export):
#     <rdf:Description mwg-rs:Name="X" mwg-rs:Type="Face">
#       <mwg-rs:Area stArea:x="0.47" stArea:y=".." stArea:w=".." stArea:h=".."
#                    stArea:unit="normalized"/>
#   B (element form, Lightroom/darktable export):
#     <rdf:li rdf:parseType='Resource'>
#       <mwg-rs:Area rdf:parseType='Resource'>
#         <stArea:h>0.13</stArea:h> <stArea:w>..</stArea:w>
#         <stArea:x>..</stArea:x> <stArea:y>..</stArea:y>
#       </mwg-rs:Area>
#       <mwg-rs:Name><person name></mwg-rs:Name>
#       <mwg-rs:Type>Face</mwg-rs:Type>
# </rdf:li>
MWG_REG_PAT = re.compile(r'<mwg-rs:Regions\b.*?</mwg-rs:Regions>', re.S)
LI_ANY_PAT = re.compile(r'<rdf:li\b.*?</rdf:li>', re.S)


def _mwg_field(seg: str, field: str):
    """Value of a mwg-rs/stArea/stDim field in attribute or element form."""
    m = re.search(rf'{field}="([^"]*)"', seg)
    if m:
        return m.group(1)
    m = re.search(rf'<{field}>([^<]*)</{field}>', seg)
    return m.group(1).strip() if m else None


# MPRI regions: <rdf:li MPReg:PersonDisplayName=".."/>
MPRI_NAME_PAT = re.compile(r'rdf:li\s+MPReg:PersonDisplayName="([^"]*)"')
# any rdf:li item (hierarchical tags)
LI_PAT = re.compile(r'<rdf:li[^>]*>(.*?)</rdf:li>', re.S)
HIER_PAT = re.compile(
    r"<(?:lr|darktable):hierarchicalSubject>.*?</(?:lr|darktable):hierarchicalSubject>", re.S)
CATSET_PAT = re.compile(
    r"<mediapro:CatalogSets>.*?</mediapro:CatalogSets>", re.S)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".nef", ".cr2", ".cr3",
              ".dng", ".arw", ".orf", ".rw2", ".pef", ".psd", ".x3f", ".rwl",
              ".webp", ".bmp", ".heic", ".hif", ".srf", ".g3n", ".ppm"}

# digiKam face rectangles (ImageTagProperties tagRegion).
DK_RECT_PAT = re.compile(r'<rect x="(\d+)" y="(\d+)" width="(\d+)" '
                         r'height="(\d+)"/>')


def _fnum(s: str):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def sidecar_face_data(xmp_text: str):
    """Yield (kind, name, x, y, w, h, unit, img_w, img_h) from one sidecar.

    kind is 'mwgrs' (rectangle) or 'mpri' (presence, None geometry).
    Handles both mwg-rs serializations (attribute and element form).
    """
    for block in MWG_REG_PAT.finditer(xmp_text):
        bsec = block.group(0)
        img_w = _fnum(_mwg_field(bsec, "stDim:w"))
        img_h = _fnum(_mwg_field(bsec, "stDim:h"))
        for li in LI_ANY_PAT.finditer(bsec):
            seg = li.group(0)
            if "mwg-rs:Name" not in seg:
                continue
            name = _mwg_field(seg, "mwg-rs:Name")
            rtype = _mwg_field(seg, "mwg-rs:Type") or "Face"
            if not name or rtype != "Face":
                continue
            # search area fields in the <mwg-rs:Area …> part (both forms),
            # falling back to the whole li
            asec = seg[seg.find("<mwg-rs:Area"):]
            if asec.startswith("<"):
                asec = asec.split("</mwg-rs:")[0]
            else:
                asec = seg
            vals = []
            for axis in ("x", "y", "w", "h"):
                v = _mwg_field(asec, f"stArea:{axis}")
                vals.append(_fnum(v) if v is not None else None)
            unit = _mwg_field(asec, "stArea:unit") or "normalized"
            yield ("mwgrs", name, *vals, unit,
                   int(img_w) if img_w is not None else None,
                   int(img_h) if img_h is not None else None)
    # MPRI display names
    for m in MPRI_NAME_PAT.finditer(xmp_text):
        if m.group(1):
            yield ("mpri", m.group(1), None, None, None, None, None, None, None)


def sidecar_people_paths(xmp_text: str):
    """Hierarchical tag paths under the `People` root (leaf = person name)."""
    paths = set()
    for block in HIER_PAT.finditer(xmp_text):
        for li in LI_PAT.finditer(block.group(0)):
            item = li.group(1).strip()
            if item.startswith("People|") or item == "People":
                paths.add(item)
    for block in CATSET_PAT.finditer(xmp_text):
        for li in LI_PAT.finditer(block.group(0)):
            item = li.group(1).strip()
            if item.startswith("People|") or item == "People":
                paths.add(item)
    return paths


# --------------------------------------------------------------------------
# v3 write helpers
# --------------------------------------------------------------------------

def image_id_by_path(con: sqlite3.Connection, path: str) -> int | None:
    """The staged image_id for *path*, or None when stage 1 did not hash it.

    `image_paths` is populated by stage 1.  Preferring a 'live' location
    keeps the live tree authoritative over the archive.
    """
    r = con.execute(
        "SELECT image_id FROM image_paths WHERE path=?"
        " ORDER BY (location='live') DESC, id LIMIT 1", (path,)).fetchone()
    return r[0] if r else None


def person_id(con: sqlite3.Connection, name: str) -> int:
    """Get-or-create a person by name; seeded persons are reused as-is."""
    con.execute("INSERT OR IGNORE INTO persons(name) VALUES(?)", (name,))
    return con.execute("SELECT id FROM persons WHERE name=?", (name,)).fetchone()[0]


def add_image_person(con: sqlite3.Connection, image_id: int, pid: int,
                     source_id: int, source_ref: str | None) -> bool:
    """NULL-safe insert-or-ignore; True if a row was added.

    SQLite treats NULLs as distinct in a UNIQUE, so `INSERT OR IGNORE` alone
    would duplicate a NULL source_ref every run."""
    before = con.total_changes
    con.execute(
        "INSERT INTO image_persons(image_id, person_id, source_id, source_ref)"
        " SELECT ?,?,?,? WHERE NOT EXISTS("
        "   SELECT 1 FROM image_persons WHERE image_id=? AND person_id=?"
        "     AND source_id=? AND source_ref IS ?)",
        (image_id, pid, source_id, source_ref,
         image_id, pid, source_id, source_ref))
    return con.total_changes > before


def add_person_path(con: sqlite3.Connection, pid: int, path: str) -> None:
    con.execute("INSERT OR IGNORE INTO person_paths(person_id, path)"
                " VALUES(?,?)", (pid, path))


def add_person_ref(con: sqlite3.Connection, pid: int, kind: str,
                   ref: str) -> None:
    con.execute("INSERT OR IGNORE INTO person_refs(person_id, kind, ref)"
                " VALUES(?,?,?)", (pid, kind, ref))


def add_face(con: sqlite3.Connection, *, image_id: int, pid: int,
             x, y, w, h, unit, img_w, img_h, source_id: int,
             source_ref: str | None = None,
             approval: str = "imported", score: float = 0.75) -> bool:
    """Insert a face; True if a row was added.  face_key stays NULL until
    stage 3 rekeys (invariant I3).

    False means the row already existed.  That is normal and worth counting:
    digiKam keeps several Images rows for one file, so the same box is often
    offered more than once.
    """
    before = con.total_changes
    con.execute(
        "INSERT OR IGNORE INTO faces(image_id, person_id, x, y, w, h, unit,"
        " img_w, img_h, source_id, source_ref, approval, score)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (image_id, pid, x, y, w, h, unit, img_w, img_h, source_id,
         source_ref, approval, score))
    return con.total_changes > before


def get_or_create_dktag(con: sqlite3.Connection, path: str, name: str,
                        pid: int | None) -> int:
    r = con.execute("SELECT id FROM dktags WHERE path=?", (path,)).fetchone()
    if r:
        if pid is not None:
            con.execute("UPDATE dktags SET person_id=COALESCE(person_id, ?)"
                        " WHERE id=?", (pid, r[0]))
        return r[0]
    cur = con.execute("INSERT INTO dktags(name, path, person_id) VALUES(?,?,?)",
                      (name, path, pid))
    return cur.lastrowid


def add_dkt_image_tag(con: sqlite3.Connection, tag_id: int, image_id: int,
                      pid: int | None) -> bool:
    """True if a row was added; False if the (tag, image) pair already existed."""
    before = con.total_changes
    con.execute("INSERT OR IGNORE INTO dkt_image_tags(tag_id, image_id,"
                " person_id) VALUES(?,?,?)", (tag_id, image_id, pid))
    return con.total_changes > before


# --------------------------------------------------------------------------
# loaders
# --------------------------------------------------------------------------

def image_known(con: sqlite3.Connection, iid: int | None, path: str | None,
                review_paths: set[str] | None) -> bool:
    """gh #102 (design 8.8): may this image receive image-scoped data?

    Path first — the gate is a check against the *review* DB's
    `image_paths`, never against staging.  Falls back to the staged image's
    paths when the source offers no path of its own (digiKam's
    reconstruction is best-effort).  A source that yields neither path nor
    id is unknowable here and returns True, so the caller keeps its own
    counter (dk's 'unknown') instead of a fabricated gate hit.

    `review_paths is None` (the gate off, and every existing caller)
    answers True for everything — behaviour byte-identical to 5.0.
    """
    if review_paths is None:
        return True
    if path is not None:
        return path in review_paths
    if iid is None:
        return True
    for (p,) in con.execute(
            "SELECT path FROM image_paths WHERE image_id=?", (iid,)):
        if p in review_paths:
            return True
    return False


def harvest_sidecars(con: sqlite3.Connection, images_dirs: list[Path],
                     src: dict[str, int], stats: dict,
                     enabled: set[str],
                     review_paths: set[str] | None = None) -> set[str]:
    """XMP `<image.ext>.xmp` sidecars: MWG-RS rects, MPRI presence, People| paths.

    darktable's export style, and the only sidecar shape whose faces were
    harvested as `sidecars-mwgrs`.  Lightroom's own `<stem>.xmp` (no image
    extension in the stem) is a different loader, `harvest_lightroom_sidecars`,
    because the two disagree on which file the sidecar belongs to.
    """
    known: set[str] = set()
    person_paths: dict[str, set[str]] = {}
    n_files = n_faces = n_presence = n_paths = n_unmatched = 0
    n_faces_dup = n_presence_dup = 0
    n_faces_nidb = n_pres_nidb = 0
    for images_dir in images_dirs:
        if not images_dir.is_dir():
            log(f"  (images dir not found: {images_dir})")
            continue
        for root, _dirs, files in os.walk(images_dir):
            for fname in files:
                if not fname.lower().endswith(".xmp"):
                    continue
                img = fname[:-4]
                if Path(img).suffix.lower() not in IMAGE_EXTS:
                    continue
                try:
                    text = open(Path(root, fname), errors="ignore").read()
                except OSError:
                    continue
                n_files += 1
                img_path = str(Path(root, img))
                iid = image_id_by_path(con, img_path)
                # gh #102 (8.8): the gate decides *before* the writes — a
                # path the review DB has never seen gets no face and no
                # presence row, but its People|… paths still import: person
                # data is not image-scoped.
                gated = not image_known(con, iid, img_path, review_paths)
                if iid is None and not gated:
                    n_unmatched += 1

                for kind, name, x, y, w, h, unit, iw, ih in sidecar_face_data(text):
                    pid = person_id(con, name)
                    known.add(name)
                    if gated:
                        if kind == "mwgrs":
                            n_faces_nidb += 1
                        else:
                            n_pres_nidb += 1
                        continue
                    if kind == "mwgrs":
                        if iid is None or "sidecars-mwgrs" not in enabled:
                            continue
                        if add_face(con, image_id=iid, pid=pid, x=x, y=y, w=w,
                                    h=h, unit=unit or "normalized", img_w=iw,
                                    img_h=ih, source_id=src["sidecars-mwgrs"]):
                            n_faces += 1
                        else:
                            n_faces_dup += 1
                    else:
                        if iid is None or "sidecars-mpri" not in enabled:
                            continue
                        if add_image_person(con, iid, pid,
                                            src["sidecars-mpri"], None):
                            n_presence += 1
                        else:
                            n_presence_dup += 1

                if "sidecars-catsets" not in enabled:
                    continue
                for p in sidecar_people_paths(text):
                    if p == "People":
                        continue
                    leaf = p.rsplit(TAG_SEP, 1)[-1]
                    pid = person_id(con, leaf)
                    known.add(leaf)
                    person_paths.setdefault(leaf, set()).add(p)
                    n_paths += 1
                    if iid is not None and not gated:
                        add_image_person(con, iid, pid, src["sidecars-catsets"], p)
            con.commit()

    for name, paths in person_paths.items():
        pid = person_id(con, name)
        for p in paths:
            add_person_path(con, pid, p)
    con.commit()
    stats.update({"scanned": n_files, "faces": n_faces, "presence": n_presence,
                  "people_paths": n_paths, "sidecar_images_unmatched": n_unmatched,
                  "faces_dup": n_faces_dup, "presence_dup": n_presence_dup})
    if review_paths is not None:
        stats["sidecar_faces_not_in_db"] = n_faces_nidb
        stats["sidecar_presence_not_in_db"] = n_pres_nidb
    return known


def harvest_recognition(con: sqlite3.Connection, db_path: Path, src_id: int,
                        stats: dict) -> set[str]:
    """digiKam recognition DB: identity names -> persons, UUIDs -> person_refs."""
    if not db_path.exists():
        log(f"  (recognition db not found: {db_path})")
        stats["identities"] = 0
        return set()
    con2 = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    names: set[str] = set()
    n_refs = 0
    try:
        ids = {r[0] for r in con2.execute("SELECT id FROM Identities")}
        by_name: dict[int, set[str]] = {}
        by_uuid: dict[int, set[str]] = {}
        for iid, attr, val in con2.execute(
                "SELECT id, attribute, value FROM IdentityAttributes"):
            if iid not in ids or not val:
                continue
            if attr in ("fullName", "name"):
                by_name.setdefault(iid, set()).add(val)
            elif attr == "uuid":
                by_uuid.setdefault(iid, set()).add(val)
        # two passes rather than v1's single pass, which silently dropped a
        # UUID that appeared before its identity's name in row order
        for iid, ns in by_name.items():
            for name in ns:
                person_id(con, name)
                names.add(name)
        for iid, uuids in by_uuid.items():
            for name in by_name.get(iid, ()):  # only identities that have a name
                pid = person_id(con, name)
                for u in uuids:
                    add_person_ref(con, pid, "digikam-recognition", u)
                    n_refs += 1
    finally:
        con2.close()
    con.commit()
    stats["identities"] = len(names)
    stats["recognition_refs"] = n_refs
    return names


def _digikam_tag_paths(con2: sqlite3.Connection) -> dict[int, str]:
    tags = {r[0]: (r[1], r[2]) for r in
            con2.execute("SELECT id, pid, name FROM Tags")}

    def path_of(tid):
        parts, seen = [], set()
        while tid in tags and tid not in seen:
            parts.append(tags[tid][1])
            tid = tags[tid][0]
            seen.add(tid)
        return TAG_SEP.join(reversed(parts)) if parts else None

    return {tid: p for tid in tags if (p := path_of(tid))}


def _digikam_reconstructed_paths(con2: sqlite3.Connection) -> dict[int, str]:
    """digiKam image id -> full posix path, *where reconstructable*.

    The path is AlbumRoots.specificPath + Albums.relativePath + name.  That
    only works when Images.album is set, and in this archive it is not:
    130,672 of 130,674 digiKam images have album = NULL, so their location is
    genuinely not recorded.  Those are left out here and resolved by size
    instead (see resolve_dk_image).  Returning the ones we can is still worth
    it -- it is exact where it applies.
    """
    roots = {r[0]: r[1] for r in
             con2.execute("SELECT id, specificPath FROM AlbumRoots")}
    albums = {r[0]: r[1] for r in
              con2.execute("SELECT id, albumRoot FROM Albums")}
    rel = {r[0]: (r[1] or "") for r in
           con2.execute("SELECT id, relativePath FROM Albums")}
    out: dict[int, str] = {}
    for iid, album_id, name in con2.execute(
            "SELECT id, album, name FROM Images"):
        root = roots.get(albums.get(album_id))
        if root and name:
            out[iid] = str(Path(root) / rel.get(album_id, "").lstrip("/")
                           / name)
    return out


def staged_indexes(con: sqlite3.Connection) -> tuple[dict[str, int],
                                                       dict[tuple[str, int],
                                                            list[int]]]:
    """(path -> image_id, (basename, size) -> [image_id]) for the staging DB.

    stage 1 records images.size, which is what makes a size-based match
    possible at all.
    """
    path_to_id: dict[str, int] = {}
    for path, iid in con.execute("SELECT path, image_id FROM image_paths"):
        path_to_id.setdefault(path, iid)
    by_name_size: dict[tuple[str, int], list[int]] = {}
    for path, iid, size in con.execute(
            "SELECT ip.path, ip.image_id, i.size FROM image_paths ip"
            " JOIN images i ON i.id = ip.image_id WHERE i.size IS NOT NULL"):
        by_name_size.setdefault(
            (path.rsplit("/", 1)[-1], size), []).append(iid)
    return path_to_id, by_name_size


def resolve_dk_image(dk_id: int, name: str, file_size: int | None,
                     recon: dict[int, str], path_to_id: dict[str, int],
                     by_name_size: dict[tuple[str, int], list[int]]
                     ) -> tuple[int | None, str]:
    """digiKam image -> staged image_id, and how it was resolved.

    Returns (image_id or None, 'path' | 'name-size' | 'ambiguous' | 'unknown').

    The order matters.  A reconstructed path is exact, so it wins.  Otherwise
    the name *and* byte size must agree, because 69.7% of basenames collide
    somewhere in the archive.  An ambiguous match is reported rather than
    guessed: silently picking one of several candidates is how a face ends up
    attached to the wrong file.
    """
    if name:
        p = recon.get(dk_id)
        if p and p in path_to_id:
            return path_to_id[p], "path"
        if file_size is not None:
            cands = by_name_size.get((name, file_size))
            if cands and len(cands) == 1:
                return cands[0], "name-size"
            if cands and len(cands) > 1:
                return None, "ambiguous"
    return None, "unknown"


def harvest_digikam_core(con: sqlite3.Connection, db_path: Path,
                         stats: dict, known: set[str]):
    """digiKam core DB: tag paths -> dktags, image tags -> dkt_image_tags."""
    if not db_path.exists():
        log(f"  (digikam core db not found: {db_path})")
        stats["dktags"] = 0
        stats["dkt_pairs"] = 0
        return
    con2 = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    n_pairs = n_pairs_dup = 0
    resolved: dict[str, int] = {}
    try:
        paths = _digikam_tag_paths(con2)
        known_l = {n.lower() for n in known}
        for p in paths.values():
            leaf = p.rsplit(TAG_SEP, 1)[-1]
            pid = person_id(con, leaf) if leaf.lower() in known_l else None
            get_or_create_dktag(con, p, leaf, pid)
        # distinct paths, not digiKam tag ids: several tag ids can carry the
        # same path, and dktags is keyed by path
        n_tags = len(set(paths.values()))

        recon = _digikam_reconstructed_paths(con2)
        path_to_id, by_name_size = staged_indexes(con)
        meta = {r[0]: (r[1], r[2]) for r in
                con2.execute("SELECT id, name, fileSize FROM Images")}
        for dk_id, tid in con2.execute(
                "SELECT imageid, tagid FROM ImageTags"):
            p = paths.get(tid)
            if p is None:
                continue
            leaf = p.rsplit(TAG_SEP, 1)[-1]
            if leaf.lower() not in known_l:
                continue
            name, fsize = meta.get(dk_id, (None, None))
            iid, how = resolve_dk_image(dk_id, name, fsize, recon, path_to_id,
                                        by_name_size)
            resolved[how] = resolved.get(how, 0) + 1
            if iid is None:
                continue
            pid = person_id(con, leaf)
            tag_id = get_or_create_dktag(con, p, leaf, pid)
            if add_dkt_image_tag(con, tag_id, iid, pid):
                n_pairs += 1
            else:
                n_pairs_dup += 1
        con.commit()
    finally:
        con2.close()
    stats["dktags"] = n_tags
    stats["dkt_pairs"] = n_pairs
    stats["dkt_pairs_dup"] = n_pairs_dup
    for how in ("path", "name-size", "ambiguous", "unknown"):
        if how in resolved:
            stats[f"dkt_resolved_{how}"] = resolved[how]


def harvest_digikam_faces(con: sqlite3.Connection, db_path: Path, src_id: int,
                          stats: dict,
                          review_paths: set[str] | None = None):
    """digiKam ImageTagProperties tagRegion -> faces."""
    if not db_path.exists():
        log(f"  (digikam core db not found: {db_path})")
        stats["dk_faces"] = 0
        return
    con2 = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    n = n_dup = n_nidb = 0
    resolved: dict[str, int] = {}
    try:
        recon = _digikam_reconstructed_paths(con2)
        path_to_id, by_name_size = staged_indexes(con)
        meta = {r[0]: (r[1], r[2]) for r in
                con2.execute("SELECT id, name, fileSize FROM Images")}
        for img_id, tname, val in con2.execute(
                "SELECT itp.imageid, t.name, itp.value "
                "FROM ImageTagProperties itp "
                "JOIN Tags t ON t.id = itp.tagid "
                "WHERE itp.property = 'tagRegion'"):
            m = DK_RECT_PAT.search(val or "")
            if not m:
                stats["dk_faces_unparsed"] = \
                    stats.get("dk_faces_unparsed", 0) + 1
                continue
            x, y, w, h = map(int, m.groups())
            if w <= 0 or h <= 0:
                continue
            name, fsize = meta.get(img_id, (None, None))
            iid, how = resolve_dk_image(img_id, name, fsize, recon, path_to_id,
                                        by_name_size)
            resolved[how] = resolved.get(how, 0) + 1
            # gh #102 (8.8): the gate judges the *reconstructed path* (when
            # there is one) against the review DB — before the write, and
            # before 'unstaged' can hide the reason.  Person creation keeps
            # the ungated flow's shape: it happens when the row resolves.
            gated = not image_known(con, iid, recon.get(img_id), review_paths)
            if iid is None:
                if gated:
                    n_nidb += 1
                continue
            pid = person_id(con, tname)
            if gated:
                n_nidb += 1
                continue
            if add_face(con, image_id=iid, pid=pid, x=x, y=y, w=w, h=h,
                        unit="pixels", img_w=None, img_h=None,
                        source_id=src_id):
                n += 1
            else:
                n_dup += 1
        con.commit()
    finally:
        con2.close()
    stats["dk_faces"] = n
    stats["dk_faces_dup"] = n_dup
    if review_paths is not None:
        stats["dk_faces_not_in_db"] = n_nidb
    for how in ("path", "name-size", "ambiguous", "unknown"):
        if how in resolved:
            stats[f"dk_faces_resolved_{how}"] = resolved[how]


# --------------------------------------------------------------------------
# Lightroom
# --------------------------------------------------------------------------

def parse_lr_roots(specs: list[str],
                   default_location: str = "archive") -> list[tuple[str, Path, str]]:
    """`D:/LIVE/=/mnt/archive/LIVE` -> [('d:/live', Path('/mnt/archive/LIVE'), 'archive')].

    The catalog records Windows paths and the archive is mounted somewhere
    else, so the mapping is stated rather than guessed: a root nobody mapped
    leaves its faces unresolved and counted, never silently re-rooted.

    **Order is preference order, and it matters more than it looks.** The live
    tree and the archive hold different bytes for the same filename — of 400
    face-bearing files sampled, 13 differ — so which copy stage 1 hashes decides
    the `face_key` of every face on that file. Map the live tree first to keep
    the keys the review DB already holds. A trailing `@location` records
    `image_paths.location` per root (`CATALOG=LOCAL@live`); without it the root
    takes `--lr-location`.
    """
    roots: list[tuple[str, Path, str]] = []
    for spec in specs:
        mapping, at, location = spec.rpartition("@")
        if not at:
            mapping, location = spec, default_location
        catalog, sep, local = mapping.partition("=")
        if not sep or not catalog.strip() or not local.strip():
            raise ValueError(
                f"--lr-root wants CATALOG_ROOT=LOCAL_ROOT[@location], got {spec!r}")
        if location not in ("live", "archive", "historical"):
            raise ValueError(
                f"--lr-root location must be live, archive or historical, "
                f"got {location!r} in {spec!r}")
        roots.append((catalog.strip().rstrip("/").casefold(),
                      Path(local.strip()).expanduser(), location))
    return roots


def map_lr_path(catalog_root: str | None, path_from_root: str | None,
                filename: str, roots: list[tuple[str, Path, str]]
                ) -> tuple[str, str] | None:
    """The catalog's own path, mapped onto disk and a location.

    Returns (local path, image_paths.location) for the first root that matches,
    or None when none does.
    """
    cat_root = (catalog_root or "").rstrip("/")
    rel = "/".join(p for p in ((path_from_root or "").strip("/"), filename) if p)
    catalog_path = f"{cat_root}/{rel}" if cat_root else rel
    folded = catalog_path.casefold()
    for prefix, local, location in roots:
        if folded == prefix:
            return str(local), location
        if folded.startswith(prefix + "/"):
            return str(local / catalog_path[len(prefix) + 1:]), location
    return None


def _lr_keyword_paths(con2: sqlite3.Connection) -> dict[int, str]:
    """id_local -> 'People|Friends|Pelsers|Winnie Pelser', for person keywords.

    The walk is over *every* keyword, not just person ones, so the path reaches
    the top of the tree.  v1 walked only person keywords, which stops at the
    first non-person ancestor and so yielded a bare name 375 times out of 377 —
    too thin to compare against the `People|…` paths the sidecars contribute.
    """
    name_of = {r[0]: (r[1], r[2]) for r in con2.execute(
        "SELECT id_local, name, parent FROM AgLibraryKeyword")}
    cache: dict[int, str] = {}

    def path_of(lid: int, depth: int = 0) -> str | None:
        if lid in cache:
            return cache[lid]
        if depth > 32 or lid not in name_of:
            return None
        name, parent = name_of[lid]
        rest = path_of(parent, depth + 1) if parent else None
        out = f"{rest}{TAG_SEP}{name}" if (rest and name) else (rest or name)
        cache[lid] = out
        return out

    return {r[0]: p for r in con2.execute(
        "SELECT id_local FROM AgLibraryKeyword WHERE keywordType='person'")
        if (p := path_of(r[0]))}


def harvest_lap(con: sqlite3.Connection, db_path: Path | None, src_id: int,
                stats: dict, review_paths: set[str] | None = None,
                box_space: str = "corner-pixels"):
    """Lap's person/face store → staged claims with provenance (requirements
    v0.12, R-A1; design §3.3 — the mirror of Lap's own import_person_faces.py).

    The configured Lap database is opened READ-ONLY (I5). A file resolves to
    a staged image **content-hash-first** (Lap's `file_hashes.hash` is the
    same BLAKE3 our `images.hash` stores), falling back to its path
    (`afolders.path` + `afiles.name`). `faces.person_id` in Lap is the user's
    own *Assign a face to a person*, so a linked face propagates as a
    **provenance-tagged acceptance** (`approval='confirmed'`,
    `source_ref='lap:<face id>'`); unlinked detections are not claims and
    stay behind — the join is on persons, by design.

    The bbox space is the run's config — `--lap-box-space`, never guessed
    (§3.3's discipline): `corner-pixels` (default) or `corner-normalized`.
    """
    if db_path is None or not Path(db_path).exists():
        log(f"  (lap db not given or not found: {db_path})")
        stats["lap_faces"] = 0
        return
    norm = (box_space or "corner-pixels").lower().endswith("normalized")
    con2 = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    n = n_dup = n_nidb = 0
    try:
        path_to_id, _by_name_size = staged_indexes(con)
        hash_to_id = {r[0]: r[1] for r in con.execute(
            "SELECT hash, id FROM images WHERE hash IS NOT NULL")}
        folders = {r[0]: r[1] for r in con2.execute(
            "SELECT id, path FROM afolders")}
        files = {r[0]: (r[1], r[2], r[3], r[4]) for r in con2.execute(
            "SELECT id, name, folder_id, width, height FROM afiles")}
        hashes = {r[0]: r[1] for r in con2.execute(
            "SELECT file_id, hash FROM file_hashes WHERE hash IS NOT NULL")}
        rows = con2.execute(
            "SELECT fa.id, fa.file_id, fa.bbox, p.name "
            "FROM faces fa JOIN persons p ON p.id = fa.person_id").fetchall()
        for face_id, file_id, bbox_json, person_name in rows:
            rec = files.get(file_id)
            if rec is None or not person_name:
                continue
            name, folder_id, fw, fh = rec
            folder = folders.get(folder_id)
            full = f"{str(folder).rstrip('/')}/{name}" if folder else str(name)
            iid = None
            h = hashes.get(file_id)
            if h:
                iid = hash_to_id.get(h)
            if iid is None:
                iid = path_to_id.get(full)
            gated = not image_known(con, iid, full, review_paths)
            if iid is None or gated:
                if gated:
                    n_nidb += 1
                continue
            try:
                box = json.loads(bbox_json or "")
                bx, by = float(box["x"]), float(box["y"])
                bw, bh = float(box["width"]), float(box["height"])
                conf = float(box.get("confidence") or 0.75)
            except (ValueError, KeyError, TypeError):
                stats["lap_faces_unparsed"] = \
                    stats.get("lap_faces_unparsed", 0) + 1
                continue
            if norm:
                if not fw or not fh:
                    continue
                bx, by, bw, bh = bx * fw, by * fh, bw * fw, bh * fh
            pid = person_id(con, person_name)
            if add_face(con, image_id=iid, pid=pid, x=bx, y=by, w=bw, h=bh,
                        unit="normalized" if norm else "pixels",
                        img_w=fw, img_h=fh, source_id=src_id,
                        source_ref=f"lap:{face_id}",
                        approval="confirmed", score=conf):
                n += 1
            else:
                n_dup += 1
        con.commit()
    finally:
        con2.close()
    stats["lap_faces"] = n
    stats["lap_faces_dup"] = n_dup
    if review_paths is not None:
        stats["lap_faces_not_in_db"] = n_nidb


def harvest_lightroom_catalog(con: sqlite3.Connection, catalog: Path,
                              roots: list[tuple[str, Path, str]],
                              src_id: int, stats: dict,
                              review_paths: set[str] | None = None) -> set[str]:
    """Person keyword tree + face regions from a Lightroom `.lrcat`.

    Read-only per invariant I5.  The catalog is the largest single source of
    hand-made decisions the archive has: 9,688 of its 10,584 face-to-person
    links are `userPick = 1`.  None of it is trusted — every row lands as
    `approval = 'imported'` and stage 3 decides (§6.2) — but `userPick` is
    kept as a prior in `score`, because it is the only evidence the archive has
    that a person said yes.
    """
    if not catalog.exists():
        log(f"  (lightroom catalog not found: {catalog})")
        stats["lr_faces"] = 0
        return set()
    # immutable=1 as well as mode=ro: the catalog is checkpointed, so nothing
    # needs writing and nothing may be written next to it on the archive.
    uri = "file:" + urllib.parse.quote(str(catalog)) + "?mode=ro&immutable=1"
    con2 = sqlite3.connect(uri, uri=True)
    known: set[str] = set()
    n_persons = n_paths = n_refs = n_groups = 0
    n_faces = n_dup = 0
    n_unmapped = n_missing = n_unstaged = n_nodims = n_degenerate = 0
    n_nidb = 0
    try:
        # person keywords: leaves become persons, group nodes do not
        kw = {r[0]: (r[1], r[2], r[3]) for r in con2.execute(
            "SELECT id_local, id_global, name, parent FROM AgLibraryKeyword "
            "WHERE keywordType='person'")}
        group_nodes = {p for (_g, _n, p) in kw.values() if p is not None}
        paths = _lr_keyword_paths(con2)
        for lid, (gid, name, _p) in kw.items():
            if lid in group_nodes:
                n_groups += 1
                continue
            n_persons += 1
            pid = person_id(con, name)
            known.add(name)
            # A bare name in person_paths would false-flag multi-path against
            # every People|… path the sidecars contribute for the same person.
            p = paths.get(lid)
            if p and p.startswith("People" + TAG_SEP):
                add_person_path(con, pid, p)
                n_paths += 1
            add_person_ref(con, pid, "lightroom-catalog", LR_PERSON_REF.format(gid))
            n_refs += 1
        con.commit()

        # face regions
        for (W, H, tlx, tly, trx, bly, name, pick, fid, ap, pfr, fn) in con2.execute(
                "SELECT i.fileWidth, i.fileHeight, fa.tl_x, fa.tl_y, fa.tr_x, "
                "fa.bl_y, k.name, COALESCE(kf.userPick, 0), fa.id_local, "
                "rf.absolutePath, fo.pathFromRoot, fl.idx_filename "
                "FROM AgLibraryFace fa "
                "JOIN Adobe_images i ON i.id_local = fa.image "
                "JOIN AgLibraryFile fl ON fl.id_local = i.rootFile "
                "JOIN AgLibraryFolder fo ON fo.id_local = fl.folder "
                "JOIN AgLibraryRootFolder rf ON rf.id_local = fo.rootFolder "
                "JOIN AgLibraryKeywordFace kf ON kf.face = fa.id_local "
                "JOIN AgLibraryKeyword k ON k.id_local = kf.tag "
                "AND k.keywordType = 'person'"):
            if None in (W, H, tlx, tly, trx, bly):
                n_nodims += 1
                continue
            hit = map_lr_path(ap, pfr, fn or "", roots)
            if hit is None:
                n_unmapped += 1
                continue
            local, location = hit
            # gh #102 (8.8): the gate judges the *mapped path* against the
            # review DB before existence or staging are even asked — a path
            # the database has never seen is skipped as such, not as
            # 'missing' or 'unstaged'.
            if not image_known(con, None, local, review_paths):
                n_nidb += 1
                continue
            if not Path(local).exists():
                n_missing += 1
                continue
            iid = image_id_by_path(con, local)
            if iid is None:
                n_unstaged += 1
                continue
            # The catalog normalizes against fileWidth/fileHeight, so these are
            # file-space pixels already.  round() is banker's rounding, and v1
            # used it: the 10,522 keys in the review DB are built on it.
            x = round(tlx * W)
            y = round(tly * H)
            w = round((trx - tlx) * W)
            h = round((bly - tly) * H)
            if w <= 0 or h <= 0:
                n_degenerate += 1
                continue
            pid = person_id(con, name)
            known.add(name)
            if add_face(con, image_id=iid, pid=pid, x=x, y=y, w=w, h=h,
                        unit="pixels", img_w=None, img_h=None, source_id=src_id,
                        source_ref=LR_FACE_REF.format(fid),
                        approval="imported",
                        score=LR_PICK_SCORE if pick else LR_SUGGEST_SCORE):
                n_faces += 1
                con.execute(
                    "UPDATE image_paths SET location=COALESCE(location, ?) "
                    "WHERE path=?", (location, local))
            else:
                n_dup += 1
        con.commit()
    finally:
        con2.close()
    stats.update({"lr_persons": n_persons, "lr_group_nodes": n_groups,
                  "lr_people_paths": n_paths, "lr_person_refs": n_refs,
                  "lr_faces": n_faces, "lr_faces_dup": n_dup,
                  "lr_root_unmapped": n_unmapped, "lr_file_missing": n_missing,
                  "lr_image_unstaged": n_unstaged, "lr_no_dims": n_nodims,
                  "lr_degenerate": n_degenerate})
    if review_paths is not None:
        stats["lr_faces_not_in_db"] = n_nidb
    return known


def harvest_lightroom_sidecars(con: sqlite3.Connection, images_dirs: list[Path],
                               src_id: int, stats: dict,
                               review_paths: set[str] | None = None) -> set[str]:
    """Lightroom's own `<stem>.xmp`, the RAW-master sidecar style.

    Two things separate this from `harvest_sidecars`.  The stem carries no
    image extension, so the sidecar has to be matched to an image by base name
    in the same directory — RAW preferred, since a same-named JPG is normally
    an export of the RAW — and the People|… paths a Lightroom sidecar carries
    belong to `lightroom-sidecars` rather than to the darktable catset source.
    v1 harvested these too (2,649 faces in the review DB), under the same
    source name and with no `source_ref`, so the same keys come out.
    """
    known: set[str] = set()
    person_paths: dict[str, set[str]] = {}
    n_files = n_faces = n_dup = n_paths = n_nocand = n_unstaged = 0
    n_nidb = 0
    for images_dir in images_dirs:
        if not images_dir.is_dir():
            log(f"  (images dir not found: {images_dir})")
            continue
        for root, _dirs, files in os.walk(images_dir):
            # one pass per directory: the archive is on an external drive and
            # one iterdir() per sidecar is what makes a full walk unbearable
            xmps = [f[:-4] for f in files
                    if f.lower().endswith(".xmp")
                    and Path(f[:-4]).suffix.lower() not in IMAGE_EXTS]
            if not xmps:
                continue
            img_by_base: dict[str, list[str]] = {}
            for f in files:
                sfx = Path(f).suffix.lower()
                if sfx in IMAGE_EXTS and not f.lower().endswith(".xmp"):
                    img_by_base.setdefault(f[:-len(sfx)].lower(), []).append(f)
            for base in xmps:
                cands = img_by_base.get(base.lower(), [])
                if not cands:
                    n_nocand += 1
                    continue
                cands.sort(key=lambda n: (
                    RAW_PREF_EXTS.index(Path(n).suffix.lower())
                    if Path(n).suffix.lower() in RAW_PREF_EXTS else 99,
                    n.lower()))
                cand_path = str(Path(root, cands[0]))
                iid = image_id_by_path(con, cand_path)
                # gh #102 (8.8): the source's own candidate path is the gate
                # input; a face on a path the review DB has never seen is
                # counted as such, not as 'unstaged'.
                gated = not image_known(con, iid, cand_path, review_paths)
                if gated and iid is None:
                    # Outside the gate and never staged: count the faces and
                    # write nothing — not even the People|… paths the
                    # ungated flow would never have reached either.
                    try:
                        text = open(Path(root, base + ".xmp"), errors="ignore").read()
                    except OSError:
                        continue
                    n_files += 1
                    n_nidb += sum(1 for k, *_ in sidecar_face_data(text)
                                 if k == "mwgrs")
                    continue
                if iid is None:
                    n_unstaged += 1
                    continue
                try:
                    text = open(Path(root, base + ".xmp"), errors="ignore").read()
                except OSError:
                    continue
                n_files += 1
                for kind, name, x, y, w, h, unit, iw, ih in sidecar_face_data(text):
                    if kind != "mwgrs":
                        continue
                    pid = person_id(con, name)
                    known.add(name)
                    if gated:
                        n_nidb += 1
                        continue
                    if add_face(con, image_id=iid, pid=pid, x=x, y=y, w=w, h=h,
                                unit=unit or "normalized", img_w=iw, img_h=ih,
                                source_id=src_id):
                        n_faces += 1
                    else:
                        n_dup += 1
                for p in sidecar_people_paths(text):
                    if p == "People":
                        continue
                    leaf = p.rsplit(TAG_SEP, 1)[-1]
                    pid = person_id(con, leaf)
                    known.add(leaf)
                    person_paths.setdefault(leaf, set()).add(p)
                    n_paths += 1
                    if iid is not None and not gated:
                        add_image_person(con, iid, pid, src_id, p)
            con.commit()
    for name, paths in person_paths.items():
        pid = person_id(con, name)
        for p in paths:
            add_person_path(con, pid, p)
    con.commit()
    stats.update({"lrs_scanned": n_files, "lrs_faces": n_faces,
                  "lrs_faces_dup": n_dup, "lrs_paths": n_paths,
                  "lrs_no_candidate": n_nocand,
                  "lrs_image_unstaged": n_unstaged})
    if review_paths is not None:
        stats["lrs_faces_not_in_db"] = n_nidb
    return known


# --------------------------------------------------------------------------
# orchestration
# --------------------------------------------------------------------------

def harvest(con: sqlite3.Connection, *, images_dirs: list[Path],
            digikam_db: Path, recognition_db: Path,
            sources: tuple[str, ...] = ALL_SOURCES,
            lightroom_catalog: Path | None = None,
            lr_roots: list[tuple[str, Path, str]] | None = None,
            lap_db: Path | None = None,
            lap_box_space: str = "corner-pixels",
            dry: bool = False,
            review_paths: set[str] | None = None) -> dict:
    """Run the requested loaders into *con*.

    Returns a stats dict.  External DBs are opened read-only; *con* is the
    caller's staging connection and is committed as each loader finishes.

    `review_paths` (gh #102, design 8.8) is the gate: when given, every
    image-scoped write for a path outside it is skipped and counted
    (`*_faces_not_in_db`); person-level data still imports.  None keeps the
    5.0 behaviour byte-identical.
    """
    unknown = [s for s in sources if s not in ALL_SOURCES]
    if unknown:
        raise ic.SourceNotCanonical(
            f"not a harvest source: {unknown}. This stage reads "
            f"{', '.join(ALL_SOURCES)}")
    if "lightroom-catalog" in sources and lightroom_catalog is None:
        raise ValueError(
            "lightroom-catalog was requested but no catalog was given: pass "
            "--lightroom-catalog <file.lrcat> (or set LIGHTROOM_CATALOG). "
            "A missing catalog is never treated as an empty one")
    roots = lr_roots or []

    stats: dict = {}
    known: set[str] = set()
    enabled = set(sources)

    if dry:
        # Count only: never write to the staging DB.
        log("  [dry-run] parse-only, nothing written")
        known = _dry_scan(images_dirs)
        stats["known_persons"] = len(known)
        return stats

    src_map = ic.ensure_sources(con, sources)

    if any(s.startswith("sidecars-") and s != "lightroom-sidecars"
           for s in sources):
        log(f"  scanning sidecars under {', '.join(str(d) for d in images_dirs)}")
        known = harvest_sidecars(con, images_dirs, src_map, stats, enabled,
                                 review_paths=review_paths)

    if "digikam-recognition" in sources:
        known |= harvest_recognition(con, recognition_db,
                                     src_map["digikam-recognition"], stats)

    if "digikam-core" in sources:
        harvest_digikam_core(con, digikam_db, stats, known)

    if "digikam-faces" in sources:
        harvest_digikam_faces(con, digikam_db, src_map["digikam-faces"], stats,
                              review_paths=review_paths)

    if "lap-faces" in sources:
        harvest_lap(con, lap_db, src_map["lap-faces"], stats,
                    review_paths=review_paths, box_space=lap_box_space)

    if "lightroom-catalog" in sources:
        log(f"  lightroom catalog: {lightroom_catalog}")
        known |= harvest_lightroom_catalog(
            con, lightroom_catalog, roots, src_map["lightroom-catalog"], stats,
            review_paths=review_paths)

    if "lightroom-sidecars" in sources:
        log(f"  scanning Lightroom sidecars under "
            f"{', '.join(str(d) for d in images_dirs)}")
        known |= harvest_lightroom_sidecars(
            con, images_dirs, src_map["lightroom-sidecars"], stats,
            review_paths=review_paths)

    stats["known_persons"] = len(known)
    return stats


def _dry_scan(images_dirs: list[Path]) -> set[str]:
    names: set[str] = set()
    for images_dir in images_dirs:
        if not images_dir.is_dir():
            continue
        for root, _dirs, files in os.walk(images_dir):
            for fname in files:
                if not fname.lower().endswith(".xmp"):
                    continue
                img = fname[:-4]
                if Path(img).suffix.lower() not in IMAGE_EXTS:
                    continue
                try:
                    text = open(Path(root, fname), errors="ignore").read()
                except OSError:
                    continue
                for kind, name, *_ in sidecar_face_data(text):
                    names.add(name)
                for p in sidecar_people_paths(text):
                    if p != "People":
                        names.add(p.rsplit(TAG_SEP, 1)[-1])
    return names


def _staging_connection(args) -> sqlite3.Connection:
    if args.db:
        return fdb.connect(args.db)
    if not args.run:
        raise SystemExit("give --run <run_id> or --db <staging.db>")
    base = Path(args.base).expanduser() if args.base else ic.import_root()
    run = ic.Run(run_id=args.run, kind="", base=base)
    return ic.open_staging(run)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", metavar="RUN_ID",
                    help="import run whose staging DB to fill")
    ap.add_argument("--db", metavar="PATH",
                    help="staging DB path (overrides --run)")
    ap.add_argument("--base", metavar="DIR",
                    help="import root for --run (default ~/.cache/facerec/imports)")
    ap.add_argument("--images", action="append", metavar="DIR", default=[],
                    help="image tree to scan for sidecars (repeatable)")
    ap.add_argument("--digikam-db", default=os.environ.get(
        "DIGIKAM_DB", "~/.config/digikam/digikam4.db"))
    ap.add_argument("--recognition-db", default=os.environ.get(
        "DIGIKAM_RECOGNITION_DB", "~/.config/digikam/recognition.db"))
    ap.add_argument("--lap-db", default=os.environ.get("LAP_DB"),
                    help="Lap's database, read-only; needed by --sources "
                         "lap-faces (env: LAP_DB)")
    ap.add_argument("--lap-box-space", default="corner-pixels",
                    choices=["corner-pixels", "corner-normalized"],
                    help="the space Lap records bboxes in — the operator's "
                         "call, recorded per run, never guessed (design §3.3)")
    # LR_CATALOG is an older env spelling; both point at the same file, so
    # accepting either keeps .env honest.
    ap.add_argument("--lightroom-catalog",
                    default=os.environ.get("LIGHTROOM_CATALOG")
                    or os.environ.get("LR_CATALOG"),
                    help="Lightroom .lrcat, read-only; needed by --sources "
                         "lightroom-catalog (env: LIGHTROOM_CATALOG)")
    ap.add_argument("--lr-root", action="append", metavar="CATALOG=LOCAL[@LOC]",
                    default=[],
                    help="map a catalog root onto disk, e.g. "
                         "D:/LIVE/=/mnt/archive/LIVE (repeatable, tried in "
                         "order: map the live tree first so stage 1 hashes the "
                         "same bytes the review DB keyed on)")
    ap.add_argument("--lr-location", default="archive",
                    choices=("live", "archive", "historical"),
                    help="image_paths.location for roots mapped without an "
                         "@LOC suffix (default: archive)")
    ap.add_argument("--sources", default=",".join(ALL_SOURCES),
                    help="comma separated subset of the harvest sources")
    ap.add_argument("--dry-run", action="store_true",
                    help="parse and count without writing")
    # gh #102 (8.8): the reporting half of the image gate.
    ap.add_argument("--only-known-images", action="store_true",
                    help="skip and count image-scoped writes whose path the "
                         "review DB does not have (gh #102, design 8.8)")
    ap.add_argument("--target", metavar="DB", default=None,
                    help="the review DB the gate classifies against "
                         "(default: the .env person_faces.db)")
    args = ap.parse_args(argv)

    t0 = time.time()
    review_paths: set[str] | None = None
    if args.only_known_images:
        target = Path(args.target or envlib.db_path()).expanduser()
        if not target.exists():
            log(f"error: --only-known-images needs the review DB: "
                f"{target} does not exist")
            return 1
        tcon = fdb.connect(str(target), readonly=True)
        try:
            review_paths = {r[0] for r in tcon.execute("SELECT path FROM image_paths")}
        finally:
            tcon.close()
        log(f"image gate: only-known-images = on (target {target}, "
            f"{len(review_paths)} known paths)")
    else:
        log("image gate: only-known-images = off")
    sources = tuple(s.strip() for s in args.sources.split(",") if s.strip())
    images_dirs = [Path(p).expanduser() for p in args.images] or \
                  [Path("~/Pictures").expanduser()]
    digikam_db = Path(args.digikam_db).expanduser()
    recognition_db = Path(args.recognition_db).expanduser()
    lap_db = Path(args.lap_db).expanduser() if args.lap_db else None
    catalog = Path(args.lightroom_catalog).expanduser() \
        if args.lightroom_catalog else None
    try:
        lr_roots = parse_lr_roots(args.lr_root, args.lr_location)
    except ValueError as e:
        log(f"error: {e}")
        return 1

    if args.dry_run and not args.db and not args.run:
        stats = harvest(None, images_dirs=images_dirs, digikam_db=digikam_db,
                        recognition_db=recognition_db, sources=sources,
                        lightroom_catalog=catalog, lr_roots=lr_roots,
                        lap_db=lap_db, lap_box_space=args.lap_box_space,
                        dry=True)
        log(f"  known persons (dry): {stats['known_persons']}")
        log(f"elapsed: {time.time() - t0:.1f}s")
        return 0

    con = _staging_connection(args)
    try:
        if args.dry_run:
            stats = harvest(con, images_dirs=images_dirs, digikam_db=digikam_db,
                            recognition_db=recognition_db, sources=sources,
                            lightroom_catalog=catalog, lr_roots=lr_roots,
                            lap_db=lap_db, lap_box_space=args.lap_box_space,
                            dry=True, review_paths=review_paths)
        else:
            stats = harvest(con, images_dirs=images_dirs, digikam_db=digikam_db,
                            recognition_db=recognition_db, sources=sources,
                            lightroom_catalog=catalog, lr_roots=lr_roots,
                            lap_db=lap_db, lap_box_space=args.lap_box_space,
                            review_paths=review_paths,
                            )
    except (ValueError, ic.SourceNotCanonical,
            ic.CornerOriginViolation) as e:
        log(f"error: {e}")
        return 1
    finally:
        con.close()

    log("")
    for k in sorted(stats):
        log(f"  {k:<24} {stats[k]}")
    log(f"elapsed: {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())