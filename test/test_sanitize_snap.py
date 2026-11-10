"""#236/#237 — the dump sanitizer: the gui-mock snapshot carries no personal data.

Contract: test/gui-mock/README.md -> "Sanitization". The sanitizer is a
pure function over the dumped snapshot structure; the tests use a small
synthetic corpus that mirrors the real one's shapes (real-name persons,
UnknownN, a system person, surname group segments incl. a bare
`Friends` segment that must not merge with an afrikaans equivalent,
notes, free-text descriptions with stray name tokens, home paths).

Run: python3 -m unittest discover -s test
"""
import copy
import json
import unittest

import sys
from pathlib import Path
GUI_MOCK = Path(__file__).resolve().parent / "gui-mock"
sys.path.insert(0, str(GUI_MOCK))

from dump_snap import (sanitize_snap, RESERVED_PERSON_NAMES,
                       RESERVED_PERSON_RE, RESERVED_SEGMENTS)


def person(pid, name, groups=(), note=None, state="created"):
    return {
        "id": pid, "name": name, "state": state, "note": note,
        "primary_face_id": None, "primary_pinned": 0, "created_at": "2026-01-01 00:00:00",
        "groups": list(groups),
        "counts": {"total": 0, "provisional": 0, "confirmed": 0, "rejected": 0},
    }


def face(fid, pid, name, seq=1, description=None):
    return {
        "id": fid, "image_id": fid, "person_id": pid, "x": 0, "y": 0, "w": 1, "h": 1,
        "name": name, "seq": seq, "description": description, "confidence": 0.9,
        "link_status": "provisional", "state": "created", "rotation": 0,
        "import_id": 1, "created_at": "2026-01-01 00:00:00",
    }


def raw_snap():
    return {
        "persons": [
            person(1, "Annette Botha (Pompie)", ["Familie|Botha", "Friends|PHS"], note="Pompie"),
            person(2, "Unknown12", ["New"]),
            person(3, "Baby Chandler", ["Familie|Chandler", "Friends"]),
            person(4, "Rejected", ["Rejected"], state="created"),
            person(5, "Rejected7", ["Rejected"], state="created"),
        ],
        "faces": [
            face(10, 1, "Annette Botha (Pompie)-1", seq=1),
            face(11, 3, "Baby Chandler-sun-2", seq=2, description="baby"),
            face(12, 1, "Annette Botha (Pompie)-scar-3", seq=3, description="scar"),
            face(13, 5, "Rejected7-1", seq=1),
        ],
        "images": [
            {"id": 20, "primary_path": "/home/stoflom/Pictures/Trees/2020/a.jpg",
             "width": 1, "height": 1, "orientation": "landscape", "rotation": 0,
             "rtype": "processed", "state": "scanned", "first_import_id": 1,
             "last_import_id": 1},
            {"id": 21, "primary_path": "/home/stoflom/scratch/b.jpg",
             "width": 1, "height": 1, "orientation": "landscape", "rotation": 0,
             "rtype": "processed", "state": "scanned", "first_import_id": 1,
             "last_import_id": 1},
        ],
        "imports": [
            {"id": 1, "path": "/home/stoflom/Pictures", "started_at": "2026-01-01 00:00:00"},
        ],
        "settings": {},
    }


