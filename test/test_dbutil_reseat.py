# dbutil's shared §4.35 re-seat — the ONE implementation (#335).
# reseat_persons used to have a divergent bulk copy in import_roll.py
# (same rule cited, no insert-first, no reject-bin guard); the unify-on-
# dbutil form routes the set through reseat_person. These tests pin the
# semantics the bulk copy could drift on.
# Run: python3 -m pytest test/test_dbutil_reseat.py
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import dbutil  # noqa: E402

NOW = "2026-01-01 00:00:00"


def db():
    con = sqlite3.connect(":memory:")
    con.executescript("""
        CREATE TABLE persons(id INTEGER PRIMARY KEY, name TEXT, state TEXT, created_at TEXT);
        CREATE TABLE faces(id INTEGER PRIMARY KEY, person_id INT, link_status TEXT, state TEXT);
        CREATE TABLE person_groups(person_id INT, path TEXT);
    """)
    return con


def person(con, pid, name):
    con.execute("INSERT INTO persons VALUES (?,?, 'created', ?)", (pid, name, NOW))


def face(con, fid, pid, status):
    con.execute("INSERT INTO faces VALUES (?,?,?,'detected')", (fid, pid, status))


def seat(con, pid):
    return [r[0] for r in con.execute(
        "SELECT path FROM person_groups WHERE person_id=?", (pid,))]


class ReseatPersonsTest(unittest.TestCase):
    def test_insert_first_and_rederivation(self):
        """A seat-only person with a fresh provisional re-derives to New;
        losing the last provisional re-derives back to Accepted — the
        insert-first ordering leaves exactly one seat row."""
        con = db()
        person(con, 1, "A")
        person(con, 2, "B")
        con.executemany("INSERT INTO person_groups VALUES (?,?)",
                        [(1, "Accepted"), (2, "Accepted")])
        face(con, 10, 1, "provisional")
        face(con, 11, 2, "confirmed")
        dbutil.reseat_persons(con, {1, 2})
        self.assertEqual(seat(con, 1), ["New"])
        self.assertEqual(seat(con, 2), ["Accepted"],
                         "no provisional ⇒ seat re-derives to Accepted")

    def test_groupless_person_gets_a_seat(self):
        """The bulk copy's blind spot: a person with NO person_groups row
        (the invariant is broken by an external write) gets its seat
        inserted instead of being skipped."""
        con = db()
        person(con, 1, "A")
        face(con, 10, 1, "provisional")
        dbutil.reseat_persons(con, {1})
        self.assertEqual(seat(con, 1), ["New"])

    def test_filed_and_rejectbin_seats_are_never_touched(self):
        """A real group is never re-seated; a reject-bin person (the
        #266 RejectedN family) is never re-seated — even with
        provisional faces in hand."""
        con = db()
        person(con, 1, "Filed")
        person(con, 2, "RejectBin1")
        con.executemany("INSERT INTO person_groups VALUES (?,?)",
                        [(1, "family|x"), (2, "Rejected")])
        face(con, 10, 1, "provisional")
        face(con, 11, 2, "provisional")
        dbutil.reseat_persons(con, {1, 2})
        self.assertEqual(seat(con, 1), ["family|x"])
        self.assertEqual(seat(con, 2), ["Rejected"])

    def test_missing_id_is_a_silent_noop(self):
        """must_exist=True — a person deleted earlier in the run is
        skipped (the bulk statement's implicit behaviour)."""
        con = db()
        dbutil.reseat_persons(con, {99})          # no rows anywhere
        self.assertEqual(con.execute(
            "SELECT COUNT(*) FROM person_groups").fetchone()[0], 0)


class Blake3HexTest(unittest.TestCase):
    def test_matches_the_blake3_library_directly(self):
        """The shared copy hashes a file streamed, same identity as a
        direct blake3 call (and stable across two calls)."""
        import tempfile
        from blake3 import blake3
        payload = b"whot" * 300000               # > 1 MiB: the streaming path
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
            f.write(payload)
            p = Path(f.name)
        try:
            self.assertEqual(dbutil.blake3_hex(p),
                             blake3(payload).hexdigest())
            self.assertEqual(dbutil.blake3_hex(p), dbutil.blake3_hex(p))
        finally:
            p.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
