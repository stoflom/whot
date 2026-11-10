# WhoT Backend Design — Rust / Tauri

**Version: 1.18** (#278) (major.minor per `AGENTS.md`; major = new feature,
minor = change/correction)

This document describes the **current state only** — no change
history, no was-broken narratives. Revision history lives in the GitHub
issues; the version above is bumped with every change and referenced in
the closing comment of the issue(s) it implements.

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
  importer.rs # spawn/monitor/kill import_roll.py, scan_import_dir
src-tauri/tests/
  workflow.rs  # integration tests against a fixture DB built from schema.sql
  importer.rs  # arg building, scan, real child-process lifecycle
```

- **`lib.rs`** holds one `#[tauri::command]` fn per operation; each is a
  one-liner: resolve `Paths` from `AppState`, delegate to `db::*`,
  map the error to `String` (Tauri's error channel). No SQL, no logic.
  The full command list with signatures is in `README.md` — the code
  (`generate_handler![]` list) and the README must agree.
  #218: every DB-backed / heavy command is declared `async fn` so Tauri
  runs it on the async runtime's thread pool instead of the UI main
  thread (argument shapes and TS-side `invoke` calls are unchanged; the
  runner-mutex/config-file exceptions are guarded by the
  `commands_run_off_the_main_thread_218` workflow test).
  #219: every mutating command returns a `db::Delta` (the touched
  rows + the new change stamp) instead of `()`/`i64` — the GUI applies
  the diff locally instead of re-fetching the whole snapshot. Read-only
  commands (`get_snapshot`, `get_refcrops`, `get_image_batch`, …) and
  the config-only `get_settings`/`set_settings` are unchanged.
- **`db.rs`** owns every query and every rule implementation. If a
  behaviour question arises, `db.rs` + gui-design §4 are the answer;
  nothing may embed SQL elsewhere (`main.rs` included).
