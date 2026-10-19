-- harvest staging DB — faces.db design §8.2 (docs/gui-design.md v3.0, schema v1.1)
-- Created fresh by scripts/harvest_legacy.py; never migrated, never mixed
-- with faces.db, and the harvester's only write target (invariants H1-H4).
-- v1.1: rectangle-less capture removed — only faces with geometry are
-- harvested (§9 attaches persons by rectangle overlap), so the former
-- image_persons table and the sidecars-mpri source are gone.
--   sqlite3 harvest.db < database/harvest_schema.sql   (tests / emergencies)

PRAGMA journal_mode = WAL;

DROP TABLE IF EXISTS faces;
DROP TABLE IF EXISTS images;
DROP TABLE IF EXISTS person_refs;
DROP TABLE IF EXISTS person_groups;
DROP TABLE IF EXISTS persons;
DROP TABLE IF EXISTS sources;
DROP TABLE IF EXISTS harvest_runs;

CREATE TABLE harvest_runs (
  id          INTEGER PRIMARY KEY,
  started_at  TEXT NOT NULL,               -- ISO-8601 UTC (design #40 clock)
  finished_at TEXT,                        -- NULL = run did not complete
  sources     TEXT NOT NULL,               -- JSON list of canonical source names
  roots       TEXT,                        -- JSON {kind: path} of scanned roots
  stats       TEXT                         -- JSON counts, written on finish
);

CREATE TABLE sources (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,               -- canonical vocabulary (design §8)
  kind TEXT NOT NULL CHECK (kind IN ('sidecars','lightroom','digikam'))
);

CREATE TABLE persons (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,     -- identity, exactly as a source says
  created_at     TEXT NOT NULL,
  harvest_run_id INTEGER NOT NULL REFERENCES harvest_runs(id)
);

CREATE TABLE person_groups (
  person_id      INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,            -- '|' path, e.g. People|Friends|X
  source_id      INTEGER NOT NULL REFERENCES sources(id),
  harvest_run_id INTEGER NOT NULL REFERENCES harvest_runs(id),
  PRIMARY KEY (person_id, path)
);
CREATE INDEX idx_person_groups_path ON person_groups(path);

CREATE TABLE person_refs (
  person_id      INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,            -- source name the ref came from
  ref            TEXT NOT NULL,            -- uuid, or keyword:<uuid>
  source_id      INTEGER NOT NULL REFERENCES sources(id),
  harvest_run_id INTEGER NOT NULL REFERENCES harvest_runs(id),
  PRIMARY KEY (person_id, kind, ref)
);

CREATE TABLE images (
  id             INTEGER PRIMARY KEY,
  path           TEXT UNIQUE,              -- fs path as the source states it
  path_origin    TEXT CHECK (path_origin IN ('source','name-size')),
  content_hash   TEXT,                     -- BLAKE3, 64 hex; set ONLY when the
                                           --   image was certainly resolved and
                                           --   read for hashing (design §8, H3)
  name           TEXT,                     -- source's own basename (digiKam)
  file_size      INTEGER,                  -- source's own byte size (digiKam)
  source_ref     TEXT,                     -- source's own image id, if any
  source_id      INTEGER NOT NULL REFERENCES sources(id),
  width          INTEGER,                  -- when the source states them
  height         INTEGER,
  harvest_run_id INTEGER NOT NULL REFERENCES harvest_runs(id)
);
CREATE INDEX idx_images_name_size ON images(name, file_size);
CREATE INDEX idx_images_source_ref ON images(source_ref);

CREATE TABLE faces (
  id             INTEGER PRIMARY KEY,
  image_id       INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  person_id      INTEGER NOT NULL REFERENCES persons(id),
  x              REAL NOT NULL,            -- corner origin, as the source
  y              REAL NOT NULL,            --   states it; normalised->pixel
  w              REAL NOT NULL,            --   conversion is the importer's
  h              REAL NOT NULL,            --   job (design §8.2)
  unit           TEXT NOT NULL CHECK (unit IN ('normalized','pixels')),
  img_w          INTEGER,                  -- source-stated image dims
  img_h          INTEGER,
  source_id      INTEGER NOT NULL REFERENCES sources(id),
  source_ref     TEXT,                     -- source's own face id, if any
  picked         INTEGER NOT NULL DEFAULT 0,  -- source's own user confirmed it
  harvest_run_id INTEGER NOT NULL REFERENCES harvest_runs(id),
  UNIQUE (image_id, person_id, x, y, w, h, source_id)
);
CREATE INDEX idx_faces_person ON faces(person_id);
CREATE INDEX idx_faces_image  ON faces(image_id);

-- Single-row schema marker (exact-match check; no migrations by policy).
CREATE TABLE schema_version (
  version    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO schema_version(version, updated_at) VALUES ('1.1', datetime('now'));
