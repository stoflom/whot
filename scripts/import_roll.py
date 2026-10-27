#!/usr/bin/env python
"""import_roll.py — import a film-roll directory into data/faces.db.

Pipeline (see docs/gui-design.md §4 and README.md):
  scan -> BLAKE3 hash -> skip existing / detect+embed -> associate -> store

Usage: import_roll.py [--dry-run] [--all] [--recursive] [--gpu]
                      [--threshold F] [-q] [--create-db] [ROLL_DIR]
Console (scripts-design §10): startup header, status updates (full paths),
final summary; -q/--quiet prints only the header and the final summary.
--create-db builds the database from database/schema.sql (§4.29, #90).
CPU provider by default; --gpu opts in to MIGraphX (§4.29, #91) — its
compute hangs have wedged this machine's amdgpu and killed the session.
Run with the insight_env venv python (insightface, cv2, rawpy, blake3).
"""
from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

import cli_console  # shared header/status/quiet console (scripts-design §10)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODEL_TAG = "insightface:buffalo_l"
# must match database/schema.sql's schema_version row and db.rs SCHEMA_VERSION
SCHEMA_VERSION = "1.7"


# ---------------------------------------------------------------- insightface venv

def _locate_venv_site_packages(insightface_path: Path) -> Path | None:
    """Find insight_env's site-packages, trying several Python-version layouts."""
    insight_env = insightface_path / "insight_env"
    if not insight_env.is_dir():
        return None
    # Try versioned site-packages first (python3.Y/, python3.Y.Z/)
    for lib_dir in sorted(insight_env.glob("lib/python*")):
        sp = lib_dir / "site-packages"
        if sp.is_dir():
            return sp
    # Fallback: bare "lib/site-packages" (rare)
    sp = insight_env / "lib" / "site-packages"
    return sp if sp.is_dir() else None


def inject_insightface_venv(env: dict[str, str]) -> None:
    """Add the insightface venv's site-packages to sys.path (in-place).

    Reads INSIGHTFACE_PATH from *env* (already loaded from .env), resolves
    it relative to PROJECT_ROOT, finds the insight_env venv, and prepends
    its site-packages to sys.path so that *import insightface* works
    without the venv being activated.

    Raises SystemExit with a clear message when the path or venv is missing.
    """
    raw = env.get("INSIGHTFACE_PATH")
    if not raw:
        return  # optional — no env var, rely on activation

    p = Path(raw)
    if not p.is_absolute():
        p = (PROJECT_ROOT / p).resolve()
    else:
        p = p.resolve()

    sp = _locate_venv_site_packages(p)
    if sp is None:
        sys.exit(
            f"insightface venv not found at {p}/insight_env (INSIGHTFACE_PATH={raw})\n"
            f"Check that the venv exists and has a lib/python*/site-packages directory."
        )

    site_pkgs = str(sp)
    if site_pkgs not in sys.path:
        sys.path.insert(0, site_pkgs)
THRESHOLD_DEFAULT = 0.40          # cosine similarity, same parameter as GUI ranking (req 4.3)
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff",
                  ".pef", ".dng", ".cr2", ".cr3", ".nef", ".arw", ".rw2", ".orf"}
RAW_SUFFIXES = {".pef", ".dng", ".cr2", ".cr3", ".nef", ".arw", ".rw2", ".orf"}
TIFF_SUFFIXES = {".tif", ".tiff"}
ICON_LONG_EDGE = 256              # thumbnails (req 3.3)
PREVIEW_LONG_EDGE = 1600
FACE_CROP_LONG_EDGE = 512


# ---------------------------------------------------------------- env (.env)

def load_env(path: Path) -> dict[str, str]:
    """Parse KEY=VALUE lines with ${VAR} references; no external dependency."""
    raw: dict[str, str] = {}
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
    # refs not defined in the file (e.g. ${HOME}) fall back to the process
    # environment; unresolvable refs stay literal (#15)
    for k, v in raw.items():
        if "${" in v:
            raw[k] = re.sub(r"\$\{(\w+)\}",
                            lambda m: os.environ.get(m.group(1), m.group(0)), v)
    return raw


