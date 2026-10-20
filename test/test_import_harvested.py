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
        # without a person name: root stripped only (legacy behaviour)
        self.assertEqual(ih.strip_group_root("People|Family|X"), "Family|X")
        self.assertEqual(ih.strip_group_root("Person|X"), "X")
        self.assertEqual(ih.strip_group_root("people|X"), "X")
        self.assertEqual(ih.strip_group_root("Family|X"), "Family|X")
        self.assertIsNone(ih.strip_group_root("People"))

    def test_strip_group_root_drops_name_leaf(self):
        """§9.4 v2.1 (#80): staging paths end in the person's own name;
        faces.db group paths never do — the leaf is dropped."""
        self.assertEqual(ih.strip_group_root("People|Family|Winnie Pelser",
                                             "Winnie Pelser"), "Family")
        # leaf kept when it is NOT the person's name (capture, no guessing)
        self.assertEqual(ih.strip_group_root("People|Family|Winnie Pelser",
                                             "Koos Kat"), "Family|Winnie Pelser")
        self.assertEqual(ih.strip_group_root("Family|Mary", "Mary"), "Family")
        # name directly under the root -> ungrouped
        self.assertIsNone(ih.strip_group_root("People|Winnie Pelser",
                                              "Winnie Pelser"))
        # §9.4 v4.0 (#87): the name-leaf drop is case-insensitive too
        self.assertEqual(
            ih.strip_group_root("People|family|WINNIE PELSER", "winnie pelser"),
            "family")
        self.assertIsNone(
            ih.strip_group_root("People|WINNIE PELSER", "winnie pelser"))

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
                         ["Family"])   # root+name-leaf stripped (§9.4 v2.1)

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

    def test_contested_face_left_untouched(self):
        """§9.3 v4.0 (#87): ONE db face claimed by TWO different persons —
        IoU never picks the person. The face stays, all claimants are
        logged, and contest-only claimants are not created."""
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)   # IoU 1.00 on f1
        self.s_face(img, "Koos Kat", 12, 12, 20, 20)       # IoU ~0.69 on f1
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters["contested"], 1)
        self.assertEqual(rep.counters.get("matched", 0), 0)
        self.assertEqual(rep.counters.get("faces_moved", 0), 0)
        # contest-only claimants stay log-only, nothing created
        self.assertEqual(rep.counters.get("persons_created", 0), 0)
        self.assertEqual(self.q("SELECT person_id FROM faces WHERE id=1")[0]
                         ["person_id"], 7)
        self.assertEqual(self.q("SELECT * FROM persons WHERE name"
                                " IN ('Winnie Pelser','Koos Kat')"), [])
        # the log names every claimant with source and IoU
        det = [d for d in rep.details if d.startswith("contested")]
        self.assertEqual(len(det), 1)
        self.assertIn("Winnie Pelser", det[0])
        self.assertIn("Koos Kat", det[0])
        self.assertIn("IoU 1.00", det[0])
        self.assertIn("left with Unknown7", det[0])

    def test_different_faces_in_cluster_decide_separately(self):
        """§9.3 v4.0: two DIFFERENT whot faces, one claim each — each face
        decides alone; the cluster's undecided mates do not co-move."""
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)   # claims f1
        self.s_face(img, "Koos Kat", 50, 50, 20, 20)       # claims f2
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters["matched"], 2)
        self.assertEqual(rep.counters["faces_moved"], 2)
        names = {r["id"]: r["name"] for r in self.q(
            "SELECT f.id, p.name FROM faces f JOIN persons p"
            " ON p.id=f.person_id WHERE f.id IN (1,2)")}
        self.assertEqual(names, {1: "Winnie Pelser", 2: "Koos Kat"})
        # f3 had no claim and the cluster was NOT unanimous -> stays
        self.assertEqual(self.q("SELECT person_id FROM faces WHERE id=3")[0]
                         ["person_id"], 7)

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
        self.assertEqual([x["path"] for x in g], ["Family"])  # leaf dropped

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

    def test_same_person_many_rects_dedup_to_one_move(self):
        """§9.3 v4.0 (#87): several rects of the SAME person on one db
        face are agreement — exactly one move; the rects are claims, not
        competitors."""
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)   # IoU 1.00
        self.s_face(img, "winnie pelser", 12, 12, 20, 20)  # ~0.69, case-variant
        self.s_face(img, "WINNIE PELSER", 11, 11, 20, 20)  # in between
        self.con.commit()
        rep = self.run_plan()
        # one db face decided (agreement deduped the three rects) ...
        self.assertEqual(rep.counters["matched"], 1)
        self.assertEqual(rep.counters.get("contested", 0), 0)
        # ... and the unclaimed cluster mates followed (§9.5 co-move)
        self.assertEqual(rep.counters["faces_moved"], 3)
        rows = self.q("SELECT p.name FROM faces f JOIN persons p"
                      " ON p.id=f.person_id WHERE f.id IN (1,2,3)")
        # case-insensitive agreement -> one person, first source's spelling
        self.assertEqual({r["name"] for r in rows}, {"Winnie Pelser"})

    # ---------------------------------------------------- #80 regressions

    def test_name_leaf_only_path_is_ungrouped(self):
        """§9.4 v2.1 (#80): 'People|<name>' leaves no group above the
        person -> ungrouped, never a same-named twig in the tree."""
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20,
                    groups=("People|Winnie Pelser",))
        self.con.commit()
        self.run_plan()
        groups = self.q("SELECT path FROM person_groups pg"
                        " JOIN persons p ON p.id=pg.person_id"
                        " WHERE p.name='Winnie Pelser'")
        self.assertEqual(groups, [])                       # ungrouped

    def test_harvested_persons_get_machine_primary(self):
        """§9.5 v2.1 (#80): the §4.5 machine rule backfills every empty
        primary in the copy — the person view must not rely on NULL."""
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)
        self.s_face(img, "Winnie Pelser", 50, 50, 20, 20)
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters["faces_moved"], 3)   # cluster merge
        rows = self.q("SELECT p.name, p.primary_face_id FROM persons p"
                      " WHERE p.name='Winnie Pelser'")
        self.assertEqual(len(rows), 1)
        self.assertIsNotNone(rows[0]["primary_face_id"],
                             "machine primary backfilled (§4.5 rule)")

    def test_reuse_matches_gui_group_after_correction(self):
        """§9.4 v2.1 (#80): a harvested 'People|Family|Winnie Pelser'
        matches a GUI person grouped 'Family' (before the correction the
        trailing name leaf defeated the reuse rule)."""
        con = sqlite3.connect(self.faces_db)
        con.execute("UPDATE persons SET name='Winnie Pelser' WHERE id=9")
        con.execute("INSERT INTO person_groups(person_id, path)"
                    " VALUES (9, 'Family')")
        con.commit()
        con.close()
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20,
                    groups=("People|Family|Winnie Pelser",))
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters["persons_reused"], 1)
        self.assertEqual(rep.counters.get("persons_created", 0), 0)


