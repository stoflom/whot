//! #268 — `open_image` opens the ORIGINAL: `db::image_open_paths` orders
//! the recorded locations (primary first, then the `image_paths` alias
//! set, deduplicated) and `db::resolve_image_open_path` picks the first
//! one that exists on disk (a recorded location can be stale — the alias
//! set is append-only).

use rusqlite::{params, Connection};
use std::path::PathBuf;
use whotapp_lib::db::{self, Paths};

const SCHEMA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../database/schema.sql");
const NOW: &str = "2026-10-15T00:00:00";

/// One image, `primary_path` = primary, plus the given alias rows
/// (inserted exactly as the importer would — order not guaranteed).
fn fixture(name: &str, primary: &str, aliases: &[&str]) -> Paths {
    let root: PathBuf =
        std::env::temp_dir().join(format!("whot-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let paths = Paths { root: root.clone(), db: root.join("faces.db"), config: root.join("whotrc.json") };
    let con = Connection::open(&paths.db).unwrap();
    con.execute_batch(&std::fs::read_to_string(SCHEMA).unwrap()).unwrap();
    con.execute(
        "INSERT INTO images(id, content_hash, width, height, primary_path, state,
                            orientation, type, created_at)
         VALUES (1, ?, 100, 100, ?, 'scanned', 'landscape', 'processed', ?)",
        params!["0".repeat(64), primary, NOW],
    )
    .unwrap();
    for p in aliases {
        con.execute(
            "INSERT INTO image_paths(image_id, path) VALUES (1, ?)",
            params![p],
        )
        .unwrap();
    }
    paths
}

/// A real file on disk under the test temp root (cleaned up after).
fn touch(path: &str) -> std::path::PathBuf {
    let p = std::path::Path::new(path).to_path_buf();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&p, b"x").unwrap();
    p
}

#[test]
fn open_paths_primary_first_aliases_sorted_deduped() {
    let paths = fixture(
        "order",
        "/tmp/whot-order/a.jpg",
        &["/tmp/whot-order/a.jpg", "/tmp/whot-order/c.jpg", "/tmp/whot-order/b.jpg"],
    );
    // the primary alias row duplicates the primary — it must not appear twice
    let out = db::image_open_paths(&paths, 1).unwrap();
    assert_eq!(
        out,
        vec![
            "/tmp/whot-order/a.jpg".to_string(),
            "/tmp/whot-order/b.jpg".to_string(),
            "/tmp/whot-order/c.jpg".to_string(),
        ],
        "primary first, then aliases in path order, deduplicated"
    );
}

#[test]
fn resolve_picks_the_first_existing_location() {
    let stale_primary = "/tmp/whot-resolve-stale/a.jpg";
    let live_alias = "/tmp/whot-resolve-stale/b.jpg";
    let paths = fixture("stale", stale_primary, &[live_alias]);
    // primary recorded but the file is gone; the alias file exists
    touch(live_alias);
    let got = db::resolve_image_open_path(&paths, 1).unwrap();
    assert_eq!(got, Some(live_alias.to_string()), "stale primary skipped, live alias opened");
}

#[test]
fn resolve_prefers_the_primary_when_it_exists() {
    let primary = "/tmp/whot-resolve-primary/a.jpg";
    let alias = "/tmp/whot-resolve-primary/b.jpg";
    let paths = fixture("primary", primary, &[alias]);
    let p = touch(primary);
    let a = touch(alias);
    let got = db::resolve_image_open_path(&paths, 1).unwrap();
    assert_eq!(got, Some(primary.to_string()), "primary wins when it exists");
    std::fs::remove_file(p).unwrap();
    std::fs::remove_file(a).unwrap();
}

#[test]
fn resolve_none_when_no_recorded_location_exists() {
    let paths = fixture(
        "none",
        "/tmp/whot-resolve-none/a.jpg",
        &["/tmp/whot-resolve-none/b.jpg"],
    );
    // no files created — the image is BLOB-only (or the originals moved)
    let got = db::resolve_image_open_path(&paths, 1).unwrap();
    assert_eq!(got, None, "no existing location — the caller falls back to the temp copy");
}
