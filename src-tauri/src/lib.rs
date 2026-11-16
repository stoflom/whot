//! WhoT Face Manager — Tauri command surface (README.md "Tauri commands";
//! architecture: docs/backend-design.md, behaviour rules: docs/gui-design.md §4).
//!
//! #218 — every DB-backed / heavy command is declared `async fn`: Tauri
//! then runs it on the async runtime's thread pool instead of the UI
//! main thread, so a long snapshot, image batch, cluster computation or
//! fs probe never freezes the renderer. The command surface, argument
//! shapes and TS-side `invoke` calls are unchanged. The runtime
//! stays correct because the DB layer serialises behind the `db::POOL`
//! mutex (#207). The honest-possible sync exceptions (runner mutex,
//! config file only) are guarded by the
//! `commands_run_off_the_main_thread_218` workflow test.
//!
//! #343 — an `async fn` body runs on the async runtime's WORKER
//! threads, where blocking work starves the other tasks; the bodies
//! therefore run on the runtime's dedicated BLOCKING pool
//! (`run_blocking`, below) instead. The DB surface keeps its
//! serialisation (`db::POOL`) — the one-operator UI is serial anyway.

pub mod db;
pub mod importer;

use db::{Delta, Paths, Settings};
use importer::ImportRunner;

use tauri::State;

struct AppState {
    paths: Result<Paths, String>,
    /// #167: the single import slot (one child process at a time)
    runner: ImportRunner,
}

impl AppState {
    fn paths(&self) -> Result<&Paths, String> {
        self.paths.as_ref().map_err(|e| e.clone())
    }
}

/// #343 — the async commands' bodies are BLOCKING work (rusqlite calls
/// behind the `db::POOL` mutex, blob copies, fs walks and writes), and
/// #218 deliberately keeps them off the UI main thread by declaring the
/// commands `async fn` — but an `async fn` body runs on the async
/// runtime's WORKER threads, so a `get_image_batch` (up to a 32 MiB
/// copy) or a snapshot stalled every other command AND tied up a worker
/// for its duration. The body now runs on the runtime's dedicated
/// BLOCKING pool instead: the workers stay free, the #218 pin (every
/// command `async fn`) keeps its shape, and the DB layer's own
/// serialisation (`db::POOL`) is unchanged — the one-operator UI is
/// serial anyway, so head-of-line blocking behind the pool lock is not
/// a real bottleneck (that is why the bounded-connection-pool
/// alternative stays undone; see backend-design §lib.rs).
///
/// A panicked body (a DB-code bug) is an Err here, not a bricked worker
/// — the same degradation the #318 lock-poison recovery already gives
/// the pool lock.
async fn run_blocking<T, F>(body: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(body).await {
        Ok(r) => r,
        Err(e) => Err(format!("command task failed: {e}")),
    }
}

#[tauri::command]
async fn get_snapshot(state: State<'_, AppState>) -> Result<db::Snapshot, String> {
    // #343: the body runs on the blocking pool (run_blocking, and below)
    let paths = state.paths()?.clone();
    run_blocking(move || db::snapshot(&paths).map_err(|e| e.to_string())).await
}

/// #208 — the cheap change stamp for the GUI's focus/visibility reload
/// skip (equal to the snapshot's `version` ⇒ nothing to reload).
/// #323 — `async fn` like every DB-backed command (#218): the probe's
/// FIRST open for a path is a real connection open with a 5 s
/// busy_timeout, and it must not stall the UI main thread while the
/// importer holds the write lock.
#[tauri::command]
async fn get_data_version(state: State<'_, AppState>) -> Result<i64, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || db::data_version(&paths).map_err(|e| e.to_string())).await
}

/// #212 — raw image bytes, no base64: ONE binary response per batch
/// (tauri::ipc::Response → ArrayBuffer on the JS side) carrying the
/// framed `WHOTIMG` container decoded by src/imageBatch.ts. Kinds:
/// "face" (faces.preview), "thumb" (images.thumbnail), "preview"
/// (images.preview); images without a blob simply do not appear.
#[tauri::command]
async fn get_image_batch(
    state: State<'_, AppState>,
    kind: String,
    ids: Vec<i64>,
) -> Result<tauri::ipc::Response, String> {
    // #343: the framing copy (up to ~32 MiB) runs on the blocking pool
    let paths = state.paths()?.clone();
    run_blocking(move || {
        db::image_batch_bytes(&paths, &kind, &ids)
            .map_err(|e| e.to_string())
            .map(tauri::ipc::Response::new)
    })
    .await
}

