# WhoT Performance Review — Frontend & Backend

**Date:** 2026-11-03
**Scope:** `src/` (React 19 / TypeScript), `src-tauri/` (Rust / Tauri 2 / SQLite),
at app version 3.96.0, commit `a14c1dc` (branch `dev`).

This is a review report, not a design document. It records the current
performance state with concrete evidence (file + line references), the
conclusions drawn from it, and a prioritised set of recommendations. Each
recommendation should be turned into its own GitHub issue when work begins.

---

## 1. Executive summary

The app already contains a significant amount of deliberate performance
engineering, and much of it is correct:

- `FaceCard`, `SectionView`, `FaceGrid`, `PersonTree`, `RollsPane`,
  `DetailPane` and `RollsThumbs` are all `memo`'d, with section-level
  signature comparators in `FaceGrid.tsx:276–303`.
- Image IPC is raw bytes (no base64), coalesced per microtask into
  `get_image_batch` calls, with LRU-capped Blob URLs and revoke-on-evict
  (`src/api.ts:225–305`).
- The review grid has incremental mounting (`src/gridMount.ts`) driven by
  an IntersectionObserver.
- `lruCache.ts` eviction is O(1) amortised; `nameCluster.ts` is
  length-bucketed rather than naive O(n²).
- The Rust side uses WAL + `busy_timeout` + a persistent pooled connection,
  batch write commands (one transaction per user action), a cheap
  `data_version` stamp to skip focus/visibility reloads, and a fully
  optimised release profile (`lto`, `codegen-units = 1`).

Despite this, two architectural problems dominate everything else at scale,
and a long tail of `medium`/`low` issues accumulates around them:

1. **Every mutation re-fetches and re-serialises the entire database** as one
   JSON snapshot over IPC, on both sides of the bridge.
2. **Every Tauri command is synchronous**, so all of that DB, blob and fs
   work blocks the WebKit/ui main thread — the two problems compound into
   perceptible freezes per click on a large library.

Until #1 and #2 are fixed, the smaller optimisations below will only shave
the per-click cost, not change its order of growth.

---

## 2. Findings — Frontend (React / TypeScript)

### 2.1 HIGH severity

#### F-H1. Unbounded cache of full-size images as base64 data URLs

`src/hooks.ts:35, 54, 88–90`

```ts
const rotatedCache = new Map<string, { base: string; out: string }>(); // L35 — never evicted
...
resolve(c.toDataURL("image/jpeg", 0.92));                              // L54
...
rotatedCache.set(key, { base, out: u });                               // L89
```

`useRotatedImage` (only consumer: `FaceOverlay.tsx:45`, the full-size image
view) decodes the whole photo into a canvas, re-encodes it with `toDataURL`,
and stores the base64 string in a plain `Map` that is never evicted — in
contrast to `api.ts`, which LRU-caps Blob URLs at 500/1000/5000.

Consequences:

- Data URLs are ≈33% larger than the raw blob bytes and a full photo can be
  multiple MB; every (image, rotation) pair ever viewed is retained for the
  session. Browsing 200 rotated images can retain hundreds of MB of strings.
- The synchronous canvas draw + JPEG encode happens on the main thread per
  cache miss, freezing the UI.
- No dedupe with the existing preview Blob-URL LRU.

**Recommendation:** replace `toDataURL` with `canvas.toBlob` →
`URL.createObjectURL` and wrap the cache in the existing LRU; better still,
drop the JS-side re-encode entirely and apply rotation as a CSS
`transform` (the backend already stores `rotation` per face/image; the
rotation is display state).

#### F-H2. Full snapshot re-fetched over IPC after every single mutation

`src/App.tsx:249–253 (refresh), 428–445 (mutate), 1623–1624 (commitPending)`

```ts
const mutate = useCallback(async (fn, clearSel = false) => { ...
    await fn();
    await refresh();                       // → api.getSnapshot(): ALL persons+faces+images+imports
...
const s = await api.getSnapshot();          // L1624: second FULL fetch inside one user action
```

