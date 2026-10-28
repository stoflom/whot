# WhoT Backend Design — Rust / Tauri

**Version: 1.5** (#167: `importer` module — child-process runner for
`scripts/import_roll.py` + `scan_import_dir`; `Paths.root` exposed;
#169: the scan walks recursively and early-exits on the first image,
`IMAGE_SUFFIXES` back in exact parity with the script)
(major.minor per `AGENTS.md`; major = new feature, minor =
change/correction)

Split out of `docs/gui-design.md` (v3.16). Revision history lives in the
GitHub issues; the version above is bumped with every change and
referenced in the closing comment of the issue(s) it implements.

This document describes the **structure** of the Rust backend: module
layout, path resolution, the transaction/derived-state machinery and the
test setup. It does **not** restate behaviour rules — those are
normative in `docs/gui-design.md` §4 — nor the schema — see
`docs/schema-design.md` — nor the user-facing command reference, which
lives in `README.md` (§ *Tauri commands*).

## 1. Module layout

```
src-tauri/src/
  main.rs   # binary entry: tauri::Builder → lib::run()
  lib.rs    # #[tauri::command] surface + AppState; thin by design
  db.rs     # ALL SQL, embeddings math, derived-state maintenance
  importer.rs # #167: spawn/monitor/kill import_roll.py, scan_import_dir
src-tauri/tests/
  workflow.rs  # integration tests against a fixture DB built from schema.sql
  importer.rs  # #167: arg building, scan, real child-process lifecycle
```

