# WhoT Scripts Design — Python tooling

**Version: 6.0** (major.minor per `AGENTS.md`; major = new feature,
minor = change/correction)

This document describes the **current state only** — no change
history, no was-broken narratives. Revision history lives in the GitHub
issues; the version above is bumped with every change and referenced in
the closing comment of the issue(s) it implements.

Split out of `docs/gui-design.md` so each design document stays
focused. **Section numbers §8/§9** — code, tests and comments
cite them.


Covered here:

| Script | Section | What it does |
| --- | --- | --- |
| `scripts/harvest_legacy.py` | §8 | read-only archival harvester → staging DB |
| `scripts/import_harvested.py` | §9 | merge a staging DB into a **copy** of `faces.db` |

Not covered here (see their own documents):

- `scripts/import_roll.py` — roll import; behaviour rules in
  `docs/gui-design.md` §4 (esp. §4.12), usage in `README.md`.
- `scripts/annotation_snapshot.py` — annotation export/restore across a
  drop & recreate; usage in `README.md`.
- `scripts/fix_status_groups.py` — data fix: upgrades a
  v1.6 `faces.db` in place to the status-group layout (spec:
  gui-design §4.35, gate: schema-design §5).
- CLI console conventions shared by **all** scripts (startup header,
  status updates, `-q/--quiet`) — §10 below.

---

## 8. Legacy harvest — staging database

`scripts/harvest_legacy.py` is one self-contained script (the earlier
importers are archived under `scripts/legacy/`). It captures what the
archive already knows about **faces and persons** and writes it into a
**staging database it creates itself**. Importing that staging DB into
`faces.db` is the job of a *separate, later* script (§8.5) — the harvester
and `faces.db` never meet.

The three source families (each enabled by canonical name):

| Source | What is read | Canonical names |
| --- | --- | --- |
| darktable-style sidecars (`<image.ext>.xmp`) | MWG-RS face regions, `People|…` hierarchical tags | `sidecars-mwgrs`, `sidecars-catsets` |
| Lightroom catalog (`.lrcat`) + Lightroom's own sidecars (`<stem>.xmp`) | person keyword tree, face regions (`userPick` kept as a flag), MWG-RS regions + `People|…` tags | `lightroom-catalog`, `lightroom-sidecars` |
| digiKam core + recognition databases | tag paths (group info), face rectangles (`tagRegion`), identity names + UUIDs | `digikam-core`, `digikam-faces`, `digikam-recognition` |

### 8.1 Invariants

- **H1 — sources are read-only.** Every external database is opened with
  SQLite `mode=ro` (`&immutable=1` for the `.lrcat`, which is checkpointed);
  sidecar files are opened for reading only. The archive
  (`/run/media/…/Seagate Expansion Drive`) is mounted strictly read-only;
  the harvester must never write there — or create WAL/SHM files next to a
  source DB.
- **H2 — `faces.db` is never touched.** Not read, not seeded from, not
  written. The only write target is the staging DB, created fresh per run
  (`O_EXCL` create; refusing to overwrite an existing file is an error).
  The one exception is an explicit `--resume` (§8.7), which reopens the
  staging DB a previous run created — still never `faces.db`, and never
  overwriting a recorded hash (they only ever move NULL → a value).
- **H3 — no image content is imported.** Images are not decoded,
  thumbnailled or copied. The harvester captures the **fs path of the
  image as the source states it**, plus any dimensions the source states
  (`images.width/height`). The one deliberate read of image bytes is
  hashing: whenever an image is **certainly** resolved — the sidecar's own
  sibling, an existing mapped catalog path, a digiKam reconstructed path,
  or a unique (basename, byte size) match — its **BLAKE3** hash is stored
  in `images.content_hash`, the same identity `faces.db.images` keys on,
  so the importer can match by content instead of by path. An ambiguous or
  absent resolution gets no hash, never a guessed one; `--no-hash` skips
  hashing entirely (e.g. a quick first pass over the archive). The tree
  walk that feeds digiKam's size-based resolution (§8.3) stats files only.
  The same certain-resolution gate also reads the file's
  **EXIF Orientation tag** (header metadata only — pixels are still never
  decoded) and stores the display rotation in `images.rotation` (CW,
  0/90/180/270; flip orientations 2/4/5/7 have no rotation expression and
  are stored as NULL, H4).