- **`AppState`** carries `paths: Result<Paths, String>` — resolution
  happens once at startup; until it succeeds every command fails with
  the resolution error instead of panicking. It additionally carries the
  `import: Mutex<ImportState>` slot (§7 below).

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
   joined onto the root. `Paths` keeps the resolved `root` itself
   (the importer locates `scripts/import_roll.py` and sets the child
   process's cwd there).

GUI settings are **not** in the database: `get_settings`/`set_settings`
read and write `config/whotrc.json`
(`{cluster_threshold, refcrop_n, face_filter, cluster_group,
merge_name_distance, merge_suffix_aliases, image_viewer,
directory_viewer}` with defaults
`0.40 / 5 / "all" / "accuracy" / 2 / [] / "" / ""`), creating it on
first write. `image_viewer` / `directory_viewer` (#273) override the
opener plugin's system default for the *Open in system viewer* /
*Open roll path* entries (gui-design §3); empty means "system
default".
A legacy `show_rejected` key is ignored (unknown field — the setting
is the 4-state `face_filter`, gui-design §4.10).

## 3. Connection & schema gate

- `connect()` opens SQLite with `foreign_keys = ON` and immediately runs
  `check_schema`: exact match against `SCHEMA_VERSION` (currently
  `'1.9'`, equal to `database/schema.sql`'s marker row) — a mismatch is
  refused: a stale `'1.6'` marker is pointed at
  `scripts/fix_status_groups.py` (gui-design §4.35), anything else
  at recreate instructions; never worked around (no
  migrations; `docs/schema-design.md` §5).
- The derived-state machinery of `db.rs` (names, primaries, refcrops)
  additionally owns the **status seats** and the **`RejectedN`
  cluster-person family** (#266) — behaviour rules in gui-design §4.35; both are
  writer-maintained like the rest of the derived state (no triggers,
  schema-design §4). The legacy single bin `Rejected` is retired by the
  one-shot idempotent split that rides the reject writers.
- Reads that only need one row batch use short-lived connections;
  mutations open one connection, run **one transaction** and commit.
- All connections set `PRAGMA foreign_keys = ON` explicitly — the DDL's
  `PRAGMA` only affects the session that created the file.

## 4. Mutation machinery

Every mutating command follows the same shape (gui-design §4.8):

1. **validate** (name rules, group-path rules, membership preconditions)
   — fail with a message string before touching anything;
2. **mutate** the core rows in one transaction — batch-shaped, not
   per-row: seq assignment runs as one `UPDATE … FROM` statement per
   `(person, description_key)` group (base `MAX(seq)` + `ROW_NUMBER()`
   in id order, gap-proof F5 semantics preserved), and person
   existence checks are one up-front `IN (…)` fetch, not a per-id
   `COUNT(*)` in a loop (schema v1.9, #220);
3. **maintain derived state** for every affected person, still inside
   the transaction: `refresh_person_names` (§4.7 name derivation, one
   UPDATE, #210),
   `backfill_primary` (§4.5 machine rule when the slot is empty or
   stale), `recompute_refcrops` (§4.6 per-appearance top-N, `pinned`
   rows keep their `seq` slots, compare-and-skip — identical rows are
   never rewritten, #210);
4. commit; the command returns a `Delta` (#219) — the touched rows plus
   the new change stamp — which the GUI applies locally. The delta is
   built AFTER the commit by `delta_after()`: person rows for the
   affected persons (with counts/groups), all faces of any person whose
   names were re-derived (`refresh_person_names`), the directly-touched
   face/image rows, and any removed person ids. `delta_after()` reads
   the stamp before (`v1`) and after (`v2`) the write; `v2 > v1 + 1`
   means an external write (importer) interleaved and the delta is
   flagged `drifted` — the GUI then falls back to a full
   `get_snapshot()`. A full snapshot is still used for cold load, the
   focus/visibility reload (`get_data_version` gate), and import
   completion.

The stale-shell sweep (gui-design §4.27) rides the writers that can
empty a person — `snapshot()` itself is a pure read (#208).

**Read-modify-write atomicity:** the rotation commands
(`rotate_image`, `rotate_images`, `rotate_face`) read a `rotation` column
and write back `current + delta`. The read and the write stay in **one
deferred transaction** (#249): `rotate_face`'s old bare `query_row` +
`execute` left a lost-update window — a concurrent importer write landing
between the read and the update was silently overwritten (the `rotation`
column is the geometric key the importer lands harvested angles in,
§7). A deferred tx that reads then writes instead fails with
`SQLITE_BUSY` on a stale snapshot, so the update is never lost silently.

Helpers: `affected_persons()` collects the person ids a mutation
touched (before *and* after — moves have an origin and a destination),
`recompute_person()` is the per-person bundle of steps 3. Helper SQL is
built with `ids_list()` for `IN (…)`, so id lists never interpolate user
text. `ids_list()` takes a **non-empty** slice — an empty one would emit
`IN ()` (invalid SQL), so every caller guards and a `debug_assert!` makes
the contract loud in test/debug builds if a future caller forgets (#249).

**NULL-safety contract:** derived-state queries must tolerate absent
derived values (`primary_face_id IS NULL` on a fresh or harvested
person) — see `docs/schema-design.md` §5.

## 5. Reads & blobs

- `snapshot()` is the one big read: persons (+groups, counts), faces,
  images, imports in a single query pass — the frontend re-fetches it
  wholesale after every mutation. It is **pure** (#208): the stale-shell
  sweep (gui-design §4.27) rides the writers that can empty a person
  (assign/merge, reject-moves); named persons are never swept.
- Image/face content lives in the DB as BLOBs and leaves as **raw
  bytes** (#212): `get_image_batch` answers one framed `WHOTIMG`
  container per call (`tauri::ipc::Response` → ArrayBuffer → Blob URLs
  in the webview), the frontend coalesces each render-commit's image
  requests into one call per kind and caches the URLs by
  `face_id`/`image_id` (content is immutable; per-kind LRU caps revoke
  evicted Blob URLs). The batch's two passes (lengths, then bytes) run
  in **one read transaction** — a single snapshot, so a concurrent
  importer commit can't land between them and misalign the frame
  offsets (the importer is a separate process; the pool mutex only
  serialises in-process commands, #245). `get_refcrops` derives its
  filenames at read from the face and carries no pixels (rows are
  metadata since schema v1.8, #210) — the detail strip loads crops
  through the same pipeline. `open_image` is the exception (#268): it
  first resolves the image's **recorded locations** — `images.primary_path`
  then the `image_paths` alias set — and hands the **first path that
  exists on disk** to the opener plugin. Only when none exists does it fall
  back to writing `images.preview` to a unique, magic-sniffed temp file and
  handing that to the opener plugin, returning a short status string the
  frontend surfaces as a quiet info toast (gui-design §3).
- `person_face_clusters` computes, per appearance group, single-linkage
  clusters around the primary face (gui-design §4.9) — read-only
  display aid, threshold from the caller (default 0.40). Results are
  cached per `(db, person, threshold)` behind the input fingerprint
  (#211); the cache is **LRU** (#249) — a full clear on the 257th
  distinct key degenerated to recompute-every-time once more than 256
  persons were browsed, so the coldest entry (least-recently-used) is
  evicted instead and the hot set is retained.

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

## 7. Import runner

Behaviour rules: gui-design §4.36. Structure:

- **`importer.rs`** owns everything process-related; no SQL, no Tauri
  types beyond what the commands need.
- **`ImportOptions { roll_dir, dry_run, all, reimport, gpu, threshold, recursive, create_db }`**
  (serde, camelCase over IPC) maps 1:1 onto the
  `import_roll.py` CLI; `build_args()` renders the flag vector
  (deterministic order: mode flags, `--threshold`, the directory) and
  refuses `create_db && dry_run` before anything spawns.
  `reimport` (#278, exposing the script's re-import pass — the
  per-image rules are gui-design §4.47) renders between `--all` and `--gpu` and is validated like the
  other combos: `reimport && create_db` is refused — the rework pass
  re-detects and re-links images whose `content_hash` is already in the
  database, so re-importing against a freshly created database would
  rework nothing by definition; the configuration is refused before any
  process spawns. A re-import with `--dry-run` stays legal (compute
  everything, write nothing).
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
  trigger — rolls live in sub-folders, so the walk is recursive;
  a one-level probe would misread them as empty).
- **`get_import_status(since)`** returns
  `{ running, killed, exit_code, next_since, lines }` — lines are the
  buffer slice `[since..]` (the GUI polls and appends; no event
  plumbing, the poll interval is 300 ms).

## 8. Testing

- `src-tauri/tests/workflow.rs` — integration tests build a fixture DB
  **from `database/schema.sql`** (never a committed binary DB), then
  exercise the `db::` functions end-to-end: assign/reject/primary/
  refcrop/group flows and their derived-state consequences.
- `src-tauri/tests/importer.rs` — arg building (flag order, the
  `--create-db`+`--dry-run` refusal), `scan_import_dir` over a temp tree
  (a level-2 image IS found — the walk is recursive),
  and a real child-process lifecycle against a stub script (start →
  `get_import_status` drain → exit code; kill → `killed`).
- Run with `(cd src-tauri && cargo test)`; the Tauri context embeds
  `dist/`, so `npm run build` once on a fresh clone first (README
  § Tests).
- Python-side behaviour shared with the scripts (corpus/numbering
  rules) is covered by the `test/` suite; each side must pass before a
  commit (AGENTS.md).
- **GUI contract suite** (`test/gui-mock/`): `gui_check.py` runs
  against the mocked backend in **WebKitGTK** by default — the engine
  the Tauri app actually ships, so engine-specific rendering bugs are
  caught by the suite instead of a human — via
  `webkit_tester.py` (Selenium `Remote` → the system `WebKitWebDriver`
  binary, a `WebElement` subclass fixing WebKit's broken `getElementText`
  and its pre-dispatch occlusion check, one driver process per run — no
  leaked sessions). The suite's snapshot is **sanitized at dump time**
  (`test/gui-mock/README.md` → Sanitization): no personal names,
  surnames, notes or home paths survive, so the test corpus is sharable
  (the suite is corpus-agnostic: no check hardcodes a person or group
  name; C23 discovers its drag-drop scenario in the loaded snapshot).
  Firefox remains a supported choice (true headless):
  `WHOT_GUI_DRIVER=firefox` uses the personal firefox-testing skill,
  resolved from `WHOT_FIREFOX_SKILL` (default `~/.pi/agent/skills/
  firefox-testing`). WebKit has no headless mode — it needs a display
  (a desktop `DISPLAY`, or a **private virtual display** when the
  session is remote/idle: Xvfb, or Xvnc — `Xvnc :123 -geometry
  1600x1000 -depth 24 -SecurityTypes None` — since an idle
  GNOME/Xwayland compositor suspends `requestAnimationFrame` and the
  grid's incremental mount never grows); both drivers must pass
  before a commit.
