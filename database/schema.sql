-- who app — faces.db schema (v1.7; behaviour rules: docs/gui-design.md §4,
-- incl. §4.35: status seats New/Accepted/Rejected and the ≥1-group-row
-- invariant). No migrations: drop and recreate. The schema_version table
-- lets the app, the importer and the annotation tools verify they are
-- talking to the matching schema (SCHEMA_VERSION in src-tauri/src/db.rs,
-- scripts/import_roll.py, scripts/import_harvested.py and
-- scripts/annotation_snapshot.py must equal the value inserted below).
-- A v1.6 database is upgraded IN PLACE by scripts/fix_status_groups.py
-- (backup first) instead of being recreated — its stored .schema stays
-- byte-identical to a fresh build of this file (#165).
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
  created_at            TEXT NOT NULL,
  UNIQUE (image_id, x, y, w, h)              -- face identity: image + rectangle
);
CREATE INDEX idx_faces_person  ON faces(person_id);
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
-- A v1.6 database reaches this contract via scripts/fix_status_groups.py.
CREATE TABLE person_groups (
  person_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,                 -- free-form | -path, e.g. family|lombards
  PRIMARY KEY (person_id, path)
);

CREATE TABLE person_refcrops (
  person_id   INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  face_id     INTEGER NOT NULL UNIQUE REFERENCES faces(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',  -- appearance group: the face's description ('' = none)
  pinned      INTEGER NOT NULL DEFAULT 0, -- 1 = manual pin: excluded from auto top-N, survives recompute (§4.6)
  seq         INTEGER NOT NULL,           -- 1..n within (person, description)
  filename    TEXT NOT NULL,                 -- face.name + "-" + seq + ".jpg"
  crop        BLOB NOT NULL,
  PRIMARY KEY (person_id, description, seq)
);

-- Single-row schema marker (exact-match check; no migrations by policy).
CREATE TABLE schema_version (
  version    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO schema_version(version, updated_at) VALUES ('1.7', datetime('now'));
