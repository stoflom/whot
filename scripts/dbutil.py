"""Shared stdlib-only helpers for the WhoT scripts.

The .env reader, the read-only connection, the coverage warning and the
§4.35 seat derivation each used to live in one copy per script and had
drifted (a missing `.env` raised in one script but not another; one
read-only URI was un-quoted; the seat loop was re-typed three times).
They live here now, ONE copy each — the same shared-module precedent as
`cli_console.py`. Scripts do `import dbutil` and call `dbutil.X` so the
tests can patch a single home.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import urllib.parse
import json
from pathlib import Path

# ---------------------------------------------------------------------- .env

def _expand_refs(raw: dict[str, str]) -> dict[str, str]:
    """The `${VAR}` expansion shared by `load_env` and `resolve_env`
    (#302): references resolve against the map's OTHER keys first (4
    passes), then against the real process environment (`${HOME}`,
    `${USER}`, …); references still unresolvable stay literal."""
    for _ in range(4):                      # resolve nested ${VAR}
        for k, v in raw.items():
            if "${" in v:
                for ref, rv in raw.items():
                    v = v.replace("${" + ref + "}", rv)
                raw[k] = v
    for k, v in raw.items():                # then references to the real
        if "${" in v:                       # environment (${HOME}, ${USER})
            for ref, rv in os.environ.items():
                v = v.replace("${" + ref + "}", rv)
            raw[k] = v
    return raw


def load_env(path: Path) -> dict[str, str]:
    """Parse KEY=VALUE lines with ${VAR} references; no external dependency.

    A missing file yields `{}` (the caller's defaults apply) — it never
    raises, so a `.env` absence is not an error. Nested `${VAR}` resolve
    against the file (up to 4 passes), then against the real process
    environment (`${HOME}`, `${USER}`, …); refs still unresolvable stay
    literal.
    """
    raw: dict[str, str] = {}
    if not path.exists():
        return raw
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        raw[key.strip()] = val.strip().strip('"').strip("'")
    return _expand_refs(raw)


def user_config_path() -> Path:
    """The user whotrc.json (#301) — the installed app's config file and
    `resolve_env`'s fallback source: `$WHOT_CONFIG_DIR` overrides (the
    test hook), then `$XDG_CONFIG_HOME/whot`, then the platform
    equivalent of `~/.config/whot/whotrc.json` (`~/Library/Application
    Support/whot` on macOS, `%APPDATA%\\whot` on Windows) — the same
    table as the Rust side (backend-design §2)."""
    override = os.environ.get("WHOT_CONFIG_DIR")
    if override:
        return Path(override) / "whotrc.json"
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg) / "whot" / "whotrc.json"
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "whot" / "whotrc.json"
    if sys.platform == "win32":
        return home / "AppData" / "Roaming" / "whot" / "whotrc.json"
    return home / ".config" / "whot" / "whotrc.json"


def resolve_env(project_root: Path) -> dict[str, str]:
    """The environment source of record (#302): a `.env` in
    *project_root* when it exists (it wins — parsed with `load_env`,
    unchanged semantics); otherwise the user config's `env` object
    (`user_config_path()` — backend-design §2), expanded with the same
    `${VAR}` algorithm. A missing file, a missing `env` object, or a
    malformed JSON yields `{}` — never raises, exactly like `load_env`.
    """
    env_file = Path(project_root) / ".env"
    if env_file.exists():
        return load_env(env_file)
    try:
        data = json.loads(user_config_path().read_text())
    except (OSError, ValueError):
        return {}
    env = data.get("env")
    if not isinstance(env, dict):
        return {}
    return _expand_refs(
        {str(k): str(v) for k, v in env.items() if isinstance(v, str)})

# ---------------------------------------------------------------- read-only

def open_ro(db_path: Path, immutable: bool = False) -> sqlite3.Connection:
    """Read-only connection to a source DB (H1). The path is URL-quoted so a
    `#` or `?` in it can't truncate the URI. `immutable` also forbids the
    journal dance next to the file — required for the Lightroom catalog,
    which is checkpointed and lives on the read-only archive."""
    uri = "file:" + urllib.parse.quote(str(db_path)) + "?mode=ro" \
        + ("&immutable=1" if immutable else "")
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    return con

# ------------------------------------------------------------------ coverage

UNUSABLE_THRESHOLD = 0.20      # >20% unusable rows => loud warning (#83)

def coverage_pct(unusable: int, total: int,
                 threshold: float = UNUSABLE_THRESHOLD) -> float | None:
    """Share of unusable rows in percent, or None while healthy (#8.6).

    Pure function so the threshold logic is testable without a harvest.
    """
    if total <= 0 or unusable * (1.0 / threshold) <= total:
        return None
    return 100.0 * unusable / total

# ---------------------------------------------------------------- seat (§4.35)

SEATS = ("New", "Accepted", "Rejected")

def seat_for(con: sqlite3.Connection, person_id: int) -> str:
    """§4.35 seat derivation: any provisional face ⇒ `New`, else
    `Accepted`. (Every rejected face is on the system person by the time
    a caller needs this.)"""
    row = con.execute(
        "SELECT EXISTS(SELECT 1 FROM faces WHERE person_id = ?"
        "               AND link_status = 'provisional')",
        (person_id,)).fetchone()
    return "New" if row[0] else "Accepted"

def reseat_person(con: sqlite3.Connection, person_id: int,
                  seats: tuple = SEATS, must_exist: bool = False) -> None:
    """Insert-first seat re-derivation for one person (#165/§4.35): a
    groupless person gets its seat, a seat-only person re-derives from the
    faces it now holds; a real group (or a reject-bin person's `Rejected`
    seat — the `RejectedN` family, #266 —) is
    never touched. `must_exist` skips a person deleted earlier in the run
    (the importer's shell sweep)."""
    if must_exist and not con.execute(
            "SELECT 1 FROM persons WHERE id=?", (person_id,)).fetchone():
        return
    rows = [r[0] for r in con.execute(
        "SELECT path FROM person_groups WHERE person_id=?", (person_id,))]
    if rows and "Rejected" in rows:
        return                             # the system person is never re-seated
    seat = seat_for(con, person_id)
    if not rows:
        con.execute("INSERT INTO person_groups(person_id, path) VALUES (?, ?)",
                    (person_id, seat))
    elif all(r in seats for r in rows) and seat not in rows:
        # insert-first: the fresh seat lands before the stale one drops
        con.execute("INSERT OR IGNORE INTO person_groups(person_id, path) VALUES (?, ?)",
                    (person_id, seat))
        con.execute("DELETE FROM person_groups WHERE person_id=? AND path != ?",
                    (person_id, seat))
