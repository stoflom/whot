//! #301/#302 — the config resolution overhaul (backend-design §2):
//! repository mode unchanged (WHOT_ROOT / walk-up, `.env` source of
//! record), installed mode (user config `~/.config/whot/whotrc.json`,
//! first-use copy from `/usr/share/whot` or the binary-embedded
//! default, `env` object with `${VAR}` expansion, app data home).
//!
//! The mode functions take explicit inputs (`repo_paths`,
//! `installed_paths`) so the tests need no process-env races; the
//! env-var-driven glue (`resolve`, the dir helpers) is covered in ONE
//! sequential #[test] under an RAII guard.

use std::path::PathBuf;

use whotapp_lib::db::{expand_env, installed_paths, repo_paths, user_config_dir, app_data_home, Paths, Settings};

/// A scoped env override: set on construction, restored on drop.
struct EnvVar {
    key: &'static str,
    old: Option<String>,
}

impl EnvVar {
    fn set(key: &'static str, value: &str) -> Self {
        let old = std::env::var(key).ok();
        // Rust 2024: process env is global shared state — set_var is unsafe
        unsafe { std::env::set_var(key, value) };
        Self { key, old }
    }

    fn clear(key: &'static str) -> Self {
        let old = std::env::var(key).ok();
        unsafe { std::env::remove_var(key) };
        Self { key, old }
    }
}

impl Drop for EnvVar {
    fn drop(&mut self) {
        match self.old.take() {
            Some(v) => unsafe { std::env::set_var(self.key, v) },
            None => unsafe { std::env::remove_var(self.key) },
        }
    }
}

