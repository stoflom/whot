"""Unit tests for scripts/fix_status_groups.py (#165, gui-design §4.35).

Run: python3 -m unittest discover -s test
Builds a v1.6-shaped faces.db from database/schema.sql, seeds the legacy
layout (retired `Unknown` rows, owned + unowned rejected faces, stale
derived state) and checks the upgrade end to end: what moves, what seats,
what is asserted, that it is idempotent, and that every refusal path
leaves the database untouched.
"""
from __future__ import annotations

import contextlib
import io
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import fix_status_groups as fx  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCHEMA = PROJECT_ROOT / "database" / "schema.sql"


def make_v16(path: Path) -> None:
    """A legacy-shaped database: marker 1.6, Unknown rows, rejected faces
    (owned + unowned), a stale primary and a stale pin at a rejected face."""
    con = sqlite3.connect(path)
    con.executescript(SCHEMA.read_text())
    con.execute("UPDATE schema_version SET version = '1.6'")
    con.execute(
        "INSERT INTO images(id, content_hash, width, height, primary_path, state, created_at)"
        " VALUES (1, printf('%064d', 1), 100, 100, '/a.jpg', 'scanned', 'now')")
    people = [
        (1, "Unknown7"),   # mixed      → seat New
        (2, "Unknown8"),   # all confirmed → seat Accepted
        (3, "Alice"),      # filed (Family|X), owns a rejected face
        (4, "Bob"),        # Unknown + Family|Y → keeps the real group
        (5, "Dana"),       # groupless  → seat by state
    ]
    for pid, name in people:
        con.execute(
            "INSERT INTO persons(id, name, state, created_at)"
            " VALUES (?, ?, 'created', 'now')", (pid, name))
    con.execute("INSERT INTO person_groups VALUES (1, 'Unknown')")
    con.execute("INSERT INTO person_groups VALUES (2, 'Unknown')")
    con.execute("INSERT INTO person_groups VALUES (3, 'Family|X')")
    con.execute("INSERT INTO person_groups VALUES (4, 'Unknown')")
    con.execute("INSERT INTO person_groups VALUES (4, 'Family|Y')")
    # (id, person, link_status, confidence) — previews present where refcrops matter
    for fid, pid, status, conf in [
        (1, 1, "provisional", 0.9),
        (2, 1, "confirmed", 0.8),
        (3, 2, "confirmed", 0.7),
        (4, 2, "confirmed", 0.6),
        (5, 3, "rejected", 0.95),   # owned rejected: moves; stale primary target
        (6, 3, "confirmed", 0.5),
        (7, 5, "provisional", 0.4),
        (8, None, "rejected", 0.3),  # historical unowned: moves
    ]:
        con.execute(
            "INSERT INTO faces(id, image_id, x, y, w, h, person_id, link_status, name,"
            " seq, confidence, preview, created_at)"
            " VALUES (?, 1, ?, ?, 10, 10, ?, ?, ?, ?, ?, x'aa', 'now')",
            (fid, fid * 10, fid * 10 + 1, pid, status, f"legacy-{fid}", fid, conf))
    con.execute("UPDATE persons SET primary_face_id = 5 WHERE id = 3")  # stale: moves away
    con.execute(
        "INSERT INTO person_refcrops VALUES (3, 5, '', 0, 1, 'Alice-5-1', x'aa')")  # stale pin
    con.commit()
    con.close()


class FixStatusGroupsTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="whot-fix165-"))
        self.db = self.dir / "faces.db"
        make_v16(self.db)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = fx.main(list(argv))
        return rc, out.getvalue(), err.getvalue()

    def q(self, sql, *args):
        con = sqlite3.connect(self.db)
        try:
            con.row_factory = sqlite3.Row
            return [dict(r) for r in con.execute(sql, args).fetchall()]
        finally:
            con.close()

    # ------------------------------------------------------------- upgrade

    def test_upgrade_moves_seats_and_asserts(self):
        rc, out, err = self.run_main(str(self.db), "-q")
        self.assertEqual(rc, 0, err)
        # marker + backup
        self.assertEqual(self.q("SELECT version FROM schema_version")[0]["version"], "1.7")
        backups = list(self.dir.glob("faces.db.pre-1.7-*"))
        self.assertEqual(len(backups), 1, "backup taken before the first write")
        # every rejected face (owned + unowned) homed on the system person
        rej = self.q("SELECT id FROM persons WHERE name = 'Rejected'")
        self.assertEqual(len(rej), 1)
        rej_id = rej[0]["id"]
        self.assertEqual(
            self.q("SELECT path FROM person_groups WHERE person_id = ?", rej_id),
            [{"path": "Rejected"}], "the fixed seat")
        moved = self.q(
            "SELECT id, name, seq FROM faces WHERE link_status = 'rejected' ORDER BY id")
        self.assertEqual([r["id"] for r in moved], [5, 8])
        self.assertEqual(
            [r["name"] for r in moved], ["Rejected-1", "Rejected-2"],
            "seq/name re-derived per §4.7")
        # retired Unknown rows are gone; seats written by state; filings kept
        self.assertEqual(
            self.q("SELECT COUNT(*) AS n FROM person_groups"
                   " WHERE path = 'Unknown' OR path LIKE 'Unknown|%'")[0]["n"], 0)
        self.assertEqual(self.q("SELECT path FROM person_groups WHERE person_id = 1"),
                         [{"path": "New"}])              # provisional remains
        self.assertEqual(self.q("SELECT path FROM person_groups WHERE person_id = 2"),
                         [{"path": "Accepted"}])         # all confirmed
        self.assertEqual(self.q("SELECT path FROM person_groups WHERE person_id = 3"),
                         [{"path": "Family|X"}])         # filing untouched
        self.assertEqual(
            sorted(r["path"] for r in self.q("SELECT path FROM person_groups WHERE person_id = 4")),
            ["Family|Y"], "Unknown row dropped, real row kept, no seat added")
        self.assertEqual(self.q("SELECT path FROM person_groups WHERE person_id = 5"),
                         [{"path": "New"}])              # groupless → seat by state
        # stale derived state: primary cleared + backfilled, stale pin dropped
        self.assertEqual(self.q("SELECT primary_face_id FROM persons WHERE id = 3")[0]
                         ["primary_face_id"], 6)
        self.assertEqual(
            self.q("SELECT COUNT(*) AS n FROM person_refcrops WHERE face_id = 5")[0]["n"], 0)
        # the invariants the script asserts (#165/§4.35)
        self.assertEqual(
            self.q("SELECT COUNT(*) AS n FROM persons p WHERE NOT EXISTS"
                   " (SELECT 1 FROM person_groups g WHERE g.person_id = p.id)")[0]["n"], 0)
        self.assertEqual(
            self.q("SELECT COUNT(*) AS n FROM faces WHERE link_status = 'rejected'"
                   " AND (person_id IS NULL OR person_id !="
                   " (SELECT id FROM persons WHERE name = 'Rejected'))")[0]["n"], 0)
        self.assertIn("integrity=ok", out)
        # stats tell the story
        self.assertIn("moved_rejected_faces=2", out)
        self.assertIn("unknown_rows_deleted=3", out)
        self.assertIn("seats_written=3", out)
        self.assertIn("marker=1.6 → 1.7", out)

    def test_second_run_is_a_noop(self):
        rc, out, _ = self.run_main(str(self.db), "-q")
        self.assertEqual(rc, 0)
        rc, out2, _ = self.run_main(str(self.db), "-q")
        self.assertEqual(rc, 0, "idempotent: already 1.7 exits 0")
        self.assertIn("already=v1.7", out2)
        self.assertEqual(len(list(self.dir.glob("faces.db.pre-1.7-*"))), 1,
                         "no second backup for a no-op run")

    # ------------------------------------------------------------- refusals

    def test_refuses_any_other_marker(self):
        con = sqlite3.connect(self.db)
        con.execute("UPDATE schema_version SET version = '1.5'")
        con.commit()
        con.close()
        with self.assertRaises(SystemExit) as ctx:
            self.run_main(str(self.db), "-q")
        self.assertIn("v1.6 → v1.7", str(ctx.exception))

    def test_refuses_missing_marker(self):
        con = sqlite3.connect(self.db)
        con.execute("DELETE FROM schema_version")
        con.commit()
        con.close()
        with self.assertRaises(SystemExit) as ctx:
            self.run_main(str(self.db), "-q")
        self.assertIn("empty schema_version", str(ctx.exception))

    def test_missing_database_fails_cleanly(self):
        rc, _, err = self.run_main(str(self.dir / "nope.db"))
        self.assertEqual(rc, 1)
        self.assertIn("no database at", err)

    def test_invariant_violation_rolls_everything_back(self):
        # a pre-seeded system person holding a REAL group violates §4.35:
        # the script must refuse, roll back and leave the marker at 1.6
        con = sqlite3.connect(self.db)
        con.execute(
            "INSERT INTO persons(id, name, state, created_at)"
            " VALUES (9, 'Rejected', 'created', 'now')")
        con.execute("INSERT INTO person_groups VALUES (9, 'Family|X')")
        con.commit()
        con.close()
        rc, _, err = self.run_main(str(self.db), "-q")
        self.assertEqual(rc, 1)
        self.assertIn("invariant violated", err)
        self.assertEqual(self.q("SELECT version FROM schema_version")[0]["version"], "1.6",
                         "rollback restored the marker")
        self.assertEqual(
            self.q("SELECT COUNT(*) AS n FROM faces WHERE link_status = 'rejected'"
                   " AND person_id = 3")[0]["n"], 1,
            "rollback restored the unmoved rejected face")
        self.assertEqual(
            self.q("SELECT COUNT(*) AS n FROM person_groups"
                   " WHERE path = 'Unknown'")[0]["n"], 3,
            "rollback restored the retired rows")


if __name__ == "__main__":
    unittest.main()
