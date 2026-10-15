//! WhoT Face Manager — database layer.
//!
//! All SQL, embeddings math and derived-state maintenance (face names,
//! primary faces, refcrops) lives here. See docs/gui-design.md §4 for the
//! behaviour rules implemented in this file.

use anyhow::{bail, Context, Result};
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub const MODEL_TAG: &str = "insightface:buffalo_l";
const DEFAULT_THRESHOLD: f64 = 0.40;
const DEFAULT_REFCROP_N: i64 = 5;

// ---------------------------------------------------------------- paths

pub struct Paths {
    pub root: PathBuf,
    pub db: PathBuf,
    pub config: PathBuf,
}

impl Paths {
    /// Resolve project root (`.env` + `data/`), then FACES_DB / CONFIG_FILE
    /// from .env — mirrors import_roll.py resolution. `WHOT_ROOT` overrides.
    pub fn resolve() -> Result<Paths> {
        let root = if let Ok(r) = std::env::var("WHOT_ROOT") {
            PathBuf::from(r)
        } else {
            let mut dir = std::env::current_dir()
                .context("no current directory")?;
            loop {
                if dir.join(".env").is_file() && dir.join("data").is_dir() {
                    break;
                }
                if !dir.pop() {
                    bail!("could not locate project root (.env + data/) — set WHOT_ROOT");
                }
            }
            dir
        };
        let env = parse_env(&root.join(".env"));
        let db = root.join(env.get("FACES_DB").map(|s| s.as_str()).unwrap_or("data/faces.db"));
        let config = root.join(
            env.get("CONFIG_FILE")
                .map(|s| s.as_str())
                .unwrap_or("config/hoistrc.json"),
        );
        Ok(Paths { root, db, config })
    }
}

/// Minimal .env parser mirroring import_roll.py (KEY=VALUE, ${VAR}, 4 passes).
pub fn parse_env(path: &Path) -> HashMap<String, String> {
    let mut raw: HashMap<String, String> = HashMap::new();
    if let Ok(text) = std::fs::read_to_string(path) {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((key, val)) = line.split_once('=') else { continue };
            let val = val.trim().trim_matches('"').trim_matches('\'').to_string();
            raw.insert(key.trim().to_string(), val);
        }
        for _ in 0..4 {
            let pairs: Vec<(String, String)> = raw.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            for val in raw.values_mut() {
                if val.contains("${") {
                    for (k, v) in &pairs {
                        *val = val.replace(&format!("${{{k}}}"), v);
                    }
                }
            }
        }
    }
    raw
}

pub fn connect(paths: &Paths) -> Result<Connection> {
    let con = Connection::open(&paths.db)
        .with_context(|| format!("cannot open {}", paths.db.display()))?;
    con.pragma_update(None, "journal_mode", "WAL")?;
    con.pragma_update(None, "foreign_keys", "ON")?;
    Ok(con)
}

// ---------------------------------------------------------------- settings

#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct Settings {
    pub cluster_threshold: f64,
    pub refcrop_n: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Self { cluster_threshold: DEFAULT_THRESHOLD, refcrop_n: DEFAULT_REFCROP_N }
    }
}

pub fn get_settings(paths: &Paths) -> Result<Settings> {
    match std::fs::read_to_string(&paths.config) {
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
        Err(_) => Ok(Settings::default()),
    }
}

pub fn set_settings(paths: &Paths, settings: Settings) -> Result<()> {
    if let Some(parent) = paths.config.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&paths.config, serde_json::to_string_pretty(&settings)?)?;
    Ok(())
}

// ---------------------------------------------------------------- snapshot

#[derive(Serialize, Clone)]
pub struct PersonCounts {
    pub total: i64,
    pub provisional: i64,
    pub confirmed: i64,
    pub rejected: i64,
}

#[derive(Serialize, Clone)]
pub struct Person {
    pub id: i64,
    pub name: String,
    pub state: String,
    pub note: Option<String>,
    pub primary_face_id: Option<i64>,
    pub primary_pinned: i64,
    pub groups: Vec<String>,
    pub counts: PersonCounts,
}

#[derive(Serialize, Clone)]
pub struct Face {
    pub id: i64,
    pub image_id: i64,
    pub person_id: i64,
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub name: String,
    pub seq: i64,
    pub description: Option<String>,
    pub confidence: f64,
    pub link_status: String,
    pub state: String,
    pub import_id: Option<i64>,
    pub created_at: String,
}