`Snapshot` is the whole DB — every person row, every face row, every image
row, imports and settings (`api.ts:75–84`, `db.rs:519–603`). One
Accept/Reject/Rotate/Note mutation therefore costs a complete
re-serialisation of the dataset across the IPC bridge, followed by App
rebuilding `facesById`, `personsById`, `primaryRot`, `treePersons`,
`statusTotals`, sections and the tree — all O(total faces/persons/images).

Worse, `commitPending` performs its own extra `getSnapshot()` (L1624) on top
of the `mutate`-driven refresh — two full fetches per staged Accept. The
`data_version` stamp (`App.tsx:257–260`) exists to suppress no-op reloads
but is only used for background-focus refreshes, not mutations.

**Recommendation:** introduce a delta protocol: mutation commands return the
touched faces/persons/images plus the new stamp, and `mutate` applies the
delta locally instead of calling `refresh()`. Failing that, at minimum
stamp-gate the refresh and remove the duplicate fetch in `commitPending`.

#### F-H3. Identity-churn chain re-renders every mounted FaceCard on person changes in Review mode

`src/App.tsx:583–590, 613–639, 640–658, 1072–1111, 1256–1346, 1361–1377`

```ts
const markExhaust = useCallback(..., [mode, personId, stepIdx]);           // L590
const doAccept = useCallback(..., [mutate, markExhaust, facesById, ...]);  // L658
const faceMenu = useCallback(..., [facesById, ..., doAccept, doReject, ...]); // L1109–1111
const gridHandlers = useMemo(() => ({...}), [facesById, ..., doReject, ...]);  // L1344–1346
const sections = useMemo(() => buildSections({...personId...}), [..., personId, ...]); // L1376
```

`personId` changes on every review verdict advance and every tree select.
That flips `markExhaust` → `doAccept`/`doReject` → `faceMenu` →
`gridHandlers` identity. The prop comparator in `FaceGrid.tsx:276–303`
explicitly compares handler identities, so `memo(SectionView)` fails for all
mounted sections and every `memo(FaceCard)` re-renders despite unchanged
data. Additionally, `sections`' dep list includes `personId`, so review-mode
sections are recomputed (O(total faces) scan, `sections.ts:180–208`)
producing fresh `section` objects that also defeat the
`a.section === b.section` comparator.

In Review mode, with `mountLimit` grown geometrically to hundreds/thousands
of cards (`gridMount.ts:16–18`), every accept→advance becomes a full grid
re-render instead of touching only the affected section. The comment at
`FaceGrid.tsx:56–58` claims this is avoided — it is only avoided while
`personId`/`stepIdx` are static.

**Recommendation:** read `personId`-dependent values through refs inside
`doAccept`/`doReject` (the codebase already uses `selRef`/`hoverRef`/
`sectionsRef` for exactly this pattern), and drop `personId` from the
`sections` dep list when mode is review.

### 2.2 MEDIUM severity

#### F-M1. PersonTree: O(n·depth) traversal per render + un-memoised rows

`src/PersonTree.tsx:167–292 (PersonRow), 529–534, 587–593, 631–641`

```ts
const renderNode = (node, depth, path, groupPath) => {
  if (!subtreeMatch(node)) return null;               // recursive walk #1
  ...
  const children = node.children.filter(subtreeMatch); // recursive walk #2
```

Per render the tree is walked twice per node, and the header count calls
`countPersons(c)` per child — itself a recursive descendant sum — for a
total of O(n·depth). This runs on every tree selection, every drag-over
highlight (`setDropPerson`), every rename, and every filter keystroke
(`useDeferredValue` at L346 defers `f` but the traversal still runs twice —
old and new value). `PersonRow` is **not memoised**: only the whole
`PersonTree` is, so every row (each with its own `useFaceImage` hook and DOM
subtree) re-renders on any of the above. With a few thousand persons this is
a heavy per-click cost.

