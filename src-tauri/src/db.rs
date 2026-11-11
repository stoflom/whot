//! WhoT Face Manager — database layer.
//!
//! All SQL, embeddings math and derived-state maintenance (face names,
//! primary faces, refcrops) lives here. See docs/gui-design.md §4 for the
//! behaviour rules implemented in this file.

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

pub const MODEL_TAG: &str = "insightface:buffalo_l";
/// Must match `schema_version.version` in database/schema.sql — exact
/// match, no migrations by policy: mismatched DBs are refused up-front
/// with recreate instructions instead of failing on the first query.
pub const SCHEMA_VERSION: &str = "1.9";
const DEFAULT_THRESHOLD: f64 = 0.40;
const DEFAULT_REFCROP_N: i64 = 5;

// ---------------------------------------------------------------- paths

pub struct Paths {
    /// the resolved project root (#167: the importer locates its script
    /// and sets the child process's cwd there)
    pub root: PathBuf,
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

/// #185 — does a USABLE database exist? The schema must be present — a
/// missing file AND the empty file a failed first load can leave behind
/// (`connect`'s `Connection::open` creates it) both mean "no database".
/// #252: opened READ-ONLY so the probe itself never creates a file — the
/// old `Connection::open` would leave an empty `data/faces.db` behind as a
/// side effect of `get_import_info`'s `db_exists` check.
pub fn has_schema(paths: &Paths) -> bool {
    let Ok(con) = Connection::open_with_flags(
        &paths.db,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return false;
    };
    con.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'faces'",
        [],
        |_| Ok(()),
    )
    .is_ok()
}

/// #207 — one connection per database path, opened once per process.
/// The guard keeps the pool lock for the caller's scope (the DB surface
/// is serialised — commands are short and the UI is serial anyway), so
/// `connect` callers keep their `let mut con = connect(paths)?;` shape
/// unchanged through Deref/DerefMut. `create_dir_all`, the pragmas and
/// the compatibility gate run on first open only — per-call cost is
/// just the gate's marker query. A database REPLACED on disk (unlink +
/// recreate) while the app runs keeps being served by the old file —
/// the drop-and-recreate maintenance policy implies an app restart.
/// The #208 `data_version` probe stays a SEPARATE connection on
/// purpose: own writes must still move the stamp.
static POOL: Mutex<Option<HashMap<PathBuf, Connection>>> = Mutex::new(None);

pub struct DbConn {
    guard: MutexGuard<'static, Option<HashMap<PathBuf, Connection>>>,
    key: PathBuf,
}

impl Deref for DbConn {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.guard
            .as_ref()
            .expect("pool map initialised in connect")
            .get(&self.key)
            .expect("pool entry inserted in connect")
    }
}

impl DerefMut for DbConn {
    fn deref_mut(&mut self) -> &mut Connection {
        self.guard
            .as_mut()
            .expect("pool map initialised in connect")
            .get_mut(&self.key)
            .expect("pool entry inserted in connect")
    }
}

impl std::fmt::Debug for DbConn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DbConn").field("db", &self.key).finish()
    }
}

fn pool_lock() -> Result<MutexGuard<'static, Option<HashMap<PathBuf, Connection>>>> {
    POOL.lock().map_err(|_| anyhow!("database pool lock poisoned"))
}

pub fn connect(paths: &Paths) -> Result<DbConn> {
    let mut guard = pool_lock()?;
    let map = guard.get_or_insert_with(HashMap::new);
    if !map.contains_key(&paths.db) {
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
        // gate before caching — a broken database is never pooled
        check_schema(&con, &paths.db)?;
        map.insert(paths.db.clone(), con);
    } else {
        // the compatibility gate is one marker query and stays PER CALL:
        // a database corrupted/restored under the running app must keep
        // being refused (workflow.rs schema_version_compatibility_gate)
        let con = map.get(&paths.db).unwrap();
        check_schema(con, &paths.db)?;
    }
    let key = paths.db.clone();
    Ok(DbConn { guard, key })
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
  /// #273 (gui-design §3) — the program for *Open in system viewer*;
  /// empty/absent = the system default. serde default keeps existing
  /// whotrc.json files loading.
  #[serde(default)]
  pub image_viewer: String,
  /// #273 (gui-design §3) — the program for *Open roll path*;
  /// empty/absent = the system default file manager.
  #[serde(default)]
  pub directory_viewer: String,
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
            image_viewer: String::new(),
            directory_viewer: String::new(),
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

#[derive(Serialize, Clone, Debug)]
pub struct PersonCounts {
    pub total: i64,
    pub provisional: i64,
    pub confirmed: i64,
    pub rejected: i64,
}

#[derive(Serialize, Clone, Debug)]
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

#[derive(Serialize, Clone, Debug)]
pub struct Face {
    pub id: i64,
    pub image_id: i64,
    /// NULL never occurs since #165 — every writer homes its faces
    /// (§4.13 re-homes removed persons' faces into `RejectedN` cluster
    /// persons, §4.35/#266); the column
    /// stays nullable only for legacy rows
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

#[derive(Serialize, Clone, Debug)]
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
    /// #208 — the change stamp read BEFORE the rows below (see
    /// `data_version`): the GUI stores it and skips no-op reloads
    pub version: i64,
    pub persons: Vec<Person>,
    pub faces: Vec<Face>,
    pub images: Vec<ImageRow>,
    pub imports: Vec<ImportRow>,
    pub settings: Settings,
}

/// #208 — the change stamp behind the GUI's no-op reload skip: a
/// persistent connection whose `PRAGMA data_version` bumps whenever ANY
/// connection (ours or the importer's) commits a real modification — a
/// zero-row write never bumps it. Fresh connections cannot observe
/// changes at all (every open sees the same baseline), so the probe
/// connections persist, one per database path (the test fixtures each
/// bring their own; the app has exactly one). Full command-connection
/// pooling is #207.
static PROBE: Mutex<Option<HashMap<PathBuf, Connection>>> = Mutex::new(None);

fn probe_lock(
) -> Result<std::sync::MutexGuard<'static, Option<HashMap<PathBuf, Connection>>>> {
    PROBE.lock().map_err(|_| anyhow!("data_version probe lock poisoned"))
}

/// Cheap "has anything changed since?" stamp for the frontend's
/// focus/visibility reloads (F12): equal stamps ⇒ the reload can skip.
/// Read the stamp BEFORE the snapshot data it accompanies — a write
/// landing in between can then only cause a redundant refresh later,
/// never a missed one (see `snapshot`).
pub fn data_version(paths: &Paths) -> Result<i64> {
    let mut guard = probe_lock()?;
    let map = guard.get_or_insert_with(HashMap::new);
    if !map.contains_key(&paths.db) {
        let con = Connection::open(&paths.db)
            .with_context(|| format!("cannot open {}", paths.db.display()))?;
        // the importer may hold the write lock — same patience as `connect`
        con.pragma_update(None, "busy_timeout", 5000)?;
        map.insert(paths.db.clone(), con);
    }
    Ok(map
        .get(&paths.db)
        .expect("just inserted")
        .query_row("PRAGMA data_version", [], |r| r.get(0))?)
}

pub fn snapshot(paths: &Paths) -> Result<Snapshot> {
    // #208 — the stamp first, then the data (ordering rule above). The
    // read path is pure: the §4.27 sweep rides the writers that can
    // empty a person (sweep_stale_shells), so a snapshot never writes.
    let version = data_version(paths)?;
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
    Ok(Snapshot { version, persons, faces, images, imports, settings })
}

// ---------------------------------------------------------------- delta protocol (#219)

/// #219 — the delta a mutation sends to the GUI instead of a full
/// snapshot: only the tables/rows the mutation touched, plus the new
/// change stamp.
#[derive(Serialize, Clone, Debug)]
pub struct Delta {
    pub version: i64,
    /// #281 — the stamp read BEFORE the write (the `v1` of the drift
    /// check). The GUI compares it against the stamp of the state it
    /// has applied (`Snapshot.version`, or the previous delta's
    /// `version` inside a sequential plan): a mismatch means an
    /// external write landed before this command's pre-read and this
    /// delta cannot cover it — full refresh. `drifted` alone only sees
    /// writes landing between the pre-read and the commit, and a
    /// zero-row write never moves the stamp at all, so `base` (not
    /// `version`) is the sound comparison.
    pub base: i64,
    /// an external write moved the stamp by more than 1 between our
    /// pre-read and our commit — the delta may be incomplete and the
    /// frontend must full-refresh instead of applying it.
    pub drifted: bool,
    /// touched person rows (counts + groups included); `None` = none.
    pub persons: Option<Vec<Person>>,
    /// touched face rows; `None` = none.
    pub faces: Option<Vec<Face>>,
    /// touched image rows; `None` = none.
    pub images: Option<Vec<ImageRow>>,
    /// removed person ids (faces are never deleted — they are re-homed).
    pub removed: Vec<i64>,
}

/// Person rows (with counts + groups) for the given ids, shaped exactly
/// like `snapshot()` produces — used for a `Delta`'s `persons`.
fn person_rows(con: &Connection, ids: &[i64]) -> Result<Vec<Person>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let list = ids_list(ids);
    let mut counts: HashMap<i64, PersonCounts> = HashMap::new();
    {
        let mut st = con.prepare(&format!(
            "SELECT person_id, COUNT(*),
                    COALESCE(SUM(link_status = 'provisional'), 0),
                    COALESCE(SUM(link_status = 'confirmed'), 0),
                    COALESCE(SUM(link_status = 'rejected'), 0)
               FROM faces WHERE person_id IS NOT NULL AND person_id IN ({list})
               GROUP BY person_id"
        ))?;
        for row in st.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                PersonCounts { total: r.get(1)?, provisional: r.get(2)?, confirmed: r.get(3)?, rejected: r.get(4)? },
            ))
        })? {
            let (pid, c) = row?; counts.insert(pid, c);
        }
    }
    let mut groups: HashMap<i64, Vec<String>> = HashMap::new();
    {
        let mut st = con.prepare(&format!(
            "SELECT person_id, path FROM person_groups WHERE person_id IN ({list}) ORDER BY person_id, path"
        ))?;
        for row in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
            let (pid, path) = row?; groups.entry(pid).or_default().push(path);
        }
    }
    let mut out = Vec::new();
    let mut st = con.prepare(&format!(
        "SELECT p.id, p.name, p.state, p.note, p.primary_face_id, p.primary_pinned, p.created_at
           FROM persons p WHERE p.id IN ({list})
           ORDER BY (p.name GLOB 'Unknown*') DESC, p.name COLLATE NOCASE, p.id"
    ))?;
    for row in st.query_map([], |r| {
        Ok(Person {
            id: r.get(0)?, name: r.get(1)?, state: r.get(2)?, note: r.get(3)?,
            primary_face_id: r.get(4)?, primary_pinned: r.get(5)?, created_at: r.get(6)?,
            groups: Vec::new(),
            counts: PersonCounts { total: 0, provisional: 0, confirmed: 0, rejected: 0 },
        })
    })? {
        let mut p = row?;
        p.counts = counts.remove(&p.id).unwrap_or(PersonCounts { total: 0, provisional: 0, confirmed: 0, rejected: 0 });
        p.groups = groups.remove(&p.id).unwrap_or_default();
        out.push(p);
    }
    Ok(out)
}

