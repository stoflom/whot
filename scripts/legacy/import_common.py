#!/usr/bin/env python3
"""
import_common.py — staging database lifecycle for the import pipeline.

A staging DB is where everything gets written before the review DB is touched.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import signal
import sqlite3
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import envlib  # noqa: E402
import face_db2 as fdb  # noqa: E402

# --------------------------------------------------------------------------
# Invariant I1: the canonical source vocabulary.
#
# These are exactly the names already present in stored face_key values, plus
# the app's own scan source. Adding a name here is safe; inventing one
# elsewhere is not.
# --------------------------------------------------------------------------
CANON_SOURCES: dict[str, str] = {
    "sidecars-mwgrs":       "sidecars",    # MWG-RS rectangles (darktable)
    "sidecars-mpri":        "sidecars",    # MPRI PersonDisplayName presence
    "sidecars-catsets":     "sidecars",    # People|... hierarchical paths
    "digikam-core":         "digikam",     # digiKam core DB tag paths
    "digikam-recognition":  "digikam",     # digiKam recognition DB identities
    "digikam-faces":        "digikam",     # digiKam face rectangles
    "lap-faces":            "lap",         # Lap's person/face store (gh #111)
    "lightroom-catalog":    "lightroom",   # .lrcat face regions + person keywords
    "lightroom-sidecars":   "sidecars",    # Adobe-written XMP with face regions
    "app-scan":             "app",         # db::SCAN_SOURCE_NAME
}

# Every source with a reader in `import_harvest.py`.  A source is enabled by
# default only once its loader exists, so asking for one that is off still
# fails loudly rather than quietly doing nothing.
DEFAULT_SOURCES: tuple[str, ...] = (
    "sidecars-mwgrs",
    "sidecars-mpri",
    "sidecars-catsets",
    "digikam-core",
    "digikam-recognition",
    "digikam-faces",
    "lap-faces",
    "lightroom-catalog",
    "lightroom-sidecars",
)

# Copied from the review DB into a fresh staging DB. 
SEED_TABLES: tuple[str, ...] = (
    "persons",
    "sources",
    "person_paths",
    "person_refs",
    "person_aliases",
    "person_notes",
)

# Tables that may only be copied when explicitly asked for.
LARGE_SEED_TABLES: tuple[str, ...] = ("images", "image_paths", "image_headers")

RUNS_DDL = """
CREATE TABLE IF NOT EXISTS import_runs (
    run_id     TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,   -- 'archival' | 'rolls'
    roots      TEXT,
    sources    TEXT,
    status     TEXT NOT NULL DEFAULT 'open',
                             -- open|staged|verified|promoted|failed
    started_at TEXT,
    finished_at TEXT,
    stats      TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_runs_status
    ON import_runs(status);
"""

STEPS_DDL = """
CREATE TABLE IF NOT EXISTS import_run_steps (
    run_id      TEXT NOT NULL,
    step        TEXT NOT NULL,   -- inventory|harvest|scan|verify|promote
    status      TEXT NOT NULL,   -- running|done|failed|skipped
    started_at  TEXT,
    finished_at TEXT,
    stats       TEXT,
    error       TEXT,
    PRIMARY KEY (run_id, step)
);
"""


def init_run_tables(con: sqlite3.Connection) -> None:
    """Both staging-only tables, so a run dir predating either still works."""
    con.executescript(RUNS_DDL)
    con.executescript(STEPS_DDL)


class SourceNotCanonical(ValueError):
    """A source name outside CANON_SOURCES was requested."""


class CornerOriginViolation(RuntimeError):
    """A source would be written with a non-corner box origin."""


class Interrupted(Exception):
    """SIGINT/SIGTERM/SIGHUP arrived; unwind so `finally` still runs.

    Lives here (gh #105) rather than in `import_run.py`, the module that
    installs the handler: every step module in the chain must be able to let
    it propagate instead of catching it as an ordinary failure.
    """

    def __init__(self, signum: int):
        super().__init__(f"interrupted by {signal.Signals(signum).name}")
        self.signum = signum


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------
# run identity
# --------------------------------------------------------------------------

def import_root() -> Path:
    """~/.cache/facerec/imports (XDG-aware, like sidecar.rs::migraphx_cache_dir)."""
    cache = Path(os.environ.get("XDG_CACHE_HOME") or
                 (Path.home() / ".cache"))
    return cache.expanduser() / "facerec" / "imports"


_RUN_ID_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{6}$")


def new_run_id() -> str:
    """`YYYYmmdd-HHMMSS-xxxxxx`: sorts chronologically, readable, unique."""
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"{stamp}-{uuid.uuid4().hex[:6]}"


def valid_run_id(run_id: str) -> bool:
    return bool(_RUN_ID_RE.match(run_id))


@dataclass
class Run:
    """One import attempt. The directory is disposable; deleting it is safe."""
    run_id: str
    kind: str
    roots: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    base: Path = field(default_factory=import_root)

    @property
    def dir(self) -> Path:
        return self.base / self.run_id

    @property
    def staging_path(self) -> Path:
        return self.dir / "import_staging.db"

    @property
    def log_path(self) -> Path:
        return self.dir / "run.log"

    def exists(self) -> bool:
        return self.staging_path.exists()


def parse_root(spec: str) -> str:
    """`PATH` or `PATH:LABEL`, matching scan_hashes.py's --tree spelling."""
    if ":" not in spec:
        return spec
    path, _, label = spec.rpartition(":")
    if not path:                      # a bare label, or a windows drive
        return spec
    return f"{path}:{label}"


def create_run(kind: str, roots: list[str] | None = None,
               sources: list[str] | None = None,
               base: Path | None = None,
               run_id: str | None = None) -> Run:
    """Make the run directory and an empty, fully-initialised staging DB."""
    if kind not in ("archival", "rolls"):
        raise ValueError(f"kind must be 'archival' or 'rolls', got {kind!r}")
    run = Run(run_id=run_id or new_run_id(),
              kind=kind,
              roots=[parse_root(r) for r in (roots or [])],
              sources=list(sources or DEFAULT_SOURCES),
              base=base or import_root())
    if not valid_run_id(run.run_id):
        raise ValueError(f"malformed run id: {run.run_id!r}")
    for name in run.sources:       # fail before touching the filesystem
        check_canonical(name)
    run.dir.mkdir(parents=True, exist_ok=False)
    con = fdb.connect(str(run.staging_path))
    try:
        # The staging shadow needs the harvest's third-party tables; the
        # review DB never gets them (gh #78, design §1).
        fdb.init_db(con, third_party=True)
        init_run_tables(con)
        con.execute(
            "INSERT INTO import_runs(run_id, kind, roots, sources, status,"
            " started_at) VALUES(?,?,?,?,'open',?)",
            (run.run_id, run.kind,
             json.dumps(run.roots), json.dumps(run.sources),
             fdb._now()))
        con.commit()
    finally:
        con.close()
    return run


def open_staging(run: Run, readonly: bool = False) -> sqlite3.Connection:
    if not run.staging_path.exists():
        raise FileNotFoundError(f"no staging DB for {run.run_id}: "
                                f"{run.staging_path}")
    con = fdb.connect(str(run.staging_path), readonly=readonly)
    if not readonly:
        init_run_tables(con)   # a run dir made before these tables existed
    return con


def run_row(con: sqlite3.Connection, run_id: str) -> dict | None:
    r = con.execute("SELECT * FROM import_runs WHERE run_id=?",
                    (run_id,)).fetchone()
    return dict(r) if r else None


def set_status(con: sqlite3.Connection, run_id: str, status: str,
               stats: dict | None = None) -> None:
    if status == "promoted":
        con.execute("UPDATE import_runs SET status=?, finished_at=?, stats=?"
                    " WHERE run_id=?",
                    (status, fdb._now(),
                     json.dumps(stats) if stats else None, run_id))
    else:
        con.execute("UPDATE import_runs SET status=?, stats=? WHERE run_id=?",
                    (status, json.dumps(stats) if stats else None, run_id))
    con.commit()


STEP_ORDER = ("inventory", "harvest", "scan", "verify", "promote")

# The run status each completed step leaves behind, so a step table can be
# re-read into a status. `inventory` moves nothing: it is stage 1 of two.
STEP_BOUNDARY = {"inventory": None, "harvest": "staged", "scan": "staged",
                 "verify": "verified", "promote": "promoted"}


def step_state(con: sqlite3.Connection, run_id: str, step: str) -> str | None:
    """`running` | `done` | `failed` | `skipped`, or None if never started.

    Only `done` means "skip this on a resume".  A `running` row is a process
    that died mid-step, and re-running an idempotent stage is the correct
    recovery -- so it must not read as finished.
    """
    r = con.execute("SELECT status FROM import_run_steps"
                    " WHERE run_id=? AND step=?", (run_id, step)).fetchone()
    return r[0] if r else None


def step_rows(con: sqlite3.Connection, run_id: str) -> list[dict]:
    """This run's steps, in chain order rather than by start time.

    Two steps can share a timestamp, and alphabetical order would print
    `harvest` before `inventory`, which reads as a run that did nothing.
    """
    case = "CASE step " + " ".join(
        f"WHEN '{name}' THEN {i}" for i, name in enumerate(STEP_ORDER)) \
        + " ELSE 99 END"
    rows = con.execute(f"SELECT * FROM import_run_steps WHERE run_id=?"
                       f" ORDER BY {case}, started_at", (run_id,)).fetchall()
    return [dict(r) for r in rows]


def start_step(con: sqlite3.Connection, run_id: str, step: str) -> None:
    """Mark a step in flight, committed before the work begins.

    The commit is the point: a process killed mid-step must leave evidence
    that the step did not finish, or resume would skip it.
    """
    con.execute(
        "INSERT INTO import_run_steps(run_id, step, status, started_at)"
        " VALUES(?,?,'running',?)"
        " ON CONFLICT(run_id, step) DO UPDATE SET"
        " status='running', started_at=excluded.started_at,"
        " finished_at=NULL, stats=NULL, error=NULL",
        (run_id, step, fdb._now()))
    con.commit()


def finish_step(con: sqlite3.Connection, run_id: str, step: str,
                status: str = "done", stats: dict | None = None,
                error: str | None = None) -> None:
    """Record a step outcome. `status` is `done`, `failed` or `skipped`.

    Upserts, because a step can fail before `start_step` reached the commit --
    a stage that refused its arguments is still a step that did not pass.
    """
    con.execute(
        "INSERT INTO import_run_steps(run_id, step, status, finished_at,"
        " stats, error) VALUES(?,?,?,?,?,?)"
        " ON CONFLICT(run_id, step) DO UPDATE SET status=excluded.status,"
        " finished_at=excluded.finished_at, stats=excluded.stats,"
        " error=excluded.error",
        (run_id, step, status, fdb._now(),
         json.dumps(stats) if stats else None, error))
    con.commit()


def fail_run(con: sqlite3.Connection, run_id: str, step: str,
             error: str) -> None:
    """A step raised or was refused: the run is `failed` and resumable.

    `import_runs.stats` is cleared rather than left holding the previous
    stage's numbers, which would read as this run's result.
    """
    finish_step(con, run_id, step, status="failed", error=error)
    con.execute("UPDATE import_runs SET status='failed', stats=NULL"
                " WHERE run_id=?", (run_id,))
    con.commit()


STATUS_ORDER = ("open", "staged", "verified", "promoted")


def advance_status(con: sqlite3.Connection, run_id: str, status: str) -> bool:
    """Move the run forward to *status*, never backwards. False if unchanged.

    Unlike `set_status` this leaves `stats` alone. The stage that just ran
    wrote them, and restating its boundary must not erase the record of what
    it did; that is why the orchestrator advances the status with this instead
    of re-setting it.
    """
    if status not in STATUS_ORDER:
        return False
    current = (run_row(con, run_id) or {}).get("status") or "open"
    if current in STATUS_ORDER and STATUS_ORDER.index(current) >= \
            STATUS_ORDER.index(status):
        return False
    con.execute("UPDATE import_runs SET status=? WHERE run_id=?",
                (status, run_id))
    con.commit()
    return True


def sync_status(con: sqlite3.Connection, run_id: str) -> str:
    """Re-derive the coarse status from the step rows, never going backwards.

    Needed because the stage scripts write their own status when they run: stage
    3 sets `verified` when it finishes, so re-verifying a promoted run would
    leave the run reading `verified` while stage 4 is `done` and its rows are
    already in the review DB. The step table is the finer record; this keeps the
    coarse one from contradicting it.  A `failed` run is left alone -- that is a
    claim about what went wrong, not a position in the chain.
    """
    current = (run_row(con, run_id) or {}).get("status") or "open"
    if current == "failed":
        return current
    rows = {r["step"]: r["status"] for r in step_rows(con, run_id)}
    for name in STEP_ORDER:
        if rows.get(name) == "done":
            boundary = STEP_BOUNDARY.get(name)
            if boundary:
                advance_status(con, run_id, boundary)
    return (run_row(con, run_id) or {}).get("status") or "open"


def list_runs(base: Path | None = None) -> list[dict]:
    base = base or import_root()
    out: list[dict] = []
    if not base.is_dir():
        return out
    for d in sorted(base.iterdir(), reverse=True):
        if not valid_run_id(d.name):
            continue
        db = d / "import_staging.db"
        if not db.exists():
            continue
        try:
            con = fdb.connect(str(db), readonly=True)
        except sqlite3.Error:
            continue
        try:
            r = con.execute("SELECT * FROM import_runs WHERE run_id=?",
                            (d.name,)).fetchone()
            if r:
                out.append(dict(r))
        except sqlite3.Error:
            pass
        finally:
            con.close()
    return out


# --------------------------------------------------------------------------
# Invariant I1 / I2: sources
# --------------------------------------------------------------------------

def check_canonical(name: str) -> str:
    """The `kind` for *name*, or raise. Never auto-registers a new name."""
    try:
        return CANON_SOURCES[name]
    except KeyError:
        raise SourceNotCanonical(
            f"{name!r} is not a canonical source name. face_key hashes the "
            f"source name, so introducing one re-keys every face from it "
            f"(app/app-design.md, invariant I1). Known names: "
            f"{', '.join(sorted(CANON_SOURCES))}") from None


def ensure_sources(con: sqlite3.Connection,
                   names: list[str] | tuple[str, ...]) -> dict[str, int]:
    """Register the given canonical sources in a staging DB.

    Idempotent. Existing rows keep their kind and path; only `area_origin` is
    touched, and only from NULL/'corner' (invariant I2).
    """
    ids: dict[str, int] = {}
    for name in names:
        kind = check_canonical(name)
        con.execute("INSERT OR IGNORE INTO sources(name, kind) VALUES(?,?)",
                    (name, kind))
        row = con.execute("SELECT id, area_origin FROM sources WHERE name=?",
                          (name,)).fetchone()
        ids[name] = row["id"] if isinstance(row, sqlite3.Row) else row[0]
        mark_corner_origin(con, name)
    con.commit()
    return ids


def mark_corner_origin(con: sqlite3.Connection, name: str) -> None:
    """Record corner box origin for a source, refusing to overwrite 'centre'.

    A source recorded as centre-origin holds stored boxes in centre origin;
    silently re-labelling it to corner would contradict the stored geometry.
    """
    check_canonical(name)
    row = con.execute("SELECT area_origin FROM sources WHERE name=?",
                      (name,)).fetchone()
    if row is None:
        return
    cur = row["area_origin"] if isinstance(row, sqlite3.Row) else row[0]
    if cur == "corner":
        return
    if cur:
        raise CornerOriginViolation(
            f"source {name!r} is recorded as {cur!r} box origin; refusing to "
            f"overwrite it with 'corner'. Correct the source's stored origin "
            f"first, or pick a source name that is not already centre-origin.")
    con.execute("UPDATE sources SET area_origin='corner' WHERE name=?", (name,))


def assert_corner_origin(con: sqlite3.Connection,
                         names: list[str] | tuple[str, ...] | None = None
                         ) -> list[str]:
    """Sources whose area_origin is not 'corner'. Empty means clean.

    Called before promote: a non-corner source means some boxes may be
    centre-origin, which would re-key on promote.
    """
    if names:
        marks = ",".join("?" * len(names))
        rows = con.execute(
            f"SELECT name, COALESCE(area_origin,'<unset>') FROM sources"
            f" WHERE name IN ({marks})", tuple(names)).fetchall()
    else:
        rows = con.execute(
            "SELECT name, COALESCE(area_origin,'<unset>') FROM sources"
        ).fetchall()
    return [f"{r[0]} ({r[1]})" for r in rows if r[1] != "corner"]


# --------------------------------------------------------------------------
# seeding identity from the review DB (read-only)
# --------------------------------------------------------------------------

def seed_identity(staging: sqlite3.Connection, target_db: str | Path,
                  include_large: bool = False) -> dict[str, int]:
    """Copy identity tables from the review DB into a staging DB.

    The review DB is opened **read-only** (fdb.connect readonly=True), per the
    rule that external and live databases are never written by this path. The
    copy is what makes an imported name resolve to the same person id, and so
    makes face_key come out identical on both sides.

    `images` / `image_paths` / `image_headers` are ~252k rows and are skipped
    unless `include_large` -- stage 1 hashing populates the selected scope.
    """
    target = Path(target_db).expanduser()
    if not target.exists():
        raise FileNotFoundError(f"target database not found: {target}")
    tables = list(SEED_TABLES) + (list(LARGE_SEED_TABLES) if include_large else [])
    src = fdb.connect(str(target), readonly=True)
    counts: dict[str, int] = {}
    try:
        have = {r[0] for r in src.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        for table in tables:
            if table not in have:
                counts[table] = -1        # absent in an older DB; not an error
                continue
            have_col = {r[1] for r in staging.execute(
                f"PRAGMA table_info({table})")}
            src_col = {r[1] for r in src.execute(f"PRAGMA table_info({table})")}
            cols = [c for c in have_col & src_col]
            if not cols:
                counts[table] = 0
                continue
            collist = ",".join(cols)
            staging.executemany(
                f"INSERT OR IGNORE INTO {table} ({collist})"
                f" VALUES ({','.join('?' * len(cols))})",
                src.execute(f"SELECT {collist} FROM {table}"))
            counts[table] = staging.execute(
                f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        staging.commit()
    finally:
        src.close()
    return counts


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def _print_run(r: dict) -> None:
    roots = r.get("roots") or "[]"
    sources = r.get("sources") or "[]"
    print(f"run_id       {r['run_id']}")
    print(f"kind         {r.get('kind')}")
    print(f"status       {r.get('status')}")
    print(f"started      {r.get('started_at')}")
    print(f"finished     {r.get('finished_at')}")
    try:
        print(f"roots        {', '.join(json.loads(roots)) or '(none)'}")
    except (TypeError, ValueError):
        print(f"roots        {roots}")
    try:
        print(f"sources      {', '.join(json.loads(sources)) or '(none)'}")
    except (TypeError, ValueError):
        print(f"sources      {sources}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", metavar="DIR",
                    help="import root (default ~/.cache/facerec/imports)")
    ap.add_argument("--list-sources", action="store_true",
                    help="print the canonical source vocabulary and exit")
    ap.add_argument("--list-runs", action="store_true",
                    help="list existing runs and exit")
    ap.add_argument("--stage-init", action="store_true",
                    help="create a run dir and staging DB")
    ap.add_argument("--stage-info", metavar="RUN_ID",
                    help="print one run and its staging counts")
    ap.add_argument("--kind", default="archival",
                    choices=["archival", "rolls"])
    ap.add_argument("--root", action="append", default=[],
                    metavar="PATH[:LABEL]", help="repeatable")
    ap.add_argument("--source", action="append", default=[],
                    metavar="NAME", help="repeatable or comma separated")
    ap.add_argument("--seed-from", metavar="DB",
                    help="copy identity tables from this review DB")
    ap.add_argument("--seed-large", action="store_true",
                    help="also copy images/image_paths/image_headers")
    ap.add_argument("--target", default=str(envlib.db_path()),
                    help="review DB, for the corner-origin check")
    args = ap.parse_args()

    base = Path(args.base).expanduser() if args.base else import_root()

    if args.list_sources:
        first = set(DEFAULT_SOURCES)
        for name, kind in sorted(CANON_SOURCES.items()):
            mark = "on " if name in first else "off"
            print(f"  {mark}  {name:<22} kind={kind}")
        print(f"\n{len(CANON_SOURCES)} canonical names; "
              f"{len(first)} enabled by default in the first pass")
        return 0

    if args.list_runs:
        runs = list_runs(base)
        if not runs:
            print(f"no runs under {base}")
            return 0
        for r in runs:
            print(f"{r['run_id']}  {r.get('kind'):<9} {r.get('status')}")
        return 0

    if args.stage_info:
        if not valid_run_id(args.stage_info):
            print(f"malformed run id: {args.stage_info!r}")
            return 1
        run = Run(run_id=args.stage_info, kind="", base=base)
        if not run.exists():
            print(f"no staging DB at {run.staging_path}")
            return 1
        con = open_staging(run, readonly=True)
        try:
            row = run_row(con, run.run_id)
            if row:
                _print_run(row)
            counts = {}
            for t in ("images", "image_paths", "persons", "faces", "detections",
                      "issues", "suggestions", "face_embeddings",
                      "person_embeddings"):
                try:
                    counts[t] = con.execute(f"SELECT COUNT(*) FROM {t}"
                                            ).fetchone()[0]
                except sqlite3.Error:
                    counts[t] = None
            for t, n in counts.items():
                print(f"{t:<18} {n if n is not None else '-'}")
            try:
                steps = step_rows(con, args.stage_info)
            except sqlite3.Error:
                steps = []
            if steps:
                print()
                for s in steps:
                    extra = f"  {s['error']}" if s["error"] else ""
                    print(f"step {s['step']:<10} {s['status']}"
                          f"{extra}")
            bad = assert_corner_origin(con)
            print(f"\nnon-corner sources: {', '.join(bad) if bad else 'none'}")
        finally:
            con.close()
        return 0

    if args.stage_init:
        sources: list[str] = []
        for s in args.source:
            sources.extend(x.strip() for x in s.split(",") if x.strip())
        try:
            run = create_run(args.kind, args.root or [], sources or None,
                             base=base)
        except (SourceNotCanonical, ValueError) as e:
            print(f"error: {e}")
            return 1
        log(f"run {run.run_id}  kind={run.kind}")
        log(f"  dir      {run.dir}")
        log(f"  staging  {run.staging_path}")
        con = open_staging(run)
        try:
            ensure_sources(con, run.sources)
            log(f"  sources  {', '.join(run.sources)}")
            if args.seed_from:
                counts = seed_identity(con, args.seed_from, args.seed_large)
                log("  seeded identity from "
                    f"{args.seed_from}:")
                for t, n in counts.items():
                    log(f"    {t:<16} {n if n >= 0 else 'absent in target'}")
            bad = assert_corner_origin(con, run.sources)
            if bad:
                log(f"  WARNING non-corner: {', '.join(bad)}")
        finally:
            con.close()
        return 0

    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())