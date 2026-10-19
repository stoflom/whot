"""Tests for scripts/import_harvested.py (design §9).

Run: python3 -m unittest discover -s test
Builds a fixture faces.db from database/schema.sql and a harvest staging DB
via harvest_legacy (schema v1.1) — no local data, no archive access.
Covers invariants J1-J5: copy-only writes, exact-BLAKE3 image identity,
provisional-only links (unless --overwrite), IoU matching in decode space
(incl. inversion mapping), whole-cluster merges on unanimous evidence,
seq-suffix person collisions, group-root stripping and full housekeeping.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import harvest_legacy as hl        # noqa: E402
import import_harvested as ih      # noqa: E402

SCHEMA = Path(__file__).resolve().parent.parent / "database" / "schema.sql"
NOW = "2026-10-19T00:00:00"
H1 = "a" * 64                      # content hash of image 1
H2 = "b" * 64                      # content hash of image 2 (staging only)


def build_faces_db(path: Path) -> None:
    """faces.db v1.5 fixture: two images, an UnknownN cluster, a known
    person, an unowned face."""
    con = sqlite3.connect(path)
    con.executescript(SCHEMA.read_text())
    con.executescript(f"""
    INSERT INTO images(id, content_hash, width, height, primary_path, state,
                       orientation, created_at)
      VALUES (1, '{H1}', 100, 100, 'a.jpg', 'scanned', 'landscape', '{NOW}');
    INSERT INTO images(id, content_hash, width, height, primary_path, state,
                       orientation, created_at)
      VALUES (2, '{H2}', 200, 200, 'b.jpg', 'scanned', 'landscape', '{NOW}');
    INSERT INTO persons(id, name, state, created_at)
      VALUES (7, 'Unknown7', 'created', '{NOW}');
    INSERT INTO person_groups(person_id, path) VALUES (7, 'Unknown');
    INSERT INTO persons(id, name, state, created_at)
      VALUES (9, 'Mary', 'created', '{NOW}');
    -- Unknown7 cluster on image 1 (decode space == file space)
    INSERT INTO faces(id, image_id, x, y, w, h, person_id, link_status, state,
                      origin, name, seq, confidence, created_at)
      VALUES (1, 1, 10, 10, 20, 20, 7, 'provisional', 'detected',
              'insightface', 'Unknown7-1', 1, 0.9, '{NOW}');
    INSERT INTO faces(id, image_id, x, y, w, h, person_id, link_status, state,
                      origin, name, seq, confidence, created_at)
      VALUES (2, 1, 50, 50, 20, 20, 7, 'provisional', 'detected',
              'insightface', 'Unknown7-2', 2, 0.9, '{NOW}');
    INSERT INTO faces(id, image_id, x, y, w, h, person_id, link_status, state,
                      origin, name, seq, confidence, created_at)
      VALUES (3, 1, 80, 10, 20, 20, 7, 'provisional', 'detected',
              'insightface', 'Unknown7-3', 3, 0.9, '{NOW}');
    -- Mary's confirmed face on image 2
    INSERT INTO faces(id, image_id, x, y, w, h, person_id, link_status, state,
                      origin, name, seq, confidence, created_at)
      VALUES (4, 2, 20, 20, 40, 40, 9, 'confirmed', 'imported',
              'insightface', 'Mary-1', 1, 0.8, '{NOW}');
    -- unowned (user removed the person) face on image 2
    INSERT INTO faces(id, image_id, x, y, w, h, person_id, link_status, state,
                      origin, name, seq, confidence, created_at)
      VALUES (5, 2, 120, 120, 30, 30, NULL, 'provisional', 'detected',
              'insightface', 'x-1', 1, 0.7, '{NOW}');
    """)
    con.commit()
    con.close()


class Fixture(unittest.TestCase):
    """faces.db + staging DB pair in a temp dir."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.faces_db = self.base / "faces.db"
        build_faces_db(self.faces_db)
        self.staging = self.base / "staging.db"
        self.con = hl.create_staging(self.staging)
        self.run_id = hl.start_run(self.con, list(hl.ALL_SOURCES), {})
        self.st = hl.Staging(self.con, self.run_id)
        self.sid = hl.ensure_sources(self.con, ["sidecars-mwgrs"])["sidecars-mwgrs"]

    def tearDown(self) -> None:
        self.con.close()

    def s_image(self, hash_: str | None, w: int | None = 100,
                h: int | None = 100, path: str | None = None) -> int:
        if path is None:
            # distinct path per hash: images are keyed by path first, and
            # two staging images must not collide on one path in a test
            path = f"/arc/{(hash_ or 'nohash')[:6]}.jpg"
        return self.st.image(source_id=self.sid, path=path,
                             path_origin="source", content_hash=hash_,
                             width=w, height=h)

    def s_face(self, image_id: int, person: str, x, y, w, h,
               unit: str = "pixels", img_w=None, img_h=None,
               groups: tuple[str, ...] = ()) -> int:
        pid = self.st.person(person)
        for g in groups:
            self.st.group(pid, g, self.sid)
        iid = image_id
        return pid, self.st.face(image_id=iid, pid=pid, x=x, y=y, w=w, h=h,
                                 unit=unit, img_w=img_w, img_h=img_h,
                                 source_id=self.sid)

    def run_plan(self, min_overlap=0.60, overwrite=False):
        """Plan + execute against the fixture faces.db itself (temp file)."""
        rep = ih.Report()
        stcon = ih.open_ro(self.staging)
        try:
            dbcon = sqlite3.connect(self.faces_db)
            dbcon.row_factory = sqlite3.Row
            try:
                plan = ih.plan_import(stcon, dbcon, min_overlap, overwrite, rep)
                ih.execute_plan(dbcon, plan, rep)
            finally:
                dbcon.close()
        finally:
            stcon.close()
        self.con.commit()
        return rep

    def q(self, sql: str, *args):
        con = sqlite3.connect(self.faces_db)
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(sql, args)]
        finally:
            con.close()