#[tauri::command]
async fn get_refcrops(state: State<'_, AppState>, person_id: i64) -> Result<Vec<db::Refcrop>, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || db::get_refcrops(&paths, person_id).map_err(|e| e.to_string())).await
}

/// #298 (gui-design v16.0, rule 51) — the annotated-image export:
/// write the frontend's canvas-encoded bytes (PNG/JPEG/WebP) to the
/// path the native save dialog chose. A dumb writer — no DB, no
/// decode; a failure names the path (the caller's error toast, #144).
///
/// #316 — the webview is not a trusted boundary and this command was
/// an arbitrary-file-write primitive (any path, any bytes). The write
/// is now confined to an annotated-export file: the extension must be
/// one of the export formats (rule 51's dialog filters), the payload
/// is size-capped, an EXISTING target must be a regular file (a
/// symlink named `x.png` may not be followed into
/// `authorized_keys`), and the parent directory must already exist —
/// the writer never creates directories.
const EXPORT_EXTENSIONS: [&str; 4] = [".png", ".jpg", ".jpeg", ".webp"];
/// #316 — the export payload cap: a real annotated export is a few MB
/// even at 4k, so 64 MiB is far beyond any legitimate write while
/// bounding the disk + IPC memory a compromised webview could abuse.
const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;

/// #316 — the save_image_file gate (separated so the unit tests don't
/// need a Tauri runtime).
fn check_export_target(path: &str, p: &std::path::Path, len: usize) -> Result<(), String> {
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    if !EXPORT_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "cannot write {path}: the export must be a .png, .jpg, .jpeg or .webp file"
        ));
    }
    if len > MAX_EXPORT_BYTES {
        return Err(format!(
            "cannot write {path}: export too large ({} MiB, maximum {} MiB)",
            len / (1024 * 1024),
            MAX_EXPORT_BYTES / (1024 * 1024),
        ));
    }
    if std::fs::symlink_metadata(p).is_ok_and(|m| !m.is_file()) {
        return Err(format!(
            "cannot write {path}: an existing path is not a regular file"
        ));
    }
    // parent() of a bare filename is "" — that's the CWD, fine
    if p.parent()
        .is_some_and(|par| !par.as_os_str().is_empty() && !par.is_dir())
    {
        return Err(format!(
            "cannot write {path}: the parent directory does not exist"
        ));
    }
    Ok(())
}

#[tauri::command]
async fn save_image_file(path: String, data: Vec<u8>) -> Result<(), String> {
    // #343: the (up to 64 MiB) write runs on the blocking pool
    run_blocking(move || {
        let p = std::path::Path::new(&path);
        check_export_target(&path, p, data.len())?;
        std::fs::write(p, &data).map_err(|e| format!("cannot write {path}: {e}"))
    })
    .await
}

/// #300 (gui-design v17.0, rule 51) — the annotated export's *open
/// after export*: hand the WRITTEN file to the image viewer (the #273
/// `image_viewer` setting — the configured program, else the system
/// default — the same `open_with` opener as `open_image`). A stale
/// path (deleted between the write and the open) is a rejection like
/// `open_dir`'s (#144 — the caller's error toast); it never fails the
/// export itself, which already succeeded.
///
/// #317 — the path is renderer-supplied and the webview is not a
/// trusted boundary: the extension must be an image (the import
/// scanner's exact IMAGE_SUFFIXES set) — a compromised webview cannot
/// hand arbitrary files to the viewer through this command.
#[tauri::command]
async fn open_image_file(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let paths = state.paths()?.clone();
    // #343: the settings read + viewer launch run on the blocking pool
    run_blocking(move || {
        let p = std::path::Path::new(&path);
        let ext = p
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        if !importer::IMAGE_SUFFIXES.contains(&ext.as_str()) {
            return Err(format!("not an image file: {path}"));
        }
        if !p.is_file() {
            return Err(format!("file no longer exists: {path}"));
        }
        let settings = db::get_settings(&paths).map_err(|e| e.to_string())?;
        open_with(&settings.image_viewer, &path)?;
        // diagnostic line in the spirit of #144 (which path was opened)
        eprintln!("[open_image_file] opened {path}");
        Ok(())
    })
    .await
}

