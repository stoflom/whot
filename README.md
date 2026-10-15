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

- Python venv with `insightface` at `<INSIGHTFACE_PATH>/insight_env` — with
  the shipped `.env` that means `../insightface/insight_env` relative to the
  repo root; the buffalo_l model is downloaded on first run.
- Node 22+, Rust (Tauri prerequisites: webkit2gtk-4.1, gtk3).
- Paths (data, config, insightface, input directories) live in `.env` —
  copy the committed `.env.sample` template and adjust. `${VAR}` references
  resolve against other `.env` keys first, then the process environment
  (`${HOME}`, `${USER}`, …).
- The GUI resolves the project root by looking for `.env` or `data/` in the
  current directory or its parents; set `WHOT_ROOT=/path/to/whot` to
  override (needed for release bundles started outside the repo).

```sh
npm install
mkdir -p ../insightface && python3 -m venv ../insightface/insight_env
../insightface/insight_env/bin/pip install insightface onnxruntime opencv-python-headless rawpy blake3 numpy
```

## Import a roll

```sh
../insightface/insight_env/bin/python scripts/import_roll.py <roll-dir>
```

Flags: `--dry-run` (detect only, no writes), `--all` (also import faceless
images), `--recursive`, `--cpu` (skip the MIGraphX GPU provider),
`--threshold F` (cosine similarity, default 0.40).

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
(cd src-tauri && cargo test)    # Rust integration tests (fixture DB built from database/schema.sql)
npx tsc --noEmit                # TypeScript
npm run lint                    # ESLint (incl. react-hooks rules)
python3 -m unittest discover -s test   # importer unit tests (needs numpy only)
```

Note: `cargo test` compiles the Tauri context, which embeds `dist/` — run
`npm run build` once first on a fresh clone.

## Docs

- `AGENTS.md` — agent conventions (branching, versioning, testing)
- `docs/gui-design.md` — GUI design document (versioned)