# ------------------------------------------------- idempotent re-runs (#82)

class IdempotencyTests(Fixture):
    """§9.8: a second identical run converges — no X-3 snowball, no seq
    churn, no leftover shells."""

    def seed_cluster(self):
        # the whole Unknown7 cluster on image 1 (exact matches)
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20,
                    groups=("People|Family|Winnie Pelser",))
        self.s_face(img, "Winnie Pelser", 50, 50, 20, 20)
        self.s_face(img, "Winnie Pelser", 80, 10, 20, 20)
        # a second staging person colliding with the GUI 'Mary' by name:
        # her staged face matches the unowned provisional f5 on image 2,
        # and her group set differs from GUI-Mary's (none) -> first run
        # must mint 'Mary 2' (state='imported'), which the second run
        # has to recognise as its own generation (#82)
        img2 = self.s_image(H2, w=200, h=200)
        self.st.group(self.st.person("Mary"), "People|Friends|Mary", self.sid)
        self.s_face(img2, "Mary", 120, 120, 30, 30)
        self.con.commit()

    def snapshot_persons(self):
        return {r["name"]: r for r in self.q(
            "SELECT id, name, state, primary_face_id FROM persons")}

    def test_second_run_converges(self):
        self.seed_cluster()
        rep1 = self.run_plan()
        self.assertGreater(rep1.counters["faces_moved"], 0)
        # first run: Mary collides -> created as 'Mary 2' (state='imported')
        p1 = self.snapshot_persons()
        self.assertIn("Mary 2", p1)
        self.assertEqual(p1["Mary 2"]["state"], "imported")
        names1 = set(p1)
        faces1 = self.q("SELECT id, seq, name, person_id FROM faces ORDER BY id")
        prim1 = {n: p["primary_face_id"] for n, p in p1.items()}

        # second identical run: same staging, same target
        rep2 = self.run_plan()
        # (1) no new persons, no snowball generation
        self.assertEqual(rep2.counters.get("persons_created", 0), 0)
        p2 = self.snapshot_persons()
        self.assertEqual(set(p2), names1, "no 'X 3' duplicates")
        # (2) every matched face is already-there: no moves, no relabel
        self.assertEqual(rep2.counters.get("faces_moved", 0), 0)
        self.assertGreater(rep2.counters.get("already-there", 0), 0)
        faces2 = self.q("SELECT id, seq, name, person_id FROM faces ORDER BY id")
        self.assertEqual(faces1, faces2, "seq/names/ownership unchanged")
        # (3) primaries survive the second run (backfill is a no-op)
        self.assertEqual({n: p["primary_face_id"] for n, p in self.snapshot_persons().items()},
                         prim1)
        # (4) no importer shells were created or deleted
        self.assertEqual(rep2.counters.get("importer_shells_deleted", 0), 0)

    def test_third_run_still_converges(self):
        """Even after three runs: same person set, zero moves."""
        self.seed_cluster()
        self.run_plan()
        self.run_plan()
        rep3 = self.run_plan()
        self.assertEqual(rep3.counters.get("faces_moved", 0), 0)
        self.assertEqual(rep3.counters.get("persons_created", 0), 0)
        suffixed = [n for n in self.snapshot_persons() if n.endswith(" 3")]
        self.assertEqual(suffixed, [], "no third generation minted")

    def test_shell_sweep_only_touches_imported(self):
        """§9.8: state='imported' zero-face persons are swept; named
        (state='created') empty persons are never touched."""
        con = sqlite3.connect(self.faces_db)
        con.execute("INSERT INTO persons(id, name, state, created_at)"
                    " VALUES (90, 'Ghost', 'imported', '2026-10-20')")
        con.execute("INSERT INTO persons(id, name, state, created_at)"
                    " VALUES (91, 'KeepMe', 'created', '2026-10-20')")
        con.commit()
        con.close()
        self.seed_cluster()
        self.run_plan()
        names = set(self.snapshot_persons())
        self.assertNotIn("Ghost", names, "importer shell swept")
        self.assertIn("KeepMe", names, "user person untouched")

    def test_whot_spelling_wins_case_insensitive_reuse(self):
        """§9.4 v4.0 (#87): claims spelled 'winnie pelser'/'WINNIE PELSER'
        reuse the whot person 'Winnie Pelser' — whot's spelling wins,
        no new person, existing derived labels untouched."""
        con = sqlite3.connect(self.faces_db)
        con.execute("UPDATE persons SET name='Winnie Pelser' WHERE id=9")
        con.execute("INSERT INTO person_groups(person_id, path)"
                    " VALUES (9, 'Family')")          # note: 'Family' capital
        con.commit()
        con.close()
        img = self.s_image(H1)
        self.s_face(img, "winnie pelser", 10, 10, 20, 20,
                    groups=("People|family|WINNIE PELSER",))  # case-variant groups
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters["persons_reused"], 1)
        self.assertEqual(rep.counters.get("persons_created", 0), 0)
        rows = self.q("SELECT id, name FROM persons WHERE name"
                      " COLLATE NOCASE = 'winnie pelser'")
        self.assertEqual(len(rows), 1)                # one person, not two
        self.assertEqual(rows[0]["name"], "Winnie Pelser")   # whot spelling
        g = self.q("SELECT path FROM person_groups WHERE person_id=9")
        self.assertEqual([x["path"] for x in g], ["Family"])  # untouched

    def test_first_source_spelling_wins_for_new_person(self):
        """§9.4 v4.0 (#87): no whot match -> one new person, spelled as
        the FIRST source (lowest staging person id) stated it."""
        img = self.s_image(H1)
        # s_face creates staging persons in call order: 'winnie pelser' is
        # the first source, the capitalised variants join the same identity
        self.s_face(img, "winnie pelser", 10, 10, 20, 20,
                    groups=("People|Family|winnie pelser",))
        self.s_face(img, "Winnie Pelser", 50, 50, 20, 20,
                    groups=("People|Family|Winnie Pelser",))
        self.s_face(img, "WINNIE PELSER", 80, 10, 20, 20,
                    groups=("People|family|WINNIE PELSER",))
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters["matched"], 3)
        names = [r["name"] for r in self.q(
            "SELECT name FROM persons WHERE state='imported'")]
        # the three case-variants merged into ONE person ...
        self.assertEqual(len(names), 1, names)
        # ... spelled as the first source said it
        self.assertEqual(names[0], "winnie pelser")
        # its group is first-source spelling too — and the name-leaf was
        # dropped by §9.4 v2.1, so just 'Family' (spelled by the first source,
        # which happens to be capitalised here)
        g = self.q("""SELECT pg.path FROM person_groups pg
                      JOIN persons p ON p.id=pg.person_id
                     WHERE p.state='imported'""")
        self.assertEqual([x["path"] for x in g], ["Family"])

    def test_case_insensitive_own_generation_reuse(self):
        """#82 + §9.4 v4.0: claims spelled 'winnie pelser' recognise the
        previous run's 'Winnie Pelser 2' (state='imported') — no ' 3'."""
        # a GUI 'Winnie Pelser' with DIFFERENT groups forces the suffix
        con = sqlite3.connect(self.faces_db)
        con.execute("UPDATE persons SET name='Winnie Pelser' WHERE id=9")
        con.execute("INSERT INTO person_groups(person_id, path)"
                    " VALUES (9, 'Other')")
        con.commit()
        con.close()
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20,
                    groups=("People|Family|Winnie Pelser",))
        self.con.commit()
        self.run_plan()                       # run 1 mints 'Winnie Pelser 2'
        names1 = {r["name"] for r in self.q("SELECT name FROM persons")}
        self.assertIn("Winnie Pelser 2", names1)
        # run 2: same claims, different capitalization (re-harvest effect)
        st = sqlite3.connect(self.staging)
        st.execute("UPDATE persons SET name='WINNIE PELSER'")
        st.execute("UPDATE person_groups SET path='People|family|WINNIE PELSER'")
        st.commit()
        st.close()
        rep = self.run_plan()
        self.assertEqual(rep.counters.get("persons_created", 0), 0)
        self.assertEqual(rep.counters.get("faces_moved", 0), 0)   # already-there
        names2 = {r["name"] for r in self.q("SELECT name FROM persons")}
        self.assertEqual(names2, names1)          # no 'Winnie Pelser 3'

    def test_loose_rect_cannot_override_agreement(self):
        """§9.3 v4.0 (#87): a large loose rect adds a claim but can never
        overturn agreement of the other sources."""
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)   # tight, IoU 1.0
        self.s_face(img, "Winnie Pelser", 12, 12, 20, 20)   # tight, ~0.69
        # a loose rect for the SAME person also hitting f2 (IoU ~0.69) ->
        # f2's only claim is Winnie, so it links too (agreement is per face)
        self.s_face(img, "Winnie Pelser", 48, 48, 24, 24)
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters.get("contested", 0), 0)
        self.assertEqual(rep.counters["matched"], 2)   # f1 and f2 decided
        rows = self.q("SELECT p.name FROM faces f JOIN persons p"
                      " ON p.id=f.person_id WHERE f.id IN (1,2)")
        self.assertTrue(all(r["name"] == "Winnie Pelser" for r in rows))

    def test_confirmed_face_claims_ignored(self):
        """§9.3 rule 1 (#87): confirmed whot faces keep whot's work."""
        img = self.s_image(H1)
        self.s_face(img, "Winnie Pelser", 50, 50, 20, 20)   # on f2 (provisional)
        img2 = self.s_image(H2, w=200, h=200)
        self.s_face(img2, "Winnie Pelser", 20, 20, 40, 40)  # on f4 (Mary, confirmed)
        self.con.commit()
        rep = self.run_plan()
        self.assertEqual(rep.counters["status-protected"], 1)  # f4's claim
        self.assertEqual(rep.counters["matched"], 1)           # f2 linked
        row = self.q("SELECT p.name FROM faces f JOIN persons p"
                     " ON p.id=f.person_id WHERE f.id=4")[0]
        self.assertEqual(row["name"], "Mary")   # f4 still belongs to Mary
        det = [d for d in rep.details if d.startswith("status-protected")]
        self.assertEqual(len(det), 1)
        self.assertIn("Winnie Pelser", det[0])   # the ignored claim is logged

    def test_rescue_overlay_feeds_matching(self):
        """§8.6: hashes rescued by the path map overlay the staging images
        in memory — the staging DB itself is never written (H1/H2)."""
        import hashlib
        img = self.s_image(None, path="/moved/nowhere/a.jpg")  # hashless
        # stage a face; without a rescue it is hash-missing
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)
        self.con.commit()
        st = sqlite3.connect(self.staging)
        ch0 = st.execute("SELECT content_hash FROM images WHERE id=?",
                         (img,)).fetchone()[0]
        st.close()
        self.assertIsNone(ch0)
        # the overlay supplies a hash that matches the fixture H1 image
        rep = ih.Report()
        stcon = ih.open_ro(self.staging)
        try:
            dbcon = sqlite3.connect(self.faces_db)
            dbcon.row_factory = sqlite3.Row
            try:
                plan = ih.plan_import(stcon, dbcon, 0.60, False, rep,
                                      rescues={img: H1})
                self.assertGreater(rep.counters["matched"], 0)
            finally:
                dbcon.close()
        finally:
            stcon.close()
        st = sqlite3.connect(self.staging)
        ch1 = st.execute("SELECT content_hash FROM images WHERE id=?",
                         (img,)).fetchone()[0]
        st.close()
        self.assertIsNone(ch1, "staging DB untouched by the overlay (H1)")