fn face_rows(con: &Connection, ids: &[i64]) -> Result<Vec<Face>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let list = ids_list(ids);
    let mut st = con.prepare(&format!(
        "SELECT id, image_id, person_id, x, y, w, h, name, seq, description,
                confidence, link_status, state, rotation, detected_in_import_id, created_at
           FROM faces WHERE id IN ({list}) ORDER BY id"
    ))?;
    Ok(st
        .query_map([], |r| {
            Ok(Face {
                id: r.get(0)?, image_id: r.get(1)?, person_id: r.get(2)?, x: r.get(3)?, y: r.get(4)?,
                w: r.get(5)?, h: r.get(6)?, name: r.get(7)?, seq: r.get(8)?, description: r.get(9)?,
                confidence: r.get(10)?, link_status: r.get(11)?, state: r.get(12)?, rotation: r.get(13)?,
                import_id: r.get(14)?, created_at: r.get(15)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn image_rows(con: &Connection, ids: &[i64]) -> Result<Vec<ImageRow>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let list = ids_list(ids);
    let mut st = con.prepare(&format!(
        "SELECT id, primary_path, width, height, orientation, rotation, type, state,
                first_import_id, last_import_id FROM images WHERE id IN ({list}) ORDER BY id"
    ))?;
    Ok(st
        .query_map([], |r| {
            Ok(ImageRow {
                id: r.get(0)?, primary_path: r.get(1)?, width: r.get(2)?, height: r.get(3)?,
                orientation: r.get(4)?, rotation: r.get(5)?, rtype: r.get(6)?, state: r.get(7)?,
                first_import_id: r.get(8)?, last_import_id: r.get(9)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

/// #219 — build the `Delta` for a mutation that just committed: read the
/// stamp before (`v1`, taken by the caller before the write) and after
/// (`v2`). Drift (`v2 > v1 + 1`) means an external write (importer)
/// interleaved — the delta may be incomplete, so `drifted` is true and
/// the frontend must full-refresh instead of applying it. #281: `v1`
/// also travels as `base` — the frontend compares it against the stamp
/// of the state it has applied, which closes the other window (an
/// external write landing BEFORE the pre-read moves the stamp without
/// tripping the count check; see `Delta::base`).
///
/// `con` is the caller's open connection (the POOL lock is already held
/// by the caller's `DbConn` guard — calling `connect` here would
/// deadlock). The rows are read through it after the write, so they see
/// the committed state.
pub fn delta_after(
    paths: &Paths,
    con: &Connection,
    v1: i64,
    person_ids: &[i64],        // person rows only
    person_face_ids: &[i64],   // person ids → fetch ALL their faces
    face_ids: &[i64],          // additional specific face rows
    image_ids: &[i64],         // image rows
    removed: Vec<i64>,
) -> Result<Delta> {
    let v2 = data_version(paths)?;
    let drifted = v2 > v1 + 1;
    let mut all_face_ids: Vec<i64> = face_ids.to_vec();
    if !person_face_ids.is_empty() {
        let mut st = con.prepare(&format!(
            "SELECT id FROM faces WHERE person_id IN ({}) ORDER BY id",
            ids_list(person_face_ids)
        ))?;
        for row in st.query_map([], |r| r.get::<_, i64>(0))? {
            all_face_ids.push(row?);
        }
    }
    all_face_ids.sort_unstable();
    all_face_ids.dedup();
    let persons = if person_ids.is_empty() {
        None
    } else {
        Some(person_rows(con, person_ids)?)
    };
    let faces = if all_face_ids.is_empty() {
        None
    } else {
        Some(face_rows(con, &all_face_ids)?)
    };
    let images = if image_ids.is_empty() {
        None
    } else {
        Some(image_rows(con, image_ids)?)
    };
    Ok(Delta { version: v2, base: v1, drifted, persons, faces, images, removed })
}

// ---------------------------------------------------------------- images

/// #212 — raw image bytes leave over the IPC as `tauri::ipc::Response`
/// (→ ArrayBuffer on the JS side) and render from Blob URLs: no base64
/// (~33% smaller transfers, no giant JS strings).
pub fn face_preview_bytes(paths: &Paths, face_id: i64) -> Result<Option<Vec<u8>>> {
    let con = connect(paths)?;
    Ok(con
        .query_row("SELECT preview FROM faces WHERE id = ?", params![face_id], |r| r.get(0))?)
}

pub fn image_thumb_bytes(paths: &Paths, image_id: i64) -> Result<Option<Vec<u8>>> {
    let con = connect(paths)?;
    Ok(con
        .query_row("SELECT thumbnail FROM images WHERE id = ?", params![image_id], |r| r.get(0))?)
}

/// #227 — the byte cap on one batch's blob payload. A `preview` batch
/// (full-image bytes; the frontend coalesces up to 500 ids) must not
/// balloon the response to 50–100 MB and 2–3× in transient copies. A
/// single oversized image is always served alone; the rest of the batch
/// is deferred and the frontend re-requests it (see splitImageBatch in
/// src/api.ts). The wire format is unchanged — truncation is detected by
/// the frontend as "requested ids that carry no frame entry".
pub const IMAGE_BATCH_MAX_BYTES: usize = 32 * 1024 * 1024;

/// #212 — one binary batch per kind ("face" = faces.preview, "thumb" =
/// images.thumbnail, "preview" = images.preview), id-ordered; images
/// without a blob are omitted (the callers cache the miss).
///
/// #227 — built in two passes so the blob bytes are never held twice:
/// a lengths-only first pass (`length(col)` reads the header, not the
/// blob) resolves the exact frame size and applies the byte cap, then
/// the second pass streams each blob straight into the response buffer
/// (the per-row rusqlite `Vec<u8>` is the only temp copy, dropped as
/// soon as it is appended). Serving stays a strict id-prefix: the
/// frontend re-requests deferred ids and only a SINGLE-id response may
/// cache a genuine miss.
pub fn image_batch_bytes(paths: &Paths, kind: &str, ids: &[i64]) -> Result<Vec<u8>> {
    image_batch_bytes_capped(paths, kind, ids, IMAGE_BATCH_MAX_BYTES)
}

/// #227 — the cap-aware implementation; the cap is a parameter so the
/// tests exercise truncation without allocating 32 MiB blobs.
pub fn image_batch_bytes_capped(
    paths: &Paths,
    kind: &str,
    ids: &[i64],
    max_bytes: usize,
) -> Result<Vec<u8>> {
    let (table, col) = match kind {
        "face" => ("faces", "preview"),
        "thumb" => ("images", "thumbnail"),
        "preview" => ("images", "preview"),
        _ => bail!("unknown image kind {kind:?}"),
    };
    let mut sorted: Vec<i64> = ids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut con = connect(paths)?;
    // #245: both passes run in ONE transaction — a single read snapshot,
    // so a concurrent importer commit can't land between the length
    // pass and the byte pass and misalign the WHOTIMG frame offsets
    // (the importer is a separate process; the pool mutex only serialises
    // in-process commands)
    let tx = con.transaction()?;
    // pass 1 — lengths only, grouped so a huge selection never outgrows
    // the SQL string budget; a cap hit defers the rest (strict prefix)
    let mut served: Vec<(i64, u32)> = Vec::new();
    let mut total = 0usize;
    'lengths: for chunk in sorted.chunks(500) {
        let list = ids_list(chunk);
        let mut st = tx.prepare(&format!(
            "SELECT id, length({col}) FROM {table} WHERE id IN ({list}) AND {col} IS NOT NULL ORDER BY id"
        ))?;
        let rows: Vec<(i64, i64)> = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (id, len) in rows {
            let len = len as usize;
            // a single oversized image is served alone, never dropped
            if served.is_empty() && len > max_bytes {
                served.push((id, len as u32));
                total = len;
                break 'lengths;
            }
            if total + len > max_bytes {
                break 'lengths;
            }
            served.push((id, len as u32));
            total += len;
        }
    }
    // exact-size frame: header first, then the blob area the second
    // pass streams into
    let mut out = Vec::with_capacity(12 + served.len() * 16 + total);
    out.extend_from_slice(b"WHOTIMG\x01");
    out.extend_from_slice(&(served.len() as u32).to_le_bytes());
    let mut offset = 0u32;
    for (id, len) in &served {
        out.extend_from_slice(&id.to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&len.to_le_bytes());
        offset += *len;
    }
    // pass 2 — stream the blobs straight into the response buffer
    let served_ids: Vec<i64> = served.iter().map(|(id, _)| *id).collect();
    for chunk in served_ids.chunks(500) {
        let list = ids_list(chunk);
        let mut st = tx.prepare(&format!(
            "SELECT {col} FROM {table} WHERE id IN ({list}) AND {col} IS NOT NULL ORDER BY id"
        ))?;
        for row in st.query_map([], |r| r.get::<_, Vec<u8>>(0))? {
            let blob = row?;
            out.extend_from_slice(&blob);
        }
    }
    // read-only: the commit only ends the snapshot (no writes were made)
    tx.commit()?;
    Ok(out)
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

/// #268 — the image's recorded locations, ordered for the system
/// viewer: `primary_path` first, then the `image_paths` alias set
/// (deduplicated; aliases in path order for determinism).
pub fn image_open_paths(paths: &Paths, image_id: i64) -> Result<Vec<String>> {
    let con = connect(paths)?;
    let primary: Option<String> = con
        .query_row(
            "SELECT primary_path FROM images WHERE id = ?",
            params![image_id],
            |r| r.get(0),
        )
        .optional()?
        .context("image not found")?;
    let mut st = con
        .prepare("SELECT path FROM image_paths WHERE image_id = ? ORDER BY path")?;
    let mut out: Vec<String> = Vec::new();
    if let Some(p) = primary {
        out.push(p);
    }
    for row in st
        .query_map(params![image_id], |r| r.get::<_, String>(0))?
        .flatten()
    {
        if !out.contains(&row) {
            out.push(row);
        }
    }
    Ok(out)
}

/// #285 (gui-design v12.6) — what `open_image` should open:
/// [`OpenImageTarget::Original`] — the first recorded location that
/// exists on disk (primary first, then the aliases; the alias set is
/// append-only, so a recorded location can be stale); or
/// [`OpenImageTarget::Preview`] — only when NO location is recorded at
/// all (a BLOB-only image; `images.primary_path` is `NOT NULL` today,
/// so this is the defensive reservation). `Err` when ≥ 1 location IS
/// recorded but none exists on disk (moved/deleted, or the volume
/// holding it is unmounted) — the message names the looked-at paths
/// for the caller's error toast (#285): a missing original must never
/// masquerade as one that opened.
#[derive(Debug)]
pub enum OpenImageTarget {
    /// the first recorded location that exists on disk
    Original(String),
    /// no recorded location at all — open the preview blob instead
    Preview,
}

pub fn resolve_open_image_target(paths: &Paths, image_id: i64) -> Result<OpenImageTarget> {
    let recorded = image_open_paths(paths, image_id)?;
    match recorded.iter().find(|p| std::path::Path::new(p).exists()) {
        Some(p) => Ok(OpenImageTarget::Original(p.clone())),
        None if recorded.is_empty() => Ok(OpenImageTarget::Preview),
        None => bail!("original image not found at its recorded paths: {}", recorded.join(", ")),
    }
}

/// #272 (gui-design v11.1) — the directory containing the image file:
/// the parent of `images.primary_path`. Roll imports may be recursive,
/// so `imports.path` records only the roll root while the image can sit
/// in a subdirectory — the file manager opens where the file actually
/// lives. `None` for an unknown image id.
pub fn image_file_dir(paths: &Paths, image_id: i64) -> Result<Option<String>> {
    let con = connect(paths)?;
    let p: Option<String> = con
        .query_row(
            "SELECT primary_path FROM images WHERE id = ?",
            params![image_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(p.and_then(|s| {
        std::path::Path::new(&s)
            .parent()
            .map(|d| d.to_string_lossy().into_owned())
    }))
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
/// #210: one UPDATE — the label (§4.7) is pure SQL over the person's name
/// and the face's own description/seq.
fn refresh_person_names(con: &Connection, person_id: i64) -> Result<()> {
    con.execute(
        "UPDATE faces SET name = (
               SELECT p.name FROM persons p WHERE p.id = ?1)
              || CASE WHEN COALESCE(description, '') != ''
                      THEN '-' || description ELSE '' END
              || '-' || seq
          WHERE person_id = ?1",
        params![person_id],
    )?;
    Ok(())
}

/// §4.27 (#84, #266) — the stale-shell sweep: zero-face `UnknownN`
/// persons are leftovers no other code path revisits (assign/merge
/// deletes the shells it empties itself; reject-moves empty them here),
/// and a `RejectedN` fully **claimed** — every face assigned away — is
/// swept the same way (§4.35). Named persons are never swept — an empty
/// named person is a legitimate future assignment target — and the
/// legacy `Rejected` (no number) never matches this GLOB: it is retired
/// by the one-shot split, not swept. #208: the READ path is pure — the
/// sweep rides the writers that can empty a person, so leftovers from
/// external writers are swept at the next write instead of the next
/// snapshot.
/// #281: returns the ids it deleted — the caller's delta must report
/// them in `removed` (the GUI drops rows by id; a swept shell would
/// otherwise linger until the next full refresh).
fn sweep_stale_shells(con: &Connection) -> Result<Vec<i64>> {
    let ids: Vec<i64> = {
        let mut st = con.prepare(
            "SELECT id FROM persons
              WHERE (name GLOB 'Unknown*' OR name GLOB 'Rejected[0-9]*')
                AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.person_id = persons.id)",
        )?;
        st.query_map([], |r| r.get::<_, i64>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    if !ids.is_empty() {
        // dependent rows (groups/refcrops) cascade with the FK — the
        // schema declares ON DELETE CASCADE and connections set it ON
        let list = ids_list(&ids);
        con.execute(&format!("DELETE FROM persons WHERE id IN ({list})"), [])?;
    }
    Ok(ids)
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
/// #210 (schema v1.8): the rows are METADATA — the crop and the filename
/// derive at read from the face — and the rebuild is compare-and-skip: a
/// recompute whose rows come out identical (a rename, say) writes nothing.
fn recompute_refcrops(con: &Connection, person_id: i64, n: i64) -> Result<()> {
    // seq slots still occupied by surviving pins, per appearance group
    let mut pinned: HashMap<String, HashSet<i64>> = HashMap::new();
    {
        let mut st = con.prepare(
            "SELECT description, seq FROM person_refcrops WHERE person_id = ? AND pinned = 1",
        )?;
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
        "SELECT face_id, description, has_preview, rn FROM (
             SELECT f.id AS face_id, COALESCE(f.description, '') AS description,
                    f.preview IS NOT NULL AS has_preview,
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
                r.get::<_, bool>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    // rn-order within each group; skip seq slots held by pins of that
    // group; a preview-less face cannot become a refcrop (#39) but keeps
    // its rank slot, so the numbering leaves the same gaps as before
    let mut next: HashMap<String, i64> = HashMap::new();
    let mut want: Vec<(i64, String, i64)> = Vec::new(); // (face_id, group, seq)
    for (face_id, group, has_preview, rn) in rows {
        if !has_preview {
            continue;
        }
        let cursor = next.get(&group).copied().unwrap_or(1);
        let mut seq = rn.max(cursor);
        while pinned.get(&group).is_some_and(|s| s.contains(&seq)) {
            seq += 1;
        }
        next.insert(group.clone(), seq + 1);
        want.push((face_id, group, seq));
    }
    // #210: compare-and-skip — identical output means no write at all
    let mut have: Vec<(i64, String, i64)> = {
        let mut st = con.prepare(
            "SELECT face_id, description, seq FROM person_refcrops
              WHERE person_id = ? AND pinned = 0",
        )?;
        st.query_map(params![person_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
    };
    have.sort_unstable();
    let mut same = want.clone();
    same.sort_unstable();
    if have == same {
        return Ok(());
    }
    con.execute(
        "DELETE FROM person_refcrops WHERE person_id = ? AND pinned = 0",
        params![person_id],
    )?;
    // #228 (B-L2): the INSERT is prepared once — the old loop re-prepared
    // the same statement per row (inside the writer tx, so minor, but free)
    let mut ins = con.prepare(
        "INSERT OR REPLACE INTO person_refcrops
           (person_id, face_id, description, pinned, seq)
         VALUES (?, ?, ?, 0, ?)",
    )?;
    for (face_id, group, seq) in want {
        ins.execute(params![person_id, face_id, group, seq])?;
    }
    Ok(())
}

fn recompute_person(con: &Connection, person_id: i64, settings: &Settings) -> Result<()> {
    backfill_primary(con, person_id)?;
    recompute_refcrops(con, person_id, settings.refcrop_n)
}

/// The `IN (...)` placeholder for a NON-EMPTY id slice. Callers must guard
/// against an empty slice — an empty one would emit `IN ()`, which is
/// invalid SQL (#249: every current caller guards, this makes the
/// contract explicit). The assert fires in test/debug builds so a future
/// unguarded caller fails loudly and locally, not as a cryptic SQL error
/// deep in the query.
fn ids_list(ids: &[i64]) -> String {
    debug_assert!(!ids.is_empty(), "ids_list: empty slice emits invalid `IN ()` — guard the caller");
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
        bail!("the name 'Rejected' is reserved (#165: legacy system person for rejected faces)");
    }
    if is_rejected_cluster_name(name) {
        bail!("the name '{name}' is reserved (#266: RejectedN cluster persons are writer-owned)");
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
/// the reject-bin persons' own fixed seat (the `RejectedN` family,
/// §4.35/#266).
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
/// group is never touched. A reject-bin person's seat is never derived
/// (§4.35/#266).
fn reseat(con: &Connection, person_id: i64) -> Result<()> {
    let exists: bool = con.query_row(
        "SELECT EXISTS(SELECT 1 FROM persons WHERE id = ?)",
        params![person_id],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(()); // shells deleted by the same tx never get a seat
    }
    if is_system_person(con, person_id)? {
        return Ok(()); // §4.35: a reject-bin person's seat is fixed
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

/// #266 — the `RejectedN` cluster-person name family: `Rejected` +
/// digits (case-insensitive, like the `Unknown*` rule). The exact name
/// `Rejected` (no number) is the legacy system person, handled
/// separately.
fn is_rejected_cluster_name(name: &str) -> bool {
    name.to_ascii_lowercase()
        .strip_prefix("rejected")
        .and_then(|rest| rest.parse::<u32>().ok())
        .is_some()
}

/// #266 — the next collision-free `RejectedN` number: the max of the
/// existing family numbers + 1 (the importer's `UnknownN` numbering
/// rule — gaps left by swept persons are harmless).
fn next_rejected_number(tx: &Connection) -> Result<i64> {
    let mut st = tx.prepare("SELECT name FROM persons WHERE name GLOB 'Rejected[0-9]*'")?;
    let rows: Vec<String> = st
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut max_n = 0i64;
    for n in &rows {
        if let Some(d) = n.to_ascii_lowercase().strip_prefix("rejected") {
            if let Ok(v) = d.parse::<i64>() {
                max_n = max_n.max(v);
            }
        }
    }
    Ok(max_n + 1)
}

/// #266 — a fresh `RejectedN` cluster person: state `created`, seat row
/// `Rejected` (its one derivation — never re-evaluated, §4.35).
fn create_rejected_person(tx: &Connection) -> Result<i64> {
    let n = next_rejected_number(tx)?;
    tx.execute(
        "INSERT INTO persons (name, state, created_at)
         VALUES (?1, 'created', datetime('now'))",
        params![format!("Rejected{n}")],
    )?;
    let id = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO person_groups (person_id, path) VALUES (?1, 'Rejected')",
        params![id],
    )?;
    Ok(id)
}

/// #266 — resolve each face's `RejectedN` target: single-linkage greedy
/// matching (cosine ≥ threshold — the importer's and the §4.9
/// grouping's same parameter) against the faces of the existing
/// `RejectedN` persons, then against faces resolved earlier in the same
/// batch; a face matching nothing — including one with no embedding
/// (legacy, #41) — starts a fresh `RejectedN`. A non-finite cosine is
/// no match evidence, like #149's NaN handling. Returns `(face_id,
/// person_id)` in input order.
fn resolve_rejected_clusters(
    tx: &Connection,
    face_ids: &[i64],
    threshold: f64,
) -> Result<Vec<(i64, i64)>> {
    // every existing bin with all of its face vectors, one pass
    let mut bins: BTreeMap<i64, Vec<Vec<f32>>> = BTreeMap::new();
    {
        let mut st = tx.prepare(
            "SELECT f.person_id, e.vector FROM face_embeddings e
              JOIN faces f ON f.id = e.face_id
              WHERE e.model = ? AND f.person_id IN
                  (SELECT id FROM persons WHERE name GLOB 'Rejected[0-9]*')",
        )?;
        let rows: Vec<(i64, Vec<u8>)> = st
            .query_map(params![MODEL_TAG], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (pid, blob) in rows {
            if blob.len() % 4 != 0 {
                // #45: a corrupt blob cannot match — treat it as no
                // vector, never a panic
                continue;
            }
            let v: Vec<f32> = blob
                .as_chunks::<4>()
                .0
                .iter()
                .map(|c| f32::from_le_bytes(*c))
                .collect();
            bins.entry(pid).or_default().push(v);
        }
    }
    let batch_vecs = l2_vectors(tx, face_ids)?;
    let mut out: Vec<(i64, i64)> = Vec::with_capacity(face_ids.len());
    let mut assigned: Vec<(Vec<f32>, i64)> = Vec::new(); // this batch: (vector, target)
    for (&fid, v) in face_ids.iter().zip(batch_vecs.iter()) {
        let mut target: Option<i64> = None;
        if !v.is_empty() {
            for (pid, vecs) in bins.iter() {
                if vecs.iter().any(|pv| !pv.is_empty() && cosine(v, pv) >= threshold) {
                    target = Some(*pid);
                    break;
                }
            }
            if target.is_none() {
                if let Some((_, t)) = assigned
                    .iter()
                    .find(|(pv, _)| !pv.is_empty() && cosine(v, pv) >= threshold)
                {
                    target = Some(*t);
                }
            }
        }
        let t = match target {
            Some(t) => t,
            None => create_rejected_person(tx)?,
        };
        assigned.push((v.clone(), t));
        out.push((fid, t));
    }
    Ok(out)
}

/// #266 — apply the reject move to the resolved targets:
/// `link_status='rejected'`, set-based seq per `(target,
/// description_key)` (the #220 gap-proof F5 logic, parameterised per
/// person), the §4.7 label from the target's name, and the stale
/// refcrops of the moved faces dropped (rejected faces are
/// refcrop-ineligible, §4.6).
fn apply_reject_moves(tx: &Connection, assignments: &[(i64, i64)]) -> Result<()> {
    if assignments.is_empty() {
        return Ok(());
    }
    let tids: Vec<i64> = assignments.iter().map(|(_, t)| *t).collect();
    let t_list = ids_list(&tids);
    let mut names: HashMap<i64, String> = HashMap::new();
    {
        let mut st = tx.prepare(&format!("SELECT id, name FROM persons WHERE id IN ({t_list})"))?;
        let rows: Vec<(i64, String)> = st
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (id, name) in rows {
            names.insert(id, name);
        }
    }
    let fids: Vec<i64> = assignments.iter().map(|(f, _)| *f).collect();
    let f_list = ids_list(&fids);
    let mut by_key: BTreeMap<(i64, String), Vec<i64>> = BTreeMap::new();
    {
        let mut st = tx.prepare(&format!("SELECT id, description_key FROM faces WHERE id IN ({f_list})"))?;
        let rows: Vec<(i64, String)> = st
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let target_of: HashMap<i64, i64> = assignments.iter().map(|(f, t)| (*f, *t)).collect();
        for (fid, key) in rows {
            by_key.entry((target_of[&fid], key)).or_default().push(fid);
        }
    }
    for ((pid, key), fids) in by_key {
        let fids_list = ids_list(&fids);
        let pname = &names[&pid];
        tx.execute(
            &format!(
                "WITH base AS (
                     SELECT COALESCE(MAX(seq), 0) AS m FROM faces
                       WHERE person_id = {pid} AND description_key = ?1),
                  n AS (
                     SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
                       FROM faces WHERE id IN ({fids_list}))
                 UPDATE faces SET
                   person_id = {pid},
                   link_status = 'rejected',
                   seq = base.m + n.rn,
                   name = ?2 || '-' || CASE WHEN ?1 = '' THEN ''
                                             ELSE ?1 || '-' END
                        || (base.m + n.rn)
                 FROM n, base WHERE faces.id = n.id",
            ),
            params![key, pname],
        )?;
    }
    tx.execute(&format!("DELETE FROM person_refcrops WHERE face_id IN ({f_list})"), [])?;
    Ok(())
}

/// #266 — the one-shot idempotent fix that retires the legacy single
/// system person `Rejected`: its faces are split into `RejectedN`
/// clusters by the same resolution (a face not already rejected is
/// force-rejected — that state was an invariant breach already), the
/// person row is deleted, and the caller's reseat pass rewrites the
/// seats. Databases without the person (fresh builds, dev drop-and-
/// recreate) skip it.
/// #281: returns what it changed so the caller's delta covers it — the
/// deleted legacy id rides `removed`, the `RejectedN` targets that
/// received its faces join the affected persons, and the moved faces
/// join the delta's face rows.
struct SplitLegacy {
    /// the deleted `Rejected` id (empty when the person is absent)
    removed: Vec<i64>,
    /// `RejectedN` targets that received the legacy faces
    targets: Vec<i64>,
    /// the legacy faces that were re-homed
    faces: Vec<i64>,
}

fn split_legacy_rejected_person(tx: &Connection, threshold: f64) -> Result<SplitLegacy> {
    let legacy: Option<i64> = tx
        .query_row("SELECT id FROM persons WHERE name = 'Rejected'", [], |r| r.get(0))
        .optional()?;
    let Some(legacy) = legacy else {
        return Ok(SplitLegacy { removed: Vec::new(), targets: Vec::new(), faces: Vec::new() });
    };
    let mut st = tx.prepare("SELECT id FROM faces WHERE person_id = ?1")?;
    let mut fids: Vec<i64> = st
        .query_map(params![legacy], |r| r.get::<_, i64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    fids.sort_unstable();
    let mut targets: Vec<i64> = Vec::new();
    if !fids.is_empty() {
        let assignments = resolve_rejected_clusters(tx, &fids, threshold)?;
        apply_reject_moves(tx, &assignments)?;
        let mut seen = std::collections::HashSet::new();
        for (_, t) in &assignments {
            if seen.insert(*t) {
                targets.push(*t);
            }
        }
        targets.sort_unstable();
    }
    tx.execute("DELETE FROM person_groups WHERE person_id = ?1", params![legacy])?;
    tx.execute("DELETE FROM person_refcrops WHERE person_id = ?1", params![legacy])?;
    tx.execute("DELETE FROM persons WHERE id = ?1", params![legacy])?;
    Ok(SplitLegacy { removed: vec![legacy], targets, faces: fids })
}

/// #165/#266 — writer-owned persons: the legacy system person
/// `Rejected` and the `RejectedN` cluster family.
fn is_system_person(con: &Connection, person_id: i64) -> Result<bool> {
    let name: Option<String> = con
        .query_row("SELECT name FROM persons WHERE id = ?", params![person_id], |r| r.get(0))
        .optional()?;
    Ok(matches!(
        name.as_deref(),
        Some(n) if n == "Rejected" || is_rejected_cluster_name(n)
    ))
}

/// §4.35 — writer-owned persons are never renamed, re-grouped or removed.
fn guard_system_person(con: &Connection, person_id: i64) -> Result<()> {
    if is_system_person(con, person_id)? {
        let name: String = con
            .query_row("SELECT name FROM persons WHERE id = ?", params![person_id], |r| r.get(0))?;
        bail!(
            "'{name}' is writer-owned (the RejectedN cluster family, #266) and cannot be changed"
        );
    }
    Ok(())
}

/// §4.2/§4.35 (#165, #266) — the reject move: `link_status='rejected'`
/// plus the re-home onto each face's `RejectedN` cluster person (cluster
/// resolution per the face's embedding, §4.35; seq/name re-derived per
/// §4.7), dropping stale pins at those faces (rejected faces are
/// refcrop-ineligible, §4.6). Faces already home are skipped —
/// re-rejecting is a no-op. Returns (affected, removed, faces): every
/// person touched — the pre-move origins AND the `RejectedN` targets,
/// sorted, so callers only recompute/reseat over that list — plus
/// (#281) the ids the #266 legacy split deleted (→ the delta's
/// `removed`) and the faces it moved (→ the delta's face rows).
fn reject_and_rehome(
    tx: &Connection,
    face_ids: &[i64],
    threshold: f64,
) -> Result<(Vec<i64>, Vec<i64>, Vec<i64>)> {
    // #266: retire the legacy single bin first (idempotent no-op when
    // absent)
    let split = split_legacy_rejected_person(tx, threshold)?;
    let mut affected = affected_persons(tx, face_ids, None)?;
    affected.extend(split.targets.iter().copied());
    let mut ids: Vec<i64> = face_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        affected.sort_unstable();
        affected.dedup();
        return Ok((affected, split.removed, split.faces));
    }
    let list = ids_list(&ids);
    // faces already home (rejected on a RejectedN) are skipped
    let pending: Vec<i64> = {
        let mut st = tx.prepare(&format!(
            "SELECT id FROM faces WHERE id IN ({list})
              AND NOT (link_status = 'rejected' AND person_id IN
                       (SELECT id FROM persons WHERE name GLOB 'Rejected[0-9]*'))"
        ))?;
        st.query_map([], |r| r.get::<_, i64>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    if !pending.is_empty() {
        let assignments = resolve_rejected_clusters(tx, &pending, threshold)?;
        apply_reject_moves(tx, &assignments)?;
        for (_, t) in &assignments {
            affected.push(*t);
        }
    }
    affected.sort();
    affected.dedup();
    Ok((affected, split.removed, split.faces))
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
pub fn assign_person(paths: &Paths, face_ids: &[i64], name: &str, group_path: &str) -> Result<Delta> {
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
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
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
    // #220 — set-based per (target, description_key) group: one statement
    // per group instead of the per-face MAX+UPDATE loop (B-M2). The
    // gap-proof next free number is preserved: base = the group's MAX
    // before this batch, each face takes base + its ROW_NUMBER in id
    // order (the old loop walked the same sorted id order) — moving faces
    // out leaves seq gaps and COUNT+1 could collide (F5, design §4.7).
    let sel_list = ids_list(&ids);
    tx.execute(
        &format!("UPDATE faces SET link_status = 'confirmed'
                  WHERE person_id = {target} AND id IN ({sel_list})"),
        [],
    )?;
    let mut by_key: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    {
        // NULL-owned faces join the batch too (the old Option loop moved
        // them; `person_id != target` alone would drop NULLs from the SQL)
        let mut st = tx.prepare(&format!(
            "SELECT id, description_key FROM faces
              WHERE id IN ({sel_list})
                AND (person_id != {target} OR person_id IS NULL)"
        ))?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (fid, key) in rows {
            by_key.entry(key).or_default().push(fid);
        }
    }
    for (key, fids) in by_key {
        let fids_list = ids_list(&fids);
        tx.execute(
            &format!(
                "WITH base AS (
                     SELECT COALESCE(MAX(seq), 0) AS m FROM faces
                       WHERE person_id = {target} AND description_key = ?1),
                  n AS (
                     SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
                       FROM faces WHERE id IN ({fids_list}))
                 UPDATE faces SET
                   person_id = {target},
                   link_status = 'confirmed',
                   reassigned = 1,
                   seq = base.m + n.rn
                 FROM n, base WHERE faces.id = n.id",
            ),
            params![key],
        )?;
    }

    refresh_person_names(&tx, target)?;
    // §4.1/§4.13 housekeeping: a person left with zero faces by this move is
    // a stale shell — delete it (groups/refcrops with it, #46) so merges and
    // whole-group moves don't leave the old person behind in the tree.
    // #220 — the per-pid COUNT loop is one IN-cluster fetch (B-M4) plus
    // one statement per deletion target-set.
    let mut removed: Vec<i64> = Vec::new();
    if !old_persons.is_empty() {
        let mut pids: Vec<i64> = old_persons.iter().copied().collect();
        pids.sort();
        let p_list = ids_list(&pids);
        // §4.35: writer-owned persons are never deleted here — the
        // legacy `Rejected` is retired by the split, and an emptied
        // `RejectedN` is swept by §4.27, not deleted by a merge
        let sys: HashSet<i64> = {
            let mut st = tx.prepare(&format!(
                "SELECT id FROM persons WHERE id IN ({p_list})
                  AND (name = 'Rejected' OR name GLOB 'Rejected[0-9]*')"
            ))?;
            st.query_map([], |r| r.get::<_, i64>(0))?
                .collect::<std::result::Result<HashSet<_>, _>>()?
        };
        // #46: delete dependents explicitly instead of trusting the FK
        // cascade — a connection opened without foreign_keys=ON would
        // otherwise orphan these rows
        let mut st = tx.prepare(&format!(
            "SELECT person_id, COUNT(*) FROM faces
              WHERE person_id IN ({p_list}) GROUP BY person_id"
        ))?;
        let counts: HashMap<i64, i64> = st
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
            .collect::<std::result::Result<HashMap<_, _>, _>>()?;
        for pid in &pids {
            if !sys.contains(pid) && counts.get(pid).copied().unwrap_or(0) == 0 {
                removed.push(*pid);
            }
        }
        if !removed.is_empty() {
            let r_list = ids_list(&removed);
            tx.execute(&format!("DELETE FROM person_groups WHERE person_id IN ({r_list})"), [])?;
            tx.execute(&format!("DELETE FROM person_refcrops WHERE person_id IN ({r_list})"), [])?;
            tx.execute(&format!("DELETE FROM persons WHERE id IN ({r_list})"), [])?;
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
    // #281: the sweep's deletions ride `removed` too — a `RejectedN`
    // emptied by this move (un-rejecting its faces via the claim rule)
    // is deleted by the sweep, not the inline path, and the GUI must
    // drop the row instead of keeping a stale shell
    let swept = sweep_stale_shells(&tx)?; // §4.27: sweep rides the writers (#208)
    removed.extend(swept);
    removed.sort_unstable();
    removed.dedup();
    tx.commit()?;
    // #219 — affected = old owners + target; the target's faces are
    // re-named by refresh_person_names (person_face_ids), the moved faces
    // are the selected ids; removed = old owners emptied by the move.
    delta_after(
        paths,
        &*con,
        v1,
        &affected,
        &[target],
        &ids,
        &[],
        removed,
    )
}

/// §4.2/§4.3 (#165/#266) — set the face verdict. `rejected` RE-HOMES
/// every face into its `RejectedN` cluster person in the same
/// transaction (cluster resolution per the face's embedding; seq/name
/// re-derived per §4.7, §4.35); `confirmed` NEVER un-rejects — rejected
/// faces are skipped: the claim rule (#165) makes an assignment the only
/// exit from `rejected`.
pub fn set_link_status(paths: &Paths, face_ids: &[i64], status: &str) -> Result<Delta> {
    if !matches!(status, "confirmed" | "rejected") {
        bail!("bad status {status}");
    }
    if face_ids.is_empty() {
        bail!("no faces selected");
    }
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
    let mut con = connect(paths)?;
    let settings = get_settings(paths)?;
    let tx = con.transaction()?;
    // #281: (affected, removed, faces) — a reject re-homes faces and may
    // retire the legacy `Rejected` bin: its targets join the affected
    // persons, its deleted id and moved faces ride the delta.
    let (affected, mut removed, extra_faces) = if status == "rejected" {
        reject_and_rehome(&tx, face_ids, settings.cluster_threshold)?
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
        (affected_persons(&tx, face_ids, None)?, Vec::new(), Vec::new())
    };
    for pid in &affected {
        recompute_person(&tx, *pid, &settings)?;
        reseat(&tx, *pid)?; // §4.35: e.g. `UnknownN` New → Accepted
    }
    // #281: the sweep's deletions ride `removed` — the GUI drops the
    // rows instead of keeping stale shells until the next full refresh
    removed.extend(sweep_stale_shells(&tx)?); // §4.27: sweep rides the writers (#208)
    removed.sort_unstable();
    removed.dedup();
    tx.commit()?;
    // #219 — affected = face owners (+ `Rejected` on a reject); the faces
    // whose status/person changed are `face_ids` (plus the legacy
    // split's moved faces); names are untouched by accept/reject so no
    // person's full face set needs re-fetching.
    let mut all_faces: Vec<i64> = face_ids.to_vec();
    all_faces.extend(extra_faces);
    delta_after(paths, &*con, v1, &affected, &[], &all_faces, &[], removed)
}

/// #122/#183 — image display rotation, set-based (#283 N4): the images
/// UPDATE and the faces cascade are ONE statement each for the whole id
/// set (the old per-image loop was 3 statements × N), and a missing
/// image rolls the whole batch back (matched rows < ids ⇒ bail before
/// the commit — same contract as the old loop). `d` is normalised to
/// 0..359 in Rust; both columns are non-negative, so `(x + d) % 360`
/// in SQL keeps the 0..359 range exactly like the old Rust-side
/// `(cur + d) % 360`. Returns the delta's face ids read INSIDE the
/// transaction (#281): the faces UPDATE is image-scoped, so a face
/// added between a pre-tx read and the commit would be rotated but
/// missing from the delta — the in-tx read cannot drift from what the
/// UPDATE touched.
fn rotate_images_tx(
    tx: &Connection,
    image_ids: &[i64],
    delta: i64,
) -> Result<Vec<i64>> {
    let d = ((delta % 360) + 360) % 360;
    let list = ids_list(image_ids);
    let n = tx.execute(
        &format!("UPDATE images SET rotation = (rotation + {d}) % 360 WHERE id IN ({list})"),
        [],
    )?;
    if n != image_ids.len() {
        bail!("image not found");
    }
    tx.execute(
        &format!(
            "UPDATE faces SET rotation = ((rotation + {d}) % 360 + 360) % 360
               WHERE image_id IN ({list})"
        ),
        [],
    )?;
    let face_ids: Vec<i64> = {
        let mut st =
            tx.prepare(&format!("SELECT id FROM faces WHERE image_id IN ({list}) ORDER BY id"))?;
        st.query_map([], |r| r.get::<_, i64>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    Ok(face_ids)
}

pub fn rotate_image(paths: &Paths, image_id: i64, delta: i64) -> Result<Delta> {
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    // #283 N4: the single-image rotation is the batch with one id —
    // same set-based shape (one statement per table), same
    // not-found refusal
    let face_ids = rotate_images_tx(&tx, &[image_id], delta)?;
    tx.commit()?;
    // #219 — the image row and every face on it change rotation; no
    // person rows are affected.
    delta_after(paths, &*con, v1, &[], &[], &face_ids, &[image_id], Vec::new())
}

/// #209 — batch display rotation: N images in ONE transaction behind one
/// IPC call (the GUI rotates a whole thumbnail scope at once) — same
/// per-image semantics as `rotate_image`, incl. the crop cascade. A
/// repeated id rotates once; a missing image rolls the whole batch back
/// (the old per-image loop applied the prefix before failing).
pub fn rotate_images(paths: &Paths, image_ids: &[i64], delta: i64) -> Result<Delta> {
    let mut ids: Vec<i64> = image_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        bail!("no images selected");
    }
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    let face_ids = rotate_images_tx(&tx, &ids, delta)?;
    tx.commit()?;
    // #219 — the image rows and every face on them change rotation; no
    // person rows are affected.
    delta_after(paths, &*con, v1, &[], &[], &face_ids, &ids, Vec::new())
}

/// #122/#183 — face-crop display rotation (server state): the per-crop
/// correction — independent of the full-image rotation in the CONVERSE
/// direction only (rotating the image cascades to its crops, this never
/// touches the image); same ±90 quarter-turn contract as `rotate_image`.
pub fn rotate_face(paths: &Paths, face_id: i64, delta: i64) -> Result<Delta> {
    let d = ((delta % 360) + 360) % 360;
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
    let mut con = connect(paths)?;
    // #249 — the read+write must be ONE transaction. The old bare
    // query_row + execute left a lost-update window: a concurrent importer
    // write landing between the read and the update was silently
    // overwritten (the `rotation` column is the geometric key the importer
    // lands harvested angles in). A deferred tx that reads then writes
    // fails with SQLITE_BUSY on a stale snapshot instead of overwriting it
    // — the same guarantee `rotate_image` / `rotate_image_tx` already had.
    let tx = con.transaction()?;
    let cur: i64 = tx
        .query_row("SELECT rotation FROM faces WHERE id = ?", params![face_id], |r| r.get(0))
        .context("face not found")?;
    let next = (cur + d) % 360;
    tx.execute("UPDATE faces SET rotation = ? WHERE id = ?", params![next, face_id])?;
    tx.commit()?;
    // #219 — only this face's crop rotation changes.
    delta_after(paths, &*con, v1, &[], &[], &[face_id], &[], Vec::new())
}

/// The per-face core of `set_face_description` inside the caller's
/// transaction: records the normalised description, re-assigns seq within
/// the NEW (person, description) group and re-derives the label. Returns
/// the owning person when the face actually moved groups (the caller
/// re-derives their state once per person, not per face — #209).
fn set_face_description_tx(
    tx: &Connection,
    face_id: i64,
    desc: &Option<String>,
) -> Result<Option<i64>> {
    let (person_id, old_desc): (Option<i64>, Option<String>) = tx.query_row(
        "SELECT person_id, description FROM faces WHERE id = ?",
        params![face_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if desc == &old_desc {
        return Ok(None);
    }
    let Some(person_id) = person_id else {
        // unowned face (removed person, §4.13): just record the tags
        // (description_key mirrors description — v1.9, #220)
        tx.execute(
            "UPDATE faces SET description = ?, description_key = ? WHERE id = ?",
            params![desc, desc.clone().unwrap_or_default(), face_id],
        )?;
        return Ok(None);
    };
    // next free seq of the new group, counting the OTHER faces only (§4.7)
    // — keyed on description_key so the composite index serves it (v1.9)
    let key = desc.clone().unwrap_or_default();
    let seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM faces
          WHERE person_id = ? AND id != ? AND description_key = ?",
        params![person_id, face_id, key],
        |r| r.get(0),
    )?;
    tx.execute(
        "UPDATE faces SET description = ?, description_key = ?, seq = ? WHERE id = ?",
        params![desc, key, seq, face_id],
    )?;
    let person_name: String =
        tx.query_row("SELECT name FROM persons WHERE id = ?", params![person_id], |r| r.get(0))?;
    tx.execute(
        "UPDATE faces SET name = ? WHERE id = ?",
        params![face_name(&person_name, desc.as_deref(), seq), face_id],
    )?;
    Ok(Some(person_id))
}

/// §4.4 — set face description (normalised): re-assign seq within the NEW
/// (person, description) group, re-derive the label, and rebuild the
/// person's refcrops — the face has changed appearance group (§4.6).
pub fn set_face_description(paths: &Paths, face_id: i64, raw: &str) -> Result<Delta> {
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
    let mut con = connect(paths)?;
    let settings = get_settings(paths)?;
    let tx = con.transaction()?;
    let owner = set_face_description_tx(&tx, face_id, &normalize_description(raw))?;
    if let Some(person_id) = owner {
        recompute_person(&tx, person_id, &settings)?;
    }
    tx.commit()?;
    // #219 — this face's description/seq/label changed; its owner's
    // primary may have been re-derived by recompute_person.
    let person_ids: Vec<i64> = owner.into_iter().collect();
    delta_after(paths, &*con, v1, &person_ids, &[], &[face_id], &[], Vec::new())
}

/// #209 — batch description write behind one IPC call: one transaction,
/// faces processed in CALL ORDER (each takes the next seq of the shared
/// new group exactly as the sequential single calls did), and each
/// owner's derived state recomputed once at the end instead of per face.
pub fn set_face_descriptions(paths: &Paths, face_ids: &[i64], raw: &str) -> Result<Delta> {
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
    let mut con = connect(paths)?;
    let settings = get_settings(paths)?;
    let tx = con.transaction()?;
    let desc = normalize_description(raw);
    let mut touched: Vec<i64> = Vec::new();
    // #252: O(1) membership — the old `touched.contains` was O(n) per face
    // over the whole batch (O(n²) on a large --all description write)
    let mut touched_set: HashSet<i64> = HashSet::new();
    for face_id in face_ids {
        if let Some(pid) = set_face_description_tx(&tx, *face_id, &desc)? {
            if touched_set.insert(pid) {
                touched.push(pid);
            }
        }
    }
    for pid in &touched {
        recompute_person(&tx, *pid, &settings)?;
    }
    tx.commit()?;
    // #219 — the described faces changed; each touched owner's primary may
    // have been re-derived (names are untouched — no refresh_person_names).
    delta_after(paths, &*con, v1, &touched, &[], face_ids, &[], Vec::new())
}

/// §4.5 — user-pinned primary face.
pub fn set_primary_face(paths: &Paths, person_id: i64, face_id: i64) -> Result<Delta> {
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
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
    // #219 — only the person row (primary pointer) changed.
    delta_after(paths, &*con, v1, &[person_id], &[], &[], &[], Vec::new())
}

pub fn set_person_name(paths: &Paths, person_id: i64, name: &str) -> Result<Delta> {
    validate_person_name(name)?;
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
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
    if old_name == "Rejected" || is_rejected_cluster_name(&old_name) {
        // §4.35: writer-owned persons are never renamed
        // (validate_person_name reserves the target name as well — this
        // guards the source)
        bail!("'{old_name}' is writer-owned (the RejectedN cluster family, #266) and cannot be renamed");
    }
    tx.execute("UPDATE persons SET name = ? WHERE id = ?", params![name.trim(), person_id])?;
    // (#165): the retired `Unknown` group rows are gone since v1.7 — a
    // rename keeps the person's rows exactly as they are (status seat or
    // real path, #153)
    refresh_person_names(&tx, person_id)?;
    // #43 + #210: refcrop filenames/crops derive at read from the face,
    // so a rename needs no rebuild — the recompute below is a no-op
    // (compare-and-skip) and stays for symmetry with assign_person
    recompute_person(&tx, person_id, &get_settings(paths)?)?;
    tx.commit()?;
    // #219 — the person row changed and ALL its faces were re-named by
    // refresh_person_names (person_face_ids).
    delta_after(paths, &*con, v1, &[person_id], &[person_id], &[], &[], Vec::new())
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

pub fn set_person_group(paths: &Paths, person_id: i64, path: &str) -> Result<Delta> {
    let path = normalize_group_path(path);
    validate_group_path(&path)?; // #165: status seats are system-only
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
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
    // #219 — only the person row (groups) changed.
    delta_after(paths, &*con, v1, &[person_id], &[], &[], &[], Vec::new())
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
/// #193 (§4.16): a clash with an existing branch is a MERGE, never an
/// error — a person in both the source (branch or sub-branch) and the
/// destination path would duplicate their `(person_id, path)` key under
/// the rewrite; the clashing source rows are dropped (the person keeps
/// the single destination row), the rest rewrite, and the source branch
/// is absorbed by the destination (gone once emptied).
pub fn rename_group(paths: &Paths, old_path: &str, new_path: &str) -> Result<Delta> {
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
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
    let mut con = connect(paths)?;
    // every person in the branch has their group path rewritten.
    let affected: Vec<i64> = {
        let mut st = con.prepare(&format!(
            "SELECT DISTINCT person_id FROM person_groups WHERE {BRANCH_OF}"
        ))?;
        st.query_map(params![old], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    let tx = con.transaction()?;
    // The emptiness check runs BEFORE the rewrite (#193): an all-clashing
    // branch loses every row in the merge and rewrites none — still a
    // successful rename, never “no persons in that group”.
    let before: i64 = tx.query_row(
        &format!("SELECT COUNT(*) FROM person_groups WHERE {BRANCH_OF}"),
        params![old],
        |r| r.get(0),
    )?;
    if before == 0 {
        bail!("no persons in that group");
    }
    if new.is_empty() {
        // §4.35: every person doomed by this rewrite gets its derived seat
        // BEFORE the branch rows drop (never zero rows, no trigger)
        seat_branch_doomed(&tx, &old)?;
        tx.execute(
            &format!("DELETE FROM person_groups WHERE {BRANCH_OF}"),
            params![old],
        )?;
    } else {
        // #193: drop the clashing source rows first — the person keeps the
        // single destination row — then rewrite the rest (the destination
        // rows are never in the old branch: `new` is neither `old` nor
        // inside/outside a prefix of it, so the EXISTS is stable while the
        // DELETE runs)
        tx.execute(
            &format!(
                "DELETE FROM person_groups
                 WHERE {BRANCH_OF}
                   AND EXISTS (
                     SELECT 1 FROM person_groups k
                     WHERE k.person_id = person_groups.person_id
                       AND k.path = CASE
                         WHEN person_groups.path = ?1 THEN ?2
                         ELSE ?2 || substr(person_groups.path, length(?1) + 1) END
                   )"
            ),
            params![old, new],
        )?;
        tx.execute(
            &format!(
                "UPDATE person_groups SET path = ?2 || substr(path, length(?1) + 1)
                  WHERE {BRANCH_OF}"
            ),
            params![old, new],
        )?;
    }
    tx.commit()?;
    // #219 — the persons in the branch have new group paths (person rows).
    delta_after(paths, &*con, v1, &affected, &[], &[], &[], Vec::new())
}

/// §4.16 (#50/#165) — delete a group branch: the `person_groups` rows of
/// the whole subtree go away; persons left without any row fall to their
/// status seat (§4.35 — seated before the rows drop). Structure below
/// the branch is not preserved — re-group via move/rename. Faces, names,
/// statuses untouched. Status branches are system furniture and cannot
/// be deleted.
pub fn delete_group(paths: &Paths, path: &str) -> Result<Delta> {
    let path = normalize_group_path(path);
    if path.is_empty() {
        bail!("no group to delete");
    }
    if is_status_seat(&path) {
        bail!("status branches are system furniture (#165, §4.35) — delete is refused");
    }
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
    let mut con = connect(paths)?;
    // every person in the branch has their group path rewritten/dropped.
    let affected: Vec<i64> = {
        let mut st = con.prepare(&format!(
            "SELECT DISTINCT person_id FROM person_groups WHERE {BRANCH_OF}"
        ))?;
        st.query_map(params![path], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
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
    // #219 — the persons in the branch have new group paths (person rows).
    delta_after(paths, &*con, v1, &affected, &[], &[], &[], Vec::new())
}

/// §4.16 (#50/#165) — move persons to a (possibly new) group: each
/// person's group path is replaced with the target; empty ⇒ the person
/// falls to their status seat (§4.35). Works for any persons, wherever
/// they live (rows in the status branches included — writer-owned
/// persons are refused, §4.35/#266). Faces, names, statuses, primaries untouched.
pub fn move_persons_to_group(paths: &Paths, person_ids: &[i64], group: &str) -> Result<Delta> {
    let ids: HashSet<i64> = person_ids.iter().copied().collect();
    if ids.is_empty() {
        bail!("no persons selected");
    }
    let id_list: Vec<i64> = ids.iter().copied().collect();
    let path = normalize_group_path(group);
    validate_group_path(&path)?;
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    // #220 — the per-pid existence COUNT + system-person guard is one
    // IN-cluster fetch (B-M4): the guard reads the name from the same
    // rows, so it needs no extra query.
    let list = ids_list(&id_list);
    let present: Vec<(i64, String)> = {
        let mut st = tx.prepare(&format!("SELECT id, name FROM persons WHERE id IN ({list})"))?;
        st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut moved = 0;
    for (_, pname) in &present {
        if pname == "Rejected" || is_rejected_cluster_name(pname) {
            bail!("'{pname}' is writer-owned (the RejectedN cluster family, #266) and cannot be changed");
        }
        moved += 1;
    }
    if moved == 0 {
        bail!("none of the selected persons exist any more");
    }
    // #283 (N4): the common case (a real target path) is TWO set-based
    // statements for the whole selection (the old per-pid loop was 2×N);
    // insert-first: the final row lands before the old rows drop — §4.35
    if !path.is_empty() {
        tx.execute(
            &format!(
                "INSERT OR REPLACE INTO person_groups (person_id, path)
                   SELECT id, ?1 FROM persons WHERE id IN ({list})"
            ),
            params![path],
        )?;
        tx.execute(
            &format!(
                "DELETE FROM person_groups WHERE person_id IN ({list}) AND path != ?1"
            ),
            params![path],
        )?;
    } else {
        // to the status seat: derive it per person (a per-pid CASE in SQL
        // would have to be spelled twice per person — the loop stays)
        for (pid, _) in &present {
            let final_path = derive_seat(&tx, *pid)?.to_string();
            tx.execute(
                "INSERT OR REPLACE INTO person_groups (person_id, path) VALUES (?1, ?2)",
                params![pid, final_path],
            )?;
            tx.execute(
                "DELETE FROM person_groups WHERE person_id = ?1 AND path != ?2",
                params![pid, final_path],
            )?;
        }
    }
    tx.commit()?;
    // #219 — the moved persons have new group paths (person rows).
    delta_after(paths, &*con, v1, &id_list, &[], &[], &[], Vec::new())
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
) -> Result<Delta> {
    let ids: HashSet<i64> = person_ids.iter().copied().collect();
    if ids.is_empty() {
        bail!("no persons selected");
    }
    let id_list: Vec<i64> = ids.iter().copied().collect();
    let from = normalize_group_path(from_group);
    let to = normalize_group_path(to_group);
    if !to.is_empty() {
        validate_group_path(&to)?;
    }
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    // #220 — the per-pid existence COUNT + system-person guard is one
    // IN-cluster fetch (B-M4): the guard reads the name from the same
    // rows, so it needs no extra query.
    let list = ids_list(&id_list);
    let present: Vec<(i64, String)> = {
        let mut st = tx.prepare(&format!("SELECT id, name FROM persons WHERE id IN ({list})"))?;
        st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut moved = 0;
    for (_, pname) in &present {
        if pname == "Rejected" || is_rejected_cluster_name(pname) {
            bail!("'{pname}' is writer-owned (the RejectedN cluster family, #266) and cannot be changed");
        }
        moved += 1;
    }
    if moved == 0 {
        bail!("none of the selected persons exist any more");
    }
    // #283 (N4): set-based — one statement per shape over the whole
    // selection (the old loop was 2–3 statements per person)
    if from != to {
        tx.execute(
            &format!(
                "DELETE FROM person_groups WHERE person_id IN ({list}) AND path = ?1"
            ),
            params![from],
        )?;
    }
    if !to.is_empty() {
        // insert-first: the target row lands before the seat drops
        tx.execute(
            &format!(
                "INSERT OR IGNORE INTO person_groups (person_id, path)
                   SELECT id, ?1 FROM persons WHERE id IN ({list})"
            ),
            params![to],
        )?;
        // §4.35/§4.18: filing replaces the seat — an add-group onto a
        // seated person drops the seat (insert happened above first)
        tx.execute(
            &format!(
                "DELETE FROM person_groups
                   WHERE person_id IN ({list})
                     AND path IN ('New', 'Accepted', 'Rejected')"
            ),
            [],
        )?;
    } else {
        // §4.35: last membership removed ⇒ the derived seat — ensure_seat
        // for the whole selection at once (insert only where the person
        // has no row left; the seat is derived per person by the same CASE
        // as derive_seat)
        tx.execute(
            &format!(
                "INSERT OR IGNORE INTO person_groups (person_id, path)
                   SELECT p.id, CASE WHEN EXISTS(SELECT 1 FROM faces f
                                     WHERE f.person_id = p.id
                                       AND f.link_status = 'provisional')
                                THEN 'New' ELSE 'Accepted' END
                     FROM persons p WHERE p.id IN ({list})
                       AND NOT EXISTS (SELECT 1 FROM person_groups g
                                        WHERE g.person_id = p.id)"
            ),
            [],
        )?;
    }
    tx.commit()?;
    // #219 — the moved persons have new group paths (person rows).
    delta_after(paths, &*con, v1, &id_list, &[], &[], &[], Vec::new())
}

pub fn set_person_note(paths: &Paths, person_id: i64, note: &str) -> Result<Delta> {
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
    let con = connect(paths)?;
    con.execute(
        "UPDATE persons SET note = ? WHERE id = ?",
        params![if note.trim().is_empty() { None } else { Some(note.trim()) }, person_id],
    )?;
    // #219 — only the person row (note) changed.
    delta_after(paths, &*con, v1, &[person_id], &[], &[], &[], Vec::new())
}

/// §4.13 (#35/#165/#266) — remove unwanted persons: every face becomes
/// `rejected` and JOINS a `RejectedN` cluster person (§4.2/§4.35 — no
/// writer ever detaches a face anymore), stale foreign primary pointers
/// are cleared, then the person row is deleted (its groups/refcrops go
/// with it — the group invariant governs living persons only). Faces are
/// never deleted. Writer-owned persons (`Rejected`/`RejectedN`) can
/// never be removed. One transaction for the whole batch; no undo.
pub fn remove_persons(paths: &Paths, person_ids: &[i64]) -> Result<Delta> {
    let ids: HashSet<i64> = person_ids.iter().copied().collect();
    if ids.is_empty() {
        bail!("no persons selected");
    }
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
    let mut con = connect(paths)?;
    let settings = get_settings(paths)?;
    let tx = con.transaction()?;
    // #220 — one IN-cluster fetch replaces the per-pid
    // guard/SELECT/UPDATE/DELETE loop (B-M3/B-M4); the re-home is
    // reject_and_rehome's set-based writer.
    let id_list: Vec<i64> = ids.iter().copied().collect();
    let p_list = ids_list(&id_list);
    let present: Vec<(i64, String)> = {
        let mut st = tx.prepare(&format!("SELECT id, name FROM persons WHERE id IN ({p_list})"))?;
        st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    for (_, pname) in &present {
        if pname == "Rejected" || is_rejected_cluster_name(pname) {
            bail!("'{pname}' is writer-owned (the RejectedN cluster family, #266) and cannot be removed");
        }
    }
    if present.is_empty() {
        bail!("none of the selected persons exist any more");
    }
    // defensive: no OTHER person may keep pointing at these faces
    tx.execute(
        &format!("UPDATE persons SET primary_face_id = NULL, primary_pinned = 0
                  WHERE primary_face_id IN
                      (SELECT id FROM faces WHERE person_id IN ({p_list}) )"),
        [],
    )?;
    // §4.2/§4.35: rejection re-homes — the faces join `Rejected`
    let rehomed_faces: Vec<i64> = {
        let mut st = tx.prepare(&format!("SELECT id FROM faces WHERE person_id IN ({p_list})"))?;
        let rows = st.query_map([], |r| r.get::<_, i64>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut touched: HashSet<i64> = HashSet::new();
    // #281: a removed person's faces re-home onto `RejectedN` clusters
    // (the targets join the touched persons); retiring the legacy
    // `Rejected` bin mid-batch reports its deleted id and moved faces
    // the same way
    let mut removed_extra: Vec<i64> = Vec::new();
    let mut extra_faces: Vec<i64> = Vec::new();
    if !rehomed_faces.is_empty() {
        let (aff, rem, faces) = reject_and_rehome(&tx, &rehomed_faces, settings.cluster_threshold)?;
        touched.extend(aff);
        removed_extra.extend(rem);
        extra_faces.extend(faces);
    }
    // #46: delete dependents explicitly instead of trusting the FK
    // cascade — a connection opened without foreign_keys=ON would
    // otherwise orphan these rows (the person dies, so no seat is
    // written for it — §4.35 governs living persons)
    tx.execute(&format!("DELETE FROM person_groups WHERE person_id IN ({p_list})"), [])?;
    tx.execute(&format!("DELETE FROM person_refcrops WHERE person_id IN ({p_list})"), [])?;
    tx.execute(&format!("DELETE FROM persons WHERE id IN ({p_list})"), [])?;
    let removed: Vec<i64> = present.iter().map(|(id, _)| *id).collect();
    for pid in &removed {
        touched.remove(pid);
    }
    let touched: Vec<i64> = touched.into_iter().collect();
    for pid in &touched { // the RejectedN bins, in practice
        recompute_person(&tx, *pid, &settings)?;
        reseat(&tx, *pid)?;
    }
    tx.commit()?;
    // #219 — removed = deleted person ids (plus the legacy bin the
    // #266/#281 split retired); rehomed_faces = their faces (plus the
    // faces the split moved); touched = recomputed persons (e.g. a
    // `RejectedN` target's primary). Names are set per-face by
    // reject_and_rehome, so no person's full face set is re-fetched.
    let mut all_removed: Vec<i64> = removed;
    all_removed.extend(removed_extra);
    let mut all_faces: Vec<i64> = rehomed_faces.clone();
    all_faces.extend(extra_faces);
    delta_after(paths, &*con, v1, &touched, &[], &all_faces, &[], all_removed)
}

/// §4.6 — manually promote a confirmed face into refcrops (survives rebuilds).
/// #210: the row is metadata only — crop and filename derive at read.
pub fn add_refcrop(paths: &Paths, person_id: i64, face_id: i64) -> Result<Delta> {
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
    let mut con = connect(paths)?;
    let tx = con.transaction()?;
    let (ok, desc, preview): (bool, Option<String>, Option<Vec<u8>>) = tx
        .query_row(
            "SELECT person_id = ?, description, preview FROM faces
              WHERE id = ? AND link_status = 'confirmed' AND state != 'discarded'",
            params![person_id, face_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .unwrap_or((false, None, None));
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
            // upgrade an auto row to a pin in place (keeps its seq)
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
            // §4.6 invariant: a crop-less face cannot become a refcrop
            // (the crop itself derives at read — schema v1.8)
            preview.context("face has no preview")?;
            tx.execute(
                "INSERT INTO person_refcrops (person_id, face_id, description, pinned, seq)
                 VALUES (?, ?, ?, 1, ?)",
                params![person_id, face_id, group, seq],
            )?;
        }
    }
    tx.commit()?;
    // #219 — only person_refcrops changed (metadata, not in the
    // snapshot); the frontend tracks refcrops via refcropEpoch. The delta
    // carries the new stamp only.
    delta_after(paths, &*con, v1, &[], &[], &[], &[], Vec::new())
}

pub fn remove_refcrop(paths: &Paths, person_id: i64, face_id: i64) -> Result<Delta> {
    // #219 — the stamp before the write, for drift detection.
    let v1 = data_version(paths)?;
    let con = connect(paths)?;
    con.execute(
        "DELETE FROM person_refcrops WHERE person_id = ? AND face_id = ?",
        params![person_id, face_id],
    )?;
    // #219 — only person_refcrops changed (metadata, not in the
    // snapshot); the delta carries the new stamp only.
    delta_after(paths, &*con, v1, &[], &[], &[], &[], Vec::new())
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

/// #211 — display-side cluster cache. Key: (db path, person, threshold
/// bits); value: (fingerprint of the input rows, clusters, hits served
/// since the last compute). The fingerprint covers exactly the rows the
/// clustering consumes (membership, id, confidence, primary flag,
/// description — the vectors are immutable per face), so any input
/// change misses and recomputes, while a change that feeds nothing here
/// (e.g. a provisional→confirmed verdict) hits. Bounded crudely by
/// clearing — the GUI only ever asks for the anchored person's clusters;
/// the map is a per-process working set, not a store.
struct ClusterCache {
    /// #249 — recency order: front = most-recently-used, back = evicted
    /// first. The old full-clear on the 257th distinct key degenerated to
    /// recompute-every-time once more than 256 persons were browsed; the
    /// LRU keeps the hot set.
    order: Vec<(PathBuf, i64, u64)>,
    map: HashMap<(PathBuf, i64, u64), (String, Vec<AppearanceGroup>, usize)>,
}
const CLUSTER_CACHE_MAX: usize = 256;
static CLUSTER_CACHE: Mutex<Option<ClusterCache>> = Mutex::new(None);

impl ClusterCache {
    /// promote `key` to most-recently-used (a served cache hit).
    fn touch(&mut self, key: &(PathBuf, i64, u64)) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            let k = self.order.remove(pos);
            self.order.insert(0, k);
        }
    }
    /// insert/replace, keeping at most `CLUSTER_CACHE_MAX` entries (LRU):
    /// a new key is pushed to the front and the coldest is evicted; a
    /// recompute of an existing key (stale fingerprint) just promotes it.
    fn put(
        &mut self,
        key: (PathBuf, i64, u64),
        val: (String, Vec<AppearanceGroup>, usize),
    ) {
        let is_new = !self.map.contains_key(&key);
        self.map.insert(key.clone(), val);
        if is_new {
            self.order.insert(0, key);
            if self.order.len() > CLUSTER_CACHE_MAX {
                if let Some(cold) = self.order.pop() {
                    self.map.remove(&cold);
                }
            }
        } else {
            self.touch(&key);
        }
    }
}

#[cfg(test)]
mod cluster_cache_tests {
    use super::{AppearanceGroup, ClusterCache};
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn key(i: i64) -> (PathBuf, i64, u64) {
        (PathBuf::from("/tmp"), i, 0u64)
    }
    fn val(i: i64) -> (String, Vec<AppearanceGroup>, usize) {
        (format!("{i}"), Vec::new(), 0)
    }

    /// #249 — a full cache evicts the coldest entry, not everything: a
    /// recently-touched entry survives, a never-touched one goes.
    #[test]
    fn evicts_cold_not_hot() {
        let mut c = ClusterCache { order: Vec::new(), map: HashMap::new() };
        for i in 0..256i64 {
            c.put(key(i), val(i));
        }
        assert_eq!(c.map.len(), 256);
        // promote key 0 to most-recently-used
        c.touch(&key(0));
        // a new key overflows -> evicts the coldest (key 1; key 0 is hot)
        c.put(key(999), val(999));
        assert_eq!(c.map.len(), 256);
        assert!(c.map.contains_key(&key(0)), "hot entry survives");
        assert!(!c.map.contains_key(&key(1)), "cold entry evicted");
        assert!(c.map.contains_key(&key(999)), "new entry present");
    }

    /// #249 — a recompute of an existing key (stale fingerprint) replaces
    /// the value and promotes it, without adding a duplicate order entry.
    #[test]
    fn recompute_promotes_not_duplicates() {
        let mut c = ClusterCache { order: Vec::new(), map: HashMap::new() };
        c.put(key(5), val(5));
        c.put(key(5), val(5)); // stale-fingerprint recompute of the same key
        assert_eq!(c.order.len(), 1, "no duplicate order entry");
        assert_eq!(c.map[&key(5)].0, "5");
    }
}

fn cluster_lock() -> Result<std::sync::MutexGuard<'static, Option<ClusterCache>>> {
    CLUSTER_CACHE.lock().map_err(|_| anyhow!("cluster cache lock poisoned"))
}

/// The cluster inputs as one string — any difference means a possibly
/// different result, so it doubles as the cache's validity stamp.
fn cluster_fingerprint(rows: &[(i64, f64, bool, String)]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(rows.len() * 40);
    for (id, conf, primary, desc) in rows {
        let _ = write!(out, "{id}:{:016x}:{}:{desc};", conf.to_bits(), *primary as u8);
    }
    out
}

/// #211 — introspection for the tests: how often the cached clusters for
/// (person, threshold) have been served since the last (re)compute.
#[doc(hidden)]
pub fn cluster_cache_hits(paths: &Paths, person_id: i64, threshold: f64) -> usize {
    let Ok(guard) = CLUSTER_CACHE.lock() else { return 0 };
    let Some(cache) = guard.as_ref() else { return 0 };
    cache
        .map
        .get(&(paths.db.clone(), person_id, threshold.to_bits()))
        .map(|(_, _, hits)| *hits)
        .unwrap_or(0)
}

/// §4.9 — display-side grouping of one person's faces: partitioned by
/// appearance (distinct description), then single-linkage around the
/// primary face *within* each appearance. Rejected/discarded excluded.
/// #211: results are cached per (person, threshold) behind the input
/// fingerprint above.
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
    // #211 — cache hit? (the fingerprint is derived from the rows just
    // read, so this costs one string build, not another query pass)
    let key = (paths.db.clone(), person_id, threshold.to_bits());
    let fp = cluster_fingerprint(&faces);
    {
        let mut guard = cluster_lock()?;
        let cache = guard.get_or_insert_with(|| ClusterCache { order: Vec::new(), map: HashMap::new() });
        // clone the result out before touching — the get_mut borrow must
        // end before the mutable touch (E0499)
        let hit: Option<Vec<AppearanceGroup>> = match cache.map.get_mut(&key) {
            Some(entry) if entry.0 == fp => {
                entry.2 += 1;
                Some(entry.1.clone())
            }
            _ => None,
        };
        if let Some(out) = hit {
            cache.touch(&key);
            return Ok(out);
        }
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

    let out: Vec<AppearanceGroup> = grouped
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
        .collect();
    // #211: remember the result under its input fingerprint
    if let Ok(mut guard) = cluster_lock() {
        let cache = guard.get_or_insert_with(|| ClusterCache { order: Vec::new(), map: HashMap::new() });
        cache.put(key, (fp, out.clone(), 0));
    }
    Ok(out)
}

#[derive(Serialize, Clone, Debug)]
pub struct Refcrop {
    pub face_id: i64,
    pub seq: i64,
    /// appearance group (the face's description; "" = none)
    pub description: String,
    pub pinned: bool,
    pub filename: String,
}

pub fn get_refcrops(paths: &Paths, person_id: i64) -> Result<Vec<Refcrop>> {
    let con = connect(paths)?;
    // #210/#212: the rows are metadata — the filename derives from the
    // face and the crop pixels load through the binary image pipeline
    // (face/<face_id>); a crop-less face is never a refcrop (§4.6)
    let mut st = con.prepare(
        "SELECT r.face_id, r.seq, r.description, r.pinned,
                f.name || '-' || r.seq || '.jpg'
           FROM person_refcrops r JOIN faces f ON f.id = r.face_id
          WHERE r.person_id = ? AND f.preview IS NOT NULL
          ORDER BY r.description, r.seq",
    )?;
    let rows = st.query_map(params![person_id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (face_id, seq, description, pinned, filename) = row?;
        out.push(Refcrop {
            face_id,
            seq,
            description,
            pinned: pinned != 0,
            filename,
        });
    }
    Ok(out)
}


