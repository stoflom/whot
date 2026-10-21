#!/usr/bin/env python3
"""harvest_legacy.py — capture face & person data from the archival sources.

Design: docs/scripts-design.md §8 (v2.0).  Replaces the legacy duo under
scripts/legacy/ with one self-contained script.  Invariants:

  H1  every source is read-only — external DBs open with SQLite ``mode=ro``
      (``&immutable=1`` for the Lightroom catalog), sidecar files are opened
      for reading only; the archive mount is strictly read-only.
  H2  data/faces.db is never touched — not read, not seeded from, not
      written.  The only write target is a NEW staging database this script
      creates itself (O_EXCL; an existing --out file is an error) — unless
      --resume reopens the staging DB an earlier run created (§8.7), which
      never overwrites a recorded hash (they only move NULL → a value).
  H3  no image content is imported — images are not decoded, thumbnailled
      or copied.  What is captured is the fs path of the image *as the
      source states it*, plus any dimensions the source states.  The ONE
      read of image bytes is hashing: when an image is *certainly*
      resolved (the sidecar's own sibling, an existing mapped catalog
      path, a digiKam reconstructed path, a unique (name,size) match) its
      BLAKE3 hash is stored in images.content_hash — the same identity
      faces.db keys on, so the importer can match by content.  An
      ambiguous resolution gets no hash, never a guessed one.  The tree
      walk that feeds digiKam's size-based resolution stats files only.
  H4  capture, not judgement — rows are stored as the source said, with
      provenance: canonical source name, the source's own reference where it
      has one, the source's own user confirmation (Lightroom userPick) as a
      flag, and the harvest run + time on every captured row.

Importing a staging DB into faces.db is a SEPARATE, later script (§8.5);
this script and faces.db never meet.

Sources (see --list-sources):
  sidecars-mwgrs / sidecars-catsets
      darktable-style <image.ext>.xmp sidecars: MWG-RS face regions and
      People|... hierarchical tags.
  lightroom-catalog      .lrcat person keyword tree + face regions.
  lightroom-sidecars     Lightroom's own <stem>.xmp (RAW-master) sidecars.
  digikam-core           digiKam tag paths -> person group info.
  digikam-faces          digiKam ImageTagProperties tagRegion rectangles.
  digikam-recognition    recognition DB identity names + UUIDs.
Since schema v1.1 only faces WITH geometry are harvested (design §9):
rectangle-less presence (MPRI display names, tag->image hits) is gone.

Usage:
  scripts/harvest_legacy.py --out /tmp/harvest.db \\
      --images '/run/media/.../PicFiles' \\
      --lightroom-catalog /run/media/.../StofLomPictures-v13-3.lrcat \\
      --lr-root 'D:/LIVE/=/run/media/.../LIVE'
  scripts/harvest_legacy.py --out /tmp/harvest.db --resume  # rerun: reuse
                                                    # the recorded hashes (§8.7)
  scripts/harvest_legacy.py --list-sources
  scripts/harvest_legacy.py --dry-run            # parse+count, nothing written

All commands accept -q/--quiet: only the startup header and the final
summary are printed (scripts-design §10); errors always go to stderr.
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
SCHEMA_PATH = PROJECT_ROOT / "database" / "harvest_schema.sql"
HARVEST_SCHEMA_VERSION = "1.1"   # exact-match, like faces.db (no migrations)

# The canonical source vocabulary (design §8).  kind groups the sources for
# the harvest_runs.roots JSON; a name outside this map is refused, never
# silently registered.
CANON_SOURCES: dict[str, str] = {
    "sidecars-mwgrs":       "sidecars",     # MWG-RS rectangles (darktable)
    "sidecars-catsets":     "sidecars",     # People|... hierarchical paths
    "digikam-core":         "digikam",      # digiKam core DB tag paths
    "digikam-recognition":  "digikam",      # recognition DB identities
    "digikam-faces":        "digikam",      # digiKam face rectangles
    "lightroom-catalog":    "lightroom",    # .lrcat face regions + keywords
    "lightroom-sidecars":   "lightroom",    # Adobe-written XMP face regions
}
ALL_SOURCES: tuple[str, ...] = tuple(CANON_SOURCES)

TAG_SEP = "|"


# module-level console: library callers (tests) get plain status output;
# main() swaps in the -q-aware instance (scripts-design §10.7)
_CONSOLE = cli_console.Console()

UNUSABLE_THRESHOLD = 0.20      # >20% unusable rows => loud warning (#83)


def unmapped_breakdown(entries: list[tuple[str, str]],
                       covered_names: set[str] | None = None,
                       root_depth: int = 2, sub_depth: int = 3) -> dict:
    """#86 (§8.6 v4.1): group unmapped catalog paths by root -> subtree
    with counts, one example path each, and an in-scope tally.

    *entries* are `(catalog_path, basename)` pairs; *covered_names* is the
    casefolded basename set of the resolution index built from the
    --images trees. In-scope = the row's file IS under the covered trees
    (by basename — classification only, never identity; the catalog has
    no file size), i.e. a path-map line could actually fix it.
    """
    roots: dict = {}
    for path, base in entries:
        parts = [s for s in path.replace(chr(92), "/").split("/") if s]
        root = "/".join(parts[:root_depth]).casefold()
        # subtree = the directory chain between root and basename
        sub = "/".join(parts[root_depth:len(parts) - 1][:sub_depth]) or "(root)"
        in_scope = bool(covered_names) and (base or "").casefold() in covered_names
        r = roots.setdefault(root, {"count": 0, "example": path,
                                    "in_scope": 0, "subtrees": {}})
        r["count"] += 1
        r["in_scope"] += int(in_scope)
        s = r["subtrees"].setdefault(sub, {"count": 0, "in_scope": 0,
                                           "example": path})
        s["count"] += 1
        s["in_scope"] += int(in_scope)
    return roots


def coverage_pct(unusable: int, total: int,
                 threshold: float = UNUSABLE_THRESHOLD) -> float | None:
    """Share of unusable rows in percent, or None while healthy (#8.6).

    Pure function so the threshold logic is testable without a harvest.
    """
    if total <= 0 or unusable * (1.0 / threshold) <= total:
        return None
    return 100.0 * unusable / total


def log(msg: str) -> None:
    _CONSOLE.status(msg)


def now() -> str:
    """UTC, same convention as import_roll.py (design #40)."""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())


def blake3_hex(path: Path) -> str:
    """BLAKE3 of a file, streamed — same identity import_roll.py stores."""
    from blake3 import blake3
    h = blake3()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Hasher:
    """Content hashing for *certainly* resolved images only (H3).

    Caches by path, so the same file reached via several sources (a
    darktable sidecar and the catalog both naming a.jpg) is read once.
    `enabled=False` (--no-hash) answers None everywhere and imports no
    blake3 dependency at all.
    """

    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self.cache: dict[str, str] = {}
        self.n = 0
        self.failed = 0
        self.seeded = 0          # reused from an earlier run (§8.7 resume)

    def seed(self, con: sqlite3.Connection) -> int:
        """Reuse the hashes an earlier run recorded in a staging DB
        (§8.7): full paths already hashed are never read again.  A no-op
        when hashing is disabled."""
        if not self.enabled:
            return 0
        n = 0
        rows = con.execute("SELECT path, content_hash FROM images"
                           " WHERE path IS NOT NULL"
                           " AND content_hash IS NOT NULL")
        for r in rows:
            if r["path"] not in self.cache:
                self.cache[r["path"]] = r["content_hash"]
                n += 1
        self.seeded += n
        return n

    def hex(self, path: str) -> str | None:
        if not self.enabled:
            return None
        if path in self.cache:
            return self.cache[path]
        try:
            digest = blake3_hex(Path(path))
        except (OSError, ImportError) as e:
            if isinstance(e, ImportError):
                raise SystemExit(
                    "the blake3 package is required to hash images "
                    "(pip install blake3), or pass --no-hash") from None
            self.failed += 1            # unreadable file on a flaky mount
            return None
        self.cache[path] = digest
        self.n += 1
        return digest


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


# ------------------------------------------------- sidecar XMP parse (H1 read)

# RAW master extensions, preferred when mapping a Lightroom-style sidecar
# (<name>.xmp) onto a same-base-name image that exists in several formats
# (the same-name JPG is normally an export of the processed RAW).
RAW_PREF_EXTS = (".pef", ".cr3", ".cr2", ".dng", ".nef", ".arw",
                 ".orf", ".rw2", ".x3f", ".rwl", ".hif", ".srf")

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".nef", ".cr2", ".cr3",
              ".dng", ".arw", ".orf", ".rw2", ".pef", ".psd", ".x3f", ".rwl",
              ".webp", ".bmp", ".heic", ".hif", ".srf", ".g3n", ".ppm"}

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


# any rdf:li item (hierarchical tags)
LI_PAT = re.compile(r'<rdf:li[^>]*>(.*?)</rdf:li>', re.S)
HIER_PAT = re.compile(
    r"<(?:lr|darktable):hierarchicalSubject>.*?</(?:lr|darktable):hierarchicalSubject>", re.S)
CATSET_PAT = re.compile(
    r"<mediapro:CatalogSets>.*?</mediapro:CatalogSets>", re.S)

# digiKam face rectangles (ImageTagProperties tagRegion).
DK_RECT_PAT = re.compile(r'<rect x="(\d+)" y="(\d+)" width="(\d+)" '
                         r'height="(\d+)"/>')


def _fnum(s: str):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def sidecar_face_data(xmp_text: str):
    """Yield (name, x, y, w, h, unit, img_w, img_h) per MWG-RS face region.

    Handles both mwg-rs serializations (attribute and element form).
    MPRI PersonDisplayName is deliberately NOT yielded (v1.1, §9): person
    presence without a rectangle can never be attached to a face.
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
            yield (name, *vals, unit,
                   int(img_w) if img_w is not None else None,
                   int(img_h) if img_h is not None else None)


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


def read_text(path: Path) -> str | None:
    """Read a sidecar for parsing; None on any OSError (H1: read-only)."""
    try:
        return open(path, errors="ignore").read()
    except OSError:
        return None


# ------------------------------------------------------------- staging (H2)

class StagingError(RuntimeError):
    """A staging-DB lifecycle violation (exists, version, schema)."""


def open_ro(db_path: Path, immutable: bool = False) -> sqlite3.Connection:
    """Read-only connection to a source DB (H1). `immutable` also forbids
    the journal dance next to the file — required for the Lightroom catalog,
    which is checkpointed and lives on the read-only archive."""
    uri = "file:" + urllib.parse.quote(str(db_path)) + "?mode=ro" \
        + ("&immutable=1" if immutable else "")
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    return con


class Staging:
    """The harvest staging DB: created fresh, the script's only write target.

    Every writer carries the run id (H4): each captured row points at
    harvest_runs, whose started_at is the harvest time.
    """

    def __init__(self, con: sqlite3.Connection, run_id: int):
        self.con = con
        self.run_id = run_id

    # -- persons -----------------------------------------------------------

    def person(self, name: str) -> int:
        self.con.execute(
            "INSERT OR IGNORE INTO persons(name, created_at, harvest_run_id)"
            " VALUES(?,?,?)", (name, now(), self.run_id))
        r = self.con.execute("SELECT id FROM persons WHERE name=?",
                             (name,)).fetchone()
        return r[0] if not isinstance(r, sqlite3.Row) else r["id"]

    def group(self, pid: int, path: str, source_id: int) -> None:
        self.con.execute(
            "INSERT OR IGNORE INTO person_groups(person_id, path, source_id,"
            " harvest_run_id) VALUES(?,?,?,?)", (pid, path, source_id,
                                                 self.run_id))

    def ref(self, pid: int, kind: str, ref: str, source_id: int) -> bool:
        before = self.con.total_changes
        self.con.execute(
            "INSERT OR IGNORE INTO person_refs(person_id, kind, ref,"
            " source_id, harvest_run_id) VALUES(?,?,?,?,?)",
            (pid, kind, ref, source_id, self.run_id))
        return self.con.total_changes > before

    # -- images ------------------------------------------------------------

    def image(self, *, source_id: int, path: str | None = None,
              path_origin: str | None = None,
              content_hash: str | None = None, name: str | None = None,
              file_size: int | None = None, source_ref: str | None = None,
              width: int | None = None, height: int | None = None) -> int:
        """Get-or-create the image row for a source-stated path (or the
        source's own image id); returns its id.  Dimensions and the content
        hash only ever move from NULL to a value (COALESCE): the first
        source that states them wins, later sources cannot contradict (H4)."""
        row = None
        if path is not None:
            row = self.con.execute(
                "SELECT id FROM images WHERE path=?", (path,)).fetchone()
        if row is None and source_ref is not None:
            row = self.con.execute(
                "SELECT id FROM images WHERE source_ref=?",
                (source_ref,)).fetchone()
        if row is not None:
            iid = row[0]
            self.con.execute(
                "UPDATE images SET width=COALESCE(width,?),"
                " height=COALESCE(height,?),"
                " content_hash=COALESCE(content_hash,?) WHERE id=?",
                (width, height, content_hash, iid))
            return iid
        cur = self.con.execute(
            "INSERT INTO images(path, path_origin, content_hash, name,"
            " file_size, source_ref, source_id, width, height,"
            " harvest_run_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (path, path_origin, content_hash, name, file_size, source_ref,
             source_id, width, height, self.run_id))
        return cur.lastrowid

    # -- presence without geometry ----------------------------------------

    # -- faces -------------------------------------------------------------

    def face(self, *, image_id: int, pid: int, x, y, w, h, unit: str,
             source_id: int, img_w: int | None = None,
             img_h: int | None = None, source_ref: str | None = None,
             picked: bool = False) -> bool:
        """Insert a face exactly as the source stated it (H4); True if a row
        was added.  False means the (image, person, box, source) tuple
        already existed — normal for digiKam's duplicate Images rows."""
        before = self.con.total_changes
        self.con.execute(
            "INSERT OR IGNORE INTO faces(image_id, person_id, x, y, w, h,"
            " unit, img_w, img_h, source_id, source_ref, picked,"
            " harvest_run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (image_id, pid, x, y, w, h, unit, img_w, img_h, source_id,
             source_ref, 1 if picked else 0, self.run_id))
        return self.con.total_changes > before


def create_staging(out: Path, faces_db: Path | None = None) -> sqlite3.Connection:
    """Create a NEW staging DB at *out* (H2: O_EXCL; never overwrites).

    Also refuses the faces.db path outright, so a typo'd --out can never
    point the harvester at the review DB.
    """
    out = out.expanduser()
    if faces_db is not None and out.resolve() == faces_db.expanduser().resolve():
        raise StagingError(
            f"refusing to write {out}: that is faces.db (invariant H2). "
            f"The harvester only ever writes a fresh staging DB.")
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(out, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
    except FileExistsError:
        raise StagingError(
            f"{out} already exists — a staging DB is created fresh per run "
            f"(H2); give a new --out path, move the old file away, or add "
            f"--resume to rerun against it (§8.7)") from None
    con = sqlite3.connect(out)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.executescript(SCHEMA_PATH.read_text())
    row = con.execute("SELECT version FROM schema_version").fetchone()
    if row is None or row[0] != HARVEST_SCHEMA_VERSION:
        con.close()
        raise StagingError(
            f"staging schema version mismatch in {SCHEMA_PATH}: "
            f"want {HARVEST_SCHEMA_VERSION}, got {row[0] if row else None}")
    return con


def open_staging_resume(out: Path, faces_db: Path | None = None) -> sqlite3.Connection:
    """Reopen the staging DB an earlier run created (--resume, §8.7).

    Refuses the faces.db path outright (H2), a missing file, and anything
    that is not a harvest staging DB at the current schema version.  The
    caller seeds the hasher from the DB's recorded hashes (Hasher.seed).
    """
    out = out.expanduser()
    if faces_db is not None and out.resolve() == faces_db.expanduser().resolve():
        raise StagingError(
            f"refusing to resume {out}: that is faces.db (invariant H2).")
    if not out.exists():
        raise StagingError(
            f"--resume: {out} does not exist — point --out at the staging "
            f"DB of the run to resume (§8.7), or drop --resume to create "
            f"a fresh one")
    con = sqlite3.connect(out)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        row = con.execute("SELECT version FROM schema_version").fetchone()
    except sqlite3.Error:
        con.close()
        raise StagingError(
            f"--resume: {out} is not a harvest staging DB "
            f"(no schema_version)") from None
    if row is None or row[0] != HARVEST_SCHEMA_VERSION:
        con.close()
        raise StagingError(
            f"--resume: schema version mismatch in {out}: "
            f"want {HARVEST_SCHEMA_VERSION}, got {row[0] if row else None}")
    return con


def start_run(con: sqlite3.Connection, sources: list[str],
              roots: dict[str, list[str]]) -> int:
    cur = con.execute(
        "INSERT INTO harvest_runs(started_at, sources, roots)"
        " VALUES(?,?,?)",
        (now(), json.dumps(sources), json.dumps(roots)))
    con.commit()
    return cur.lastrowid


def finish_run(con: sqlite3.Connection, run_id: int, stats: dict) -> None:
    con.execute("UPDATE harvest_runs SET finished_at=?, stats=? WHERE id=?",
                (now(), json.dumps(stats), run_id))
    con.commit()


def ensure_sources(con: sqlite3.Connection,
                   names: list[str]) -> dict[str, int]:
    """Register the requested canonical sources (idempotent)."""
    ids: dict[str, int] = {}
    for name in names:
        if name not in CANON_SOURCES:
            raise StagingError(
                f"{name!r} is not a canonical harvest source (design §8). "
                f"Known: {', '.join(ALL_SOURCES)}")
        con.execute("INSERT OR IGNORE INTO sources(name, kind) VALUES(?,?)",
                    (name, CANON_SOURCES[name]))
        row = con.execute("SELECT id FROM sources WHERE name=?",
                          (name,)).fetchone()
        ids[name] = row[0]
    con.commit()
    return ids


# ------------------------------------------------- image tree index (H3 stat)

def build_file_index(dirs: list[Path]) -> tuple[dict[tuple[str, int], list[str]], int]:
    """(basename.casefold(), byte size) -> [paths], plus file count.

    Stats only (H3) — digiKam's album-less images resolve on this, and a
    unique (name, size) hit is the only basename-adjacent match allowed
    (basenames collide archive-wide; design §8.3).
    """
    index: dict[tuple[str, int], list[str]] = {}
    n_files = 0
    for d in dirs:
        if not d.is_dir():
            log(f"  (images dir not found: {d})")
            continue
        for root, _dirs, files in os.walk(d):
            for fname in files:
                if Path(fname).suffix.lower() not in IMAGE_EXTS:
                    continue
                p = str(Path(root, fname))
                try:
                    size = os.stat(p).st_size
                except OSError:
                    continue
                index.setdefault((fname.casefold(), size), []).append(p)
                n_files += 1
            if n_files and n_files % 50000 < len(files):
                log(f"  … indexed {n_files} image files")
    return index, n_files


# --------------------------------------------------------------- digiKam (H1)

def _digikam_tag_paths(con2: sqlite3.Connection) -> dict[int, str]:
    """tag id -> 'Parent|Sub|Leaf' path, from the Tags (id, pid, name) tree."""
    tags = {r[0]: (r[1], r[2]) for r in
            con2.execute("SELECT id, pid, name FROM Tags")}

    def path_of(tid):
        parts, seen = [], set()
        while tid in tags and tid not in seen:
            seen.add(tid)                    # guard: add BEFORE descending,
            parts.append(tags[tid][1])       # not the parent (legacy bug:
            tid = tags[tid][0]               # adding the parent stopped the
        return TAG_SEP.join(reversed(parts)) if parts else None  # walk at depth 1

    return {tid: p for tid in tags if (p := path_of(tid))}


def _digikam_reconstructed_paths(con2: sqlite3.Connection) -> dict[int, str]:
    """digiKam image id -> full posix path *where reconstructable*.

    AlbumRoots.specificPath + Albums.relativePath + name; only works when
    Images.album is set (~14k of ~145k rows in this archive — the rest carry
    no location at all and resolve by (name, size) instead, §8.3).
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


def resolve_dk_image(dk_id: int, name: str | None, file_size: int | None,
                     recon: dict[int, str],
                     index: dict[tuple[str, int], list[str]]
                     ) -> tuple[str | None, str]:
    """digiKam image -> (path or None, path_origin).

    Order matters (§8.3).  A reconstructed path is stated by the source, so
    it wins.  Otherwise basename AND byte size must agree, uniquely — never
    basename alone.  An ambiguous match returns no path rather than guessing
    one; the caller keeps name/file_size so the importer can re-try.
    """
    p = recon.get(dk_id)
    if p:
        return p, "source"
    if name and file_size is not None:
        cands = index.get((name.casefold(), file_size))
        if cands and len(cands) == 1:
            return cands[0], "name-size"
        if cands and len(cands) > 1:
            return None, "ambiguous"
    return None, "unknown"


# ------------------------------------------------------------- Lightroom (H1)

def parse_lr_roots(specs: list[str]) -> list[tuple[str, Path]]:
    """`D:/LIVE/=/mnt/archive/LIVE` -> [('d:/live', Path('/mnt/archive/LIVE'))].

    The catalog records Windows paths and the archive is mounted somewhere
    else, so the mapping is stated rather than guessed: a root nobody mapped
    leaves its faces unmapped and counted, never silently re-rooted.  Order
    is preference order — the mapped path is the path of record (§8.4).
    """
    roots: list[tuple[str, Path]] = []
    for spec in specs:
        catalog, sep, local = spec.partition("=")
        if not sep or not catalog.strip() or not local.strip():
            raise ValueError(
                f"--lr-root wants CATALOG_ROOT=LOCAL_ROOT, got {spec!r}")
        roots.append((catalog.strip().rstrip("/").casefold(),
                      Path(local.strip()).expanduser()))
    return roots


def map_lr_path(catalog_root: str | None, path_from_root: str | None,
                filename: str, roots: list[tuple[str, Path]]) -> str | None:
    """The catalog's own path, mapped onto disk for the first root that matches."""
    cat_root = (catalog_root or "").rstrip("/")
    rel = "/".join(p for p in ((path_from_root or "").strip("/"), filename) if p)
    catalog_path = f"{cat_root}/{rel}" if cat_root else rel
    folded = catalog_path.casefold()
    for prefix, local in roots:
        if folded == prefix:
            return str(local)
        if folded.startswith(prefix + "/"):
            return str(local / catalog_path[len(prefix) + 1:])
    return None


def _lr_keyword_paths(con2: sqlite3.Connection) -> dict[int, str]:
    """id_local -> 'People|Friends|Pelsers|Winnie Pelser', for person keywords.

    The walk is over *every* keyword, not just person ones, so the path
    reaches the top of the tree (a person-only walk stops at the first
    non-person ancestor and yields a bare name — too thin to compare
    against the People|… paths the sidecars contribute).
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

    return {lid: p for (lid,) in con2.execute(
        "SELECT id_local FROM AgLibraryKeyword WHERE keywordType='person'")
        if (p := path_of(lid))}


# ----------------------------------------------------------------- loaders

def harvest_sidecars(st: Staging, images_dirs: list[Path],
                     src: dict[str, int], stats: dict,
                     enabled: set[str], hasher: "Hasher") -> set[str]:
    """XMP `<image.ext>.xmp` sidecars: MWG-RS rects + People| paths (v1.1:
    rectangles only — presence without geometry is not captured, §9).

    darktable's export style.  The image path of record is the sidecar's
    own sibling image, exactly as the sidecar names it (H3).
    """
    known: set[str] = set()
    person_paths: dict[str, set[str]] = {}
    n_files = n_faces = n_paths = 0
    n_faces_dup = n_unsupported = 0
    # the image row is shared by both sidecar sources; with a narrowed
    # --sources set it belongs to whichever of them is enabled
    img_src = src.get("sidecars-mwgrs") or src.get("sidecars-catsets")
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
                text = read_text(Path(root, fname))
                if text is None:
                    continue
                n_files += 1
                img_path = str(Path(root, img))
                # the sidecar names its sibling exactly: certainly resolved,
                # so the file (when present) is hashed (H3)
                ch = hasher.hex(img_path) if Path(img_path).is_file() else None
                iid = st.image(source_id=img_src,
                               path=img_path, path_origin="source",
                               content_hash=ch)

                if "sidecars-mwgrs" in enabled:
                    for name, x, y, w, h, unit, iw, ih in \
                            sidecar_face_data(text):
                        pid = st.person(name)
                        known.add(name)
                        if unit not in ("normalized", "pixels"):
                            n_unsupported += 1
                            continue
                        if st.face(image_id=iid, pid=pid, x=x, y=y, w=w, h=h,
                                   unit=unit, img_w=iw, img_h=ih,
                                   source_id=src["sidecars-mwgrs"]):
                            n_faces += 1
                        else:
                            n_faces_dup += 1

                if "sidecars-catsets" not in enabled:
                    continue
                for p in sidecar_people_paths(text):
                    if p == "People":
                        continue
                    leaf = p.rsplit(TAG_SEP, 1)[-1]
                    pid = st.person(leaf)
                    known.add(leaf)
                    person_paths.setdefault(leaf, set()).add(p)
                    n_paths += 1
            st.con.commit()

    for name, paths in person_paths.items():
        pid = st.person(name)
        for p in paths:
            st.group(pid, p, src["sidecars-catsets"])
    st.con.commit()
    stats.update({"scanned": n_files, "faces": n_faces,
                  "people_paths": n_paths, "faces_dup": n_faces_dup,
                  "faces_unsupported_unit": n_unsupported})
    return known


def harvest_recognition(st: Staging, db_path: Path, src_id: int,
                        stats: dict) -> set[str]:
    """digiKam recognition DB: identity names -> persons, UUIDs -> person_refs."""
    if not db_path.exists():
        log(f"  (recognition db not found: {db_path})")
        stats["identities"] = 0
        stats["recognition_refs"] = 0
        return set()
    con2 = open_ro(db_path)
    names: set[str] = set()
    n_refs = 0
    try:
        ids = {r[0] for r in con2.execute("SELECT id FROM Identities")}
        by_name: dict[int, set[str]] = {}
        by_uuid: dict[int, set[str]] = {}
        for r in con2.execute(
                "SELECT id, attribute, value FROM IdentityAttributes"):
            iid, attr, val = r[0], r[1], r[2]
            if iid not in ids or not val:
                continue
            if attr in ("fullName", "name"):
                by_name.setdefault(iid, set()).add(val)
            elif attr == "uuid":
                by_uuid.setdefault(iid, set()).add(val)
        # two passes rather than the legacy single pass, which silently
        # dropped a UUID that appeared before its identity's name in row order
        for ns in by_name.values():
            for name in ns:
                st.person(name)
                names.add(name)
        for iid, uuids in by_uuid.items():
            for name in by_name.get(iid, ()):   # only identities that have a name
                pid = st.person(name)
                for u in uuids:
                    if st.ref(pid, "digikam-recognition", u, src_id):
                        n_refs += 1
    finally:
        con2.close()
    st.con.commit()
    stats["identities"] = len(names)
    stats["recognition_refs"] = n_refs
    return names


def harvest_digikam_core(st: Staging, db_path: Path, stats: dict,
                         known: set[str], src_id: int):
    """digiKam core DB: tag paths of KNOWN persons -> person_groups (v1.1).

    Tag->image links are gone (rectangle-less capture, §9); what remains
    is group info: the digiKam tag tree's paths for leaves the sidecar,
    recognition and Lightroom loaders already established as persons.
    """
    if not db_path.exists():
        log(f"  (digikam core db not found: {db_path})")
        stats["dktags"] = 0
        return
    con2 = open_ro(db_path)
    try:
        paths = _digikam_tag_paths(con2)
        known_l = {n.lower() for n in known}
        n_tags = 0
        for p in set(paths.values()):
            leaf = p.rsplit(TAG_SEP, 1)[-1]
            if leaf.lower() in known_l:
                st.group(st.person(leaf), p, src_id)
                n_tags += 1
        st.con.commit()
    finally:
        con2.close()
    stats["dktags"] = n_tags


def harvest_digikam_faces(st: Staging, db_path: Path, src_id: int,
                          stats: dict,
                          index: dict[tuple[str, int], list[str]],
                          hasher: "Hasher",
                          path_map: list | None = None):
    """digiKam ImageTagProperties tagRegion -> faces (pixel boxes, tag = person)."""
    if not db_path.exists():
        log(f"  (digikam core db not found: {db_path})")
        stats["dk_faces"] = 0
        return
    con2 = open_ro(db_path)
    n = n_dup = 0
    resolved: dict[str, int] = {}
    try:
        recon = _digikam_reconstructed_paths(con2)
        if path_map:
            # legacy album roots rewritten through the path map (#85, §8.6);
            # an unmapped recon path stays as the source stated it (H3)
            recon = {k: (pathmap.apply_path_map(v, path_map) or v)
                     for k, v in recon.items()}
        meta = {r[0]: (r[1], r[2]) for r in
                con2.execute("SELECT id, name, fileSize FROM Images")}
        unresolved: list[str] = []       # samples for the coverage warning (#85)
        for r in con2.execute(
                "SELECT itp.imageid, t.name, itp.value "
                "FROM ImageTagProperties itp "
                "JOIN Tags t ON t.id = itp.tagid "
                "WHERE itp.property = 'tagRegion'"):
            img_id, tname, val = r[0], r[1], r[2]
            m = DK_RECT_PAT.search(val or "")
            if not m:
                stats["dk_faces_unparsed"] = \
                    stats.get("dk_faces_unparsed", 0) + 1
                continue
            x, y, w, h = map(int, m.groups())
            if w <= 0 or h <= 0:
                continue
            name, fsize = meta.get(img_id, (None, None))
            path, origin = resolve_dk_image(img_id, name, fsize, recon, index)
            resolved[origin] = resolved.get(origin, 0) + 1
            if origin == "unknown" and len(unresolved) < 10:
                unresolved.append(f"{name!r} ({fsize} bytes,"
                                  f" digikam-image:{img_id})")
            ch = hasher.hex(path) if path and Path(path).is_file() else None
            iid = st.image(source_id=src_id, path=path,
                           path_origin=origin if path else None,
                           content_hash=ch, name=name, file_size=fsize,
                           source_ref=f"digikam-image:{img_id}")
            pid = st.person(tname)
            if st.face(image_id=iid, pid=pid, x=x, y=y, w=w, h=h,
                       unit="pixels", source_id=src_id):
                n += 1
            else:
                n_dup += 1
        st.con.commit()
    finally:
        con2.close()
    stats["dk_faces"] = n
    stats["dk_faces_dup"] = n_dup
    for how in ("source", "name-size", "ambiguous", "unknown"):
        if how in resolved:
            stats[f"dk_faces_resolved_{how}"] = resolved[how]
    if unresolved:
        stats["dk_unresolved_samples"] = unresolved   # coverage warning (#85)


def harvest_lightroom_catalog(st: Staging, catalog: Path,
                              roots: list[tuple[str, Path]],
                              src_id: int, stats: dict,
                              hasher: "Hasher",
                              excludes: list[str] | None = None,
                              covered_names: set[str] | None = None) -> set[str]:
    """Person keyword tree + face regions from a Lightroom `.lrcat` (read-only).

    `userPick` is kept only as the `picked` flag (H4): the sole evidence the
    catalog holds that a person said yes.  The catalog normalises face boxes
    against fileWidth/fileHeight, so its corners are file-space pixels
    already; `round()` is banker's rounding and the legacy keys were built
    on it — contract, not preference (§8.2).
    """
    if not catalog.exists():
        log(f"  (lightroom catalog not found: {catalog})")
        stats["lr_faces"] = 0
        return set()
    con2 = open_ro(catalog, immutable=True)
    known: set[str] = set()
    n_persons = n_paths = n_refs = n_groups = 0
    n_faces = n_dup = 0
    n_unmapped = n_missing = n_nodims = n_degenerate = n_on_group = 0
    n_excluded = 0
    unmapped_entries: list[tuple[str, str]] = []      # (catalog path, basename) (#86)
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
            pid = st.person(name)
            known.add(name)
            # a bare name in person_groups would collide with every
            # People|… path another source contributes for the same person
            p = paths.get(lid)
            if p and p.startswith("People" + TAG_SEP):
                st.group(pid, p, src_id)
                n_paths += 1
            if st.ref(pid, "lightroom-catalog", f"keyword:{gid}", src_id):
                n_refs += 1
        st.con.commit()

        # face regions
        for r in con2.execute(
                "SELECT i.fileWidth, i.fileHeight, fa.tl_x, fa.tl_y, fa.tr_x, "
                "fa.bl_y, k.name, COALESCE(kf.userPick, 0), fa.id_local, "
                "kf.tag, rf.absolutePath, fo.pathFromRoot, fl.idx_filename "
                "FROM AgLibraryFace fa "
                "JOIN Adobe_images i ON i.id_local = fa.image "
                "JOIN AgLibraryFile fl ON fl.id_local = i.rootFile "
                "JOIN AgLibraryFolder fo ON fo.id_local = fl.folder "
                "JOIN AgLibraryRootFolder rf ON rf.id_local = fo.rootFolder "
                "JOIN AgLibraryKeywordFace kf ON kf.face = fa.id_local "
                "JOIN AgLibraryKeyword k ON k.id_local = kf.tag "
                "AND k.keywordType = 'person'"):
            (W, H, tlx, tly, trx, bly, name, pick, fid, kwd,
             ap, pfr, fn) = (r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7],
                             r[8], r[9], r[10], r[11], r[12])
            if kwd in group_nodes:
                # a face attached to a *group* keyword is not person data
                n_on_group += 1
                continue
            if None in (W, H, tlx, tly, trx, bly):
                n_nodims += 1
                continue
            cat_path = "/".join(p for p in ((ap or "").rstrip("/"),
                                            (pfr or "").strip("/"),
                                            fn or "") if p)
            if pathmap.is_excluded(cat_path, excludes or []):
                # deliberately ignored (#86): counted, never warned
                n_excluded += 1
                continue
            local = map_lr_path(ap, pfr, fn or "", roots)
            if local is None:
                n_unmapped += 1
                unmapped_entries.append((cat_path, fn or ""))
                continue
            if not Path(local).exists():
                n_missing += 1
                continue
            x = round(tlx * W)
            y = round(tly * H)
            w = round((trx - tlx) * W)
            h = round((bly - tly) * H)
            if w <= 0 or h <= 0:
                n_degenerate += 1
                continue
            iid = st.image(source_id=src_id, path=local, path_origin="source",
                           content_hash=hasher.hex(local),
                           width=int(W), height=int(H),
                           source_ref=f"lightroom-image:{fid}")
            pid = st.person(name)
            known.add(name)
            if st.face(image_id=iid, pid=pid, x=x, y=y, w=w, h=h,
                       unit="pixels", source_id=src_id,
                       source_ref=f"face:{fid}", picked=bool(pick)):
                n_faces += 1
            else:
                n_dup += 1
        st.con.commit()
    finally:
        con2.close()
    if unmapped_entries:
        # source-tagged, subtree-broken-down, in-scope split (#86, §8.6 v4.1)
        stats["lr_unmapped_roots"] = unmapped_breakdown(
            unmapped_entries, covered_names)
        stats["lr_unmapped_in_scope"] = sum(
            r["in_scope"] for r in stats["lr_unmapped_roots"].values())
    if n_excluded:
        stats["lr_excluded"] = n_excluded
    stats.update({"lr_persons": n_persons, "lr_group_nodes": n_groups,
                  "lr_people_paths": n_paths, "lr_person_refs": n_refs,
                  "lr_faces": n_faces, "lr_faces_dup": n_dup,
                  "lr_root_unmapped": n_unmapped, "lr_file_missing": n_missing,
                  "lr_no_dims": n_nodims, "lr_degenerate": n_degenerate,
                  "lr_faces_on_group_node": n_on_group})
    return known


def harvest_lightroom_sidecars(st: Staging, images_dirs: list[Path],
                               src_id: int, stats: dict,
                               hasher: "Hasher") -> set[str]:
    """Lightroom's own `<stem>.xmp`, the RAW-master sidecar style.

    Two things separate this from `harvest_sidecars`: the stem carries no
    image extension, so the sidecar is matched to an image by base name in
    the same directory (RAW preferred — a same-named JPG is normally an
    export of the RAW); and its People|… paths belong to lightroom-sidecars.
    """
    known: set[str] = set()
    person_paths: dict[str, set[str]] = {}
    n_files = n_faces = n_dup = n_paths = n_nocand = 0
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
                # RAW-preference among SEVERAL candidates is a heuristic, not
                # certainty: only a single candidate gets its bytes hashed (H3)
                ch = hasher.hex(cand_path) if len(cands) == 1 else None
                text = read_text(Path(root, base + ".xmp"))
                if text is None:
                    continue
                n_files += 1
                iid = st.image(source_id=src_id, path=cand_path,
                               path_origin="source", content_hash=ch)
                for name, x, y, w, h, unit, iw, ih in \
                        sidecar_face_data(text):
                    pid = st.person(name)
                    known.add(name)
                    if unit not in ("normalized", "pixels"):
                        continue
                    if st.face(image_id=iid, pid=pid, x=x, y=y, w=w, h=h,
                               unit=unit, img_w=iw, img_h=ih,
                               source_id=src_id):
                        n_faces += 1
                    else:
                        n_dup += 1
                for p in sidecar_people_paths(text):
                    if p == "People":
                        continue
                    leaf = p.rsplit(TAG_SEP, 1)[-1]
                    pid = st.person(leaf)
                    known.add(leaf)
                    person_paths.setdefault(leaf, set()).add(p)
                    n_paths += 1
            st.con.commit()
    for name, paths in person_paths.items():
        pid = st.person(name)
        for p in paths:
            st.group(pid, p, src_id)
    st.con.commit()
    stats.update({"lrs_scanned": n_files, "lrs_faces": n_faces,
                  "lrs_faces_dup": n_dup, "lrs_paths": n_paths,
                  "lrs_no_candidate": n_nocand})
    return known


# ------------------------------------------------------------- orchestration

def harvest(st: Staging | None, *, images_dirs: list[Path],
            digikam_db: Path, recognition_db: Path,
            sources: tuple[str, ...] = ALL_SOURCES,
            lightroom_catalog: Path | None = None,
            lr_roots: list[tuple[str, Path]] | None = None,
            hasher: "Hasher | None" = None,
            path_map: list | None = None,
            path_excludes: list[str] | None = None) -> dict:
    """Run the requested loaders; returns the stats dict.

    Load order is the legacy order minus the dropped Lap source, and it
    matters: digikam-core gates its tag linking on the names the sidecar,
    recognition and Lightroom loaders established first.
    """
    unknown = [s for s in sources if s not in ALL_SOURCES]
    if unknown:
        raise StagingError(
            f"not a harvest source: {unknown}. This script reads "
            f"{', '.join(ALL_SOURCES)}")
    if "lightroom-catalog" in sources and lightroom_catalog is None:
        raise ValueError(
            "lightroom-catalog was requested but no catalog was given: pass "
            "--lightroom-catalog <file.lrcat> (or set LR_CATALOG). "
            "A missing catalog is never treated as an empty one")
    enabled = set(sources)
    roots = list(lr_roots or [])

    if st is None:
        # dry-run: parse + count only, nothing written anywhere (H1/H2/H3)
        return _dry_scan(images_dirs, digikam_db, recognition_db,
                         lightroom_catalog)

    if hasher is None:
        hasher = Hasher()

    stats: dict = {}
    known: set[str] = set()
    src = ensure_sources(st.con, sources)

    # path map (#85, §8.6): extra LR roots + seeded index + recon rewrites —
    # a lookup aid only, never a guess (H3/J2)
    pm = list(path_map or [])
    # the map extends the LR roots (§8.6 — same shape, consulted in order);
    # `roots` was set to lr_roots at the top of this function
    roots += [(old_n, Path(new)) for old_n, _od, new in pm]

    index: dict[tuple[str, int], list[str]] = {}
    needs_index = "digikam-faces" in enabled
    if needs_index:
        idx_dirs = list(images_dirs)
        for d in pathmap.local_roots(pm):
            if d not in idx_dirs:
                idx_dirs.append(d)
        log(f"  indexing image files under {', '.join(str(d) for d in idx_dirs)}")
        index, n_idx = build_file_index(idx_dirs)
        stats["indexed_files"] = n_idx
    # #86 (§8.6 v4.1): in-scope classification for the coverage warning
    # uses the index's basename set; no index => no split (old behaviour)
    covered_names = {name for name, _size in index} if index else None

    if enabled & {"sidecars-mwgrs", "sidecars-mpri", "sidecars-catsets"}:
        log(f"  scanning sidecars under {', '.join(str(d) for d in images_dirs)}")
        known |= harvest_sidecars(st, images_dirs, src, stats, enabled, hasher)

    if "digikam-recognition" in sources:
        known |= harvest_recognition(st, recognition_db,
                                     src["digikam-recognition"], stats)

    if "digikam-core" in sources:
        harvest_digikam_core(st, digikam_db, stats, known,
                             src["digikam-core"])

    if "digikam-faces" in sources:
        harvest_digikam_faces(st, digikam_db, src["digikam-faces"], stats,
                              index, hasher, path_map=pm)

    if "lightroom-catalog" in sources:
        log(f"  lightroom catalog: {lightroom_catalog}")
        known |= harvest_lightroom_catalog(
            st, lightroom_catalog, roots,
            src["lightroom-catalog"], stats, hasher,
            excludes=path_excludes, covered_names=covered_names)

    if "lightroom-sidecars" in sources:
        log(f"  scanning Lightroom sidecars under "
            f"{', '.join(str(d) for d in images_dirs)}")
        known |= harvest_lightroom_sidecars(
            st, images_dirs, src["lightroom-sidecars"], stats, hasher)

    stats["known_persons"] = len(known)
    stats["hashed"] = hasher.n
    stats["hash_failed"] = hasher.failed
    if hasher.seeded:
        stats["hash_reused"] = hasher.seeded     # §8.7 resume
    return stats


def _dry_scan(images_dirs: list[Path], digikam_db: Path,
              recognition_db: Path, lightroom_catalog: Path | None) -> dict:
    """Parse-only preview of the person names each source would yield.

    Nothing is written, nothing but the sidecars/DBs themselves is read
    (no image-tree index: the walk would stat the whole archive for a
    preview that needs no resolution).
    """
    names: set[str] = set()
    stats: dict = {}
    for images_dir in images_dirs:
        if not images_dir.is_dir():
            continue
        for root, _dirs, files in os.walk(images_dir):
            for fname in files:
                if not fname.lower().endswith(".xmp"):
                    continue
                # every .xmp is parsed here, unlike the harvesting loaders:
                # the preview must also show Lightroom-style sidecars (bare
                # stem), not just darktable's <image.ext>.xmp
                text = read_text(Path(root, fname))
                if text is None:
                    continue
                for name, *_ in sidecar_face_data(text):
                    names.add(name)
                for p in sidecar_people_paths(text):
                    if p != "People":
                        names.add(p.rsplit(TAG_SEP, 1)[-1])
    if recognition_db.exists():
        con2 = open_ro(recognition_db)
        try:
            ids = {r[0] for r in con2.execute("SELECT id FROM Identities")}
            for iid, attr, val in con2.execute(
                    "SELECT id, attribute, value FROM IdentityAttributes"):
                if iid in ids and attr in ("fullName", "name") and val:
                    names.add(val)
        finally:
            con2.close()
    if lightroom_catalog and lightroom_catalog.exists():
        con2 = open_ro(lightroom_catalog, immutable=True)
        try:
            kw = {r[0]: (r[1], r[2]) for r in con2.execute(
                "SELECT id_local, name, parent FROM AgLibraryKeyword "
                "WHERE keywordType='person'")}
            group_nodes = {p for (_n, p) in kw.values() if p is not None}
            for lid, (name, _p) in kw.items():
                if lid not in group_nodes:
                    names.add(name)
        finally:
            con2.close()
    if digikam_db.exists():
        con2 = open_ro(digikam_db)
        try:
            paths = _digikam_tag_paths(con2)
            stats["digikam_tag_leaves"] = len({p.rsplit(TAG_SEP, 1)[-1]
                                               for p in paths.values()})
        finally:
            con2.close()
    stats["known_persons"] = len(names)
    return stats


# ---------------------------------------------------------------------- CLI

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", metavar="PATH",
                    help="staging DB to CREATE (must not exist); with "
                         "--resume: must EXIST — the staging DB of the run "
                         "to resume (§8.7); default "
                         "~/.cache/whot/harvest/harvest-<stamp>.db")
    ap.add_argument("--images", action="append", metavar="DIR", default=[],
                    help="image tree to scan for sidecars and to stat-index "
                         "(repeatable; default: DEFAULT_IMAGES_DIR, "
                         "ARCHIVE_DIR, LR_SIDECARS_DIR from .env)")
    ap.add_argument("--digikam-db", metavar="PATH", default=None)
    ap.add_argument("--recognition-db", metavar="PATH", default=None)
    ap.add_argument("--lightroom-catalog", metavar="PATH", default=None)
    ap.add_argument("--lr-root", action="append", metavar="CATALOG=LOCAL",
                    default=[],
                    help="map a catalog root onto disk, e.g. "
                         "D:/LIVE/=/mnt/archive/LIVE (repeatable, tried in "
                         "order; the mapped path is the path of record)")
    ap.add_argument("--sources", default=",".join(ALL_SOURCES),
                    help="comma separated subset of the harvest sources")
    ap.add_argument("--no-hash", action="store_true",
                    help="skip BLAKE3 hashing of certainly-resolved images "
                         "(faster first pass; the importer then matches on "
                         "path / name+size only)")
    ap.add_argument("--resume", action="store_true",
                    help="reuse the staging DB named by --out (which must "
                         "exist and be a harvest staging DB): full paths "
                         "already hashed in it are skipped, never read "
                         "again (§8.7) — for reruns after fixing a "
                         "--path-map/--lr-root")
    ap.add_argument("--list-sources", action="store_true",
                    help="print the canonical source vocabulary and exit")
    ap.add_argument("--dry-run", action="store_true",
                    help="parse and count person names; write nothing")
    ap.add_argument("--path-map", action="append", metavar="FILE", default=[],
                    help="path-map file: 'OLD_PREFIX = NEW_PREFIX' lines "
                         "rewriting legacy roots onto the local archive "
                         "(§8.6, #85; also PATH_MAP in .env)")
    cli_console.add_quiet_arg(ap)
    args = ap.parse_args(argv)

    global _CONSOLE
    _CONSOLE = ui = cli_console.Console(quiet=args.quiet)

    if args.list_sources:
        # requested data, not status: printed even under -q (§10.5)
        ui.header("WhoT harvest_legacy — list sources")
        for name, kind in sorted(CANON_SOURCES.items()):
            print(f"  {name:<22} kind={kind}")
        print(f"\n{len(CANON_SOURCES)} canonical harvest sources (design §8)")
        return 0

    if args.resume and not args.out:
        ui.error("error: --resume needs --out pointing at the staging DB"
                 " of the run to resume (§8.7)")
        return 1
    if args.resume and args.dry_run:
        ui.error("error: --resume cannot be combined with --dry-run"
                 " (nothing is written, so there is nothing to resume)")
        return 1

    env = load_env(PROJECT_ROOT / ".env")

    def env_path(key: str) -> Path | None:
        v = env.get(key)
        return Path(v).expanduser() if v else None

    images_dirs = [Path(p).expanduser() for p in args.images]
    if not images_dirs:
        seen: set[str] = set()
        for key in ("DEFAULT_IMAGES_DIR", "ARCHIVE_DIR", "LR_SIDECARS_DIR"):
            p = env_path(key)
            if p and str(p) not in seen:
                seen.add(str(p))
                images_dirs.append(p)
    digikam_db = Path(args.digikam_db).expanduser() if args.digikam_db \
        else (env_path("DIGIKAM_DB") or Path("~/.config/digikam/digikam4.db").expanduser())
    recognition_db = Path(args.recognition_db).expanduser() if args.recognition_db \
        else (env_path("DIGIKAM_RECOGNITION_DB")
              or Path("~/.config/digikam/recognition.db").expanduser())
    catalog = Path(args.lightroom_catalog).expanduser() if args.lightroom_catalog \
        else (env_path("LR_CATALOG") or env_path("LIGHTROOM_CATALOG"))

    sources = tuple(s.strip() for s in args.sources.split(",") if s.strip())
    mode = "DRY RUN — nothing written" if args.dry_run else "harvest"
    ui.header(f"WhoT harvest_legacy — {mode}",
              f"sources   : {', '.join(sources)}",
              f"images    : {', '.join(str(d) for d in images_dirs) or '(none)'}",
              f"digikam   : {digikam_db}",
              f"recognition: {recognition_db}",
              f"catalog   : {catalog or '(none)'}")

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

    try:
        lr_roots = parse_lr_roots(args.lr_root)
    except ValueError as e:
        ui.error(f"error: {e}")
        return 1

    try:
        check = [s for s in sources if s not in ALL_SOURCES]
        if check:
            raise StagingError(
                f"not a harvest source: {check}. Known: {', '.join(ALL_SOURCES)}")
        ui.start_beat("scanning sources")
        if args.dry_run:
            stats = harvest(None, images_dirs=images_dirs,
                            digikam_db=digikam_db, recognition_db=recognition_db,
                            sources=sources, lightroom_catalog=catalog,
                            lr_roots=lr_roots, path_map=path_map,
                            path_excludes=path_excludes)
            ui.status("[dry-run] nothing written")
        else:
            t0 = time.time()
            out = Path(args.out).expanduser() if args.out else \
                Path(os.environ.get("XDG_CACHE_HOME")
                     or (Path.home() / ".cache")).expanduser() \
                / "whot" / "harvest" / \
                f"harvest-{time.strftime('%Y%m%d-%H%M%S')}.db"
            faces_db = env_path("FACES_DB")
            if faces_db and not faces_db.is_absolute():
                faces_db = PROJECT_ROOT / faces_db
            if args.resume:
                con = open_staging_resume(out, faces_db=faces_db)
            else:
                con = create_staging(out, faces_db=faces_db)
            try:
                st = Staging(con, start_run(con, list(sources), {
                    "images": [str(d) for d in images_dirs],
                    "digikam-db": str(digikam_db),
                    "recognition-db": str(recognition_db),
                    "lightroom-catalog": str(catalog) if catalog else None,
                    "lr-root": args.lr_root,
                }))
                ui.status(f"staging: {out}  (run {st.run_id})")
                hasher = Hasher(enabled=not args.no_hash)
                if args.resume:
                    n = hasher.seed(con)
                    ui.status(f"resume: {n} recorded hash(es) reused —"
                              f" those paths will not be read again")
                stats = harvest(st, images_dirs=images_dirs,
                                digikam_db=digikam_db,
                                recognition_db=recognition_db,
                                sources=sources, lightroom_catalog=catalog,
                                lr_roots=lr_roots,
                                hasher=hasher,
                                path_map=path_map,
                                        path_excludes=path_excludes)
                finish_run(con, st.run_id, stats)
            except (ValueError, StagingError) as e:
                con.close()
                ui.stop_beat()
                ui.error(f"error: {e}")
                return 1
            finally:
                con.close()
            ui.stop_beat()
            ui.status(f"elapsed: {time.time() - t0:.1f}s")
    except (ValueError, StagingError) as e:
        ui.stop_beat()
        ui.error(f"error: {e}")
        return 1

    ui.stop_beat()

    # coverage warning (#83/#86, §8.6 v4.1): source-tagged, subtree-
    # broken-down, and the 20% threshold counts only IN-SCOPE unusable
    # rows — a scoped run must not read as a catastrophe. stderr, never
    # -q-suppressed.
    index_available = bool(stats.get("indexed_files"))
    lr_unmapped = stats.get("lr_root_unmapped", 0)
    lr_in_scope = stats.get("lr_unmapped_in_scope", lr_unmapped) \
        if index_available else lr_unmapped
    lr_out = lr_unmapped - lr_in_scope if index_available else 0
    dk_unknown = stats.get("dk_faces_resolved_unknown", 0)
    unusable = lr_in_scope + dk_unknown
    total_rows = unusable + lr_out + stats.get("lr_faces", 0) + \
        stats.get("dk_faces", 0) + stats.get("dk_faces_dup", 0)
    pct = coverage_pct(unusable, total_rows)
    if pct is not None:
        scope_note = ("" if index_available else
                      " (no resolution index: in-scope split unavailable,"
                      " all rows counted)")
        ui.error(f"WARNING: {pct:.0f}% of archive rows unusable IN SCOPE"
                 f" ({unusable} of {total_rows}){scope_note}: images could"
                 f" not be resolved to a path, so their faces can never"
                 f" match the import (J2). Map the missing roots in your"
                 f" --path-map file (§8.6) or extend --images/--lr-root.")
        for root, info in list(stats.get("lr_unmapped_roots", {}).items())[:5]:
            ui.error(f"  lightroom-catalog: unmapped root {root!r} —"
                     f" {info['count']} row(s), {info.get('in_scope', 0)}"
                     f" in scope:")
            for sub, s in list(info.get("subtrees", {}).items())[:5]:
                ui.error(f"      {sub:<44} {s['count']:>6} row(s)"
                         f" ({s['in_scope']} in scope)"
                         f"   e.g. {s['example']}")
        for sample in stats.get("dk_unresolved_samples", [])[:5]:
            ui.error(f"  digikam-faces: unresolved image {sample}"
                     f" (no album; only resolvable by (name,size) under"
                     f" --images)")
    if lr_out:
        ui.error(f"note: {lr_out} unmapped lightroom-catalog row(s) are"
                 f" OUT OF SCOPE (not under the indexed --images trees) —"
                 f" informational, not counted toward the threshold"
                 f" (#86)")
    if stats.get("lr_excluded"):
        ui.error(f"note: {stats['lr_excluded']} lightroom-catalog row(s)"
                 f" skipped by '!' path-map excludes (#86)")

    ui.summary("", *(f"  {k:<26} {stats[k]}" for k in sorted(stats)
                     if not isinstance(stats[k], (dict, list))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
