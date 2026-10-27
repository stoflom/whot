# WhoT Database Schema Design

**Version: 2.0** (major.minor per `AGENTS.md`; major = new feature, minor =
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
  Rolls view can group by run (#40: UTC, same clock as the scripts).
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
  one row per person is invariant** (#165, gui-design §4.35): the three
  status seats (`New`/`Accepted`/`Rejected`) are system-written
  fallbacks for unfiled/rejected state, so *zero rows* is impossible —
  `path` was already `NOT NULL`; what changed is that the "no group"
  state itself was designed away (writer-owned, asserted by the fix
  script, documented in the DDL).
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
code review. The #165 group invariant (§2) is writer-owned the same way:
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
- **v1.6 → v1.7 (#165)** changed no column — the upgrade is semantic
  (status seats, system person `Rejected`, writer-owned group
  invariant), so it ships as `scripts/fix_status_groups.py`: a one-off,
  backed-up, verified **in-place data fix** (the #122 live-upgrade
  precedent), not a migration framework — the app itself never migrates
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
  context that is later read as an integer (issue #80).

## 6. Embeddings & coordinates (storage side)

- `face_embeddings.vector` — little-endian `float32[dim]`, **L2-
  normalised**, `dim = 512` for `insightface:buffalo_l` (the `model`
  column versions the vector; a model change = new row per face, not an
  in-place rewrite). L2-normalisation makes cosine similarity a plain
  dot product — computed in Rust in bulk (backend-design §6).
- Rectangle coordinates are **pixel units** in the canonical decode
  space of `images.width/height` (`inversion` records the flip, if any;
  design #18). The DDL's `CHECK`s pin the state/status/orientation/
  inversion vocabularies so both writers (Rust and Python) fail loudly
  rather than store a surprise value.
- `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON` are set in
  the DDL itself (connection-time enforcement in Rust: backend-design
  §3).
