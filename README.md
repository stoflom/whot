# WhoT

Face database and review GUI for photo rolls. Faces detected at import
(insightface) are stored with 512-d embeddings in a SQLite database; the GUI
is used to review, name, accept, reject and annotate them.

## Components

| Part | Where | Notes |
|---|---|---|
| Schema | `database/schema.sql` | single source of truth; DB is dropped & recreated on schema changes |
| Import script | `scripts/import_roll.py` | scans a roll, detects faces, clusters (single-linkage ≥ 0.40), writes `data/faces.db` |
| GUI | repo root (Tauri 2 + React + TS, Rust backend in `src-tauri/`) | review/naming/annotation; serves images from DB BLOBs, no Python at runtime |
| Config | `.env` (paths), `config/whotrc.json` (GUI settings, created at runtime) | |

## Setup

- Python venv with `insightface` (see `INSIGHTFACE_PATH` in `.env`); the
  buffalo_l model is downloaded on first run.
- Node 22+, Rust (Tauri prerequisites: webkit2gtk-4.1, gtk3).
- Paths (data, config, insightface, input directories) live in `.env` —
  copy the committed template and adjust.

```sh
npm install
python3 -m venv insight_env   # or point INSIGHTFACE_PATH at an existing one
```

## Import a roll

```sh
.venv/bin/python scripts/import_roll.py <roll-dir> <label>
```

Every cluster becomes an `UnknownN` person; all faces start `provisional`.

## Run the GUI

```sh
npm run tauri dev      # development
npm run tauri build    # release bundles
```

Main flows: rename an `UnknownN` group (accepts & names it, moving it into a
group path), assign selected faces to an existing or new person, reject or
re-accept faces, per-face descriptions, primary face, reference faces.

## Tests

```sh
(cd src-tauri && cargo test --lib)   # Rust integration tests (use a temp copy of the DB)
npx tsc --noEmit                     # TypeScript
```

## Docs

- `AGENTS.md` — agent conventions (branching, versioning, testing)
- `docs/gui-design.md` — GUI design document (versioned)