def check_schema(con: sqlite3.Connection, db_path: Path) -> None:
    """Compatibility gate: refuse a DB whose schema_version doesn't match
    this script (exact match — no migrations by policy)."""
    try:
        row = con.execute("SELECT version FROM schema_version").fetchone()
    except sqlite3.Error:
        sys.exit(
            f"{db_path} has no schema_version marker — not a WhoT v{SCHEMA_VERSION} database.\n"
            f"Move that file away, then create a fresh database:\n"
            f"  scripts/import_roll.py --create-db\n"
            f"(or: sqlite3 {db_path} < database/schema.sql)"
        )
    if row is None:                       # was rendered as 'vempty …' (#90)
        sys.exit(
            f"{db_path} has an empty schema_version table — not a WhoT v{SCHEMA_VERSION} database.\n"
            f"Move that file away, then create a fresh database:\n"
            f"  scripts/import_roll.py --create-db"
        )
    if row[0] != SCHEMA_VERSION:
        remedy = (
            "Upgrade it in place (backup first): scripts/fix_status_groups.py"
            if row[0] == "1.6"
            else "Preserve annotations first if wanted: scripts/annotation_snapshot.py export,\n"
                 f"  then recreate: scripts/import_roll.py --create-db "
                 f"(or: sqlite3 {db_path} < database/schema.sql)")
        sys.exit(
            f"{db_path} schema v{row[0]} does not match this script (v{SCHEMA_VERSION}).\n"
            f"{remedy}"
        )


def missing_db_message(db_path: Path) -> str | None:
    """#90: a missing FACES_DB must say so — sqlite3.connect() would silently
    create an empty file and the schema gate would then reject it with a
    bogus 'wrong schema version' style error."""
    if db_path.is_file():
        return None
    return (f"database not found: {db_path}\n"
            f"  FACES_DB in .env points at a missing file — create it with:\n"
            f"  scripts/import_roll.py --create-db")


def create_database(db_path: Path, ui: cli_console.Console) -> bool:
    """--create-db (#90): build *db_path* from database/schema.sql, creating
    missing parent directories. An existing **non-empty** database is kept
    (warning on stderr, returns False ⇒ exit 1); a stray 0-byte file — what
    sqlite3.connect() leaves behind when pointed at a missing path — counts
    as absent and is replaced. A failed build removes its own debris."""
    if db_path.exists() and db_path.stat().st_size > 0:
        ui.error(f"database already exists: {db_path} — refusing to overwrite it")
        ui.summary("--create-db: nothing to do (existing database kept)")
        return False
    db_path.parent.mkdir(parents=True, exist_ok=True)
    schema_sql = (PROJECT_ROOT / "database" / "schema.sql").read_text()
    con = sqlite3.connect(db_path)
    try:
        con.executescript(schema_sql)
        con.commit()
        row = con.execute("SELECT version FROM schema_version").fetchone()
    except Exception:
        con.close()
        db_path.unlink(missing_ok=True)      # never leave a half-built DB
        raise
    con.close()
    ui.summary(f"created database {db_path} — WhoT schema v{row[0] if row else '?'}")
    return True


# ---------------------------------------------------------------- data model

@dataclass
class Detection:
    box: tuple[int, int, int, int]         # x, y, w, h (8-bit quantised, req 3.4)
    det_score: float
    embedding: np.ndarray                  # L2-normalised float32[512]
    crop_jpeg: bytes | None = None

@dataclass
class ImportPlan:
    """Everything decided for one new image, before writing."""
    content_hash: str
    path: str
    state: str
    width: int                             # source (decode) pixels — canonical
    height: int                            #   coordinate space (#18)
    orientation: str | None
    type: str
    icon_jpeg: bytes
    preview_jpeg: bytes
    detections: list[Detection] = field(default_factory=list)


# ---------------------------------------------------------------- image io