/// Full-image context menu (#33): open the image with the system
/// viewer — the webkit default menu entries don't work.
///
/// #268: the ORIGINAL is opened, not a copy — the first recorded
/// location that exists on disk (`primary_path`, then the
/// `image_paths` aliases, gui-design §3). #285: a recorded path that no
/// longer exists (moved/deleted, unmounted volume) is an ERROR (the
/// looked-at paths named, the caller's error toast) — NO preview copy
/// opens. The temp copy is the fallback for a BLOB-only image (no
/// recorded location at all); the Ok message (non-empty only in that
/// branch) becomes the frontend's quiet info toast.
#[tauri::command]
async fn open_image(state: State<'_, AppState>, image_id: i64) -> Result<String, String> {
    let paths = state.paths()?.clone();
    // #343: the DB reads, the temp write and the viewer launch run on
    // the blocking pool
    run_blocking(move || {
        let settings = db::get_settings(&paths).map_err(|e| e.to_string())?;
        if let db::OpenImageTarget::Original(p) =
            db::resolve_open_image_target(&paths, image_id).map_err(|e| e.to_string())?
        {
            open_with(&settings.image_viewer, &p)?;
            // diagnostic line in the spirit of #144 (which path was opened)
            eprintln!("[open_image] image {image_id}: opened original {p}");
            return Ok(String::new());
        }
        let bytes = db::image_preview_bytes(&paths, image_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("image {image_id} has no preview"))?;
        // #144: the name used to be a fixed `whot-image-{image_id}.jpg` —
        // predictable (path pre-squatting by another local user) and shared by
        // every open, so a slow viewer still reading the file raced the next
        // overwrite. Unique per open (pid + unix nanos); the viewer holding
        // the old path is never disturbed by a later open.
        let ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        // extension follows the pixel magic; JPEG is the only format the
        // importer/GUI ever write, PNG is recognised defensively
        let ext = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
            "png"
        } else {
            "jpg"
        };
        let path = std::env::temp_dir().join(format!(
            "whot-image-{image_id}-{}-{ns}.{ext}",
            std::process::id()
        ));
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        open_with(&settings.image_viewer, path.to_string_lossy().as_ref())?;
        // #268/#285: no recorded location at all (BLOB-only) — quiet info
        // toast (a recorded-but-missing path already rejected above, #285)
        Ok(format!(
            "image has no recorded location — opened a temporary copy ({image_id})"
        ))
    })
    .await
}

/// v12.5 (#284) — 'Open roll path' on a Rolls tree branch (gui-design
/// §4.36): the BRANCH's own directory (its absolute path) opens in the
/// system file manager through the same opener plugin as `open_roll` —
/// unlike `open_roll` (the image's own directory, resolved from the
/// db) the path is handed over directly. A stale (moved/deleted) branch
/// path is a rejection like `open_roll`'s (#144) — the caller's error
/// toast names the path.
#[tauri::command]
async fn open_dir(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let paths = state.paths()?.clone();
    // #343: the settings read + viewer launch run on the blocking pool
    run_blocking(move || {
        if !std::path::Path::new(&path).is_dir() {
            return Err(format!("directory no longer exists: {path}"));
        }
        let settings = db::get_settings(&paths).map_err(|e| e.to_string())?;
        open_with(&settings.directory_viewer, &path)?;
        // diagnostic line in the spirit of #144 (which path was opened)
        eprintln!("[open_dir] opened {path}");
        Ok(())
    })
    .await
}

/// #273 — hand `path` to the opener plugin: the configured program
/// (whotrc.json `image_viewer` / `directory_viewer`, trimmed) when set,
/// else the system default; a launch failure names the configured
/// program (#144 — the caller's error toast).
fn open_with(viewer: &str, path: &str) -> Result<(), String> {
    let t = viewer.trim();
    let app = if t.is_empty() { None } else { Some(t) };
    tauri_plugin_opener::open_path(path, app).map_err(|e| {
        if app.is_some() { format!("{e} (configured viewer: {t})") } else { e.to_string() }
    })
}

