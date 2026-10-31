# WhoT Database Schema Design

**Version: 2.1** (major.minor per `AGENTS.md`; major = new feature, minor =
change/correction)

Split out of `docs/gui-design.md` (v3.16). Revision history lives in the
GitHub issues; the version above is bumped with every change and
referenced in the closing comment of the issue(s) it implements.

The **DDL is normative**: `database/schema.sql` (faces.db) and
`database/harvest_schema.sql` (harvest staging). This document explains
the design decisions behind it — it never restates column lists; read the
DDL for those. Behaviour rules for what the columns *mean* during
operations are `docs/gui-design.md` §4; the harvest staging schema is
specified in `docs/scripts-design.md` §8.2 (not repeated here).

## 1. The two databases

| Database | DDL | Version row | Lifetime |
| --- | --- | --- | --- |
| `faces.db` | `database/schema.sql` | `'1.7'` | long-lived; **dropped & recreated** on structural schema change; semantic changes ship as a one-off data fix (§5) |
| harvest staging | `database/harvest_schema.sql` | `'1.2'` | created fresh by every `harvest_legacy.py` run; consumed once by `import_harvested.py` |

The harvester never touches `faces.db` (scripts-design §8 H2); the
importer writes only a **vacuumed copy** of it (scripts-design §9 J1).

## 2. faces.db — table roles

One line each; the DDL carries the columns.

- `imports` — one row per roll import; faces/images reference it
  (`first_import_id`/`last_import_id`, `detected_in_import_id`) so the
  Rolls view can group by run (UTC, same clock as the scripts).
- `images` — one row per distinct **content** (see §3); decode
  dimensions, state, orientation/inversion, thumbnail/preview BLOBs.
- `image_paths` — mutable paths as an *attribute set* of the image
  (paths are regarded as mutable; content is identity).
- `faces` — rectangle + lifecycle columns; `name`/`seq` are **derived**
  (§4); per-image rectangle is the face identity (§3).
- `face_embeddings` — one vector per `(face_id, model)`; storage in §6.
- `persons` — name is unique and **reserved** at the edges: `UnknownN`
  for importer clusters and the exact name `Rejected` for the system
  person (gui-design §4.35); optional
  `primary_face_id` (nullable — see §5) with `primary_pinned`.
- `person_groups` — `|`-paths, one row per membership; the person tree
  is *derived* from these paths (gui-design §3), never stored. **At least
  one row per person is invariant** (gui-design §4.35): the three
  status seats (`New`/`Accepted`/`Rejected`) are system-written
  fallbacks for unfiled/rejected state, so *zero rows* is impossible —
  `path` is `NOT NULL`; the "no group" state does not exist — the
  seat system is writer-owned, asserted by the fix script, documented
  in the DDL.
- `person_refcrops` — per-appearance reference images; `pinned` rows are
  manual and survive recompute (gui-design §4.6).
- `schema_version` — single row; the gate (§5).

## 3. Identities

- **Image identity = BLAKE3 content hash** (`images.content_hash`,
  UNIQUE, 64 hex). File paths are mutable and may collide across disks —
  `image_paths` records every known location, `primary_path` the first
  found. The harvest pipeline matches on the same hash
  (scripts-design §9 J2).
- **Face identity = `(image_id, x, y, w, h)`** (UNIQUE). Rectangle-only
  identity is what lets a re-detected or harvested rectangle re-attach to
  the same face (annotation restore fuzzy-matches with IoU on top of it).
- **Person identity = `persons.name`** (UNIQUE, case-sensitive like
  SQLite UNIQUE). Assigning to an existing name *merges*, never collides
  (gui-design §4.1) — the uniqueness is for reference, not for control
  flow.
- **Refcrop identity = `(person_id, description, seq)`**, with
  `face_id` UNIQUE across the table (a face is a refcrop of at most one
  person).

## 4. Derived state

Some columns exist for reading but are **owned by the writers**; every
mutating path re-derives them (gui-design §4.4/§4.5/§4.6/§4.7):