#[derive(Serialize, Clone)]
pub struct ImageRow {
    pub id: i64,
    pub primary_path: String,
    pub width: i64,
    pub height: i64,
    pub orientation: Option<String>,
    pub rtype: Option<String>,
    pub state: String,
    pub first_import_id: Option<i64>,
    pub last_import_id: Option<i64>,
}

#[derive(Serialize, Clone)]
pub struct ImportRow {
    pub id: i64,
    pub path: String,
    pub started_at: String,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub persons: Vec<Person>,
    pub faces: Vec<Face>,
    pub images: Vec<ImageRow>,
    pub imports: Vec<ImportRow>,
    pub settings: Settings,
}

pub fn snapshot(paths: &Paths) -> Result<Snapshot> {
    let con = connect(paths)?;

    let mut persons = Vec::new();
    {
        let mut st = con.prepare(
            "SELECT p.id, p.name, p.state, p.note, p.primary_face_id, p.primary_pinned
               FROM persons p
              ORDER BY (p.name GLOB 'Unknown*') DESC, p.name COLLATE NOCASE, p.id",
        )?;
        let rows = st.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<i64>>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })?;
        for row in rows {
            let (id, name, state, note, primary_face_id, primary_pinned) = row?;
            let (total, provisional, confirmed, rejected) = con
                .query_row(
                    "SELECT COUNT(*),
                            SUM(CASE WHEN link_status='provisional' THEN 1 ELSE 0 END),
                            SUM(CASE WHEN link_status='confirmed' THEN 1 ELSE 0 END),
                            SUM(CASE WHEN link_status='rejected' THEN 1 ELSE 0 END)
                       FROM faces WHERE person_id = ?",
                    params![id],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                            r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                            r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                        ))
                    },
                )
                .unwrap_or((0, 0, 0, 0));
            let mut groups: Vec<String> = con
                .prepare("SELECT path FROM person_groups WHERE person_id = ? ORDER BY path")?
                .query_map(params![id], |r| r.get(0))?
                .collect::<std::result::Result<_, _>>()?;
            groups.shrink_to_fit();
            persons.push(Person {
                id,
                name,
                state,
                note,
                primary_face_id,
                primary_pinned,
                groups,
                counts: PersonCounts { total, provisional, confirmed, rejected },
            });
        }
    }

    let faces: Vec<Face> = {
        let mut st = con.prepare(
            "SELECT id, image_id, person_id, x, y, w, h, name, seq, description,
                    confidence, link_status, state, detected_in_import_id, created_at
               FROM faces ORDER BY id",
        )?;
        st.query_map([], |r| {
            Ok(Face {
                id: r.get(0)?,
                image_id: r.get(1)?,
                person_id: r.get(2)?,
                x: r.get(3)?,
                y: r.get(4)?,
                w: r.get(5)?,
                h: r.get(6)?,
                name: r.get(7)?,
                seq: r.get(8)?,
                description: r.get(9)?,
                confidence: r.get(10)?,
                link_status: r.get(11)?,
                state: r.get(12)?,
                import_id: r.get(13)?,
                created_at: r.get(14)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?
    };

    let images: Vec<ImageRow> = {
        let mut st = con.prepare(
            "SELECT id, primary_path, width, height, orientation, type, state,
                    first_import_id, last_import_id FROM images ORDER BY id",
        )?;
        st.query_map([], |r| {
            Ok(ImageRow {
                id: r.get(0)?,
                primary_path: r.get(1)?,
                width: r.get(2)?,
                height: r.get(3)?,
                orientation: r.get(4)?,
                rtype: r.get(5)?,
                state: r.get(6)?,
                first_import_id: r.get(7)?,
                last_import_id: r.get(8)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?
    };

    let imports: Vec<ImportRow> = {
        let mut st = con.prepare("SELECT id, path, started_at FROM imports ORDER BY id DESC")?;
        st.query_map([], |r| Ok(ImportRow { id: r.get(0)?, path: r.get(1)?, started_at: r.get(2)? }))?
            .collect::<std::result::Result<_, _>>()?
    };

    let settings = get_settings(paths)?;
    Ok(Snapshot { persons, faces, images, imports, settings })
}

// ---------------------------------------------------------------- images

fn jpeg_data_url(bytes: &[u8]) -> String {
    format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

pub fn face_preview(paths: &Paths, face_id: i64) -> Result<String> {
    let con = connect(paths)?;
    let blob: Option<Vec<u8>> = con
        .query_row("SELECT preview FROM faces WHERE id = ?", params![face_id], |r| r.get(0))?;
    let blob = blob.context("face has no preview")?;
    Ok(jpeg_data_url(&blob))
}

pub fn image_blobs(paths: &Paths, image_id: i64) -> Result<Option<(String, Option<String>)>> {
    let con = connect(paths)?;
    let (thumb, preview): (Option<Vec<u8>>, Option<Vec<u8>>) = con
        .query_row(
            "SELECT thumbnail, preview FROM images WHERE id = ?",
            params![image_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .context("image not found")?;
    Ok(match (thumb, preview) {
        (Some(t), Some(p)) => Some((jpeg_data_url(&t), Some(jpeg_data_url(&p)))),
        (Some(t), None) => Some((jpeg_data_url(&t), None)),
        _ => None,
    })
}

// ---------------------------------------------------------------- derived state

/// Derived face label: `person.name[-description]-seq` (design §4.7).
pub fn face_name(person_name: &str, description: Option<&str>, seq: i64) -> String {
    match description {
        Some(d) if !d.is_empty() => format!("{person_name}-{d}-{seq}"),
        _ => format!("{person_name}-{seq}"),
    }
}

/// Re-derive `faces.name` for every face of a person (after renames / moves).
fn refresh_person_names(con: &Connection, person_id: i64) -> Result<()> {
    let person_name: String = con.query_row("SELECT name FROM persons WHERE id = ?", params![person_id], |r| r.get(0))?;
    let faces: Vec<(i64, Option<String>, i64)> = {
        let mut st = con.prepare(
            "SELECT id, description, seq FROM faces WHERE person_id = ?",
        )?;
        st.query_map(params![person_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?
    };
    for (id, description, seq) in faces {
        con.execute(
            "UPDATE faces SET name = ? WHERE id = ?",
            params![face_name(&person_name, description.as_deref(), seq), id],
        )?;
    }
    Ok(())
}

/// §4.5 — machine primary: highest-confidence non-discarded, non-rejected face;
/// unpin & clear stale primaries first. Mirrors import_roll.assign_missing_primaries.
fn backfill_primary(con: &Connection, person_id: i64) -> Result<()> {
    con.execute(
        "UPDATE persons SET primary_face_id = NULL, primary_pinned = 0
          WHERE id = ? AND primary_face_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM faces f
                             WHERE f.id = persons.primary_face_id
                               AND f.person_id = ? AND f.state != 'discarded')",
        params![person_id, person_id],
    )?;
    con.execute(
        "UPDATE persons SET primary_face_id = (
               SELECT f.id FROM faces f
                WHERE f.person_id = ? AND f.state != 'discarded' AND f.link_status != 'rejected'
                ORDER BY f.confidence DESC, f.id LIMIT 1)
          WHERE id = ? AND primary_face_id IS NULL
            AND EXISTS (SELECT 1 FROM faces f
                        WHERE f.person_id = ? AND f.state != 'discarded'
                          AND f.link_status != 'rejected')",
        params![person_id, person_id, person_id],
    )?;
    Ok(())
}

/// §4.6 — refcrops: keep manual (`pin:`) rows, rebuild auto rows as the top
/// `refcrop_n` confirmed faces by confidence, excluding the primary face.
fn recompute_refcrops(con: &Connection, person_id: i64, n: i64) -> Result<()> {
    con.execute(
        "DELETE FROM person_refcrops WHERE person_id = ? AND description NOT LIKE 'pin:%'",
        params![person_id],
    )?;
    let primary: Option<i64> = con
        .query_row("SELECT primary_face_id FROM persons WHERE id = ?", params![person_id], |r| {
            r.get(0)
        })
        .optional()?
        .flatten();
    let mut st = con.prepare(
        "SELECT f.id, f.name, f.description, f.preview FROM faces f
          WHERE f.person_id = ? AND f.link_status = 'confirmed' AND f.state != 'discarded'
            AND f.id IS NOT ?
          ORDER BY f.confidence DESC, f.id LIMIT ?",
    )?;
    let rows = st
        .query_map(params![person_id, primary, n], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Vec<u8>>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (seq, (face_id, name, description, crop)) in rows.into_iter().enumerate() {
        let seq = (seq as i64) + 1;
        let desc = description.filter(|d| !d.is_empty()).unwrap_or_else(|| "auto".into());
        let filename = format!("{name}-{seq}.jpg");
        con.execute(
            "INSERT OR REPLACE INTO person_refcrops (person_id, face_id, description, seq, filename, crop)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![person_id, face_id, desc, seq, filename, crop],
        )?;
    }
    Ok(())
}

fn recompute_person(con: &Connection, person_id: i64, settings: &Settings) -> Result<()> {
    backfill_primary(con, person_id)?;
    recompute_refcrops(con, person_id, settings.refcrop_n)
}

fn ids_list(ids: &[i64]) -> String {
    ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")
}

/// Persons touched by a set of faces + any additional id, deduped.
fn affected_persons(
    con: &Connection,
    face_ids: &[i64],
    extra: Option<i64>,
) -> Result<Vec<i64>> {
    let mut set: HashSet<i64> = HashSet::new();
    if let Some(id) = extra {
        set.insert(id);
    }
    if !face_ids.is_empty() {
        let list = ids_list(face_ids);
        let mut st = con.prepare(&format!("SELECT DISTINCT person_id FROM faces WHERE id IN ({list})"))?;
        let rows = st.query_map([], |r| r.get::<_, i64>(0))?;
        for row in rows {
            set.insert(row?);
        }
    }
    let mut out: Vec<i64> = set.into_iter().collect();
    out.sort();
    Ok(out)
}

pub fn normalize_description(raw: &str) -> Option<String> {
    let parts: Vec<&str> = raw
        .split('|')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("|"))
    }
}

fn validate_person_name(name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        bail!("person name must not be empty");
    }
    if name.to_ascii_lowercase().starts_with("unknown") {
        bail!("person names may not start with 'Unknown' (reserved for importer clusters)");
    }
    Ok(())
}

// ---------------------------------------------------------------- mutations

/// §4.1 — assign selected faces to a person (accept + name + group).
/// Renames an UnknownN in place when the selection is exactly its faces;
/// otherwise moves faces to an existing or newly created person.
pub fn assign_person(paths: &Paths, face_ids: &[i64], name: &str, group_path: &str) -> Result<()> {
    validate_person_name(name)?;
    let name = name.trim().to_string();
    let group_path = group_path.trim().to_string();
    if face_ids.is_empty() {
        bail!("no faces selected");
    }
    let mut con = connect(paths)?;
    let settings = get_settings(paths)?;
    let tx = con.transaction()?;

    let selected: Vec<(i64, i64)> = {
        let list = ids_list(face_ids);
        let mut st = tx.prepare(&format!("SELECT id, person_id FROM faces WHERE id IN ({list})"))?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if rows.len() != face_ids.len() {
            bail!("some selected faces no longer exist");
        }
        rows
    };
    let mut old_persons: HashSet<i64> = selected.iter().map(|(_, p)| *p).collect();

    let target: i64 = match tx
        .query_row("SELECT id FROM persons WHERE name = ?", params![name], |r| r.get(0))
        .optional()?
    {
        Some(id) => id,
        None => {
            let single_unknown = if old_persons.len() == 1 {
                let pid = *old_persons.iter().next().unwrap();
                let pname: String =
                    tx.query_row("SELECT name FROM persons WHERE id = ?", params![pid], |r| r.get(0))?;
                if pname.starts_with("Unknown") {
                    tx.execute("UPDATE persons SET name = ? WHERE id = ?", params![name, pid])?;
                    Some(pid)
                } else {
                    None
                }
            } else {
                None
            };
            match single_unknown {
                Some(pid) => {
                    old_persons.remove(&pid);
                    pid
                }
                None => {
                    tx.execute(
                        "INSERT INTO persons (name, state, created_at) VALUES (?, 'created', datetime('now'))",
                        params![name],
                    )?;
                    tx.last_insert_rowid()
                }
            }
        }
    };

    // group: one path per person; empty ⇒ Ungrouped (no rows)
    tx.execute("DELETE FROM person_groups WHERE person_id = ?", params![target])?;
    if !group_path.is_empty() {
        tx.execute(
            "INSERT OR REPLACE INTO person_groups (person_id, path) VALUES (?, ?)",
            params![target, group_path],
        )?;
    }

    for (face_id, person_id) in &selected {
        if *person_id == target {
            tx.execute(
                "UPDATE faces SET link_status = 'confirmed' WHERE id = ?",
                params![face_id],
            )?;
        } else {
            // importer-style seq: next free number for (person, description)
            let seq: i64 = tx.query_row(
                "SELECT COUNT(*) + 1 FROM faces
                  WHERE person_id = ?
                    AND COALESCE(description, '') = COALESCE((SELECT description FROM faces WHERE id = ?), '')",
                params![target, face_id],
                |r| r.get(0),
            )?;
            tx.execute(
                "UPDATE faces SET person_id = ?, link_status = 'confirmed', reassigned = 1, seq = ? WHERE id = ?",
                params![target, seq, face_id],
            )?;
        }
    }

    refresh_person_names(&tx, target)?;
    // NOTE: affected must include the *old* owners — after the UPDATEs above the
    // faces no longer point at them, so querying faces would miss them and they
    // would keep stale primary_face_id pointers (UNIQUE violation).
    let mut affected: Vec<i64> = old_persons.iter().copied().collect();
    if !affected.contains(&target) {
        affected.push(target);
    }
    affected.sort();
    for pid in &affected {
        recompute_person(&tx, *pid, &settings)?;
    }
    tx.commit()?;
    Ok(())
}

/// §4.3 — accept (confirm) faces in place.
pub fn set_link_status(paths: &Paths, face_ids: &[i64], status: &str) -> Result<()> {
    if !matches!(status, "confirmed" | "rejected") {
        bail!("bad status {status}");
    }
    if face_ids.is_empty() {
        bail!("no faces selected");
    }
    let mut con = connect(paths)?;
    let settings = get_settings(paths)?;
    let tx = con.transaction()?;
    let list = ids_list(face_ids);
    tx.execute(
        &format!("UPDATE faces SET link_status = ? WHERE id IN ({list})"),
        params![status],
    )?;
    let affected = affected_persons(&tx, face_ids, None)?;
    for pid in &affected {
        recompute_person(&tx, *pid, &settings)?;
    }
    tx.commit()?;
    Ok(())
}

/// §4.4 — set face description (normalised) and re-derive the face label.
pub fn set_face_description(paths: &Paths, face_id: i64, raw: &str) -> Result<()> {
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    let desc = normalize_description(raw);
    let (person_id, seq): (i64, i64) = tx.query_row(
        "SELECT person_id, seq FROM faces WHERE id = ?",
        params![face_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    tx.execute("UPDATE faces SET description = ? WHERE id = ?", params![desc, face_id])?;
    let person_name: String =
        tx.query_row("SELECT name FROM persons WHERE id = ?", params![person_id], |r| r.get(0))?;
    tx.execute(
        "UPDATE faces SET name = ? WHERE id = ?",
        params![face_name(&person_name, desc.as_deref(), seq), face_id],
    )?;
    tx.commit()?;
    Ok(())
}

/// §4.5 — user-pinned primary face.
pub fn set_primary_face(paths: &Paths, person_id: i64, face_id: i64) -> Result<()> {
    let mut con = connect(paths)?;
    let settings = get_settings(paths)?;
    let tx = con.transaction()?;
    let ok: bool = tx.query_row(
        "SELECT 1 FROM faces WHERE id = ? AND person_id = ?
          AND state != 'discarded' AND link_status != 'rejected'",
        params![face_id, person_id],
        |r| r.get(0),
    )
    .optional()?
    .unwrap_or(false);
    if !ok {
        bail!("face does not belong to this person or is not eligible");
    }
    tx.execute(
        "UPDATE persons SET primary_face_id = ?, primary_pinned = 1 WHERE id = ?",
        params![face_id, person_id],
    )?;
    recompute_person(&tx, person_id, &settings)?;
    tx.commit()?;
    Ok(())
}

pub fn set_person_name(paths: &Paths, person_id: i64, name: &str) -> Result<()> {
    validate_person_name(name)?;
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    let exists: bool = tx
        .query_row(
            "SELECT 1 FROM persons WHERE name = ? AND id != ?",
            params![name.trim(), person_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false);
    if exists {
        bail!("a person named {name} already exists");
    }
    tx.execute("UPDATE persons SET name = ? WHERE id = ?", params![name.trim(), person_id])?;
    refresh_person_names(&tx, person_id)?;
    tx.commit()?;
    Ok(())
}

pub fn set_person_group(paths: &Paths, person_id: i64, path: &str) -> Result<()> {
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    let path = path.trim().to_string();
    tx.execute("DELETE FROM person_groups WHERE person_id = ?", params![person_id])?;
    if !path.is_empty() {
        tx.execute(
            "INSERT OR REPLACE INTO person_groups (person_id, path) VALUES (?, ?)",
            params![person_id, path],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn set_person_note(paths: &Paths, person_id: i64, note: &str) -> Result<()> {
    let con = connect(paths)?;
    con.execute(
        "UPDATE persons SET note = ? WHERE id = ?",
        params![if note.trim().is_empty() { None } else { Some(note.trim()) }, person_id],
    )?;
    Ok(())
}

/// §4.6 — manually promote a confirmed face into refcrops (survives rebuilds).
pub fn add_refcrop(paths: &Paths, person_id: i64, face_id: i64) -> Result<()> {
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    let (ok, name, desc, crop): (bool, String, Option<String>, Option<Vec<u8>>) = tx
        .query_row(
            "SELECT person_id = ?, name, description, preview FROM faces
              WHERE id = ? AND link_status = 'confirmed' AND state != 'discarded'",
            params![person_id, face_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?
        .unwrap_or((false, String::new(), None, None));
    if !ok {
        bail!("face is not a confirmed face of this person");
    }
    let other: Option<i64> = tx
        .query_row(
            "SELECT person_id FROM person_refcrops WHERE face_id = ? AND person_id != ?",
            params![face_id, person_id],
            |r| r.get(0),
        )
        .optional()?;
    if other.is_some() {
        bail!("face is already a reference face of another person");
    }
    let pin_desc = format!("pin:{}", desc.filter(|d| !d.is_empty()).unwrap_or_default());
    let existing: Option<String> = tx
        .query_row(
            "SELECT description FROM person_refcrops WHERE person_id = ? AND face_id = ?",
            params![person_id, face_id],
            |r| r.get(0),
        )
        .optional()?;
    match existing {
        Some(d) if d.starts_with("pin:") => {} // already pinned — no-op
        Some(_) => {
            // upgrade an auto row to a pin (keeps its seq/filename/crop)
            tx.execute(
                "UPDATE person_refcrops SET description = ? WHERE person_id = ? AND face_id = ?",
                params![pin_desc, person_id, face_id],
            )?;
        }
        None => {
            let seq: i64 = tx.query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM person_refcrops WHERE person_id = ? AND description = ?",
                params![person_id, pin_desc],
                |r| r.get(0),
            )?;
            let filename = format!("{name}-{seq}.jpg");
            let crop = crop.context("face has no preview")?;
            tx.execute(
                "INSERT INTO person_refcrops (person_id, face_id, description, seq, filename, crop)
                 VALUES (?, ?, ?, ?, ?, ?)",
                params![person_id, face_id, pin_desc, seq, filename, crop],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn remove_refcrop(paths: &Paths, person_id: i64, face_id: i64) -> Result<()> {
    let con = connect(paths)?;
    con.execute(
        "DELETE FROM person_refcrops WHERE person_id = ? AND face_id = ?",
        params![person_id, face_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------- similarity

fn l2_vectors(con: &Connection, face_ids: &[i64]) -> Result<Vec<Vec<f32>>> {
    let mut out = Vec::with_capacity(face_ids.len());
    let list = ids_list(face_ids);
    let mut st = con.prepare(&format!(
        "SELECT face_id, vector FROM face_embeddings
          WHERE face_id IN ({list}) AND model = ? ORDER BY face_id"
    ))?;
    let mut map: HashMap<i64, Vec<f32>> = HashMap::new();
    let rows = st.query_map(params![MODEL_TAG], |r| {
        let fid: i64 = r.get(0)?;
        let blob: Vec<u8> = r.get(1)?;
        let v: Vec<f32> = blob.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
        Ok((fid, v))
    })?;
    for row in rows {
        let (fid, v) = row?;
        map.insert(fid, v);
    }
    for &id in face_ids {
        out.push(map.remove(&id).unwrap_or_default());
    }
    Ok(out)
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    a.iter().zip(b).map(|(x, y)| (*x as f64) * (*y as f64)).sum()
}

#[derive(Serialize, Clone)]
pub struct ClusterFace {
    pub face_id: i64,
    /// cosine similarity to the person's reference (primary) face
    pub sim: f64,
}

/// §4.9 — display-side single-linkage grouping of one person's faces around
/// the primary face. Rejected/discarded faces are excluded.
pub fn person_face_clusters(paths: &Paths, person_id: i64, threshold: f64) -> Result<Vec<Vec<ClusterFace>>> {
    let con = connect(paths)?;
    let faces: Vec<(i64, f64, bool)> = {
        let mut st = con.prepare(
            "SELECT id, confidence, (id = (SELECT primary_face_id FROM persons WHERE id = ?)) AS is_primary
               FROM faces
              WHERE person_id = ? AND state != 'discarded' AND link_status != 'rejected'
              ORDER BY id",
        )?;
        st.query_map(params![person_id, person_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?, r.get::<_, i64>(2)? != 0))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
    };
    if faces.is_empty() {
        return Ok(Vec::new());
    }
    let primary = faces.iter().find(|(_, _, p)| *p).map(|(id, _, _)| *id)
        .or_else(|| faces.iter().max_by(|a, b| a.1.partial_cmp(&b.1).unwrap()).map(|(id, _, _)| *id));
    let ids: Vec<i64> = faces.iter().map(|(id, _, _)| *id).collect();
    let vectors = l2_vectors(&con, &ids)?;

    // reference = primary face's vector (fallback: highest-confidence face)
    let ref_idx = faces.iter().position(|(id, _, _)| Some(*id) == primary).unwrap_or(0);
    let sims: Vec<f64> = faces
        .iter()
        .enumerate()
        .map(|(i, &(id, _, _))| {
            if Some(id) == primary || vectors[i].is_empty() {
                1.0
            } else {
                cosine(&vectors[ref_idx], &vectors[i])
            }
        })
        .collect();

    // single-linkage: each face joins the first cluster with a member at ≥ threshold
    let mut clusters: Vec<Vec<usize>> = Vec::new();
    let order: Vec<usize> = (0..faces.len()).collect();
    let mut order = order;
    order.sort_by(|&a, &b| sims[b].partial_cmp(&sims[a]).unwrap());
    for i in order {
        let mut joined = false;
        for cluster in clusters.iter_mut() {
            if cluster.iter().any(|&j| cosine(&vectors[i], &vectors[j]) >= threshold) {
                cluster.push(i);
                joined = true;
                break;
            }
        }
        if !joined {
            clusters.push(vec![i]);
        }
    }
    clusters.sort_by(|a, b| sims[b[0]].partial_cmp(&sims[a[0]]).unwrap_or(std::cmp::Ordering::Equal));

    Ok(clusters
        .into_iter()
        .map(|c| {
            c.into_iter()
                .map(|i| ClusterFace {
                    face_id: faces[i].0,
                    sim: sims[i],
                })
                .collect()
        })
        .collect())
}

#[derive(Serialize, Clone)]
pub struct Refcrop {
    pub face_id: i64,
    pub seq: i64,
    pub description: String,
    pub filename: String,
    pub image: String,
}

pub fn get_refcrops(paths: &Paths, person_id: i64) -> Result<Vec<Refcrop>> {
    let con = connect(paths)?;
    let mut st = con.prepare(
        "SELECT face_id, seq, description, filename, crop
           FROM person_refcrops WHERE person_id = ? ORDER BY seq, description",
    )?;
    let rows = st.query_map(params![person_id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, Vec<u8>>(4)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (face_id, seq, description, filename, crop) = row?;
        out.push(Refcrop {
            face_id,
            seq,
            description,
            filename,
            image: jpeg_data_url(&crop),
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_paths() -> Paths {
        let root = std::env::temp_dir().join(format!("whot-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../data/faces.db");
        std::fs::copy(&src, root.join("faces.db")).unwrap();
        Paths {
            root: root.clone(),
            db: root.join("faces.db"),
            config: root.join("hoistrc.json"),
        }
    }

    #[test]
    fn full_workflow() {
        let p = temp_paths();

        // baseline
        let s = snapshot(&p).unwrap();
        assert_eq!(s.persons.len(), 30);
        assert_eq!(s.faces.len(), 61);
        assert!(s.faces.iter().all(|f| f.link_status == "provisional"));

        // 1) rename Unknown1 in place (its single face 1)
        assign_person(&p, &[1], "Test Alice", "family|test").unwrap();
        let s = snapshot(&p).unwrap();
        let alice = s.persons.iter().find(|x| x.name == "Test Alice").unwrap();
        assert_eq!(alice.groups, vec!["family|test".to_string()]);
        let f1 = s.faces.iter().find(|f| f.id == 1).unwrap();
        assert_eq!(f1.link_status, "confirmed");
        assert_eq!(f1.name, "Test Alice-1");
        assert_eq!(alice.primary_face_id, Some(1));

        // 2) move faces from two different UnknownNs to a fresh person
        let f30 = s.faces.iter().find(|f| f.id == 30).unwrap();
        let f31 = s.faces.iter().find(|f| f.id == 31).unwrap();
        let (p30, p31) = (f30.person_id, f31.person_id);
        assert_ne!(p30, p31);
        assign_person(&p, &[30, 31], "Test Bob", "").unwrap();
        let s = snapshot(&p).unwrap();
        let bob = s.persons.iter().find(|x| x.name == "Test Bob").unwrap();
        assert!(bob.groups.is_empty());
        for fid in [30, 31] {
            let f = s.faces.iter().find(|f| f.id == fid).unwrap();
            assert_eq!(f.person_id, bob.id);
            assert_eq!(f.link_status, "confirmed");
        }
        let names: Vec<&str> = s.faces.iter().filter(|f| f.person_id == bob.id).map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["Test Bob-1", "Test Bob-2"]);
        // source persons lost their only face → no primary
        for pid in [p30, p31] {
            let per = s.persons.iter().find(|x| x.id == pid).unwrap();
            assert!(per.primary_face_id.is_none());
        }

        // 3) reject a face
        set_link_status(&p, &[32], "rejected").unwrap();
        let s = snapshot(&p).unwrap();
        assert_eq!(s.faces.iter().find(|f| f.id == 32).unwrap().link_status, "rejected");

        // 4) description normalisation + derived name
        set_face_description(&p, 1, "  beard | glasses ").unwrap();
        let s = snapshot(&p).unwrap();
        let f1 = s.faces.iter().find(|f| f.id == 1).unwrap();
        assert_eq!(f1.description.as_deref(), Some("beard|glasses"));
        assert_eq!(f1.name, "Test Alice-beard|glasses-1");

        // 5) pinned primary + refcrops exclude it; manual pin survives rebuild
        let bob = s.persons.iter().find(|x| x.name == "Test Bob").unwrap();
        set_primary_face(&p, bob.id, 31).unwrap();
        add_refcrop(&p, bob.id, 30).unwrap();
        let rc = get_refcrops(&p, bob.id).unwrap();
        assert!(rc.iter().any(|r| r.face_id == 30 && r.description.starts_with("pin:")));
        assert!(rc.iter().all(|r| r.face_id != 31));

        // 6) re-accept the rejected face back into its person
        set_link_status(&p, &[32], "confirmed").unwrap();
        let s = snapshot(&p).unwrap();
        assert_eq!(s.faces.iter().find(|f| f.id == 32).unwrap().link_status, "confirmed");

        // 7) clusters on a 2-face person
        let bob = s.persons.iter().find(|x| x.name == "Test Bob").unwrap();
        let cl = person_face_clusters(&p, bob.id, 0.4).unwrap();
        assert!(cl.len() == 1 || cl.len() == 2);
        assert_eq!(cl.iter().map(|c| c.len()).sum::<usize>(), 2);

        // 8) name validation
        assert!(assign_person(&p, &[33], "Unknown99", "").is_err());
        assert!(set_person_name(&p, bob.id, "Test Bob").is_ok()); // self-rename no-op

        // 9) settings round-trip
        set_settings(&p, Settings { cluster_threshold: 0.5, refcrop_n: 3 }).unwrap();
        assert_eq!(get_settings(&p).unwrap().refcrop_n, 3);

        std::fs::remove_dir_all(p.root).ok();
    }
}