- **H4 — capture, not judgement.** Rows are stored as the source said, with
  provenance: canonical `sources.name`, the source's own reference where it
  has one (`faces.source_ref`, `person_refs.ref`), the source's own user
  confirmation where it records one (`faces.picked` — Lightroom `userPick`),
  and the harvest run (`harvest_run_id` → `harvest_runs.started_at`) on
  every captured row. No cross-source deduplication, no ambiguous guessing:
  an unresolvable image is counted in the run stats, never guessed.

### 8.2 Staging schema (`database/harvest_schema.sql`, v1.2)

Deliberately modelled on `faces.db` naming so the importer is a
translation, not a redesign — but without content: no `content_hash`, no
BLOBs, no embeddings, no link statuses (review decisions happen in the GUI,
after import).

- `harvest_runs(id, started_at, finished_at, sources, roots, stats)` — one
  row per harvest invocation; `sources`/`roots`/`stats` are JSON.
- `sources(id, name UNIQUE, kind)` — the canonical vocabulary above,
  `kind` ∈ `sidecars|lightroom|digikam`.
- `persons(id, name UNIQUE, created_at, harvest_run_id)`.
- `person_groups(person_id, path, source_id, harvest_run_id)` — `|`-paths
  (`People|Friends|Pelsers`), one leaf-name person per path, same shape as
  `faces.db.person_groups`.
- `person_refs(person_id, kind, ref, source_id, harvest_run_id)` — external
  identity references: digiKam recognition UUIDs, Lightroom keyword UUIDs
  (`keyword:<id_global>`).
- `images(id, path, path_origin, content_hash, name, file_size, source_ref,
  source_id, width, height, rotation, harvest_run_id)` — **one row per
  distinct image path as stated by a source**; `path_origin` records how
  the path was obtained: `source` (the source states it) or `name-size`
  (uniquely resolved against the scanned tree — digiKam's album-less
  images, §8.3). `content_hash` is the BLAKE3 of the file, set **only when
  the image was certainly resolved and read for hashing** (H3);
  `rotation` — the file's EXIF display rotation (CW 0/90/180/270), set
  under the same gate (H3); `name`/`file_size`/`source_ref` keep the
  source's own identifiers for the importer's matching.
- `faces(id, image_id, person_id, x, y, w, h, unit, img_w, img_h,
  source_id, source_ref, picked, harvest_run_id)` — corner-origin boxes as
  the source states them: `unit` ∈ `normalized|pixels` plus the source's
  image dimensions (`img_w/img_h`) when given. Normalised→pixel conversion
  is deferred to the importer, because only it will know the canonical
  decode dimensions (`faces.db` `images.width/height`).
  Lightroom's pixel rounding is banker's `round()` — contract, not choice,
  because the legacy keys were built on it. `UNIQUE(image_id, person_id,
  x, y, w, h, source_id)` dedupes digiKam's duplicate `Images` rows.
- **Rectangle-only capture (§9):** only faces *with geometry* are
  harvested — the import (§9) attaches persons by
  rectangle overlap, so presence-only rows (MPRI display names,
  digiKam/catset tag→image hits — the legacy `image_persons` table
  and `sidecars-mpri` source) are never recorded.
  Tag/catset paths still contribute `person_groups` (group info, §9.4).
- `schema_version(version, updated_at)` — single row `'1.2'`, exact-match
  check like `faces.db`; no migrations (AGENTS.md).

### 8.3 Image resolution (digiKam)

