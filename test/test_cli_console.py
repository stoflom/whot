"""Tests for scripts/cli_console.py and the §10 console contract (#79).

Run: python3 -m unittest discover -s test
No heavy deps: exercises Console primitives, the heartbeat, the -q
flag of all four scripts (import_roll only up to the empty-directory
exit, which runs before any model load), and the §10.3 one-full-path-
per-item verdict contract (#94) over import_roll's whole file loop
(Detector/plan_image/blake3_hex patched, temp project DB).
"""
from __future__ import annotations

import contextlib
import io
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import cli_console  # noqa: E402
import annotation_snapshot as ansi  # noqa: E402
import harvest_legacy as hl  # noqa: E402
import import_harvested as ih  # noqa: E402
import import_roll as ir  # noqa: E402

REAL_ROOT = ir.PROJECT_ROOT        # captured before any test patches it (#94)

# ---- local-config isolation (#112): hl.main()/ih.main() read the real
# project .env, so the operator's PATH_MAP (a present file, a missing file,
# any content) must never decide a console-contract test's outcome.
def _strip_path_map(module):
    orig = module.load_env

    def _load_env(path):
        env = orig(path)
        env.pop("PATH_MAP", None)
        return env

    return orig, _load_env


_HL_LOAD_ENV, _HL_LOAD_ENV_NO_PM = _strip_path_map(hl)
_IH_LOAD_ENV, _IH_LOAD_ENV_NO_PM = _strip_path_map(ih)


def setUpModule() -> None:
    hl.load_env = _HL_LOAD_ENV_NO_PM
    ih.load_env = _IH_LOAD_ENV_NO_PM


def tearDownModule() -> None:
    hl.load_env = _HL_LOAD_ENV
    ih.load_env = _IH_LOAD_ENV