# ------------------------------------------------------------- pure functions

class GeometryTests(unittest.TestCase):
    def test_iou(self):
        self.assertEqual(ih.iou((0, 0, 10, 10), (0, 0, 10, 10)), 1.0)
        self.assertEqual(ih.iou((0, 0, 10, 10), (20, 20, 5, 5)), 0.0)
        self.assertAlmostEqual(ih.iou((0, 0, 10, 10), (5, 0, 10, 10)),
                               50 / 150)

    def test_convert_normalized(self):
        self.assertEqual(
            ih.convert_box(0.1, 0.2, 0.5, 0.5, "normalized", 4000, 3000,
                           4000, 3000),
            (400.0, 600.0, 2000.0, 1500.0))

    def test_convert_normalized_falls_back_to_db_dims(self):
        self.assertEqual(
            ih.convert_box(0.5, 0.5, 0.5, 0.5, "normalized", None, None,
                           100, 200),
            (50.0, 100.0, 50.0, 100.0))

    def test_convert_pixels_inversion(self):
        box = (10, 20, 30, 40)
        self.assertEqual(ih.convert_box(*box, "pixels", None, None, 100, 100),
                         (10, 20, 30, 40))          # inversion none
        self.assertEqual(ih.convert_box(*box, "pixels", None, None, 100, 100,
                                        "lr"),
                         (60, 20, 30, 40))          # x' = W - (x + w)
        self.assertEqual(ih.convert_box(*box, "pixels", None, None, 100, 100,
                                        "tb"),
                         (10, 40, 30, 40))          # y' = H - (y + h)
        self.assertEqual(ih.convert_box(*box, "pixels", None, None, 100, 100,
                                        "both"),
                         (60, 40, 30, 40))

    def test_convert_degenerate(self):
        self.assertIsNone(ih.convert_box(0, 0, 0, 10, "pixels", None, None,
                                         100, 100))
        self.assertIsNone(ih.convert_box(0, 0, 1, 1, "degrees", None, None,
                                         100, 100))

    def test_strip_group_root(self):
        self.assertEqual(ih.strip_group_root("People|Family|X"), "Family|X")
        self.assertEqual(ih.strip_group_root("Person|X"), "X")
        self.assertEqual(ih.strip_group_root("people|X"), "X")
        self.assertEqual(ih.strip_group_root("Family|X"), "Family|X")
        self.assertIsNone(ih.strip_group_root("People"))

    def test_next_free_name(self):
        self.assertEqual(ih.next_free_name(set(), "Winnie"), "Winnie")
        self.assertEqual(ih.next_free_name({"Winnie"}, "Winnie"), "Winnie 2")
        self.assertEqual(ih.next_free_name({"Winnie", "Winnie 2"}, "Winnie"),
                         "Winnie 3")


