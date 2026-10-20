#!/usr/bin/env python3
"""cli_console.py — shared CLI console for all WhoT scripts (scripts-design §10).

One contract, four scripts:

  * ``header()``  — printed first, immediately after argument parsing and
    cheap input resolution, *before* anything that can take a moment
    (model load, archive walk, VACUUM, DB scan).  Always printed, even
    under ``-q``.
  * ``status()``  — phase/progress lines while working; suppressed by
    ``-q``.
  * ``start_beat()``/``stop_beat()`` — a daemon heartbeat that prints
    ``… <phase> — <N>s`` at most every ``BEAT_INTERVAL`` seconds *and*
    only when nothing else was printed in that interval, so a script
    inside one long silent operation still proves it is alive.
    Suppressed by ``-q``; always stopped before the summary.
  * ``summary()`` — the final result block; always printed, whatever the
    exit code.
  * ``error()``   — diagnostics on **stderr**; never suppressed by
    ``-q``.

``-q`` / ``--quiet`` therefore yields exactly: header + final summary
(+ requested data on stdout — JSON, listings — which are outputs, not
status, and are never suppressed).

The console output *stream* is resolved at write time, so tests can
redirect stdout/stderr around ``main()``.  Scripts whose stdout is a
data channel (annotation_snapshot: JSON on stdout) construct the console
with ``use_stderr=True`` and route header/status/summary to stderr —
one rule per script (§10.6).
"""
from __future__ import annotations

import argparse
import sys
import threading
import time

BANNER = "=" * 64
BEAT_INTERVAL = 10.0        # seconds between heartbeats (§10.3)
_QUIET_HELP = ("quiet: print only the startup header and the final "
               "summary (no status updates)")


def add_quiet_arg(parser: argparse.ArgumentParser) -> None:
    """The -q/--quiet flag, parsed identically by every script (§10.5)."""
    parser.add_argument("-q", "--quiet", action="store_true", help=_QUIET_HELP)


def _reline() -> None:
    """Line-buffer stdout so progress is visible even when piped/redirected."""
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError, OSError):
        pass


class Console:
    """Header/status/summary/error channel of one script run (§10)."""

    def __init__(self, quiet: bool = False, use_stderr: bool = False):
        self.quiet = quiet
        self.use_stderr = use_stderr     # stdout is a data channel (§10.6)
        self._lock = threading.Lock()
        self._last_output = time.monotonic()
        self._beat_stop: threading.Event | None = None
        self._beat_phase = ""
        self._beat_t0 = 0.0
        _reline()

    # ------------------------------------------------------------ streams

    @property
    def out(self):
        """Console stream, resolved per write (redirect-friendly)."""
        return sys.stderr if self.use_stderr else sys.stdout

    def _now(self) -> float:
        return time.monotonic()

    # -------------------------------------------------------- primitives

    def header(self, title: str, *lines: str) -> None:
        """Banner + script + parameters + UTC start time; always printed."""
        with self._lock:
            print(BANNER, file=self.out)
            print(title, file=self.out)
            for line in lines:
                print(f"  {line}", file=self.out)
            start = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())  # #40: UTC
            print(f"  started   : {start} UTC", file=self.out)
            print(BANNER, file=self.out, flush=True)
            self._last_output = self._now()

    def status(self, msg: str) -> None:
        """Progress line; suppressed by -q (§10.3)."""
        if self.quiet:
            return
        with self._lock:
            print(msg, file=self.out, flush=True)
            self._last_output = self._now()

    def summary(self, *lines: str) -> None:
        """Final result block; always printed, whatever the exit code."""
        with self._lock:
            for line in lines:
                print(line, file=self.out, flush=True)
            self._last_output = self._now()

    def error(self, msg: str) -> None:
        """Diagnostic on stderr; never suppressed by -q (§10.4)."""
        with self._lock:
            print(msg, file=sys.stderr, flush=True)
            self._last_output = self._now()

    # -------------------------------------------------------- heartbeat

    def start_beat(self, phase: str) -> None:
        """Tick every BEAT_INTERVAL while silent inside a long phase."""
        if self.quiet or self._beat_stop is not None:
            return
        self._beat_phase = phase
        self._beat_t0 = self._now()
        stop = threading.Event()
        self._beat_stop = stop

        def run() -> None:
            while not stop.wait(BEAT_INTERVAL):
                now = self._now()
                with self._lock:
                    if now - self._last_output < BEAT_INTERVAL:
                        continue        # something printed recently
                    self._last_output = now
                    print(f"… {self._beat_phase} — {int(now - self._beat_t0)}s",
                          file=self.out, flush=True)

        threading.Thread(target=run, daemon=True, name="cli-beat").start()

    def set_phase(self, phase: str) -> None:
        """Rename the heartbeat's phase without restarting it."""
        self._beat_phase = phase

    def stop_beat(self) -> None:
        """Stop the heartbeat (idempotent); call before the summary."""
        stop, self._beat_stop = self._beat_stop, None
        if stop is not None:
            stop.set()
