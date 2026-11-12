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

#[tauri::command]
async fn get_snapshot(state: State<'_, AppState>) -> Result<db::Snapshot, String> {
    db::snapshot(state.paths()?).map_err(|e| e.to_string())
}

/// #208 — the cheap change stamp for the GUI's focus/visibility reload
/// skip (equal to the snapshot's `version` ⇒ nothing to reload)
#[tauri::command]
fn get_data_version(state: State<AppState>) -> Result<i64, String> {    db::data_version(state.paths()?).map_err(|e| e.to_string())
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
    let bytes = db::image_batch_bytes(state.paths()?, &kind, &ids).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn get_refcrops(state: State<'_, AppState>, person_id: i64) -> Result<Vec<db::Refcrop>, String> {
    db::get_refcrops(state.paths()?, person_id).map_err(|e| e.to_string())
}

/// #298 (gui-design v16.0, rule 51) — the annotated-image export:
/// write the frontend's canvas-encoded bytes (PNG/JPEG/WebP) to the
/// path the native save dialog chose. A dumb writer — no DB, no
/// decode; a failure names the path (the caller's error toast, #144).
#[tauri::command]
async fn save_image_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| format!("cannot write {path}: {e}"))
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
    let paths = state.paths()?;
    let settings = db::get_settings(paths).map_err(|e| e.to_string())?;
    if let db::OpenImageTarget::Original(p) =
        db::resolve_open_image_target(paths, image_id).map_err(|e| e.to_string())?
    {
        open_with(&settings.image_viewer, &p)?;
        // diagnostic line in the spirit of #144 (which path was opened)
        eprintln!("[open_image] image {image_id}: opened original {p}");
        return Ok(String::new());
    }
    let bytes = db::image_preview_bytes(paths, image_id)
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
    let ext = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) { "png" } else { "jpg" };
    let path = std::env::temp_dir().join(format!("whot-image-{image_id}-{}-{ns}.{ext}", std::process::id()));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    open_with(&settings.image_viewer, path.to_string_lossy().as_ref())?;
    // #268/#285: no recorded location at all (BLOB-only) — quiet info
    // toast (a recorded-but-missing path already rejected above, #285)
    Ok(format!("image has no recorded location — opened a temporary copy ({image_id})"))
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
    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("directory no longer exists: {path}"));
    }
    let settings = db::get_settings(state.paths()?).map_err(|e| e.to_string())?;
    open_with(&settings.directory_viewer, &path)?;
    // diagnostic line in the spirit of #144 (which path was opened)
    eprintln!("[open_dir] opened {path}");
    Ok(())
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
    let paths = state.paths()?;
    let p = db::image_file_dir(paths, image_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("image {image_id} is not recorded"))?;
    if !std::path::Path::new(&p).exists() {
        return Err(format!("image directory no longer exists: {p}"));
    }
    let settings = db::get_settings(paths).map_err(|e| e.to_string())?;
    open_with(&settings.directory_viewer, &p)?;
    // diagnostic line in the spirit of #144 (which path was opened)
    eprintln!("[open_roll] image {image_id}: opened {p}");
    Ok(())
}

#[tauri::command]
async fn person_face_clusters(
    state: State<'_, AppState>,
    person_id: i64,
    threshold: f64,
) -> Result<Vec<db::AppearanceGroup>, String> {
    db::person_face_clusters(state.paths()?, person_id, threshold).map_err(|e| e.to_string())
}

#[tauri::command]
async fn assign_person(
    state: State<'_, AppState>,
    face_ids: Vec<i64>,
    name: String,
    group: String,
) -> Result<Delta, String> {
    db::assign_person(state.paths()?, &face_ids, &name, &group).map_err(|e| e.to_string())
}

#[tauri::command]
async fn accept_faces(state: State<'_, AppState>, face_ids: Vec<i64>) -> Result<Delta, String> {
    db::set_link_status(state.paths()?, &face_ids, "confirmed").map_err(|e| e.to_string())
}

#[tauri::command]
async fn reject_faces(state: State<'_, AppState>, face_ids: Vec<i64>) -> Result<Delta, String> {
    db::set_link_status(state.paths()?, &face_ids, "rejected").map_err(|e| e.to_string())
}

/// #122 — rotate the full image ±90° (server state; refresh follows).
#[tauri::command]
async fn rotate_image(state: State<'_, AppState>, image_id: i64, delta: i64) -> Result<Delta, String> {
    db::rotate_image(state.paths()?, image_id, delta).map_err(|e| e.to_string())
}

