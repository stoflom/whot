"""Tests for scripts/annotation_snapshot.py (schema v1.6 export/restore).

Run: python3 -m unittest discover -s test
Builds old/new databases from database/schema.sql — no local data needed.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import annotation_snapshot as ansi  # noqa: E402

SCHEMA = Path(__file__).resolve().parent.parent / "database" / "schema.sql"
NOW = "2026-10-15T00:00:00"
HASH = "a" * 64


def build_db(path: Path) -> None:
    con = sqlite3.connect(path)
    con.executescript(SCHEMA.read_text())
    con.execute(
        "INSERT INTO imports(id, path, started_at) VALUES (1, '/tmp/roll1', ?)", (NOW,))
    con.execute(
        "INSERT INTO images(id, content_hash, width, height, primary_path, state, "
        "orientation, type, created_at) VALUES (1, ?, 100, 100, 'a.jpg', 'scanned', "
        "'landscape', 'processed', ?)", (HASH, NOW))
    con.execute(
        "INSERT INTO persons(id, name, state, created_at) VALUES (1, 'Unknown1', 'created', ?)",
        (NOW,))
    con.execute("INSERT INTO person_groups(person_id, path) VALUES (1, 'Unknown')")
    con.execute(
        "INSERT INTO persons(id, name, state, created_at) VALUES (2, 'Unknown2', 'created', ?)",
        (NOW,))
    con.execute("INSERT INTO person_groups(person_id, path) VALUES (2, 'Unknown')")
    for fid, (x, y), seq, conf in [
        (1, (10, 10), 1, 0.9), (2, (50, 50), 2, 0.8), (3, (80, 5), 3, 0.7),
    ]:
        con.execute(
            "INSERT INTO faces(id, image_id, x, y, w, h, person_id, link_status, state, "
            "origin, name, seq, confidence, preview, detected_in_import_id, created_at) "
            "VALUES (?, 1, ?, ?, 20, 20, 1, 'provisional', 'detected', 'insightface', "
            "'Unknown1-?', ?, ?, ?, 1, ?)",
            (fid, x, y, seq, conf, f"prev{fid}".encode(), NOW))
    # a second, never-renamed importer cluster: its face keeps its person on restore
    con.execute(
        "INSERT INTO faces(id, image_id, x, y, w, h, person_id, link_status, state, "
        "origin, name, seq, confidence, preview, detected_in_import_id, created_at) "
        "VALUES (4, 1, 5, 60, 20, 20, 2, 'provisional', 'detected', 'insightface', "
        "'Unknown2-1', 1, 0.6, ?, 1, ?)",
        (b"prev4", NOW))
    con.commit()
    con.close()


def apply_user_work(db: Path) -> None:
    """Simulate what a session of GUI work would leave behind (db1)."""
    con = sqlite3.connect(db)
    con.execute("UPDATE persons SET name = 'Alice', note = 'mom', "
                "primary_face_id = 1, primary_pinned = 1 WHERE id = 1")
    con.execute("DELETE FROM person_groups WHERE person_id = 1")
    con.execute("INSERT INTO person_groups VALUES (1, 'family|test')")
    con.execute("UPDATE faces SET link_status = 'confirmed', description = 'beard', "
                "name = 'Alice-beard-1' WHERE id = 1")
    con.execute("UPDATE faces SET link_status = 'confirmed', description = 'glasses', "
                "name = 'Alice-glasses-2' WHERE id = 2")
    con.execute("UPDATE faces SET link_status = 'rejected' WHERE id IN (3, 4)")
    con.execute(
        "INSERT INTO person_refcrops(person_id, face_id, description, pinned, seq, "
        "filename, crop) VALUES (1, 2, 'glasses', 1, 1, 'Alice-glasses-2-1.jpg', ?)",
        (b"crop",))
    con.commit()
    con.close()


class RoundTripTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="whot-ansi-"))
        self.old = self.dir / "old.db"
        self.new = self.dir / "new.db"
        build_db(self.old)
        apply_user_work(self.old)
        build_db(self.new)  # freshly recreated + re-imported state

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_export_reports_schema_and_decisions(self):
        data = ansi.do_export(self.old)
        self.assertEqual(data["format"], 1)
        self.assertEqual(data["source_schema"], "1.6")
        self.assertEqual([p["name"] for p in data["persons"]], ["Alice"])
        self.assertEqual(data["persons"][0]["groups"], ["family|test"])
        self.assertEqual(data["persons"][0]["note"], "mom")
        self.assertEqual(len(data["faces"]), 4)  # all four have decisions
        self.assertEqual(len(data["pins"]), 1)
        self.assertEqual(data["pins"][0]["group"], "glasses")

    def test_restore_reapplies_everything(self):
        stats = ansi.do_restore(ansi.do_export(self.old), self.new)
        self.assertEqual(stats["unmatched_faces"], 0)
        con = sqlite3.connect(self.new)
        alice = con.execute(
            "SELECT id, note, primary_face_id, primary_pinned FROM persons "
            "WHERE name = 'Alice'").fetchone()
        self.assertIsNotNone(alice, "named person must be recreated")
        self.assertEqual(alice[1], "mom")
        self.assertEqual(alice[3], 1)
        groups = [r[0] for r in con.execute(
            "SELECT path FROM person_groups WHERE person_id = ?", (alice[0],))]
        self.assertEqual(groups, ["family|test"])
        f1 = con.execute(
            "SELECT person_id, link_status, description, seq, name FROM faces "
            "WHERE id = 1").fetchone()
        self.assertEqual(f1[0], alice[0], "face must move to the restored person")
        self.assertEqual(f1[1:], ("confirmed", "beard", 1, "Alice-beard-1"))
        self.assertEqual(alice[2], 1, "primary resolved to the matched face")
        f3 = con.execute(
            "SELECT person_id, link_status, name FROM faces WHERE id = 3").fetchone()
        self.assertEqual(f3[0], alice[0],
                         "a rejected face of a renamed cluster stays with that person")
        self.assertEqual(f3[1:], ("rejected", "Alice-3"))
        f4 = con.execute(
            "SELECT person_id, link_status, name FROM faces WHERE id = 4").fetchone()
        self.assertEqual(f4[0], 2, "face of an unnamed person stays with its import person")
        self.assertEqual(f4[1:], ("rejected", "Unknown2-1"),
                         "link_status restored even without a person move")
        pin = con.execute(
            "SELECT description, pinned, seq FROM person_refcrops WHERE person_id = ?",
            (alice[0],)).fetchone()
        self.assertEqual(pin, ("glasses", 1, 1), "pin restored with its group")
        # #37: Unknown1 lost all three faces to Alice -> shell deleted;
        # Unknown2 keeps its face and survives
        self.assertEqual(
            con.execute("SELECT count(*) FROM persons WHERE id = 1").fetchone()[0], 0,
            "emptied UnknownN shell must be deleted")
        self.assertEqual(
            con.execute("SELECT count(*) FROM persons WHERE id = 2").fetchone()[0], 1,
            "person keeping a face must survive")
        con.close()

    def test_legacy_pre15_export(self):
        con = sqlite3.connect(self.old)
        # pre-1.5 database: no schema_version, pin expressed as 'pin:' prefix
        con.execute("DROP TABLE schema_version")
        con.execute("ALTER TABLE person_refcrops DROP COLUMN pinned")
        con.execute("UPDATE person_refcrops SET description = 'pin:glasses'")
        con.commit()
        con.close()
        data = ansi.do_export(self.old)
        self.assertEqual(data["source_schema"], "pre-1.5")
        self.assertEqual(data["pins"][0]["group"], "glasses", "pin: prefix stripped")
        stats = ansi.do_restore(data, self.new)
        self.assertEqual(stats["unmatched_faces"], 0)
        con = sqlite3.connect(self.new)
        pin = con.execute("SELECT description, pinned FROM person_refcrops").fetchone()
        con.close()
        self.assertEqual(pin, ("glasses", 1))

    def test_restore_refuses_wrong_schema(self):
        con = sqlite3.connect(self.new)
        con.execute("UPDATE schema_version SET version = '1.4'")
        con.commit()
        con.close()
        with self.assertRaises(SystemExit):
            ansi.do_restore(ansi.do_export(self.old), self.new)

    def test_unmatched_face_is_reported_not_dropped(self):
        data = ansi.do_export(self.old)
        data["faces"].append({"hash": "b" * 64, "x": 0, "y": 0, "w": 10, "h": 10,
                              "person": None, "link_status": "confirmed",
                              "description": None, "seq": 1})
        stats = ansi.do_restore(data, self.new)
        self.assertEqual(stats["unmatched_faces"], 1)
        self.assertEqual(stats["faces"], 4)

    def test_json_roundtrip_is_stable(self):
        data = ansi.do_export(self.old)
        again = json.loads(json.dumps(data))
        self.assertEqual(data, again)

    def test_restore_housekeeping_primary_refcrops_shells(self):
        """#37 — restore writes faces directly, so it must also do the
        derived-state maintenance: machine primary, auto refcrops, and
        deletion of the UnknownN shells the moves emptied."""
        data = {
            "format": 1, "source_schema": "1.6", "exported_at": NOW,
            "persons": [{"name": "Bob", "state": "created", "note": None,
                         "groups": ["family|test"],
                         "primary": None, "primary_pinned": 0}],
            # take face 1 (conf .90) from Unknown1 and face 4 (conf .60)
            # from Unknown2 — the latter move empties Unknown2
            "faces": [
                {"hash": HASH, "x": 10, "y": 10, "w": 20, "h": 20,
                 "person": "Bob", "link_status": "confirmed", "description": None,
                 "seq": 1},
                {"hash": HASH, "x": 5, "y": 60, "w": 20, "h": 20,
                 "person": "Bob", "link_status": "confirmed", "description": None,
                 "seq": 2},
            ],
            "pins": [], "skipped_unknown_pins": 0,
        }
        stats = ansi.do_restore(data, self.new)
        self.assertEqual(stats["unmatched_faces"], 0)
        self.assertEqual(stats["shells_deleted"], 1, "emptied Unknown2 shell")
        con = sqlite3.connect(self.new)
        self.assertIsNone(con.execute(
            "SELECT id FROM persons WHERE name LIKE 'Unknown%' "
            "AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.person_id = persons.id)"
        ).fetchone(), "no faceless UnknownN shell may remain")
        bob = con.execute("SELECT id FROM persons WHERE name = 'Bob'").fetchone()
        self.assertIsNotNone(bob)
        prim = con.execute(
            "SELECT primary_face_id, primary_pinned FROM persons WHERE id = ?",
            (bob[0],)).fetchone()
        self.assertEqual(prim, (1, 0), "machine primary = highest-confidence face")
        rc = con.execute(
            "SELECT face_id, description, seq, pinned, filename FROM person_refcrops "
            "WHERE person_id = ? ORDER BY seq", (bob[0],)).fetchall()
        self.assertEqual(len(rc), 1, "only the non-primary confirmed face qualifies")
        self.assertEqual(rc[0][0], 4, "face 4 is Bob's non-primary confirmed face")
        self.assertEqual(rc[0][1], "")
        self.assertEqual(rc[0][2], 1)
        self.assertEqual(rc[0][3], 0)
        self.assertEqual(rc[0][4], "Bob-2-1.jpg", "<face name>-<seq>.jpg like db.rs")
        self.assertIsNotNone(con.execute(
            "SELECT id FROM persons WHERE name = 'Unknown1'").fetchone(),
            "Unknown1 keeps its remaining faces and survives")
        con.close()


if __name__ == "__main__":
    unittest.main()