- `faces.name` = `person.name[-description]-seq`; `faces.seq` is
  per `(person, description)`.
- `persons.primary_face_id` — user picks pin it (`primary_pinned=1`);
  otherwise the machine rule (highest-confidence, non-discarded,
  non-rejected face) backfills an empty slot.
- `person_refcrops.*` — rebuilt per appearance group after any
  accept/reject/primary/description change; `pinned=1` rows are exempt.

No stored triggers: derivation lives in one place per writer
(`src-tauri/src/db.rs` for the GUI, `import_roll.py`/`import_harvested.py`
for the scripts), so the rules in gui-design §4 stay single-sourced in
code review. The group invariant (§2) is writer-owned the same way:
a stored trigger enforcing "≥ 1 row per person" would abort the writers'
replace-a-group sequences (delete-then-insert inside one transaction)
mid-flight — both writers seat instead, and the fix script asserts.

## 5. Version gate & drop & recreate

- `schema_version` holds **one row**; `version` is checked by **exact
  match** — there are **no migrations** (AGENTS.md). A mismatched or
  missing marker is refused up-front: a stale `'1.6'` marker is pointed
  at the data fix (`scripts/fix_status_groups.py`, gui-design §4.35),
  anything else at recreate instructions
  (`sqlite3 data/faces.db < database/schema.sql`), never on the first
  query.
- The expected value `'1.7'` is a constant in **five** places that must be
  kept equal: `schema.sql` (the `INSERT`), `src-tauri/src/db.rs`
  (`SCHEMA_VERSION`), `scripts/import_roll.py` (`SCHEMA_VERSION`),
  `scripts/import_harvested.py` (`FACES_SCHEMA_VERSION`);
  `scripts/annotation_snapshot.py` checks it too (`SCHEMA_VERSION`) for
  restore targets.
- **v1.6 → v1.7** changed no column — the upgrade is semantic
  (status seats, system person `Rejected`, writer-owned group
  invariant), so it ships as `scripts/fix_status_groups.py`: a one-off,
  backed-up, verified **in-place data fix**, not a migration framework — the app itself never migrates
  (AGENTS.md). The gate forces it: a v1.6 database is refused by a v1.7
  build until fixed. Fresh databases come from the DDL as always.
- Drop & recreate loses manual annotations by design — that is what
  `scripts/annotation_snapshot.py` (export before, restore after) is
  for; its matching keys are exactly the identities in §3.
- **Nullability contract:** `persons.primary_face_id` is nullable and
  queries must tolerate `NULL` (a person with no eligible face has no
  primary — freshly imported `UnknownN`s, harvested persons before GUI
  confirmation). Any expression derived from it must be NULL-safe
  (`IS NULL` / `COALESCE`), never bare `= (SELECT …)` in a boolean
  context that is later read as an integer.

## 6. Embeddings & coordinates (storage side)

- `face_embeddings.vector` — little-endian `float32[dim]`, **L2-
  normalised**, `dim = 512` for `insightface:buffalo_l` (the `model`
  column versions the vector; a model change = new row per face, not an
  in-place rewrite). L2-normalisation makes cosine similarity a plain
  dot product — computed in Rust in bulk (backend-design §6).
- Rectangle coordinates are **pixel units** in the canonical decode
  space of `images.width/height` (`inversion` records the flip, if
  any). The DDL's `CHECK`s pin the state/status/orientation/
  inversion vocabularies so both writers (Rust and Python) fail loudly
  rather than store a surprise value.
- `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON` are set in
  the DDL itself (connection-time enforcement in Rust: backend-design
  §3).

## 7. State model — transition tables

Every mutable fact in the app hangs off three state axes; together these
tables are the app's entire state surface — everything else in the DDL
(names, seq, descriptions, primaries, refcrops, rotation, embeddings,
BLOBs) is derived or immutable display data driven from them. The
headers carry the actual DDL column names: each table pairs the entity's
own state with its **link** — the image's `image_paths` set (append-only,
stateless), the face's `faces.link_status` (the face↔person link —
provisional/confirmed/rejected; no column is named `link_state`) — and
the person's `person_groups.path`. Behaviour behind the triggers is
gui-design §4 (esp. §4.35); `scripts/fix_status_groups.py` asserts the
invariants below.

