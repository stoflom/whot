"""Unit tests for the pure parts of scripts/import_roll.py.

Run: python3 -m unittest discover -s test
No insightface/cv2 needed: only load_env, numbering, assign_seq,
assign_missing_primaries and associate are exercised.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import import_roll as ir  # noqa: E402


# ---------------------------------------------------------------- helpers

def vec(*components: float) -> np.ndarray:
    """L2-normalised float32 test vector."""
    v = np.asarray(components, dtype=np.float32)
    return v / np.linalg.norm(v)


def det(embedding: np.ndarray, score: float = 0.9) -> ir.Detection:
    return ir.Detection(box=(0, 0, 10, 10), det_score=score, embedding=embedding)


def write_env(text: str) -> Path:
    fd, name = tempfile.mkstemp(suffix=".env")
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    return Path(name)


# ---------------------------------------------------------------- load_env

class LoadEnvTest(unittest.TestCase):
    def test_quotes_comments_and_nested_refs(self):
        p = write_env(
            "# comment\n"
            "A=one\n"
            "B=\"${A}/two\"\n"
            "C='${B}/three'\n"
            "  D = spaced  \n"
            "not-a-assignment\n"
        )
        try:
            env = ir.load_env(p)
        finally:
            p.unlink()
        self.assertEqual(env["A"], "one")
        self.assertEqual(env["B"], "one/two")
        self.assertEqual(env["C"], "one/two/three")
        self.assertEqual(env["D"], "spaced")

    def test_process_env_fallback(self):           # F15 / #15
        os.environ["WHOT_TEST_PROC_VAR"] = "procval"
        p = write_env("X=${WHOT_TEST_PROC_VAR}/pics\nY=${WHOT_UNDEFINED_42}/x\n")
        try:
            env = ir.load_env(p)
        finally:
            p.unlink()
            del os.environ["WHOT_TEST_PROC_VAR"]
        self.assertEqual(env["X"], "procval/pics")
        self.assertEqual(env["Y"], "${WHOT_UNDEFINED_42}/x")  # stays literal


# ---------------------------------------------------------------- numbering

class UnknownNumberingTest(unittest.TestCase):
    def test_next_number_over_mixed_names(self):
        names = ["Unknown1", "Unknown3", "Unknownish", "Alice"]
        self.assertEqual(ir._next_unknown_number_for(names), 4)

    def test_non_numeric_ignored(self):            # #46
        self.assertEqual(ir._next_unknown_number_for(["Unknown", "unknownX"]), 1)

    def test_empty(self):
        self.assertEqual(ir._next_unknown_number_for([]), 1)


# ---------------------------------------------------------------- seq / primary

SEQ_DDL = "CREATE TABLE faces (id INTEGER PRIMARY KEY, person_id INT, description TEXT, seq INT)"


class AssignSeqTest(unittest.TestCase):
    def test_max_based_seq_is_gap_proof(self):     # F5 / #5
        con = sqlite3.connect(":memory:")
        con.execute(SEQ_DDL)
        # Alice keeps seqs {1,3} after the GUI moved face seq 2 away
        con.execute("INSERT INTO faces VALUES (1,1,NULL,1)")
        con.execute("INSERT INTO faces VALUES (3,1,NULL,3)")
        self.assertEqual(ir.assign_seq(con, 1, ""), 4)   # COUNT+1 would yield 3 → collision

    def test_scoped_to_its_appearance_group(self):  # §4.12 / S2
        con = sqlite3.connect(":memory:")
        con.execute(SEQ_DDL)
        con.execute("INSERT INTO faces VALUES (1,1,'beard',1)")
        self.assertEqual(ir.assign_seq(con, 1, ""), 1)   # no desc-group row yet
        self.assertEqual(ir.assign_seq(con, 1, "beard"), 2)
        self.assertEqual(ir.assign_seq(con, 2, "beard"), 1)  # other person unaffected


PRIMARY_DDL = """
CREATE TABLE persons (id INTEGER PRIMARY KEY, name TEXT, primary_face_id INTEGER, primary_pinned INT DEFAULT 0);
CREATE TABLE faces (id INTEGER PRIMARY KEY, person_id INT, state TEXT DEFAULT 'detected',
                    link_status TEXT DEFAULT 'confirmed', confidence REAL);