digiKam reconstructs an exact path only when `Images.album` is set (rare in
this archive: ~14k of ~145k rows). Where it is not, the harvester resolves
on **(basename, byte size)** against a stat-index of the `--images` trees —
never basename alone (basenames collide archive-wide). An ambiguous match
is counted and skipped, never guessed; the digiKam image id, name and size
stay in `images.source_ref/name/file_size` either way.

### 8.4 CLI

```
scripts/harvest_legacy.py --out STAGING.db \
    [--images DIR …] [--digikam-db P] [--recognition-db P] \
    [--lightroom-catalog P] [--lr-root 'D:/LIVE/=/mnt/…/LIVE' …] \
    [--sources sidecars-mwgrs,…] [--resume] [--list-sources] [--dry-run]
```

Defaults come from `.env` (`DEFAULT_IMAGES_DIR`, `ARCHIVE_DIR`,
`DIGIKAM_DB`, `DIGIKAM_RECOGNITION_DB`, `LR_CATALOG`, `LR_SIDECARS_DIR`);
without `--out` the staging DB is created as
`~/.cache/whot/harvest/harvest-<YYYYmmdd-HHMMSS>.db`. `--lr-root` maps a
catalog root onto disk, tried **in order** (map the live tree first), and
the *mapped* path is the path of record. `--dry-run` parses and counts
without writing anything at all; `--no-hash` skips the BLAKE3 reads (H3).
A rerun that should not re-read the images an earlier run already hashed
(e.g. after fixing a `--path-map`/`--lr-root`) reopens that run's staging
DB with `--resume` (§8.7).

### 8.5 Import hand-off

Merged into `faces.db` by `scripts/import_harvested.py` — full spec in
§9.

### 8.6 Path map & coverage reporting

Legacy sources state paths that no longer exist on disk (`D:/LIVE/…`,
old NAS roots). A **path-map file** rewrites such prefixes onto the
local archive — a *lookup aid only*: identity stays the BLAKE3 hash
(J2/H3), and an ambiguous or still-unmapped path is counted and logged,
never guessed (H4).

**File** (`PATH_MAP` in `.env`, or `--path-map FILE`; repeatable flag
for ad-hoc additions): one mapping per line, longest-prefix-first,
case-insensitive, forward/back slashes normalised, `#` comments and
blank lines ignored, plain prefix rewrite — **no globbing**:

```
# legacy root                       -> local root
D:/images/PicFiles                  = /run/media/stoflom/Seagate Expansion Drive/LIVE/PICTURES/PicFiles
D:/LIVE                             = /run/media/stoflom/Seagate Expansion Drive/LIVE
```

`parse_lr_roots` and the digiKam name-size resolution consult the map
exactly like `--lr-root` does today (same-order preference, mapped path
is the path of record); the map additionally seeds the resolution index
with its local roots.

**Coverage reporting (both scripts):** when a run's unusable share
exceeds **20%** — harvest: `lr_root_unmapped + dk_faces_resolved_unknown`
of all rows; import: `hash-missing + image-not-in-db` of `staging_faces`
— the run ends with a prominent, `stderr`, **never `-q`-suppressed**
warning block: the share in percent plus the **top unmapped
catalog roots / unresolved digiKam albums with one example path each**
(harvest) or the full stated path per unverifiable image, one line per
*image*, not per face. Unusable share and percentages also appear
in every final summary, quiet or not.

**Coverage attribution** — a deliberately scoped run must
not read as a catastrophe:

1. **Source tags** — every warning entry and every harvested
   `unmapped`/`unresolved` detail carries its canonical source name
   (`lightroom-catalog: …`, `digikam-faces: …`), so mixed blocks are
   attributable at a glance.
2. **Subtree breakdown** — unmapped rows sharing a root are grouped by
   the catalog subtree under that root with counts and one example each
   (`PICTURES/PicFiles/SourcePictures  9,696   e.g. D:/LIVE/…`),
   collapsing to the root itself when the root has no common subtree.
   Pure function, tested without a harvest.
