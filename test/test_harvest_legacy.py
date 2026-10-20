"""Tests for scripts/harvest_legacy.py (design §8, staging schema v1.0).

Run: python3 -m unittest discover -s test
Builds fixture sources (sidecars, digiKam DBs, Lightroom catalog) in a temp
dir — no local data, no archive access.  Checks the invariants H1-H4:
sources stay byte-identical and untouched, faces.db is refused, only a new
staging DB is written, and provenance (source, refs, picked, run + time,
fs path, certainly-resolved BLAKE3 hashes) lands on every row.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import harvest_legacy as hl  # noqa: E402
import pathmap  # noqa: E402

MWG_ELEMENT = """<x:xmpmeta><rdf:RDF><rdf:Description>
<mwg-rs:Regions>
 <rdf:Bag><rdf:li rdf:parseType="Resource">
   <mwg-rs:Area rdf:parseType="Resource">
     <stArea:x>0.1</stArea:x><stArea:y>0.2</stArea:y>
     <stArea:w>0.3</stArea:w><stArea:h>0.4</stArea:h>
     <stArea:unit>normalized</stArea:unit>
   </mwg-rs:Area>
   <mwg-rs:Name>Winnie Pelser</mwg-rs:Name>
   <mwg-rs:Type>Face</mwg-rs:Type>
 </rdf:li></rdf:Bag>
 <stDim:w>4000</stDim:w><stDim:h>3000</stDim:h>
</mwg-rs:Regions>
</rdf:Description></rdf:RDF></x:xmpmeta>"""

MWG_ATTRIBUTE = """<x:xmpmeta><rdf:RDF>
<mwg-rs:Regions>
 <rdf:Bag><rdf:li mwg-rs:Name="Koos Kat" mwg-rs:Type="Face">
   <mwg-rs:Area stArea:x="0.5" stArea:y="0.5" stArea:w="0.25"
                stArea:h="0.25" stArea:unit="normalized"/>
 </rdf:li></rdf:Bag>
</mwg-rs:Regions></rdf:RDF></x:xmpmeta>"""

HIER = """<lr:hierarchicalSubject><rdf:Bag>
 <rdf:li>People|Family|Winnie Pelser</rdf:li>
 <rdf:li>People|Family</rdf:li>
