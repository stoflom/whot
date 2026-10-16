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
/// Must match `schema_version.version` in database/schema.sql — exact
/// match, no migrations by policy: mismatched DBs are refused up-front
/// with recreate instructions instead of failing on the first query.
pub const SCHEMA_VERSION: &str = "1.5";
const DEFAULT_THRESHOLD: f64 = 0.40;
const DEFAULT_REFCROP_N: i64 = 5;

// ---------------------------------------------------------------- paths

pub struct Paths {
    pub db: PathBuf,
    pub config: PathBuf,
}

impl Paths {
    /// Resolve project root (`.env` or `data/` marker), then FACES_DB /
    /// CONFIG_FILE from .env — mirrors import_roll.py resolution.
    /// `WHOT_ROOT` overrides (documented in README; required for packaged
    /// builds, where the cwd will not contain the repo checkout).
    pub fn resolve() -> Result<Paths> {
        let root = if let Ok(r) = std::env::var("WHOT_ROOT") {
            PathBuf::from(r)
        } else {
            let mut dir = std::env::current_dir()
                .context("no current directory")?;
            loop {
                // `.env` alone suffices — every key has a default, and a
                // fresh clone has no data/ directory yet (F11)
                if dir.join(".env").is_file() || dir.join("data").is_dir() {
                    break;
                }
                if !dir.pop() {
                    bail!("could not locate project root (.env or data/) — set WHOT_ROOT");
                }
            }
            dir
        };
        let env = parse_env(&root.join(".env"));
        let db = root.join(env.get("FACES_DB").map(|s| s.as_str()).unwrap_or("data/faces.db"));
        let config = root.join(
            env.get("CONFIG_FILE")
                .map(|s| s.as_str())
                .unwrap_or("config/whotrc.json"),
        );
        Ok(Paths { db, config })
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
        // keys not defined in the file fall back to the process environment
        // so `${HOME}`/`${USER}` resolve (F15); unknown refs stay literal
        for val in raw.values_mut() {
            if val.contains("${") {
                *val = expand_process_env(val);
            }
        }
    }
    raw
}

/// Replace `${KEY}` with the process-environment value; unknown keys stay literal.
fn expand_process_env(val: &str) -> String {
    let mut out = String::with_capacity(val.len());
    let mut rest = val;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        rest = &rest[start + 2..];
        let Some(end) = rest.find('}') else {
            out.push_str("${");
            break;
        };
        let key = &rest[..end];
        match std::env::var(key) {
            Ok(v) => out.push_str(&v),
            Err(_) => {
                out.push_str("${");
                out.push_str(key);
                out.push('}');
            }
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

pub fn connect(paths: &Paths) -> Result<Connection> {
    if let Some(parent) = paths.db.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("cannot create {}", parent.display()))?;
    }
    let con = Connection::open(&paths.db)
        .with_context(|| format!("cannot open {}", paths.db.display()))?;
    con.pragma_update(None, "journal_mode", "WAL")?;
    con.pragma_update(None, "foreign_keys", "ON")?;
    // the importer runs in a separate process — don't fail instantly on lock
    // contention (F16); matches python sqlite3's 5s default timeout
    con.pragma_update(None, "busy_timeout", 5000)?;
    check_schema(&con, &paths.db)?;
    Ok(con)
}

/// Compatibility gate: every connection must see the schema this build
/// expects (v1.5 introduces the marker itself).
fn check_schema(con: &Connection, db: &Path) -> Result<()> {
    let v: String = con
        .query_row("SELECT version FROM schema_version", [], |r| r.get(0))
        .with_context(|| {
            format!(
                "{} has no schema_version marker — not a WhoT v{SCHEMA_VERSION} database;\n\
                 create it with: sqlite3 {} < database/schema.sql",
                db.display(),
                db.display()
            )
        })?;
    if v != SCHEMA_VERSION {
        bail!(
            "database schema v{v} does not match this build (v{SCHEMA_VERSION}) — \
             no migrations by policy. Preserve annotations first if wanted:\n\
             scripts/annotation_snapshot.py export, then recreate with:\n\
             sqlite3 {} < database/schema.sql",
            db.display()
        );
    }
    Ok(())
}