**Recommendation:** memoise `PersonRow`; precompute per-subtree matches and
counts once per (tree, filter) change in a `useMemo`; pass stable handler
identities (as `gridHandlers` does for the grid).

#### F-M2. Tree built repeatedly: `stepIds` re-runs full `buildTree` on every filter keystroke

`src/App.tsx:337–341`; `PersonTree.tsx:83–112, 341`

```ts
const stepIds = useMemo(() => orderedVisiblePersonIds(treePersons, filter), [treePersons, filter]);
```

`orderedVisiblePersonIds` internally calls `buildTree(persons)` again — the
same tree `PersonTree.tsx:341` also builds and memoises. Per snapshot the
tree is built twice; per filter keystroke once more (sort O(n log n) per
node, including `localeCompare`), synchronously and outside the deferral.

**Recommendation:** hoist one shared tree build; key `stepIds` off the
deferred filter value.

#### F-M3. `stagedFieldsForCard` is O(stages × faces-per-op) per card → quadratic pending set

`src/components/FaceCard.tsx:87`, `src/stage.ts:72–84, 121–133`,
`src/components/FaceGrid.tsx:356`

```ts
const staged = stagedFieldsForCard(stage, face.id);
```

`stagedFieldsForCard` linearly scans the whole `Stage[]` with
`stage.faceIds.includes(faceId)` for every card render, and
`stagedFieldsForSection` does the same per section. The pending set only
grows until Accept (#123 semantics), so a long multi-edit session or one
large batch desc-drop (`App.tsx:1326–1343`) makes each Apply re-render every
covered card at O(ops × opsize) each.

**Recommendation:** index the pending set once per change into
`Map<faceId, stagedFields>` (single pass over ops) in App and pass the map
down instead of the raw array.

#### F-M4. No virtualisation outside Review mode

`src/App.tsx:2484–2497`; `src/components/RollsThumbs.tsx:49–68`

`mountLimit` is passed only for review; person view, image-detail grid and
the focus film roll render all sections/cards ("person/rolls stay fully
mounted" per the code comment). Every branch image in `RollsThumbs` mounts a
`Thumb`; a flat directory with 5–10k photos coalesces into a single
multi-MB `get_image_batch` IPC (`api.ts:263–305`), thousands of Blob
allocations + `bytes.slice()` copies, and ~5k `<img>` mounts in one commit.
A single person with thousands of faces in Person mode has the same problem.

**Recommendation:** extend the `gridMount` prefix pattern to the person /
film-roll grids and to `RollsThumbs`, or window the lists.

#### F-M5. RollsPane recomputes recursive roll-ups in render, per expand/collapse

`src/components/RollsPane.tsx:120, 105–163, 254–259`

```ts
const t = rollup(node, faceTotals);   // recursion over the subtree — in the body, not a memo
```

`BranchView` is a plain (un-memoised) function; expanding/collapsing one
branch re-renders the whole visible tree and re-runs `rollup`/`hasListed`
over each subtree — O(depth × images) per toggle, plus a full recursive pass
for the roots list.

**Recommendation:** memoise `BranchView` with a node-identity comparator, or
precompute roll-ups once per snapshot in a `useMemo`.

#### F-M6. Pane drag re-renders the entire App on every raw `mousemove`

`src/paneState.ts:64–77`

```ts
window.addEventListener("mousemove", move);   // setPaneSizes / setRollCenter per event
```

One App render per mousemove during any divider drag — for the whole-app
component. The hover-listener effect (`App.tsx:1770–1779`) rAF-throttles its
own work; the pane drag lacks the same treatment.

**Recommendation:** rAF-throttle the setter, or mutate DOM styles during the
drag and commit the final size on `mouseup`.

#### F-M7. ImportPane polls every 300 ms forever while open

`src/components/ImportPane.tsx:96–102`

```ts
const id = window.setInterval(() => void tick(), 300);
```

An always-on IPC tick (`get_import_status`) every 300 ms even when nothing
is running. On the Rust side this is cheap (bounded 5000-line buffer), but
it continuously wakes the renderer's task queue in WebKitGTK.

**Recommendation:** poll at 300 ms only while `running`; fall back to
2–3 s or event-driven refresh otherwise.

### 2.3 LOW severity

- **F-L1 — O(total faces) work per App render while focus/split is open.**
  `App.tsx:2410, 2473`: `snap.faces.filter(...)` runs inline in render (use a
  `useMemo`); `App.tsx:2112–2114`: two linear `snap.images.find` scans. The
  focused `FaceOverlay` also receives a fresh array each time and is not
  memoised.
- **F-L2 — O(faces) lookup per crop in DetailPane.** `DetailPane.tsx:156`,
  called per render per refcrop row: `snapshot?.faces.find(...)`. A
  `Map<faceId, rotation>` would be O(1) (App already builds `primaryRot`).
- **F-L3 — hot keydown effect rebinds on every selection change.**
  `App.tsx:1801–1924`: dep list includes `sel`, `sections`, `stepPerson`;
  listener torn down/re-attached per click. Use refs.
- **F-L4 — menu handlers depend on `sel`** (`App.tsx:1155–1198`), so
  `memo(RollsThumbs)` re-renders all thumbs when the face selection changes.
  Readable via `selRef`.
- **F-L5 — per-keystroke linear scans in dialogs.** `EditDialog.tsx:88–89`
  (`persons.find` on name per render), `MergeIntoDialog.tsx:46–50` (two
  `.toLowerCase()` linear scans). Index once per dialog.
- **F-L6 — LRU eviction may revoke Blob URLs still shown by mounted cards** —
  `api.ts:225–234`. Recoverable (cache miss reloads) but a blank-flicker risk
  after remount waves; consider refcounting consumers, and chunk batches
  (e.g. ≤64 images per IPC) to bound the `bytes.slice()` peak memory at
  `api.ts:297`.
- **F-L8 — `OverlayProvider` context value not memoised** (`overlays.tsx:38`);
  hygiene only.

*(F-L7: React StrictMode double-wiring in dev is expected; do not benchmark
IPC counts in dev builds.)*

---

## 3. Findings — Backend (Rust / Tauri / SQLite)

### 3.1 HIGH severity

#### B-H1. Every Tauri command is synchronous — all DB/blob/fs work runs on the main thread

`src-tauri/src/lib.rs:24–288`

All 30 commands are declared `#[tauri::command] fn …` — none is `async` nor
`#[tauri::command(async)]`. In Tauri 2, plain (non-async) commands execute on
the main thread. The heaviest offenders:

- `get_snapshot` (L24–27): full-DB JSON serialisation;
- `get_image_batch` (L41–49): multi-MB blob reads;
- `person_face_clusters` (L82–89): O(n²) math over 512-dim vectors;
- `open_image` (L58–80): fs temp-file write;
- `scan_import_dir`: recursive fs walk up to depth 32;
- `remove_persons` / `assign_person`: hundreds of SQL statements each.

Each stalls the main thread, producing visible UI freeze. Because the DB
layer is already serialised behind its own mutex, making the commands async
is safe and cheap.

**Recommendation:** declare the heavy commands `#[tauri::command(async)]`
(or wrap in `spawn_blocking`). This is the single cheapest high-impact fix
in the backend.

#### B-H2. `get_snapshot` loads the entire database into one JSON blob

`src-tauri/src/db.rs:519–603` (reads), `426–436` (Snapshot struct)

No WHERE: `SELECT … FROM faces ORDER BY id` (548–575), all images
(577–597), all imports (599–603), plus persons/groups/counts (484–546). Combined
with F-H2 (frontend calls it per mutation), a 50k-face/10k-image library
pays tens of MB of JSON per click. There is no pagination, no view-scoped
query, and the stamp that already exists (`data_version`, `db.rs:458–472`)
is not used to compute deltas.

**Recommendation:** implement the delta protocol on the Tauri side (touched
rows + stamp per mutation command), or view-scoped queries instead of the
global snapshot. This closes the same loop as F-H2 — treat them as one
feature.

#### B-H3. `person_face_clusters` is O(n²) cosine on the main thread

`src-tauri/src/db.rs:2171–2183` (loop), `2110–2119, 2052–2059, 2215–2216` (cache)

Single-linkage loop: each candidate computes a 512-multiply cosine against
every member of every cluster, with no similarity memoisation; a person with
k faces costs O(k²·512) worst case — synchronously (see B-H1). The
fingerprint cache (#211) avoids *recompute* on repeat calls, but the first
compute per person per threshold is uncached, every call rebuilds an O(n·40)-
byte fingerprint string, and cache hits still pay a full `out.clone()`.

**Recommendation:** make the command async (B-H1 covers most of it);
memoise cosines within a call; consider vector preferring an approximate
filter (dimensionality reduction or 8-bit quantisation) before full cosine.

### 3.2 MEDIUM severity

- **B-M1 — Global POOL mutex held for the entire operation + per-call
  schema gate.** `db.rs:151, 153–183, 189–216`: the `DbConn` Deref holds the
  `MutexGuard` for the whole command, so nothing else can even acquire a
  connection while a transaction runs; and every `connect()` runs one extra
  `SELECT version FROM schema_version` (208–212). Gate on first open only,
  or cache the marker briefly.
- **B-M2 — N+1 loops in reject/re-home and assign paths.**
  `db.rs:1097–1112` per face: `MAX(seq)+1` SELECT then UPDATE; called from
  `set_link_status` (1330–1335) and inside the per-person loop of
  `remove_persons` (1868–1892) → P·(5 + 2F) statements for a batch;
  `assign_person` repeats the pattern (1250–1272). Same inside one
  transaction (no fsync cost), but each iteration re-prepares SQL. Set-based
  `UPDATE … FROM (window function)` per (person, description) group removes
  the loop.
- **B-M3 — Missing composite index for the MAX(seq) shape.**
  Query shape at `1098–1103, 1260–1266, 1448–1453`:
  `SELECT MAX(seq) FROM faces WHERE person_id = ? AND COALESCE(description,'') = ?`.
  Only `idx_faces_person(person_id)` exists (`schema.sql:100–103`), and
  `COALESCE` blocks index use — the MAX scans all of that person's faces.
  Inside B-M2's loops this makes a reject batch O(k²) in the person's face
  count. Add
  `CREATE INDEX idx_faces_person_desc_seq ON faces(person_id, description, seq)`
  (and a normalised `description_key` column if the COALESCE must stay).
- **B-M4 — per-person `SELECT COUNT(*)` existence checks in a loop.**
  `db.rs:1740–1745, 1802–1807, 1284–1288`. One `WHERE id IN (…)` up front.
- **B-M5 — `get_image_batch` double-copies every blob, and "preview" batches
  are unbounded.** `db.rs:630–675`: each blob is copied once per
  `Vec<u8>` row read and again into the framed buffer; for `kind="preview"`
  with 500 ids/chunk a transfer can transiently hold 2–3× the bytes on the
  main thread. Cap preview batch size and stream/frame in place.
- **B-M6 — `open_image` does heavy fs work in a sync command** (`lib.rs`
  L58–80; blob read `db.rs:679–690`): MBs of BLOB read + temp-file write +
  opener invocation synchronously (B-H1 covers the fix; move the work off
  the main thread).

### 3.3 LOW severity

- **B-L1 — `BRANCH_OF` group-path matching can't use an index**
  (`db.rs:1618` and call sites): `substr(path,1,length(?1)+1) = ?1||'|'`
  defeats any index; `person_groups` has no standalone `path` index. Fine at
  small person counts.
- **B-L2 — `recompute_refcrops` INSERT loop** (`db.rs:851–858`): re-prepared
  per row, but compare-and-skip-guarded (830–846) and inside the tx; minor.
- **B-L3 — `sweep_stale_shells` GLOB scan on every writer** (`db.rs:726–733`):
  negligible today.
- **B-L4 — two single-statement writes skip the tx wrapper**
  (`set_person_note` 1839–1846, `remove_refcrop` 1970–1977): fine, minor.

---

## 4. Conclusions

1. **The app's performance architecture is good at the top level but has two
   broken feedback loops at scale:** per-mutation full-DB snapshots
   (F-H2/B-H2) and main-thread-bound command execution (B-H1/F-H1).
   Together these make every user action O(entire library) and freeze the
   UI while it runs — the worst possible combination.
2. **Memory growth in the render path is unbounded in one place:** the
   rotated-image data-URL cache (F-H1). This is the only finding that can
   leak into OOM territory in a long session.
3. **The remaining issues are per-interaction constant-factor costs** —
   tree traversal (F-M1/M2), stage scans (F-M3), unwindowed grids (F-M4),
   roll-up recursion (F-M5), mousemove storms (F-M6), polling (F-M7/F-M7…
   ImportPane) and the SQL N+1 tails (B-M2..M5). Individually small; they
   compound with H-H3-style identity churn because they re-run inside
   unnecessary re-renders.
4. **Nothing found changes the design documents' structure.** All fixes fit
   the existing module layout (`lib.rs` stays thin; `db.rs` owns its delta
   additions; React-side fixes stay in App/components/hooks).

## 5. Recommended fix order

| # | Area | Fix | Severity | Rough impact |
|---|------|-----|----------|--------------|
| 1 | Backend | async commands / `spawn_blocking` for heavy handlers (B-H1) | HIGH | unblocks main thread for everything else |
| 2 | Both | delta snapshot protocol: mutations return touched rows + stamp; App applies locally (F-H2 + B-H2) | HIGH | biggest single win on large libraries |
| 3 | Backend | `idx_faces_person_desc_seq` + set-based seq assignment (B-M3/M2) | MED→HIGH | removes O(k²) reject batches |
| 4 | Frontend | media store: CSS-rotate or `toBlob`, LRU-cap rotated cache (F-H1) | HIGH | bounded memory, no jank per rotate |
| 5 | Frontend | break the `personId` identity chain in review handlers + sections (F-H3) | HIGH | verdicts touch one section |
| 6 | Frontend | memoise `PersonRow`, hoist tree build, precompute counts, defer `stepIds` (F-M1/M2) | MED | flat tree cost per interaction |
| 7 | Frontend | index pending stages into a `Map` (F-M3) | MED | removes quadratic editing path |
| 8 | Frontend | window person grid / film roll / `RollsThumbs` (F-M4) | MED | bounded DOM for large sets |
| 9 | Frontend | memoise `RollsPane` roll-ups (F-M5), rAF-throttle pane drag (F-M6), poll only while running (F-M7) | MED | interaction smoothness |
| 10 | Backend | cap preview batch size, avoid double blob copy (B-M5); async `open_image` (B-M6) | MED | fewer MB copies per serve |
| 11 | Both | low-severity cleanups (F-L1–L6, B-M1, B-M4, B-L1–L4) | LOW | hygiene, compounding effect |

Per `AGENTS.md`, items 1–2 (and arguably 5–6) are feature-scale changes —
they should bump the design documents (major/minor) and be tracked as
GitHub issues; items 3, 4, 7–11 are corrections/speed-ups and can ride as
minor bumps or subminor fixes depending on whether they alter documented
behaviour.