def _decode(path: Path):
    """Decode to a BGR uint8 ndarray — always the **displayed** image,
    EXIF orientation applied (§4.29, #89):

      RAW   → rawpy JPEG thumbnail, else postprocess(half_size); *any*
              ``rawpy.LibRawError`` from the thumbnail step (missing AND
              unsupported/bitmap thumbs — merged Pano/HDR DNGs raise
              ``LibRawUnsupportedThumbnailError``) falls through to the
              full decode instead of failing the file;
      other → cv2 → Pillow (OpenCV's TIFF blind spots: crashes on TIFFs
              carrying an EXIF Orientation tag, refuses 32-bit samples)
              → tifffile (TIFFs Pillow cannot identify, e.g. float32).

    Raises ValueError only when *no* decoder can read the file (#89).
    """
    import cv2
    if path.suffix.lower() in RAW_SUFFIXES:
        import rawpy
        with rawpy.imread(str(path)) as raw:
            try:
                thumb = raw.extract_thumb()
                if thumb.format == rawpy.ThumbFormat.JPEG:
                    img = cv2.imdecode(np.frombuffer(thumb.data, np.uint8),
                                       cv2.IMREAD_COLOR)
                    if img is not None:
                        return img
            except rawpy.LibRawError:
                pass            # missing/unsupported thumb → full decode (#89)
            rgb = raw.postprocess(half_size=True, use_camera_wb=True)
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is not None:
        return img
    for fallback in (_decode_pillow, _decode_tifffile):
        img = fallback(path)
        if img is not None:
            return img
    raise ValueError(f"cannot decode {path}")


def _decode_pillow(path: Path):
    """Pillow fallback (#89): reads what OpenCV refuses — TIFFs with an EXIF
    Orientation tag (cv2 dies with 'original_ptr == real_mat.data'), 32-bit
    and other exotic TIFFs. exif_transpose keeps the decode space identical
    to cv2's default (orientation applied)."""
    try:
        from PIL import Image, ImageOps
        with Image.open(path) as im:
            transposed = ImageOps.exif_transpose(im)
            if transposed is not None:      # older Pillow: None without EXIF
                im = transposed
            if im.mode != "RGB":
                im = im.convert("RGB")
            return np.ascontiguousarray(np.asarray(im)[:, :, ::-1])   # RGB → BGR
    except Exception:
        return None


def _decode_tifffile(path: Path):
    """tifffile last resort (#89): TIFFs neither cv2 nor Pillow can read —
    32-bit float exports of raw development above all. Samples are
    normalised to uint8 and the TIFF Orientation tag applied, so the decode
    space matches every other branch."""
    if path.suffix.lower() not in TIFF_SUFFIXES:
        return None
    try:
        import tifffile
        with tifffile.TiffFile(path) as tf:
            page = tf.pages[0]
            arr = page.asarray()
            tag = page.tags.get("Orientation")
            orientation = int(tag.value) if tag is not None else 1
    except Exception:
        return None
    if arr.ndim == 2:
        arr = arr[:, :, None]
    if arr.shape[-1] == 1:
        arr = np.repeat(arr, 3, axis=-1)
    img = _apply_orientation(_to_uint8(arr[..., :3]), orientation)
    return np.ascontiguousarray(img[:, :, ::-1])                 # RGB → BGR


# EXIF orientation 2..8 → displayed pixels; 1 / unknown = identity. Same
# mapping as Pillow's ImageOps.exif_transpose (1 none, 2 flip-LR, 3 rot180,
# 4 flip-UD, 5 transpose, 6 rot90 CW, 7 transverse, 8 rot90 CCW).
def _apply_orientation(img: np.ndarray, orientation: int) -> np.ndarray:
    if orientation == 2:
        return img[:, ::-1]
    if orientation == 3:
        return img[::-1, ::-1]
    if orientation == 4:
        return img[::-1, :]
    if orientation == 5:
        return img.transpose(1, 0, 2)
    if orientation == 6:
        return np.rot90(img, -1)                # 90° clockwise
    if orientation == 7:
        return img.transpose(1, 0, 2)[::-1, ::-1]
    if orientation == 8:
        return np.rot90(img, 1)                 # 90° counter-clockwise
    return img


def _to_uint8(arr: np.ndarray) -> np.ndarray:
    """Normalise decoded samples to uint8 (#89, §4.29): uint8 passes
    through; integers scale over their dtype range (uint16 ⇒ ÷257); floats
    with max ≤ 1.5 are 0..1 *linear* and get gamma-encoded to sRGB (so face
    detection sees JPEG-like tones for float TIFF exports), ≤ 255 stay as
    they are, larger values are treated as 16-bit. NaN/inf ⇒ 0/255."""
    if arr.dtype == np.uint8:
        return arr
    if np.issubdtype(arr.dtype, np.integer):
        hi = float(np.iinfo(arr.dtype).max) or 1.0
        a = np.clip(arr, 0, None).astype(np.float32)
        return np.clip(a * (255.0 / hi) + 0.5, 0, 255).astype(np.uint8)
    a = np.nan_to_num(arr.astype(np.float32, copy=False),
                      nan=0.0, posinf=3.0e38, neginf=-3.0e38)
    peak = float(a.max()) if a.size else 0.0
    if peak <= 1.5:                             # 0..1 linear → sRGB encode
        a = np.clip(a, 0.0, 1.0)
        a = np.where(a <= 0.0031308, a * 12.92,
                     1.055 * np.power(a, 1.0 / 2.4) - 0.055)
        a = a * 255.0
    elif peak <= 255.5:                         # already 8-bit-range
        a = np.clip(a, 0.0, 255.0)
    else:                                       # 16-bit range
        a = np.clip(a, 0.0, 65535.0) * (255.0 / 65535.0)
    return (a + 0.5).astype(np.uint8)