</rdf:Bag></lr:hierarchicalSubject>"""

MPRI = ('<MPReg:Regions><rdf:Bag>'
        '<rdf:li MPReg:PersonDisplayName="Barry Pelser"/>'
        '</rdf:Bag></MPReg:Regions>')


def build_digikam(path: Path, pics: Path) -> None:
    con = sqlite3.connect(path)
    con.executescript(f"""
    CREATE TABLE Tags (id INTEGER PRIMARY KEY, pid INTEGER, name TEXT,
                       icon BLOB, iconkde TEXT);
    CREATE TABLE Images (id INTEGER PRIMARY KEY, album INTEGER, name TEXT,
        status INTEGER, category INTEGER, modificationDate TEXT,
        fileSize INTEGER, uniqueHash TEXT, manualOrder INTEGER);
    CREATE TABLE ImageTags (imageid INTEGER, tagid INTEGER);
    CREATE TABLE ImageTagProperties (imageid INTEGER, tagid INTEGER,
        property TEXT, value TEXT);
    CREATE TABLE AlbumRoots (id INTEGER PRIMARY KEY, label TEXT,
        status INTEGER, type INTEGER, identifier TEXT, specificPath TEXT,
        caseSensitivity INTEGER);
    CREATE TABLE Albums (id INTEGER PRIMARY KEY, albumRoot INTEGER,
        relativePath TEXT, date TEXT, caption TEXT, collection INTEGER,
        icon BLOB, modificationDate TEXT);
    INSERT INTO Tags VALUES (1, 0, 'People', NULL, NULL);
    INSERT INTO Tags VALUES (2, 1, 'Family', NULL, NULL);
    INSERT INTO Tags VALUES (3, 2, 'Winnie Pelser', NULL, NULL);
    INSERT INTO Tags VALUES (4, 0, 'Places', NULL, NULL);
    INSERT INTO AlbumRoots VALUES (1, 'r', 1, 1, 'x', '{pics}', 0);
    INSERT INTO Albums VALUES (1, 1, '', NULL, NULL, 0, NULL, NULL);
    -- 10: album set -> path reconstructs exactly
    INSERT INTO Images VALUES (10, 1, 'a.jpg', 1, 0, NULL, 1234, NULL, 0);
    -- 11: album NULL, unique (name,size) in the tree -> name-size match
    INSERT INTO Images VALUES (11, NULL, 'b.PEF', 1, 0, NULL, 5678, NULL, 0);
    -- 12: album NULL, (name,size) ambiguous -> must stay unresolved
    INSERT INTO Images VALUES (12, NULL, 'dup.jpg', 1, 0, NULL, 42, NULL, 0);
    INSERT INTO ImageTags VALUES (10, 3);
    INSERT INTO ImageTags VALUES (11, 3);
    INSERT INTO ImageTags VALUES (10, 4);   -- 'Places': not a person, gated
    INSERT INTO ImageTagProperties VALUES
      (10, 3, 'tagRegion', '<rect x="10" y="20" width="30" height="40"/>');
    INSERT INTO ImageTagProperties VALUES
      (11, 3, 'tagRegion', '<rect x="1" y="2" width="3" height="4"/>');
    INSERT INTO ImageTagProperties VALUES
      (12, 3, 'tagRegion', '<rect x="5" y="5" width="6" height="6"/>');
    """)
    con.commit()
    con.close()


def build_recognition(path: Path) -> None:
    con = sqlite3.connect(path)
    con.executescript("""
    CREATE TABLE Identities (id INTEGER PRIMARY KEY, type TEXT);
    CREATE TABLE IdentityAttributes (id INTEGER, attribute TEXT, value TEXT);
    INSERT INTO Identities VALUES (1, 'internal');
    INSERT INTO IdentityAttributes VALUES (1, 'uuid', 'UUID-AAA');
    INSERT INTO IdentityAttributes VALUES (1, 'fullName', 'Winnie Pelser');
    """)
    con.commit()
    con.close()


def build_lrcat(path: Path) -> None:
    con = sqlite3.connect(path)
    con.executescript("""
    CREATE TABLE AgLibraryKeyword (id_local INTEGER PRIMARY KEY,
        id_global TEXT, name TEXT, parent INTEGER, keywordType TEXT);
    CREATE TABLE AgLibraryRootFolder (id_local INTEGER PRIMARY KEY,
        absolutePath TEXT);
    CREATE TABLE AgLibraryFolder (id_local INTEGER PRIMARY KEY,
        rootFolder INTEGER, pathFromRoot TEXT);
    CREATE TABLE AgLibraryFile (id_local INTEGER PRIMARY KEY,
        folder INTEGER, idx_filename TEXT);
    CREATE TABLE Adobe_images (id_local INTEGER PRIMARY KEY,
        fileWidth INTEGER, fileHeight INTEGER, rootFile INTEGER);
    CREATE TABLE AgLibraryFace (id_local INTEGER PRIMARY KEY, image INTEGER,
        tl_x REAL, tl_y REAL, tr_x REAL, bl_y REAL);
    CREATE TABLE AgLibraryKeywordFace (face INTEGER, tag INTEGER,
        userPick INTEGER);
    INSERT INTO AgLibraryKeyword VALUES (1, 'KWROOT', 'People', NULL, 'person');
    INSERT INTO AgLibraryKeyword VALUES (2, 'KW-FAM', 'Family', 1, 'person');
    INSERT INTO AgLibraryKeyword VALUES (3, 'KW-WIN', 'Winnie Pelser', 2, 'person');
    INSERT INTO AgLibraryRootFolder VALUES (1, 'D:/LIVE/');
    INSERT INTO AgLibraryFolder VALUES (1, 1, 'PICTURES/PicFiles');
    INSERT INTO AgLibraryFile VALUES (1, 1, 'a.jpg');
    INSERT INTO Adobe_images VALUES (1, 4000, 3000, 1);
    INSERT INTO AgLibraryFace VALUES (1, 1, 0.1, 0.2, 0.4, 0.6);
    INSERT INTO AgLibraryKeywordFace VALUES (1, 3, 1);
    """)
    con.commit()
    con.close()


class HarvestFixture(unittest.TestCase):
    """The full source fixture from the smoke test, in a temp dir."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.pics = self.base / "pics"
        self.pics2 = self.base / "pics2"
        self.pics.mkdir()
        self.pics2.mkdir()
        (self.pics / "a.jpg").write_bytes(b"x" * 1234)
        (self.pics / "b.PEF").write_bytes(b"y" * 5678)
        (self.pics / "c.PEF").write_bytes(b"z" * 999)
        (self.pics / "d.PEF").write_bytes(b"w" * 777)   # LR-sidecar target
        (self.pics / "dup.jpg").write_bytes(b"d" * 42)
        (self.pics2 / "dup.jpg").write_bytes(b"d" * 42)  # ambiguity for digiKam
        (self.pics / "a.jpg.xmp").write_text(MWG_ELEMENT + HIER + MPRI)
        (self.pics / "c.PEF.xmp").write_text(MWG_ATTRIBUTE)
        # Lightroom-style sidecar: stem carries no image extension
        (self.pics / "d.xmp").write_text(
            "<x:xmpmeta><rdf:RDF><rdf:Description>"
            "<lr:hierarchicalSubject><rdf:Bag>"
            "<rdf:li>People|Pets|Kat Booi</rdf:li></rdf:Bag>"
            "</lr:hierarchicalSubject></rdf:Description></rdf:RDF></x:xmpmeta>")
        self.digikam = self.base / "digikam4.db"
        self.recognition = self.base / "recognition.db"
        self.lrcat = self.base / "cat.lrcat"
        build_digikam(self.digikam, self.pics)
        build_recognition(self.recognition)
        build_lrcat(self.lrcat)
        self.out = self.base / "staging.db"
        self.addCleanup(self.tmp.cleanup)

    def run_harvest(self, **kw):
        args = dict(images_dirs=[self.pics, self.pics2],
                    digikam_db=self.digikam,
                    recognition_db=self.recognition,
                    lightroom_catalog=self.lrcat,
                    lr_roots=[("d:/live/pictures/picfiles", self.pics)])
        args.update(kw)
        con = hl.create_staging(self.out)
        try:
            run_id = hl.start_run(con, list(hl.ALL_SOURCES), {})
            st = hl.Staging(con, run_id)
            stats = hl.harvest(st, **args)
            hl.finish_run(con, run_id, stats)
        finally:
            con.close()
        return stats

    def q(self, sql: str):
        con = sqlite3.connect(self.out)
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(sql)]
        finally:
            con.close()