# -------------------------------------------------------- lifecycle & copies

class LifecycleTests(Fixture):
    def test_refuses_wrong_staging_version(self):
        con = sqlite3.connect(self.staging)
        con.execute("UPDATE schema_version SET version='1.0'")
        con.commit()
        con.close()
        with self.assertRaises(SystemExit):
            ih.plan_import  # sanity: function exists
            ih.main([str(self.staging), "--faces-db", str(self.faces_db),
                     "--dry-run"])

    def test_target_copy_and_original_untouched(self):
        """J1: the source db is byte-identical after a real run."""
        before = self.faces_db.read_bytes()
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)
        self.con.commit()
        rc = ih.main([str(self.staging), "--faces-db", str(self.faces_db)])
        self.assertEqual(rc, 0)
        self.assertEqual(self.faces_db.read_bytes(), before)   # untouched
        copies = sorted(self.base.glob("faces-*.db"))
        self.assertEqual(len(copies), 1)
        self.assertRegex(copies[0].name, r"faces-\d{8}-\d{6}\.db")
        # the copy has the moved face
        con = sqlite3.connect(copies[0])
        name = con.execute("SELECT name FROM persons WHERE state='imported'"
                           ).fetchone()[0]
        con.close()
        self.assertEqual(name, "Winnie Pelser")

    def test_report_files_written(self):
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)
        self.con.commit()
        ih.main([str(self.staging), "--faces-db", str(self.faces_db)])
        jpath = sorted(self.base.glob("faces-*.import.json"))[0]
        data = json.loads(jpath.read_text())
        self.assertEqual(data["counters"]["matched"], 1)
        log = sorted(self.base.glob("faces-*.import.log"))[0].read_text()
        self.assertIn("matched=1", log)

    def test_dry_run_writes_nothing(self):
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)
        self.con.commit()
        before = self.faces_db.read_bytes()
        ih.main([str(self.staging), "--faces-db", str(self.faces_db),
                 "--dry-run"])
        self.assertEqual(self.faces_db.read_bytes(), before)
        self.assertEqual(list(self.base.glob("faces-*.db")), [])


# ---------------------------------------------------------------- scenarios