"""


class AssignMissingPrimariesTest(unittest.TestCase):
    def _db(self) -> sqlite3.Connection:
        con = sqlite3.connect(":memory:")
        con.executescript(PRIMARY_DDL)
        return con

    def test_prefers_highest_confidence(self):
        con = self._db()
        con.execute("INSERT INTO persons VALUES (1,'Alice',NULL,0)")
        con.execute("INSERT INTO faces VALUES (10,1,'detected','confirmed',0.8)")
        con.execute("INSERT INTO faces VALUES (11,1,'detected','confirmed',0.9)")
        ir.assign_missing_primaries(con)
        self.assertEqual(con.execute("SELECT primary_face_id FROM persons").fetchone()[0], 11)

    def test_skips_rejected_faces(self):           # F3 / #3
        con = self._db()
        con.execute("INSERT INTO persons VALUES (1,'Alice',NULL,0)")
        con.execute("INSERT INTO faces VALUES (10,1,'detected','rejected',0.95)")
        con.execute("INSERT INTO faces VALUES (11,1,'detected','confirmed',0.7)")
        ir.assign_missing_primaries(con)
        self.assertEqual(con.execute("SELECT primary_face_id FROM persons").fetchone()[0], 11)

    def test_no_eligible_face_leaves_null(self):
        con = self._db()
        con.execute("INSERT INTO persons VALUES (1,'Alice',NULL,0)")
        con.execute("INSERT INTO faces VALUES (10,1,'detected','rejected',0.95)")
        ir.assign_missing_primaries(con)
        self.assertIsNone(con.execute("SELECT primary_face_id FROM persons").fetchone()[0])


# ---------------------------------------------------------------- associate

class AssociateTest(unittest.TestCase):
    def test_known_person_match_wins(self):
        alice = ir.PersonStub(10, "Alice", True, vectors=[vec(1, 0, 0, 0)])
        pairs = ir.associate([det(vec(1, 0, 0, 0))], [alice], [], 0.4)
        self.assertEqual(pairs[0][1].person_id, 10)
        self.assertEqual(pairs[0][1].name, "Alice")

    def test_match_to_existing_unknown(self):
        unk = ir.PersonStub(7, "Unknown7", False, vectors=[vec(0, 1, 0, 0)])
        pairs = ir.associate([det(vec(0, 1, 0, 0))], [], [unk], 0.4)
        self.assertEqual(pairs[0][1].person_id, 7)

    def test_unmatched_singletons_get_sequential_numbers(self):
        # orthogonal detections → two singleton clusters; numbering continues
        # over existing_names (#45)
        pairs = ir.associate([det(vec(1, 0, 0, 0)), det(vec(0, 1, 0, 0))],
                             [], [], 0.4, existing_names=["Unknown1", "Unknown2"])
        names = [p.name for _, p in pairs]
        self.assertEqual(names, ["Unknown3", "Unknown4"])
        self.assertTrue(all(p.person_id == 0 for _, p in pairs))

    def test_similar_unmatched_share_one_cluster(self):
        pairs = ir.associate([det(vec(1, 0, 0, 0)), det(vec(1, 1, 0, 0))],
                             [], [], 0.4, existing_names=[])
        (d1, s1), (d2, s2) = pairs
        self.assertIs(s1, s2, "similar detections must land in the same cluster")
        self.assertEqual(s1.name, "Unknown1")
        self.assertEqual(len(s1.vectors), 2, "cluster stub collects its members' vectors")

    def test_best_similarity_wins(self):
        # both detections match Alice (0.71 sim) and Bob (1.0 sim): Bob wins
        alice = ir.PersonStub(10, "Alice", True, vectors=[vec(1, 0)])
        bob = ir.PersonStub(11, "Bob", True, vectors=[vec(1, 1)])
        pairs = ir.associate([det(vec(1, 1), score=0.5)], [alice, bob], [], 0.4)
        self.assertEqual(pairs[0][1].name, "Bob")


if __name__ == "__main__":
    unittest.main()


# ---------------------------------------------------------------- schema gate

class SchemaCheckTest(unittest.TestCase):
    def _con(self, version: str | None) -> sqlite3.Connection:
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE schema_version (version TEXT, updated_at TEXT)")
        if version is not None:
            con.execute(
                "INSERT INTO schema_version VALUES (?, datetime('now'))", (version,)
            )
        return con

    def test_matching_version_passes(self):
        ir.check_schema(self._con(ir.SCHEMA_VERSION), Path(":memory:"))  # no raise

    def test_mismatched_version_exits(self):
        with self.assertRaises(SystemExit):
            ir.check_schema(self._con("1.4"), Path(":memory:"))

    def test_missing_marker_exits(self):
        con = sqlite3.connect(":memory:")  # no schema_version table at all
        with self.assertRaises(SystemExit):
            ir.check_schema(con, Path(":memory:"))
        with self.assertRaises(SystemExit):
            ir.check_schema(self._con(None), Path(":memory:"))  # empty table


# ---------------------------------------------------------------- §4.12 inheritance

CORPUS_DDL = """
CREATE TABLE persons (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE faces (id INTEGER PRIMARY KEY, person_id INT, link_status TEXT,
                    description TEXT);
CREATE TABLE face_embeddings (face_id INT, model TEXT, dim INT, vector BLOB,
                              created_at TEXT);
"""


def _seed_corpus(con: sqlite3.Connection) -> None:
    """Alice: face 1 = 'beard' vectors, face 2 = no-description vectors."""
    con.execute("INSERT INTO persons VALUES (1, 'Alice')")
    con.execute("INSERT INTO faces VALUES (1, 1, 'confirmed', 'beard')")
    con.execute("INSERT INTO faces VALUES (2, 1, 'confirmed', NULL)")
    for fid, v in ((1, vec(1.0, 0.0, 0.0, 0.0)), (2, vec(0.0, 1.0, 0.0, 0.0))):
        con.execute(
            "INSERT INTO face_embeddings VALUES (?, ?, 4, ?, ?)",
            (fid, ir.MODEL_TAG, v.astype("<f4").tobytes(), "t"))


class AppearanceCorpusTest(unittest.TestCase):
    def _con(self) -> sqlite3.Connection:
        con = sqlite3.connect(":memory:")
        con.executescript(CORPUS_DDL)
        _seed_corpus(con)
        return con

    def test_corpus_keyed_per_person_and_description(self):
        stubs = ir.load_known_corpus(self._con())
        self.assertEqual(len(stubs), 2, "one stub per (person, appearance)")
        self.assertEqual({s.description for s in stubs}, {"beard", ""})
        self.assertTrue(all(s.person_id == 1 and s.is_known for s in stubs))

    def test_match_inherits_the_winning_group_description(self):
        corpus = ir.load_known_corpus(self._con())
        # detection ≈ beard vector -> beard group; ≈ other vector -> '' group
        got = ir.associate([det(vec(1.0, 0.1, 0.0, 0.0))], corpus, [], 0.4)[0][1]
        self.assertEqual((got.person_id, got.description), (1, "beard"))
        got = ir.associate([det(vec(0.1, 1.0, 0.0, 0.0))], corpus, [], 0.4)[0][1]
        self.assertEqual((got.person_id, got.description), (1, ""))

    def test_store_image_inherits_seq_and_label(self):
        """End-to-end: matched face is inserted with the inherited
        description, the group-scoped seq and the derived label (§4.12)."""
        con = sqlite3.connect(":memory:")
        con.executescript((Path(__file__).resolve().parent.parent
                           / "database" / "schema.sql").read_text())
        con.execute("PRAGMA foreign_keys = ON")
        con.execute("INSERT INTO imports(path, started_at) VALUES ('/tmp/r', 't')")
        # seed Alice + one beard face (seq 1) and one plain face against the real schema
        con.execute("INSERT INTO images(id, content_hash, width, height, primary_path, "
                    "state, created_at) VALUES (1, ?, 100, 100, 'seed.jpg', 'scanned', 't')",
                    ("e" * 64,))
        con.execute("INSERT INTO persons(id, name, state, created_at) "
                    "VALUES (1, 'Alice', 'created', 't')")
        for fid, (x, y), desc_name, seq in [(1, (0, 0), "Alice-beard-1", 1),
                                            (2, (20, 20), "Alice-1", 1)]:
            con.execute(
                "INSERT INTO faces(id, image_id, x, y, w, h, person_id, link_status, "
                "state, origin, description, name, seq, confidence, detected_in_import_id, "
                "created_at) VALUES (?, 1, ?, ?, 10, 10, 1, 'confirmed', 'detected', "
                "'insightface', ?, ?, ?, 0.9, 1, 't')",
                (fid, x, y, "beard" if fid == 1 else None, desc_name, seq))
        for fid, v in ((1, vec(1.0, 0.0, 0.0, 0.0)), (2, vec(0.0, 1.0, 0.0, 0.0))):
            con.execute("INSERT INTO face_embeddings(face_id, model, dim, vector, created_at) "
                        "VALUES (?, ?, 4, ?, 't')",
                        (fid, ir.MODEL_TAG, v.astype("<f4").tobytes()))
        corpus = ir.load_known_corpus(con)
        detection = det(vec(1.0, 0.1, 0.0, 0.0))
        pairs = ir.associate([detection], corpus, [], 0.4)
        plan = ir.ImportPlan(content_hash="f" * 64, path="x.jpg", state="scanned",
                             width=100, height=100, orientation="landscape",
                             type="processed", icon_jpeg=b"i", preview_jpeg=b"p",
                             detections=[detection])
        ir.store_image(con, plan, pairs, [], import_id=1, now="t")
        row = con.execute(
            "SELECT person_id, description, seq, name FROM faces "
            "WHERE detected_in_import_id = 1 ORDER BY id DESC LIMIT 1"
        ).fetchone()
        self.assertEqual(row, (1, "beard", 2, "Alice-beard-2"),
                         "inherited desc, group-scoped seq (beard had seq 1), derived label")
