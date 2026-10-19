# WhoT (Whos'that)

Face database and review GUI for photo rolls. Faces detected at import
(insightface) are stored with 512-d embeddings in a SQLite database; the GUI
is used to review, name, accept, reject and annotate them. Image files are
BLAKE3 hashed for identification, file paths are regarded as mutable.

This is still in very early stage. Future functionality will inlude:
  i) Script to export data to Lap asset management
  ii) Script to export person tag group hierarchy to darktable sidecars.

Recovering person/face knowledge from digiKam, Lightroom and darktable
sidecars is available today — see [Legacy recovery](#legacy-recovery-harvest--import).

## Components

| Part | Where | Notes |
|---|---|---|
| Schema | `database/schema.sql` | single source of truth; DB is dropped & recreated on schema changes |
| Roll import | `scripts/import_roll.py` | scans a roll, detects faces, clusters (single-linkage ≥ 0.40), writes `data/faces.db` |
| Legacy harvest | `scripts/harvest_legacy.py` | read-only scan of sidecars/Lightroom/digiKam into a staging DB (§8) |
| Harvest import | `scripts/import_harvested.py` | attaches harvested persons to existing faces in a **copy** of `faces.db` (§9) |
| Annotation snapshot | `scripts/annotation_snapshot.py` | export/restore manual annotations across drop & recreate |
| Staging schema | `database/harvest_schema.sql` | harvest staging DB, created by `harvest_legacy.py` |
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

## Scripts

### Import a roll

```sh
./scripts/import_roll.py "${ROLL_DIR}"
```

Flags: `--dry-run` (detect only, no writes), `--all` (also import faceless
images), `--recursive`, `--cpu` (skip the MIGraphX GPU provider),
`--threshold F` (cosine similarity, default 0.40).

Every cluster becomes an `UnknownN` person; all faces start `provisional`.

### Legacy recovery (harvest → import)

Recaptures work already done in legacy applications (digiKam, Lightroom,
darktable sidecars) by **attaching persons to the faces insightface has
already detected** — it never imports new images, faces or detections
(design `docs/gui-design.md` §8/§9).

Two steps, both safe by construction:

1. **`scripts/harvest_legacy.py`** scans the archival sources into a fresh
   *staging DB* it creates (never `faces.db`; sources are opened read-only).
   It captures faces **with rectangles**, person names, group paths, the
   source's own references, the harvest time and the image's fs path — and
   the **BLAKE3 hash** of every certainly-resolved image.
2. **`scripts/import_harvested.py`** merges that staging DB into a
   **vacuumed copy** of `faces.db` (`data/faces-<YYYYmmdd-HHMMSS>.db` — the
   original is never written). Harvested rectangles are matched to existing
   faces by IoU ≥ 0.60 (configurable) on images identified by **exact
   BLAKE3 equality**; `UnknownN` clusters are merged on unanimous evidence;
   links stay `provisional` for you to confirm in the GUI. Open the app
   against the copy (e.g. a symlink) and promote it only if you like the
   result. Every non-import is logged (`faces-*.import.log` / `.json`).

```sh
# 1) harvest (flags default to the .env input keys shown)
python3 scripts/harvest_legacy.py --out "${HARVEST_DB}" \
    --images "${DEFAULT_IMAGES_DIR}" --images "${ARCHIVE_DIR}" \
    --digikam-db "${DIGIKAM_DB}" \
    --recognition-db "${DIGIKAM_RECOGNITION_DB}" \
    --lightroom-catalog "${LR_CATALOG}" \
    --lr-root "D:/PICTURES/=${ARCHIVE_DIR}"

# 2) import — always dry-run first, then the real thing
python3 scripts/import_harvested.py "${HARVEST_DB}" --dry-run
python3 scripts/import_harvested.py "${HARVEST_DB}" \
    --min-overlap 0.60
```

Harvest flags: `--sources` (comma list of the canonical names printed by
`--list-sources`, default all), `--lr-root 'CATALOG=LOCAL'` (repeatable,
tried in order; maps the catalog's paths onto disk), `--dry-run` (parse and
count, write nothing), `--no-hash` (skip the BLAKE3 reads for a quick
first pass). Without `--out` the staging DB is created under
`~/.cache/whot/harvest/`.

Import flags: `--faces-db` (default `FACES_DB` from `.env`),
`--min-overlap` (IoU threshold, default 0.60), `--overwrite` (also touch
faces you already confirmed/rejected — they become provisional again),
`--dry-run` (full pipeline, no copy, no writes).

`test/archive-fixture/` (gitignored) holds a small hand-picked photo set
with real Lightroom/digiKam/darktable person data for trying the pipeline
end to end before pointing it at the full archive.

### Annotation snapshot

Preserves manual annotations (persons, groups, links, statuses,
descriptions, primaries, refcrops) across a `faces.db` drop & recreate.

```sh
python3 scripts/annotation_snapshot.py export "${FACES_DB}" > "${SNAPSHOT}.json"
python3 scripts/annotation_snapshot.py restore "${SNAPSHOT}.json" "${FACES_DB}"
```

Restore flags: `--iou F` (min rectangle IoU for fuzzy face matching after
a re-import moved boxes, default 0.75).

## Run the GUI

```sh
npm run tauri dev      # development
npm run tauri build    # release bundles
```

Main flows: rename an `UnknownN` group (accepts & names it, moving it into a
group path, e.g. family|Smith, friends|college), assign selected faces to an existing or new person, reject or
re-accept faces, per-face descriptions (beard|sun_glasses, baby, side), primary face, reference faces per-face descriptions.

## Tests

```sh
(cd src-tauri && cargo test)    # Rust integration tests (fixture DB built from database/schema.sql)
npx tsc --noEmit                # TypeScript
npm run lint                    # ESLint (incl. react-hooks rules)
python3 -m unittest discover -s test   # harvest + import unit tests (needs numpy + blake3)
```

Note: `cargo test` compiles the Tauri context, which embeds `dist/` — run
`npm run build` once first on a fresh clone.

## Docs

- `AGENTS.md` — agent conventions (branching, versioning, testing)
- `docs/gui-design.md` — GUI design document (versioned)