/// #272 (gui-design v11.1) — 'Open roll path' (gui-design §3 context
/// menus): the directory CONTAINING the image file (parent of
/// `images.primary_path`) opens in the system file manager through the
/// same opener plugin as `open_image` — roll imports may be recursive,
/// so the roll root `imports.path` is not where the file lives. A stale
/// (moved/deleted) image location is a rejection like `open_image`'s
/// (#144) — the caller's error toast names the path.
#[tauri::command]
async fn open_roll(state: State<'_, AppState>, image_id: i64) -> Result<(), String> {
    let paths = state.paths()?.clone();
    // #343: the DB reads + viewer launch run on the blocking pool
    run_blocking(move || {
        let p = db::image_file_dir(&paths, image_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("image {image_id} is not recorded"))?;
        if !std::path::Path::new(&p).exists() {
            return Err(format!("image directory no longer exists: {p}"));
        }
        let settings = db::get_settings(&paths).map_err(|e| e.to_string())?;
        open_with(&settings.directory_viewer, &p)?;
        // diagnostic line in the spirit of #144 (which path was opened)
        eprintln!("[open_roll] image {image_id}: opened {p}");
        Ok(())
    })
    .await
}

#[tauri::command]
async fn person_face_clusters(
    state: State<'_, AppState>,
    person_id: i64,
    threshold: f64,
) -> Result<Vec<db::AppearanceGroup>, String> {
    // #343: the O(n²) clustering runs on the blocking pool
    let paths = state.paths()?.clone();
    run_blocking(move || {
        db::person_face_clusters(&paths, person_id, threshold).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn assign_person(
    state: State<'_, AppState>,
    face_ids: Vec<i64>,
    name: String,
    group: String,
) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || {
        db::assign_person(&paths, &face_ids, &name, &group).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn accept_faces(state: State<'_, AppState>, face_ids: Vec<i64>) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || {
        db::set_link_status(&paths, &face_ids, "confirmed").map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn reject_faces(state: State<'_, AppState>, face_ids: Vec<i64>) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || {
        db::set_link_status(&paths, &face_ids, "rejected").map_err(|e| e.to_string())
    })
    .await
}

/// #122 — rotate the full image ±90° (server state; refresh follows).
#[tauri::command]
async fn rotate_image(state: State<'_, AppState>, image_id: i64, delta: i64) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || db::rotate_image(&paths, image_id, delta).map_err(|e| e.to_string())).await
}

/// #209 — one call per user action for a multi-image rotate (the GUI's
/// thumbnail-scope rotation), same per-image semantics as `rotate_image`
#[tauri::command]
async fn rotate_images(state: State<'_, AppState>, image_ids: Vec<i64>, delta: i64) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || db::rotate_images(&paths, &image_ids, delta).map_err(|e| e.to_string()))
        .await
}

/// #122 — rotate the face crop ±90° (server state; refresh follows).
#[tauri::command]
async fn rotate_face(state: State<'_, AppState>, face_id: i64, delta: i64) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || db::rotate_face(&paths, face_id, delta).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn set_face_description(
    state: State<'_, AppState>,
    face_id: i64,
    description: String,
) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || {
        db::set_face_description(&paths, face_id, &description).map_err(|e| e.to_string())
    })
    .await
}

/// #209 — one call per staged batch: the sequential per-face seq
/// re-assignment (§4.4) happens inside its transaction, in call order
#[tauri::command]
async fn set_face_descriptions(
    state: State<'_, AppState>,
    face_ids: Vec<i64>,
    description: String,
) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || {
        db::set_face_descriptions(&paths, &face_ids, &description).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn set_primary_face(
    state: State<'_, AppState>,
    person_id: i64,
    face_id: i64,
) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || {
        db::set_primary_face(&paths, person_id, face_id).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn set_person_name(state: State<'_, AppState>, person_id: i64, name: String) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || db::set_person_name(&paths, person_id, &name).map_err(|e| e.to_string()))
        .await
}

#[tauri::command]
async fn set_person_group(state: State<'_, AppState>, person_id: i64, group: String) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || db::set_person_group(&paths, person_id, &group).map_err(|e| e.to_string()))
        .await
}

#[tauri::command]
async fn set_person_note(state: State<'_, AppState>, person_id: i64, note: String) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || db::set_person_note(&paths, person_id, &note).map_err(|e| e.to_string()))
        .await
}

/// §4.13/#35/#165/#266 — remove persons: reject + re-home their faces
/// into their `RejectedN` cluster persons, delete the person row(s).
/// §4.16 (#50) — move persons to a group (membership only).
#[tauri::command]
async fn move_persons_to_group(
    state: State<'_, AppState>,
    person_ids: Vec<i64>,
    group: String,
) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || {
        db::move_persons_to_group(&paths, &person_ids, &group).map_err(|e| e.to_string())
    })
    .await
}

/// §4.16 (#157, v3.59) — tree D&D: re-home ONE membership of each dragged
/// person (remove the dragged-from row if present, file them into the
/// target branch); other memberships are kept.
#[tauri::command]
async fn move_persons_between_groups(
    state: State<'_, AppState>,
    person_ids: Vec<i64>,
    from_group: String,
    to_group: String,
) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || {
        db::move_persons_between_groups(&paths, &person_ids, &from_group, &to_group)
            .map_err(|e| e.to_string())
    })
    .await
}