3. **In-scope classification** — an unmapped LR row is *in scope* iff
   its basename appears in the resolution index built from the
   `--images` trees (classification only — never identity, never
   hashing; the catalog has no file size, so name-in-index is the
   signal). The **20% threshold counts only in-scope unusable rows**;
   out-of-scope rows are reported as informational context (`… of which
   out of scope`). When no index exists (digiKam-faces disabled) the
   split is omitted and the whole unusable set counts — stated in
   the warning.
4. **`!` exclude directive** — a path-map line starting with `!` marks a
   catalog prefix as deliberately ignored:
   `!D:/LIVE/PICTURES/PicFiles/SourcePictures`. Rows under it are
   counted `excluded` (own stat, never a warning), skipped before
   unmapped/missing accounting, and never rescued at import time. Same
   prefix rules as rewrites (longest-first, case-insensitive).

### 8.7 Resume — reuse recorded hashes

A harvest over a big archive is dominated by the BLAKE3 reads of image
bytes (H3). Re-running after fixing a `--path-map`/`--lr-root` — or after
taking delivery of new files — would otherwise re-read every image that
was already hashed. A **resume** run avoids exactly that.

`--resume` requires an explicit `--out` naming the staging DB of an
earlier run, and reopens it instead of creating a fresh one:

1. **Hash reuse.** Every `images` row whose **full path** already carries
   a `content_hash` is seeded into the hasher's path cache, so those
   files are **never opened again** — `hasher.hex()` answers from the
   cache. The summary reports the reused count as `hash_reused`;
   `hashed` counts only files actually read this run.
2. **Convergence.** Everything else is harvested normally. The staging
   writes are get-or-create / `INSERT OR IGNORE`, so an unchanged archive
   adds no rows; new files, previously ambiguous resolutions and fixed
   path mappings do. Hashes only ever move NULL → a value (`COALESCE`),
   so a resume can add a hash but never contradict or erase one.
3. **Provenance.** The resume is its own `harvest_runs` row (H4); rows
   already captured keep the `harvest_run_id` of the run that first saw
   them.
4. **Guards.** The file must exist and must be a harvest staging DB at
   the current schema version; `faces.db` remains refused outright (H2).
   Without `--resume` an existing `--out` stays an error (`O_EXCL`) — a
   resume is always explicit, never inferred from the file's existence.

## 9. Harvest import — attaching legacy persons to existing faces (v3.0)

`scripts/import_harvested.py` merges one harvest staging DB (§8) into a
**working copy** of `faces.db`. It is a *recovery* tool, not an import: it
never creates images or faces and never adds detections. It attaches the
persons the archive knew to the faces insightface already detected — as if
the user had assigned them by hand in the GUI (§4.1), just automatically
and in bulk.

### 9.1 Invariants

- **J1 — the original `faces.db` is never written.** The target is a fresh
  **vacuumed copy** (`VACUUM INTO` → `data/faces-YYYYmmdd-HHMMSS.db`), so
  the user can open the app against the copy (e.g. via a symlink) and
  decide whether to promote it. All report files are written next to the
  copy.
- **J2 — image identity is the BLAKE3 hash, exactly.** A harvested face
  participates only when its staging image's `content_hash` **equals**
  `faces.db images.content_hash`. No path or size fallbacks; staging rows
  without a hash (never certainly resolved, §8 H3) are report-only.
- **J3 — only faces with geometry.** The staging schema (v1.1) contains
  only rectangles (§8.2); the importer refuses any other staging version.
- **J4 — user work is untouchable by default.** Only faces that are
  `link_status='provisional'` **and** `state != 'discarded'` may receive a
  person. `--overwrite` makes every face eligible (the user's prior link
  is assumed invalid) but changes **only `person_id`** — no user entity is
  ever deleted, and their primaries/refcrops elsewhere are retained.