# ---------------------------------------------------------------- parsers

class ParserTests(unittest.TestCase):
    def test_load_env_expands_environment(self):
        """${HOME}-style refs resolve against the real environment, not just
        other .env keys (the .env defaults on this machine depend on it)."""
        import os
        with tempfile.TemporaryDirectory() as td:
            envf = Path(td) / ".env"
            envf.write_text("A=${HOME}/pics\nB=${A}/deep\nC=plain\n")
            got = hl.load_env(envf)
        self.assertEqual(got["A"], f"{os.environ['HOME']}/pics")
        self.assertEqual(got["B"], f"{os.environ['HOME']}/pics/deep")
        self.assertEqual(got["C"], "plain")

    def test_mwg_element_form(self):
        rows = list(hl.sidecar_face_data(MWG_ELEMENT))
        self.assertEqual(len(rows), 1)
        name, x, y, w, h, unit, iw, ih = rows[0]
        self.assertEqual(name, "Winnie Pelser")
        self.assertEqual((x, y, w, h), (0.1, 0.2, 0.3, 0.4))
        self.assertEqual((unit, iw, ih), ("normalized", 4000, 3000))

    def test_mwg_attribute_form(self):
        name, x, y, w, h, unit, iw, ih = \
            list(hl.sidecar_face_data(MWG_ATTRIBUTE))[0]
        self.assertEqual((name, unit), ("Koos Kat", "normalized"))
        self.assertEqual((x, y, w, h), (0.5, 0.5, 0.25, 0.25))
        self.assertIsNone(iw)

    def test_mpri_not_captured(self):
        """v1.1/§9: person presence without a rectangle is never harvested,
        even when the sidecar carries MPRI display names."""
        self.assertEqual(list(hl.sidecar_face_data(MPRI)), [])

    def test_non_face_type_skipped(self):
        text = MWG_ELEMENT.replace("<mwg-rs:Type>Face</mwg-rs:Type>",
                                   "<mwg-rs:Type>Pet</mwg-rs:Type>")
        self.assertEqual(list(hl.sidecar_face_data(text)), [])

    def test_people_paths(self):
        got = hl.sidecar_people_paths(HIER)
        self.assertEqual(got, {"People|Family|Winnie Pelser", "People|Family"})

    def test_lr_roots_and_mapping(self):
        roots = hl.parse_lr_roots(["D:/LIVE/=/mnt/archive/LIVE",
                                   "E:/misc=/tmp/misc"])
        self.assertEqual(roots[0][0], "d:/live")
        got = hl.map_lr_path("D:/LIVE", "PICTURES/PicFiles", "a.jpg", roots)
        self.assertEqual(got, "/mnt/archive/LIVE/PICTURES/PicFiles/a.jpg")
        self.assertIsNone(hl.map_lr_path("Z:/other", "x", "a.jpg", roots))
        with self.assertRaises(ValueError):
            hl.parse_lr_roots(["D:/LIVE"])          # no '=' mapping

    def test_digikam_tag_paths_are_hierarchical(self):
        """Regression: the legacy walker's cycle guard stopped at depth 1,
        so every digiKam path came out as a bare name."""
        con = sqlite3.connect(":memory:")
        con.executescript("""
        CREATE TABLE Tags (id INTEGER, pid INTEGER, name TEXT);
        INSERT INTO Tags VALUES (1, 0, 'People');
        INSERT INTO Tags VALUES (2, 1, 'Family');
        INSERT INTO Tags VALUES (3, 2, 'Winnie Pelser');
        INSERT INTO Tags VALUES (4, 4, 'Cycle');       -- pid points at self
        """)
        paths = hl._digikam_tag_paths(con)
        self.assertEqual(paths[3], "People|Family|Winnie Pelser")
        self.assertEqual(paths[4], "Cycle")            # cycle terminates
        con.close()

    def test_resolve_dk_image(self):
        recon = {10: "/arc/a.jpg"}
        index = {("b.pef", 5678): ["/arc/b.PEF"],
                 ("dup.jpg", 42): ["/arc/dup.jpg", "/arc2/dup.jpg"]}
        self.assertEqual(hl.resolve_dk_image(10, "a.jpg", 1, recon, index),
                         ("/arc/a.jpg", "source"))
        self.assertEqual(hl.resolve_dk_image(11, "b.PEF", 5678, recon, index),
                         ("/arc/b.PEF", "name-size"))
        self.assertEqual(hl.resolve_dk_image(12, "dup.jpg", 42, recon, index),
                         (None, "ambiguous"))
        self.assertEqual(hl.resolve_dk_image(13, "nope.jpg", 9, recon, index),
                         (None, "unknown"))


