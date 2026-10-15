# WhoT Face Manager — GUI Design

**Version: 1.3** (major.minor per `AGENTS.md`; major = new feature, minor =
change/correction)

**Change log**

- **1.3** (2026-10-15, description/appearance investigation #27, part 1):
  §4.6 — reference faces are rebuilt **per appearance group**: one top-N
  list per distinct `(person, faces.description)`, `seq` 1..n within the
  group; manual pins move from the `pin:`-prefix hack to a dedicated
  `person_refcrops.pinned` column (schema v1.5, DB drop & recreate —
  `scripts/annotation_snapshot.py` exports/restores manual annotations
  across the recreate). §4.4 — editing a description re-assigns the face's
  `seq` within its new group and re-runs the refcrop recompute. §4.7 —
  uniqueness follows. Importer matching keyed on person+description
  (inheritance) is **not** part of this bump — pending #27 decision.
- **1.2** (2026-10-15, UX enhancements #23–#26 — incremental controls on
  existing panes, no new workflow ⇒ minor): §3 — `show_rejected` toggle
  (persisted in `whotrc.json`, default `true`) hides rejected faces
  everywhere they surface; person-tree branches roll up/down individually
  and all at once (⌃/⌄ beside the filter); every full-image view draws
  interactive, name-labelled face rectangles; double-clicking a face card
  opens the full image in a vertical split of the center pane. §2/§5 —
  `settings` gains `show_rejected`. §4.10–§4.11 — the corresponding
  behaviour rules. §6 — `FaceOverlay.tsx` added.
- **1.1** (2026-10-15, review-driven corrections F2/F7/F12/F14/F22):
  §4.1 — a name that matches an existing person *merges* into that person
  (no collision error) and their group path is left untouched; the group
  field applies only to rename-in-place/new-person. §4.7 — next free seq is
  `MAX(seq)+1` (gap-proof). §4.8 — manual refresh button + refetch on
  window focus for imports made while the GUI is open. §5 — command
  signatures corrected (`remove_refcrop(person_id, face_id)`,
  `get_image_* → Option<String>`). §6 — file layout corrected (command
  surface lives in `lib.rs`; `tests/`, `test/`, `docs/` added).
- **1.0** initial GUI design.

Tauri-based desktop app for reviewing, naming, accepting, rejecting and
annotating faces imported by `scripts/import_roll.py` into `data/faces.db`.

## 1. Goals

After a roll import, all faces are `provisional` and attached to `UnknownN`
persons (one per similarity cluster found by the importer). The GUI lets the
user:

- see the new faces in a grid, **split into the importer's similarity groups**;
- select a whole group or any subset of faces and **assign them a real person**
  (name + group) — this *accepts* the faces (`link_status = 'confirmed'`);
- **reject** faces (`link_status = 'rejected'`);
- give a face a **description** (e.g. `beard|glasses`);
- pick each person's **primary face** (icon);
- browse persons in a **hierarchical tree by group**, with a name/group filter;
- browse **images by import roll**;
- maintain each person's **reference faces** for future recognition.

All panes re-sync after every mutation.

## 2. Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | **Tauri 2** (Rust 1.98, webkit2gtk-4.1 on this host) | user requirement, small native binary |
| Frontend | **React 19 + TypeScript + Vite** | user asked vue vs react; React chosen for the most mature Tauri templates and component ecosystem — both are fine, React is the lower-risk path |
| Styling | hand-rolled dark-theme CSS (custom properties, no UI library) | face-grid UIs look better hand-tuned; keeps bundle small |
| Backend | Rust + **rusqlite** (bundled SQLite) | all SQL in one trusted place |
| Embeddings | Rust float32 dot product on `face_embeddings.vector` (512-d, L2-normalised ⇒ cosine) | trivial cost up to ~10k faces |
| Images | served from DB **BLOBs** (`faces.preview`, `images.thumbnail/preview`) as base64 data URLs, lazy + cached in the frontend | GUI works even if source files move; no file-system access needed |
| Python | **none** at runtime | insightface only runs in the import script |

App root = repository root (`package.json`, `src/`, `src-tauri/`).
DB path resolved like `import_roll.py`: parse `.env` (`FACES_DB`, default
`data/faces.db`), relative to project root.

GUI settings live in `config/whotrc.json` (created on first need; path from
`CONFIG_FILE` in `.env`):

```json
{ "cluster_threshold": 0.40, "refcrop_n": 5, "show_rejected": true }
```

## 3. Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ WhoT Face Manager                [Review] [Rolls]      settings ⚙       │
├──────────────┬───────────────────────────────────────────┬───────────────┤
│ filter       │ group header (select-all ▣ · N faces ·    │ person name   │
│ ┌──────────┐ │  similarity · rule: [name][group] [apply])│ group path    │
│ │persons…  │ ├───────────────────────────────────────────┤ note          │
│ └──────────┘ │  ▣ face card  ▣ face card  ▣ face card    │ primary face  │
│ counts:      │  (preview, name,      …                   │ refcrops      │
│ prov/conf/rej│   conf, desc input,                    (scrollable)      │
├──────────────┴───────────────────────────────────────────┴───────────────┤
│ rule bar: N selected · [Assign name…][group…] [Accept] [Reject] [clear]  │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Left pane — person tree.** Hierarchy built from `person_groups.path`
  (segments split on `|`). Virtual branches: `Unknown` (persons whose only
  group is `Unknown`) and `Ungrouped` (known persons with no group row).
  Leaves = persons (avatar, name, counts: total / provisional / confirmed /
  rejected). One filter box matches **person name and/or group path**
  (case-insensitive substring); tree stays hierarchical below the match.
  Branches **roll up/down** by clicking their header (any branch holding
  persons or sub-branches, arrows reflect state) and all at once via
  **⌃ roll-up / ⌄ roll-down** controls beside the filter. The collapsed set
  is display-only: filtering auto-expands matching paths while a filter is
  active without mutating it, and the previous roll-up state applies again
  when the filter is cleared. Rolled-up branch counts always include the
  hidden descendants.
- **Center pane — two modes** (tabs):
  - **Review** (default): all faces that are `provisional` (i.e. still to be
    decided on), **grouped by their importer person** (`UnknownN` clusters).
    Each group section has: select-all checkbox, face count, the current
    `UnknownN` name, and a **rule** = `[name input][group input][Apply]` that
    assigns the group's currently selected faces (default: whole group).
  - **Rolls**: imports (roll path + date) as expandable sections; image
    thumbnails per roll; clicking an image opens its faces (same face cards,
    same operations) plus the image preview **annotated with its detected
    face rectangles** (see below).
- **Rejected visibility** (§4.10): a `show_rejected` toggle in the center
  pane's toolbar hides rejected faces wherever they surface — the person
  view's `Rejected` section, rejected cards in image grids, and rejected
  rectangles in full-image views.
- **Full-image views** (§4.11): every full-size image — the Rolls image
  detail and the card double-click split — always draws one **active,
  name-labelled rectangle** per visible face of that image, colour-coded by
  `link_status`; hover highlights the rectangle and its card (bidirectional),
  click toggles the face's selection.
- **Card double-click — image split**: double-clicking a face card splits
  the center pane vertically (current grid left, annotated full image right;
  in Rolls image detail the image replaces nothing — same overlay). Closable
  via ×/Esc; selection and current view survive; double-clicking another
  card swaps the image. Single-click selection is unaffected (the two
  clicks of a double-click cancel each other out).
- **Person view**: clicking a person in the tree shows *that person's* faces
  in the center pane, **grouped by similarity to the primary face**
  (single-linkage, `cluster_threshold`, section shows min similarity) so
  impostors stand out; same selection/operations as Review.
- **Right pane — person detail** (when a person is selected): name (editable
  for known persons), group path (editable, `|`-separated; empty ⇒
  Ungrouped), note, primary-face picker, refcrops list.
- **Rule bar (bottom)**: always visible when ≥1 face is selected in any
  center-pane view: `N selected · [Assign…][Accept][Reject][clear]`. Assign
  opens a name+group dialog (name pre-filled with the group's `UnknownN`
  when the selection is homogeneous).

Face card: preview image, derived `name`, confidence %, description input
(`|`-separated tags, edited inline, committed on blur/Enter), star (set as
primary), status badge (provisional/confirmed/rejected), reject button.
Double-click opens the full image split (§3).

## 4. Behaviour rules (decided)

1. **Assign a person** (core operation — accept + name + group):
   - If all selected faces belong to *one* `UnknownN` and the user keeps/
     supplies a name for that person: **rename in place** — `persons.name`,
     replace `person_groups` with the given path (empty ⇒ no group rows ⇒
     Ungrouped), all selected faces `link_status='confirmed'`. The old
     `UnknownN` number is retired and never reused (importer numbering is
     max-based over remaining names — safe).
   - If selected faces span multiple persons or the name is new: move the
     selected faces to that person (create if needed), `confirmed`,
     `reassigned=1`. Faces **not** selected stay with their original person
     (e.g. `UnknownN`) for later assignment or rejection.
   - Assigning to a name that matches an **existing person merges** the
     selection into that person (names are not required to be unique for
     assign); the target person's group path and note are **left untouched**
     in that case. The group field only applies to the rename-in-place /
     new-person branches (review F2/F22).
   - After any assignment the person enters the importer's *known corpus*
     automatically (name not `Unknown*` + confirmed faces).
2. **Reject** ⇒ `link_status='rejected'`. Rejected faces: excluded from
   similarity grouping, primary-face eligibility, refcrops and importer
   corpora. Reversible: re-selecting + Accept sets `confirmed`.
3. **Accept (without rename)** ⇒ selected faces `link_status='confirmed'`
   (stay with their current person; used to confirm a `UnknownN` as-is or
   to recover a previously rejected face).
4. **Description** ⇒ free text, spaces around `|` trimmed by the writer; the
   derived face label becomes `person.name-description-seq`. Editing a
   description **re-assigns the face's `seq`** to `MAX(others)+1` within its
   new `(person, description)` group (so §4.7 uniqueness survives the move)
   and re-runs the person's refcrop recompute — the face has changed
   appearance group.
5. **Primary face** ⇒ `persons.primary_face_id` + `primary_pinned=1` when set
   by the user. After any mutation, a person whose primary is missing or no
   longer belongs to them gets the machine rule of `import_roll.py`
   (`assign_missing_primaries`: highest `confidence`, non-discarded face,
   `primary_pinned=0`).
6. **Reference faces** ⇒ automatic: after any accept/reject/primary/
   description change, the person's `person_refcrops` are rebuilt **per
   appearance group** — for each distinct `COALESCE(faces.description,'')`
   of the person's confirmed faces, the **top `refcrop_n` (default 5) by
   confidence within that group**, excluding the primary face, `seq` 1..n
   inside the group (PK `(person_id, description, seq)`). Manual promotion
   of any confirmed face is possible; pinned rows carry `pinned=1`, are
   excluded from auto-selection and survive recomputation. `face_id` is
   UNIQUE per row (a face is a refcrop of at most one person). The old
   `pin:`-prefix convention is gone (schema v1.5).
7. **Face `name` derivation** ⇒ `person.name[-description]-seq`; `seq` is
   per (person, description) as in the importer, computed as `MAX(seq)+1`
   (gap-proof, so labels stay unique within a person even after faces are
   moved out and back in — review F5). On a move, a face gets the next free
   seq of its new person; renames only re-derive names, description edits
   re-derive names *and* re-assign seq within the new group (§4.4).
8. **Sync** ⇒ every mutation runs in one SQLite transaction; the frontend
   then re-fetches `get_snapshot()` and re-renders tree, grid, detail pane,
   rule bar and rolls. Image BLOBs are fetched lazily per card and cached by
   `face_id`/`image_id` (content never changes, cache never invalidated).
   External changes (a roll imported while the GUI is open) become visible
   via a **manual refresh button** in the top bar and an automatic re-fetch
   when the window regains focus/visibility; focus-refetch errors are
   ignored so they cannot stomp the current view (review F12).
9. **Similarity grouping** (person view only) uses the same single-linkage
   cosine rule and default 0.40 threshold as the importer — it is a display
   aid for impostors, it does *not* re-cluster or reassign anything; the
   importer's grouping is authoritative (no redundant global re-clustering).
10. **Rejected-face visibility** ⇒ the `show_rejected` setting (default
    `true`, persisted in `whotrc.json`). When off: the person view's
    `Rejected` section and rejected cards/rectangles in image grids and
    full-image views are hidden, and any *selected* rejected faces are
    deselected at toggle time — hidden faces can never be bulk-acted on.
    `link_status` itself is unchanged; the toggle is pure display (§3).
11. **Full-image annotation** ⇒ every full-size image draws one rectangle
    per visible face from `faces.x/y/w/h` against the canonical
    `images.width/height` coordinate space, percentage-scaled so it stays
    correct at any rendered size. Rectangles are active: hover highlights
    rectangle + card (shared hover state), click toggles selection; colours
    follow `link_status` (warn/ok/bad). `no-face` images and hidden faces
    (§4.10) draw no rectangles.

## 5. Tauri commands (Rust)

**Reads**

- `get_snapshot()` → `{ persons: [{id, name, state, note, primary_face_id,
  primary_pinned, groups[], counts{total, provisional, confirmed, rejected}}],
  faces: [{id, image_id, person_id, x, y, w, h, name, seq, description,
  confidence, link_status, state, import_id, created_at}],
  images: [{id, primary_path, width, height, orientation, type, state,
  roll_id, first_import_id}], imports: [{id, path, started_at}],
  settings {cluster_threshold, refcrop_n, show_rejected} }`
- `get_face_preview(face_id) → String` (base64 JPEG from `faces.preview`)
- `get_image_thumb(image_id) → Option<String>`,
  `get_image_preview(image_id) → Option<String>`
- `get_refcrops(person_id) → [{seq, description, face_id, image: base64}]`

**Mutations** (each ends with refcrops recompute + primary backfill for all
affected persons; all return an error string on constraint violation)

- `assign_person(face_ids, name, group_path)` — §4.1
- `accept_faces(face_ids)` — §4.3
- `reject_faces(face_ids)` — §4.2
- `set_face_description(face_id, description)` — §4.4
- `set_primary_face(person_id, face_id)` — §4.5
- `set_person_name(person_id, name)` / `set_person_group(person_id, path)` /
  `set_person_note(person_id, note)`
- `add_refcrop(person_id, face_id)` (manual, pinned) /
  `remove_refcrop(person_id, face_id)`
- `get_settings()` / `set_settings(json)` — `config/whotrc.json`

## 6. File layout

```
whot/
  package.json  vite.config.ts  index.html      # frontend
  src/                              # React app
    main.tsx  App.tsx  api.ts      # api.ts = typed tauri invoke wrapper
    components/  PersonTree.tsx  FaceCard.tsx  FaceGrid.tsx
                 RuleBar.tsx  DetailPane.tsx  RollsPane.tsx  AssignDialog.tsx
                 FaceOverlay.tsx   # active rectangles on full-size images
    styles.css
  src-tauri/
    tauri.conf.json  Cargo.toml    # tauri 2, rusqlite(bundled), serde, base64
    src/main.rs  src/lib.rs        # lib.rs: #[tauri::command] surface (§5)
    src/db.rs                      # db.rs: queries + embeddings + refcrops
    tests/                         # Rust integration tests (self-built fixture DB)
  test/                            # Python unit tests (import helpers)
  docs/                            # design + review documents
  config/whotrc.json              # created at runtime
  data/faces.db                   # (existing)
```

## 7. Run / build

- dev: `npm run tauri dev`
- prod: `npm run tauri build` → `src-tauri/target/release/bundle/`

Non-goals (v1): moving faces between *known* persons by drag & drop,
deleting persons/faces, editing embeddings, multi-group membership UI
(one group path per person), i18n.
