//! #272 — `open_roll` opens the roll's directory in the file manager:
//! `db::roll_dir` reads `imports.path` (an unknown id is `None`, the
//! command's rejection path — the caller's error toast, #144).

use rusqlite::{params, Connection};
use std::path::PathBuf;
use whotapp_lib::db::{self, Paths};

const SCHEMA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../database/schema.sql");
const NOW: &str = "2026-10-15T00:00:00";

fn fixture(name: &str, roll: i64, dir: &str) -> Paths {
    let root: PathBuf =
        std::env::temp_dir().join(format!("whot-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let paths = Paths { root: root.clone(), db: root.join("faces.db"), config: root.join("whotrc.json") };
    let con = Connection::open(&paths.db).unwrap();
    con.execute_batch(&std::fs::read_to_string(SCHEMA).unwrap()).unwrap();
    con.execute(
        "INSERT INTO imports(id, path, started_at) VALUES (?, ?, ?)",
        params![roll, dir, NOW],
    )
    .unwrap();
    paths
}

#[test]
fn roll_dir_returns_the_recorded_path() {
    let paths = fixture("roll", 7, "/tmp/whot-roll/rollA");
    let got = db::roll_dir(&paths, 7).unwrap();
    assert_eq!(got, Some("/tmp/whot-roll/rollA".to_string()));
}

#[test]
fn roll_dir_none_for_an_unknown_import() {
    let paths = fixture("unknown", 7, "/tmp/whot-roll/rollB");
    let got = db::roll_dir(&paths, 8).unwrap();
    assert_eq!(got, None, "unknown id — the command rejects, no opener call");
}
