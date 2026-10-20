#!/usr/bin/env python3
"""pathmap.py — legacy path-map file for harvest + import (scripts-design §8.6).

Rewrites legacy path prefixes (`D:/LIVE`, old NAS roots) onto the local
archive — a *lookup aid only*: identity stays the BLAKE3 hash (J2/H3);
an ambiguous or still-unmapped path is counted and logged, never
guessed (H4).

File format (#85 — a text file, one mapping per line):

    # comment lines and blank lines are ignored
    D:/images/PicFiles  =  /run/media/.../LIVE/PICTURES/PicFiles
    \\NAS\\photos        =  /mnt/nas/photos
    !D:/LIVE/PICTURES/PicFiles/SourcePictures      <- deliberately ignored (#86)

- `=` separates OLD from NEW (whitespace around both sides trimmed);
- longest-prefix-first, case-insensitive match;
- forward and back slashes are normalised to `/` before matching;
- plain prefix rewrite — no globbing (predictable, auditable);
- a leading `!` marks a prefix as **excluded** (#86, §8.6): rows under
  it are counted `excluded`, never warned about, never rescued.
"""
from __future__ import annotations

from pathlib import Path

# a rule is (old_norm, old_display, new_display); matching uses old_norm
# (slashes normalised, case-folded, no trailing slash), the rewrite keeps
# the NEW side exactly as the file states it.
Rule = tuple[str, str, str]


def _slashes(p: str) -> str:
    """Forward slashes, no trailing slash (length-preserving except the tail)."""
    return p.replace("\\", "/").rstrip("/")


def parse_path_map(text: str) -> tuple[list[Rule], list[str]]:
    """Text -> (rewrite rules longest OLD prefix first, excluded prefixes).

    Excludes (#86, §8.6 v4.1) are `'!' + PREFIX` lines: catalog prefixes
    deliberately ignored by this run — same prefix rules as rewrites.
    """
    rules: list[Rule] = []
    excludes: list[str] = []
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("!"):
            excl = _slashes(line[1:].strip())
            if not excl:
                raise ValueError(f"path map line {n}: empty '!' exclude")
            excludes.append(excl.casefold())
            continue
        old, sep, new = line.partition("=")
        if not sep or not old.strip() or not new.strip():
            raise ValueError(
                f"path map line {n}: wants 'OLD_PREFIX = NEW_PREFIX', got {raw!r}")
        old_d, new_d = _slashes(old.strip()), _slashes(new.strip())
        rules.append((old_d.casefold(), old_d, new_d))
    rules.sort(key=lambda r: -len(r[0]))
    excludes.sort(key=lambda pr: -len(pr))
    return rules, excludes


def load_path_map(path: Path) -> tuple[list[Rule], list[str]]:
    return parse_path_map(path.read_text())


def is_excluded(path: str, excludes: list[str]) -> bool:
    """True when *path* falls under one of the excluded prefixes (#86)."""
    if not excludes:
        return False
    folded = _slashes(path).casefold()
    for pre in excludes:
        if folded == pre or (len(folded) > len(pre)
                             and folded[len(pre)] == "/"
                             and folded.startswith(pre)):
            return True
    return False


def apply_path_map(path: str, rules: list[Rule]) -> str | None:
    """Rewrite *path* through the rules; None when no prefix matches.

    Case/separator-insensitive on the prefix; the remainder is appended
    to the NEW side verbatim.  (Case-folding is length-preserving for
    the ASCII drive-letter/NAS paths this exists for; exotic Unicode
    prefixes are out of scope — the result is then simply not rewritten.)
    """
    if not rules:
        return None
    disp = _slashes(path)
    folded = disp.casefold()
    for old_n, _old_d, new in rules:
        if folded == old_n:
            return new
        if (len(folded) > len(old_n) and folded[len(old_n)] == "/"
                and folded.startswith(old_n)):
            return new + disp[len(old_n):]
    return None


def local_roots(rules: list[Rule]) -> list[Path]:
    """The NEW sides of the map — trees the harvester may index."""
    return [Path(new) for _old_n, _old_d, new in rules]
