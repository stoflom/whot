//! #272 (gui-design v11.1) — `open_roll` opens the directory CONTAINING
//! the image file in the file manager: `db::image_file_dir` is the parent
//! of `images.primary_path` (a recursive roll import places the file in a
//! subdirectory below the roll root `imports.path`), and `None` for an
//! unknown image id (the command's rejection path — the caller's error
//! toast, #144).

use rusqlite::{params, Connection};
use std::path::PathBuf;
use whotapp_lib::db::{self, Paths};

const SCHEMA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../database/schema.sql");
const NOW: &str = "2026-10-15T00:00:00";

fn fixture(name: &str, image: i64, primary: &str) -> Paths {
    let root: PathBuf =
        std::env::temp_dir().join(format!("whot-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let paths = Paths { root: root.clone(), db: root.join("faces.db"), config: root.join("whotrc.json"), mode: "repo", env_source: "dotenv" };
    let con = Connection::open(&paths.db).unwrap();
    con.execute_batch(&std::fs::read_to_string(SCHEMA).unwrap()).unwrap();
    con.execute(
        "INSERT INTO imports(id, path, started_at) VALUES (?, ?, ?)",
        params![7, "/tmp/whot-roll/rollA", NOW],
    )
    .unwrap();
    con.execute(
        "INSERT INTO images(id, content_hash, width, height, primary_path, state, first_import_id, last_import_id, created_at)
         VALUES (?, ?, 10, 10, ?, 'imported', 7, 7, ?)",
        params![image, format!("{image:064x}"), primary, NOW],
    )
    .unwrap();
    paths
}

#[test]
fn image_file_dir_is_the_parent_of_the_primary_path() {
    let paths = fixture("sub", 3, "/tmp/whot-roll/rollA/sub/IMG_0001.RAW");
    let got = db::image_file_dir(&paths, 3).unwrap();
    // the recursive-import subdirectory — NOT the roll root
    assert_eq!(got, Some("/tmp/whot-roll/rollA/sub".to_string()));
}

#[test]
fn image_file_dir_none_for_an_unknown_image() {
    let paths = fixture("unknown", 3, "/tmp/whot-roll/rollA/IMG_0002.RAW");
    let got = db::image_file_dir(&paths, 8).unwrap();
    assert_eq!(got, None, "unknown id — the command rejects, no opener call");
}