/// A unique per-run scratch root (no tempfile dev-dependency — the same
/// std::env::temp_dir pattern as importer.rs).
fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir()
        .join(format!("whot-cfg-{}-{}", tag, std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Expand a nested tree of directory paths under a scratch root.
fn mkdirs(root: &std::path::Path, parts: &[&str]) -> PathBuf {
    let p = parts.iter().fold(root.to_path_buf(), |acc, s| acc.join(s));
    std::fs::create_dir_all(&p).unwrap();
    p
}

/// expand_env — the whotrc `env` object's `${VAR}` algorithm: other env
/// keys first (4 passes), then the process environment; unresolvable
/// references stay literal.
#[test]
fn env_object_expansion_302() {
    unsafe { std::env::set_var("WHOT_TEST_HOME_BASE_302", "/srv/whot") };
    let env = expand_env(
        [
            ("HOME_BASE", "${WHOT_TEST_HOME_BASE_302}"),
            ("DATA_DIR", "${HOME_BASE}/whot/data"),
            ("FACES_DB", "${DATA_DIR}/faces.db"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect(),
    );
    unsafe { std::env::remove_var("WHOT_TEST_HOME_BASE_302") };
    assert_eq!(env["FACES_DB"], "/srv/whot/whot/data/faces.db");
    assert_eq!(env["DATA_DIR"], "/srv/whot/whot/data");

    // unresolvable references stay literal
    let env = expand_env(
        [("X", "${NOT_A_REAL_VAR_302}/x")]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    );
    assert_eq!(env["X"], "${NOT_A_REAL_VAR_302}/x");
}

/// Repository mode: `WHOT_ROOT` + `.env` — the 1.x behaviour, unchanged
/// (FACES_DB / CONFIG_FILE from the .env, joined onto the root).
#[test]
fn repository_mode_unchanged() {
    let tmp = scratch("repo");
    let root = mkdirs(&tmp, &["repo"]);
    std::fs::write(root.join(".env"), "FACES_DB=custom/faces.db\n").unwrap();
    let _g = EnvVar::set("WHOT_ROOT", root.to_str().unwrap());
    let p = whotapp_lib::db::Paths::resolve().unwrap();
    assert_eq!(p.root, root);
    assert_eq!(p.db, root.join("custom/faces.db"));
    assert_eq!(p.config, root.join("config/whotrc.json"));

    // the factored repo mode, no env needed
    let p = repo_paths(root.clone());
    assert_eq!(p.root, root);
    assert_eq!(p.db, root.join("custom/faces.db"));
}

/// Installed mode first use: the user config is CREATED by copying the
/// packaged default, and FACES_DB comes from its `env` object — a
/// `${HOME}`-absolute default resolves through the process env.
#[test]
fn installed_mode_first_use_copies_the_default() {
    let tmp = scratch("t1");
    let cfg = mkdirs(&tmp, &["cfg"]);
    let data = mkdirs(&tmp, &["data"]);
    let home = mkdirs(&tmp, &["home"]);
    let _g = EnvVar::set("HOME", home.to_str().unwrap());
    let default = r#"{"env": {"DATA_DIR": "${HOME}/.local/share/whot/data",
                              "FACES_DB": "${DATA_DIR}/faces.db"}}"#;

    let p = installed_paths(cfg.clone(), data.clone(), Some(default.to_string()));
    // the first-use copy exists and carries the env object
    let user = cfg.join("whotrc.json");
    assert!(user.is_file(), "first use copies the packaged default");
    // ${VAR} expanded, absolute via ${HOME}
    assert_eq!(p.db, home.join(".local/share/whot/data/faces.db"));
    // config + root point at the user copies
    assert_eq!(p.config, user);
    assert_eq!(p.root, data);

    // settings parse: the env object rides the struct
    let s = whotapp_lib::db::get_settings(&p).unwrap();
    assert_eq!(s.env["FACES_DB"], "${DATA_DIR}/faces.db");
}

/// Installed mode, second use: an edited user config wins — the copy is
/// NOT re-made, and the env object is re-read from the user file.
#[test]
fn installed_mode_user_edit_wins() {
    let tmp = scratch("t3");
    let cfg = mkdirs(&tmp, &["cfg"]);
    let data = mkdirs(&tmp, &["data"]);
    // the user copy exists BEFORE the resolve — with an edit
    std::fs::write(
        cfg.join("whotrc.json"),
        r#"{"env": {"FACES_DB": "edited-by-user.db"}}"#,
    )
    .unwrap();
    let default = r#"{"env": {"FACES_DB": "from-default.db"}}"#;

    let p = installed_paths(cfg.clone(), data.clone(), Some(default.to_string()));
    assert_eq!(p.db, data.join("edited-by-user.db"));
    let on_disk = std::fs::read_to_string(cfg.join("whotrc.json")).unwrap();
    assert!(on_disk.contains("edited-by-user"), "the copy is not re-made");
}

/// Installed mode with no packaged default reachable: the
/// binary-embedded default is used (the copy always succeeds).
#[test]
fn installed_mode_embedded_default() {
    let tmp = scratch("t2");
    let cfg = mkdirs(&tmp, &["cfg"]);
    let data = mkdirs(&tmp, &["data"]);

    let p = installed_paths(
        cfg.clone(),
        data.clone(),
        Some(whotapp_lib::db::EMBEDDED_DEFAULT_CONFIG.to_string()),
    );
    assert!(cfg.join("whotrc.json").is_file());
    let text = std::fs::read_to_string(cfg.join("whotrc.json")).unwrap();
    assert!(text.contains("\"env\""), "the embedded default carries env");
    // the embedded default's FACES_DB resolves via DATA_DIR/${HOME}
    let s = whotapp_lib::db::get_settings(&p).unwrap();
    assert!(s.env.contains_key("FACES_DB"));
}

/// Settings round-trip: set_settings rewrites the env object verbatim
/// (a GUI settings save never clobbers it, backend-design §2).
#[test]
fn settings_round_trip_preserves_env() {
    let tmp = scratch("t4");
    let cfg = mkdirs(&tmp, &["cfg"]);
    std::fs::write(
        cfg.join("whotrc.json"),
        r#"{"cluster_threshold": 0.5, "env": {"FACES_DB": "keep.db"}}"#,
    )
    .unwrap();
    let paths = Paths {
        root: tmp.clone(),
        db: tmp.join("faces.db"),
        config: cfg.join("whotrc.json"),
    };
    let s = whotapp_lib::db::get_settings(&paths).unwrap();
    assert_eq!(s.env["FACES_DB"], "keep.db");
    whotapp_lib::db::set_settings(&paths, Settings { cluster_threshold: 0.7, ..s }).unwrap();
    let s2 = whotapp_lib::db::get_settings(&paths).unwrap();
    assert_eq!(s2.cluster_threshold, 0.7);
    assert_eq!(s2.env["FACES_DB"], "keep.db");
}

/// The per-user dir chains (backend-design §2): `$WHOT_CONFIG_DIR` /
/// `$WHOT_DATA_DIR` overrides, then `$XDG_*_HOME/whot`, then the
/// platform default. One sequential #[test] — process-global env.
#[test]
fn user_dir_chains() {
    let tmp = scratch("t5");
    // overrides first
    let _g1 = EnvVar::set("WHOT_CONFIG_DIR", tmp.join("c").to_str().unwrap());
    let _g2 = EnvVar::set("WHOT_DATA_DIR", tmp.join("d").to_str().unwrap());
    let _g3 = EnvVar::set("XDG_CONFIG_HOME", "/nonexistent-302");
    let _g4 = EnvVar::set("XDG_DATA_HOME", "/nonexistent-302");
    assert_eq!(user_config_dir(), tmp.join("c"));
    assert_eq!(app_data_home(), tmp.join("d"));

    // XDG when no override
    drop(_g1);
    drop(_g2);
    unsafe { std::env::set_var("XDG_CONFIG_HOME", tmp.join("xcfg").to_str().unwrap()) };
    unsafe { std::env::set_var("XDG_DATA_HOME", tmp.join("xdata").to_str().unwrap()) };
    assert_eq!(user_config_dir(), tmp.join("xcfg").join("whot"));
    assert_eq!(app_data_home(), tmp.join("xdata").join("whot"));

    // platform default under HOME when neither
    drop(_g3);
    drop(_g4);
    let home = mkdirs(&tmp, &["home"]);
    let _g5 = EnvVar::set("HOME", home.to_str().unwrap());
    match std::env::consts::OS {
        "macos" => {
            assert_eq!(user_config_dir(), home.join("Library/Application Support/whot"));
            assert_eq!(app_data_home(), home.join("Library/Application Support/whot"));
        }
        "windows" => {
            assert_eq!(user_config_dir(), home.join("AppData/Roaming/whot"));
            assert_eq!(app_data_home(), home.join("AppData/Roaming/whot"));
        }
        _ => {
            assert_eq!(user_config_dir(), home.join(".config/whot"));
            assert_eq!(app_data_home(), home.join(".local/share/whot"));
        }
    }
}
