//! #268/#285 — `open_image` opens the ORIGINAL: `db::image_open_paths`
//! orders the recorded locations (primary first, then the `image_paths`
//! alias set, deduplicated) and `db::resolve_open_image_target`
//! decides the open: the first location that exists on disk (a
//! recorded location can be stale — the alias set is append-only), or
//! `Preview` when no location is recorded at all (BLOB-only); #285:
//! `Err` when ≥ 1 recorded location exists but none does (moved /
//! unmounted volume) — a missing original never masquerades as one
//! that opened.

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
    let paths = Paths { root: root.clone(), db: root.join("faces.db"), config: root.join("whotrc.json"), mode: "repo", env_source: "dotenv" };
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
    let got = db::resolve_open_image_target(&paths, 1).unwrap();
    assert!(
        matches!(got, db::OpenImageTarget::Original(ref p) if p == live_alias),
        "stale primary skipped, live alias opened: {got:?}"
    );
}

#[test]
fn resolve_prefers_the_primary_when_it_exists() {
    let primary = "/tmp/whot-resolve-primary/a.jpg";
    let alias = "/tmp/whot-resolve-primary/b.jpg";
    let paths = fixture("primary", primary, &[alias]);
    let p = touch(primary);
    let a = touch(alias);
    let got = db::resolve_open_image_target(&paths, 1).unwrap();
    assert!(
        matches!(got, db::OpenImageTarget::Original(ref q) if q == primary),
        "primary wins when it exists: {got:?}"
    );
    std::fs::remove_file(p).unwrap();
    std::fs::remove_file(a).unwrap();
}

// #285 (gui-design v12.6): recorded but ALL missing is an ERROR — the
// unmounted-drive case. No preview copy may open; the message names
// every looked-at path for the error toast.
#[test]
fn resolve_rejects_when_no_recorded_location_exists() {
    let paths = fixture(
        "none",
        "/tmp/whot-resolve-none/a.jpg",
        &["/tmp/whot-resolve-none/b.jpg"],
    );
    // no files created — the originals moved / the volume unmounted
    let err = db::resolve_open_image_target(&paths, 1).unwrap_err().to_string();
    assert!(err.contains("/tmp/whot-resolve-none/a.jpg"), "primary named: {err}");
    assert!(err.contains("/tmp/whot-resolve-none/b.jpg"), "alias named: {err}");
}

// an unknown image id stays an error (not a silent Preview fallback)
#[test]
fn resolve_unknown_image_is_an_error() {
    let paths = fixture("unknown", "/tmp/whot-resolve-unknown/a.jpg", &[]);
    assert!(db::resolve_open_image_target(&paths, 42).is_err());
}
