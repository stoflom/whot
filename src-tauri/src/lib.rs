//! WhoT Face Manager — Tauri command surface (docs/gui-design.md §5).

pub mod db;

use db::{Paths, Settings};

use tauri::State;

struct AppState {
    paths: Result<Paths, String>,
}

impl AppState {
    fn paths(&self) -> Result<&Paths, String> {
        self.paths.as_ref().map_err(|e| e.clone())
    }
}

#[tauri::command]
fn get_snapshot(state: State<AppState>) -> Result<db::Snapshot, String> {
    db::snapshot(state.paths()?).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_face_preview(state: State<AppState>, face_id: i64) -> Result<String, String> {
    db::face_preview(state.paths()?, face_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_image_thumb(state: State<AppState>, image_id: i64) -> Result<Option<String>, String> {
    db::image_blobs(state.paths()?, image_id)
        .map(|v| v.map(|(t, _)| t))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_image_preview(state: State<AppState>, image_id: i64) -> Result<Option<String>, String> {
    db::image_blobs(state.paths()?, image_id)
        .map(|v| v.and_then(|(_, p)| p))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_refcrops(state: State<AppState>, person_id: i64) -> Result<Vec<db::Refcrop>, String> {
    db::get_refcrops(state.paths()?, person_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn person_face_clusters(
    state: State<AppState>,
    person_id: i64,
    threshold: f64,
) -> Result<Vec<db::AppearanceGroup>, String> {
    db::person_face_clusters(state.paths()?, person_id, threshold).map_err(|e| e.to_string())
}

#[tauri::command]
fn assign_person(
    state: State<AppState>,
    face_ids: Vec<i64>,
    name: String,
    group: String,
) -> Result<(), String> {
    db::assign_person(state.paths()?, &face_ids, &name, &group).map_err(|e| e.to_string())
}

#[tauri::command]
fn accept_faces(state: State<AppState>, face_ids: Vec<i64>) -> Result<(), String> {
    db::set_link_status(state.paths()?, &face_ids, "confirmed").map_err(|e| e.to_string())
}

#[tauri::command]
fn reject_faces(state: State<AppState>, face_ids: Vec<i64>) -> Result<(), String> {
    db::set_link_status(state.paths()?, &face_ids, "rejected").map_err(|e| e.to_string())
}

#[tauri::command]
fn set_face_description(
    state: State<AppState>,
    face_id: i64,
    description: String,
) -> Result<(), String> {
    db::set_face_description(state.paths()?, face_id, &description).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_primary_face(
    state: State<AppState>,
    person_id: i64,
    face_id: i64,
) -> Result<(), String> {
    db::set_primary_face(state.paths()?, person_id, face_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_person_name(state: State<AppState>, person_id: i64, name: String) -> Result<(), String> {
    db::set_person_name(state.paths()?, person_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_person_group(state: State<AppState>, person_id: i64, group: String) -> Result<(), String> {
    db::set_person_group(state.paths()?, person_id, &group).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_person_note(state: State<AppState>, person_id: i64, note: String) -> Result<(), String> {
    db::set_person_note(state.paths()?, person_id, &note).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_refcrop(state: State<AppState>, person_id: i64, face_id: i64) -> Result<(), String> {
    db::add_refcrop(state.paths()?, person_id, face_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_refcrop(state: State<AppState>, person_id: i64, face_id: i64) -> Result<(), String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            paths: Paths::resolve().map_err(|e| e.to_string()),
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_face_preview,
            get_image_thumb,
            get_image_preview,
            get_refcrops,
            person_face_clusters,
            assign_person,
            accept_faces,
            reject_faces,
            set_face_description,
            set_primary_face,
            set_person_name,
            set_person_group,
            set_person_note,
            add_refcrop,
            remove_refcrop,
            get_settings,
            set_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running WhoT Face Manager");
}