- **J5 — links stay provisional.** A face the script assigns gets
  `link_status='provisional'`, `reassigned=0`: the harvested link is a
  suggestion the user confirms in the GUI. Nothing is ever confirmed or
  rejected by the script.

### 9.2 Coordinate space

Harvested rectangles are converted into the canonical decode space of
`faces.db` before any overlap is computed: normalised boxes are multiplied
by `images.width/height` — the **decode** dims: `import_roll.py` stores
what the decoder returned, and cv2/rawpy **apply** the EXIF orientation,
so the canonical space is the *displayed* image (gui-design §4.29);
pixel
boxes (digiKam, Lightroom) are already in that same displayed space. If a
target image ever carries `inversion != 'none'`, the box is mapped through
the inverse flip (`lr`: `x' = W−(x+w)`; `tb`: `y' = H−(y+h)`) — kept
for the inversion case.

**stDim does not scale normalised boxes.** A normalised rectangle is a
fraction of the photo — scale-invariant — so scaling by the decode dims
places it in the canonical space; the source-stated `img_w/img_h` (stDim)
is kept in the staging record (H4 source-as-stated) but is a dead input to
the match (a differently-sized export of the same photo states the original
RAW dims, same hash J2 — scaling by it would mis-place the box).

**The transposed case is mappable.** The harvest reads the file's EXIF
display rotation under the H3 gate;
`convert_box` takes it as `rotation` and maps the box from **RAW (file)
space into the displayed space** before any inversion: normalised boxes
scale by the RAW dims — the db's decode dims with 90/270° swapped — and
then the corner-origin rectangle is rotated:

| rotation | mapping (W, H = RAW dims) |
|---|---|
| 90 CW  | `(x, y, w, h) → (H−y−h, x, h, w)` |
| 180    | `(x, y, w, h) → (W−x−w, H−y−h, w, h)` |
| 270 CW | `(x, y, w, h) → (y, W−x−w, h, w)` |

The same math is implemented once for the GUI (`src/rotation.ts`).
The angle is also **landed on the matched `faces.db` image** —
`UPDATE images SET rotation=… WHERE rotation=0` — first write wins, so a
rotation the user already set in the GUI is never overridden. The
hash-match that gates the import (J2) guarantees the file whose EXIF was
read is byte-identical to the one the db image displays.

### 9.3 Matching — the per-face claim model

`overlap = |A∩B| / |A∪B| ≥ --min-overlap` (default **0.50**, configurable — the 0.50–0.60 near-miss band of the
2026-10-22 run was dominated by cross-tool rectangle disagreement on the
*same* face — legacy tools draw looser/tighter boxes than insightface —
and every assigned link stays `provisional` (J5), so a more permissive
gate costs only extra suggestions to review. Below ~0.50 the band is
dominated by genuine no-counterpart cases, so it is not justified.)

**IoU is a face-identity test, never a ranking criterion**: ≥ threshold
means "this harvested rectangle and this whot face are the same physical
face". No IoU comparison ever decides *which person* a face belongs to —
with three overlapping sources a greedy best-IoU pass would pick an
identity winner with no basis (and a large loose rectangle can capture a
neighbouring detection). The loop is therefore **inverted** from v3.x:
iterate whot faces; per face gather **every** above-threshold claim
(sidecar MWG, digiKam tagRegion, Lightroom — all sources at once); decide
by **person-agreement**:

1. **whot face is linked** (`confirmed`/`rejected` — user work): keep
   whot as-is, the claims are ignored (J4, `status-protected`).
2. **whot face is `UnknownN` and all claims resolve to the same target
   person** (agreement per §9.4 — case-insensitive): link the face to
   that person, exactly as if the user assigned it; the link stays
   `provisional` (J5).
3. **whot face is `UnknownN` and claims resolve to different persons**:
   a face can only belong to one person — **log the disagreement**
   (every claimant with person, group, source, IoU and `picked`) and
   **leave the whot face untouched**. No contest is recorded in the DB
   (user decision): the log is the arbiter; the user re-assigns by hand
   if they want.