All rows describe **committed** states: every mutation runs in one
transaction, so mid-transaction intermediates are never observable.
Legend: **✗** marks a **not-logical** combination — its trigger cell
gives the reason; every unmarked row is produced by the listed triggers.

### 7.1 images — `images.state` × `image_paths`

| images.state (1) | image_paths (1) | images.state (2) | image_paths (2) | transition triggers (1) → (2) |
| --- | --- | --- | --- | --- |
| — | — | `scanned` | {first path} | **roll import, ≥ 1 detection** — `INSERT INTO images` writes `state='scanned'` + the first path row (`plan_image`/`store_image`) |
| — | — | `no-face` | {first path} | **roll import, 0 detections** — born `no-face`, first write wins |
| `scanned` | P | `scanned` | P ∪ {p′} | **same content re-imported from a new path** — `INSERT OR IGNORE image_paths`, state untouched |
| `no-face` | P | `no-face` | P ∪ {p′} | same (paths are mutable, content hash is identity — §3) |
| ✗ `imported` | any | `imported` | — | **✗ NOT LOGICAL** — no writer passes the DDL default: every INSERT writes `scanned`/`no-face` — foreign/legacy rows only |
| ✗ `scanned` | any | `no-face` | — | **✗ NOT LOGICAL** — no writer flips state after birth (content identity: first import wins) |
| ✗ `no-face` | any | `scanned` | — | **✗ NOT LOGICAL** — same (no upgrade path exists) |

### 7.2 faces — `faces.state` × `faces.link_status`

| faces.state (1) | faces.link_status (1) | faces.state (2) | faces.link_status (2) | transition triggers (1) → (2) |
| --- | --- | --- | --- | --- |
| — | — | `detected` | `provisional` | **roll import INSERT** (`store_image`) — both columns born fixed: `state='detected'`, status starts `provisional` (new cluster, joined cluster or known-person match alike) |
| `detected` | `provisional` | `detected` | `confirmed` | **Accept** (§4.3); **Assignment/merge** (§4.1, person re-homes); **snapshot restore** applying a recorded `confirmed` |
| `detected` | `provisional` | `detected` | `rejected` | **Reject** (§4.2 — re-homes onto person `Rejected`); **Remove person** (§4.13); **restore** of a recorded-rejected face |
| `detected` | `confirmed` | `detected` | `rejected` | **Reject**; **Remove person**; **restore** of a recorded-rejected face |
| `detected` | `confirmed` | `detected` | `provisional` | **Harvest claim `--overwrite`** (forces `provisional`; person re-homes) |
| `detected` | `rejected` | `detected` | `provisional` | **Harvest claim `--overwrite`** — also moves the face *out* of the reject bin (claim-like) |
| `detected` | `rejected` | `detected` | `confirmed` | **Assignment = the claim** (§4.35 — the only GUI exit from `rejected`); restore of a recorded-`confirmed` face over a rejected one |
| `detected` | any | `detected` | recorded value | **Snapshot restore** (`annotation_snapshot`) — writes the recorded `link_status` + person move; recorded-rejected parks on `Rejected`; unmatched faces skipped |
| `detected` | `confirmed` | `detected` | `confirmed` | pair unchanged — **person re-homes** on assignment/merge; description/seq/name/rotation edits (derived/display only) |
| `detected` | `provisional` | `detected` | `provisional` | pair unchanged — **harvest claim of a provisional face** (status kept; person re-homes) |
| ✗ `imported`, `created`, `discarded` | any | same | — | **✗ NOT LOGICAL** — no writer ever sets `faces.state`; every INSERT passes `'detected'`; `discarded` exists only as a CHECK that eligibility filters tolerate (legacy/foreign rows) |
| ✗ any | — (NULL) | any | — | **✗ NOT LOGICAL** — `link_status` is `NOT NULL` (DDL): a face never exists without a link state |