def _resize_jpeg(img, long_edge: int, quality: int = 88) -> bytes:
    import cv2
    h, w = img.shape[:2]
    scale = long_edge / max(h, w)
    if scale < 1.0:
        img = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    assert ok
    return buf.tobytes()


# ---------------------------------------------------------------- detection

class Detector:
    """insightface FaceAnalysis, loaded once.

    **CPU by default**; MIGraphX only behind --gpu (#91): its compute
    hangs wedged the amdgpu and took the GNOME session down (2026-10-21),
    so the unsafe path must be requested explicitly."""

    def __init__(self, gpu: bool = False):
        from insightface.app import FaceAnalysis
        if gpu:
            # mirror activate.custom: direct bin/python calls don't inherit
            # the cache path, and MIGraphX fails hard when it is empty
            # (sessions are created lazily at first detect, so set it up-front)
            cache = os.environ.setdefault("ORT_MIGRAPHX_MODEL_CACHE_PATH",
                                          str(Path.home() / ".cache" / "migraphx"))
            Path(cache).mkdir(parents=True, exist_ok=True)
            try:
                self.app = FaceAnalysis(name="buffalo_l",
                                        providers=["MIGraphXExecutionProvider", "CPUExecutionProvider"])
                self.app.prepare(ctx_id=0, det_size=(640, 640))
                # sessions are created lazily on first detect — probe now so a
                # provider failure surfaces here, where we can fall back
                self.app.get(np.zeros((640, 640, 3), dtype=np.uint8))
                return
            except Exception as exc:               # GPU when it works, CPU otherwise
                print(f"MIGraphX unavailable ({exc}); falling back to CPU", file=sys.stderr)
        self.app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
        self.app.prepare(ctx_id=-1, det_size=(640, 640))

    def detect(self, img_bgr) -> list[Detection]:
        faces = self.app.get(img_bgr)
        out = []
        for f in faces:
            x1, y1, x2, y2 = np.clip(np.round(f.bbox).astype(int), 0, [10**9, 10**9,
                                                                      img_bgr.shape[1], img_bgr.shape[0]])
            x, y, w, h = int(x1), int(y1), int(x2 - x1), int(y2 - y1)
            if w <= 0 or h <= 0:
                continue
            emb = np.asarray(f.normed_embedding, dtype=np.float32)
            crop = img_bgr[y:y + h, x:x + w]
            out.append(Detection(box=(x, y, w, h),
                                 det_score=float(f.det_score),
                                 embedding=emb,
                                 crop_jpeg=_resize_jpeg(crop, FACE_CROP_LONG_EDGE)))
        return out


# ---------------------------------------------------------------- association

def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))             # vectors are L2-normalised


@dataclass
class PersonStub:
    person_id: int
    name: str
    is_known: bool                          # False = UnknownN (created by imports)
    vectors: list[np.ndarray] = field(default_factory=list)
    description: str = ""                   # appearance group of these vectors (§4.12)


def load_known_corpus(con: sqlite3.Connection) -> list[PersonStub]:
    """Confirmed-face vectors keyed per (person, appearance group) — the
    matching corpus (design 3.8, OQ-3; §4.12). The groups *partition* the
    person's pooled vectors, so the winning person and match/no-match are
    unchanged; what changes is that the winning stub carries its
    description for inheritance at insert time. Row order is pinned with
    ORDER BY faces.id for deterministic tie-breaks."""
    rows = con.execute("""
        SELECT f.person_id, p.name, e.vector, COALESCE(f.description, '')
          FROM faces f
          JOIN persons p ON p.id = f.person_id
          JOIN face_embeddings e ON e.face_id = f.id AND e.model = ?
         WHERE f.link_status = 'confirmed' AND p.name NOT LIKE 'Unknown%'
         ORDER BY f.id
    """, (MODEL_TAG,)).fetchall()
    groups: dict[tuple[int, str], PersonStub] = {}
    for pid, name, vec, desc in rows:
        stub = groups.setdefault((pid, desc), PersonStub(pid, name, True, description=desc))
        stub.vectors.append(_vec(vec))
    return list(groups.values())


