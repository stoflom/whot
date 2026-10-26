"""Unit tests for the pure parts of scripts/import_roll.py.

Run: python3 -m unittest discover -s test
No insightface/cv2/rawpy needed: load_env, numbering, assign_seq,
assign_missing_primaries, associate, the schema gate, the #89 decode
normalisation and fallback chain (fake cv2/rawpy modules) and the #90
database helpers are exercised. Tests needing the *real* decoders
(cv2/Pillow/tifffile) skip themselves when those are absent — CI
installs numpy only.
"""
from __future__ import annotations

import importlib.util
import io
import os
import sqlite3
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
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
        with self.assertRaises(SystemExit) as cm:   # empty table: its own
            ir.check_schema(self._con(None), Path(":memory:"))  # message (#90)
        self.assertIn("empty schema_version table", str(cm.exception.code))
        self.assertNotIn("does not match", str(cm.exception.code))

    def test_messages_point_at_create_db(self):     # #90
        with self.assertRaises(SystemExit) as cm:
            ir.check_schema(self._con("1.4"), Path("data/faces.db"))
        msg = str(cm.exception.code)
        self.assertIn("schema v1.4 does not match", msg)
        self.assertIn("--create-db", msg)


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


# ---------------------------------------------------------------- CLI contract (#90/#91)

class ParserTest(unittest.TestCase):
    def test_cpu_provider_is_the_default(self):          # #91
        args = ir.build_parser().parse_args(["/tmp/roll"])
        self.assertFalse(args.gpu)
        self.assertFalse(args.cpu)

    def test_gpu_is_opt_in(self):
        self.assertTrue(ir.build_parser().parse_args(["/tmp/roll", "--gpu"]).gpu)

    def test_cpu_flag_is_a_deprecated_no_op(self):       # old invocations keep working
        args = ir.build_parser().parse_args(["/tmp/roll", "--cpu"])
        self.assertFalse(args.gpu)                       # never switches the GPU on

    def test_roll_dir_is_optional_with_create_db(self):  # #90
        args = ir.build_parser().parse_args(["--create-db"])
        self.assertTrue(args.create_db)
        self.assertIsNone(args.roll_dir)


class ValidateArgsTest(unittest.TestCase):
    def test_create_db_with_dry_run_refused(self):
        ap = ir.build_parser()
        args = ap.parse_args(["--create-db", "--dry-run"])
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            ir.validate_args(ap, args)

    def test_roll_dir_required_unless_create_db(self):
        ap = ir.build_parser()
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            ir.validate_args(ap, ap.parse_args([]))
        ir.validate_args(ap, ap.parse_args(["--create-db"]))    # no raise

    def test_ordinary_import_passes(self):
        ap = ir.build_parser()
        ir.validate_args(ap, ap.parse_args(["/tmp/roll"]))       # no raise


# ---------------------------------------------------------------- decode (#89)

