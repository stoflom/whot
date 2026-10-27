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
pub const SCHEMA_VERSION: &str = "1.7";
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
        let remedy = if v == "1.6" {
            format!(
                "upgrade it in place (backup first):\n  python3 scripts/fix_status_groups.py {}",
                db.display()
            )
        } else {
            format!(
                "no migrations by policy. Preserve annotations first if wanted:\n\
                 scripts/annotation_snapshot.py export, then recreate with:\n\
                 sqlite3 {} < database/schema.sql",
                db.display()
            )
        };
        bail!(
            "database schema v{v} does not match this build (v{SCHEMA_VERSION}) — {remedy}"
        );
    }
    Ok(())
}

// ---------------------------------------------------------------- settings

/// #99 (gui-design §4.10) — which face statuses every view shows.
/// Serialized lowercase: "all" | "provisional" | "confirmed" | "rejected"
/// (the UI labels `confirmed` **Accepted**); `accepted` is accepted as an
/// alias so a hand-edited whotrc.json in UI vocabulary still parses.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum FaceFilter {
    /// everything — equivalent to the retired show_rejected: true
    #[default]
    All,
    Provisional,
    #[serde(alias = "accepted")]
    Confirmed,
    Rejected,
}

/// #99 (gui-design §4.9) — how the person view groups faces into sections.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum ClusterGroup {
    /// similarity clusters within each description (§4.9, default)
    #[default]
    Accuracy,
    /// one section per description — no similarity split, no IPC
    Description,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Settings {
    pub cluster_threshold: f64,
    pub refcrop_n: i64,
    /// face-status filter for every view (#99); defaults to `all`, which
    /// is exactly the old show_rejected: true — a legacy `show_rejected`
    /// key in whotrc.json is an unknown field and is ignored.
    #[serde(default)]
    pub face_filter: FaceFilter,
    /// persons-view cluster grouping (#99): Accuracy (default) or
    /// Description — one section per distinct description.
    #[serde(default)]
    pub cluster_group: ClusterGroup,
    /// Merge Similar Persons (#88, §4.28): max Damerau-Levenshtein
    /// distance for name clustering. Default 2, clamped to 1..=3 on read;
    /// serde default keeps existing whotrc.json files loading.
    #[serde(default = "default_merge_name_distance")]
    pub merge_name_distance: u32,
    /// Generational-suffix equivalence groups (#88, §4.28), e.g.
    /// [["J","Jr","Junior"],["S","Sr","Senior"]] — stripped before
    /// comparing. Default empty = off.
    #[serde(default)]
    pub merge_suffix_aliases: Vec<Vec<String>>,
}

fn default_merge_name_distance() -> u32 {
    2
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            cluster_threshold: DEFAULT_THRESHOLD,
            refcrop_n: DEFAULT_REFCROP_N,
            face_filter: FaceFilter::All,
            cluster_group: ClusterGroup::Accuracy,
            merge_name_distance: default_merge_name_distance(),
            merge_suffix_aliases: Vec::new(),
        }
    }
}