class TestSanitizeSnap(unittest.TestCase):
    def setUp(self):
        self.out = sanitize_snap(copy.deepcopy(raw_snap()))

    # persons -----------------------------------------------------------
    def test_real_names_become_john_smith_n_in_id_order(self):
        names = [p["name"] for p in self.out["persons"]]
        self.assertEqual(names, ["John Smith1", "Unknown12", "John Smith2",
                                 "Rejected", "Rejected7"])

    def test_identity_is_preserved_for_identical_names(self):
        snap = raw_snap()
        snap["persons"].append(person(6, "Annette Botha (Pompie)", ["New"]))
        out = sanitize_snap(snap)
        mapped = [p["name"] for p in out["persons"] if p["id"] in (1, 6)]
        self.assertEqual(mapped[0], mapped[1])

    def test_unknown_and_system_names_stay(self):
        names = {p["name"] for p in self.out["persons"]}
        self.assertIn("Unknown12", names)
        self.assertIn("Rejected", names)
        self.assertIn("Rejected7", names)

    def test_rejected_cluster_family_stays_verbatim(self):
        # #266: every `RejectedN` cluster person is writer-owned and
        # structural — none may be rewritten (nor feed the token corpus)
        names = [p["name"] for p in self.out["persons"]]
        self.assertIn("Rejected7", names)
        labels = [f["name"] for f in self.out["faces"]]
        self.assertIn("Rejected7-1", labels)

    # notes / descriptions ----------------------------------------------
    def test_note_tokens_are_masked(self):
        p1 = next(p for p in self.out["persons"] if p["id"] == 1)
        self.assertEqual(p1["note"], "person")

    def test_free_text_description_tokens_are_masked(self):
        f2 = next(f for f in self.out["faces"] if f["id"] == 11)
        self.assertEqual(f2["description"], "person")
        f3 = next(f for f in self.out["faces"] if f["id"] == 12)
        self.assertEqual(f3["description"], "scar")  # not a name word

    def test_curated_extra_tokens_are_masked(self):
        snap = raw_snap()
        snap["persons"][0]["note"] = "Dawid"
        snap["faces"][2]["description"] = "Dawid"
        out = sanitize_snap(snap)
        self.assertEqual(out["persons"][0]["note"], "person")
        self.assertEqual(out["faces"][2]["description"], "person")

    # group paths ---------------------------------------------------------
    def test_segments_become_distinct_generics_in_first_seen_order(self):
        groups = {p["id"]: p["groups"] for p in self.out["persons"]}
        # first-seen order: Familien, Botha, Friends(in Folk|PHS), PHS,
        # then person 3's Chandler — identical literal segments share one
        # generic, distinct segments never collide.
        self.assertEqual(groups[1], ["Group1|Group2", "Group3|Group4"])
        self.assertEqual(groups[3], ["Group1|Group5", "Group3"])

    def test_reserved_seats_survive(self):
        groups = {p["id"]: p["groups"] for p in self.out["persons"]}
        self.assertEqual(groups[2], ["New"])
        self.assertEqual(groups[4], ["Rejected"])

    def test_identical_segments_share_one_generic_afrikaans_never_merges(self):
        # two persons sharing the literal segment `Friends` map to the
        # SAME generic (identical path stays one branch), but a distinct
        # afrikaans segment (`Vriende`) must get its OWN generic — the
        # naive `Vriende -> Friends` semantic mapping would have merged
        # two different branches.
        snap = raw_snap()
        snap["persons"].append(person(6, "Zorro Botha", ["Friends"]))
        snap["persons"].append(person(7, "Willem Dekker", ["Vriende"]))
        out = sanitize_snap(snap)
        g3 = next(p for p in out["persons"] if p["id"] == 3)["groups"]
        g6 = next(p for p in out["persons"] if p["id"] == 6)["groups"]
        g7 = next(p for p in out["persons"] if p["id"] == 7)["groups"]
        self.assertEqual(g3[1], g6[0])          # Friends == Friends
        self.assertNotEqual(g7[0], g3[1])       # Vriende != Friends

    def test_segment_mapping_is_deterministic(self):
        snap = raw_snap()
        out1 = sanitize_snap(copy.deepcopy(snap))
        out2 = sanitize_snap(copy.deepcopy(snap))
        self.assertEqual(out1["persons"], out2["persons"])

    # faces ---------------------------------------------------------------
    def test_face_labels_are_rebuilt_from_the_mapped_person(self):
        # the label formula is the mock's own: name|-description|-seq
        labels = {f["id"]: f["name"] for f in self.out["faces"]}
        self.assertEqual(labels[10], "John Smith1-1")
        self.assertEqual(labels[11], "John Smith2-person-2")  # desc 'baby' masked
        self.assertEqual(labels[12], "John Smith1-scar-3")
        snap2 = raw_snap()
        snap2["faces"][1]["seq"] = 7
        out2 = sanitize_snap(snap2)
        self.assertEqual(out2["faces"][1]["name"], "John Smith2-person-7")

    # paths ------------------------------------------------------------------
    def test_home_component_is_rewritten(self):
        paths = [i["primary_path"] for i in self.out["images"]]
        self.assertEqual(paths, ["/home/tester/Pictures/Trees/2020/a.jpg",
                                 "/home/tester/scratch/b.jpg"])
        self.assertEqual(self.out["imports"][0]["path"], "/home/tester/Pictures")

    def test_person_name_directories_get_injective_dir_n(self):
        # a directory segment carrying a person-name word — one Dir{n}
        # per distinct segment (Marianne and Marianne-LLD are different
        # branches and must not merge); imports inherit images' map
        snap = raw_snap()
        snap["persons"].append(person(5, "Marianne Marais", ["New"]))
        snap["images"][0]["primary_path"] = "/home/stoflom/Pictures/Marianne/2020/a.jpg"
        snap["images"][1]["primary_path"] = "/home/stoflom/Pictures/Marianne-LLD/2021/b.jpg"
        snap["imports"][0]["path"] = "/home/stoflom/Pictures/Marianne-LLD"
        out = sanitize_snap(snap)
        self.assertEqual(out["images"][0]["primary_path"],
                         "/home/tester/Pictures/Dir1/2020/a.jpg")
        self.assertEqual(out["images"][1]["primary_path"],
                         "/home/tester/Pictures/Dir2/2021/b.jpg")
        self.assertEqual(out["imports"][0]["path"], "/home/tester/Pictures/Dir2")

    def test_bare_file_names_are_not_renamed(self):
        # a person-name TOKEN appearing only in the file name keeps the
        # filename — the contract renames directory segments, not file content
        snap = raw_snap()
        snap["images"][0]["primary_path"] = "/home/stoflom/Pictures/Annette.jpg"
        out = sanitize_snap(snap)
        self.assertEqual(out["images"][0]["primary_path"], "/home/tester/Pictures/Annette.jpg")

    def test_non_home_paths_are_left_alone(self):
        snap = raw_snap()
        snap["images"].append({"id": 22, "primary_path": "/mnt/archive/x.jpg",
                               "width": 1, "height": 1, "orientation": "landscape",
                               "rotation": 0, "rtype": "processed", "state": "scanned",
                               "first_import_id": 1, "last_import_id": 1})
        out = sanitize_snap(snap)
        self.assertEqual(out["images"][2]["primary_path"], "/mnt/archive/x.jpg")

    # determinism / structural integrity -------------------------------------
    def test_deterministic(self):
        out2 = sanitize_snap(copy.deepcopy(raw_snap()))
        self.assertEqual(self.out, out2)

    def test_counts_and_ids_untouched(self):
        snap = raw_snap()
        out = sanitize_snap(copy.deepcopy(snap))
        self.assertEqual([p["id"] for p in out["persons"]], [p["id"] for p in snap["persons"]])
        self.assertEqual([f["id"] for f in out["faces"]], [f["id"] for f in snap["faces"]])
        self.assertEqual(out["persons"][0]["counts"], snap["persons"][0]["counts"])

    def test_no_real_name_token_survives(self):
        snap = raw_snap()
        out = sanitize_snap(copy.deepcopy(snap))
        blob = json.dumps(out)
        for p in snap["persons"]:
            n = p["name"]
            if n.startswith("Unknown") or n in RESERVED_PERSON_NAMES \
                    or RESERVED_PERSON_RE.match(n):
                continue
            for w in n.split():
                if len(w) >= 3:
                    self.assertNotIn(w, blob)
        for g in (g for p in snap["persons"] for g in p["groups"]):
            for seg in g.split("|"):
                if seg not in RESERVED_SEGMENTS and len(seg) >= 3:
                    self.assertNotIn(seg, blob)
        self.assertNotIn("stoflom", blob)


if __name__ == "__main__":
    unittest.main()
