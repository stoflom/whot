#!/usr/bin/env python
"""import_roll.py — import a film-roll directory into data/faces.db.

Pipeline (scripts-design.md):
  scan -> BLAKE3 hash -> skip existing / detect+embed -> associate -> store

Usage: import_roll.py [--dry-run] [--recursive] [--threshold F] ROLL_DIR
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

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODEL_TAG = "insightface:buffalo_l"


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
    return raw


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
    """Decode to BGR ndarray; RAW via rawpy's embedded preview or half-size image."""
    import cv2
    if path.suffix.lower() in {".pef", ".dng", ".cr2", ".cr3", ".nef", ".arw", ".rw2", ".orf"}:
        import rawpy
        with rawpy.imread(str(path)) as raw:
            try:
                thumb = raw.extract_thumb()
                if thumb.format == rawpy.ThumbFormat.JPEG:
                    return cv2.imdecode(np.frombuffer(thumb.data, np.uint8), cv2.IMREAD_COLOR)
            except rawpy.LibRawNoThumbnailError:
                pass
            rgb = raw.postprocess(half_size=True, use_camera_wb=True)
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"cannot decode {path}")
    return img


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
    """insightface FaceAnalysis, loaded once."""

    def __init__(self, cpu: bool = False):
        from insightface.app import FaceAnalysis
        # mirror activate.custom: direct bin/python calls don't inherit the
        # cache path, and MIGraphX fails hard when it is empty (sessions are
        # created lazily at first detect, so this must be set up-front)
        cache = os.environ.setdefault("ORT_MIGRAPHX_MODEL_CACHE_PATH",
                                      str(Path.home() / ".cache" / "migraphx"))
        Path(cache).mkdir(parents=True, exist_ok=True)
        try:
            if cpu:
                raise RuntimeError("--cpu requested")
            self.app = FaceAnalysis(name="buffalo_l",
                                    providers=["MIGraphXExecutionProvider", "CPUExecutionProvider"])
            self.app.prepare(ctx_id=0, det_size=(640, 640))
            # sessions are created lazily on first detect — probe now so a
            # provider failure surfaces here, where we can fall back
            self.app.get(np.zeros((640, 640, 3), dtype=np.uint8))
        except Exception as exc:                       # GPU when it works, CPU otherwise
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


def load_known_corpus(con: sqlite3.Connection) -> list[PersonStub]:
    """Confirmed-face vectors per person — the matching corpus (design 3.8, OQ-3)."""
    rows = con.execute("""
        SELECT f.person_id, p.name, e.vector
          FROM faces f
          JOIN persons p ON p.id = f.person_id
          JOIN face_embeddings e ON e.face_id = f.id AND e.model = ?
         WHERE f.link_status = 'confirmed' AND p.name NOT LIKE 'Unknown%'
    """, (MODEL_TAG,)).fetchall()
    people: dict[int, PersonStub] = {}
    for pid, name, vec in rows:
        people.setdefault(pid, PersonStub(pid, name, True)).vectors.append(_vec(vec))
    return list(people.values())


