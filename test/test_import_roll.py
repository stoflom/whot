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
        self.assertEqual(ir.assign_seq(con, 1), 4)   # COUNT+1 would yield 3 → collision

    def test_counts_only_matching_description(self):
        con = sqlite3.connect(":memory:")
        con.execute(SEQ_DDL)
        con.execute("INSERT INTO faces VALUES (1,1,'beard',1)")
        self.assertEqual(ir.assign_seq(con, 1), 1)   # no desc=''-row yet


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
