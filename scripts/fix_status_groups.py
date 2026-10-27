#!/usr/bin/env python3
"""fix_status_groups.py — one-off #165 data fix: v1.6 → v1.7 in place.

Upgrades a long-lived v1.6 `faces.db` to the v1.7 status-group layout
(gui-design §4.35) WITHOUT a re-import:

  * creates the system person `Rejected` (seat row `Rejected`) when any
    rejected face needs a home;
  * moves EVERY rejected face — owned and the historical unowned
    `remove_persons` leftovers — onto it, re-deriving seq/name per §4.7
    (`Rejected[-description]-seq`);
  * deletes the retired `Unknown` group rows and seats whoever that
    leaves groupless (any provisional face ⇒ `New`, else `Accepted`);
  * recomputes primaries/refcrops touched by the moves (stale primary
    pointers at moved faces are cleared first, then the machine rule
    backfills, §4.5/§4.6);
  * asserts the group invariant (≥ 1 group row per person, every
    rejected face on `Rejected`, no retired rows left) BEFORE committing;
  * bumps `schema_version` 1.6 → 1.7 (the app/importer gate).

A v1.6 database is refused by a v1.7 build until this has run; a database
already at 1.7 is a no-op (exit 0), anything else is refused. Runs are
backup-first: a full copy is written next to the database before the
first write, and the upgrade itself is one transaction. The upgraded
file's stored `.schema` stays byte-identical to a fresh
`database/schema.sql` build (#165 — only comments and the marker row
differ from v1.6).

Usage:
  fix_status_groups.py [db] [-q]

Console (scripts-design §10): startup header, status updates and the
final summary; -q/--quiet prints only header + summary.

Exit codes: 0 ok (upgraded or already v1.7), 1 failure / incompatible
schema. stdlib only (reuses cli_console + annotation_snapshot helpers).
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path

import cli_console                    # shared header/status/quiet console (§10)
import annotation_snapshot as snap    # shared derive/backfill/refcrop helpers

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FROM_VERSION = "1.6"    # the only version this fix accepts
# must equal SCHEMA_VERSION in schema.sql / db.rs / import_roll.py /
# import_harvested.py / annotation_snapshot.py once written:
TO_VERSION = "1.7"


# ---------------------------------------------------------------- helpers

def gate(con: sqlite3.Connection, db: Path) -> str:
    """'fix' (v1.6), 'done' (already v1.7); anything else exits."""
    try:
        row = con.execute("SELECT version FROM schema_version").fetchone()
    except sqlite3.Error:
        sys.exit(
            f"{db} has no schema_version marker — not a WhoT database.\n"
            f"Create it with: sqlite3 {db} < database/schema.sql"
        )
    if row is None:
        sys.exit(f"{db} has an empty schema_version table — refusing.")
    ver = row[0]
    if ver == TO_VERSION:
        return "done"
    if ver == FROM_VERSION:
        return "fix"
    sys.exit(
        f"{db} schema v{ver}: this script upgrades v{FROM_VERSION} → v{TO_VERSION} only.\n"
        f"Recreate with: sqlite3 {db} < database/schema.sql"
    )


def backup(con: sqlite3.Connection, db: Path, ui: cli_console.Console) -> Path:
    """Full copy next to the database, taken BEFORE the first write (sqlite
    backup API — consistent even with a hot -wal)."""
    ts = time.strftime("%Y%m%d-%H%M%S")
    dest = db.with_name(f"{db.name}.pre-{TO_VERSION}-{ts}")
    ui.status(f"backup    → {dest.name}")
    ui.start_beat("backup")
    try:
        with sqlite3.connect(dest) as dst:
            con.backup(dst)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    finally:
        ui.stop_beat()
    if not dest.is_file() or dest.stat().st_size == 0:
        dest.unlink(missing_ok=True)
        sys.exit(f"backup failed (missing or empty: {dest}) — nothing was changed")
    return dest


def seat_for(con: sqlite3.Connection, person_id: int) -> str:
    """§4.35 seat derivation: any provisional face ⇒ `New`, else `Accepted`.
    (Every rejected face is on the system person by the time this runs.)"""
    row = con.execute(
        "SELECT EXISTS(SELECT 1 FROM faces WHERE person_id = ?"
        "               AND link_status = 'provisional')",
        (person_id,)).fetchone()
    return "New" if row[0] else "Accepted"


def ensure_rejected_person(con: sqlite3.Connection, create: bool) -> int:
    """The system person `Rejected` (exact reserved name) + its seat row.
    Returns 0 when it does not exist and `create` is False (no rejected
    faces need a home)."""
    row = con.execute("SELECT id FROM persons WHERE name = 'Rejected'").fetchone()
    if row is None:
        if not create:
            return 0
        pid = con.execute(
            "INSERT INTO persons(name, state, created_at)"
            " VALUES ('Rejected', 'created', datetime('now'))").lastrowid
    else:
        pid = row[0]
    con.execute("INSERT OR IGNORE INTO person_groups(person_id, path) VALUES (?, 'Rejected')",
                (pid,))
    return pid


def move_rejected(con: sqlite3.Connection, rej_id: int) -> tuple[list[int], list[int]]:
    """Move every rejected face not already on `Rejected` onto it,
    re-deriving seq/name per §4.7 against the system person.
    Returns (moved face ids, origin person ids) — origins captured BEFORE
    the move, since the reparenting erases them."""
    origins = [r[0] for r in con.execute(
        "SELECT DISTINCT person_id FROM faces"
        " WHERE link_status = 'rejected' AND person_id IS NOT NULL"
        "   AND person_id != ?", (rej_id,)).fetchall()]
    moved = [r[0] for r in con.execute(
        "SELECT id FROM faces WHERE link_status = 'rejected'"
        "   AND (person_id IS NULL OR person_id != ?)"
        " ORDER BY id", (rej_id,)).fetchall()]
    if not moved:
        return [], []
    # next-free seq per (Rejected, description), §4.7 — seeded from what
    # `Rejected` already owns (fresh person ⇒ nothing), then re-derived.
    nxt: dict[str, int] = {}
    for desc, mx in con.execute(
            "SELECT COALESCE(description, ''), MAX(seq) FROM faces"
            " WHERE person_id = ? GROUP BY COALESCE(description, '')",
            (rej_id,)).fetchall():
        nxt[desc] = mx
    ph = ",".join("?" * len(moved))
    for fid, desc in con.execute(
            f"SELECT id, description FROM faces WHERE id IN ({ph}) ORDER BY id",
            moved).fetchall():
        key = desc or ""
        nxt[key] = nxt.get(key, 0) + 1
        con.execute(
            "UPDATE faces SET person_id = ?, seq = ?, name = ? WHERE id = ?",
            (rej_id, nxt[key], snap.derive_name("Rejected", desc, nxt[key]), fid))
    return moved, origins


def seat_groupless(con: sqlite3.Connection) -> tuple[int, int]:
    """Retire the `Unknown` rows, then enforce the invariant: whoever that
    (or anything else) leaves groupless is seated by state."""
    unknown_rows = con.execute(
        "DELETE FROM person_groups WHERE path = 'Unknown' OR path LIKE 'Unknown|%'"
    ).rowcount
    seat_rows = 0
    for (pid,) in con.execute(
            "SELECT p.id FROM persons p"
            " WHERE NOT EXISTS (SELECT 1 FROM person_groups g"
            "                   WHERE g.person_id = p.id)"
            " ORDER BY p.id").fetchall():
        con.execute("INSERT INTO person_groups(person_id, path) VALUES (?, ?)",
                    (pid, seat_for(con, pid)))
        seat_rows += 1
    return unknown_rows, seat_rows


def recompute_after_move(con: sqlite3.Connection, moved: list[int],
                         origins: list[int], rej_id: int,
                         refcrop_n: int) -> tuple[int, int]:
    """Primaries/refcrops touched by the moves (§4.5/§4.6): stale primary
    pointers at moved faces are cleared, the machine rule backfills, each
    origin person's auto-refcrops are rebuilt. The system person gets
    neither (eligibility excludes rejected faces, §4.35)."""
    cleared = rebuilt = 0
    if moved:
        ph = ",".join("?" * len(moved))
        cleared = con.execute(
            "UPDATE persons SET primary_face_id = NULL, primary_pinned = 0"
            f" WHERE primary_face_id IN ({ph})", moved).rowcount
        # a pin must never outlive the face's stay (§4.6): rejected faces
        # are refcrop-ineligible, wherever the stale rows came from
        con.execute(
            f"DELETE FROM person_refcrops WHERE face_id IN ({ph})", moved)
        for pid in sorted(origins):
            snap.backfill_primary(con, pid)
            snap.recompute_refcrops(con, pid, refcrop_n)
            rebuilt += 1
    if rej_id:
        con.execute("DELETE FROM person_refcrops WHERE person_id = ?", (rej_id,))
        con.execute("UPDATE persons SET primary_face_id = NULL, primary_pinned = 0"
                    " WHERE id = ?", (rej_id,))
    return cleared, rebuilt


def assert_invariant(con: sqlite3.Connection, rej_id: int) -> list[str]:
    """Violations found BEFORE the commit (§4.35) — anything here rolls
    the whole upgrade back."""
    bad: list[str] = []
    n = con.execute(
        "SELECT COUNT(*) FROM persons p"
        " WHERE NOT EXISTS (SELECT 1 FROM person_groups g WHERE g.person_id = p.id)"
    ).fetchone()[0]
    if n:
        bad.append(f"{n} person(s) without a group row")
    n = con.execute(
        "SELECT COUNT(*) FROM faces WHERE link_status = 'rejected'"
        "   AND (person_id IS NULL OR person_id != ?)", (rej_id,)).fetchone()[0]
    if n:
        bad.append(f"{n} rejected face(s) not on person `Rejected`")
    n = con.execute(
        "SELECT COUNT(*) FROM person_groups"
        " WHERE path = 'Unknown' OR path LIKE 'Unknown|%'").fetchone()[0]
    if n:
        bad.append(f"{n} retired `Unknown` group row(s) left")
    if rej_id:
        n = con.execute(
            "SELECT COUNT(*) FROM person_groups"
            " WHERE person_id = ? AND path != 'Rejected'", (rej_id,)).fetchone()[0]
        if n:
            bad.append(f"system person holds {n} non-seat group row(s)")
        n = con.execute(
            "SELECT COUNT(*) FROM faces"
            " WHERE person_id = ? AND link_status != 'rejected'", (rej_id,)).fetchone()[0]
        if n:
            bad.append(f"{n} non-rejected face(s) on the system person")
    return bad


# ---------------------------------------------------------------- main

def do_fix(db: Path, ui: cli_console.Console) -> dict[str, object]:
    con = sqlite3.connect(db, timeout=5.0, isolation_level=None)  # explicit BEGIN only
    try:
        con.execute("PRAGMA busy_timeout = 5000")
        if gate(con, db) == "done":
            return {"already": f"v{TO_VERSION} — nothing to do"}
        dest = backup(con, db, ui)

        ui.status("upgrading  …")
        pending = con.execute(
            "SELECT COUNT(*) FROM faces WHERE link_status = 'rejected'").fetchone()[0]
        refcrop_n = snap.restore_refcrop_n()
        con.execute("BEGIN")
        try:
            rej_id = ensure_rejected_person(con, create=pending > 0)
            moved, origins = move_rejected(con, rej_id)
            unknown_rows, seat_rows = seat_groupless(con)
            cleared, rebuilt = recompute_after_move(
                con, moved, origins, rej_id, refcrop_n)
            violations = assert_invariant(con, rej_id)
            if violations:
                raise RuntimeError("invariant violated: " + "; ".join(violations))
            con.execute(
                "UPDATE schema_version SET version = ?, updated_at = datetime('now')",
                (TO_VERSION,))
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise

        ui.status("verifying  …")
        integ = con.execute("PRAGMA integrity_check").fetchone()[0]
        fk = len(con.execute("PRAGMA foreign_key_check").fetchall())
        if integ != "ok" or fk:
            raise RuntimeError(
                f"post-fix verification failed: integrity={integ}, fk_violations={fk}")
        return {
            "backup": dest.name,
            "moved_rejected_faces": len(moved),
            "from_origin_persons": len(origins),
            "unknown_rows_deleted": unknown_rows,
            "seats_written": seat_rows,
            "stale_primaries_cleared": cleared,
            "refcrops_rebuilt_for": rebuilt,
            "marker": f"{FROM_VERSION} → {TO_VERSION}",
            "integrity": "ok",
        }
    finally:
        con.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="fix_status_groups.py",
        description="one-off #165 data fix: upgrade a v1.6 faces.db in place "
                    "(backup first, one transaction)")
    ap.add_argument("db", nargs="?", type=Path, default=None,
                    help="database to upgrade (default: FACES_DB from .env)")
    cli_console.add_quiet_arg(ap)
    args = ap.parse_args(argv)
    ui = cli_console.Console(quiet=args.quiet)

    db = args.db if args.db is not None else snap.default_db()
    ui.header(f"fix_status_groups.py — v{FROM_VERSION} → v{TO_VERSION} status-group data fix (#165)",
              f"database  : {db}",
              f"upgrade   : in place, backup first, one transaction")
    if not db.is_file():
        ui.error(f"no database at {db}")
        return 1
    try:
        stats = do_fix(db, ui)
    except (sqlite3.Error, RuntimeError, OSError) as exc:
        ui.error(f"FAILED: {exc} — the database was rolled back or left unchanged")
        return 1
    ui.summary(f"upgraded {db}: " + ", ".join(f"{k}={v}" for k, v in stats.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
