# WhoT Backend Design — Rust / Tauri

**Version: 1.0** (major.minor per `AGENTS.md`; major = new feature, minor =
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
src-tauri/tests/
  workflow.rs  # integration tests against a fixture DB built from schema.sql
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
  the resolution error instead of panicking.

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
   joined onto the root.

GUI settings are **not** in the database: `get_settings`/`set_settings`
read and write `config/whotrc.json`
(`{cluster_threshold, refcrop_n, show_rejected}` with defaults
`0.40 / 5 / true`), creating it on first write.

## 3. Connection & schema gate

- `connect()` opens SQLite with `foreign_keys = ON` and immediately runs
  `check_schema`: exact match against `SCHEMA_VERSION` (currently
  `'1.5'`, equal to `database/schema.sql`'s marker row) — a mismatch is
  refused with recreate instructions, never worked around (no
  migrations; `docs/schema-design.md` §5).
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
  wholesale after every mutation.
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

## 7. Testing

- `src-tauri/tests/workflow.rs` — integration tests build a fixture DB
  **from `database/schema.sql`** (never a committed binary DB), then
  exercise the `db::` functions end-to-end: assign/reject/primary/
  refcrop/group flows and their derived-state consequences.
- Run with `(cd src-tauri && cargo test)`; the Tauri context embeds
  `dist/`, so `npm run build` once on a fresh clone first (README
  § Tests).
- Python-side behaviour shared with the scripts (corpus/numbering
  rules) is covered by the `test/` suite; each side must pass before a
  commit (AGENTS.md).