pub fn get_settings(paths: &Paths) -> Result<Settings> {
    match std::fs::read_to_string(&paths.config) {
        Ok(text) => match serde_json::from_str::<Settings>(&text) {
            Ok(mut s) => {
                // #88: hand-edited values may sit outside 1..=3
                s.merge_name_distance = s.merge_name_distance.clamp(1, 3);
                Ok(s)
            }
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
    /// creation timestamp (UTC, #40) — provenance for the #88 triage view:
    /// persons minted by one import run share it
    pub created_at: String,
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
    /// #122: display rotation of the face crop (CW, 0/90/180/270)
    /// — independent of the full-image rotation
    pub rotation: i64,
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
    /// #118/#122: EXIF display rotation, CW (0/90/180/270) — the geometric
    /// key the importer lands harvested angles in
    pub rotation: i64,
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

    // §4.27 (#84) — stale-shell sweep: zero-face UnknownN persons are
    // leftovers no other code path revisits (assign_person only deletes
    // shells it empties itself; reject-moves now empty them too, #165).
    // Named persons are never swept — an empty named person is a
    // legitimate future assignment target — and the system person
    // `Rejected` never matches this GLOB (§4.35: never swept).
    con.execute(
        "DELETE FROM persons WHERE name GLOB 'Unknown*'
           AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.person_id = persons.id)",
        [],
    )?;

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
            "SELECT p.id, p.name, p.state, p.note, p.primary_face_id, p.primary_pinned,
                    p.created_at
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
                created_at: r.get(6)?,
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
                    confidence, link_status, state, rotation, detected_in_import_id, created_at
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
                rotation: r.get(13)?,
                import_id: r.get(14)?,
                created_at: r.get(15)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?
    };

    let images: Vec<ImageRow> = {
        let mut st = con.prepare(
            "SELECT id, primary_path, width, height, orientation, rotation, type, state,
                    first_import_id, last_import_id FROM images ORDER BY id",
        )?;
        st.query_map([], |r| {
            Ok(ImageRow {
                id: r.get(0)?,
                primary_path: r.get(1)?,
                width: r.get(2)?,
                height: r.get(3)?,
                orientation: r.get(4)?,
                rotation: r.get(5)?,
                rtype: r.get(6)?,
                state: r.get(7)?,
                first_import_id: r.get(8)?,
                last_import_id: r.get(9)?,
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
        // person_id IS NOT NULL: defensive — since #165 no writer leaves
        // a face unowned (the fix script migrated the historical ones)
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
    if name.eq_ignore_ascii_case("Rejected") {
        bail!("the name 'Rejected' is reserved (#165: system person for rejected faces)");
    }
    Ok(())
}

// ------------------------------------------------------ status seats (#165)

/// #165 / §4.35 — the three system-written status-seat paths. Reserved
/// against user input (validate_group_path); written only by these
/// helpers, the importer and scripts/fix_status_groups.py.
const STATUS_SEATS: [&str; 3] = ["New", "Accepted", "Rejected"];

fn is_status_seat(path: &str) -> bool {
    STATUS_SEATS.contains(&path)
}

/// §4.35 seat derivation: any provisional face ⇒ `New`, else `Accepted`
/// (all confirmed — or none left). `Rejected` is never derived: it is
/// the system person's own fixed seat.
fn derive_seat(con: &Connection, person_id: i64) -> Result<&'static str> {
    let has_new: bool = con.query_row(
        "SELECT EXISTS(SELECT 1 FROM faces
                 WHERE person_id = ?1 AND link_status = 'provisional')",
        params![person_id],
        |r| r.get(0),
    )?;
    Ok(if has_new { "New" } else { "Accepted" })
}

/// §4.35 — writer-owned group invariant: a person left with no
/// `person_groups` row is seated by state. Every writer that can remove
/// a person's rows ends with this (no trigger by design —
/// schema-design §4: the committed state is what the invariant governs).
fn ensure_seat(con: &Connection, person_id: i64) -> Result<()> {
    let n: i64 = con.query_row(
        "SELECT COUNT(*) FROM person_groups WHERE person_id = ?",
        params![person_id],
        |r| r.get(0),
    )?;
    if n == 0 {
        con.execute(
            "INSERT INTO person_groups (person_id, path) VALUES (?1, ?2)",
            params![person_id, derive_seat(con, person_id)?],
        )?;
    }
    Ok(())
}

/// §4.35 — re-evaluate a seat holder's seat after its faces changed
/// (accept/reject/import). No-op unless ALL of the person's rows are
/// status seats: filing replaces the seat (§4.18), and a user-given
/// group is never touched. The system person's seat is never derived.
fn reseat(con: &Connection, person_id: i64) -> Result<()> {
    if is_system_person(con, person_id)? {
        return Ok(()); // §4.35: `Rejected`'s seat is fixed
    }
    let (seats, total): (i64, i64) = con.query_row(
        "SELECT COALESCE(SUM(path IN ('New', 'Accepted', 'Rejected')), 0), COUNT(*)
           FROM person_groups WHERE person_id = ?",
        params![person_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if total == 0 {
        return ensure_seat(con, person_id);
    }
    if seats != total {
        return Ok(()); // filed: real groups win, never touched (§4.35)
    }
    let seat = derive_seat(con, person_id)?;
    // insert-first: the fresh seat lands before the stale one drops
    con.execute(
        "INSERT OR REPLACE INTO person_groups (person_id, path) VALUES (?1, ?2)",
        params![person_id, seat],
    )?;
    con.execute(
        "DELETE FROM person_groups
          WHERE person_id = ?1 AND path != ?2 AND path IN ('New', 'Accepted', 'Rejected')",
        params![person_id, seat],
    )?;
    Ok(())
}

/// §4.35 — the system person `Rejected` (exact reserved name): created
/// on demand by the reject paths; its seat row is always `Rejected`.
fn ensure_rejected_person(con: &Connection) -> Result<i64> {
    if let Some(id) = con
        .query_row("SELECT id FROM persons WHERE name = 'Rejected'", [], |r| r.get(0))
        .optional()?
    {
        con.execute(
            "INSERT OR IGNORE INTO person_groups (person_id, path) VALUES (?1, 'Rejected')",
            params![id],
        )?;
        return Ok(id);
    }
    con.execute(
        "INSERT INTO persons (name, state, created_at)
         VALUES ('Rejected', 'created', datetime('now'))",
        [],
    )?;
    let id = con.last_insert_rowid();
    con.execute(
        "INSERT INTO person_groups (person_id, path) VALUES (?1, 'Rejected')",
        params![id],
    )?;
    Ok(id)
}

fn is_system_person(con: &Connection, person_id: i64) -> Result<bool> {
    let name: Option<String> = con
        .query_row("SELECT name FROM persons WHERE id = ?", params![person_id], |r| r.get(0))
        .optional()?;
    Ok(name.as_deref() == Some("Rejected"))
}

/// §4.35 — the system person is never renamed, re-grouped or removed.
fn guard_system_person(con: &Connection, person_id: i64) -> Result<()> {
    if is_system_person(con, person_id)? {
        bail!("'Rejected' is the system person for rejected faces (#165) and cannot be changed");
    }
    Ok(())
}

/// §4.2/§4.35 (#165) — the reject move: `link_status='rejected'` plus
/// the re-home onto the system person `Rejected` (next free seq per
/// (Rejected, description), name re-derived per §4.7), dropping stale
/// pins at those faces (rejected faces are refcrop-ineligible, §4.6).
/// Faces already home are skipped — re-rejecting is a no-op. Returns
/// every person touched — the pre-move origins AND `Rejected` — sorted,
/// so callers only recompute/reseat over that list.
fn reject_and_rehome(tx: &Connection, face_ids: &[i64]) -> Result<Vec<i64>> {
    let mut affected = affected_persons(tx, face_ids, None)?;
    let mut ids: Vec<i64> = face_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let rej = ensure_rejected_person(tx)?;
    if !affected.contains(&rej) {
        affected.push(rej);
    }
    let list = ids_list(&ids);
    let rows: Vec<(i64, Option<String>)> = {
        let mut st = tx.prepare(&format!(
            "SELECT id, description FROM faces WHERE id IN ({list})
              AND NOT (link_status = 'rejected' AND person_id = {rej})"
        ))?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    for (fid, desc) in rows {
        let seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM faces
              WHERE person_id = ?1
                AND COALESCE(description, '') = COALESCE(?2, '')",
            params![rej, desc],
            |r| r.get(0),
        )?;
        let name = face_name("Rejected", desc.as_deref(), seq);
        tx.execute(
            "UPDATE faces
                SET link_status = 'rejected', person_id = ?1, seq = ?2, name = ?3
              WHERE id = ?4",
            params![rej, seq, name, fid],
        )?;
    }
    tx.execute(&format!("DELETE FROM person_refcrops WHERE face_id IN ({list})"), [])?;
    affected.sort();
    Ok(affected)
}

/// §4.35 — insert the derived seat of every person whose group rows lie
/// ENTIRELY inside `branch` (they would otherwise hit zero rows when the
/// branch goes away). The seat lands BEFORE the caller drops the branch
/// rows — writer-side invariant, no trigger (schema-design §4). Returns
/// how many seats were written.
fn seat_branch_doomed(tx: &Connection, branch: &str) -> Result<usize> {
    let mut st = tx.prepare(&format!(
        "SELECT DISTINCT person_id FROM person_groups pg
          WHERE {BRANCH_OF}
            AND NOT EXISTS (SELECT 1 FROM person_groups g2
                             WHERE g2.person_id = pg.person_id
                               AND NOT (g2.path = ?1
                                   OR (substr(g2.path, 1, length(?1) + 1) = ?1 || '|')))"
    ))?;
    let pids: Vec<i64> = st
        .query_map(params![branch], |r| r.get::<_, i64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for pid in &pids {
        let seat = derive_seat(tx, *pid)?;
        tx.execute(
            "INSERT OR IGNORE INTO person_groups (person_id, path) VALUES (?1, ?2)",
            params![pid, seat],
        )?;
    }
    Ok(pids.len())
}

// ---------------------------------------------------------------- mutations

/// §4.1 — assign selected faces to a person (accept + name + group).
/// Renames an UnknownN in place when the selection is exactly its faces;
/// otherwise moves faces to an existing or newly created person.
pub fn assign_person(paths: &Paths, face_ids: &[i64], name: &str, group_path: &str) -> Result<()> {
    validate_person_name(name)?;
    let name = name.trim().to_string();
    let group_path = normalize_group_path(group_path); // #42
    validate_group_path(&group_path)?; // #165: status seats are system-only
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

    // group: one path per person; empty ⇒ the status seat (§4.35 — the
    // invariant forbids zero rows). Filing replaces the seat: the final
    // path lands FIRST and the old rows drop after, so the person is
    // never groupless, not even mid-transaction.
    if owns_group {
        let final_path = if group_path.is_empty() {
            derive_seat(&tx, target)?.to_string()
        } else {
            group_path.clone()
        };
        tx.execute(
            "INSERT OR REPLACE INTO person_groups (person_id, path) VALUES (?1, ?2)",
            params![target, final_path],
        )?;
        tx.execute(
            "DELETE FROM person_groups WHERE person_id = ?1 AND path != ?2",
            params![target, final_path],
        )?;
    }

    // claim rule (#165 §4.35, replacing the old sticky rule): an
    // assignment ALWAYS confirms what it touches — including previously
    // rejected faces (reachable only under Show → Rejected, §4.10), which
    // it un-rejects and moves. Plain accept never un-rejects (§4.3).
    for (face_id, person_id, _status) in &selected {
        if *person_id == Some(target) {
            tx.execute(
                "UPDATE faces SET link_status = 'confirmed' WHERE id = ?",
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
            tx.execute(
                "UPDATE faces SET person_id = ?, link_status = 'confirmed', reassigned = 1, seq = ? WHERE id = ?",
                params![target, seq, face_id],
            )?;
        }
    }

    refresh_person_names(&tx, target)?;
    // §4.1/§4.13 housekeeping: a person left with zero faces by this move is
    // a stale shell — delete it (groups/refcrops with it, #46) so merges and
    // whole-group moves don't leave the old person behind in the tree.
    for pid in &old_persons {
        if is_system_person(&tx, *pid)? {
            continue; // §4.35: the system person is never deleted — an
            // emptied `Rejected` is an invisible shell (§4.10) the next
            // reject reuses
        }
        let n: i64 = tx.query_row(
            "SELECT COUNT(*) FROM faces WHERE person_id = ?",
            params![pid],
            |r| r.get(0),
        )?;
        if n == 0 {
            // #46: delete dependents explicitly instead of trusting the FK
            // cascade — a connection opened without foreign_keys=ON would
            // otherwise orphan these rows
            tx.execute("DELETE FROM person_groups WHERE person_id = ?", params![pid])?;
            tx.execute("DELETE FROM person_refcrops WHERE person_id = ?", params![pid])?;
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
        reseat(&tx, *pid)?; // §4.35: seat-holders re-derive; filed/system no-op
    }
    tx.commit()?;
    Ok(())
}

/// §4.2/§4.3 (#165) — set the face verdict. `rejected` RE-HOMES every
/// face onto the system person `Rejected` in the same transaction
/// (seq/name re-derived per §4.7, §4.35); `confirmed` NEVER un-rejects —
/// rejected faces are skipped: the claim rule (#165) makes an
/// assignment the only exit from `rejected`.
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
    if status == "rejected" {
        let affected = reject_and_rehome(&tx, face_ids)?;
        for pid in &affected {
            recompute_person(&tx, *pid, &settings)?;
            reseat(&tx, *pid)?; // §4.35: e.g. `UnknownN` New → Accepted
        }
    } else {
        // §4.3/§4.35: accept skips rejected faces — never un-rejects
        tx.execute(
            &format!(
                "UPDATE faces SET link_status = 'confirmed'
                  WHERE id IN ({}) AND link_status != 'rejected'",
                ids_list(face_ids)
            ),
            [],
        )?;
        for pid in affected_persons(&tx, face_ids, None)? {
            recompute_person(&tx, pid, &settings)?;
            reseat(&tx, pid)?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// #122 — full-image display rotation (server state): `delta` is the
/// signed quarter-turn (the GUI sends +90/−90); the stored value is
/// normalised to 0/90/180/270 CW. The same column is the geometric key
/// #118 lands harvested EXIF angles in at import time.
pub fn rotate_image(paths: &Paths, image_id: i64, delta: i64) -> Result<i64> {
    let d = ((delta % 360) + 360) % 360;
    let con = connect(paths)?;
    let cur: i64 = con
        .query_row("SELECT rotation FROM images WHERE id = ?", params![image_id], |r| r.get(0))
        .context("image not found")?;
    let next = (cur + d) % 360;
    con.execute("UPDATE images SET rotation = ? WHERE id = ?", params![next, image_id])?;
    Ok(next)
}

/// #122 — face-crop display rotation (server state): independent of the
/// full-image rotation; same ±90 quarter-turn contract as `rotate_image`.
pub fn rotate_face(paths: &Paths, face_id: i64, delta: i64) -> Result<i64> {
    let d = ((delta % 360) + 360) % 360;
    let con = connect(paths)?;
    let cur: i64 = con
        .query_row("SELECT rotation FROM faces WHERE id = ?", params![face_id], |r| r.get(0))
        .context("face not found")?;
    let next = (cur + d) % 360;
    con.execute("UPDATE faces SET rotation = ? WHERE id = ?", params![next, face_id])?;
    Ok(next)
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
    if old_name == "Rejected" {
        // §4.35: the system person is never renamed (validate_person_name
        // reserves the target name as well — this guards the source)
        bail!("'Rejected' is the system person for rejected faces (#165) and cannot be renamed");
    }
    tx.execute("UPDATE persons SET name = ? WHERE id = ?", params![name.trim(), person_id])?;
    // (#165): the retired `Unknown` group rows are gone since v1.7 — a
    // rename keeps the person's rows exactly as they are (status seat or
    // real path, #153)
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
    let path = normalize_group_path(path);
    validate_group_path(&path)?; // #165: status seats are system-only
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    guard_system_person(&tx, person_id)?; // §4.35
    // §4.35: the final row (given path, or the derived seat for empty
    // input) lands BEFORE the old rows drop — never zero rows.
    let final_path = if path.is_empty() {
        derive_seat(&tx, person_id)?.to_string()
    } else {
        path
    };
    tx.execute(
        "INSERT OR REPLACE INTO person_groups (person_id, path) VALUES (?1, ?2)",
        params![person_id, final_path],
    )?;
    tx.execute(
        "DELETE FROM person_groups WHERE person_id = ?1 AND path != ?2",
        params![person_id, final_path],
    )?;
    tx.commit()?;
    Ok(())
}

/// §4.16 (#50/#165) — group paths are normalised (#42) and five segments
/// are RESERVED: `Ungrouped` (the retired pseudo-group), `Unknown` (the
/// retired group value) and the three status seats `New`, `Accepted`,
/// `Rejected` (§4.35: system-written — no typed path, dialog or drop may
/// produce them; their branches carry no menu and accept no drops).
fn validate_group_path(path: &str) -> Result<()> {
    const RESERVED: [&str; 5] = ["Ungrouped", "New", "Accepted", "Rejected", "Unknown"];
    if let Some(seg) = path.split('|').find(|s| RESERVED.contains(&s)) {
        bail!("'{seg}' is a reserved group name (#165: status seats and retired segments)");
    }
    Ok(())
}

/// Path-or-subtree match on segment boundaries: `path = ?` or
/// `path LIKE ?|…%` without LIKE's wildcard pitfalls (segments may contain
/// `%`/`_`). Character-based, so multi-byte segments are safe.
const BRANCH_OF: &str = "(path = ?1 OR (substr(path, 1, length(?1) + 1) = ?1 || '|'))";

/// §4.16 (#50) — rename/move a group branch: rewrite the path prefix of
/// every person whose group path is inside the branch (the branch itself
/// or any sub-branch). `new_path` empty ⇒ the whole subtree drops to
/// Ungrouped (rows deleted). A branch cannot be moved inside itself.
/// Membership only — faces, names, statuses, primaries untouched.
pub fn rename_group(paths: &Paths, old_path: &str, new_path: &str) -> Result<()> {
    let old = normalize_group_path(old_path);
    let new = normalize_group_path(new_path);
    if old.is_empty() {
        bail!("no group to rename");
    }
    if is_status_seat(&old) {
        bail!("status branches are system furniture (#165, §4.35) — rename is refused");
    }
    validate_group_path(&new)?;
    if new == old || new.starts_with(&format!("{old}|")) {
        bail!("a branch cannot be moved inside itself");
    }
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    let n = if new.is_empty() {
        // §4.35: every person doomed by this rewrite gets its derived seat
        // BEFORE the branch rows drop (never zero rows, no trigger)
        seat_branch_doomed(&tx, &old)?;
        tx.execute(
            &format!("DELETE FROM person_groups WHERE {BRANCH_OF}"),
            params![old],
        )?
    } else {
        tx.execute(
            &format!(
                "UPDATE person_groups SET path = ?2 || substr(path, length(?1) + 1)
                  WHERE {BRANCH_OF}"
            ),
            params![old, new],
        )?
    };
    if n == 0 {
        bail!("no persons in that group");
    }
    tx.commit()?;
    Ok(())
}

/// §4.16 (#50/#165) — delete a group branch: the `person_groups` rows of
/// the whole subtree go away; persons left without any row fall to their
/// status seat (§4.35 — seated before the rows drop). Structure below
/// the branch is not preserved — re-group via move/rename. Faces, names,
/// statuses untouched. Status branches are system furniture and cannot
/// be deleted.
pub fn delete_group(paths: &Paths, path: &str) -> Result<()> {
    let path = normalize_group_path(path);
    if path.is_empty() {
        bail!("no group to delete");
    }
    if is_status_seat(&path) {
        bail!("status branches are system furniture (#165, §4.35) — delete is refused");
    }
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    seat_branch_doomed(&tx, &path)?; // §4.35
    let n = tx.execute(
        &format!("DELETE FROM person_groups WHERE {BRANCH_OF}"),
        params![path],
    )?;
    if n == 0 {
        bail!("no persons in that group");
    }
    tx.commit()?;
    Ok(())
}

/// §4.16 (#50/#165) — move persons to a (possibly new) group: each
/// person's group path is replaced with the target; empty ⇒ the person
/// falls to their status seat (§4.35). Works for any persons, wherever
/// they live (rows in the status branches included — the system person
/// itself is refused, §4.35). Faces, names, statuses, primaries untouched.
pub fn move_persons_to_group(paths: &Paths, person_ids: &[i64], group: &str) -> Result<()> {
    let ids: HashSet<i64> = person_ids.iter().copied().collect();
    if ids.is_empty() {
        bail!("no persons selected");
    }
    let path = normalize_group_path(group);
    validate_group_path(&path)?;
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    let mut moved = 0;
    for pid in ids {
        let exists: i64 =
            tx.query_row("SELECT COUNT(*) FROM persons WHERE id = ?", params![pid], |r| r.get(0))?;
        if exists == 0 {
            continue;
        }
        guard_system_person(&tx, pid)?; // §4.35: Rejected never re-grouped
        // insert-first: the final row (target, or the derived seat for
        // empty input) lands before the old rows drop — §4.35
        let final_path = if path.is_empty() {
            derive_seat(&tx, pid)?.to_string()
        } else {
            path.clone()
        };
        tx.execute(
            "INSERT OR REPLACE INTO person_groups (person_id, path) VALUES (?1, ?2)",
            params![pid, final_path],
        )?;
        tx.execute(
            "DELETE FROM person_groups WHERE person_id = ?1 AND path != ?2",
            params![pid, final_path],
        )?;
        moved += 1;
    }
    if moved == 0 {
        bail!("none of the selected persons exist any more");
    }
    tx.commit()?;
    Ok(())
}

/// §4.16 (#157, v3.59/#165) — tree D&D move for the §9 multi-row world:
/// **one membership re-homes**. Dropping a person row from placement
/// `from` onto branch `to` removes the `from` row (when the person has
/// it — every placement is one stored row) and files the person into
/// `to`; any other membership is kept, so a multi-group person stays
/// multi-group (`INSERT OR IGNORE` dedupes the PK when `to` is already
/// present). **Filing drops the person's status seat** (§4.35/§4.18:
/// filing replaces the seat). A person dragged from a branch they are
/// not in (another member of the dragged selection) is simply filed into
/// `to`. `to = ""` removes only the dragged membership — when it was the
/// last, the person falls to their status seat (§4.35; the Ungrouped
/// drop target is retired, #165). `from = to` is a no-op: the person is
/// already rendered under the target.
pub fn move_persons_between_groups(
    paths: &Paths,
    person_ids: &[i64],
    from_group: &str,
    to_group: &str,
) -> Result<()> {
    let ids: HashSet<i64> = person_ids.iter().copied().collect();
    if ids.is_empty() {
        bail!("no persons selected");
    }
    let from = normalize_group_path(from_group);
    let to = normalize_group_path(to_group);
    if !to.is_empty() {
        validate_group_path(&to)?;
    }
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    let mut moved = 0;
    for pid in ids {
        let exists: i64 =
            tx.query_row("SELECT COUNT(*) FROM persons WHERE id = ?", params![pid], |r| r.get(0))?;
        if exists == 0 {
            continue;
        }
        guard_system_person(&tx, pid)?; // §4.35: Rejected never re-grouped
        if from != to {
            tx.execute(
                "DELETE FROM person_groups WHERE person_id = ? AND path = ?",
                params![pid, from],
            )?;
        }
        if !to.is_empty() {
            tx.execute(
                "INSERT OR IGNORE INTO person_groups (person_id, path) VALUES (?, ?)",
                params![pid, to],
            )?;
            // §4.35/§4.18: filing replaces the seat — an add-group onto a
            // seated person drops the seat (insert happened above first)
            tx.execute(
                "DELETE FROM person_groups
                  WHERE person_id = ? AND path IN ('New', 'Accepted', 'Rejected')",
                params![pid],
            )?;
        } else {
            ensure_seat(&tx, pid)?; // §4.35: last membership removed ⇒ seat
        }
        moved += 1;
    }
    if moved == 0 {
        bail!("none of the selected persons exist any more");
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

/// §4.13 (#35/#165) — remove unwanted persons: every face becomes
/// `rejected` and JOINS the system person `Rejected` (§4.2/§4.35 — no
/// writer ever detaches a face anymore), stale foreign primary pointers
/// are cleared, then the person row is deleted (its groups/refcrops go
/// with it — the group invariant governs living persons only). Faces are
/// never deleted. The system person itself can never be removed.
/// One transaction for the whole batch; no undo.
pub fn remove_persons(paths: &Paths, person_ids: &[i64]) -> Result<()> {
    let ids: HashSet<i64> = person_ids.iter().copied().collect();
    if ids.is_empty() {
        bail!("no persons selected");
    }
    let mut con = connect(paths)?;
    let settings = get_settings(paths)?;
    let tx = con.transaction()?;
    for pid in &ids {
        guard_system_person(&tx, *pid)?; // §4.35: Rejected never removed
    }
    let mut removed = 0;
    let mut touched: HashSet<i64> = HashSet::new();
    for pid in ids {
        // defensive: no OTHER person may keep pointing at these faces
        tx.execute(
            "UPDATE persons SET primary_face_id = NULL, primary_pinned = 0
              WHERE primary_face_id IN (SELECT id FROM faces WHERE person_id = ?)",
            params![pid],
        )?;
        // §4.2/§4.35: rejection re-homes — the faces join `Rejected`
        let fids: Vec<i64> = {
            let mut st = tx.prepare("SELECT id FROM faces WHERE person_id = ?")?;
            let rows = st.query_map(params![pid], |r| r.get::<_, i64>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        if !fids.is_empty() {
            touched.extend(reject_and_rehome(&tx, &fids)?);
        }
        // #46: delete dependents explicitly instead of trusting the FK
        // cascade — a connection opened without foreign_keys=ON would
        // otherwise orphan these rows (the person dies, so no seat is
        // written for it — §4.35 governs living persons)
        tx.execute("DELETE FROM person_groups WHERE person_id = ?", params![pid])?;
        tx.execute("DELETE FROM person_refcrops WHERE person_id = ?", params![pid])?;
        removed += tx.execute("DELETE FROM persons WHERE id = ?", params![pid])?;
        touched.remove(&pid);
    }
    if removed == 0 {
        bail!("none of the selected persons exist any more");
    }
    for pid in &touched { // the system person, in practice
        recompute_person(&tx, *pid, &settings)?;
        reseat(&tx, *pid)?;
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
            // NULL-safe (#80): persons.primary_face_id is nullable — a
            // freshly imported/harvested person, or one whose faces are all
            // rejected — and `id = NULL` is NULL, not 0, which broke
            // r.get::<_, i64>.  coalesce keeps 1/0 semantics.
            "SELECT id, confidence, COALESCE(id = (SELECT primary_face_id FROM persons WHERE id = ?), 0) AS is_primary,
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
        .or_else(|| {
            // #149: NaN confidence must not panic — Equal is as good a
            // fallback rank as any for corrupt data
            faces.iter().max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(id, _, _, _)| *id)
        });
    let ids: Vec<i64> = faces.iter().map(|(id, _, _, _)| *id).collect();
    let vectors = l2_vectors(&con, &ids)?;

    // reference = primary face's vector (fallback: highest-confidence face)
    let ref_idx = faces.iter().position(|(id, _, _, _)| Some(*id) == primary).unwrap_or(0);
    // #149: a length-valid blob can still decode to non-finite
    // components; a non-finite cosine (NaN/±inf) is "no similarity
    // evidence", exactly like the #41 missing-embedding 0.0 — this also
    // keeps every stored similarity finite so `partial_cmp` irreflexivity
    // can never trip a comparison unwrap below.
    let clean = |s: f64| if s.is_finite() { s } else { 0.0 };
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
                clean(cosine(&vectors[ref_idx], &vectors[i]))
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
        // #149: NaN must not panic the command — Equal is fine for corrupt data
        order.sort_by(|&a, &b| sims[b].partial_cmp(&sims[a]).unwrap_or(std::cmp::Ordering::Equal));
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