/// #209 — one call per user action for a multi-image rotate (the GUI's
/// thumbnail-scope rotation), same per-image semantics as `rotate_image`
#[tauri::command]
async fn rotate_images(state: State<'_, AppState>, image_ids: Vec<i64>, delta: i64) -> Result<Delta, String> {
    db::rotate_images(state.paths()?, &image_ids, delta).map_err(|e| e.to_string())
}

/// #122 — rotate the face crop ±90° (server state; refresh follows).
#[tauri::command]
async fn rotate_face(state: State<'_, AppState>, face_id: i64, delta: i64) -> Result<Delta, String> {
    db::rotate_face(state.paths()?, face_id, delta).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_face_description(
    state: State<'_, AppState>,
    face_id: i64,
    description: String,
) -> Result<Delta, String> {
    db::set_face_description(state.paths()?, face_id, &description).map_err(|e| e.to_string())
}

/// #209 — one call per staged batch: the sequential per-face seq
/// re-assignment (§4.4) happens inside its transaction, in call order
#[tauri::command]
async fn set_face_descriptions(
    state: State<'_, AppState>,
    face_ids: Vec<i64>,
    description: String,
) -> Result<Delta, String> {
    db::set_face_descriptions(state.paths()?, &face_ids, &description).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_primary_face(
    state: State<'_, AppState>,
    person_id: i64,
    face_id: i64,
) -> Result<Delta, String> {
    db::set_primary_face(state.paths()?, person_id, face_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_person_name(state: State<'_, AppState>, person_id: i64, name: String) -> Result<Delta, String> {
    db::set_person_name(state.paths()?, person_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_person_group(state: State<'_, AppState>, person_id: i64, group: String) -> Result<Delta, String> {
    db::set_person_group(state.paths()?, person_id, &group).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_person_note(state: State<'_, AppState>, person_id: i64, note: String) -> Result<Delta, String> {
    db::set_person_note(state.paths()?, person_id, &note).map_err(|e| e.to_string())
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
    db::move_persons_to_group(state.paths()?, &person_ids, &group).map_err(|e| e.to_string())
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
    db::move_persons_between_groups(state.paths()?, &person_ids, &from_group, &to_group)
        .map_err(|e| e.to_string())
}

/// §4.16 (#50) — rename/move a group branch (path-prefix rewrite).
#[tauri::command]
async fn rename_group(state: State<'_, AppState>, old_path: String, new_path: String) -> Result<Delta, String> {
    db::rename_group(state.paths()?, &old_path, &new_path).map_err(|e| e.to_string())
}

/// §4.16 (#50) — delete a group branch (members fall to Ungrouped).
#[tauri::command]
async fn delete_group(state: State<'_, AppState>, path: String) -> Result<Delta, String> {
    db::delete_group(state.paths()?, &path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_persons(state: State<'_, AppState>, person_ids: Vec<i64>) -> Result<Delta, String> {
    db::remove_persons(state.paths()?, &person_ids).map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_refcrop(state: State<'_, AppState>, person_id: i64, face_id: i64) -> Result<Delta, String> {
    db::add_refcrop(state.paths()?, person_id, face_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_refcrop(state: State<'_, AppState>, person_id: i64, face_id: i64) -> Result<Delta, String> {
    db::remove_refcrop(state.paths()?, person_id, face_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<Settings, String> {
    db::get_settings(state.paths()?).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_settings(state: State<AppState>, settings: Settings) -> Result<(), String> {
    db::set_settings(state.paths()?, settings).map_err(|e| e.to_string())
}

/// #167 (§4.36) — fs probe for the Rolls path filter: does the path hold
/// ≥ 1 image at ANY depth (#169, recursive + early-exit, exact
/// IMAGE_SUFFIXES parity); `true` + no snapshot match = "not yet
/// imported" ⇒ the import pane opens
#[tauri::command]
async fn scan_import_dir(state: State<'_, AppState>, path: String) -> Result<bool, String> {
    // join semantics: an absolute path (the native picker) replaces the
    // root, a relative one is resolved against it
    Ok(importer::scan_import_dir(&state.paths()?.root.join(path)))
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
    let paths = state.paths()?;
    Ok(ImportInfo {
        db_path: paths.db.display().to_string(),
        db_exists: db::has_schema(&paths),
    })
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
