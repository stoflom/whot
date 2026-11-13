"""dbutil.resolve_env / user_config_path — the #302 environment source
of record: a `.env` in the project root wins; otherwise the user
whotrc.json's `env` object is read and expanded with the same `${VAR}`
algorithm. Missing or malformed sources yield {} — never raises."""

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import dbutil  # noqa: E402


@pytest.fixture
def cfg_dir(tmp_path, monkeypatch):
    """Isolate the user config + the expansion environment per test."""
    monkeypatch.setenv("WHOT_CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    return tmp_path


def write_user_config(cfg_dir, env):
    d = cfg_dir / "cfg"
    d.mkdir(parents=True, exist_ok=True)
    (d / "whotrc.json").write_text(json.dumps({"env": env}))


def write_raw_config(cfg_dir, data):
    d = cfg_dir / "cfg"
    d.mkdir(parents=True, exist_ok=True)
    (d / "whotrc.json").write_text(json.dumps(data))


# ------------------------------------------------------------- .env wins

def test_dotenv_present_wins(cfg_dir):
    """A `.env` in the project root is parsed with load_env semantics —
    the user config is never consulted, even when it disagrees."""
    root = cfg_dir / "proj"
    root.mkdir(parents=True)
    (root / ".env").write_text("FACES_DB=${DATA_DIR}/faces.db\nDATA_DIR=data\n")
    write_user_config(cfg_dir, {"FACES_DB": "should-not-win"})
    env = dbutil.resolve_env(root)
    assert env["FACES_DB"] == "data/faces.db"        # nested ${VAR} resolved
    assert "DATA_DIR" in env


def test_dotenv_missing_is_not_an_error(cfg_dir):
    """No `.env`, no user config → {} (the caller's defaults apply)."""
    assert dbutil.resolve_env(cfg_dir / "empty-root") == {}


# ------------------------------------------------- the user config fallback

def test_user_config_env_object(cfg_dir):
    """Without a `.env` the user whotrc.json's `env` object is the source."""
    write_user_config(cfg_dir, {"FACES_DB": "${DATA_DIR}/faces.db",
                                "DATA_DIR": "data"})
    env = dbutil.resolve_env(cfg_dir / "proj")
    assert env["FACES_DB"] == "data/faces.db"
    assert env["DATA_DIR"] == "data"


def test_user_config_expands_process_env(cfg_dir):
    """`${HOME}` and friends resolve against the real environment after
    the map's own keys."""
    write_user_config(cfg_dir, {"DEFAULT_IMAGES_DIR": "${HOME}/Pictures"})
    env = dbutil.resolve_env(cfg_dir / "proj")
    assert env["DEFAULT_IMAGES_DIR"] == str(cfg_dir / "home" / "Pictures")


def test_user_config_unresolvable_stays_literal(cfg_dir):
    write_user_config(cfg_dir, {"X": "${NOT_A_REAL_VAR_302}/x"})
    assert dbutil.resolve_env(cfg_dir / "proj")["X"] == "${NOT_A_REAL_VAR_302}/x"


def test_user_config_gui_keys_ignored(cfg_dir):
    """Only the `env` object is an environment source — GUI settings are
    not environment keys."""
    write_raw_config(cfg_dir, {"cluster_threshold": 0.5, "env": {"A": "b"}})
    env = dbutil.resolve_env(cfg_dir / "proj")
    assert env == {"A": "b"}


def test_user_config_non_string_values_skipped(cfg_dir):
    write_user_config(cfg_dir, {"A": "b", "N": 3, "L": ["x"]})
    assert dbutil.resolve_env(cfg_dir / "proj") == {"A": "b"}


def test_user_config_malformed_json(cfg_dir):
    d = cfg_dir / "cfg"
    d.mkdir(parents=True, exist_ok=True)
    (d / "whotrc.json").write_text("{ not json")
    assert dbutil.resolve_env(cfg_dir / "proj") == {}


def test_user_config_env_missing_or_wrong_type(cfg_dir):
    d = cfg_dir / "cfg"
    d.mkdir(parents=True, exist_ok=True)
    (d / "whotrc.json").write_text(json.dumps({"cluster_threshold": 0.4}))
    assert dbutil.resolve_env(cfg_dir / "proj") == {}
    (d / "whotrc.json").write_text(json.dumps({"env": "not-a-map"}))
    assert dbutil.resolve_env(cfg_dir / "proj") == {}


# ------------------------------------------------------------ user_config_path

def test_user_config_path_override_chain(cfg_dir, monkeypatch):
    """$WHOT_CONFIG_DIR overrides; then $XDG_CONFIG_HOME/whot; then the
    platform default under HOME."""
    assert dbutil.user_config_path() == cfg_dir / "cfg" / "whotrc.json"
    monkeypatch.delenv("WHOT_CONFIG_DIR")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg_dir / "xdg"))
    assert dbutil.user_config_path() == cfg_dir / "xdg" / "whot" / "whotrc.json"
    monkeypatch.delenv("XDG_CONFIG_HOME")
    p = dbutil.user_config_path()
    if sys.platform == "darwin":
        assert p == Path.home() / "Library/Application Support/whot/whotrc.json"
    elif sys.platform == "win32":
        assert p == Path.home() / "AppData/Roaming/whot/whotrc.json"
    else:
        assert p == Path.home() / ".config/whot/whotrc.json"