Consequences: several rectangles on one whot face are simply several
claims, deduped by agreement (rule 2) — a loose rectangle can add a
claim but can never override agreement or capture a neighbour silently;
whot's own overlapping duplicate detections each decide for themselves
(the duplication pre-exists, the import creates none); staging faces below threshold everywhere are `below-threshold` log
lines.
Only staging persons that **win at least one face** are created in the
copy — a contest-only claimant stays log-only, the whot data is left
as-is.

### 9.4 Person resolution

Per staging person with at least one accepted assignment:

- **Staging paths are keyword/tag paths** — by construction (§8) their **last segment is the person's own name**.
  They are translated to `faces.db` **group paths, which name the groups
  *above* the person, never the person itself** (gui-design §3/§4.1):
  1. strip the leading `People`/`Person` root segment (case-insensitive),
     then
  2. drop the **trailing segment when it equals the staging person's
     name** (the legacy leaf). An empty remainder means *no user group*
     — the group invariant applies: the person is **seated** instead
     (gui-design §4.35: `provisional` faces ⇒ `New`, else `Accepted`),
     never left without a `person_groups` row.

  `People|Family|Winnie Pelser` → `Family`; `People|Winnie Pelser` →
  seated (§4.35). A trailing segment that does *not* equal the person's name
  is kept as-is (defensive: paths are capture, §8 H4 — never guessed).
- Reuse an existing `faces.db` person **only** when its name matches *and*
  its group set matches the harvested set exactly (post-§9.4-correction
  sets — so a harvested `Winnie Pelser` with `People|Family|Winnie
  Pelser` correctly reuses a GUI person grouped `Family`). The script
  never guesses identity; otherwise it creates a new person
  (`state='imported'`) and the user merges later via the GUI's assign
  semantics (§4.1).
- **A faceless same-named person is a shell — the name is reusable.** When no name+group match exists, but a same-named
  (case-insensitive) person exists with **zero faces** (a faceless group
  import, or a person the GUI left empty), the harvested faces are
  linked to that person instead of minting an `X N` generation. The
  shell's own groups are kept and the harvested groups are *appended*
  (`INSERT OR IGNORE`, additive — the shell lands under the harvested
  groups). Precedence among several faceless same-named persons: exact
  spelling first, then lowest id (first-source order, the same fixed
  precedence as rule 1). A person whose faces are all *discarded* is
  **not** faceless — discarded faces are recoverable rows, and linking
  into a discarded cluster would resurrect identity by guesswork.
- **Agreement is case-insensitive.** Person-name and
  group-set comparisons `casefold`: `Winnie Pelser` = `winnie pelser` =
  `WINNIE PELSER`; `family|Smith` = `Family|Smith`. Only the *stored*
  spelling must be chosen, by fixed precedence — never synthesised:
  1. **whot wins** — a person/group matching case-insensitively already
     exists ⇒ reuse it, keep **whot's** capitalization (the user's
     spelling is never rewritten; existing derived labels untouched);
  2. **first source wins** — otherwise create new with the capitalization
     of the first source that stated it: deterministic = the **lowest
     staging `persons.id`** among the agreeing claims (staging ids are
     insertion-ordered, i.e. harvest load order: sidecars →
     recognition → digiKam → Lightroom).
  The folding is the importer's (Python `casefold`) — never SQL:
  `faces.db persons.name` UNIQUE and `=` are case-sensitive (SQLite
  BINARY), so `winnie pelser` and `Winnie Pelser` can legitimately
  coexist in whot today; a case-variant pair left by earlier runs is
  cleaned up by the user via the GUI, not by this script.
  The §9.8 own-generation recognition (`<name> N` + `state='imported'`)
  compares the same case-insensitively.
- On a name collision the new person gets the smallest free seq suffix:
  `Winnie Pelser 2`, `Winnie Pelser 3`, …

### 9.5 UnknownN cluster merge (follow-on to §9.3)