# ------------------------------------------------------- staging lifecycle

class StagingLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_creates_schema_and_version(self):
        con = hl.create_staging(self.base / "s.db")
        try:
            ver = con.execute("SELECT version FROM schema_version").fetchone()[0]
            self.assertEqual(ver, hl.HARVEST_SCHEMA_VERSION)
            tables = {r[0] for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertEqual(tables, {"harvest_runs", "sources", "persons",
                                      "person_groups", "person_refs", "images",
                                      "faces", "schema_version"})
        finally:
            con.close()

    def test_refuses_existing_file(self):
        p = self.base / "s.db"
        p.write_text("precious")
        with self.assertRaises(hl.StagingError):
            hl.create_staging(p)
        self.assertEqual(p.read_text(), "precious")     # untouched

    def test_refuses_faces_db_path(self):
        faces_db = self.base / "faces.db"
        faces_db.write_text("the review db")
        with self.assertRaises(hl.StagingError):
            hl.create_staging(self.base / "faces.db", faces_db=faces_db)
        self.assertEqual(faces_db.read_text(), "the review db")

    def test_unknown_source_refused(self):
        con = hl.create_staging(self.base / "s.db")
        try:
            with self.assertRaises(hl.StagingError):
                hl.ensure_sources(con, ["not-a-source"])
        finally:
            con.close()

    def test_mpri_source_refused(self):
        """v1.1: sidecars-mpri is no longer canonical."""
        con = hl.create_staging(self.base / "s.db")
        try:
            with self.assertRaises(hl.StagingError):
                hl.ensure_sources(con, ["sidecars-mpri"])
        finally:
            con.close()


# -------------------------------------------------------- end-to-end run

class EndToEndTests(HarvestFixture):
    def test_stats_and_provenance(self):
        stats = self.run_harvest()
        # sidecars: one mwgrs face per image sidecar (c.PEF.xmp carries the
        # attribute-form region); the MPRI name in a.jpg.xmp is ignored (v1.1)
        self.assertEqual(stats["faces"], 2)
        self.assertNotIn("presence", stats)
        # digiKam faces: a.jpg by path, b.PEF by name-size, dup.jpg ambiguous
        self.assertEqual(stats["dk_faces"], 3)
        self.assertEqual(stats["dk_faces_resolved_source"], 1)
        self.assertEqual(stats["dk_faces_resolved_name-size"], 1)
        self.assertEqual(stats["dk_faces_resolved_ambiguous"], 1)
        # Lightroom catalog: one face, user-picked
        self.assertEqual(stats["lr_faces"], 1)
        self.assertEqual(stats["lr_file_missing"], 0)
        # every face row carries source + run
        for row in self.q("SELECT * FROM faces"):
            self.assertIsNotNone(row["source_id"])
            self.assertEqual(row["harvest_run_id"], 1)
        run = self.q("SELECT * FROM harvest_runs")[0]
        self.assertIsNotNone(run["started_at"])
        self.assertIsNotNone(run["finished_at"])
        self.assertEqual(json.loads(run["sources"]), list(hl.ALL_SOURCES))

    def test_face_geometry_and_provenance_fields(self):
        self.run_harvest()
        rows = self.q("""
            SELECT s.name src, p.name person, f.* FROM faces f
            JOIN persons p ON p.id=f.person_id
            JOIN sources s ON s.id=f.source_id""")
        by_src = {r["src"]: r for r in rows}
        mw = by_src["sidecars-mwgrs"]
        self.assertEqual((mw["x"], mw["y"], mw["w"], mw["h"]),
                         (0.1, 0.2, 0.3, 0.4))
        self.assertEqual((mw["unit"], mw["img_w"], mw["img_h"]),
                         ("normalized", 4000, 3000))
        lr = by_src["lightroom-catalog"]
        # banker's rounding of tl(0.1,0.2)..(0.4,0.6) over 4000x3000
        self.assertEqual((lr["x"], lr["y"], lr["w"], lr["h"]),
                         (400, 600, 1200, 1200))
        self.assertEqual(lr["source_ref"], "face:1")
        self.assertEqual(lr["picked"], 1)
        dk = [r for r in rows
              if r["src"] == "digikam-faces" and r["x"] == 10]
        self.assertEqual(len(dk), 1)
        dk = dk[0]
        self.assertEqual(dk["unit"], "pixels")
        self.assertEqual((dk["x"], dk["y"], dk["w"], dk["h"]), (10, 20, 30, 40))

    def test_image_paths_and_hashes(self):
        from blake3 import blake3
        stats = self.run_harvest()
        rows = {r["path"]: r for r in self.q("SELECT * FROM images")
                if r["path"]}
        # sidecar siblings and the mapped catalog path are certain: hashed
        a = rows[str(self.pics / "a.jpg")]
        self.assertEqual(a["path_origin"], "source")
        self.assertEqual(a["content_hash"],
                         blake3(b"x" * 1234).hexdigest())   # independent check
        self.assertEqual((a["width"], a["height"]), (4000, 3000))
        # digiKam's ambiguous image keeps identifiers but no path, no hash
        amb = self.q("SELECT * FROM images WHERE name='dup.jpg'")[0]
        self.assertIsNone(amb["path"])
        self.assertIsNone(amb["content_hash"])
        self.assertEqual(amb["file_size"], 42)
        # unique name-size resolution IS certain -> hashed
        b = rows[str(self.pics / "b.PEF")]
        self.assertEqual(b["path_origin"], "name-size")
        self.assertEqual(len(b["content_hash"]), 64)
        self.assertEqual(stats["hash_failed"], 0)
        self.assertGreaterEqual(stats["hashed"], 3)

    def test_lr_sidecar_single_candidate_hashed(self):
        self.run_harvest()
        row = self.q(
            f"SELECT * FROM images WHERE path='{self.pics / 'd.PEF'}'")
        self.assertEqual(len(row), 1)
        self.assertEqual(len(row[0]["content_hash"]), 64)

    def test_no_hash_flag(self):
        self.run_harvest(hasher=hl.Hasher(enabled=False))
        for row in self.q("SELECT content_hash FROM images"):
            self.assertIsNone(row["content_hash"])

    def test_persons_and_refs(self):
        self.run_harvest()
        names = {r["name"] for r in self.q("SELECT name FROM persons")}
        self.assertIn("Winnie Pelser", names)
        self.assertIn("Koos Kat", names)
        self.assertNotIn("Barry Pelser", names)   # MPRI presence: not captured
        refs = {(r["name"], r["kind"], r["ref"])
                for r in self.q("SELECT p.name, pr.* FROM person_refs pr"
                                " JOIN persons p ON p.id=pr.person_id")}
        self.assertIn(("Winnie Pelser", "digikam-recognition", "UUID-AAA"), refs)
        self.assertIn(("Winnie Pelser", "lightroom-catalog", "keyword:KW-WIN"),
                      refs)
        groups = {(r["name"], r["path"])
                  for r in self.q("SELECT p.name, pg.path FROM person_groups pg"
                                  " JOIN persons p ON p.id=pg.person_id")}
        self.assertIn(("Winnie Pelser", "People|Family|Winnie Pelser"), groups)
        self.assertIn(("Kat Booi", "People|Pets|Kat Booi"), groups)

    def test_sources_untouched(self):
        """H1: the sources are read-only — byte-identical afterwards and no
        WAL/SHM files appear next to them."""
        before = {p: (p.read_bytes(), p.stat().st_mtime_ns)
                  for p in [self.digikam, self.recognition, self.lrcat,
                            self.pics / "a.jpg.xmp", self.pics / "d.xmp"]}
        self.run_harvest()
        for p, (data, mtime) in before.items():
            self.assertEqual(p.read_bytes(), data, f"{p} was modified")
            self.assertEqual(p.stat().st_mtime_ns, mtime, f"{p} was touched")
        for p in self.base.rglob("*"):
            if p.name.endswith(("-wal", "-shm")):
                self.assertTrue(str(p).startswith(str(self.out)),
                                f"stray journal file: {p}")

    def test_dry_run_writes_nothing(self):
        stats = hl.harvest(None, images_dirs=[self.pics],
                           digikam_db=self.digikam,
                           recognition_db=self.recognition,
                           lightroom_catalog=self.lrcat)
        self.assertGreaterEqual(stats["known_persons"], 4)
        self.assertFalse(self.out.exists())

    def test_missing_catalog_is_an_error(self):
        with self.assertRaises(ValueError):
            hl.harvest(None, images_dirs=[],
                       digikam_db=self.digikam,
                       recognition_db=self.recognition,
                       sources=("lightroom-catalog",),
                       lightroom_catalog=None)

    def test_narrowed_sources_run(self):
        """A subset of the vocabulary must not KeyError on shared rows."""
        stats = self.run_harvest(sources=("sidecars-catsets",))
        # darktable-style sidecars only: a.jpg.xmp's two paths; d.xmp is a
        # Lightroom-style sidecar and its loader is disabled here
        self.assertEqual(stats["people_paths"], 2)
        rows = self.q("SELECT DISTINCT s.name src FROM person_groups pg"
                      " JOIN sources s ON s.id=pg.source_id")
        self.assertEqual({r["src"] for r in rows}, {"sidecars-catsets"})
        names = {r["name"] for r in self.q("SELECT name FROM persons")}
        self.assertIn("Winnie Pelser", names)
        self.assertNotIn("Koos Kat", names)      # mwgrs disabled
        self.assertNotIn("Kat Booi", names)      # lr-sidecars disabled


# ------------------------------------------ path map & coverage (#83/#85)

class PathMapHarvestTests(HarvestFixture):
    """§8.6: the path-map file feeds LR roots and the index (#85)."""

    def test_unmapped_lr_roots_are_sampled(self):
        """Run with NO lr-root mapping: the catalog root is remembered
        with an example path instead of being counted and forgotten."""
        stats = self.run_harvest(lr_roots=[])
        self.assertGreater(stats["lr_root_unmapped"], 0)
        roots = stats["lr_unmapped_roots"]
        self.assertIn("d:/live", roots)             # root_key: first 2 segs
        self.assertEqual(roots["d:/live"]["count"], 1)
        self.assertEqual(roots["d:/live"]["example"],
                         "D:/LIVE/PICTURES/PicFiles/a.jpg")

    def test_path_map_resolves_lr_root(self):
        """The same run, mapped through a path-map file, resolves and
        hashes the image — no --lr-root flag involved."""
        rules = pathmap.parse_path_map(
            f"D:/LIVE/PICTURES/PicFiles = {self.pics}")
        stats = self.run_harvest(lr_roots=[], path_map=rules)
        self.assertEqual(stats["lr_root_unmapped"], 0)
        self.assertNotIn("lr_unmapped_roots", stats)
        self.assertEqual(stats["lr_faces"], 1)
        self.assertGreaterEqual(stats["hashed"], 1)

    def test_path_map_seeds_resolution_index(self):
        """digiKam name-size resolution also consults the map's local
        roots — a file living only under a mapped root becomes resolvable."""
        # b.PEF is in self.pics with a sidecar-less digiKam entry resolved
        # by name-size in the standard fixture; map an unrelated prefix onto
        # pics so the seeded index gains nothing new — the invariant to
        # pin is: indexing runs over images_dirs + mapped roots without
        # duplication or crash.
        rules = pathmap.parse_path_map(f"D:/somewhere/else = {self.pics}")
        stats = self.run_harvest(path_map=rules)
        # same unique name-size hit as the standard run
        self.assertEqual(stats["dk_faces_resolved_name-size"], 1)

    def test_broken_path_map_line_raises(self):
        with self.assertRaises(ValueError):
            pathmap.parse_path_map("just some text")


class CoverageWarningTests(HarvestFixture):
    """§8.6 (#83): >20% unusable => prominent stderr warning, never
    -q-suppressed, naming the unmapped roots (#85)."""

    def run_main(self, *args):
        import contextlib, io
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = hl.main(list(args))
        return rc, out.getvalue(), err.getvalue()

    def main_args(self, *extra, out_db: Path | None = None):
        return ["--out", str(out_db or (self.base / "warn.db")),
                "--images", str(self.pics),
                "--digikam-db", str(self.digikam),
                "--recognition-db", str(self.recognition),
                "--lightroom-catalog", str(self.lrcat),
                "--sources", "lightroom-catalog",   # nothing mapped -> 100%
                *extra]

    def test_warning_on_poor_coverage(self):
        rc, out, err = self.run_main(*self.main_args())
        self.assertEqual(rc, 0)
        self.assertIn("WARNING:", err)
        self.assertIn("100% of archive rows unusable", err)
        self.assertIn("d:/live", err)                # the unmapped root named
        self.assertIn("D:/LIVE/PICTURES/PicFiles/a.jpg", err)  # example path
        # the header still leads stdout
        self.assertTrue(out.startswith("=" * 64))

    def test_warning_survives_quiet(self):
        """-q silences status, never the coverage warning (§8.6)."""
        rc, out, err = self.run_main(*self.main_args("-q"))
        self.assertEqual(rc, 0)
        self.assertIn("WARNING:", err)
        # quiet stdout: header only (no phase lines)
        self.assertNotIn("scanning", out)
        self.assertIn("harvest_legacy", out)

    def test_no_warning_when_coverage_ok(self):
        rc, out, err = self.run_main(
            *self.main_args("--lr-root",
                            f"D:/LIVE/PICTURES/PicFiles={self.pics}"))
        self.assertEqual(rc, 0)
        self.assertNotIn("WARNING:", err)


if __name__ == "__main__":
    unittest.main()