def run_captured(fn, *args, **kw):
    """Run fn(*args) capturing stdout/stderr; returns (rc, out, err)."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = fn(*args, **kw)
    return rc, out.getvalue(), err.getvalue()


BANNER = "=" * 64


# ----------------------------------------------------------------- Console

class ConsoleTests(unittest.TestCase):
    def test_header_banner_and_started(self):
        ui = cli_console.Console()
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            ui.header("WhoT x — mode", "param : 1")
        text = out.getvalue()
        self.assertEqual(text.count(BANNER), 2)
        self.assertIn("WhoT x — mode", text)
        self.assertIn("  param : 1", text)
        self.assertIn("started   :", text)
        self.assertIn("UTC", text)
        self.assertEqual(err.getvalue(), "")

    def test_status_printed_by_default_suppressed_when_quiet(self):
        ui = cli_console.Console()
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            ui.status("progress 1")
        self.assertIn("progress 1", buf.getvalue())

        quiet = cli_console.Console(quiet=True)
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            quiet.status("progress 1")
        self.assertEqual(buf.getvalue(), "")

    def test_summary_always_printed_even_quiet(self):
        quiet = cli_console.Console(quiet=True)
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            quiet.header("h")
            quiet.status("hidden")
            quiet.summary("", "  key   1")
        text = buf.getvalue()
        self.assertIn("h", text)
        self.assertNotIn("hidden", text)
        self.assertIn("  key   1", text)

    def test_error_on_stderr_never_quiet_suppressed(self):
        quiet = cli_console.Console(quiet=True)
        with contextlib.redirect_stderr(io.StringIO()) as err, \
                contextlib.redirect_stdout(io.StringIO()) as out:
            quiet.error("boom")
        self.assertIn("boom", err.getvalue())
        self.assertEqual(out.getvalue(), "")

    def test_heartbeat_ticks_while_silent(self):
        old = cli_console.BEAT_INTERVAL
        cli_console.BEAT_INTERVAL = 0.1
        try:
            ui = cli_console.Console()
            with contextlib.redirect_stdout(io.StringIO()) as buf:
                ui.start_beat("slow phase")
                import time
                time.sleep(0.35)
                ui.stop_beat()
            self.assertIn("… slow phase", buf.getvalue())
            self.assertIn("s", buf.getvalue())
        finally:
            cli_console.BEAT_INTERVAL = old

    def test_heartbeat_silent_when_quiet(self):
        old = cli_console.BEAT_INTERVAL
        cli_console.BEAT_INTERVAL = 0.1
        try:
            ui = cli_console.Console(quiet=True)
            with contextlib.redirect_stdout(io.StringIO()) as buf:
                ui.start_beat("slow phase")
                import time
                time.sleep(0.3)
                ui.stop_beat()
            self.assertEqual(buf.getvalue(), "")
        finally:
            cli_console.BEAT_INTERVAL = old

    def test_status_resets_heartbeat_silence(self):
        """No heartbeat line when something else printed in the interval."""
        old = cli_console.BEAT_INTERVAL
        cli_console.BEAT_INTERVAL = 0.1
        try:
            ui = cli_console.Console()
            with contextlib.redirect_stdout(io.StringIO()) as buf:
                ui.start_beat("phase")
                import time
                time.sleep(0.06)
                ui.status("just printed")   # resets the silence window
                time.sleep(0.06)
                ui.stop_beat()
            text = buf.getvalue()
            self.assertIn("just printed", text)
            self.assertNotIn("… phase", text)
        finally:
            cli_console.BEAT_INTERVAL = old

    def test_add_quiet_arg_parses_both_spellings(self):
        import argparse
        ap = argparse.ArgumentParser()
        cli_console.add_quiet_arg(ap)
        self.assertFalse(ap.parse_args([]).quiet)
        self.assertTrue(ap.parse_args(["-q"]).quiet)
        self.assertTrue(ap.parse_args(["--quiet"]).quiet)


# ------------------------------------------------- per-script §10 contract

class ImportRollConsoleTests(unittest.TestCase):
    """main() on an empty dir exits before any model/DB work."""

    def run_main(self, *args):
        with tempfile.TemporaryDirectory() as d:
            return run_captured(ir.main, [*args, str(Path(d))])

    def test_default_header_then_status_then_summary(self):
        rc, out, err = self.run_main()
        self.assertEqual(rc, 1)                 # no image files
        self.assertLess(out.index(BANNER), out.index("scanning"))
        self.assertIn("WhoT import_roll", out)
        self.assertIn("scanning ", out)
        self.assertIn("no image files in", out)  # final line = summary

    def test_quiet_only_header_and_summary(self):
        rc, out, err = self.run_main("-q")
        self.assertEqual(rc, 1)
        self.assertIn(BANNER, out)
        self.assertIn("WhoT import_roll", out)
        self.assertNotIn("scanning", out)       # status suppressed
        self.assertIn("no image files in", out)  # summary always

    def test_flag_spelling(self):
        rc, out, err = self.run_main("--quiet")
        self.assertEqual(rc, 1)
        self.assertNotIn("scanning", out)


class HarvestLegacyConsoleTests(unittest.TestCase):
    def run_main(self, *args):
        return run_captured(hl.main, list(args))

    def test_list_sources_is_data_never_quiet_suppressed(self):
        rc, out, err = self.run_main("--list-sources", "-q")
        self.assertEqual(rc, 0)
        self.assertIn(BANNER, out)              # header still first
        self.assertIn("kind=", out)             # the requested data
        self.assertIn("canonical harvest sources", out)

    def test_header_before_any_harvest_work(self):
        rc, out, err = self.run_main("--sources", "not-a-source",
                                     "--dry-run", "-q")
        self.assertEqual(rc, 1)
        # header is the first thing on stdout, before the error on stderr
        self.assertTrue(out.startswith(BANNER))
        self.assertIn("WhoT harvest_legacy", out)
        self.assertNotIn("scanning", out)       # -q: no phase status
        # errors always show up, quiet or not (§10.4)
        self.assertIn("error: not a harvest source", err)


class ImportHarvestedConsoleTests(unittest.TestCase):
    def test_header_then_error_for_missing_staging(self):
        rc, out, err = run_captured(
            ih.main, ["/nonexistent-staging.db", "-q"])
        self.assertEqual(rc, 1)
        self.assertTrue(out.startswith(BANNER))
        self.assertIn("WhoT import_harvested", out)
        self.assertIn("staging     : /nonexistent-staging.db", out)
        self.assertIn("error: staging DB not found", err)   # stderr, always

    def test_default_mode_shows_status_lines(self):
        rc, out, err = run_captured(ih.main, ["/nonexistent-staging.db"])
        self.assertEqual(rc, 1)
        self.assertIn(BANNER, out)
        self.assertIn("error: staging DB not found", err)


class AnnotationSnapshotConsoleTests(unittest.TestCase):
    """Console channel = stderr; stdout stays a pure data channel (§10.6)."""

    def build_db(self, tmp: Path) -> Path:
        import sqlite3
        schema = Path(__file__).resolve().parent.parent / "database" / "schema.sql"
        db = tmp / "faces.db"
        con = sqlite3.connect(db)
        con.executescript(schema.read_text())
        con.commit()
        con.close()
        return db

    def test_export_stdout_is_pure_json_console_on_stderr(self):
        with tempfile.TemporaryDirectory() as d:
            db = self.build_db(Path(d))
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = ansi.main(["export", str(db)])
            self.assertEqual(rc, 0)
            import json
            data = json.loads(out.getvalue())   # parseable = no banner leaked
            self.assertEqual(data["format"], 1)
            err_text = err.getvalue()
            self.assertIn(BANNER, err_text)
            self.assertIn("WhoT annotation_snapshot — export", err_text)
            self.assertIn("persons", err_text)  # summary always (§10.1)

    def test_quiet_flag_before_and_after_subcommand(self):
        with tempfile.TemporaryDirectory() as d:
            db = self.build_db(Path(d))
            for argv in (["-q", "export", str(db)],
                         ["export", "-q", str(db)]):
                out, err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), \
                        contextlib.redirect_stderr(err):
                    rc = ansi.main(argv)
                self.assertEqual(rc, 0, argv)
                import json
                json.loads(out.getvalue())
                self.assertIn(BANNER, err.getvalue(), argv)

    def test_restore_missing_db_errors_on_stderr(self):
        # restore's console channel is stderr too (§10.6: one rule per script)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = ansi.main(["restore", "/nonexistent.json", "/nope.db", "-q"])
        self.assertEqual(rc, 1)
        self.assertEqual(out.getvalue(), "")      # nothing on stdout
        self.assertIn(BANNER, err.getvalue())     # header still first
        self.assertIn("no database at", err.getvalue())  # error, not silenced


# ------------------------------------------- §10.3 one full path per item (#94)

class ItemOutputContractTests(unittest.TestCase):
    """import_roll's file loop prints `[i/N] <full path>` once; the verdict
    that follows (no faces / imported / skipped / FAILED) never repeats the
    path, while diagnostics outside the loop (the closing failure list)
    keep it. main() runs against a miniature PROJECT_ROOT with Detector,
    plan_image and blake3_hex patched — no model, no decoding, and a
    throwaway database."""

    def _project(self) -> Path:
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        (tmp / "database").mkdir()
        (tmp / "data").mkdir()
        (tmp / ".env").write_text("FACES_DB=data/faces.db\n")
        schema = (REAL_ROOT / "database" / "schema.sql").read_text()
        (tmp / "database" / "schema.sql").write_text(schema)
        con = sqlite3.connect(tmp / "data" / "faces.db")
        con.executescript(schema)
        con.close()
        roll = tmp / "roll"
        roll.mkdir()
        (roll / "shot.jpg").write_bytes(b"never decoded - plan_image is patched")
        return tmp

    def _run(self, *args: str, faces: int = 0, plan_exc: Exception | None = None,
             digest: str = "a" * 64, seed: bool = False):
        tmp = self._project()
        roll = tmp / "roll"
        img = roll / "shot.jpg"
        if seed:                       # an image already in the DB → skip branch
            con = sqlite3.connect(tmp / "data" / "faces.db")
            con.execute(
                "INSERT INTO images(content_hash, width, height, primary_path,"
                " state, created_at) VALUES (?,?,?,?,?,?)",
                (digest, 8, 8, str(img), "scanned", "t"))
            con.commit()
            con.close()
        plan = ir.ImportPlan(
            content_hash=digest, path=str(img), state="scanned", width=8, height=8,
            orientation="landscape", type="processed", icon_jpeg=b"i",
            preview_jpeg=b"p",
            detections=[
                ir.Detection(
                    box=(1, 1, 4, 4), det_score=0.9,
                    embedding=np.array([1.0, 0.0, 0.0, 0.0], np.float32),
                    crop_jpeg=b"c")
                for _ in range(faces)
            ])
        patches = [
            mock.patch.object(ir, "PROJECT_ROOT", tmp),
            mock.patch.object(ir, "blake3_hex", return_value=digest),
            mock.patch.object(ir, "Detector", return_value=object()),
            mock.patch.object(
                ir, "plan_image",
                **({"side_effect": plan_exc} if plan_exc
                   else {"return_value": plan})),
        ]
        with contextlib.ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            rc, out, err = run_captured(ir.main, [*args, str(roll)])
        return rc, out, err, img

    @staticmethod
    def _path_lines(out: str, img: Path) -> list[str]:
        return [l for l in out.splitlines() if str(img) in l]

    def test_progress_line_is_the_only_path_on_stdout(self):
        rc, out, err, img = self._run(faces=1)
        self.assertEqual(rc, 0, err)
        self.assertEqual(self._path_lines(out, img), [f"[1/1] {img}"], out)
        self.assertIn("  imported: 1 face(s), 1 person(s)", out)
        self.assertFalse([l for l in out.splitlines()
                          if l.startswith("  ") and str(img) in l], out)

    def test_no_faces_verdict_without_path(self):
        rc, out, err, img = self._run(faces=0)
        self.assertEqual(rc, 0, err)
        self.assertEqual(self._path_lines(out, img), [f"[1/1] {img}"], out)
        self.assertIn("  no faces", out.splitlines())
        self.assertIn("1 without faces", out)          # summary unchanged

    def test_skip_verdict_without_path(self):
        rc, out, err, img = self._run(digest="b" * 64, seed=True)
        self.assertEqual(rc, 0, err)
        self.assertEqual(self._path_lines(out, img), [f"[1/1] {img}"], out)
        self.assertIn("  already in database — skipping", out)

    def test_failed_verdict_is_pathless_but_closing_list_keeps_the_path(self):
        rc, out, err, img = self._run(plan_exc=RuntimeError("boom"))
        self.assertEqual(rc, 1)
        self.assertEqual(self._path_lines(out, img), [f"[1/1] {img}"], out)
        self.assertIn("  FAILED: boom", err)            # verdict only, in-loop
        self.assertIn("failed 1 file(s)", err)
        self.assertIn(f"  {img}: boom", err)            # closing list: full path

    def test_failed_under_quiet_still_identifies_the_file(self):
        rc, out, err, img = self._run("-q", plan_exc=RuntimeError("boom"))
        self.assertEqual(rc, 1)
        self.assertNotIn(str(img), out)                 # -q: no status at all
        self.assertIn(f"  {img}: boom", err)            # §10.4: errors survive


if __name__ == "__main__":
    unittest.main()