Per-face claims decide first (§9.3); the cluster rule is a **post-pass**
over the decisions, keeping the GUI group-assign semantics (§4.1):

- A cluster's decided faces all went to the **same** target **and no
  face of the cluster was contested** (§9.3 rule 3) ⇒ the cluster's
  *undecided* faces (no claim anywhere) move along too — as if the user
  had assigned the whole group — then the emptied UnknownN is deleted
  (stale shell, §4.13).
- Any **contested** face in the cluster ⇒ no co-move of undecided mates;
  the agreeing faces still moved individually, contested ones stay
  untouched (log, §9.3 rule 3).
- The current person is a real (user/importer) person, or no person
  (`person_id IS NULL`) ⇒ that face decides alone; an emptied person that
  is not an UnknownN is **never** deleted.

Every moved face is re-labelled like a GUI move (§4.7): `seq` becomes the
next free seq of its new `(person, description)` group and `name` is re-
derived. Housekeeping after moves (§4.5/§4.6 consistency): clear any
`persons.primary_face_id` that points at a moved face (`primary_pinned=0`)
and delete `person_refcrops` rows that reference a moved face under its
old person. No refcrop recompute runs — provisional faces are not refcrop
material (§4.6); the GUI recomputes on the next mutation.

**Primary backfill:** after the plan executes, the machine
rule of §4.5 (same statement as `import_roll.py`'s
`assign_missing_primaries`: highest-confidence, non-discarded,
non-rejected face, `primary_pinned=0`) fills every still-empty
`persons.primary_face_id` in the copy. The harvester-created persons
otherwise have no primary at all, and any caller that derives a boolean
from `primary_face_id` must still be NULL-safe — a person can legitimately
have no primary (all faces rejected/discarded); see
`docs/schema-design.md` §5.

### 9.6 Report

Every non-import is logged with reason and ids: `hash-missing`,
`image-not-in-db`, `degenerate-box`, `below-threshold`,
`already-claimed`, `status-protected`, `cluster-disagreement`. A JSON
summary plus a human-readable log are written next to the target copy.
No `imports` row is created — this is recovery, not an import; the log
files are the provenance.

**Reading `below-threshold`:** the counter counts **staging faces**,
not physical faces. The harvest records the same physical face once **per
source** (darktable sidecar, Lightroom sidecar, Lightroom catalog, digiKam),
and the same file can appear as several staging image rows (e.g. an old vs a current mount path — the duplicate-row mechanism). A single detected
face claimed by three legacy rectangles therefore yields up to **two**
below-threshold rows even when the match itself succeeded. In the
2026-10-22 run 2 045 rows sat below a 0.60 gate while the true
unique-face loss was a fraction of that — treat the counter as a triage
hint, never as lost-person evidence.

### 9.7 CLI

```
scripts/import_harvested.py STAGING.db [--faces-db data/faces.db]
    [--min-overlap 0.50] [--overwrite] [--dry-run]
```

`--faces-db` defaults to `FACES_DB` from `.env`. `--dry-run` runs the full
pipeline read-only (no copy, no writes anywhere; report to stdout).

## 10. CLI console contract — header, status, quiet

Every script must *show it is alive*: a header immediately on startup,
regular status output while it works, and a final summary — with a
`-q` / `--quiet` escape hatch for quiet runs.

### 10.1 Ordering guarantee

1. Parse arguments, line-buffer stdout.
2. Resolve cheap inputs (`.env`, path defaults) — milliseconds, file
   reads only.
3. **Print the header — before any operation that can take a moment**
   (model load, archive walk, `VACUUM INTO`, DB scan, export/restore).
   The header is the first output the script produces after argument
   parsing.
4. Work, with status updates.
5. Print the **final summary** — always, whatever the exit code
   (including error exits with partial results).

### 10.2 Header

A `=`×64 banner, the script name, optional key parameters (mode, input
paths, thresholds) and the UTC start time, closed by the
same banner. Printed **even with `-q`**.