/// §4.16 (#50) — rename/move a group branch (path-prefix rewrite).
#[tauri::command]
async fn rename_group(state: State<'_, AppState>, old_path: String, new_path: String) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || db::rename_group(&paths, &old_path, &new_path).map_err(|e| e.to_string()))
        .await
}

/// §4.16 (#50) — delete a group branch (members fall to Ungrouped).
#[tauri::command]
async fn delete_group(state: State<'_, AppState>, path: String) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || db::delete_group(&paths, &path).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn remove_persons(state: State<'_, AppState>, person_ids: Vec<i64>) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || db::remove_persons(&paths, &person_ids).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn add_refcrop(state: State<'_, AppState>, person_id: i64, face_id: i64) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || db::add_refcrop(&paths, person_id, face_id).map_err(|e| e.to_string()))
        .await
}

#[tauri::command]
async fn remove_refcrop(state: State<'_, AppState>, person_id: i64, face_id: i64) -> Result<Delta, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || db::remove_refcrop(&paths, person_id, face_id).map_err(|e| e.to_string()))
        .await
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<Settings, String> {
    db::get_settings(state.paths()?).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_settings(state: State<AppState>, settings: Settings) -> Result<(), String> {
    db::set_settings(state.paths()?, settings).map_err(|e| e.to_string())
}

/// #303 (gui-design §4 rule 52) — the environment dialog's header: the
/// resolution as it was resolved at startup (backend-design §2). The
/// one-shot read runs off the main thread with the other commands.
#[tauri::command]
async fn get_config_info(state: State<'_, AppState>) -> Result<db::ConfigInfo, String> {
    let paths = state.paths()?.clone();
    run_blocking(move || db::config_info(&paths).map_err(|e| e.to_string())).await
}

/// #167 (§4.36) — fs probe for the Rolls path filter: does the path hold
/// ≥ 1 image at ANY depth (#169, recursive + early-exit, exact
/// IMAGE_SUFFIXES parity); `true` + no snapshot match = "not yet
/// imported" ⇒ the import pane opens
#[tauri::command]
async fn scan_import_dir(state: State<'_, AppState>, path: String) -> Result<bool, String> {
    // join semantics: an absolute path (the native picker) replaces the
    // root, a relative one is resolved against it
    // #343: the (depth-32) fs walk runs on the blocking pool
    let root = state.paths()?.root.clone();
    run_blocking(move || Ok(importer::scan_import_dir(&root.join(path)))).await
}

/// #167 (§4.36) — spawn scripts/import_roll.py as an independent child
/// process; refused (error) while one is already running
#[tauri::command]
fn start_import(
    state: State<AppState>,
    options: importer::ImportOptions,
) -> Result<importer::ImportStatus, String> {
    state.runner.start(&state.paths()?.root, &options)
}

/// #167 (§4.36) — kill the running import child (if any)
#[tauri::command]
fn stop_import(state: State<AppState>) -> Result<bool, String> {
    state.runner.stop()
}

/// #167 (§4.36) — the pane's stdout poll: lines `[since..]` + process
/// state + elapsed; returns `{ dbPath }`-side info via get_import_info
#[tauri::command]
fn get_import_status(state: State<AppState>, since: usize) -> importer::ImportStatus {
    state.runner.status(since)
}

/// #185/#186 (§4.36) — the pane's read-only header info: the resolved
/// DB path (same resolution as the script) and whether a USABLE
/// database exists (schema present — gates the --create-db offer)
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportInfo {
    db_path: String,
    db_exists: bool,
}

#[tauri::command]
async fn get_import_info(state: State<'_, AppState>) -> Result<ImportInfo, String> {
    // #343: has_schema's first-open DB I/O runs on the blocking pool
    let paths = state.paths()?.clone();
    run_blocking(move || {
        Ok(ImportInfo {
            db_path: paths.db.display().to_string(),
            db_exists: db::has_schema(&paths),
        })
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // #162: native folder picker for the Rolls path filter
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            paths: Paths::resolve().map_err(|e| e.to_string()),
            runner: ImportRunner::new(),
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_data_version,
            get_image_batch,
            get_refcrops,
            save_image_file,
            open_image_file,
            open_image,
            open_roll,
            open_dir,
            person_face_clusters,
            assign_person,
            accept_faces,
            reject_faces,
            rotate_image,
            rotate_images,
            rotate_face,
            set_face_description,
            set_face_descriptions,
            set_primary_face,
            set_person_name,
            set_person_group,
            set_person_note,
            move_persons_to_group,
            move_persons_between_groups,
            rename_group,
            delete_group,
            remove_persons,
            add_refcrop,
            remove_refcrop,
            get_settings,
            get_config_info,
            set_settings,
            scan_import_dir,
            start_import,
            stop_import,
            get_import_status,
            get_import_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running WhoT Face Manager");
}

#[cfg(test)]
mod tests {
    // #316 — the save_image_file gate: extension allowlist, size cap,
    // existing-target must be a regular file, parent must exist.
    use super::check_export_target;
    use std::fs;
    use std::path::Path;

    #[test]
    fn export_gate_rejects_non_image_extensions() {
        let tmp = std::env::temp_dir().join(format!("whot-export-gate-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let no_ext = tmp.join("noext");
        let bad = tmp.join("authorized_keys");
        let db = tmp.join("faces.db");
        for p in [no_ext.as_path(), bad.as_path(), db.as_path()] {
            let e = check_export_target(&p.display().to_string(), p, 10).unwrap_err();
            assert!(e.contains("must be a .png"), "{e}");
        }
        // case-insensitive
        assert!(check_export_target("x.PNG", Path::new("x.PNG"), 10).is_ok());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn export_gate_rejects_oversized_payload() {
        let tmp = std::env::temp_dir().join(format!("whot-export-gate2-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let p = tmp.join("big.png");
        let e = check_export_target(
            &p.display().to_string(),
            p.as_path(),
            super::MAX_EXPORT_BYTES + 1,
        )
        .unwrap_err();
        assert!(e.contains("too large"), "{e}");
        assert!(check_export_target(&p.display().to_string(), p.as_path(), 10).is_ok());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn export_gate_rejects_symlink_and_dir_targets() {
        let tmp = std::env::temp_dir().join(format!("whot-export-gate3-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        // a symlink named x.png must not be followed into the target
        let target = tmp.join("real-target");
        fs::write(&target, b"").unwrap();
        let link = tmp.join("x.png");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(unix)]
        {
            let e = check_export_target(&link.display().to_string(), &link, 10).unwrap_err();
            assert!(e.contains("not a regular file"), "{e}");
        }
        // an existing DIRECTORY named y.png
        let dir = tmp.join("y.png");
        fs::create_dir_all(&dir).unwrap();
        let e = check_export_target(&dir.display().to_string(), &dir, 10).unwrap_err();
        assert!(e.contains("not a regular file"), "{e}");
        // a plain existing regular file is fine (re-export overwrite)
        let ok = tmp.join("ok.png");
        fs::write(&ok, b"old").unwrap();
        assert!(check_export_target(&ok.display().to_string(), &ok, 10).is_ok());
        // the PARENT must exist
        let missing = tmp.join("no-such-dir/z.png");
        let e = check_export_target(&missing.display().to_string(), &missing, 10).unwrap_err();
        assert!(e.contains("parent directory"), "{e}");
        let _ = fs::remove_dir_all(&tmp);
    }

    // #343 — the blocking-pool runner: the body's Err travels through,
    // and a PANICKING body is an Err (not a poisoned worker/pool) —
    // the same degradation #318's lock-poison recovery gives the pool.
    use super::run_blocking;

    #[test]
    fn run_blocking_carries_the_body_result() {
        let ok = tauri::async_runtime::block_on(run_blocking(|| Ok::<i64, String>(41 + 1)));
        assert_eq!(ok.unwrap(), 42);
        let err = tauri::async_runtime::block_on(run_blocking(|| -> Result<(), String> {
            Err("db gone".into())
        }));
        assert_eq!(err.unwrap_err(), "db gone");
    }

    #[test]
    fn run_blocking_maps_a_panicking_body_to_an_err() {
        let r = tauri::async_runtime::block_on(run_blocking(|| -> Result<(), String> {
            panic!("db code bug")
        }));
        let e = r.unwrap_err();
        assert!(e.contains("command task failed"), "{e}");
    }
}