class ScenarioTests(Fixture):
    def test_cluster_merge_unanimous(self):
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20,
                    groups=("People|Family|Winnie Pelser",))
        self.s_face(img, "Winnie Pelser", 50, 50, 20, 20)
        self.s_face(img, "Winnie Pelser", 80, 10, 20, 20)
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters["matched"], 3)
        self.assertEqual(rep.counters["faces_moved"], 3)
        self.assertEqual(rep.counters["clusters_merged"], 1)
        # Unknown7 is gone; the faces belong to the imported person
        rows = self.q("SELECT f.id, f.name, f.seq, f.link_status, p.name pname"
                      " FROM faces f JOIN persons p ON p.id=f.person_id"
                      " WHERE f.image_id=1 ORDER BY f.id")
        self.assertTrue(all(r["pname"] == "Winnie Pelser" for r in rows))
        self.assertTrue(all(r["link_status"] == "provisional" for r in rows))
        self.assertEqual([r["seq"] for r in rows], [1, 2, 3])
        self.assertEqual(rows[0]["name"], "Winnie Pelser-1")
        self.assertEqual(self.q("SELECT * FROM persons WHERE name='Unknown7'"),
                         [])
        groups = self.q("SELECT path FROM person_groups pg"
                        " JOIN persons p ON p.id=pg.person_id"
                        " WHERE p.name='Winnie Pelser'")
        self.assertEqual([g["path"] for g in groups],
                         ["Family|Winnie Pelser"])       # root stripped

    def test_cluster_merges_unmatched_faces_too(self):
        """§9.5: as if the user assigned the whole group — an unmatched
        cluster face moves along."""
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)
        self.s_face(img, "Winnie Pelser", 50, 50, 20, 20)
        self.con.commit()
        self.run_plan()
        rows = self.q("SELECT p.name FROM faces f"
                      " JOIN persons p ON p.id=f.person_id"
                      " WHERE f.image_id=1")
        self.assertEqual({r["name"] for r in rows}, {"Winnie Pelser"})
        self.assertEqual(len(rows), 3)                  # f3 came along

    def test_below_threshold_logged(self):
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 0, 0, 5, 5)   # IoU ~0.04 vs f1
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters.get("matched", 0), 0)
        self.assertEqual(rep.counters["below-threshold"], 1)
        self.assertEqual(self.q("SELECT * FROM persons WHERE state='imported'"),
                         [])
        self.assertEqual(self.q("SELECT person_id FROM faces WHERE id=1")[0]
                         ["person_id"], 7)

    def test_hash_mismatch_and_missing(self):
        img = self.s_image("f" * 64)                    # not in faces.db
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)
        img2 = self.s_image(None, path="/arc/missing.jpg")   # never hashed
        self.s_face(img2, "Koos Kat", 10, 10, 20, 20)
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters["image-not-in-db"], 1)
        self.assertEqual(rep.counters["hash-missing"], 1)
        self.assertEqual(rep.counters.get("matched", 0), 0)

    def test_status_protected_then_overwrite(self):
        img = self.s_image(H2, w=200, h=200)
        self.s_face(img, "Winnie Pelser", 20, 20, 40, 40)   # matches Mary f4
        self.con.commit()
        rep = self.run_plan()                              # default: protected
        self.assertEqual(rep.counters["status-protected"], 1)
        self.assertEqual(self.q("SELECT person_id FROM faces WHERE id=4")[0]
                         ["person_id"], 9)
        rep = self.run_plan(overwrite=True)                # J4: overwrite
        self.assertEqual(rep.counters["faces_moved"], 1)
        row = self.q("SELECT f.person_id, f.link_status, p.name FROM faces f"
                     " JOIN persons p ON p.id=f.person_id WHERE f.id=4")[0]
        self.assertEqual(row["name"], "Winnie Pelser")     # J5: provisional again
        self.assertEqual(row["link_status"], "provisional")

    def test_cluster_disagreement_leaves_unknown(self):
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)
        self.s_face(img, "Koos Kat", 50, 50, 20, 20)      # different person
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters["cluster-disagreement"], 1)
        self.assertEqual(rep.counters.get("faces_moved", 0), 0)
        # nothing moved, no persons created (counters live in execution)
        self.assertEqual(rep.counters.get("persons_created", 0), 0)
        rows = self.q("SELECT person_id FROM faces WHERE id IN (1,2)")
        self.assertTrue(all(r["person_id"] == 7 for r in rows))
        self.assertEqual(self.q("SELECT * FROM persons WHERE name"
                                " IN ('Winnie Pelser','Koos Kat')"), [])

    def test_name_collision_and_group_exact_reuse(self):
        # exact (name, group) match -> reuse 'Mary' (no groups)
        img = self.s_image(H1)
        self.s_face(img, "Mary", 10, 10, 20, 20)
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters["persons_reused"], 1)
        self.assertEqual(rep.counters.get("persons_created", 0), 0)
        row = self.q("SELECT p.name FROM faces f JOIN persons p"
                     " ON p.id=f.person_id WHERE f.id=1")[0]
        self.assertEqual(row["name"], "Mary")
        self.assertEqual(self.q("SELECT * FROM persons WHERE name='Mary'").__len__(),
                         1)                                # no duplicate

        # name collides but groups differ -> new person with seq suffix
        self.st.group(self.st.person("Mary"), "Family|Mary", self.sid)
        self.s_face(img, "Mary", 50, 50, 20, 20)
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters["seq_renamed"], 1)
        names = {p["name"] for p in self.q(
            "SELECT name FROM persons WHERE name LIKE 'Mary%'")}
        self.assertEqual(names, {"Mary", "Mary 2"})
        g = self.q("SELECT path FROM person_groups pg JOIN persons p"
                   " ON p.id=pg.person_id WHERE p.name='Mary 2'")
        self.assertEqual([x["path"] for x in g], ["Family|Mary"])

    def test_known_person_emptied_not_deleted(self):
        img = self.s_image(H2, w=200, h=200)
        self.s_face(img, "Winnie Pelser", 20, 20, 40, 40)  # matches Mary f4
        self.con.commit()
        rep = self.run_plan(overwrite=True)
        self.assertEqual(rep.counters["faces_moved"], 1)
        self.assertEqual(len(self.q("SELECT * FROM persons WHERE name='Mary'")),
                         1)                                # never deleted
        row = self.q("SELECT p.name FROM faces f JOIN persons p"
                     " ON p.id=f.person_id WHERE f.id=4")[0]
        self.assertEqual(row["name"], "Winnie Pelser")

    def test_housekeeping_primary_and_refcrop(self):
        # f1 is Unknown7's primary and a pinned refcrop; f4 is Mary's primary
        con = sqlite3.connect(self.faces_db)
        con.execute("UPDATE persons SET primary_face_id=1, primary_pinned=1"
                    " WHERE id=7")
        con.execute("INSERT INTO person_refcrops(person_id, face_id,"
                    " description, seq, filename, crop)"
                    " VALUES (7, 1, '', 1, 'x.jpg', x'00')")
        con.execute("UPDATE persons SET primary_face_id=4, primary_pinned=1"
                    " WHERE id=9")
        con.commit()
        con.close()
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)
        self.con.commit()
        self.run_plan()
        # Unknown7 deleted -> its refcrop/primary went with the cascade
        self.assertEqual(self.q("SELECT * FROM person_refcrops"), [])
        # Mary lost f4? no — in this run only f1 moved (cluster of Unknown7)
        mary = self.q("SELECT primary_face_id FROM persons WHERE name='Mary'")[0]
        self.assertEqual(mary["primary_face_id"], 4)
        # now move Mary's primary away and check the pointer is cleared
        self.s_face(self.s_image(H2, w=200, h=200), "Winnie Pelser",
                    20, 20, 40, 40)
        self.con.commit()                     # the plan reads staging ro
        con = sqlite3.connect(self.faces_db)
        con.execute("INSERT INTO person_refcrops(person_id, face_id,"
                    " description, seq, filename, crop)"
                    " VALUES (9, 4, '', 1, 'y.jpg', x'00')")
        con.commit()
        con.close()
        self.run_plan(overwrite=True)
        mary = self.q("SELECT primary_face_id, primary_pinned FROM persons"
                      " WHERE name='Mary'")[0]
        self.assertIsNone(mary["primary_face_id"])
        self.assertEqual(mary["primary_pinned"], 0)
        self.assertEqual(self.q("SELECT * FROM person_refcrops"), [])

    def test_unowned_face_moves(self):
        img = self.s_image(H2, w=200, h=200)
        self.s_face(img, "Winnie Pelser", 120, 120, 30, 30)  # matches f5
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters["faces_moved"], 1)
        row = self.q("SELECT p.name FROM faces f JOIN persons p"
                     " ON p.id=f.person_id WHERE f.id=5")[0]
        self.assertEqual(row["name"], "Winnie Pelser")

    def test_greedy_one_to_one(self):
        """Two harvest faces over the same db face: best IoU wins, the
        other is logged as already-claimed."""
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)   # exact on f1
        self.s_face(img, "Koos Kat", 12, 12, 20, 20)       # IoU ~0.69 on f1
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters["matched"], 1)
        self.assertEqual(rep.counters["already-claimed"], 1)
        row = self.q("SELECT p.name FROM faces f JOIN persons p"
                     " ON p.id=f.person_id WHERE f.id=1")[0]
        self.assertEqual(row["name"], "Winnie Pelser")      # the exact match


if __name__ == "__main__":
    unittest.main()