### 7.3 persons — `persons.state` × `person_groups.path`

`persons.state` is set **once at INSERT** (`created` = roll import/GUI/
restore, `imported` = harvest) and never transitions — all later change
lives in the link column and in the row's existence.

| persons.state (1) | person_groups.path (1) | persons.state (2) | person_groups.path (2) | transition triggers (1) → (2) |
| --- | --- | --- | --- | --- |
| — | — | `created` | seat `New` | **roll import** mints an `UnknownN` (`ensure_person` seeds `New`) |
| — | — | `created` | seat-by-state / real path | **assignment creates a named person** — empty input ⇒ seat, given path ⇒ real |
| — | — | `imported` | real path / seat | **harvest import creates** (staging groups, else the §9.4 seat pass) |
| — | — | `created` | real path / seat | **snapshot restore creates** (recorded groups; groupless ⇒ seat pass) |
| — | — | `created` | seat `Rejected` | **system person created on demand** — first Reject/Remove person, the data fix, or restore |
| `created`, `imported` | seat `New` | `created`, `imported` | seat `Accepted` | **last provisional leaves** — Accept of it, reject-move/claim/harvest-claim takes it, or restore's seat pass |
| `created`, `imported` | seat `Accepted` | `created`, `imported` | seat `New` | **roll import matches** a new provisional onto a seated person (`store_image` re-seat) |
| `created`, `imported` | seat … | `created`, `imported` | real path P | **filing replaces the seat** — assign-with-path, *Move to group…*, *Add group…*, D&D |
| `created`, `imported` | real path P | `created`, `imported` | seat-by-state | **unfiling re-derives** — `delete_group` (last row), empty *Move to group…*, `rename_group → ""`, D&D-unfile |
| `created`, `imported` | real P | `created`, `imported` | real P′ | **`rename_group`/move prefix rewrite** — path value changes, still a real link |
| `created`, `imported` | any | — | — | **person deleted** — Remove person (§4.13), source emptied by assign/merge (§4.1 shell rule), sweeps (§4.27 `UnknownN`, harvest §9.8 `imported` shells, restore-end) |
| `created` | seat `Rejected` | `created` | seat `Rejected` | **emptied by claims** — kept (never swept), invisible outside `Show → Rejected`, reused by the next reject; state unchanged |
| ✗ `created`, `imported` | ∅ (no rows) | — | — | **✗ NOT LOGICAL** — group invariant: ≥ 1 `person_groups` row (writer-enforced; pre-seating databases are migrated by `fix_status_groups.py`) |
| ✗ — | a path on nobody | — | — | **✗ NOT LOGICAL** — orphan group row (FK `person_id → persons`) |
| ✗ `imported` | seat `Rejected` | — | — | **✗ NOT LOGICAL** — the system person is always `'created'`: harvest never mints the reserved name (`taken_cf` guard), restore/fix insert `'created'` |
| ✗ (row deleted) | any path | — | — | **✗ NOT LOGICAL** — group rows die with the person (`ON DELETE CASCADE`) |

### 7.4 Cross-table invariants (also asserted by the fix script / writer guards)

- `path = 'New'` on a person whose §7.2 faces contain **zero
  `provisional`** is not logical — seat derivation re-evaluates at every
  mutation (`reseat`), including harvest claims of the origin's faces.
- **Any non-rejected face on person `Rejected`** (`Rejected` +
  `confirmed`/`provisional`) is not logical — guarded in
  `ensure_rejected_person` (db.rs and annotation_snapshot), asserted by
  the fix script; the reserved name is un-mintable in the importer.
- **A user person named exactly `Rejected`** is not logical — reserved
  in `validate_person_name`; a legacy squatter fails loudly at the first
  reject/restore instead of being adopted.
- Snapshot of the v1.7-era live database (counts drift with use): 2084
  images all `scanned`; 4116 faces all `detected` — 1733 confirmed /
  1697 provisional / 686 rejected, all 686 on person `Rejected`;
  0 groupless persons, 0 unowned faces.