def _has(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


class ToUint8Test(unittest.TestCase):
    """§4.29 sample normalisation — pure numpy, runs everywhere."""

    def test_uint8_passes_through(self):
        a = np.array([[1, 2]], np.uint8)
        self.assertIs(ir._to_uint8(a), a)

    def test_uint16_scales_over_dtype_range(self):        # ÷257
        out = ir._to_uint8(np.array([[0, 65535, 32768]], np.uint16))
        np.testing.assert_array_equal(out, [[0, 255, 128]])

    def test_linear_float_is_gamma_encoded_to_srgb(self):
        out = ir._to_uint8(np.array([[0.0, 0.5, 1.0]], np.float32))
        np.testing.assert_array_equal(out, [[0, 188, 255]])

    def test_8bit_range_float_kept_nan_becomes_zero(self):
        out = ir._to_uint8(np.array([[10.4, 200.6, np.nan]], np.float32))
        np.testing.assert_array_equal(out, [[10, 201, 0]])

    def test_negative_and_infinite_values_clamped(self):
        out = ir._to_uint8(np.array([[-0.2, np.inf]], np.float32))
        np.testing.assert_array_equal(out, [[0, 255]])


class ApplyOrientationTest(unittest.TestCase):
    """EXIF orientation mapping used by the tifffile path (§4.29)."""

    SRC = np.arange(6, dtype=np.uint8).reshape(2, 3, 1)   # [[0 1 2] [3 4 5]]

    def _ch(self, orientation: int) -> np.ndarray:
        return ir._apply_orientation(self.SRC, orientation)[:, :, 0]

    def test_orientation_1_is_identity(self):
        np.testing.assert_array_equal(self._ch(1), [[0, 1, 2], [3, 4, 5]])

    def test_orientation_6_rotates_90_clockwise(self):
        np.testing.assert_array_equal(self._ch(6), [[3, 0], [4, 1], [5, 2]])

    def test_orientation_8_rotates_90_counter_clockwise(self):
        np.testing.assert_array_equal(self._ch(8), [[2, 5], [1, 4], [0, 3]])


class _FakeThumbError(Exception):     # mimics rawpy.LibRawUnsupportedThumbnailError
    pass


def _fake_cv2():                      # imread finds nothing → fallbacks run
    mod = types.ModuleType("cv2")
    mod.IMREAD_COLOR = 1
    mod.COLOR_RGB2BGR = 4
    mod.imread = lambda *a, **k: None
    mod.imdecode = lambda buf, flag: np.zeros((4, 6, 3), np.uint8)
    mod.cvtColor = lambda img, code: np.ascontiguousarray(img[:, :, ::-1])
    return mod


def _fake_rawpy(thumb_raises: bool):
    mod = types.ModuleType("rawpy")
    mod.ThumbFormat = types.SimpleNamespace(JPEG="JPEG")
    mod.LibRawError = _FakeThumbError

    class _Raw:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def extract_thumb(self):
            if thumb_raises:
                raise _FakeThumbError(b"Unsupported thumbnail format")
            return types.SimpleNamespace(format=mod.ThumbFormat.JPEG, data=b"jpg")

        def postprocess(self, **kw):
            return np.full((3, 5, 3), 7, np.uint8)   # marker: full decode

    mod.imread = lambda path: _Raw()
    return mod


class DecodeFallbackTest(unittest.TestCase):
    """#89: any rawpy thumbnail error falls through to postprocess(), an
    unreadable file fails alone. Fake cv2/rawpy — no native deps needed."""

    def setUp(self):
        self._saved = {n: sys.modules.get(n) for n in ("cv2", "rawpy")}
        sys.modules["cv2"] = _fake_cv2()
        self.tmp = tempfile.TemporaryDirectory()
        self.raw = Path(self.tmp.name) / "shot.PEF"
        self.raw.write_bytes(b"\x00")
        self.bad = Path(self.tmp.name) / "notimage.jpg"
        self.bad.write_bytes(b"no decoder in the chain can read this bytes blob")

    def tearDown(self):
        for name, prev in self._saved.items():
            if prev is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prev
        self.tmp.cleanup()

    def test_unsupported_thumbnail_falls_through_to_postprocess(self):
        sys.modules["rawpy"] = _fake_rawpy(thumb_raises=True)
        img = ir._decode(self.raw)
        self.assertEqual(img.shape, (3, 5, 3))
        self.assertEqual(int(img.max()), 7)          # marker → postprocess won

    def test_jpeg_thumbnail_is_used_when_available(self):
        sys.modules["rawpy"] = _fake_rawpy(thumb_raises=False)
        img = ir._decode(self.raw)
        self.assertEqual(img.shape, (4, 6, 3))
        self.assertEqual(int(img.max()), 0)          # zeros → thumb won

    def test_undecodable_file_raises_cannot_decode(self):
        sys.modules["rawpy"] = _fake_rawpy(thumb_raises=True)
        with self.assertRaises(ValueError) as cm:
            ir._decode(self.bad)
        self.assertIn("cannot decode", str(cm.exception))


@unittest.skipUnless(all(_has(m) for m in ("cv2", "PIL", "tifffile")),
                     "needs the real decoders (cv2, Pillow, tifffile)")
class RealDecoderFallbackTest(unittest.TestCase):
    """Synthetic twins of the files that failed in the full #89 import."""

    def test_tiff_with_exif_orientation_decodes_via_pillow(self):
        # OpenCV refuses any TIFF carrying an Orientation tag (#89)
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "orient6.tif"
            im = Image.fromarray(np.full((4, 8, 3), 60, np.uint8))
            exif = im.getexif()
            exif[274] = 6
            im.save(p, exif=exif)
            img = ir._decode(p)
        self.assertEqual(img.dtype, np.uint8)
        self.assertEqual(img.shape[:2], (8, 4))      # stored 4×8 → EXIF 6 ⇒ 8×4

    def test_float32_tiff_decodes_via_tifffile(self):
        # 32-bit linear-float export: cv2 "can not handle 32-bit samples",
        # Pillow cannot identify it — tifffile + gamma encode must win
        import tifffile
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "linear.tif"
            src = np.full((6, 5, 3), 0.25, np.float32)
            src[2, 2, 0] = 0.5
            tifffile.imwrite(p, src)
            img = ir._decode(p)
        self.assertEqual(img.dtype, np.uint8)
        self.assertEqual(img.shape, (6, 5, 3))
        self.assertEqual(int(img[2, 2, 2]), 188)     # linear 0.5 → sRGB 188
        self.assertEqual(int(img[2, 2, 0]), 137)     # linear 0.25 → sRGB 137
        self.assertEqual(int(img[0, 0, 0]), 137)


# ---------------------------------------------------------------- database (#90)

class MissingDbMessageTest(unittest.TestCase):
    def test_missing_file_reports_not_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            msg = ir.missing_db_message(Path(tmp) / "faces.db")
        self.assertIsNotNone(msg)
        self.assertIn("database not found", msg)
        self.assertIn("--create-db", msg)

    def test_existing_file_has_no_message(self):
        with tempfile.NamedTemporaryFile() as fh:
            self.assertIsNone(ir.missing_db_message(Path(fh.name)))


class CreateDatabaseTest(unittest.TestCase):
    """--create-db: built from schema.sql, refuses a real database, replaces
    the stray 0-byte file sqlite3.connect() leaves behind (#90)."""

    def _ui(self):
        return ir.cli_console.Console(quiet=True)

    def test_creates_parents_and_schema_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "nested" / "faces.db"
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertTrue(ir.create_database(db, self._ui()))
            self.assertIn(f"WhoT schema v{ir.SCHEMA_VERSION}", out.getvalue())
            con = sqlite3.connect(db)
            row = con.execute("SELECT version FROM schema_version").fetchone()
            con.close()
            self.assertEqual(row[0], ir.SCHEMA_VERSION)

    def test_existing_database_is_kept_and_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "faces.db"
            db.write_bytes(b"existing content")
            err, out = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                kept = ir.create_database(db, self._ui())
            self.assertFalse(kept)
            self.assertIn("already exists", err.getvalue())
            self.assertIn("nothing to do", out.getvalue())
            self.assertEqual(db.read_bytes(), b"existing content")

    def test_zero_byte_leftover_is_replaced(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "faces.db"
            db.write_bytes(b"")                    # the #90 artifact
            with redirect_stdout(io.StringIO()):
                self.assertTrue(ir.create_database(db, self._ui()))
            self.assertGreater(db.stat().st_size, 0)


class EnsurePersonTest(unittest.TestCase):
    """ensure_person inserts a fresh UnknownN only — #153: no group row is
    seeded, so new persons start Ungrouped (the virtual Unknown branch is
    name-driven; grouping an UnknownN is the user's act)."""

    def _con(self) -> tuple[sqlite3.Connection, tempfile.TemporaryDirectory]:
        """A real: file DB built from database/schema.sql via --create-db."""
        tmp = tempfile.TemporaryDirectory()
        db = Path(tmp.name) / "faces.db"
        with redirect_stdout(io.StringIO()):
            self.assertTrue(ir.create_database(db, ir.cli_console.Console(quiet=True)))
        return sqlite3.connect(db), tmp

    def test_new_unknownn_gets_no_person_groups_row(self):
        con, tmp = self._con()
        try:
            stub = ir.PersonStub(0, "Unknown1", False)
            fresh: list[ir.PersonStub] = []
            pid = ir.ensure_person(con, stub, fresh)
            self.assertEqual(stub.person_id, pid)
            self.assertEqual([s.person_id for s in fresh], [pid])
            self.assertEqual(
                con.execute(
                    "SELECT COUNT(*) FROM person_groups WHERE person_id = ?", (pid,)
                ).fetchone()[0],
                0,
            )
            self.assertEqual(
                con.execute("SELECT name FROM persons WHERE id = ?", (pid,)).fetchone()[0],
                "Unknown1",
            )
        finally:
            con.close()
            tmp.cleanup()

    def test_matched_person_is_returned_untouched(self):
        con, tmp = self._con()
        try:
            stub = ir.PersonStub(7, "Mary", True)
            fresh: list[ir.PersonStub] = []
            self.assertEqual(ir.ensure_person(con, stub, fresh), 7)
            self.assertEqual(fresh, [])
        finally:
            con.close()
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