- **`lib.rs`** holds one `#[tauri::command]` fn per operation; each is a
  one-liner: resolve `Paths` from `AppState`, delegate to `db::*`,
  map the error to `String` (Tauri's error channel). No SQL, no logic.
  The full command list with signatures is in `README.md` — the code
  (`generate_handler![]` list) and the README must agree.
- **`db.rs`** owns every query and every rule implementation. If a
  behaviour question arises, `db.rs` + gui-design §4 are the answer;
  nothing may embed SQL elsewhere (`main.rs` included).
- **`AppState`** carries `paths: Result<Paths, String>` — resolution
  happens once at startup; until it succeeds every command fails with
  the resolution error instead of panicking. It additionally carries the
  `import: Mutex<ImportState>` slot (#167, §7 below).

## 2. Paths & configuration

`Paths::resolve()` (mirrors `import_roll.py`):

1. `WHOT_ROOT` env var, if set — absolute override (required for
   packaged builds started outside the repo).
2. Else walk up from the cwd looking for a `.env` **file** or a `data/`
   directory (`.env` alone suffices — every key has a default, and a
   fresh clone has no `data/` yet).
3. Parse `.env` (`KEY=VALUE`, `${VAR}` references resolved against other
   `.env` keys first, then the process environment, 4 passes — same
   algorithm as the Python `load_env`s), then read `FACES_DB` (default
   `data/faces.db`) and `CONFIG_FILE` (default `config/whotrc.json`),
   joined onto the root. `Paths` keeps the resolved `root` itself (#167:
   the importer locates `scripts/import_roll.py` and sets the child
   process's cwd there).

GUI settings are **not** in the database: `get_settings`/`set_settings`
read and write `config/whotrc.json`
(`{cluster_threshold, refcrop_n, face_filter, cluster_group,
merge_name_distance, merge_suffix_aliases}` with defaults
`0.40 / 5 / "all" / "accuracy" / 2 / []`), creating it on first write.
A legacy `show_rejected` key is ignored (unknown field — §4.10 of
gui-design became the 4-state `face_filter` in #99).

## 3. Connection & schema gate

- `connect()` opens SQLite with `foreign_keys = ON` and immediately runs
  `check_schema`: exact match against `SCHEMA_VERSION` (currently
  `'1.7'`, equal to `database/schema.sql`'s marker row) — a mismatch is
  refused: a stale `'1.6'` marker is pointed at
  `scripts/fix_status_groups.py` (#165, gui-design §4.35), anything else
  at recreate instructions; never worked around (no
  migrations; `docs/schema-design.md` §5).
- The derived-state machinery of `db.rs` (names, primaries, refcrops)
  additionally owns the #165 **status seats** and the **system person
  `Rejected`** — behaviour rules in gui-design §4.35; both are
  writer-maintained like the rest of the derived state (no triggers,
  schema-design §4).
- Reads that only need one row batch use short-lived connections;
  mutations open one connection, run **one transaction** and commit.
- All connections set `PRAGMA foreign_keys = ON` explicitly — the DDL's
  `PRAGMA` only affects the session that created the file.

## 4. Mutation machinery

Every mutating command follows the same shape (gui-design §4.8):

1. **validate** (name rules, group-path rules, membership preconditions)
   — fail with a message string before touching anything;
2. **mutate** the core rows in one transaction;
3. **maintain derived state** for every affected person, still inside
   the transaction: `refresh_person_names` (§4.7 name derivation),
   `backfill_primary` (§4.5 machine rule when the slot is empty or
   stale), `recompute_refcrops` (§4.6 per-appearance top-N, `pinned`
   rows keep their `seq` slots);
4. commit; the frontend re-fetches `get_snapshot()` (no push channel).

Helpers: `affected_persons()` collects the person ids a mutation
touched (before *and* after — moves have an origin and a destination),
`recompute_person()` is the per-person bundle of steps 3. Helper SQL is
built with `ids_list()` for `IN (…)`, so id lists never interpolate user
text.

**NULL-safety contract:** derived-state queries must tolerate absent
derived values (`primary_face_id IS NULL` on a fresh or harvested
person) — see `docs/schema-design.md` §5 and issue #80.

## 5. Reads & blobs

- `snapshot()` is the one big read: persons (+groups, counts), faces,
  images, imports in a single query pass — the frontend re-fetches it
  wholesale after every mutation. It opens with the **stale-shell
  sweep** (gui-design §4.27, #84): zero-face `UnknownN` persons are
  deleted in the same transaction before the reads — leftovers no other
  code path revisits; named persons are never swept.
- Image/face content lives in the DB as BLOBs and leaves base64-encoded
  as data URLs (`face_preview`, `image_blobs`); the frontend caches by
  `face_id`/`image_id` and never invalidates (content is immutable).
  `open_image` is the exception: it writes `images.preview` to a temp
  file and hands it to the opener plugin (gui-design §3).
- `person_face_clusters` computes, per appearance group, single-linkage
  clusters around the primary face (gui-design §4.9) — read-only
  display aid, threshold from the caller (default 0.40).

## 6. Embeddings math

- `l2_vectors()` loads `face_embeddings.vector` BLOBs as little-endian
  `float32[dim]` and **re-normalises defensively** (schema says
  L2-normalised; a corrupt row degrades to a wrong similarity instead of
  a panic).
- `cosine()` is a dot product over the normalised vectors (identical
  maths to `import_roll.py`'s `associate` — same corpus rules, see
  gui-design §4.12).
- Matching runs in bulk per call; ~10k faces × 512 dims is trivially
  fast in f32 — no index, no precomputation, by design (gui-design §2).

## 7. Import runner (#167)

Behaviour rules: gui-design §4.36. Structure:

- **`importer.rs`** owns everything process-related; no SQL, no Tauri
  types beyond what the commands need.
- **`ImportOptions { roll_dir, dry_run, all, gpu, threshold, recursive,
  create_db }`** (serde, camelCase over IPC) maps 1:1 onto the
  `import_roll.py` CLI; `build_args()` renders the flag vector
  (deterministic order: mode flags, `--threshold`, the directory) and
  refuses `create_db && dry_run` before anything spawns.
- **`ImportState`** — the single `Mutex`-guarded slot in `AppState`:
  `idle`, or the child `pid`, start `Instant`, append-only line buffer
  (combined stdout+stderr, capped at `MAX_LINES = 5000`, oldest dropped)
  and the eventual `Option<i32>` exit code / `killed` marker. Two reader
  threads (stdout, stderr) push lines; `start_import` refuses while a
  live child exists (`an import is already running`).
- **Interpreter**: `WHOT_IMPORT_PYTHON` env var, else `python3`; script
  path `<root>/scripts/import_roll.py`, cwd `<root>` — the script
  resolves `.env`/DB itself from the project root, exactly like a
  terminal run (scripts-design §8).
- **`scan_import_dir(path)`** — a **recursive** walk (hidden directories
  skipped, bounded depth 32 against symlink cycles) over the script's
  exact `IMAGE_SUFFIXES`, **early-exit on the first image**: the GUI
  contract is a boolean `≥ 1 image anywhere beneath it` (the full count
  is never displayed, so a huge tree costs one hit), and the GUI treats
  `true` + no snapshot match as "not yet imported" (gui-design §4.36
  trigger; #169 — rolls live in sub-folders, a one-level probe misread
  them as empty).
- **`get_import_status(since)`** returns
  `{ running, killed, exit_code, next_since, lines }` — lines are the
  buffer slice `[since..]` (the GUI polls and appends; no event
  plumbing, the poll interval is 300 ms).

## 8. Testing

- `src-tauri/tests/workflow.rs` — integration tests build a fixture DB
  **from `database/schema.sql`** (never a committed binary DB), then
  exercise the `db::` functions end-to-end: assign/reject/primary/
  refcrop/group flows and their derived-state consequences.
- `src-tauri/tests/importer.rs` (#167) — arg building (flag order, the
  `--create-db`+`--dry-run` refusal), `scan_import_dir` over a temp tree
  (a level-2 image IS found — #169),
  and a real child-process lifecycle against a stub script (start →
  `get_import_status` drain → exit code; kill → `killed`).
- Run with `(cd src-tauri && cargo test)`; the Tauri context embeds
  `dist/`, so `npm run build` once on a fresh clone first (README
  § Tests).
- Python-side behaviour shared with the scripts (corpus/numbering
  rules) is covered by the `test/` suite; each side must pass before a
  commit (AGENTS.md).