def _vec(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


def load_unknown_corpus(con: sqlite3.Connection) -> list[PersonStub]:
    """Existing UnknownN vectors, keyed per (person, appearance group) (§4.12)
    — new faces may match them."""
    rows = con.execute("""
        SELECT f.person_id, p.name, e.vector, COALESCE(f.description, '')
          FROM faces f
          JOIN persons p ON p.id = f.person_id
          JOIN face_embeddings e ON e.face_id = f.id AND e.model = ?
         WHERE p.name LIKE 'Unknown%' AND f.link_status != 'rejected'
         ORDER BY f.id
    """, (MODEL_TAG,)).fetchall()
    groups: dict[tuple[int, str], PersonStub] = {}
    for pid, name, vec, desc in rows:
        stub = groups.setdefault((pid, desc), PersonStub(pid, name, False, description=desc))
        stub.vectors.append(_vec(vec))
    return list(groups.values())


def load_unknown_numbering_names(con: sqlite3.Connection) -> list[str]:
    """Every person name that owns an `UnknownN` number (#45): all `Unknown%`
    names — including faceless and rejected-only persons, which the *matching*
    corpus above deliberately excludes. Numbers must never be reused."""
    return [r[0] for r in con.execute("SELECT name FROM persons WHERE name LIKE 'Unknown%'")]


def associate(detections: list[Detection], corpus: list[PersonStub],
              unknowns: list[PersonStub], threshold: float,
              existing_names: Iterable[str] = ()) -> list[tuple[Detection, PersonStub]]:
    """Match each face to a person: known corpus first, then UnknownN clusters.

    Faces with no match above threshold are clustered among themselves
    (single-linkage greedy); each new cluster becomes a fresh UnknownN,
    numbered over `existing_names` + every UnknownN seen this run (#45).
    Returns (detection, person) pairs in input order.
    """
    assignments: dict[int, PersonStub] = {}

    # 1. known persons first (highest det_score wins ties)
    for idx in sorted(range(len(detections)), key=lambda i: -detections[i].det_score):
        best_sim, best_person = -1.0, None
        for person in corpus + unknowns:
            for v in person.vectors:
                sim = cosine(detections[idx].embedding, v)
                if sim > best_sim:
                    best_sim, best_person = sim, person
        if best_person is not None and best_sim >= threshold:
            assignments[idx] = best_person

    # 2. cluster the rest among themselves; each cluster = new UnknownN
    pending = [i for i in range(len(detections)) if i not in assignments]
    clusters: list[list[int]] = []
    for i in pending:
        joined = False
        for cluster in clusters:
            if any(cosine(detections[i].embedding, detections[j].embedding) >= threshold
                   for j in cluster):
                cluster.append(i)
                joined = True
                break
        if not joined:
            clusters.append([i])

    # every existing UnknownN owns its number — faceless/rejected-only included
    # (#45); clusters created earlier in this run rejoin via `unknowns`
    next_n = _next_unknown_number_for([*existing_names, *(u.name for u in unknowns)])
    for cluster in clusters:
        person = PersonStub(0, f"Unknown{next_n}", False)
        next_n += 1
        for i in cluster:
            assignments[i] = person
            person.vectors.append(detections[i].embedding)   # later faces may join this UnknownN

    return [(detections[i], assignments[i]) for i in range(len(detections))]


# Only this exact form carries a number; any other `Unknown…` name is ignored by
# numbering so it can neither skew the sequence nor abort a run (#46)
_UNKNOWN_NUM = re.compile(r"^Unknown(\d+)$")


def _next_unknown_number_for(names: Iterable[str]) -> int:
    """Next free UnknownN over raw person names. The caller supplies *every*
    existing `UnknownN` name (#45); non-numeric `Unknown…` names are skipped
    instead of raising (#46)."""
    nums = [int(m.group(1)) for n in names if (m := _UNKNOWN_NUM.match(n))]
    return max(nums, default=0) + 1


def _next_unknown_number(unknowns: list[PersonStub]) -> int:
    """Next free UnknownN over stubs (kept for callers holding stubs only)."""
    return _next_unknown_number_for(u.name for u in unknowns)


# ---------------------------------------------------------------- storage

def blake3_hex(path: Path) -> str:
    from blake3 import blake3
    h = blake3()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_person(con: sqlite3.Connection, stub: PersonStub, unknowns: list[PersonStub]) -> int:
    """Return the matched person's id, or insert a brand-new UnknownN for a
    fresh cluster. #45: minting is collision-free, so a fresh cluster is NEVER
    reused/linked by name — `persons.name` UNIQUE is the backstop. #165
    (gui-design §4.35): a fresh cluster is seeded with the status seat
    `New` — every person carries ≥1 group row from birth; filing it into a
    real group is the *user's* act (and replaces the seat)."""
    if stub.person_id:
        return stub.person_id
    cur = con.execute("INSERT INTO persons(name, state, created_at) VALUES (?, 'created', datetime('now'))",
                      (stub.name,))
    stub.person_id = cur.lastrowid
    con.execute("INSERT INTO person_groups(person_id, path) VALUES (?, 'New')",
                (stub.person_id,))
    unknowns.append(stub)
    return stub.person_id


def assign_seq(con: sqlite3.Connection, person_id: int, description: str = "") -> int:
    """Next seq for one (person, description) group — derived face name part
    (design 5, §4.12): MAX-based and scoped to the appearance group."""
    row = con.execute(
        "SELECT COALESCE(MAX(seq), 0) FROM faces WHERE person_id = ? AND COALESCE(description,'') = COALESCE(?, '')",
        (person_id, description)).fetchone()
    return row[0] + 1


def store_image(con: sqlite3.Connection, plan: ImportPlan, pairs, unknowns, import_id: int,
                now: str) -> None:
    cur = con.execute("""
        INSERT INTO images(content_hash, width, height, primary_path, state, orientation, type,
                           thumbnail, preview, first_import_id, last_import_id, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    """, (plan.content_hash, plan.width, plan.height, plan.path, plan.state, plan.orientation, plan.type,
          plan.icon_jpeg, plan.preview_jpeg, import_id, import_id, now))
    image_id = cur.lastrowid
    con.execute("INSERT OR IGNORE INTO image_paths(image_id, path) VALUES (?, ?)", (image_id, plan.path))
    for det, stub in pairs:
        person_id = ensure_person(con, stub, unknowns)
        # §4.12: inherit the winning appearance group; seq & label follow it
        desc = stub.description or None
        seq = assign_seq(con, person_id, stub.description)
        name = f"{stub.name}-{desc}-{seq}" if desc else f"{stub.name}-{seq}"
        cur = con.execute("""
            INSERT INTO faces(image_id, x, y, w, h, person_id, link_status, state, origin,
                              description, name, seq, confidence, preview, detected_in_import_id, created_at)
            VALUES (?,?,?,?,?,?, 'provisional', 'detected', 'insightface', ?,?,?,?,?,?,?)
        """, (image_id, *det.box, person_id, desc, name, seq, det.det_score,
               det.crop_jpeg, import_id, now))
        con.execute("INSERT INTO face_embeddings(face_id, model, dim, vector, created_at) "
                    "VALUES (?,?,?,?,?)",
                    (cur.lastrowid, MODEL_TAG, det.embedding.size,
                     det.embedding.astype("<f4").tobytes(), now))
    # #165 / gui-design §4.35: provisional faces landed on these persons —
    # a seated person (no user-given group) re-seats to `New`; a filed
    # person's rows are never touched (the system person's seat can't be
    # in play: `Rejected` is never an import target).
    for pid in {ensure_person(con, stub, unknowns) for _, stub in pairs}:
        con.execute(
            "UPDATE person_groups SET path = 'New'"
            "  WHERE person_id = ? AND path IN ('New', 'Accepted')"
            "    AND EXISTS (SELECT 1 FROM faces WHERE person_id = ?"
            "                AND link_status = 'provisional')",
            (pid, pid))


# ---------------------------------------------------------------- main

def plan_image(path: Path, detector: Detector | None) -> ImportPlan:
    """Build the import plan for one file. State: 'scanned' when faces were
    found, 'no-face' otherwise (kept by bulk imports until a face exists,
    req §3.3 / issue #1)."""
    img = _decode(path)
    hash_ = blake3_hex(path)
    orientation = "landscape" if img.shape[1] >= img.shape[0] else "portrait"
    plan = ImportPlan(content_hash=hash_, path=str(path), state="scanned",
                      width=int(img.shape[1]), height=int(img.shape[0]),
                      orientation=orientation,
                      type="raw" if path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"} else "processed",
                      icon_jpeg=_resize_jpeg(img, ICON_LONG_EDGE),
                      preview_jpeg=_resize_jpeg(img, PREVIEW_LONG_EDGE))
    if detector is not None:
        plan.detections = detector.detect(img)
    if not plan.detections:
        plan.state = "no-face"
    return plan


def assign_missing_primaries(con: sqlite3.Connection) -> None:
    """Set the machine-initial primary face for every person lacking one
    (req §3.2.2: the highest-confidence non-discarded, non-rejected face;
    user picks are pinned and never overwritten). Idempotent — also
    backfills persons imported before this pass existed (issue #10)."""
    con.execute("""
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


def build_parser() -> argparse.ArgumentParser:
    """Flag contract of one run (#90/#91) — extracted from main() so the
    defaults and refusals are unit-testable without a database or a model."""
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("roll_dir", type=Path, nargs="?",
                    help="roll directory to import (optional with --create-db)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--all", action="store_true",
                    help="import every image, faceless ones with state no-face (issue #1)")
    ap.add_argument("--gpu", action="store_true",
                    help="opt in to the MIGraphX GPU provider (CPU is the default, #91)")
    ap.add_argument("--cpu", action="store_true",
                    help="deprecated no-op: CPU is the default now (#91)")
    ap.add_argument("--threshold", type=float, default=THRESHOLD_DEFAULT)
    ap.add_argument("--recursive", action="store_true")
    ap.add_argument("--create-db", action="store_true",
                    help="create the database named in .env from database/schema.sql; "
                         "refuses an existing non-empty database (#90)")
    cli_console.add_quiet_arg(ap)
    return ap


def validate_args(ap: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    """Combinations refused before anything runs (#90)."""
    if args.create_db and args.dry_run:
        ap.error("--create-db cannot be combined with --dry-run (creation is a write)")
    if args.roll_dir is None and not args.create_db:
        ap.error("roll_dir is required unless --create-db is given")


def main(argv: list[str] | None = None) -> int:
    ap = build_parser()
    args = ap.parse_args(argv)
    validate_args(ap, args)

    ui = cli_console.Console(quiet=args.quiet)

    env = load_env(PROJECT_ROOT / ".env")
    db_path = PROJECT_ROOT / env.get("FACES_DB", "data/faces.db")

    if args.dry_run:
        mode = "DRY RUN — no writes"
    elif args.create_db:
        mode = "create database" + (" + import" if args.roll_dir else "")
    else:
        mode = "import"
    ui.header(f"WhoT import_roll — {mode}",
               f"roll dir  : {args.roll_dir or '(none — create only)'}",
               f"recursive : {'yes' if args.recursive else 'no'}",
               f"threshold : {args.threshold}  (model {MODEL_TAG})",
               f"provider  : {'gpu (MIGraphX, --gpu)' if args.gpu else 'cpu (default, --gpu to opt in)'}",
               f"database  : {db_path}")

    # --- database first: never create one implicitly, never misreport a
    # missing file as a schema mismatch (#90)
    if args.create_db and not create_database(db_path, ui):
        return 1
    if args.roll_dir is None:                # --create-db alone: done here
        return 0
    missing = missing_db_message(db_path)
    if missing:
        ui.error(missing)
        ui.summary(f"no database at {db_path} — nothing imported")
        return 1

    inject_insightface_venv(env)            # must precede Detector creation

    # non-recursive by default; --recursive walks subdirectories (design §3.1, #48)
    ui.status(f"scanning {args.roll_dir} ...")
    walk = args.roll_dir.rglob("*") if args.recursive else args.roll_dir.glob("*")
    files = sorted(p for p in (walk if args.roll_dir.is_dir() else [])
                   if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES)
    if not files:
        ui.summary(f"no image files in {args.roll_dir}")
        return 1
    ui.status(f"found {len(files)} image file(s)")

    con = sqlite3.connect(db_path)
    con.execute("PRAGMA foreign_keys = ON")
    check_schema(con, db_path)   # refuse a mismatched schema up-front
    ui.status(f"loading face model {MODEL_TAG} (first run may take a moment)...")
    ui.start_beat("loading face model")
    detector = Detector(gpu=args.gpu)   # dry-run still detects; it only suppresses writes
    ui.stop_beat()
    ui.status("face model ready")
    ui.status("loading match corpus from database...")
    ui.start_beat("loading match corpus")
    unknowns = load_unknown_corpus(con)   # existing UnknownN are matchable (design 3.2)
    corpus = load_known_corpus(con)
    # every UnknownN name owns its number, incl. faceless/rejected-only (#45)
    numbering_names = load_unknown_numbering_names(con)
    ui.stop_beat()
    ui.status(f"corpus ready: {len(corpus)} known group(s), {len(unknowns)} unknown group(s)")

    # #40: UTC, same convention as persons (datetime('now')) — one clock,
    # one format, for the whole import
    import_id, now = None, time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    if not args.dry_run:
        cur = con.execute("INSERT INTO imports(path, started_at) VALUES (?, ?)",
                          (str(args.roll_dir), now))
        import_id = cur.lastrowid
        con.commit()               # record the run up-front, even if it adds nothing (#47)
        ui.status(f"import run #{import_id} started at {now} UTC")

    failures: list[tuple[Path, str]] = []
    n_new = n_existing = n_noface = n_faces = 0
    ui.start_beat("importing")          # a single slow image must not go silent
    for i, path in enumerate(files, 1):
        n_stub = len(unknowns)     # run-created stubs before this file (dropped on failure)
        ui.set_phase(f"importing [{i}/{len(files)}]")
        ui.status(f"[{i}/{len(files)}] {path}")
        try:
            hash_ = blake3_hex(path)
            existing = con.execute("SELECT id FROM images WHERE content_hash = ?", (hash_,)).fetchone()
            if existing:
                n_existing += 1
                ui.status("  already in database — skipping")
                if not args.dry_run:      # dry-run must not write
                    con.execute("INSERT OR IGNORE INTO image_paths(image_id, path) VALUES (?, ?)",
                                (existing[0], str(path)))
                    # rescan touches the image: keep last_import_id truthful (#18)
                    con.execute("UPDATE images SET last_import_id = ? WHERE id = ?",
                                (import_id, existing[0]))
                    con.commit()
                continue
            plan = plan_image(path, detector)
            if not plan.detections and not args.all:
                n_noface += 1
                ui.status("  no faces")        # verdict only — path is on
                continue                       # the [i/N] line (#94)
            pairs = associate(plan.detections, corpus, unknowns, args.threshold, numbering_names)
            if not args.dry_run:
                store_image(con, plan, pairs, unknowns, import_id, now)
                # per-image transaction (#47): commit each image as soon as it is
                # stored — a later failure or kill keeps the imported prefix
                con.commit()
            n_new += 1
            n_faces += len(plan.detections)
            if plan.detections:
                ui.status(f"  imported: {len(plan.detections)} face(s), "
                          f"{len(set(id(s) for _, s in pairs))} person(s)")
            else:
                ui.status("  imported: no faces (state no-face, bulk)")
        except Exception as exc:
            # isolate the failure to THIS file (#47): discard its partial rows
            # and any person stubs it created, then continue with the batch
            if not args.dry_run:
                con.rollback()
            del unknowns[n_stub:]
            failures.append((path, str(exc)))
            ui.error(f"  FAILED: {exc}")      # path only on the [i/N] line
            # and in the closing failure list (#94)
    ui.stop_beat()

    if not args.dry_run:
        assign_missing_primaries(con)   # machine-initial primaries (req 3.2.2, issue #10)
        con.commit()
    con.close()
    ui.summary("-" * 64,
               f"{'would import' if args.dry_run else 'imported'} {n_new} image(s) "
               f"({n_faces} faces), skipped {n_existing} existing, {n_noface} without faces")
    if failures:
        ui.error(f"failed {len(failures)} file(s) (the rest of the batch was imported):")
        for p, err in failures:
            ui.error(f"  {p}: {err}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
