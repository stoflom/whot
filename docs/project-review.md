# WhoT Project Review

**Version: 1.0** · 2026-10-15 · reviewer: agent (pi)
**Scope:** whole repository at `dev` (= `main` @ `c1f0497`): schema, importer,
Rust backend, React frontend, tests, docs, versioning, build/tooling.
**Method:** full source read, `cargo test --lib` ✔, `npx tsc --noEmit` ✔,
`cargo clippy` (2 minor warnings), targeted SQLite repros for suspected bugs,
`git log --all -- .env` check (`.env` was never committed ✔).

This document is a review artifact, not a design document; `docs/gui-design.md`
stays the governing design. Findings are numbered F1… for filing as issues.

---

## Executive summary

The project is in good shape for its stage: a coherent design doc, a clean
transactional mutation layer in Rust, sensible import-failure isolation, and
working test/typecheck suites. No secrets in git history.

However, **five correctness bugs** were confirmed (three with executable SQL
repros) — two of them silently corrupt user data (refcrop pins, group paths)
and one leaves a rejected face as a person's primary icon. The test suite
cannot run on a fresh clone (it copies the local, gitignored `data/faces.db`),
there is no linting or CI, and README/versioning have concrete errors
(import command as documented fails; bundled app version is `0.1.0` while the
design/app version is `1.0`).

Recommended before any new features: fix F1–F4 (data corruption / crash),
add a fixture-based test DB (F8), correct README + versions (F9, F10).

---

## High severity

### F1 — Manual refcrop pins are destroyed by the next recompute  *(bug, backend)*

- **Where:** `src-tauri/src/db.rs` → `recompute_refcrops()`;
  `person_refcrops` has `UNIQUE (face_id)` (database/schema.sql).
- **What:** recompute deletes non-`pin:` rows, then `INSERT OR REPLACE`s the
  auto top-N rows. When a **pinned** face is also in the top-N (the common
  case — pins are usually high-confidence), the insert conflicts on the global
  `UNIQUE(face_id)` constraint, so REPLACE **deletes the pin row** and
  re-inserts it as an auto row. The `pin:` prefix is gone, so on the *next*
  recompute the row is treated as auto and deleted outright.
- **Evidence:** reproduced in SQLite: after one recompute the row
  `(person 1, face 11, 'pin:')` became `(person 1, face 11, '')`.
- **Design conflict:** gui-design §4.6 "manual rows … survive recomputation".
- **Note:** `db.rs::tests::full_workflow` step 5 *claims* "manual pin survives
  rebuild" but never runs a recompute for that person after `add_refcrop` —
  the test passes without exercising the claim.
- **Fix:** exclude pinned faces from the auto-selection query
  (`AND NOT EXISTS (SELECT 1 FROM person_refcrops pr
  WHERE pr.person_id = f.person_id AND pr.face_id = f.id
  AND pr.description LIKE 'pin:%')`), or make the auto insert
  `INSERT OR IGNORE`/upsert keyed so it can never evict a `pin:` row. Add a
  regression test that recomputes *after* pinning (ideally pinning a face
  inside the top-N).

### F2 — Assigning to an existing person clobbers their group path  *(bug, backend/design)*

- **Where:** `db.rs` → `assign_person()` — `DELETE FROM person_groups` runs
  for the target unconditionally; dialog prefill in `App.tsx`
  (`dialogPrefill`) and section rules (`FaceGrid` `ruleDefault*`).
- **What:** when the chosen name resolves to an **existing** person, the
  target's group rows are still replaced by whatever the group field holds —
  which is prefilled from the *source* `UnknownN` (typically `Unknown`), or is
  empty when the selection spans multiple clusters. Result examples:
  - assigning faces to existing "Alice" from an Unknown3 section sets Alice's
    group to `Unknown` → Alice now sits under the **Unknown** tree branch;
  - an empty group field silently moves Alice to **Ungrouped**.
- **Design conflict:** §4.1 specifies group replacement only for
  rename-in-place / new-person; the move-to-existing-person case says nothing
  about touching the target's groups.
