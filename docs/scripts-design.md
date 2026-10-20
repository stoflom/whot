# WhoT Scripts Design — Python tooling

**Version: 2.0** (major.minor per `AGENTS.md`; major = new feature, minor =
change/correction) — v2.0: §10 CLI console contract (issue #79)

Split out of `docs/gui-design.md` (which covered these scripts as §8/§9 up
to v3.15) so each design document stays focused. **Section numbers §8/§9
are unchanged** — code, tests and comments cite them as they always have.
Revision history lives in the GitHub issues; the version above is bumped
with every change and referenced in the closing comment of the issue(s)
it implements.

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
- CLI console conventions shared by **all** scripts (startup header,
  status updates, `-q/--quiet`) — §10 below (issue #79).

---

## 8. Legacy harvest — staging database (v2.0)

`scripts/harvest_legacy.py` is one self-contained script that replaces the
legacy duo under `scripts/legacy/` (`import_common.py`, `import_harvest.py`
and the old review DB they were written against). It captures what the
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
- **H4 — capture, not judgement.** Rows are stored as the source said, with
  provenance: canonical `sources.name`, the source's own reference where it
  has one (`faces.source_ref`, `person_refs.ref`), the source's own user
  confirmation where it records one (`faces.picked` — Lightroom `userPick`),
  and the harvest run (`harvest_run_id` → `harvest_runs.started_at`) on
  every captured row. No cross-source deduplication, no ambiguous guessing:
  an unresolvable image is counted in the run stats, never guessed.

### 8.2 Staging schema (`database/harvest_schema.sql`, v1.1)

Deliberately modelled on `faces.db` v1.5 naming so the importer is a
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
  source_id, width, height, harvest_run_id)` — **one row per distinct image
  path as stated by a source**; `path_origin` records how the path was
  obtained: `source` (the source states it) or `name-size` (uniquely
  resolved against the scanned tree — digiKam's album-less images, §8.3).
  `content_hash` is the BLAKE3 of the file, set **only when the image was
  certainly resolved and read for hashing** (H3); `name`/`file_size`/
  `source_ref` keep the source's own identifiers for the importer's
  matching.
- `faces(id, image_id, person_id, x, y, w, h, unit, img_w, img_h,
  source_id, source_ref, picked, harvest_run_id)` — corner-origin boxes as
  the source states them: `unit` ∈ `normalized|pixels` plus the source's
  image dimensions (`img_w/img_h`) when given. Normalised→pixel conversion
  is deferred to the importer, because only it will know the canonical
  decode dimensions (schema v1.5 `images.width/height`, design #18).
  Lightroom's pixel rounding is banker's `round()` — contract, not choice,
  because the legacy keys were built on it. `UNIQUE(image_id, person_id,
  x, y, w, h, source_id)` dedupes digiKam's duplicate `Images` rows.
- **v1.1 correction (§9):** rectangle-less capture is gone. Only faces
  *with geometry* are harvested — the import (§9) attaches persons by
  rectangle overlap, so presence rows (MPRI display names, digiKam/catset
  tag→image hits, the former `image_persons` table and the
  `sidecars-mpri` source) can never be used and are no longer recorded.
  Tag/catset paths still contribute `person_groups` (group info, §9.4).
- `schema_version(version, updated_at)` — single row `'1.0'`, exact-match
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
    [--sources sidecars-mwgrs,…] [--list-sources] [--dry-run]
```

Defaults come from `.env` (`DEFAULT_IMAGES_DIR`, `ARCHIVE_DIR`,
`DIGIKAM_DB`, `DIGIKAM_RECOGNITION_DB`, `LR_CATALOG`, `LR_SIDECARS_DIR`);
without `--out` the staging DB is created as
`~/.cache/whot/harvest/harvest-<YYYYmmdd-HHMMSS>.db`. `--lr-root` maps a
catalog root onto disk, tried **in order** (map the live tree first), and
the *mapped* path is the path of record. `--dry-run` parses and counts
without writing anything at all; `--no-hash` skips the BLAKE3 reads (H3).

### 8.5 Import hand-off

Merged into `faces.db` by `scripts/import_harvested.py` — full spec in
§9.

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
by the file dimensions (the source-stated `img_w/img_h` when given, else
`images.width/height` — equal to the file dims while `inversion='none'`,
which is what `import_roll.py` writes, since cv2/rawpy decode without EXIF
rotation); pixel boxes (digiKam, Lightroom) are already file-space. If a
target image ever carries `inversion != 'none'`, the box is mapped through
the inverse flip (`lr`: `x' = W−(x+w)`; `tb`: `y' = H−(y+h)`) — kept for
forward compatibility with design #18.

### 9.3 Matching (IoU)

`overlap = |A∩B| / |A∪B| ≥ --min-overlap` (default **0.60**, configurable).
Per image, matching is greedy one-to-one: all (harvested, db) pairs above
the threshold are sorted by IoU descending (ties: lower `faces.id` first);
each harvested face and each db face may win at most once. Below-threshold
and already-claimed leftovers are logged, never guessed.

### 9.4 Person resolution

Per staging person with at least one accepted assignment:

- Strip the leading `People`/`Person` root segment from its group paths
  (case-insensitive; an empty remainder is dropped) — `People|Family|X`
  becomes `Family|X` in `person_groups`.
- Reuse an existing `faces.db` person **only** when its name matches *and*
  its group set matches the harvested set exactly. The script never guesses
  identity; otherwise it creates a new person (`state='imported'`) and the
  user merges later via the GUI's assign semantics (§4.1).
- On a name collision the new person gets the smallest free seq suffix:
  `Winnie Pelser 2`, `Winnie Pelser 3`, …

### 9.5 UnknownN cluster merge

Assignments are grouped by the *current* person of the matched db face —
exactly the shape a GUI group-assign works on (§4.1):

- The current person is an `UnknownN` and **all** its matched faces resolve
  to the **same** new person ⇒ move **all** of the cluster's faces (matched
  or not) to that person — as if the user had assigned the whole group —
  then delete the emptied UnknownN (stale shell, §4.13).