def _vec(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


def load_unknown_corpus(con: sqlite3.Connection) -> list[PersonStub]:
    """Vectors of existing UnknownN persons — new faces may match them (design 3.2)."""
    rows = con.execute("""
        SELECT f.person_id, p.name, e.vector
          FROM faces f
          JOIN persons p ON p.id = f.person_id
          JOIN face_embeddings e ON e.face_id = f.id AND e.model = ?
         WHERE p.name LIKE 'Unknown%' AND f.link_status != 'rejected'
    """, (MODEL_TAG,)).fetchall()
    people: dict[int, PersonStub] = {}
    for pid, name, vec in rows:
        people.setdefault(pid, PersonStub(pid, name, False)).vectors.append(_vec(vec))
    return list(people.values())


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
    reused/linked by name — `persons.name` UNIQUE is the backstop."""
    if stub.person_id:
        return stub.person_id
    cur = con.execute("INSERT INTO persons(name, state, created_at) VALUES (?, 'created', datetime('now'))",
                      (stub.name,))
    stub.person_id = cur.lastrowid
    con.execute("INSERT OR IGNORE INTO person_groups(person_id, path) VALUES (?, 'Unknown')",
                (stub.person_id,))
    unknowns.append(stub)
    return stub.person_id


def assign_seq(con: sqlite3.Connection, person_id: int) -> int:
    """Next per-(person, description='') sequence — derived face name part (design 5)."""
    row = con.execute("SELECT COUNT(*) FROM faces WHERE person_id = ? AND COALESCE(description,'') = ''",
                      (person_id,)).fetchone()
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
        seq = assign_seq(con, person_id)
        name = f"{stub.name}-{seq}"
        cur = con.execute("""
            INSERT INTO faces(image_id, x, y, w, h, person_id, link_status, state, origin,
                              name, seq, confidence, preview, detected_in_import_id, created_at)
            VALUES (?,?,?,? ,?,?, 'provisional', 'detected', 'insightface', ?,?,?,?, ?,?)
        """, (image_id, *det.box, person_id, name, seq, det.det_score, det.crop_jpeg, import_id, now))
        con.execute("INSERT INTO face_embeddings(face_id, model, dim, vector, created_at) "
                    "VALUES (?,?,?,?,?)",
                    (cur.lastrowid, MODEL_TAG, det.embedding.size,
                     det.embedding.astype("<f4").tobytes(), now))


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
    (req §3.2.2: highest-confidence face, first-group semantics; user picks
    are pinned and never overwritten). Idempotent — also backfills persons
    imported before this pass existed (issue #10)."""
    con.execute("""
        UPDATE persons SET primary_face_id = (
            SELECT f.id FROM faces f
             WHERE f.person_id = persons.id AND f.state != 'discarded'
             ORDER BY f.confidence DESC, f.id LIMIT 1)
        WHERE primary_face_id IS NULL
          AND EXISTS (SELECT 1 FROM faces f
                       WHERE f.person_id = persons.id AND f.state != 'discarded')
    """)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("roll_dir", type=Path)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--all", action="store_true",
                    help="import every image, faceless ones with state no-face (issue #1)")
    ap.add_argument("--cpu", action="store_true", help="force CPU provider (skip MIGraphX)")
    ap.add_argument("--threshold", type=float, default=THRESHOLD_DEFAULT)
    ap.add_argument("--recursive", action="store_true")
    args = ap.parse_args(argv)

    env = load_env(PROJECT_ROOT / ".env")
    inject_insightface_venv(env)            # must precede Detector creation
    db_path = PROJECT_ROOT / env.get("FACES_DB", "data/faces.db")

    # non-recursive by default; --recursive walks subdirectories (design §3.1, #48)
    walk = args.roll_dir.rglob("*") if args.recursive else args.roll_dir.glob("*")
    files = sorted(p for p in (walk if args.roll_dir.is_dir() else [])
                   if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES)
    if not files:
        print(f"no image files in {args.roll_dir}")
        return 1

    con = sqlite3.connect(db_path)
    con.execute("PRAGMA foreign_keys = ON")
    detector = Detector(cpu=args.cpu)   # dry-run still detects; it only suppresses writes
    unknowns = load_unknown_corpus(con)   # existing UnknownN are matchable (design 3.2)
    corpus = load_known_corpus(con)
    # every UnknownN name owns its number, incl. faceless/rejected-only (#45)
    numbering_names = load_unknown_numbering_names(con)

    import_id, now = None, time.strftime("%Y-%m-%dT%H:%M:%S")
    if not args.dry_run:
        cur = con.execute("INSERT INTO imports(path, started_at) VALUES (?, ?)",
                          (str(args.roll_dir), now))
        import_id = cur.lastrowid
        con.commit()               # record the run up-front, even if it adds nothing (#47)

    failures: list[tuple[Path, str]] = []
    n_new = n_existing = n_noface = n_faces = 0
    for path in files:
        n_stub = len(unknowns)     # run-created stubs before this file (dropped on failure)
        try:
            hash_ = blake3_hex(path)
            existing = con.execute("SELECT id FROM images WHERE content_hash = ?", (hash_,)).fetchone()
            if existing:
                n_existing += 1
                if not args.dry_run:      # dry-run must not write
                    con.execute("INSERT OR IGNORE INTO image_paths(image_id, path) VALUES (?, ?)",
                                (existing[0], str(path)))
                    con.commit()
                continue
            plan = plan_image(path, detector)
            if not plan.detections and not args.all:
                n_noface += 1
                print(f"  no faces: {path.name}")
                continue
            pairs = associate(plan.detections, corpus, unknowns, args.threshold, numbering_names)
            if not args.dry_run:
                store_image(con, plan, pairs, unknowns, import_id, now)
                # per-image transaction (#47): commit each image as soon as it is
                # stored — a later failure or kill keeps the imported prefix
                con.commit()
            n_new += 1
            n_faces += len(plan.detections)
            if plan.detections:
                print(f"  imported {path.name}: {len(plan.detections)} face(s), "
                      f"{len(set(id(s) for _, s in pairs))} person(s)")
            else:
                print(f"  imported {path.name}: no faces (state no-face, bulk)")
        except Exception as exc:
            # isolate the failure to THIS file (#47): discard its partial rows
            # and any person stubs it created, then continue with the batch
            if not args.dry_run:
                con.rollback()
            del unknowns[n_stub:]
            failures.append((path, str(exc)))
            print(f"  FAILED {path.name}: {exc}", file=sys.stderr)

    if not args.dry_run:
        assign_missing_primaries(con)   # machine-initial primaries (req 3.2.2, issue #10)
        con.commit()
    con.close()
    print(f"{'would import' if args.dry_run else 'imported'} {n_new} image(s) "
          f"({n_faces} faces), skipped {n_existing} existing, {n_noface} without faces")
    if failures:
        print(f"failed {len(failures)} file(s) (the rest of the batch was imported):",
              file=sys.stderr)
        for p, err in failures:
            print(f"  {p}: {err}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