# --------------------------------------- coverage warning & paths (#83/#85)

class CoverageWarningImportTests(Fixture):
    """§8.6 (#83): >20% unusable staging faces => stderr warning, never
    -q-suppressed; #85: full stated paths, one line per image."""

    def run_main(self, *args):
        import contextlib, io
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = ih.main(list(args))
        return rc, out.getvalue(), err.getvalue()

    def test_warning_on_poor_coverage(self):
        # one pathless, unhashable staging face -> 100% unusable
        img = self.s_image(None, path=None)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)
        self.con.commit()
        rc, out, err = self.run_main(str(self.staging),
                                     "--faces-db", str(self.faces_db),
                                     "--dry-run")
        self.assertEqual(rc, 0)
        self.assertIn("WARNING:", err)
        self.assertIn("100% of staging faces unusable", err)
        # percentage also always in the summary (§8.6)
        self.assertIn("usable faces", out)
        self.assertIn("0/1 (0%)", out)

    def test_warning_survives_quiet(self):
        img = self.s_image(None, path=None)
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)
        self.con.commit()
        rc, out, err = self.run_main(str(self.staging),
                                     "--faces-db", str(self.faces_db),
                                     "--dry-run", "-q")
        self.assertEqual(rc, 0)
        self.assertIn("WARNING:", err)         # stderr, never -q-suppressed
        self.assertNotIn("rescue", out)         # (no path map here anyway)

    def test_details_carry_full_path_once_per_image(self):
        """#85: hash-missing / image-not-in-db details name the full
        stated path, deduplicated per image — not per face."""
        # two hashless images with stated paths; image A has two faces
        a = self.s_image(None, path="/old/moved/first.JPG")
        b = self.s_image(None, path="/old/moved/second.JPG", w=200, h=200)
        self.s_face(a, "Winnie Pelser", 10, 10, 20, 20)
        self.s_face(a, "Winnie Pelser", 50, 50, 20, 20)
        self.s_face(b, "Winnie Pelser", 20, 20, 40, 40)
        self.con.commit()
        rep = ih.Report()
        stcon = ih.open_ro(self.staging)
        try:
            dbcon = sqlite3.connect(self.faces_db)
            dbcon.row_factory = sqlite3.Row
            try:
                ih.plan_import(stcon, dbcon, 0.60, False, rep)
            finally:
                dbcon.close()
        finally:
            stcon.close()
        self.assertEqual(rep.counters["hash-missing"], 3)   # counted per face
        details = [d for d in rep.details if d.startswith("hash-missing")]
        self.assertEqual(len(details), 2)                   # reported per image
        joined = "\n".join(details)
        self.assertIn("/old/moved/first.JPG", joined)       # full path
        self.assertIn("/old/moved/second.JPG", joined)
        self.assertNotIn("staging face", joined)            # no face-noise

    def test_image_not_in_db_details_path(self):
        # a hashed staging image that faces.db lacks
        img = self.s_image("c" * 64, path="/archive/unimported/never-seen.jpg")
        self.s_face(img, "Winnie Pelser", 10, 10, 20, 20)
        self.con.commit()
        rep = ih.Report()
        stcon = ih.open_ro(self.staging)
        try:
            dbcon = sqlite3.connect(self.faces_db)
            dbcon.row_factory = sqlite3.Row
            try:
                ih.plan_import(stcon, dbcon, 0.60, False, rep)
            finally:
                dbcon.close()
        finally:
            stcon.close()
        self.assertEqual(rep.counters["image-not-in-db"], 1)
        det = [d for d in rep.details if d.startswith("image-not-in-db")]
        self.assertEqual(len(det), 1)
        self.assertIn("/archive/unimported/never-seen.jpg", det[0])


if __name__ == "__main__":
    unittest.main()