### 10.3 Status updates

- Phase lines (`scanning …`, `found N files`, `[i/N] file`, `staging:
  …`) while work proceeds — suppressed by `-q`. The per-item line
  (`[i/N] file`) always carries the **full path** — never a
  basename — and carries it **once**: the verdict lines that follow
  (`no faces`, `imported: …`, `already in database — skipping`,
  `FAILED: …`) print the verdict only and never repeat that path.
  A diagnostic that does *not* follow a progress line — the closing
  failure list, standalone per-file warnings — keeps the full path, so
  it stands alone under `-q` or a split redirect. Applies to every
  script's output: `harvest_legacy`, `import_harvested` and
  `annotation_snapshot` print full paths and never repeat one after
  its progress line.
- **Heartbeat**: while a script is inside a long operation that prints
  nothing by itself (model load, corpus build, big walks, `VACUUM`),
  a background ticker prints `… <phase> — <N>s` at most every **10 s**,
  and only when nothing else was printed in that interval. Suppressed by
  `-q`. The ticker is a daemon thread, stopped before the summary.

### 10.4 Errors and warnings

Go to **stderr**, are never suppressed by `-q`, and never carry the
banner — the header/summary on stdout, diagnostics on stderr, so
`script.py … > log` still records the outcome and the log stays
governed by the shell redirect.

### 10.5 `-q` / `--quiet`

- Accepted by **all four scripts** (`add_argument("-q", "--quiet",
  action="store_true")`, same help text); `annotation_snapshot.py`
  accepts it before *and* after the subcommand.
- With `-q`: **only the header and the final summary are printed**
  (both on the normal output stream), plus anything that *is* the
  requested data (`annotation_snapshot export` JSON, `--list-sources`
  listing) — those are outputs, not status, and are never suppressed.
- Default (no flag): full status output as above.

### 10.6 Data channel vs console channel

`annotation_snapshot.py export` writes JSON to **stdout**; its console
output (header/status/summary) therefore goes to **stderr** — as does
the whole console channel of `restore`, so the script has one rule. All
other scripts print header/status/summary to **stdout**, errors to
stderr (§10.4).

### 10.7 Shared implementation

`scripts/cli_console.py` — one `Console` class (`header`, `status`,
`summary`, `error`, heartbeat `start_beat`/`stop_beat`) plus
`add_quiet_arg(parser)` so the flag is parsed identically everywhere.
A module-level default instance keeps the existing `log()` helpers in
`harvest_legacy.py` / `import_harvested.py` working unchanged for
library callers (tests); `main()` swaps in the configured instance.

### 9.8 Idempotent re-runs

Re-running the importer over data it already merged must **converge**,
not snowball (`X 2` → `X 3`, …). Three rules:

1. **Own-generation recognition** — the §9.4 reuse rule also matches a
   staging person against an existing person named `<staging name> N`
   (trailing ` N`, N ≥ 2) when that person has `state='imported'`
   (only this importer writes that state, gui-design §4.1) *and* its
   group set matches the harvested set exactly. The rename suffix stops
   being a wall: the importer finds the person its previous run
   created instead of minting the next suffix.
2. **Already-there moves are no-ops** — a resolved move whose db face
   is already attached to the resolved target person is dropped from
   the plan (`already-there` counter): no relabel, no `seq` churn, no
   derived-name rewrite. Faces a previous run moved stay exactly as
   that run left them. (Under §9.3 this falls out naturally: a face already linked to the
   resolved target is rule-2 agreement with nothing to do.)
3. **Importer-shell sweep** — after the plan executes, persons with
   `state='imported'` and **zero faces** (emptied by a later re-run,
   or left by an interrupted one) are deleted. Named/user persons
   (`state='created'`) are never touched.

A second identical run therefore reports `faces_moved=0`,
`persons_created=0`, `already-there=<previous moves>` and changes
nothing.
