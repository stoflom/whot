-- who app — faces.db schema (v1.9; behaviour rules: docs/gui-design.md §4,
-- incl. §4.35: status seats New/Accepted/Rejected and the ≥1-group-row
-- invariant). No migrations: drop and recreate. v1.9 (#220) adds
-- faces.description_key (= COALESCE(description,''), writer-maintained)
-- and swaps idx_faces_person for the composite
-- idx_faces_person_desc_seq(person_id, description_key, seq) so the
-- seq-group key is index-backed; no data moves. The schema_version table
-- lets the app, the importer and the annotation tools verify they are
-- talking to the matching schema (SCHEMA_VERSION in src-tauri/src/db.rs,
-- scripts/import_roll.py, scripts/import_harvested.py and
-- scripts/annotation_snapshot.py must equal the value inserted below).
-- Annotations survive a recreate: scripts/annotation_snapshot.py
-- export → recreate → restore (its export also reads v1.5–v1.7 sources).
-- A v1.7 database reaches v1.8 IN PLACE — the two derived refcrop
-- columns drop and the marker moves up (no data moves; backup first):
--   VACUUM INTO 'faces.db.pre-v1.8-<ts>.db';
--   ALTER TABLE person_refcrops DROP COLUMN filename;
--   ALTER TABLE person_refcrops DROP COLUMN crop;
--   UPDATE schema_version SET version = '1.8';
-- v1.8 reaches v1.9 IN PLACE too (no data moves; backup first) — the
-- ADD COLUMN lands description_key at the END of the column list (the
-- fresh DDL below matches that shape, keeping the stored DDL
-- byte-identical to a fresh build):
--   VACUUM INTO 'faces.db.pre-v1.9-<ts>.db';
--   ALTER TABLE faces ADD COLUMN description_key TEXT NOT NULL DEFAULT '';
--   UPDATE faces SET description_key = COALESCE(description, '');
--   DROP INDEX idx_faces_person;
--   CREATE INDEX idx_faces_person_desc_seq
--     ON faces(person_id, description_key, seq);
--   CREATE INDEX idx_person_groups_path ON person_groups(path);
--   UPDATE schema_version SET version = '1.9';
-- The historical in-place v1.6 fix (scripts/fix_status_groups.py) lands
-- at v1.7 and stops there; from there take either step above.
--   sqlite3 data/faces.db < database/schema.sql

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS person_refcrops;
DROP TABLE IF EXISTS face_embeddings;
DROP TABLE IF EXISTS faces;
DROP TABLE IF EXISTS person_groups;
DROP TABLE IF EXISTS persons;
DROP TABLE IF EXISTS image_paths;
DROP TABLE IF EXISTS images;
DROP TABLE IF EXISTS imports;

CREATE TABLE imports (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL,                -- film-roll subdirectory
  started_at  TEXT NOT NULL                 -- ISO-8601
);

CREATE TABLE images (
  id             INTEGER PRIMARY KEY,
  content_hash   TEXT NOT NULL UNIQUE,      -- BLAKE3, 64 hex chars (identity)
  width          INTEGER NOT NULL,          -- source (decode) pixel dims — canonical
  height         INTEGER NOT NULL,          --   coordinate space for rectangles (#18)
  primary_path   TEXT NOT NULL,             -- first path found; updated on rescan
  state          TEXT NOT NULL DEFAULT 'imported'
                 CHECK (state IN ('imported','scanned','no-face')),
  orientation    TEXT CHECK (orientation IN ('landscape','portrait')),
  rotation       INTEGER NOT NULL DEFAULT 0
                 CHECK (rotation IN (0,90,180,270)),  -- EXIF display rotation, CW (#118/#122)
  inversion      TEXT NOT NULL DEFAULT 'none'
                 CHECK (inversion IN ('none','lr','tb','both')),
  type           TEXT CHECK (type IN ('raw','processed')),
  thumbnail      BLOB,                      -- stored icon; survives file loss
  preview        BLOB,                      -- embedded preview or generated
  first_import_id INTEGER REFERENCES imports(id),
  last_import_id  INTEGER REFERENCES imports(id),
  created_at     TEXT NOT NULL
);

CREATE TABLE image_paths (
  image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  path      TEXT NOT NULL,
  PRIMARY KEY (image_id, path)
);
CREATE INDEX idx_image_paths_path ON image_paths(path);

-- NOTE: faces is created before persons so persons.primary_face_id can carry a
-- real FK; SQLite accepts FK references to tables that are created later.
-- #165 (gui-design §4.35): `persons.name` also reserves the EXACT name
-- `Rejected` for the system person that owns every rejected face (like
-- the `Unknown*` prefix rule in validate_person_name); that person is
-- created on demand, never renamed/removed, and is only listed under
-- Show → Rejected.
-- v1.9 (#220): `description_key` is the writer-maintained
-- COALESCE(description,'') normalisation — the composite index key
-- below needs a plain column; the old COALESCE filter defeated
-- idx_faces_person for the seq-group MAX(seq). It sits at the END of
-- the column list on purpose: SQLite's ALTER TABLE … ADD COLUMN (the
-- in-place v1.8 → v1.9 step in the header) puts it there, and a fresh
-- build must stay byte-identical to a migrated one (#165's standard;
-- v1.8 did the same for the `seq` line). Every writer that writes
-- `description` writes `description_key` in the same statement.

CREATE TABLE faces (
  id                    INTEGER PRIMARY KEY,
  image_id              INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  x                     INTEGER NOT NULL,   -- rectangle, pixel units
  y                     INTEGER NOT NULL,
  w                     INTEGER NOT NULL,
  h                     INTEGER NOT NULL,
  person_id             INTEGER REFERENCES persons(id),
  link_status           TEXT NOT NULL DEFAULT 'provisional'
                        CHECK (link_status IN ('provisional','confirmed','rejected')),
  reassigned            INTEGER NOT NULL DEFAULT 0,   -- user changed the import-time suggestion
  state                 TEXT NOT NULL DEFAULT 'detected'
                        CHECK (state IN ('imported','detected','created','discarded')),
  origin                TEXT NOT NULL DEFAULT 'insightface',
  description           TEXT,                -- free-form; spaces around | trimmed by writer
  name                  TEXT NOT NULL,       -- derived label: person.name[-description]-seq
  seq                   INTEGER NOT NULL,
  confidence            REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0),
  rotation              INTEGER NOT NULL DEFAULT 0
                        CHECK (rotation IN (0,90,180,270)),  -- crop display rotation, CW (#122; renamed from the dead v1.5 `orientation` column)
  inversion             TEXT NOT NULL DEFAULT 'none'
                        CHECK (inversion IN ('none','lr','tb','both')),
  preview               BLOB,
  detected_in_import_id INTEGER REFERENCES imports(id),
  created_at            TEXT NOT NULL, description_key TEXT NOT NULL DEFAULT '',
  UNIQUE (image_id, x, y, w, h)              -- face identity: image + rectangle
);
-- v1.9 (#220): composite seq-group key — the (person_id) prefix still
-- serves the person-scoped lookups idx_faces_person did, and
-- (person_id, description_key) = const makes MAX(seq) an index seek;
-- one index instead of two on the same column.
CREATE INDEX idx_faces_person_desc_seq ON faces(person_id, description_key, seq);
CREATE INDEX idx_faces_image   ON faces(image_id);
CREATE INDEX idx_faces_import  ON faces(detected_in_import_id);

-- recognition vectors (insightface); model-versioned, one vector per face per model
CREATE TABLE face_embeddings (
  face_id    INTEGER NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,                 -- e.g. 'insightface:buffalo_l'
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,                 -- little-endian float32[dim], L2-normalised
  created_at TEXT NOT NULL,
  PRIMARY KEY (face_id, model)
);

CREATE TABLE persons (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,    -- identity; UnknownN for unknown
  state            TEXT NOT NULL DEFAULT 'created'
                   CHECK (state IN ('imported','created')),
  note             TEXT,
  primary_face_id  INTEGER UNIQUE REFERENCES faces(id) ON DELETE SET NULL,
  primary_pinned   INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);

-- #165 / gui-design §4.35 — the GROUP INVARIANT, writer-owned (no
-- trigger: the writers replace a group by inserting before deleting):
-- EVERY person carries at least one row here; the "no group" state does
-- not exist. `New`/`Accepted`/`Rejected` are system-written status
-- seats (state-derived: any provisional face ⇒ New, else Accepted; the
-- system person `Rejected` always holds `Rejected`), and `Ungrouped`,
-- `New`, `Accepted`, `Rejected` plus the retired `Unknown` are reserved
-- path segments no user input may produce (validate_group_path).
CREATE TABLE person_groups (
  person_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,                 -- free-form | -path, e.g. family|smiths
  PRIMARY KEY (person_id, path)
);

-- #228 (B-L1): person_groups had no standalone path index — every
-- membership lookup went through the (person_id, path) PRIMARY KEY or a
-- scan. The path index serves the equality half of the BRANCH_OF match
-- (`path = ?1`) and the pure-path lookups; the substr prefix half stays
-- unsargable (SQLite cannot index a substr expression, and a range
-- rewrite of `path >= ?1 || '|'` would break on arbitrary path bytes),
-- which is why the finding is LOW: it only matters with thousands of
-- memberships × branch writes.
CREATE INDEX idx_person_groups_path ON person_groups(path);

-- #210 (schema v1.8) / gui-design §4.6: per-appearance reference faces.
-- The row is METADATA only — the crop and the filename derive at READ
-- time from the referenced face (`faces.preview`;
-- `faces.name || '-' || seq || '.jpg'`), so refcrop rebuilds copy no
-- BLOBs and renames touch no refcrop rows. `seq` is 1..n within
-- (person, description). NOTE: the `seq` line carries no trailing
-- comment — SQLite's ALTER TABLE … DROP COLUMN rebuilds the stored DDL
-- without it, and a fresh build here must stay byte-identical to a
-- migrated v1.7 database (#165's standard).
CREATE TABLE person_refcrops (
  person_id   INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  face_id     INTEGER NOT NULL UNIQUE REFERENCES faces(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',  -- appearance group: the face's description ('' = none)
  pinned      INTEGER NOT NULL DEFAULT 0, -- 1 = manual pin: excluded from auto top-N, survives recompute (§4.6)
  seq         INTEGER NOT NULL,
  PRIMARY KEY (person_id, description, seq)
);

-- Single-row schema marker (exact-match check; no migrations by policy).
CREATE TABLE schema_version (
  version    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO schema_version(version, updated_at) VALUES ('1.9', datetime('now'));