// ---------------------------------------------------------------- settings

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
pub struct Settings {
    pub cluster_threshold: f64,
    pub refcrop_n: i64,
    /// Show rejected faces in the UI (§4.10). Defaults to true when the
    /// key is absent from an existing whotrc.json.
    #[serde(default = "default_show_rejected")]
    pub show_rejected: bool,
}

fn default_show_rejected() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            cluster_threshold: DEFAULT_THRESHOLD,
            refcrop_n: DEFAULT_REFCROP_N,
            show_rejected: true,
        }
    }
}

pub fn get_settings(paths: &Paths) -> Result<Settings> {
    match std::fs::read_to_string(&paths.config) {
        Ok(text) => match serde_json::from_str::<Settings>(&text) {
            Ok(s) => Ok(s),
            Err(e) => {
                // #44: a malformed whotrc.json must not vanish silently —
                // warn and fall back to defaults so the app keeps working
                eprintln!(
                    "warning: could not parse {} ({e}); using default settings",
                    paths.config.display()
                );
                Ok(Settings::default())
            }
        },
        Err(_) => Ok(Settings::default()), // first run: no config file yet
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
    /// NULL for faces whose person was removed (§4.13) — they stay in the
    /// DB as rejected, unowned records
    pub person_id: Option<i64>,
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

    // grouped queries — one pass for all face counts, one for all group paths
    // (F20: previously 2 extra queries per person)
    let mut counts: HashMap<i64, PersonCounts> = HashMap::new();
    {
        let mut st = con.prepare(
            "SELECT person_id, COUNT(*),
                    COALESCE(SUM(link_status = 'provisional'), 0),
                    COALESCE(SUM(link_status = 'confirmed'), 0),
                    COALESCE(SUM(link_status = 'rejected'), 0)
               FROM faces WHERE person_id IS NOT NULL GROUP BY person_id",
        )?;
        for row in st.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                PersonCounts {
                    total: r.get(1)?,
                    provisional: r.get(2)?,
                    confirmed: r.get(3)?,
                    rejected: r.get(4)?,
                },
            ))
        })? {
            let (pid, c) = row?;
            counts.insert(pid, c);
        }
    }
    let mut groups: HashMap<i64, Vec<String>> = HashMap::new();
    {
        let mut st =
            con.prepare("SELECT person_id, path FROM person_groups ORDER BY person_id, path")?;
        for row in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
            let (pid, path) = row?;
            groups.entry(pid).or_default().push(path);
        }
    }

    let mut persons = Vec::new();
    {
        let mut st = con.prepare(
            "SELECT p.id, p.name, p.state, p.note, p.primary_face_id, p.primary_pinned
               FROM persons p
              ORDER BY (p.name GLOB 'Unknown*') DESC, p.name COLLATE NOCASE, p.id",
        )?;
        let rows = st.query_map([], |r| {
            Ok(Person {
                id: r.get(0)?,
                name: r.get(1)?,
                state: r.get(2)?,
                note: r.get(3)?,
                primary_face_id: r.get(4)?,
                primary_pinned: r.get(5)?,
                groups: Vec::new(),
                counts: PersonCounts { total: 0, provisional: 0, confirmed: 0, rejected: 0 },
            })
        })?;
        for row in rows {
            let mut p = row?;
            p.counts = counts
                .remove(&p.id)
                .unwrap_or(PersonCounts { total: 0, provisional: 0, confirmed: 0, rejected: 0 });
            p.groups = groups.remove(&p.id).unwrap_or_default();
            persons.push(p);
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

/// Raw preview bytes (thumbnail fallback) for the full-image context menu:
/// written to a temp file and handed to the system viewer (#33).
pub fn image_preview_bytes(paths: &Paths, image_id: i64) -> Result<Option<Vec<u8>>> {
    let con = connect(paths)?;
    let (preview, thumb): (Option<Vec<u8>>, Option<Vec<u8>>) = con
        .query_row(
            "SELECT preview, thumbnail FROM images WHERE id = ?",
            params![image_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .context("image not found")?;
    Ok(preview.or(thumb))
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
/// unpin & clear stale/ineligible primaries first (a rejected face must not
/// stay primary — F3). Mirrors import_roll.assign_missing_primaries.
fn backfill_primary(con: &Connection, person_id: i64) -> Result<()> {
    con.execute(
        "UPDATE persons SET primary_face_id = NULL, primary_pinned = 0
          WHERE id = ? AND primary_face_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM faces f
                             WHERE f.id = persons.primary_face_id
                               AND f.person_id = ? AND f.state != 'discarded'
                               AND f.link_status != 'rejected')",
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

/// §4.6 — refcrops: one top-N group per distinct (person, description).
/// Pinned rows (`pinned = 1`) are excluded from auto-selection, survive the
/// rebuild, and their seq slots are skipped by that group's auto rows.
fn recompute_refcrops(con: &Connection, person_id: i64, n: i64) -> Result<()> {
    con.execute(
        "DELETE FROM person_refcrops WHERE person_id = ? AND pinned = 0",
        params![person_id],
    )?;
    // seq slots still occupied by surviving pins, per appearance group
    let mut pinned: HashMap<String, HashSet<i64>> = HashMap::new();
    {
        let mut st =
            con.prepare("SELECT description, seq FROM person_refcrops WHERE person_id = ?")?;
        let rows = st.query_map(params![person_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (group, seq) = row?;
            pinned.entry(group).or_default().insert(seq);
        }
    }
    let primary: Option<i64> = con
        .query_row("SELECT primary_face_id FROM persons WHERE id = ?", params![person_id], |r| {
            r.get(0)
        })
        .optional()?
        .flatten();
    let mut st = con.prepare(
        "SELECT face_id, name, description, preview, rn FROM (
             SELECT f.id AS face_id, f.name, f.description, f.preview,
                    ROW_NUMBER() OVER (PARTITION BY COALESCE(f.description, '')
                                       ORDER BY f.confidence DESC, f.id) AS rn
               FROM faces f
              WHERE f.person_id = ? AND f.link_status = 'confirmed'
                AND f.state != 'discarded'
                AND f.id IS NOT ?
                AND NOT EXISTS (SELECT 1 FROM person_refcrops pr    -- pins survive (F1)
                                 WHERE pr.face_id = f.id AND pr.pinned = 1)
          ) WHERE rn <= ? ORDER BY rn",
    )?;
    let rows = st
        .query_map(params![person_id, primary, n], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                // #39: faces.preview is nullable — read it as Option and
                // skip crop-less faces below instead of aborting the whole
                // mutation transaction
                r.get::<_, Option<Vec<u8>>>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    // rn-order within each group; skip seq slots held by pins of that group
    let mut next: HashMap<String, i64> = HashMap::new();
    for (face_id, name, description, crop, rn) in rows {
        let crop = match crop {
            Some(crop) => crop,
            None => continue, // a face without a preview cannot become a refcrop
        };
        let group = description.filter(|d| !d.is_empty()).unwrap_or_default();
        let cursor = next.get(&group).copied().unwrap_or(1);
        let mut seq = rn.max(cursor);
        while pinned.get(&group).is_some_and(|s| s.contains(&seq)) {
            seq += 1;
        }
        next.insert(group.clone(), seq + 1);
        let filename = format!("{name}-{seq}.jpg");
        con.execute(
            "INSERT OR REPLACE INTO person_refcrops
               (person_id, face_id, description, pinned, seq, filename, crop)
             VALUES (?, ?, ?, 0, ?, ?, ?)",
            params![person_id, face_id, group, seq, filename, crop],
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
        // person_id IS NOT NULL: removed persons leave unowned faces (§4.13)
        let mut st = con.prepare(&format!(
            "SELECT DISTINCT person_id FROM faces WHERE person_id IS NOT NULL AND id IN ({list})"
        ))?;
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
    let group_path = normalize_group_path(group_path); // #42
    if face_ids.is_empty() {
        bail!("no faces selected");
    }
    // dedupe: a repeated id must not trip the existence check below (F19)
    let mut ids: Vec<i64> = face_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let mut con = connect(paths)?;
    let settings = get_settings(paths)?;
    let tx = con.transaction()?;

    let selected: Vec<(i64, Option<i64>, String)> = {
        let list = ids_list(&ids);
        let mut st = tx.prepare(&format!("SELECT id, person_id, link_status FROM faces WHERE id IN ({list})"))?;
        let rows = st
            .query_map(
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<i64>>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if rows.len() != ids.len() {
            bail!("some selected faces no longer exist");
        }
        rows
    };
    let mut old_persons: HashSet<i64> = selected.iter().filter_map(|(_, p, _)| *p).collect();

    // (target, owns_group): the group field only applies when we rename an
    // UnknownN in place or create the person — merging into an existing
    // person must not clobber their group path (F2, design §4.1)
    let (target, owns_group): (i64, bool) = match tx
        .query_row("SELECT id FROM persons WHERE name = ?", params![name], |r| r.get(0))
        .optional()?
    {
        Some(id) => (id, false),
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
                    (pid, true)
                }
                None => {
                    tx.execute(
                        "INSERT INTO persons (name, state, created_at) VALUES (?, 'created', datetime('now'))",
                        params![name],
                    )?;
                    (tx.last_insert_rowid(), true)
                }
            }
        }
    };

    // group: one path per person; empty ⇒ Ungrouped (no rows)
    if owns_group {
        tx.execute("DELETE FROM person_groups WHERE person_id = ?", params![target])?;
        if !group_path.is_empty() {
            tx.execute(
                "INSERT OR REPLACE INTO person_groups (person_id, path) VALUES (?, ?)",
                params![target, group_path],
            )?;
        }
    }

    for (face_id, person_id, status) in &selected {
        if *person_id == Some(target) {
            // sticky rejected (design §4.2): a rename never un-rejects —
            // confirm only faces that aren't already rejected
            tx.execute(
                "UPDATE faces SET link_status = 'confirmed'
                  WHERE id = ? AND link_status != 'rejected'",
                params![face_id],
            )?;
        } else {
            // gap-proof next free number: MAX+1, not COUNT+1 — moving faces
            // out leaves seq gaps and COUNT+1 could collide with an existing
            // seq, producing duplicate names (F5, design §4.7)
            let seq: i64 = tx.query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM faces
                  WHERE person_id = ?
                    AND COALESCE(description, '') = COALESCE((SELECT description FROM faces WHERE id = ?), '')",
                params![target, face_id],
                |r| r.get(0),
            )?;
            if status == "rejected" {
                // sticky rejected (design §4.2): the face moves with its
                // person but keeps its status — only an explicit accept
                // un-rejects it
                tx.execute(
                    "UPDATE faces SET person_id = ?, reassigned = 1, seq = ? WHERE id = ?",
                    params![target, seq, face_id],
                )?;
            } else {
                tx.execute(
                    "UPDATE faces SET person_id = ?, link_status = 'confirmed', reassigned = 1, seq = ? WHERE id = ?",
                    params![target, seq, face_id],
                )?;
            }
        }
    }

    refresh_person_names(&tx, target)?;
    // §4.1/§4.13 housekeeping: a person left with zero faces by this move is
    // a stale shell — delete it (groups/refcrops cascade) so merges and
    // whole-group moves don't leave the old person behind in the tree.
    for pid in &old_persons {
        let n: i64 = tx.query_row(
            "SELECT COUNT(*) FROM faces WHERE person_id = ?",
            params![pid],
            |r| r.get(0),
        )?;
        if n == 0 {
            tx.execute("DELETE FROM persons WHERE id = ?", params![pid])?;
        }
    }
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

/// §4.4 — set face description (normalised): re-assign seq within the NEW
/// (person, description) group, re-derive the label, and rebuild the
/// person's refcrops — the face has changed appearance group (§4.6).
pub fn set_face_description(paths: &Paths, face_id: i64, raw: &str) -> Result<()> {
    let mut con = connect(paths)?;
    let settings = get_settings(paths)?;
    let tx = con.transaction()?;
    let desc = normalize_description(raw);
    let (person_id, old_desc): (Option<i64>, Option<String>) = tx.query_row(
        "SELECT person_id, description FROM faces WHERE id = ?",
        params![face_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if desc != old_desc {
        let Some(person_id) = person_id else {
            // unowned face (removed person, §4.13): just record the tags
            tx.execute("UPDATE faces SET description = ? WHERE id = ?", params![desc, face_id])?;
            tx.commit()?;
            return Ok(());
        };
        // next free seq of the new group, counting the OTHER faces only (§4.7)
        let seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM faces
              WHERE person_id = ? AND id != ? AND COALESCE(description, '') = COALESCE(?, '')",
            params![person_id, face_id, desc],
            |r| r.get(0),
        )?;
        tx.execute(
            "UPDATE faces SET description = ?, seq = ? WHERE id = ?",
            params![desc, seq, face_id],
        )?;
        let person_name: String =
            tx.query_row("SELECT name FROM persons WHERE id = ?", params![person_id], |r| r.get(0))?;
        tx.execute(
            "UPDATE faces SET name = ? WHERE id = ?",
            params![face_name(&person_name, desc.as_deref(), seq), face_id],
        )?;
        recompute_person(&tx, person_id, &settings)?;
    }
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
    let old_name: String =
        tx.query_row("SELECT name FROM persons WHERE id = ?", params![person_id], |r| r.get(0))?;
    tx.execute("UPDATE persons SET name = ? WHERE id = ?", params![name.trim(), person_id])?;
    if old_name.starts_with("Unknown") {
        // leaving the importer's Unknown cluster: drop the virtual-branch
        // group path so the renamed person shows under Ungrouped or their own
        // path (F7, mirrors assign_person's rename-in-place)
        tx.execute(
            "DELETE FROM person_groups WHERE person_id = ?
              AND (path = 'Unknown' OR path LIKE 'Unknown|%')",
            params![person_id],
        )?;
    }
    refresh_person_names(&tx, person_id)?;
    // #43: refcrop filenames embed the face name, so a rename must rebuild
    // them — symmetric with assign_person (no-op for a faceless person)
    recompute_person(&tx, person_id, &get_settings(paths)?)?;
    tx.commit()?;
    Ok(())
}

/// #42 — normalise a group path on the write side: trim each segment and
/// drop empty ones; the empty result means ungrouped (no person_groups row).
/// Without this, 'a | b' and 'a||b' would render as distinct, partly-empty
/// tree branches depending on where they were typed.
fn normalize_group_path(path: &str) -> String {
    path.split('|')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("|")
}

pub fn set_person_group(paths: &Paths, person_id: i64, path: &str) -> Result<()> {
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    let path = normalize_group_path(path);
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

/// §4.13 (#35) — remove unwanted persons: every face becomes `rejected`,
/// is detached (`person_id = NULL`), stale foreign primary pointers are
/// cleared, then the person row is deleted (groups/refcrops cascade).
/// Faces are never deleted — they stay as rejected, unowned records.
/// One transaction for the whole batch; no undo.
pub fn remove_persons(paths: &Paths, person_ids: &[i64]) -> Result<()> {
    let ids: HashSet<i64> = person_ids.iter().copied().collect();
    if ids.is_empty() {
        bail!("no persons selected");
    }
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    let mut removed = 0;
    for pid in ids {
        // defensive: no OTHER person may keep pointing at these faces
        tx.execute(
            "UPDATE persons SET primary_face_id = NULL, primary_pinned = 0
              WHERE primary_face_id IN (SELECT id FROM faces WHERE person_id = ?)",
            params![pid],
        )?;
        // rejected = out of review (§4.2); detach so the FK allows the delete
        tx.execute(
            "UPDATE faces SET link_status = 'rejected' WHERE person_id = ?",
            params![pid],
        )?;
        tx.execute(
            "UPDATE faces SET person_id = NULL WHERE person_id = ?",
            params![pid],
        )?;
        removed += tx.execute("DELETE FROM persons WHERE id = ?", params![pid])?;
    }
    if removed == 0 {
        bail!("none of the selected persons exist any more");
    }
    tx.commit()?;
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
    let group = desc.filter(|d| !d.is_empty()).unwrap_or_default();
    let existing: Option<i64> = tx
        .query_row(
            "SELECT pinned FROM person_refcrops WHERE person_id = ? AND face_id = ?",
            params![person_id, face_id],
            |r| r.get(0),
        )
        .optional()?;
    match existing {
        Some(1) => {} // already pinned — no-op
        Some(_) => {
            // upgrade an auto row to a pin in place (keeps its seq/filename/crop)
            tx.execute(
                "UPDATE person_refcrops SET pinned = 1, description = ?
                  WHERE person_id = ? AND face_id = ?",
                params![group, person_id, face_id],
            )?;
        }
        None => {
            // next free seq within this appearance group (§4.6)
            let seq: i64 = tx.query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM person_refcrops WHERE person_id = ? AND description = ?",
                params![person_id, group],
                |r| r.get(0),
            )?;
            let filename = format!("{name}-{seq}.jpg");
            let crop = crop.context("face has no preview")?;
            tx.execute(
                "INSERT INTO person_refcrops (person_id, face_id, description, pinned, seq, filename, crop)
                 VALUES (?, ?, ?, 1, ?, ?, ?)",
                params![person_id, face_id, group, seq, filename, crop],
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
    let rows: Vec<(i64, Vec<u8>)> = st
        .query_map(params![MODEL_TAG], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut map: HashMap<i64, Vec<f32>> = HashMap::new();
    for (fid, blob) in rows {
        // #45: a blob whose length is not a multiple of 4 is corrupt —
        // as_chunks::<4> would silently drop the trailing bytes and every
        // subsequent similarity from that face would be wrong
        if blob.len() % 4 != 0 {
            bail!(
                "corrupt embedding for face {fid}: {} bytes is not a multiple of 4 (insightface:buffalo_l)",
                blob.len()
            );
        }
        let v: Vec<f32> = blob.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect();
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

#[derive(Serialize, Clone, Debug)]
pub struct ClusterFace {
    pub face_id: i64,
    /// cosine similarity to the person's reference (primary) face
    pub sim: f64,
}

/// One appearance group (distinct `COALESCE(description,'')`) of a person,
/// holding its similarity clusters (§4.9/§4.12).
#[derive(Serialize, Clone, Debug)]
pub struct AppearanceGroup {
    /// appearance; "" = no description
    pub description: String,
    pub clusters: Vec<Vec<ClusterFace>>,
}

/// §4.9 — display-side grouping of one person's faces: partitioned by
/// appearance (distinct description), then single-linkage around the
/// primary face *within* each appearance. Rejected/discarded excluded.
pub fn person_face_clusters(paths: &Paths, person_id: i64, threshold: f64) -> Result<Vec<AppearanceGroup>> {
    let con = connect(paths)?;
    let faces: Vec<(i64, f64, bool, String)> = {
        let mut st = con.prepare(
            "SELECT id, confidence, (id = (SELECT primary_face_id FROM persons WHERE id = ?)) AS is_primary,
                    COALESCE(description, '')
               FROM faces
              WHERE person_id = ? AND state != 'discarded' AND link_status != 'rejected'
              ORDER BY id",
        )?;
        st.query_map(params![person_id, person_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, i64>(2)? != 0,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
    };
    if faces.is_empty() {
        return Ok(Vec::new());
    }
    let primary = faces.iter().find(|(_, _, p, _)| *p).map(|(id, _, _, _)| *id)
        .or_else(|| faces.iter().max_by(|a, b| a.1.partial_cmp(&b.1).unwrap()).map(|(id, _, _, _)| *id));
    let ids: Vec<i64> = faces.iter().map(|(id, _, _, _)| *id).collect();
    let vectors = l2_vectors(&con, &ids)?;

    // reference = primary face's vector (fallback: highest-confidence face)
    let ref_idx = faces.iter().position(|(id, _, _, _)| Some(*id) == primary).unwrap_or(0);
    let sims: Vec<f64> = faces
        .iter()
        .enumerate()
        .map(|(i, &(id, _, _, _))| {
            if Some(id) == primary {
                1.0
            } else if vectors[i].is_empty() {
                // #41: no embedding ⇒ no similarity evidence — 0.0, not the
                // 1.0 that made the GUI claim '≥ 100% similar to primary'
                // for faces it could not measure
                0.0
            } else {
                cosine(&vectors[ref_idx], &vectors[i])
            }
        })
        .collect();

    // §4.12: partition by appearance, cluster inside each partition
    let mut part_order: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, (_, _, _, desc)) in faces.iter().enumerate() {
        match part_order.iter_mut().find(|(d, _)| d.as_str() == desc.as_str()) {
            Some((_, members)) => members.push(i),
            None => part_order.push((desc.clone(), vec![i])),
        }
    }

    let mut grouped: Vec<(String, Vec<Vec<usize>>)> = Vec::new();
    for (desc, members) in part_order {
        // single-linkage: each face joins the first cluster with a member at ≥ threshold
        let mut clusters: Vec<Vec<usize>> = Vec::new();
        let mut order = members;
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
        grouped.push((desc, clusters));
    }
    // most primary-like appearance first (the primary's own group tops:
    // its head cluster contains the primary at sim 1.0)
    grouped.sort_by(|a, b| {
        let sa = a.1.first().and_then(|c| c.first()).map(|&i| sims[i]).unwrap_or(f64::MIN);
        let sb = b.1.first().and_then(|c| c.first()).map(|&i| sims[i]).unwrap_or(f64::MIN);
        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(grouped
        .into_iter()
        .map(|(description, clusters)| AppearanceGroup {
            description,
            clusters: clusters
                .into_iter()
                .map(|c| {
                    c.into_iter()
                        .map(|i| ClusterFace {
                            face_id: faces[i].0,
                            sim: sims[i],
                        })
                        .collect()
                })
                .collect(),
        })
        .collect())
}

#[derive(Serialize, Clone, Debug)]
pub struct Refcrop {
    pub face_id: i64,
    pub seq: i64,
    /// appearance group (the face's description; "" = none)
    pub description: String,
    pub pinned: bool,
    pub filename: String,
    pub image: String,
}

pub fn get_refcrops(paths: &Paths, person_id: i64) -> Result<Vec<Refcrop>> {
    let con = connect(paths)?;
    let mut st = con.prepare(
        "SELECT face_id, seq, description, pinned, filename, crop
           FROM person_refcrops WHERE person_id = ? ORDER BY description, seq",
    )?;
    let rows = st.query_map(params![person_id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Vec<u8>>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (face_id, seq, description, pinned, filename, crop) = row?;
        out.push(Refcrop {
            face_id,
            seq,
            description,
            pinned: pinned != 0,
            filename,
            image: jpeg_data_url(&crop),
        });
    }
    Ok(out)
}


