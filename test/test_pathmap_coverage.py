"""Tests for scripts/pathmap.py and the coverage threshold (#83/#85).

Run: python3 -m unittest discover -s test
Pure functions only — no harvest or import run needed.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from pathmap import apply_path_map, local_roots, parse_path_map  # noqa: E402
import harvest_legacy as hl  # noqa: E402
import import_harvested as ih  # noqa: E402


SAMPLE = """
# legacy root -> local root
D:/images/PicFiles   = /run/media/stoflom/Seagate Expansion Drive/LIVE/PICTURES/PicFiles
D:/LIVE = /run/media/stoflom/Seagate Expansion Drive/LIVE
\\\\NAS\\photos = /mnt/nas/photos
"""


class PathMapTests(unittest.TestCase):
    def setUp(self):
        self.rules = parse_path_map(SAMPLE)

    def test_parse_three_rules_longest_first(self):
        self.assertEqual(len(self.rules), 3)
        olds = [r[0] for r in self.rules]
        self.assertEqual(olds[0], "d:/images/picfiles")   # 21 chars, longest
        self.assertEqual(olds[1], "//nas/photos")         # 12 chars
        self.assertEqual(olds[2], "d:/live")              # 7 chars

    def test_rewrite_keeps_remainder(self):
        self.assertEqual(
            apply_path_map("D:/images/PicFiles/Becks/P1.JPG", self.rules),
            "/run/media/stoflom/Seagate Expansion Drive/LIVE/PICTURES/PicFiles/Becks/P1.JPG")

    def test_case_and_separator_insensitive_match(self):
        self.assertEqual(
            apply_path_map("d:\\images\\picfiles\\Becks\\P1.JPG", self.rules),
            "/run/media/stoflom/Seagate Expansion Drive/LIVE/PICTURES/PicFiles/Becks/P1.JPG")

    def test_exact_prefix_match(self):
        self.assertEqual(
            apply_path_map("D:/LIVE", self.rules),
            "/run/media/stoflom/Seagate Expansion Drive/LIVE")

    def test_prefix_boundary(self):
        """D:/images2 must NOT match the D:/images/PicFiles rule."""
        self.assertIsNone(apply_path_map("D:/images2/x.jpg", self.rules))
        self.assertIsNone(apply_path_map("/elsewhere/x.jpg", self.rules))

    def test_longest_prefix_wins(self):
        rules = parse_path_map("D:/x = /a\nD:/x/y = /b")
        self.assertEqual(apply_path_map("D:/x/y/z.jpg", rules), "/b/z.jpg")
        self.assertEqual(apply_path_map("D:/x/q.jpg", rules), "/a/q.jpg")

    def test_backslash_source(self):
        self.assertEqual(
            apply_path_map("\\\\NAS\\photos\\a\\b.jpg", self.rules),
            "/mnt/nas/photos/a/b.jpg")

    def test_no_globbing_literal(self):
        rules = parse_path_map("D:/pics/* = /mnt/x")
        self.assertEqual(apply_path_map("D:/pics/*/y.jpg", rules), "/mnt/x/y.jpg")
        self.assertEqual(apply_path_map("D:/pics/actual.jpg", rules), None)

    def test_comments_and_blanks_ignored(self):
        rules = parse_path_map("# c\n\n   \nD:/a = /b\n")
        self.assertEqual(len(rules), 1)

    def test_bad_line_raises(self):
        with self.assertRaises(ValueError):
            parse_path_map("D:/no-separator")
        with self.assertRaises(ValueError):
            parse_path_map(" = /target")

    def test_local_roots(self):
        roots = local_roots(self.rules)
        self.assertEqual(str(roots[-1]), "/run/media/stoflom/Seagate Expansion Drive/LIVE")


class CoverageThresholdTests(unittest.TestCase):
    """§8.6: >20% unusable => warning percent, else None (#83)."""

    def test_below_threshold_is_none(self):
        self.assertIsNone(hl.coverage_pct(1, 10))     # exactly 10%? no: 1/10=10%
        self.assertIsNone(hl.coverage_pct(2, 10))     # exactly 20% — healthy edge
        self.assertIsNone(hl.coverage_pct(0, 1000))
        self.assertIsNone(hl.coverage_pct(0, 0))      # empty run: no warning

    def test_above_threshold_returns_percent(self):
        self.assertAlmostEqual(hl.coverage_pct(3, 10), 30.0)
        self.assertAlmostEqual(hl.coverage_pct(17816 + 632, 18703), 98.6, places=1)

    def test_import_matches_harvest(self):
        """Both scripts share the threshold logic (§8.6)."""
        self.assertEqual(hl.UNUSABLE_THRESHOLD, ih.UNUSABLE_THRESHOLD)
        self.assertEqual(hl.coverage_pct(5, 10), ih.coverage_pct(5, 10))

    def test_custom_threshold(self):
        self.assertIsNone(hl.coverage_pct(1, 10, threshold=0.20))
        self.assertAlmostEqual(hl.coverage_pct(3, 10, threshold=0.25), 30.0)


if __name__ == "__main__":
    unittest.main()