- **Fix:** only replace `person_groups` in the rename-in-place/new-person
  branches; for an existing target keep its group (and prefill the dialog with
  the *target's* group once the name matches an existing person).

### F3 — Rejecting a person's primary face does not reassign the primary  *(bug, backend)*

- **Where:** `db.rs` → `backfill_primary()` (first UPDATE).
- **What:** the stale-primary condition checks only `state != 'discarded'` and
  ownership — **not** `link_status`. Rejecting the current primary leaves it
  as `primary_face_id`: the person's tree avatar / detail avatar keeps showing
  a rejected face, violating §4.2 ("rejected faces … excluded from
  primary-face eligibility").
- **Evidence:** reproduced in SQLite — after
  `UPDATE faces SET link_status='rejected' WHERE id=10`, both backfill UPDATEs
  run verbatim and `primary_face_id` stays `10`.
- **Related:** the comment says it "mirrors `import_roll.assign_missing_primaries`",
  but the two already differ: the Rust second UPDATE excludes
  `link_status='rejected'`, the Python one doesn't. Pick one rule
  (exclude rejected) and apply it in both.
- **Fix:** add `AND (SELECT link_status FROM faces f WHERE f.id = persons.primary_face_id) != 'rejected'`
  to the unpin condition; mirror the same predicate in the importer.

### F4 — Conditional React hooks crash the app  *(bug, frontend)*

- **Where:** `src/components/PersonTree.tsx` → `PersonRow`
  (`const img = person.primary_face_id ? useFaceImage(...) : null`) and
  `src/components/DetailPane.tsx` → `PersonView` (same pattern).
- **What:** classic rules-of-hooks violation. When `primary_face_id`
  transitions `null ↔ value` between renders (e.g. a person gains/loses their
  first primary after a mutation), React throws *"Rendered fewer hooks than
  expected"* and the whole tree unmounts — no error boundary in the app.
- **Why undetected:** there is no ESLint (`eslint-plugin-react-hooks`) in the
  project.
- **Fix:** call the hook unconditionally and guard the result:
  `const img = useFaceImage(person.primary_face_id ?? 0)` with a null-safe
  loader, or split into a child component rendered only when
  `primary_face_id != null`. Add ESLint with the hooks rules (F13).

---

## Medium severity

### F5 — Face `seq` collisions produce duplicate names within a person  *(bug, backend)*

- **Where:** `db.rs` → `assign_person()` (`COUNT(*) + 1`) and
  `scripts/import_roll.py` → `assign_seq()` (same pattern).
- **What:** `COUNT(*)+1` assumes contiguous seqs. Faces moving **out** of a
  person leave gaps; a later face moved **in** gets `count+1` that can equal
  an existing seq → after `refresh_person_names`, two faces share the same
  derived name (design §4.7 "labels stay unique within a person"). The
  importer has the same flaw when adding to a person the GUI has moved faces
  out of.
- **Evidence:** reproduced in SQLite — Alice keeping seqs {1,3} receives a new
  face assigned seq 3 → two `Alice-3`.
- **Fix:** `SELECT COALESCE(MAX(seq),0)+1` per (person, description) in both
  writer and GUI (MAX is gap-proof); or renumber on move.

### F6 — "Person" tab never switches to the person view  *(bug, frontend)*

- **Where:** `src/App.tsx` — the Person nav button's `onClick` is
  `() => setImageId(null)`; it never calls `setView("person")`.
- **Repro:** select a person → click *Rolls* → click *Person*: the center pane
  stays on the rolls list (button even highlights as active when
  `view === "person"` is false — so it shows inactive while enabled).
- **Fix:** `onClick={() => { setView("person"); setImageId(null); }}` (guard
  already exists: button disabled when `personId == null`).

### F7 — Detail-pane rename leaves an `UnknownN` person under the Unknown branch  *(bug/design gap, frontend+backend)*

- **Where:** `db.rs` → `set_person_name()` vs `assign_person()`.
- **What:** renaming via the detail pane does not touch `person_groups`, so
  the person keeps the importer's `Unknown` group path while its *name* no
  longer starts with `Unknown`. `PersonTree.buildTree` then files it under the
  `Unknown` branch (group-path branch and virtual branch share the name) —
  the user renamed it, yet it still looks unknown. `assign_person`'s
  rename-in-place does replace groups; the two rename paths disagree.
- **Fix:** on rename of an `Unknown*` person, drop the `Unknown` group row
  (or move it to Ungrouped), matching §4.1 semantics.

### F8 — Test suite cannot run on a fresh clone; no importer tests; convention drift  *(test)*

- `db.rs::tests::temp_paths()` copies `CARGO_MANIFEST_DIR/../data/faces.db` —
  gitignored local data. On CI/fresh clone `std::fs::copy(...).unwrap()`
  panics; on this machine the test's expectations depend on the user's data
  (`"test data needs a multi-face person"`).
- `scripts/import_roll.py` has **zero** tests, despite the tricky, issue-tagged
  logic (`#45` unknown numbering, `#46` non-numeric names, `#47` per-image
  rollback) being exactly what unit tests are for (pure functions:
  `associate`, `_next_unknown_number_for`, `load_env`).
- AGENTS.md: "Tests reside under an appropriate `test/` subdirectory" — there
  is no `test/` dir; Rust tests are inline (acceptable if documented, but
  currently a deviation).
- **Fix:** commit a small fixture DB generated from `database/schema.sql`
  with seeded persons/faces/embeddings (e.g. `test/fixtures/faces-small.db`
  or a builder that runs the DDL + inserts), point `temp_paths()` at it, and
  add Python tests for the pure functions. Also add the F1 regression test
  (recompute after pin).

### F9 — README: documented import command fails; venv story is inconsistent  *(docs)*

- `python3 -m venv insight_env` (README *Setup*) vs
  `.venv/bin/python scripts/import_roll.py …` (README *Import*) vs what the
  code does: `inject_insightface_venv` looks for
  `INSIGHTFACE_PATH/insight_env`, i.e. `../insightface/insight_env` with the
  shipped `.env`. Three different locations/names.
- `scripts/import_roll.py <roll-dir> <label>` — the script has **no `label`
  positional** (`--help` confirms only `roll_dir`); the documented command
  exits with *"unrecognized arguments: label"*.
- **Fix:** one venv path (create it where `INSIGHTFACE_PATH` points), drop
  `<label>` from the example, mention `--all/--recursive/--dry-run`.

### F10 — Application version is `0.1.0` in the bundle while design/app version is `1.0`  *(versioning, AGENTS.md)*

- `src-tauri/tauri.conf.json` `version: "0.1.0"` and
  `src-tauri/Cargo.toml` `version = "0.1.0"` vs `package.json`
  `"version": "1.0.0"` and design doc **v1.0**. AGENTS.md requires the app
  version's `major.minor` to match the design doc.
- **Fix:** set both Tauri versions to `1.0.0` (then `1.0.1` etc. for the
  bugfixes below — see "Versioning proposal").

### F11 — Startup fails on a fresh clone / packaged build  *(robustness)*

- `Paths::resolve()` walks up until it finds **both** `.env` **and** `data/`.
  A fresh clone has neither (both untracked/gitignored) → hard error
  "could not locate project root (.env + data/) — set WHOT_ROOT" even though
  every value has a default. In a release bundle, `current_dir()` will never
  contain the repo's `.env` either; `WHOT_ROOT` is the only escape and is
  documented nowhere (only in a Rust doc comment).
- **Fix:** don't require `.env` (all keys have defaults); require only `data/`
  (or create it); document `WHOT_ROOT` in README; consider resolving relative
  to the executable for packaged builds.

### F12 — No way to see imports made while the GUI is open  *(ux/design)*

- The snapshot loads at startup and after *mutations* only (design §4.8).
  Running `import_roll.py` in a terminal while the GUI is open leaves the new
  roll invisible until the user happens to trigger any mutation — there is no
  refresh button and no refetch on window focus.
- **Fix:** a refresh button in the top bar + refetch on focus/visibility
  (`Tauri` window focus event or the `visibilitychange` DOM event). Design §4.8
  amendment → minor bump.

### F13 — No ESLint, no CI  *(tooling)*

- `tsc` and `cargo clippy` are the only static checks; nothing would have
  caught F4 (hooks) automatically.
- No `.github/workflows` — AGENTS.md's "suite run before each commit" is a
  manual/agent convention only.
- **Fix:** add `eslint` + `typescript-eslint` + `eslint-plugin-react-hooks`
  (and `npm run lint`); a minimal workflow running `tsc --noEmit`,
  `cargo clippy`, and the suites once F8 gives them a fixture.

---

## Low severity / notes

| # | Finding | Detail |
|---|---|---|
| F14 | **Dangling design references** | `database/schema.sql` header cites `database/database-design.md`; `import_roll.py` cites `scripts-design.md` — neither exists (only `docs/gui-design.md`). gui-design §6 cites `src-tauri/src/commands.rs` (commands actually live in `lib.rs`), §5 lists `remove_refcrop(person_id, seq)` (actual: `face_id`) and `get_image_preview → String` (actual: `Option<String>`). AGENTS.md says development is governed by design documents — referenced docs must exist or be dropped. |
| F15 | **`${HOME}`/`${USER}` never expand** | Both `load_env` (Python) and `parse_env` (Rust) substitute only keys defined *in `.env` itself*, never process env — so `DEFAULT_IMAGES_DIR=${HOME}/Pictures` stays literal. Harmless today because `ARCHIVE_DIR`, `DEFAULT_IMAGES_DIR`, `DIGIKAM_*`, `LR_*` are **referenced by no code** (dead config, also in `.env.sample`). Either add a process-env fallback in both parsers or remove the unused keys. |
| F16 | **No `busy_timeout`** | `connect()` sets WAL + `foreign_keys` only. If the importer (separate process) commits while the GUI holds a transaction, SQLite can return `SQLITE_BUSY` immediately on the Rust side (Python's `sqlite3.connect` defaults to a 5 s timeout; rusqlite to 0). Add `PRAGMA busy_timeout=5000`. |
| F17 | **`csp: null`** | `tauri.conf.json` app security sets no CSP. Fine for a local-only tool, but Tauri's own guidance is to ship an explicit CSP; cheap to add. |
| F18 | **`last_import_id` is never updated** | The importer only `INSERT OR IGNORE`s `image_paths` for already-known content, so `images.last_import_id` stays = first import forever (dead column), and an image re-scanned in a later roll appears only under its first roll (`RollsPane` filters `first_import_id`). Decide: update `last_import_id` on rescan, or drop the column. |
| F19 | **`assign_person` rejects duplicate ids** | `rows.len() != face_ids.len()` → a duplicated id yields the misleading error *"some selected faces no longer exist"*. The UI can't produce duplicates today (Set-based selection); still normalize with a `HashSet` first. The `ids_list` string-built `IN (…)` lists are type-safe (`i64`), so no injection — but parameter binding would be tidier. |
| F20 | **Snapshot scaling** | `get_snapshot()` re-serializes *all* persons (with 2 extra queries each — N+1), faces (incl. `x,y,w,h` the frontend never uses) and image rows after every mutation. Fine at ~10k faces; at archive scale expect noticeable churn. Keep in mind for a future optimization pass (single grouped query for counts, prune unused columns, or delta refreshes). |
| F21 | **Clippy noise** | 2 warnings: `Paths.root` never read; `if` with identical blocks in the `full_workflow` test (`db.rs:985`); plus a `chunks_exact(4)` style hint. Trivial cleanups. |
| F22 | **Design wording: name "collision"** | §4.1 says *"Name must be unique (backend error surfaced in UI on collision)"*, but the backend deliberately **merges** into the existing person (which matches the dialog's copy and is the better UX). Correct the design text (minor bump) rather than the code. |

---

## What works well (keep it)

- Mutations are single-transaction with derived state (names, primaries,
  refcrops) recomputed inside the same transaction — no partial updates.
- Import failure isolation (`#47`): per-image commits + rollback + stub
  cleanup means one bad file doesn't poison a batch; the run is recorded
  up-front.
- Content-hash (BLAKE3) dedup + `image_paths` multi-path tracking.
- Image serving from DB BLOBs with a promise cache keyed by id, and the
  "blobs never change" invariant documented where it matters (`api.ts`).
- WAL + foreign keys on in Rust; `UnknownN` numbering rules (`#45/#46`) are
  careful and documented in code.
- `.env` was never committed (verified across all refs) and is gitignored;
  `.env.sample` is now the committed template.
- Design doc is detailed, versioned, and generally matches the code — the
  mismatches found (F2, F3, F22, F14) are the exceptions.

---

## Suggested action plan

Order = risk reduction first; labels per AGENTS.md.

1. **Data-correctness batch** (dev branch, design minor bump **1.0 → 1.1** for
   §4.1/§4.2/§4.6 clarifications):
   F1 → F3 → F2 → F5 → F7 *(label: `bug`, `backend`)*,
   F4 → F6 *(label: `bug`, `frontend`)* — each with a regression test.
2. **Test infrastructure** (F8): fixture DB + Python unit tests for the pure
   import functions *(label: `test`)* — this unblocks CI.
3. **Docs & versions** (F9, F10, F14, F15): one README pass; set bundle
   version to `1.0.x`; remove/repair dangling doc references *(label:
   `docs`)*.
4. **Tooling** (F13, F21, F16, F17): ESLint, CI workflow, clippy cleanup
   *(label: `enhancement`)*.
5. **UX/robustness** (F11, F12, F18, F20): refresh button/focus reload,
   friendlier root resolution, `last_import_id` decision *(label:
   `enhancement`, `frontend`/`backend`)*.

**Versioning proposal:** design doc → **1.1** (behaviour clarifications from
step 1); app `major.minor` follows to **1.0.x** immediately (F10 fixes the
`0.1.0` mismatch without a design change), then **1.1.0** when the design
1.1 fixes land.