- The cluster's matches resolve to **different** persons ⇒ leave the whole
  UnknownN untouched and log it: the script must not break things where
  the evidence is contradictory.
- The current person is a real (user/importer) person, or no person
  (`person_id IS NULL`) ⇒ move only that face; an emptied person that is
  not an UnknownN is **never** deleted.

Every moved face is re-labelled like a GUI move (§4.7): `seq` becomes the
next free seq of its new `(person, description)` group and `name` is re-
derived. Housekeeping after moves (§4.5/§4.6 consistency): clear any
`persons.primary_face_id` that points at a moved face (`primary_pinned=0`)
and delete `person_refcrops` rows that reference a moved face under its
old person. No refcrop recompute runs — provisional faces are not refcrop
material (§4.6); the GUI recomputes on the next mutation.

### 9.6 Report

Every non-import is logged with reason and ids: `hash-missing`,
`image-not-in-db`, `degenerate-box`, `below-threshold`,
`already-claimed`, `status-protected`, `cluster-disagreement`. A JSON
summary plus a human-readable log are written next to the target copy.
No `imports` row is created — this is recovery, not an import; the log
files are the provenance.

### 9.7 CLI

```
scripts/import_harvested.py STAGING.db [--faces-db data/faces.db]
    [--min-overlap 0.60] [--overwrite] [--dry-run]
```

`--faces-db` defaults to `FACES_DB` from `.env`. `--dry-run` runs the full
pipeline read-only (no copy, no writes anywhere; report to stdout).

## 10. CLI console contract — header, status, quiet (v2.0, issue #79)

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
paths, thresholds) and the UTC start time (#40 convention), closed by the
same banner. Printed **even with `-q`**.

### 10.3 Status updates

- Phase lines (`scanning …`, `found N files`, `[i/N] file`, `staging:
  …`) while work proceeds — suppressed by `-q`.
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
