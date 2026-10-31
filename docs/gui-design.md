# WhoT Face Manager — GUI Design

**Version: 3.88** (major.minor per `AGENTS.md`; major = new feature, minor =
change/correction; this document is the primary design document — the app
version in `package.json` tracks it). The Tauri bundle version
(`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`) must match
`package.json` exactly — the built installer reports the bundle version, so
drift there ships a wrong version to users.

This document describes the **current designed behaviour only**: no change
history, no was-broken narratives. Revision history lives in the GitHub
issues. The version above is bumped with every change and referenced in
the closing comment of the issue(s) it implements.

Tauri-based desktop app for reviewing, naming, accepting, rejecting and
annotating faces imported by `scripts/import_roll.py` into `data/faces.db`.

The script designs (§8/§9) live in `docs/scripts-design.md` *keeping their
section numbers*, the Tauri command reference and repository layout in
`README.md`, and the database and Rust backend designs in
`docs/schema-design.md` and `docs/backend-design.md` (§5 below lists every
document).

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
- browse **images by their filesystem path**, rooted at any
  chosen path;
- maintain each person's **reference faces** for future recognition.

All panes re-sync after every mutation.

Non-goals: deleting faces (persons *can* be removed — §4.13; their
faces become rejected and join the system person `Rejected`, §4.35), editing embeddings, multi-group
membership UI (one group path per person), i18n. (Moving faces between
persons by drag & drop is a feature — rule 34.)

## 2. Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | **Tauri 2** (Rust 1.98, webkit2gtk-4.1 on this host) | user requirement, small native binary |
| Frontend | **React 19 + TypeScript + Vite** | user asked vue vs react; React chosen for the most mature Tauri templates and component ecosystem — both are fine, React is the lower-risk path |
| Styling | hand-rolled dark-theme CSS (custom properties, no UI library) | face-grid UIs look better hand-tuned; keeps bundle small |
| Backend | Rust + **rusqlite** (bundled SQLite) | all SQL in one trusted place |
| Embeddings | Rust float32 dot product on `face_embeddings.vector` (512-d, L2-normalised ⇒ cosine) | trivial cost up to ~10k faces |
| Images | served from DB **BLOBs** (`faces.preview`, `images.thumbnail/preview`) as base64 data URLs, lazy + cached in the frontend | GUI works even if source files move; no file-system access needed |
| Python | **none** at runtime | insightface only runs in the import and
  harvest scripts (scripts-design §8) |

App root = repository root (`package.json`, `src/`, `src-tauri/`).
DB path resolved like `import_roll.py`: parse `.env` (`FACES_DB`, default
`data/faces.db`), relative to project root.

The database carries a single-row `schema_version` table (currently `'1.7'`).
The GUI (`db::connect`) and `import_roll.py` verify it on every connection
and **refuse a missing or mismatched version** with recreate instructions —
exact match, no migrations (AGENTS.md). `scripts/annotation_snapshot.py`
preserves manual annotations across such a drop & recreate, and
`scripts/fix_status_groups.py` upgrades a v1.6 database **in place**
(backup first) to the status-group layout of §4.35, so the long-lived live
DB never needs a re-import.

GUI settings live in `config/whotrc.json` (created on first need; path from
`CONFIG_FILE` in `.env`):

```json
{ "cluster_threshold": 0.40, "refcrop_n": 5, "face_filter": "all", "cluster_group": "accuracy" }
```

## 3. Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ WhoT Face Manager                [Review] [Rolls]      settings ⚙       │
├──────────────┬───────────────────────────────────────────┬───────────────┤
│ filter       │ group header (select-all ▣ · N faces ·    │ person name   │
│ ┌──────────┐ │ name · group · desc · Edit…; similarity   │ group path    │
│ │persons…  │ ├───────────────────────────────────────────┤ note          │
│ └──────────┘ │  ▣ face card  ▣ face card  ▣ face card    │ primary face  │
│ counts:      │ (name strip · image · group · desc ·      │ refcrops      │
│ prov/conf/rej│  accuracy + Edit…)                        │ (scrollable)  │
├──────────────┴───────────────────────────────────────────┴───────────────┤
│ rule bar: N sel · [Apply][Accept][Undo°][Edit…][Reject][clear]           │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Left pane — person tree.** Hierarchy built from `person_groups.path`
  (segments split on `|`). **Group first**: a person with a group
  row renders under their path even when named `UnknownN` — the
  user may group an UnknownN they remember by face but not by name.
  **Multi-group persons render under every listed path**:
  the §9 harvest importer legally leaves several `person_groups` rows per
  person (§9.6 — additive shell groups). Each distinct row is one
  placement; the
  person is stepped (‹ › / arrows) **once**, at the first placement
  reached, and branch bulk operations (§4.13 subtree remove) dedupe the
  ids across placements. **Status branches** (§4.35) hold the
  rest: `New`, `Accepted` and `Rejected` are ordinary group paths that
  are system-written *status seats* — every person always has ≥ 1 group
  row, so the virtual `Ungrouped`/`Unknown` branches and the `Unknown`
  group value are gone. The importer seeds `New` for every `UnknownN`
  it creates; accepting re-seats an unfiled person to `Accepted`; every
  rejected face lives on the system person `Rejected` (seat `Rejected`).
  The three status paths are reserved segments (§4.16) — no typed path,
  dialog or drop can produce them — and their branches carry no menu and
  are not drop targets; the persons inside them are ordinary rows.
  Leaves = persons (avatar, name, counts: total / provisional / confirmed /
  rejected). The tree's header — **roll up/down buttons on the left,
  filter box on the right, then the Review button** — is **pinned flush
  to the top of the pane** while the list scrolls (one sticky
  block whose panel background covers the full pane width and the
  pane's top padding, so no text can show through above or beside it).
  The filter matches **person name and/or
  group path** (case-insensitive substring); tree stays hierarchical
  below the match.
  Within every branch, persons are ordered by **face count, most first**
  (ties broken by name, then id — deterministic, no sort toggle);
  sub-branches keep their order. The stepping shortcuts and the
  selection ranges therefore follow this display order.
  Branches **roll up/down** by clicking their header (any branch holding
  persons or sub-branches, arrows reflect state) and all at once via
  **⌃ roll-up / ⌄ roll-down** controls beside the filter. The collapsed set
  is display-only: filtering auto-expands matching paths while a filter is
  active without mutating it, and the previous roll-up state applies again
  when the filter is cleared. Rolled-up branch counts always include the
  hidden descendants.
- **Modes** (the top-bar selector): `Review · Rolls · Person` are
  proper **modes**, not tabs over one layout — the selector is the mode
  switch and each mode owns its centre panel and the default content of
  its right pane (Review/Person: the grid + the person detail /
  Overview; Rolls: the path hierarchy + the branch thumbnails, §4.39).
  A mode switch is a view-context change (§4.24 staged-set confirm) and
  mode state (the Rolls root, the branch selection, the
  person anchor) is session state, surviving switches unless a rule
  below says otherwise.
- **Center pane — by mode**:
  - **Review** (default): all faces that are `provisional` (i.e. still to be
    decided on), **grouped by their importer person** (`UnknownN` clusters).
    Each group section has: select-all checkbox, face count, the current
    `UnknownN` name, and **name / group / description labels** with one
    **Edit…** button — the shared dialog, scope Group (§4.24). The heading
    always sits on its own row above the card(s) — beside the card it left
    a tall black column next to a single card and rendered inconsistently
    between the review and person views.
  - **Rolls**: the images sorted into a **hierarchy mirroring their actual
    filesystem path** — each image's `primary_path` split into its
    path segments: every **directory** segment is an expandable branch
    and the images sit in their file's directory branch — the FILENAME
    is never a branch of its own, so there is a close connection
    between the filesystem and the pictures and the user can drill in to
    a smaller set. The view **does not show the import rolls** — the
    pane simply organises the pictures according to their paths. (The
    imports
    themselves stay in the DB and snapshot; the pane just ignores them.)
    A branch header shows the segment name and the branch totals —
    `{n} img · {n} new · {n} ✓ · {n} ✗` — counted over **every** image
    under the branch, filter-independent like the person tree's raw
    badges: the Show filter changes who is listed, never any
    counters. Clicking a header expands/collapses **and selects** the
    branch (its direct images land in the right pane); branches
    start collapsed, listed alphabetically by segment (images by
    filename). **The centre renders no thumbnails** (§4.39):
    clicking a branch header both toggles the branch **and selects it**,
    and the selected
    branch's images appear as thumbnails in the **right pane** (direct
    images of that path only, never the recursion); the image-tile
    menu lives on those right-pane thumbnails. Double-clicking a
    thumbnail opens that image's faces and its preview **annotated
    with its detected face rectangles** (see below); a
    single click only selects it. **Show prunes the tree** (§4.10): an
    image is listed only if it holds at least one face passing the Show
    filter — with `All` = everything *except* rejected, an image
    holding only rejected faces lists solely under `Show → Rejected`
    (a `no-face` image still lists under `All`) — and a branch holding
    no listing image
    is pruned entirely (set Show back to All to see everything again —
    the branch raw counts keep such branches discoverable). An empty DB
    shows `no images yet`.
    **Path filter**: the pane is topped by a pinned (sticky)
    path-filter row — a text input plus a **browse…** button opening the
    native **folder picker** (tauri-plugin-dialog). The typed/picked path
    is validated against the snapshot (no fs IPC):
    - a path that **contains ≥ 1 image's `primary_path`** becomes the
      **root path** — the hierarchy branches from it (the branches are
      the root's immediate sub-directories; empty input = `/` = the
      whole tree);
    - a path **equal to an image's `primary_path`** opens **that one
      image in full-image mode** (the same view-context change as a
      thumbnail double-click, incl. the §4.24 staged-set confirm);
    - anything else is refused with a dim hint (`no images under …`) and
      the current root stays — **unless the path is a real, not-yet-imported
      directory**: it is then checked against the filesystem
      (`scan_import_dir`, §4.36) and a directory holding ≥ 1 image
      file opens the **import pane in the right pane** instead of the hint.
    The root lives for the session (it survives tab switches; not
    persisted to whotrc) and the Show filter keeps pruning under it
    (§4.10). The native picker is stubbed in the GUI-mock harness.
- **Status filter + cluster group** (§4.10/§4.9): `Show
  [All | New | Accepted | Rejected]` — the face-status filter applied by
  every view (default All; **New** is the `provisional` status, spelled
  the way the face-card badge spells it) — lives in the **top bar**.
  Beside it sits the **Review lock** (§4.40): a padlock
  **indicator** — 🔒 exactly while Review
  mode is active, never a control. In Review the Show select pins to
  **New** and renders **disabled**; the way out is the ordinary
  *Rolls*/*Person* tab switch (the select re-enables, its value stays). The center pane's toolbar right side carries the
  persons-mode cluster-group toggle `[Description | Accuracy]`, and
  **only in the person view**: `cluster_group` shapes only how

  the person view forms its sections (§4.9), so the seg is hidden in
  the Review and Rolls views, where it would change nothing. **Rolls
  renders no centre toolbar at all**: neither the navigation
  cluster nor the seg appear there — the grid gets the pane's full
  height (Review and Person keep the navigation cluster). The
  toolbar is the center pane's **fixed header** (in the views that have
  one): the sections scroll
  beneath it in their own, shorter scroll area — nothing can scroll past
  above it. While a mutation is in flight the bar's
  right side shows an animated **busy roller** beside `working…` (the
  `busy` state; `prefers-reduced-motion` disables the spin).
- **Full-image views** (§4.11): every full-size image — the Rolls image
  detail and the card double-click split — always draws one **active,
  name-labelled rectangle** per visible face of that image, colour-coded by
  `link_status`; hover highlights the rectangle and its card (bidirectional),
  click toggles the face's selection **and moves the right pane to that
  face's person (§4.37)** — and on opening a full image the right
  pane follows the opening face's person.
- **Card double-click — full-image focus** (§4.19): double-clicking a
  face card opens the center pane's **focus mode**: the annotated full
  image spans the pane's full width (height-fitted, §4.11 overlay)
  and is **pinned at the top of the pane** — only the film roll
  below scrolls (§4.19). The **film roll** shows only that image's
  face cards
  (horizontal scroll strip; all card operations keep working). The
  regular grid is hidden while the mode is active. Closable via ×/Esc;
  selection and current view survive; single-click selection is
  unaffected (the two clicks of a double-click cancel each other out).
  **Lifecycle** (§4.15): the mode ends when a person is
  selected — tree row or stepping (always — the attention has shifted,
  §4.15) — when a card/rectangle selection moves to a different image,
  or the user navigates explicitly (top-bar tabs, *Review*); the
  face-rectangle menu hides *Open full image* while its image is the one
  already open.
- **Face vs person tiles**: face crops render as **rounded squares
  with a large corner radius**, so a face tile never reads as a person
  tile (whose avatar is a small circle) without cropping the face tight.
- **Face-card name label**: the card's name is a **label**
  (the strip inside the image frame), not an input — editing goes through
  the shared Edit dialog scoped to the card (§4.24); a name commit
  **assigns that person** — an existing person is merged into, a new one is
  created (`assign_person` semantics, never a collision error); the shared
  Edit dialog's scope selector is the disambiguation between face and
  group (§4.24). The full
  derived label stays in the tooltip; the detail pane's rename routes
  through the same rename-merge helper (§4.1).
- **Inline rename**: double-clicking a person row in the tree turns
  its name into an entry field (Enter/blur commits via the rename-merge
  helper, §4.1, Esc cancels — same pattern as the detail-pane fields;
  validation errors surface as toast).
  **The renaming row is never a `<button>` while renaming**:
  an entry field must not nest inside a button (invalid HTML; WebKit
  mis-handles it — clicks in the input bubble to the row's `onClick` and
  focus juggling fights the typeahead). While `renaming`, the row renders
  as a `<div>` carrying the same class/`data-person-id`/title (CSS class
  styling keeps the geometry identical), without the select/drag
  handlers: the rename input owns the interaction, blur (click-away)
  commits via `onLeave` exactly as documented above.
- **Section stepping**: ‹ › buttons in the center toolbar — and the
  `←`/`→` **shortcuts** — step through the persons in the tree's current
  (filtered) display order, selecting each (person view); disabled at the
  ends, `n/m` indicator in the toolbar. **Neither exists in the Rolls
  view**: the toolbar is not rendered there and the shortcuts are
  inert — person stepping can only land in the person view, so ‹/← have
  no target in Rolls. Shortcuts never fire while an
  input or dialog has focus; the current set is listed in the settings
  popover (`Esc` closes overlays, `Enter` commits fields).
- **Context menus**: face cards, person rows and image thumbs show a
  right-click menu with grouped entries — *selection* (select/deselect/
  select-all/clear) and *actions* (accept/reject, primary, reference,
  edit…, open image …) — reusing the same commands and selection state.
  **Tree rows** additionally support **multi-select** (click sets the
  selection, ctrl/cmd-click toggles, shift-click extends over the tree's
  visible order; the anchor row stays the person shown) and offer
  **Remove person / Remove N persons** (§4.13) and
  ***Add group…*** beside *Move to group…* (the typed path becomes an
  **additional** membership; Move replaces) — the one-person-only
  entries (*Open person*, *Rename…*, *Select their pending faces*)
  grey out while the scope is a multi-selection (§4.14); **real group branches**
  have their own menu — *remove all persons in this branch* (counts shown,
  confirm dialog required) plus *rename/move group…* and *delete group*
  (§4.16/§4.18: a group is added *to a person* — the branch and root
  menus carry no *add group…* entry, and the root's empty-space menu goes
  with its only item); the **status
  branches** (`New`/`Accepted`/`Rejected`) offer **no** branch
  menu — they are system furniture (§4.35), and bulk actions target
  real branches only. Unknown cleanup needs **no button**: rejecting a
  face moves it off its `UnknownN` onto
  the system person `Rejected`, so a fully-decided `UnknownN` is already
  a zero-face shell that §4.27's stale-shell sweep deletes on every
  read. The reference-set
  pane exposes **Remove person** as a button, and **Update person**
  directly above it (§4.38).
- **Group management & drag-and-drop** (§4.16): real group branches
  (not the status branches) can be **renamed/moved**
  (a path dialog, prefilled; the whole subtree follows the prefix rewrite)
  and **deleted** (persons — incl. sub-branches — fall to their status
  seats, §4.35; faces
  untouched). Persons and multi-selections **move to a group** via the
  person context menu (path dialog) or by **dragging** rows onto a branch
  node (unfile = *Move to group…* with an empty input — §4.16); whole branches drag the same way (a drop onto
  the branch itself or into its own subtree is refused). Drops and dialog
  submits normalise the path like every other group write.
- **Add group…** (§4.18): the **person-row**
  context menu offers *add group…* (multi-select: *add group to N
  persons…*) — a path dialog whose submit adds the typed path as an
  **additional** membership: every current **user** group of the person(s)
  is kept — a status seat, if present, is dropped instead (filing
  replaces the seat, §4.35)
  (`move_persons_to_group`-replace stays with *Move to group…*; the add
  runs `move_persons_between_groups` with `from = ''`, §4.16), so the
  group can never be empty — the person is in it — and the entry is
  never disabled. The **branch and root menus offer no such entry**:
  branches derive from person paths, so a branch-level entry could only
  move the selection or do nothing, and the root's empty-space menu goes
  with its only item.
- **Full images get their own context menu**: the webview default
  menu's entries ("open image in new window", …) are not functional inside
  Tauri, so image areas intercept `contextmenu` and offer a WhoT menu —
  the **open in system viewer** entry (the Rust `open_image` command
  writes the BLOB to a temp file and hands it to the opener plugin) and
  the rotate entries (§4.32).
  **The `open_image` temp file is unique and magic-sniffed**:
  the name `whot-image-{image_id}-{pid}-{unix_nanos}.jpg` is unique per
  open — the same image opened twice never clobbers the first viewer's
  still-loading file, and the path cannot be pre-squatted by another
  local user — and the extension is derived from the pixel magic
  (JPEG default, PNG recognised), not hard-coded. The frontend handler
  routes a failure (no preview blob, viewer not found) through the
  standard error toast like every other mutation path.
- **Resizable panes**: the two pane dividers (left|centre and
  centre|right) are draggable with clamps and double-click reset (session
  state);
  the face/image grids reflow via `auto-fill` and follow the pane
  sizes. In **Rolls mode while browsing** (§4.39) the centre|right
  divider resizes the **centre** instead — see §4.39's layout rule (the
  centre starts at the left pane's width, drags clamp 10%..70% of the
  window, double-click returns to the left-following default).
- **Person view**: clicking a person in the tree shows *that person's* faces
  in the center pane, **partitioned by appearance** (distinct description)
  and then **grouped by similarity to the primary face** within each
  appearance (single-linkage, `cluster_threshold`, section shows min
  similarity) so impostors stand out; when a person has more than one
  appearance, section headers carry the appearance name. Same
  selection/operations as Review.
- **Right pane — person detail** (when a person is selected): name (editable
  for known persons), group path (editable, `|`-separated; empty ⇒
  the person's status seat, §4.35 — and read-only for the system person
  `Rejected`), note, primary-face picker, refcrops list.
  **The avatar click opens the primary face's image**: the large
  avatar *is* the primary face, and clicking it opens the **full-image
  focus mode** for that face's image (the same `confirmContext` →
  `setSplitImageId` path as the card double-click and the "Open full
  image" menu entries), with the tooltip/title saying so; when the person
  has no primary face there is nothing to open and the click stays inert.
  (Primary-face *setting* is the refcrop list above, not the avatar.)
- **Right pane — branch thumbnails** (Rolls mode, §4.39): while
  the user browses the path hierarchy, the right pane holds the
  **selected branch's images** — the direct children of that path only
  (no recursion), filename order, Show-filtered (§4.10) — as
  thumbnails: plain click selects (ctrl/⌘ toggle, shift range),
  **double-click opens the image** (the image detail), the
  context menu carries the image actions (§4.39). This thumbnails pane
  **replaces the person detail/Overview while browsing** (the person
  detail is Review/Person mode's pane); the import pane (§4.36) keeps
  precedence while open, and **once an image is open the pane returns
  to the person detail** for face/person editing (§4.37/§4.39).
- **Rule bar (bottom)**: always visible when ≥1 face is selected **or a
  stage is live**, in any center-pane view: `N selected · [Apply] [Accept]
  [Undo°] [Edit…] [Reject] [clear]` (§4.30) — `Apply` stages a
  preview (a `staged: …` strip shows it), `Accept` commits it, `Undo`
  greys out without a preview; `Edit…` opens the shared Edit dialog
  with scope preset to Selection (§4.24).

- **Face card**: top to bottom — the **name strip inside the image
  frame at the top** (label; edited via the card's **Edit…** dialog, §4.24),
  the image, **group** and **description** as full-width label rows
  (descriptions are `|`-separated tags), **accuracy + Edit…**, then the
  action row — star (set as primary), status badge
  (provisional/confirmed/rejected), reject button.
  An **empty** group or description label shows a **dimmed hint** instead of
  a bare dash — group: e.g. `Friends|School`, description: the neutral word
  **`description`** — so the row reads as “where this may go / what may be
  noted” rather than as a hole (the feature-example hint
  `glasses|beard` lives in the Edit dialog's placeholder
  `e.g. beard|glasses`). The section-heading rule labels use
  the same hints. The hint is dim; real values keep their normal
  colours. (The empty-state modifier class is `is-empty`, distinct from
  the app-level `.empty` no-results rule.)
  Double-click opens the full-image focus mode (§3).
- **Accept/reject asymmetry**: *accepted* (`confirmed`) is the
  default status, so the card's reject **button** is the only styled
  action embellishment; acceptance is indicated by the status badge's
  `✓`. Tooltips on both states spell this out. More generally, every
  tooltip is user-facing prose: sentence-style capitalisation, no issue
  numbers, and cryptic-symbol buttons (`⌃`/`⌄`, `✕`) always name their
  action.
- **Input families** (§4.20): group-path inputs and face-description
  inputs carry different frames and backgrounds everywhere they appear —
  solid accent-tinted frame for group paths, dashed second-accent frame
  for descriptions — so *where a person lives* and *what a face looks
  like* are never confusable at a glance (frame style also carries the
  distinction for colour-blind users).

## 4. Behaviour rules (decided)

1. **Assign a person** (core operation — accept + name + group):
   - If all selected faces belong to *one* `UnknownN` and the user keeps/
     supplies a name for that person: **rename in place** — `persons.name`,
     replace `person_groups` with the given path (empty ⇒ the person's
     status seat, §4.35), all selected faces
     `link_status='confirmed'` — **claim rule (§4.35): this includes any
     `rejected` faces in the selection, which an assignment un-rejects**
     (§4.2). The
     `UnknownN` number is never reused (importer numbering
     is max-based over remaining names — safe).
   - If selected faces span multiple persons or the name is new: move the
     selected faces to that person (create if needed), `confirmed` (claim
     rule §4.35 — a `rejected` face in the selection is un-rejected by
     the move), `reassigned=1`. Faces **not**
     selected stay with their original person
     (e.g. `UnknownN`) for later assignment or rejection.
   - Assigning to a name that matches an **existing person merges** the
     selection into that person (names are not required to be unique for
     assign); the target person's group path and note are **left untouched**
     in that case. The group field only applies to the rename-in-place /
     new-person branches. The same holds for a **tree
     rename**: it is routed through `assign_person` over *all* the person's
     faces, so a misspelling corrected to an existing name merges instead
     of erroring. A person left with **zero faces** by an assignment is
     deleted (stale shell — §4.13 housekeeping). This applies to **every
     GUI rename** (tree, context menu, detail pane) via one rename-merge
     helper: the `set_person_name` collision error can never surface in
     the GUI; a *faceless* person renamed to an existing name merges by
     deletion, an empty input is a no-op, and a rename keeps the
     person's current **real** group path: a **status seat is never
     passed** into the assignment (`assign_person` validates the path up
     front — reserved segments are refused, §4.35). The seat derives by
     state instead: the claim confirms the person's faces, so an unfiled
     `UnknownN` renamed in place lands on **Accepted** automatically — a
     caller can never write `New`, and an empty path derives by state.
     In the **merge** case the
     group is never applied, so a rename-to-known simply
     re-anchors the pane on the target (§4.38) — no group error is
     possible. A **detail-pane rename-merge**
     re-anchors the right pane on the surviving person — the merge
     target when the name was taken (§4.38: the pane must keep
     showing the person the faces now belong to).
   - After any assignment the person enters the importer's *known corpus*
     automatically (name not `Unknown*` + confirmed faces); corpus entries
     are per `(person, description)` — see §4.12.
2. **Reject** ⇒ `link_status='rejected'` **and the face moves onto the
   system person `Rejected`** (group `Rejected`, created on demand —
   §4.35): the assignment is deemed invalid, so the face leaves the person
   it was on; `seq`/`name` re-derive against `Rejected` (§4.7) and the
   origin person is recomputed (primary/refcrops/seat, §4.5/§4.6/§4.35).
   Rejected faces: excluded from similarity grouping, primary-face
   eligibility, refcrops and importer corpora, and **visible only under
   `Show → Rejected`** (§4.10). **Exit is assignment alone — the claim
   rule:** plain Accept never
   un-rejects (§4.3); only an explicit assignment (assign, rename, merge,
   move, section rule, the Edit dialog committed with a name) un-rejects
   the faces it claims *and* moves them to the target. A rejected face can
   only enter a selection while `Show = Rejected`, so claiming is always a
   deliberate act.
3. **Accept (without rename)** ⇒ selected faces `link_status='confirmed'`
   (stay with their current person; confirm an `UnknownN` as-is).
   `rejected` faces in the scope are **skipped** — accept never un-rejects
   (§4.2); and when the person holds no user-given group, the accept
   re-seats it `Accepted` (§4.35).
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
   UNIQUE per row (a face is a refcrop of at most one person).
7. **Face `name` derivation** ⇒ `person.name[-description]-seq`; `seq` is
   per (person, description) as in the importer, computed as `MAX(seq)+1`
   (gap-proof, so labels stay unique within a person even after faces are
   moved out and back in). On a move, a face gets the next free
   seq of its new person; renames only re-derive names, description edits
   re-derive names *and* re-assign seq within the new group (§4.4).
8. **Sync** ⇒ every mutation runs in one SQLite transaction; the frontend
   then re-fetches `get_snapshot()` and re-renders tree, grid, detail pane,
   rule bar and rolls. Image BLOBs are fetched lazily per card and cached by
   `face_id`/`image_id` (content never changes, cache never invalidated).
   External changes (a roll imported while the GUI is open) become visible
   via a **manual refresh button** in the top bar and an automatic re-fetch
   when the window regains focus/visibility; focus-refetch errors are
   ignored so they cannot stomp the current view.
9. **Similarity grouping** (person view only) uses the same single-linkage
   cosine rule and default 0.40 threshold as the importer — it is a display
   aid for impostors, it does *not* re-cluster or reassign anything; the
   importer's grouping is authoritative (no redundant global re-clustering).
   The clustering runs **within each appearance group** (distinct
   `COALESCE(description,'')`), against the same primary-face reference
   (§4.9/§3), so another legitimate appearance reads as its own appearance
   section instead of an impostor cluster — and a true impostor still shows
   as a low-similarity cluster inside the appearance it impersonates.
   The clustering is display-only code that must **degrade, not panic**,
   on corrupted embeddings: a non-finite cosine result (`NaN`/±inf)
   is treated exactly like the missing-embedding case — no similarity
   evidence, `0.0`, keeping every stored similarity finite — and no
   comparison site may `unwrap` a `partial_cmp` on non-finite data
   (orderings use `unwrap_or(Ordering::Equal)`).
   A **cluster-group toggle** sits in the Person view's centre toolbar —
   **only** there (hidden in Review and Rolls, where it changes
   nothing) — hugging its right edge. (The Show filter is a **global**
   control in the top bar.) Its values:
   `Accuracy` (default) keeps the rule above; `Description`
   collapses each appearance to **one section per distinct description**
   over the visible faces — no similarity split: the threshold is not
   consulted and `person_face_clusters` is not called (no IPC). The
   §4.24 staged preview drives the grouping too: a face with a
   **staged** description groups under the description it will land in
   on **Accept** — the preview shows the staged label in the section it
   belongs to; commit, Undo and Cancel return the committed grouping.
   Sections
   are ordered by first appearance with the empty description last,
   titled `(no description)`, and make no
   similarity claims in this mode. The choice persists as
   `cluster_group` in `whotrc.json` (`accuracy` default).
10. **Status filter** (`face_filter`) ⇒
    `Show [All | New | Accepted | Rejected]` in the top bar: one
    setting (whotrc `face_filter`: `all` (default) | `provisional` — UI
    label **New**, the face-card badge's word — | `confirmed` —
    UI label **Accepted** — | `rejected`). **`All` means every face
    *except* `rejected`**: rejected faces are visible **only**
    under an explicit `Show → Rejected`, so the reject bin can never
    surprise the user mid-review. A legacy `show_rejected` key in the
    config file is ignored on read. The Show control's **tooltip spells
    this out** (the user-facing contract): `All = everything
    except rejected; rejected faces appear only under Show → Rejected
    (§4.10); switching it drops hidden faces from the selection`.
    The chosen status decides **every view's**
    visibility: the person view's cluster sections and its Rejected
    section, image grids and full-image rectangles, the review grid, the
    **left-pane person presence** — a person holding no face that
    matches the filter leaves the tree (set Show back to All to list
    everyone again, including the faceless shells; the system person
    `Rejected` is listed **only** under `Show → Rejected`, never under
    `All` — §4.35) — the
    **Rolls path tree** — an image holding no face that matches
    the filter is dropped from its branch and a branch left without a
    listing image is pruned entirely (raw branch counts stay, so the
    pruned branch is discoverable; under the new `All` this prunes
    images holding *only* rejected faces, and counts as "no face
    matches" — a `no-face` image still lists under `All`) — and the
    **right-pane overview totals** (under `All` they therefore exclude
    rejected faces; the rejected total reads under `Show → Rejected`).
    The badges of the persons that stay
    listed carry their raw totals: the filter changes who is
    listed, never any counters. A selection survives its person dropping
    out of the tree — the person view simply shows nothing for them under
    the filter. `link_status`
    never changes: the filter is pure display. Switching it **drops
    non-matching faces from the selection**: faces the filter hides can
    never be bulk-acted on — which is what makes the claim rule (§4.2,
    §4.35) safe: rejected faces are unreachable except while
    `Show = Rejected`.
    **Review special case**: `All`/`Provisional` show the pending set
    (provisional — the default review), `Accepted` shows
    confirmed faces, `Rejected` shows the reject bin — every rejected
    face on the one system person `Rejected` (§4.35), so it renders as a
    single section to **assign from**; Accept is inert there (§4.2).
11. **Full-image annotation** ⇒ every full-size image draws one rectangle
    per visible face from `faces.x/y/w/h` against the canonical
    `images.width/height` coordinate space, percentage-scaled so it stays
    correct at any rendered size. Rectangles are active: hover highlights
    rectangle + card (shared hover state), click toggles selection **and
    re-anchors the right pane on the face's person (§4.37)**; colours
    follow `link_status` (warn/ok/bad). `no-face` images and hidden faces
    (§4.10) draw no rectangles.
12. **Import-time appearance inheritance** ⇒ the importer's
    known/unknown corpora are keyed by `(person, COALESCE(description,''))` —
    a *partition* of the person's confirmed vectors, so the winning person
    and match/no-match are identical to pooled matching (max over a
    partition = max over the set; vector row order is fixed with
    `ORDER BY faces.id`, corpus wins ties over unknowns). The matched face
    **inherits the winning group's description** at insert time (`''` ⇒
    none), takes its `seq` from that `(person, description)` group, and its
    label derives accordingly — imported matches arrive already labelled
    with the appearance they matched. Faces with no match above threshold
    still cluster into new `UnknownN` persons.
13. **Removing a person** ⇒ `remove_persons(person_ids)`, one
    transaction per call: every face of each person becomes
    `link_status='rejected'` and **moves to the system person `Rejected`**
    (§4.2/§4.35 — every path that rejects a face lands it there, so no
    writer ever leaves a face unowned; `faces.person_id` stays nullable in
    the DDL but is never written `NULL`), and the person row is deleted —
    `person_groups` and `person_refcrops` cascade, any *other* person's
    stale primary pointer at these faces is cleared first. **No undo**
    (the faces themselves are never deleted; they sit in the reject bin
    and can be re-claimed **only by an assignment** — §4.2/§4.35 — which
    un-rejects and moves them). With `face_filter` set to anything but
    `Rejected` (§4.10) the removed faces vanish
    immediately (the image-detail grid shows no *unassigned* section — no
    unowned faces exist). The system
    person `Rejected` itself **cannot be removed** (§4.35). Available from
    the person-tile context menu (also for a
    multi-selection), the reference-set pane and — batched — from tree
    branch menus (§3).
14. **Selection-scoped face actions** ⇒ every face action has one
    *effective scope*: the active selection when the invoked card is part
    of it (`sel.size > 1`), otherwise just that card. Context-menu entries
    (*Accept*, *Reject*, *Edit…*) and the card's ✗/undo button
    all honour this scope — the same ids the rule-bar buttons would act
    on — so "select whole section → reject" rejects the section from any
    entry point. **One-item-only actions are greyed out (disabled)
    whenever the effective scope would exceed one item — never silently
    applied to a single one**: on the face side
    **★ set as primary**, **◈ add as reference**, **Rotate crop 90° …**
    and **Open full image** (focus mode shows one image); on the
    thumbnail side **Open image** and **Open full image (focused)**; on
    the tree person menu **Open person**, **Rename…** (inline rename is
    single-person — the multi-scope has *Rename N persons to…*) and
    **Select their pending faces** (the move/add/merge/remove entries
    already speak N). **Opening the shared Edit dialog
    follows the selection** (§4.24): on a card inside the current
    selection the selection is kept — an active selection, **of any size,
    including a single face**, is itself the answer to "just this
    face or whole group?"; on a card outside it, the selection becomes
    that card. Cards and headers carry labels, not inputs (§4.24).
15. **Split-pane lifecycle** ⇒ the double-click image
    split:
    - a **tree-row select** (plain, ctrl/cmd or shift) and **person
      stepping** (‹ › / ← →) **always** end it — selecting another
      person means the attention has shifted to them, whether or not
      they have a face on the open image;
    - a **card/rectangle select** ends it when the new selection's
      `image_id` differs from `splitImageId` and it **stays open** when
      the new selection is a face **on the open image** (focus mode
      depends on this);
    - manual opens — card double-click, *Open beside (split)*, *Open
      full image* — always win; Esc/× keep their meaning. In the
      rectangle context menu the *Open full image* entry is hidden
      while `face.image_id` is already the open image.
16. **Group management** ⇒ membership-only operations in one
    transaction each; faces, names, statuses, primaries and refcrops are
    untouched:
    - `rename_group(old, new)` — rewrites the path prefix for every person
      inside the branch (the branch itself or any sub-branch). `new`
      empty ⇒ every person in the subtree **falls to their status seat**
      (§4.35 — group invariant: never zero rows). A branch cannot be
      moved inside itself (`new == old` or `new` prefixed by `old`).
      **A clash with an existing branch is a merge, never an error**:
      when a person is a member of both the source branch and the
      destination path (the `person_groups` key `(person_id, path)`), the
      rewrite must not surface the unique-constraint failure — the
      conflicting source rows are dropped (the person keeps the single
      destination row) and the remaining source rows are rewritten. The
      net effect: every source member now holds the destination group,
      the source group is removed from them, and the source branch is
      gone once emptied — the source is absorbed by the destination.
      A branch that is **entirely** absorbed still counts as a successful
      rename (the emptiness check is taken against the branch's rows
      BEFORE the rewrite, so an all-clashing branch does not read as
      “no persons in that group”).
    - `delete_group(path)` — deletes the `person_groups` rows of the whole
      subtree, then seats those persons by state (§4.35; structure below
      the branch is not preserved — re-group by move/rename).
    - `move_persons_to_group(person_ids, group)` — replaces each person's
      group path with the target (empty ⇒ the person **falls to their
      status seat**, §4.35 — this is the *unfile* gesture); works for
      any
      selection, wherever the persons live (incl. the status branches).
    All three normalise the path and reject the **reserved
    segments** `Ungrouped`, `New`, `Accepted`, `Rejected` and
    `Unknown` (§4.35: status seats are system-written — no typed path,
    dialog or drop may produce them; `Ungrouped` is not a state — every
    person always has a group row).
    **The status branches carry no branch menu and are not drop
    targets** (they are system furniture);
    the persons *inside* them are ordinary rows (select, drag out,
    remove).
    GUI entry points: branch menu (*rename/move…*, *delete group* with
    confirm dialog) — real branches only —, person menu (*move to group…*
    for the selection), and
    drag-and-drop of persons/selections/branches onto branch nodes
    (status branches are not draggable/renameable themselves; unfile via
    *Move to group…* with an empty input, which seats the person instead
    of leaving them groupless).
    **D&D move semantics**: a person drop
    re-homes **the dragged membership only** — the row's own group path
    (its placement) is removed from the person, the person is filed into
    the target branch (`move_persons_between_groups`; `INSERT OR IGNORE`
    dedupes when the target row already exists, e.g. dragging Christiaan
    Swart from `Friends` onto `Friends|Swartse` leaves exactly
    `Friends|Swartse`), and **all other memberships are kept** — a
    multi-group person stays multi-group. Dropping onto a branch the row
    already belongs to is a **no-op** (the person already renders there).
    The §4.16 dialog entry points (person menu *move to group…*, review
    bulk group apply) keep the replace-all meaning — they do not carry a
    placement context.

    **Display guarantees**: group paths are **case-significant**
    — `Family|Lombards` and `family|Lombard` are distinct data and each
    renders its own branch (the builder is case-sensitive; do not fold).
    Under the **All** face-status filter and an empty text filter, **every
    person in the snapshot is findable in the tree** — including faceless
    named persons (their own branch, or their status seat when unfiled,
    §4.35). Under New/Accepted/Rejected the
    tree lists only persons holding ≥ 1 face of that status (§4.10) — a
    person with no matching face is not listed, so reach them
    by switching Show to All. The badges of the persons that stay listed
    always carry their raw totals; the filter changes who is
    listed and which faces render in the middle pane, never whose faces
    exist or their counts. A person renders under **every** listed path
    (see §3); further groups stay visible in the row tooltip.
    A branch whose listed persons are all filtered out disappears with
    them; the system person `Rejected` is listed only under
    `Show → Rejected` (§4.35), so its branch is invisible under every
    other setting.
17. **Selection accelerators** ⇒ Ctrl/⌘-click on a face-card body
    toggles that card in the selection — the tree's idiom, mirrored
    on cards; plain click stays inert so double-click-to-open is
    unaffected. **Ctrl-G** toggles the whole section: the one holding the
    hovered card, else the one holding the most recently selected card
    (no-op when neither exists); all-selected ⇒ deselect, otherwise
    select all. Shortcuts obey the existing guards (never while an input
    or dialog has focus, `preventDefault` so webkit cannot steal Ctrl-G)
    and are listed in the settings popover.
18. **Add group…** ⇒ context menu of **person
    rows** (*add group…*; multi-select: *add group to N persons…*): a
    `GroupDialog` (empty prefill, §4.21 wholesale-select) whose submit
    **adds** the typed path as another membership via
    `move_persons_between_groups(ids, '', path)` (§4.16 — `INSERT OR
    IGNORE`, every other membership kept; *Move to group…* keeps the
    replace-all semantics beside it). The group can never be empty (the
    person joins it), so the entry is never disabled. The **branch and
    root menus do not offer it** — with branches derived from person
    paths the branch entry could only move the selection (disabled
    without one) or, wrongly read, "create" something invisible — so the tree
    root's empty-space menu offers no group item there. The status
    branches still offer no group menu of their own (§4.35).

    **The same entry lives in the FACE context menu**: when the
    effective scope's faces belong to **N distinct persons** the menu
    offers *Add group…* / *Add group to N persons…*, opening the same
    `GroupDialog` with the add semantics over those persons — a set of
    photos (person cards, a cluster, a full image) can be filed under a
    branch straight from the face domain; unowned faces count for
    nothing and an all-unowned scope leaves the entry disabled.

    **Append mode does not exist**: no menu pre-fills a `|`-terminated
    path — every group dialog opens in *replace* mode: the structural
    path is selected wholesale on focus, and selecting an empty value is
    a no-op.
19. **Full-image focus mode** ⇒ opening a full image (card
    double-click or *Open full image*) turns the center pane into a
    focused workspace: the annotated image spans the pane's full width
    (height-fitted, §4.11) — **on entry the right pane follows
    the opening face's person (§4.37)** — with a **film roll** below — one
    horizontal, scrollable strip of that image's face cards (all card
    operations keep working; no other faces are shown). The image and its
    header row are **pinned at the top** of the pane while the film roll
    scrolls beneath it — the user works against the image, so it
    never scrolls out of sight; the pinned block gets a solid backdrop so
    cards pass behind it cleanly. The regular grid
    is hidden while the mode is active; it returns when the mode ends:
    × / **Esc**, a left-pane selection or person stepping (§4.15), or
    explicit navigation (top-bar tabs, *Review*). Selection and view
    state survive the mode; there is no side-by-side split (the
    regular grid returns when the mode ends).
20. **Input families** ⇒ group-path inputs (`family|lombards`) and
    face-description inputs (`beard|glasses`) are **visually distinct**
    everywhere they appear: group paths get a solid accent-tinted frame
    and slightly tinted background (structural, hierarchical value),
    descriptions a dashed frame in a second accent colour (free-form
    per-face tags) — the frame *style* carries the distinction for
    colour-blind users, the hues only reinforce it. Applied to the
    section rule bar's group field, the face-card desc input, the
    EditDialog/GroupDialog group fields and the detail pane's Group
    field (Name/Note keep the default look; `Editable` has a variant).
    The tints stay legible in the dark theme and clear of the
    warn/ok/bad status colours.
21. **Auto-filled fields & name typeahead** ⇒ two related input
    behaviours:
    - **Select-all for generated values**: when an input holds
      *auto-generated* text — today an `UnknownN` name — focusing it
      *or clicking into it* selects the whole value (for as long as it
      stays auto-generated), so the first keystroke replaces it
      wholesale. User-entered values keep normal caret behaviour.
      Applied everywhere such a value can appear: the §4.24 Edit
      dialog's pre-filled fields, the tree inline rename, the detail-pane
      Name field. **Group-path inputs** go further
      and always select all on focus, user-entered value or not — a
      group path is a structural value that is replaced wholesale,
      never edited in place — on focus and on click alike.
    - **Name typeahead**: the EditDialog and the detail-pane Name
      field suggest existing persons (substring match, max 8, `UnknownN`
      names excluded — the point is to reach a real name; each row shows
      the person's group because **picking a suggestion merges into that
      person**, assign-not-rename §3). Arrow keys + Enter navigate,
      Enter without a highlight submits the typed value, Esc closes the
      dropdown before it touches anything else. In the EditDialog a
      pick mirrors the target's group into the group field (unless the
      user already typed one).
    - **Every value field suggests**: the name
      typeahead (existing persons, `UnknownN` excluded, pick = merge
      target) and the group-path suggestions (no `ungrouped` quick-pick
      — an empty input seats, §4.35)
      live wherever a value is typed: **the §4.24 Edit dialog** (name
      and group; description stays free text), the detail-pane
      Name/Group, the tree inline rename, `GroupDialog` and the merge
      dialog's bulk-group field — the grid's own fields are labels.
      One shared widget backs all of it (options + label +
      hint — navigation/Enter/Esc behave identically everywhere); a
      pick never counts as leaving (mousedown keeps focus), and
      click-away still commits where fields stayed inline. Free text
      stays plain: descriptions, notes, the tree filter, the alias
      list, settings numbers.
22. **Keyboard shortcut set** ⇒ shortcuts act on the
    selection, or on the hovered/last-selected card when nothing is
    selected (the Ctrl-G rule): **Ctrl-G** toggles the section **under
    the mouse cursor** — no prior click or card hover required (cursor
    hit-test via the section's `data-section-key`) — falling back
    to the hovered/last-selected card's section; **Space** toggles
    the card itself, **Ctrl-A** selects
    all cards of the current view, **A**/**R** accept/reject the
    selection (the rule-bar buttons' scope), ←/→ step persons (**not in
    Rolls**) and
    Esc closes split/dialog/menu (§4.19). Shortcuts are suppressed while
    typing in any input and while a menu or dialog is open. Context-menu
    items display their shortcut as a right-aligned dim hint
    (`MenuItem.hint`); the rule-bar tooltips and the settings popover's
    Keyboard list document the set. No shortcuts for destructive
    actions (remove person, delete group) — they keep confirm dialogs.
23. **Anchor + shift-click ranges** ⇒ a plain card click selects
    just that card and drops the *range anchor*; **Shift-click** selects
    the contiguous run of rendered cards from the anchor up to and
    including the clicked card, replacing the selection. Ranges are
    computed over the flat rendered order, so they may span section
    boundaries — the context menus, rule-bar buttons and A/R shortcuts
    then act on the whole set through the existing selection scope
    (§4.14). Ctrl/⌘-click keeps its toggle meaning and moves the
    anchor when it selects; Space follows the hovered card. A vanished
    anchor (filtered/removed card) degrades shift-click to a plain
    select. Double-click-to-open is unaffected.
24. **Grid editing: labels + one Edit dialog** ⇒
    - **Cards and cluster headers show labels, not inputs**: the three
      value fields — **name, group, description** (headers gain the
      description label; cards show all three) — are per-object,
      **live labels** (an empty group/description renders as the dimmed
      hint, §Face card) plus one **Edit…** button.
      The fields stay **visually
      distinct**: name plain, group accent-coloured, description in the
      tag colour. Card order top to bottom: the **name
      strip inside the image frame at the top**, the image, **group**
      and **description** as full-width rows, then **accuracy + Edit…**
      (and the ★/◈/✗ action row). Labels are display only: they update
      per object when an apply/accept changed some cards and not others,
      and a pending preview marks them — **unmistakably** (accent tint
      + underline + weight), echoed by a `staged: …` strip on the
      bottom bar while a stage is live. Empty group/description render as
      the dimmed hints (§Face card: `Friends|School` / `description`).
      Apply with **no changed field**
      raises the "nothing to apply" toast; Accept with no changes still
      accepts the scope (§4.30).
    - **One shared dialog**: three labelled fields — name, group,
      description — each carrying the §4.21 suggestions (a picked name
      mirrors its group unless one was typed), plus a scope selector
      `Card | Group | Selection` with a live face count (H3). Opening
      it follows the selection rules: on an object **inside** the
      current selection the selection is kept; **outside**, the
      selection becomes that card (header → that cluster). The
      **scope default follows the invocation site**: Edit on a **card
      → `Card`**, Edit on a **header →
      `Group`**, bottom bar → **`Selection`** (greyed at N = 0); the
      selector switches scope explicitly and **Apply binds the stage to
      the chosen scope's faceIds**; Accept commits those staged ops and
      then accepts the **chosen scope** (the staged set supplies the
      edits, never the acceptance scope).
    - **Buttons**: `Apply` = stage + close (screen preview), `Accept` =
      commit the staged ops, then accept the chosen scope (the shortcut
      — “Accept is what makes my changes permanent”), `Reject` = the
      scope’s verdict,
      `Cancel`/Esc = discard the pending set. **Enter = Accept**, **Esc
      = Cancel** — inside the dialog only.
    - **Reject in the dialog**: acts on the chosen scope (Card →
      that face; Group → the cluster; Selection → the selected set),
      **commits immediately** (a verdict, not a field edit — the same
      path as the rule-bar Reject; §4.2) and closes
      the dialog. Pending ops touching rejected faces are dropped from
      the set (the commit would skip them anyway). A fully-rejected
      scope makes the dialog an **assignment** (§4.35): with a name typed
      its Accept claims the scope (un-rejects + moves), without one the
      Accept stays inert with the info toast “assign a person to bring
      it back”. No
      dialog key for it — Enter/Esc keep their meaning.
    - **Scope**: every action targets the **selection**; bottom-bar
      buttons and plain keys never confirm, and the dialog's selector is
      the *only* object-vs-selection disambiguation, chosen before
      anything runs — no confirmation dialog is needed.
    - **Stage / preview state — the pending set**: the
      stage is an **accumulating set of pending ops**, one per Apply —
      `{faceIds, name?, group?, desc?}` bound to that Apply's scope.
      The working loop is **Apply → change → Apply → … until Accept or
      Cancel**: Apply never commits, it only extends the set (screen
      preview on the labels, the `staged: …` strip shows the whole set;
      in Description mode the preview includes the **section
      regrouping**); **Accept commits every op** through the same field
      routing as the commit below and drives the review advance off the
      committed ids; a
      re-Apply on the **same faceIds** replaces that op (latest wins); **Undo and
      Cancel/Esc discard the whole set** (Undo = Cancel — re-editing is
      just opening Edit… again).
      **Apply always has a concrete target**: the bar's Apply
      stays enabled while a staged set is live even when the selection
      is empty (staged ops survive selection changes by design) — with
      an empty selection, `barApply` scopes the dialog's Selection onto
      the **staged set's face ids** (largest staged set first), so the
      opened dialog always has a concrete target; when neither a
      selection nor a staged set exists, Apply is disabled anyway
      (RuleBar's `none && !stageLive`).
      **A failed commit keeps the staged set**: the set is
      cleared **only after the whole commit lands** — the ops execute
      one by one, and a failure re-stages the failed op **and everything
      after it** (the applied prefix stays; the error toast names the op
      that stopped the commit), so the staged strip keeps showing what
      remains and Accept can simply be retried. The staged field writes
      are idempotent, so the retry re-applies nothing visibly.
    - **No dialog inside the context**: changing the selection
      while the set is live — clicking another card, extending the
      selection, opening Edit… on another card (whose selection rule
      then makes the card the selection) — is **part of the Apply loop
      and never asks**. The drop/accept dialog comes up **only when the
      context changes completely**: selecting/stepping to **another
      person**, or switching the view context (top-bar tabs / focus)
      with a live set. In that dialog **both branches move the context**
      *accept* commits the set first, then the
      context switches; *cancel* discards it, then the context switches.
      Text is never dropped silently.
      **"Open image" is a view-context change**: the image menu's
      "Open image" and a right-pane thumbnail double-click rebind
      the centre pane to another image and therefore go through
      `confirmContext`
      (discard-or-accept of a live staged set) like every
      tab/step/tree/focus route.
    - **The stored context-confirm action is object-wrapped**:
      the pending action is kept as `useState<{fn} | null>` and set with
      `setContextConfirm({ fn: action })` — a bare function passed to a
      `useState` setter is read by React as a function-form updater and
      **executed immediately** (storing its `undefined` return) instead
      of being stored, which would silently disable the dialog (gui-mock
      C5 locks the wrapper in place).
    - **Commit keeps the field routing** — a name change through
      `assign_person` (group applied on create/UnknownN-rename, later
      explicit groups via `set_person_group`), a group-only change
      through `set_person_group`, a description change through its own
      setter — an empty field counts as unchanged.
      **Accept never un-rejects (§4.2):** a stage may display on a
      rejected face, a plain accept-commit skips it — while
      committing a **name** to it is the claim (§4.35: the assignment
      un-rejects).
      **The pending-op drop is owned by `doReject` and the filter
      change**: dropped pending ops (now-rejected faces, §4.2)
      are not special-cased per entry point — the drop lives inside
      `doReject`, so every reject path (bar ✗, `R` key, card ✗,
      context-menu Reject, Edit-dialog Reject) drops staged ops touching
      now-rejected faces by construction, and `changeFaceFilter` drops
      the stages of the faces the new filter hides — staged ops on
      rejected or hidden faces must never remain in the set for the
      next commit (invisible and silently committed otherwise).
    - The right-panel DetailPane and
      the tree inline rename **stay inline** (a single person, no
      scope ambiguity); the grid's cards, cluster headers and rule bar
      carry only labels plus the shared Edit dialog (no inline inputs, no
      per-object apply buttons, no auto-apply on focus).
    - **ONE label — `Edit…` — for every opener**: the card
      button, the cluster-header button, the face context menu item
      (the scope suffix stays: `Edit… (N selected)`) and the rule-bar
      button all read `Edit…`, and the dialog's title is *Edit* —
      “Edit” is the program-wide term for the function (assign a person
      / set name, group, description).
25. **Cursor-as-target rule** ⇒ with no explicit
    selection the mouse cursor decides the target: a face-card context
    menu opened on an **empty selection selects that card first**
    (anchor + last-selected), so the menu's scope, the rule bar and the
    letter shortcuts all agree; **A**/**R** fall back to the hovered
    card instead of no-oping. Ctrl-G's cursor hit-test (§4.22) and
    Space's hovered-card scope are the same rule — the cursor is the
    implicit selection whenever there is no explicit one. **←/→**
    stepping honours it too: with no selected person the first
    step starts from the person under the cursor (tree rows expose
    `data-person-id`); when the cursor is over no person row (e.g. it is
    over the ‹ › buttons themselves) the step bases on the **last
    anchored person's position** in the current step list, clamped to the
    list's bounds — so stepping from an anchor that has just left
    the list (a verdict drained it, §4.10 pruned it under Show → New)
    continues where the user left off instead of jumping to the list's
    start/end and losing the place; only when no person was ever anchored
    does the step fall back to the list's start/end.
26. **Copyable errors** ⇒ every error surfaced by the app — the
    fatal `loadError` screen and the runtime error toast — must be
    cleanly copyable for filing issues:
    - error text is selectable (`user-select: text`) and **wraps/scrolls**
      instead of clipping at `max-width`;
    - a **Copy** button writes the full, untruncated message to the
      clipboard (one click; includes the operation that failed and the
      raw error string);
    - the toast does **not** dismiss on a plain click (clicks exist for
      selecting the text): dismissal is an explicit
      **✕** button, or the toast
      stays until replaced/cleared; selecting text inside it never
      dismisses it.
    - **info vs error**: expected no-ops and guidance — “nothing to
      apply — change a field first”, “nothing to merge — the selected
      persons have no faces”, “no faces to rename — the selection has no
      faces”, “already merged — the drop target is the only selection”,
      “no more
      persons to review”, “assign a person to bring it back” (rejected
      scope, §4.35) — are **info, not error**: a quiet toast, **no
      Copy button, no ✕**, and it **auto-goes-away on the next user
      action** (any click or keystroke that acts). Real errors (failed
      operations, backend exceptions) keep the copyable red toast with ✕
      — the copyability rule above applies to them only.
27. **Stale-shell sweep** ⇒ on every `get_snapshot()`, persons
    matching `name LIKE 'Unknown%'` with **zero faces** are deleted
    (leftovers from pre-v1.9 runs, external writers — and now also
    `UnknownN`s emptied when the reject-move of §4.2/§4.35 took their
    last face; no code path ever revisits them otherwise). Named persons
    are never swept: an empty *named* person is a legitimate future
    assignment target — and the system person `Rejected` is **never
    swept** either (created on demand, reused by the next reject;
    §4.35). The sweep is one statement inside the snapshot transaction,
    cheap and idempotent.
28. **Merge Similar Persons** ⇒ a triage workflow for same-name
    duplicates (the importer's deliberate `X 2` generations, §9.4 of
    `docs/scripts-design.md`, plus case variants and misspellings):

    **Detection** (pure frontend over `get_snapshot`, no backend path):
    normalize names — `casefold`, collapse whitespace, strip trailing
    ` N` — then cluster by **Damerau-Levenshtein (OSA) distance ≤
    `merge_name_distance`** (whotrc, default **2**, range 1–3) with
    single-linkage. OSA, not plain Levenshtein: a transposition is one
    edit, so the commonest typo class counts as "1 diff". Optional
    **suffix aliases** (`merge_suffix_aliases`, whotrc, default off) —
    equivalence groups (`J,Jr,Junior`) stripped before comparing.
    **`Unknown*` persons are excluded from detection** (`Unknown7` vs
    `Unknown8` is distance 1) and refused as merge targets (§4.1
    `validate_person_name` already enforces the latter server-side).
    Each cluster carries per-pair **link evidence** (same-after-fold /
    seq-suffix / distance-N / suffix-alias) because single-linkage
    chains (A~B, B~C ⇒ {A,B,C} even if A⊀C) must stay explainable.
    Zero-face members are listed but contribute no faces to a merge.

    **Three equivalent entry points**, all feeding one confirmation
    dialog:
    - *review dialog* (tree-header button): cluster list with member
      facts (face counts, group paths, `state='imported'` badge,
      created_at), multi-select, `Merge into…` / bulk group / bulk
      rename;
    - *person context menu*: `Merge into…` (typeahead), `Apply group to
      selection…`, `Rename selection to…` on a (multi-)selection;
    - *drag-and-drop*: dragging a selected set **onto a person row**
      merges into that person — a **second drop-target type**, beside
      the branch drops. Drop-target highlighting must
      distinguish person vs branch unambiguously.

    **Confirmation is mandatory for every merge path** — menu, dialog
    and especially DnD (an accidental drop must not silently destroy):
    one shared dialog spelling `N person(s), M face(s) → <target>`,
    sources emptied and deleted, **no undo** (faces themselves are never
    deleted; §4.13). Branch drops stay dialog-free — moving
    between groups is reversible. The chip row above the dialog's
    **Merge into** input is **selectable** — each source person is a
    chip *button* (hover + selected styling, distinct from the passive
    chip look): clicking a chip prefills the input with that person's
    name and takes the **same target resolution** as the typeahead (the
    summary line and the face math are identical to typing it), the
    resolved target's chip carries the **selected state**, and clicking
    another chip or typing another name moves the target. The row
    always lists **every** source — the target's chip stays, selected,
    and is no longer counted as a source.

    **Post-merge focus**: after a successful merge the centre pane
    opens the **merged target** person — the selection moves there, showing
    all the combined faces (sources are emptied/deleted server-side); a
    failed merge leaves the selection unchanged.

    **Execution = existing §4 commands, zero new SQL paths**: merge is
    one `assign_person(face_ids_of_all_sources, target.name,
    target.group)` (§4.1 semantics: claim on rejected, emptied shells
    deleted, derived state recomputed); bulk group is
    `move_persons_to_group` (§4.16); bulk rename is the rename-merge
    helper (§4.1) — identical resulting names merge. Self-merge is a
    no-op; `UnknownN` targets are refused (server-side and pre-validated
    in the UI, including on drop).

    **Pane UX**: the dialog is **viewport-capped** — the member
    list scrolls, while the title/intro and the action row (`apply
    group`, `rename to…`, `Merge into…`) stay visible (action row
    pinned at the bottom). The row ends with a visible **cancel**
    button (Esc and an overlay click close the dialog too — a visible
    escape is still required): same dismiss as Esc, styled like
    every other dialog's cancel (`secondary`). The intro states the contract: tick the
    persons to combine — **they may come from different clusters** (a
    neighbour beyond the distance can be the same person) — and
    **everything ticked merges into ONE target person, picked in the
    next step**. Affordances: a **cluster-header click toggles all its
    members**; the buttons stay visible (disabled + explanatory title)
    when nothing is selected; every member row and cluster header offers
    a **context menu** with the finalise actions (*Merge into…* — the
    row’s person, or the cluster’s members, as sources; *Rename…*,
    *Apply group…*) so right-clicking a person finds the exit without
    knowing the selection-first flow.

    **Dialog-cap contracts** (gui-mock C15): the cap must actually
    apply when the dialog is open — the served style sheet parses to its
    final rule (`.merge-spacer`) and the open dialog's computed
    `max-height` is the 86vh cap, not `none` (a truncated typeahead
    block desyncs the whole sheet: nothing after the
    typeahead section applies, this dialog included — C15 locks both).
    Also **`.merge-cluster` carries `flex-shrink: 0`** — `.merge-list`
    is a flex column, and without it a capped list does not scroll, it
    *shrinks every cluster item* down to its border height (the
    cluster's `overflow: hidden` then clips the rows away).

    **Settings**: `whotrc.json` carries `merge_name_distance` (default 2,
    clamped 1–3) and `merge_suffix_aliases` (default `[]`), with serde
    defaults so existing files keep loading; editable from the review
    dialog. The detection functions live in one pure TS module,
    unit-tested with **vitest** (the repo's only JS test runner —
    added as a devDependency; a Python mirror is explicitly rejected:
    two implementations of one rule is how they drift).
29. **import_roll decode & CLI contract** ⇒ one canonical
    decode space, full paths in the log, and honest database errors:

    **Decode chain** (`_decode`) — try decoders in order until one
    produces an image; if all fail, the file is a *per-file* failure and
    the batch continues:
    - **RAW** (`.pef/.dng/.cr2/.cr3/.nef/.arw/.rw2/.orf`): `rawpy` —
      use the embedded JPEG thumbnail when present, otherwise
      `postprocess(half_size=True, use_camera_wb=True)`. *Any*
      `rawpy.LibRawError` raised by the thumbnail step (missing **and**
      unsupported/bitmap thumbnails — merged Pano/HDR DNGs raise
      `LibRawUnsupportedThumbnailError`) falls through to the full
      decode instead of failing the file.
    - **everything else**: `cv2.imread` → **Pillow** (`Image.open` +
      `ImageOps.exif_transpose`, converted to RGB) → **tifffile**
      (`.tif/.tiff`, first page). Pillow covers OpenCV's TIFF blind
      spots (crashes on any TIFF carrying an EXIF Orientation tag;
      refuses 32-bit samples), tifffile the formats Pillow refuses.

    **EXIF orientation is applied by every branch** — OpenCV by default,
    LibRaw for the RAW output and the stored JPEG thumbnails, and the
    fallbacks explicitly — so `images.width/height`, `images.thumbnail`,
    `images.preview` and every face box describe the **displayed** image,
    never depending on which decoder won (scripts-design §9.2).

    **Sample normalisation to `uint8`** (tifffile path): `uint8`
    passes through; integers scale over their dtype range (`uint16` ⇒
    ÷257); floats with `max ≤ 1.5` are treated as **0..1 linear** and
    gamma-encoded to sRGB (so face detection sees JPEG-like tones for
    32-bit float TIFF exports of raw development), `≤ 255` are kept,
    larger values are treated as 16-bit; NaN/±inf ⇒ 0/255.

    **One full path per item**: the `[i/N] <full path>`
    progress line identifies every scanned, skipped, imported and failed
    file — a bare filename is useless across 36 k files in same-named
    roll folders — and identifies it **once**: the verdict lines that
    follow (`no faces`, `imported: N face(s), M person(s)`, `already in
    database — skipping`, `FAILED: …`) print the verdict only; repeating
    the path under its own progress line is clutter. Diagnostics that
    stand alone (the closing failure list, warnings about files outside
    a scan loop) keep the full path. `-q` still yields exactly header +
    summary (scripts-design §10), so path detail is quieted by `-q` and
    never by anything else.

    **Database handling**: a missing `FACES_DB` file is reported
    as `database not found: <path>` (+ how to create it) and exits 1
    *before* connecting — `sqlite3.connect()` would otherwise create an
    empty file, which the schema gate then rejected with a bogus
    "wrong schema version" style message. The gate's
    empty-`schema_version`-table case gets its own message instead of
    `schema vempty schema_version table …`.

    **`--create-db`**: builds the database at the `.env`
    `FACES_DB` path from `database/schema.sql`, creating missing parent
    directories. An existing **non-empty** database ⇒ warning on
    stderr, exit 1, nothing written; a stray **0-byte** file (exactly
    what `sqlite3.connect()` leaves behind) counts as absent and is
    replaced. Combined with
    `--dry-run` ⇒ argparse error (creation is a write). `ROLL_DIR`
    becomes optional with it: omitted ⇒ create and exit 0; given ⇒
    create when needed, then continue with the import.

    **Provider selection**: **CPU is the default** — MIGraphX over
    this machine's amdgpu wedges the GPU (ring timeout → MES unrecoverable
    → every reset fails → the session itself crashes), so the unsafe path
    must be requested: `--gpu` opts in to MIGraphX (keeping the
    existing automatic CPU fallback when the provider fails to initialise
    or probe), while `--cpu` stays accepted as a **deprecated no-op** —
    it *is* the default, so old invocations keep working. The
    startup header reports the selected provider (always printed, even
    under `-q`), so every run's log states which one executed.
    `build_parser()` / `validate_args()` are extracted from `main()` so
    the flag contract is unit-testable without a database or the face
    model.

30. **Review mode flow: apply / accept** ⇒
    two commit levels, and only Review mode moves context:
    - **Apply** (dialog `Apply`, bottom-bar `Apply`) — stages on the
      selection: the labels preview, **no DB write, no regrouping**;
      Undo/Esc revert it (§4.24) and the context never moves.
    - **Accept** (dialog `Accept`, bottom-bar `Accept`, `A`, global
      `Enter` — keys and the bar **never open a dialog**) —
      stage-then-commit: the DB is written, the screen reorganises,
      **and in Review the context advances**: a partial accept keeps the
      acted-on section's remaining faces as the selection, a fully
      accepted section hands over to the next section (all of its
      faces, scrolled into view via `data-face-id` + double-rAF
      `scrollIntoView({block:'nearest'})`), and the last section clears
      the selection — the plan comes from the pre-accept sections
      (`acceptAdvancePlan`), which stay valid afterwards because
      accepting never changes another section's members.
    - **Person mode and focus mode: context never moves by itself**
      — same selection rules, same dialog, same stage/commit;
      only the advance disappears, and the right panel stays extra.
    - **Bottom bar**: `Apply · Accept · Undo° · Edit… ·
      Reject · clear` — every action scoped to the selection with no
      confirmation dialog; selection actions grey out at N = 0 and
      `Undo` greys out without a preview. `Edit…` opens the
      shared Edit dialog with scope preset to Selection.
    - **Key/bar Accept with a live pending set commits the staged ops
      first, then accepts the DISPLAYED scope** — the dialog's
      Accept takes its chosen scope, the bar's Accept and `A`/`Enter`
      take the selection (cursor-as-target when empty, §4.25); the staged
      set supplies the edits, never the acceptance scope (an empty scope
      falls back to the staged ids). Without a set they act on the
      selection. Global `Enter` accepts **in Review only** (`A` works in
      every view); the advance plan anchors at
      the **last-selected card**, else the hovered card, else the first
      accepted id. The rewrite runs **only on success**: a
      failed accept surfaces its error toast and leaves the selection —
      nothing about the selection, the staged set or the advance plan
      changes on failure.
    - **Person-exhausted fall-through**: when
      **Accept, Reject or Delete Person** leaves the current person with
      **no faces left** (no sections for it in the refreshed snapshot,
      under the current face filter), the context advances to the
      **next person of the review step list — exactly what “›”
      (`stepPerson(1)`) does** — instead of leaving a black centre
      panel. The verdict also **focuses its acted-on person**
      (post-success, §4.41): with the anchor on the acted person the
      mark comparison below is unchanged and this hand-over fires, while
      a grid-only verdict (no anchor ⇒ no mark) simply gains the anchor
      for Person mode to open. Partial actions (remaining faces/sections)
      keep the
      existing section-level advance or stay put; the step reuses the
      ‹ › code path, so cursor-as-target and list-end behaviour
      follow the stepping rules. At the end of the list the context
      stays and a toast says the review is exhausted.
      **The advance skips persons with nothing left to review**: the
      target is the first person **after** the drained one in
      the step list that still holds a face of the review status — not
      the raw successor, which under Show=All can be a faceless shell or
      under Show=New a person whose matching faces were just decided
      (that person may also have dropped out of the list on this very
      refresh via the §4.10 pruning; the marked person's current index is
      then re-derived — `exhaustAdvanceTarget` — and the captured index
      serves as the pruning gap to continue from). With no forward
      candidate the context stays and "no more persons to review" is
      reported.
      **The exhaust mark is strictly bound**: the pre-mutation
      mark (`exhaustAtRef`) remembers **which person** it was set for,
      is consumed unconditionally (so it can never linger across view
      switches, even if the snapshot refresh lands elsewhere), and acts
      only when the consumer is still the marked person **and the view
      is Review** (§4.40: the lock is the mode) — anything else
      silently drops it. The advance **ends an open full
      image / focus split** (§4.15: the person on screen is no longer
      the one shown — stepping closes it too).
    - **An open modal owns the keyboard**: while any dialog, menu or
      settings layer is open, every other shortcut is suppressed.
      **One overlay registry instead of hand lists**: every modal
      component registers itself with the `OverlayProvider`
      (`src/overlays.tsx`) while it is mounted — all overlays are
      mounted exactly while they are open, so the mount lifetime is the
      open lifetime, covering App-owned *and* child-owned layers (tree
      menus, GroupDialog, the merge dialogs' row menus, SettingsPopover)
      — and App's both guards (Esc stack, letter/arrow shortcuts) derive
      from the single `useOverlayCount()`. One source of truth: adding a
      modal in the future means using the hook, not remembering state
      lists.
    - Accept never touches rejected faces (claiming is an assignment,
      §4.35; §4.2 plain accept never un-rejects). Esc closes layers in
      order: dropdown → menus and dialogs → preview-undo → cancel field
      edit → split.
31. **Render-performance contract** ⇒ Review mode must stay
    interactive over thousands of cards (4116 faces, ~1061 sections,
    ~56k DOM nodes in the default review view):
    - **Hover is not app state**: the pointer crossing cards must not
      re-render the tree — a `hoverRef` feeds the cursor-as-target
      shortcuts and the highlight is pure CSS
      (`.face-card:hover`, replacing the `.hovered` class path).
    - **Cards and handlers are stable**: `React.memo(FaceCard)` over
      `useCallback`/`useMemo` grid handlers — handler-identity churn
      would defeat the memo instantly.
    - **`sections` is computed once per input change** (`useMemo` over
      snapshot/view/person/focus inputs), never per render.
    - **A selection change re-renders only the sections it touches**:
      each section is a memo carrying its own selection
      signature (which of its face ids are selected) and a
      staged-fields key — a card toggle re-renders the one or two
      touched sections, not all ~1200. Measured on the 4116-face DB
      (gui-mock R2): a toggle's interactive cost is tens of ms
      (~16–50 ms), not a full-tree re-render.
    - **Deferred: section/window virtualisation and snapshot payload
      thinning** (measured on gui-mock R2 + DOM census, headless
      Firefox): the interactive bar is met —
      selection toggles 14–17 ms at the very tail of the ~356k px
      scroll (worst case for the section memos), 8×8-page scroll jumps
      11–29 ms per frame after warm-up. Virtualisation would improve
      only the initial mount (2044 cards / 1061 sections / 56.3k DOM
      nodes; ~350 ms to paint the cards, lazy image fetches settle
      ~2 s in) — acceptable, so it stays deferred; revisit if
      board-scale DBs (10k+ faces in one view) make the mount or scroll
      cost user-visible. Snapshot payload: 2.06 MB JSON over IPC
      (faces ≈ 298 B/face, images 0.56 MB, persons 0.27 MB), **no
      BLOBs** (crops/thumbnails are lazily fetched per card, §2); the
      thinnable fields (`created_at`, `state`, derived `name` ≈ 200 KB
      total) are not worth a contract churn — payload thinning is
      likewise deferred.
32. **Image & face-crop rotation** (the import half lives in
    `docs/scripts-design.md`) ⇒ display rotation is **server
    state**, one column per entity, applied on every load:
    - **`images.rotation`** (0/90/180/270, degrees clockwise, default 0):
      the full-image view (focus mode, §4.19) rotates the annotated
      image (overlay included — the whole annotated block rotates, so
      the rectangles stay aligned; no coordinate math for display).
      Controls: **⟲/⟳ buttons** on the focus mode's pinned header row
      and **context-menu entries** on the image (“Rotate 90°
      counter-clockwise / clockwise”) — these complete the image's WhoT
      context menu (§3: system viewer, rotate; not the webview default
      menu). Persisted by `rotate_image(image_id,
      ±90)`; the snapshot carries the angle and the renderer applies
      `transform: rotate(⟨angle⟩deg)` from it — rotate once, it sticks.
      **A rotation of the IMAGE cascades the same delta to every crop
      on it** (one transaction): each crop's orientation
      *relative to the image* is preserved (the crop pixels are fixed
      at creation, so the two display angles move together).
    - **`faces.rotation`** — display rotation of the **face crop**
      (0/90/180/270, default 0), **independent
      of the image rotation** in the converse direction only (crop
      pixels are fixed at creation; both rotations are pure
      display state — image 90° CW + crop 90° CCW is legal — and
      `rotate_face` stays the per-crop correction, never touching
      `images.rotation`; the IMAGE→crop cascade above runs one way).
      Same control pattern on the card: ⟲/⟳ buttons on the card
      action row + context-menu entries, persisted by
      `rotate_face(face_id, ±90)`.
    - **Import interlock**: a legacy file's harvested EXIF
      rotation angle lands in `images.rotation` at import time, so a
      90°-rotated photo displays upright with zero user interaction;
      the GUI controls are the manual override. Schema/DDL details in
      `docs/schema-design.md`.
33. **Dialog action rows above typeahead fields** ⇒ a typeahead's
    suggestion list opens **downward** from its input and covers whatever
    sits below it — so in dialogs containing a typeahead (the §4.24 Edit
    dialog, the §4.16 group dialog), the **action row goes to the top** of
    the dialog (under the title/body, above the fields), where suggestions
    can never obscure it. Buttons keep their order and behaviour.
34. **Face drag & drop** ⇒ the centre-pane face cards are
    drag sources with **two drop zones** — the person tree (merge) and the
    centre pane itself (description copy):
    - **Drag source (both features)**: dragging a card that is part of the
      current multi-selection drags the **whole selection**; dragging an
      unselected card drags just that card (the §4.16 person-drag rule,
      mirrored). The payload is App-level state — the drag starts in the
      centre pane and may land in the left pane — and `dragend` (drop
      outside, Esc, cancel) clears it with every highlight.
    - **Drop on a person row — merge into the person**: every
      person row is a valid target during a face drag (group branches and
      the status branches are not); the row shows the
      existing `merge-target` highlight. The drop is **confirmed like every
      merge path** (§4.28 — an accidental drop must not silently destroy):
      a face-level dialog spells `M face(s) → <target>`, lists the movers
      by owner (`N from X`) and notes that the drop **claims** any
      rejected movers (un-rejects + moves, §4.35) while source persons
      losing their last
      face are deleted (§4.1). The target is the dropped person — fixed,
      the drop already chose it; dropping onto an `UnknownN` row is
      refused. Faces already on the target are excluded; if nothing
      remains the drop is a no-op info toast. Execution is one
      `assign_person` (the same call the person-merge uses) and the
      centre pane opens the merged target.
    - **Drop on a face card — copy its description**: during a face
      drag, every centre-pane card **with a non-empty description** is a
      valid target (highlighted `desc-target`); dropping copies that card's
      description onto the **whole dragged payload** (the target card
      included — re-applying its own description is a no-op). The copy
      source is what the card **shows** — a live staged value when one is
      staged on the card, else the committed one. A card with an **empty
      description is not a target** (no-drop cursor, drop ignored): a drag
      onto it must never clear the payload's descriptions — text is never
      dropped silently. Execution is the existing per-face description
      setter, batched over the payload inside one `mutate` (the §4.30
      stage-commit loop); `link_status` is untouched — a description write
      is a text edit, like every other description path in the app, and
      needs no confirmation.
    - No other drop targets (no branch, no image area, no section header)
      and no other drag sources (card drags only — section headers are not
      draggable).
    - **WebKit drag contracts**:
      1. **The face crop (and the tree avatar) are `draggable={false}`**.
         Without this, pressing on the image — most of a card's area —
         starts a **native image drag** (a `text/uri-list` URL drag with
         copy-only semantics) instead of the card's element drag; WebKit
         never delivers that drag back into the app as a droppable payload,
         so targets never highlight and drops never land. The card div /
         person row is the only drag source.
      2. **A plain mouse-down on an unselected card selects it first**
         (`selectOne`), so a press-drag started immediately carries exactly
         that card; the payload rule above then applies uniformly
         (selection-bearing card → whole selection, unselected card → the
         card just selected). Modifier presses (ctrl/shift) keep the
         existing click semantics.
      3. **Drop acceptance in the tree is ref-driven, not state-driven**
         (`faceDragRef`): a drag must never depend on a React re-render
         having landed mid-drag — the working person-drag path has always
         read its local `dragRef` at event time, and the face path now
         mirrors it. The `faceDragIds` prop remains for highlight/clear
         bookkeeping only.

35. **Status groups & the system person `Rejected`** ⇒ groups stay
    a plain organisational attribute — a dumb `person_groups.path` whose
    sole job is shaping the tree (§4.16). The review states carry
    *meaningful default values* **without making group stateful**:
    - **Status seats**: `New`, `Accepted`, `Rejected` are ordinary group
      paths, but **system-written only** — no typed path, dialog, merge or
      drop may produce them (§4.16 reserved segments: `Ungrouped`, the
      three seats, and `Unknown`). Their branches are system
      furniture (no branch menu, no drops, no rename) while the persons
      inside them are ordinary rows. Every person is grouped, so the
      tree is real branches plus the three seats — the renderer keeps the
      bucket names only as a **lazily-created, fail-visible fallback**
      (only an invariant breach could populate one, so a healthy tree
      never shows them and no writer can produce one).
    - **The group invariant**: every person has **≥ 1 group row** — the
      “no group” state does not exist. Everything that would leave a
      person groupless **seats** them instead: an empty assign or
      *Move to group…* input, `delete_group`, a `rename_group` to `""`.
      The empty input resolves to the person's status seat — `Accepted`
      or `Rejected` as the case may be (§4.1) — derived from the faces
      the operation leaves behind (seat derivation below). The invariant
      is **writer-owned**: both writers always write a seat and never
      delete a person's last row without replacing it (no stored trigger,
      by schema-design's no-trigger rule); `scripts/fix_status_groups.py`
      asserts it, the DDL documents it, and `schema_version` is `1.7` —
      a database predating the status seats is refused at the gate until
      `scripts/fix_status_groups.py` has upgraded it.
    - **Seat derivation** (re-evaluated for every seat-holder after each
      mutation of their faces): ≥ 1 `provisional` face ⇒ `New`; else ⇒
      `Accepted` (all faces confirmed — or none left). Transitions
      **only ever rewrite seats** — a user-given group is never touched.
      **Filing replaces the seat**: gaining any real group (assign with a
      path, *Move to group…*, *Add group…*, D&D) drops the seat, and
      losing the last real group re-derives it — a person renders under
      exactly their real groups *or* their one seat, never both. A mixed
      `UnknownN` (some confirmed, some provisional) therefore **stays
      `New`** until its last provisional face is decided, then flips to
      `Accepted`.
    - **Import**: every `UnknownN` the importer creates is seeded with
      `New`, and existing
      seat-holders that receive new provisional faces re-seat to `New`;
      the harvest importer seats its groupless persons by the same rule.
    - **Reject re-homes the face** (§4.2): every path that writes
      `link_status='rejected'` — the Reject actions and
      `remove_persons` — moves the face onto the **system person
      `Rejected`** in the same transaction (`seq`/`name` re-derived per
      §4.7, origin person recomputed), so **every rejected face in the
      database lives on `Rejected`**, ordinary persons hold only
      `provisional`/`confirmed` faces, and no writer ever produces an
      unowned face (`faces.person_id` stays nullable in the DDL but is
      never `NULL`).
    - **The system person `Rejected`**: created on demand; its seat row
      is always `Rejected` (the one derivation it never re-evaluates);
      the name is reserved in `validate_person_name` (exact match, like
      the `Unknown*` rule); it is **never renamed, moved, re-grouped,
      merged (source or target), removed, or D&D-dropped-onto** (§4.13
      guards its removal; §4.34 guards the drop); it has no primary and
      no refcrops (every face it owns is rejected, so §4.5/§4.6
      eligibility excludes them). It is listed in the tree **only under
      `Show → Rejected`** and only while it holds faces (§4.10) —
      invisible under every other setting.
    - **Claim is the only exit from `rejected`**: an assignment that
      includes rejected faces un-rejects them (`link_status='confirmed'`)
      and moves them to its target — plain **Accept never un-rejects**
      (§4.3). On a rejected-only scope Accept is inert with the info
      toast “assign a person to bring it back”, and the assignment paths
      (rule bar *Edit…*, context menu, Edit dialog committed with a
      name) are the way back — reachable only while `Show = Rejected`
      (§4.10), so no bulk operation can claim by accident.
    - **Data fix**: `scripts/fix_status_groups.py` upgrades a v1.6
      database **in place** (backup first; verified; refuses anything
      but `1.6`): creates `Rejected`, moves every rejected face — owned
      and unowned — onto it, rewrites the `Unknown` rows to derived
      seats, seats any groupless person,
      recomputes the primaries/refcrops touched by the moves, asserts the
      invariant, and bumps `schema_version` to `1.7`. A fresh database
      built from `database/schema.sql` needs none of this.

36. **Rolls import pane** ⇒ importing a fresh roll must not
   require the terminal: the Rolls path filter (§3) doubles as the
   import entry point.
   - **Trigger**: committing a path (typed + Enter, or the native folder
     picker) that matches no snapshot image **and** that
     `scan_import_dir(path)` confirms to be a real directory holding
     ≥ 1 image file **at any depth** (`IMAGE_SUFFIXES` of
     `import_roll.py`, walked **recursively** — real rolls are organised
     in sub-folders, so a one-level probe misreads them as empty; no fs
     walk happens for a path that already matches snapshot images).
     A path that is not such a directory keeps the dim refusal hint
     (`no images under …`) and the current root.
   - **The import pane** replaces the **right pane** (DetailPane's slot)
     while open; it is rolls-scoped UI state (session-only, like the
     Rolls root), closed by its own ✕ button (DetailPane returns), and
     survives
     tab switches. It is a **pane, not a modal** — the tree, the rolls
     browser and the rule bar stay interactive; only one import pane can
     be open at a time.
   - **Options**: toggles for the `import_roll.py` CLI flags that make
     sense per roll — `--dry-run`, `--all`, `--gpu` (CPU is the default,
     §4.29), `--recursive` (**on by default** — the probe that
     opened the pane already found images below the top level, so a
     default-off import would silently skip the very sub-folders that
     triggered it), `--threshold <f>` (default `0.40`, the
     script's `THRESHOLD_DEFAULT`); the **roll
     directory** and the resolved **database path** are shown read-only
     (the pane is opened with the directory pre-filled; re-picking goes
     through the path filter again). `--create-db` + `--dry-run` is
     refused up front (the script's `validate_args` — creation is a
     write).
   - **Option gating**: the pane offers only options that can
     apply — `--create-db` is **hidden while a usable database exists**
     (the script refuses an existing non-empty DB, so the checkbox
     could only fail; `get_import_info` now answers the probe with
     `{ dbPath, dbExists }`, where *usable* means the **schema is
     present**, not merely that a file exists: a failed first load can
     have created an empty file), and it is offered **pre-checked in
     the first-run flow**. The other flags apply to every in-app
     run and stay.
   - **First run — no database**: when the initial snapshot load
     fails and **no usable database exists** (the same schema probe),
     the app does not dead-end on the raw error: a dialog states it
     (*No database yet* — the configured path, built from
     `database/schema.sql`) with **Retry** (the DB may have appeared
     externally) and **Open import pane**. Opening picks a roll
     directory with the **native folder picker** and shows the import
     pane **standalone** — centred on the first-run screen, `--create-db`
     pre-checked (so `--dry-run` is refused by the existing combo rule)
     — so building the DB and importing the first roll happens in **one
     flow**; a clean exit (0) loads the snapshot and the normal app
     appears (✕ returns to the dialog, a failed retry falls back to the
     FatalError screen). Any other load failure keeps FatalError as
     today.
   - **Independent process**: *Start* asks the backend to spawn
     `python3 scripts/import_roll.py <roll_dir> [flags]` as a **separate
     child process** (`start_import`; the interpreter is overridable via
     `WHOT_IMPORT_PYTHON`) with the project root as cwd — the GUI process
     never blocks and never imports in-process (model load, GPU hangs
     §4.29 — a wedged import cannot wedge the GUI). One import at a time:
     *Start* is refused with an error line while one is running.
     *Stop* kills the child (`stop_import`).
   - **stdout monitoring viewport**: the pane polls
     `get_import_status(since)` and appends the child's combined
     stdout/stderr lines to a scrollable, selectable (`user-select:
     text`, §4.26 error rule) viewport that **auto-follows the tail**
     unless the user scrolled up (scroll-lock on manual scroll-up,
     re-engaged at the bottom). The pane shows the process state
     (`running` / `exit n` / `killed`) and the elapsed time while running.
   - **After the run**: a successful exit (code 0) triggers a snapshot
     refresh — the new faces appear in the rolls tree by the normal
     external-change rule; a non-zero exit or a kill leaves the captured
     output on screen for diagnosis (the error text rule §4.26 applies).
     Closing the pane does not kill a running import (it is an
     independent process); Start/Stop stay reachable by reopening the
     pane on the same directory.

37. **The right pane follows the full image** ⇒ while a full-size
   image is on screen the right pane must answer "who is this?" without
   the user hunting in the tree:
   - **On entry**: opening the **focus split** (card double-click or
     *Open full image* on a face) re-anchors the right pane on **the
     person owning that face**; an image-context entry without a face
     (the branch thumbnail's *Open image* / *Open full image (focused)*) —
     like the thumbnail detail open — **keeps the current
     person**. Opening the **Rolls image detail**
     re-anchors on the opening face's person when the entry carries a
     face context, and **keeps the current person** when it does not
     (a thumbnail opened without a face context — there
     is no person to follow; the pane shows whatever it showed, incl. its
     empty state when none is anchored).
   - **On rectangle click**: clicking a rect in either full-image surface
     switches the right pane to **the clicked face's person**, *in
     addition to* the §4.11 selection toggle. The view never changes:
     the split/rolls detail stays open, no tab switch, no person-view
     navigation (a plain `setPersonId` — deliberately NOT the §4.15
     tree-row select, which yanks the centre pane), and the selection is
     untouched beyond the toggle itself.
   - **Guards**: `face.person_id` may be `NULL` (the column stays
     nullable; no row writes it) —
     then the anchor is left as it was (never cleared, never `setPersonId(null)`).
     The **import pane (§4.36) keeps precedence**: while it occupies the
     right pane, neither entry nor rect-click anchoring steals the slot
     (the anchor may update underneath — the pane swaps back to the
     DetailPane on the import pane's close). The followed person's
     DetailPane edits (rename/group/note/refcrops) keep working — it is
     still `displayPerson`.

38. **The person pane's group list** and the **Update person
   button** ⇒ the right pane must show and edit *all* of a
   person's group memberships, not just the first:
   - **List**: the pane's single Group field is replaced by a list of
     every membership (`person_groups` rows — persons can belong to
     several groups; the tree already renders them under each branch,
     §4.16). Each row shows the path and an **×** button that removes
     that membership; removing the last real membership re-seats the
     person by state (§4.35 — the backend's `ensure_seat`).
   - **Status seats are inert**: a row that is the person's status seat
     (`New`/`Accepted`/`Rejected`, §4.35 — system furniture) renders
     dimmed with its × **disabled**; it is never staged for removal.
   - **Add group**: a path input below the list (path typeahead, §4.18
     options) appends a **new** membership — every current group is
     kept and the status seat drops when a real group is filed (the
     §4.35 rules). Reserved segments are refused
     client-side before staging, exactly as the backend refuses them.
   - **Editable rows**: clicking a row's path edits it inline (path
     typeahead); a committed change re-homes **that one** membership
     (from = old path, to = new path — the §4.16 D&D semantics),
     staging the same way × and add do.
   - **Staged commit**: × / add / inline-edit edits are held locally
     (the list shows the staged result); **Enter in the add input or
     the Update person button commits them** — the name field first
     (the rename-merge helper, §4.1 — which may re-anchor the pane on
     the merge target), then the membership ops applied **in order
     against the surviving person** (`move_persons_between_groups`,
     §4.16 — one call per op: `from=''` add, `to=''` remove, both
     non-empty re-home). A failed name commit aborts the ops. The Name
     and Note fields keep their immediate commit-on-blur behaviour —
     only the group list is staged. Staging is pane-local UI state:
     re-anchoring the pane (any §4.37 path, tree select) discards it.
   - **Update person**: a button directly above *Remove person*,
     styled like it — it performs the same action as the commit above
     (pending name first, then the staged group ops; with nothing
     staged and no pending name it is an informed no-op, never an
     error). The system person `Rejected` sees the list **read-only**
     (no ×, no add, no inline edit — §4.35) and no Update button.
   - **The Edit dialog fronts the same list**: whenever the
     dialog's **Name field holds a known person's name** (typed or
     prefilled), the single Group field is replaced by that person's
     group LIST — the identical rows (× removal, inert seat, inline
     re-home, add row — one shared `GroupListEditor`, so the pane and
     the dialog can never drift). The list edits stage **locally in the
     dialog**; **Apply** leaves them staged (they preview in the list
     itself — an informed note says they commit with Accept), **Accept**
     commits them **after the name lands** — the membership ops replay
     in order against the **surviving person** (the merge target when
     the name was taken; re-derived from the fresh snapshot, so an
     in-place rename hits the renamed person). With an empty or new
     (unknown) name the dialog keeps its single Group field. Scope
     switches discard the staged ops (they are per-scope, like every
     other dialog field).

39. **Modes and the Rolls branch thumbnails** ⇒ the top-bar
   selector is the **mode switch** (§3): each mode owns its centre
   panel and its right pane's default content. Rolls mode changes:
   - **Branch selection**: clicking a path node in the centre
     hierarchy both toggles the branch's expansion **and** selects it. The selection is session state like the Rolls root —
     it survives mode switches, defaults to the **root itself**, and is
     re-validated when the root changes (a selection outside the new
     root falls back to the root).
   - **The right pane shows the selected branch's images — direct
     children only, never recursive**: a branch that also holds
     sub-branches lists just the images filed *at that path* (the
     directory of the image's `primary_path` equals the branch path),
     ordered by filename and Show-listed by the §4.10 rule (an image
     lists iff it holds ≥ 1 matching face; `All` lists every image —
     branch counters stay raw, §4.16). A branch
     with no direct listing image shows a dim hint: `no images directly
     at this path — open a sub-branch` when it has sub-branches, else
     `nothing to show`.
   - **The centre renders no thumbnails**: the hierarchy (headers with
     rollup counters + expand arrows) is the centre's whole content; the
     Rolls path filter, Show pruning and the import entry (§4.36) apply
     as in §3.
   - **Thumbnail interactions** (right pane):
     - plain click **replaces** the image selection with that image;
       ctrl/⌘-click toggles; shift-click ranges over the branch's
       display order from the anchor (the §4.23 accelerator pattern,
       over images). The face selection is untouched; ids outside the
       current branch's list are dropped on render.
     - double-click opens the **image detail** (centre swaps to the
       annotated overlay + face grid, *← rolls* returns to the
       hierarchy with the branch selection intact) — a view-context
       change (incl. the §4.24 staged-set confirm).
     - **while an image is open the right pane shows the person
       detail** again (the §4.37 anchoring — the editing pane for the
       face work); the thumbnails hold the pane only while the user
       browses the hierarchy.
     - the context menu opens on a thumb; if the thumb is part
       of the selection the scope is the whole selection, otherwise
       just that thumb (the §4.14 scope rule). It carries `Open image`,
       *Open full image (focused)* (both: the invoked thumb — greyed out
       for a multi-scope, §4.14), `Rotate
       90° CW` / `Rotate 90° CCW` and `Open in system viewer` (all:
       applied to **each image of the scope**, one command per image in
       order — rotations batch into one refresh), plus the existing
       faces-of-this-image entries (invoked thumb).
   - **Selection lifecycle**: the image selection clears when the
     branch selection changes (a different thumb set); it survives
     mode switches with the branch selection.
   - **Deferred** (later expansions): *remove the images from
     Whot* — a new `remove_images` backend command whose face/person
     semantics needs backend-design + schema-design sections — and
     further bulk actions over the selection.
   - **Rolls layout while browsing**: while the centre
     shows the **hierarchy** (no image open, no focus split) the centre
     takes an **explicit width that starts at the left pane's width** —
     most of the window goes to the right pane, whose thumbnails flex
     to fill it. The centre|right divider then drags the **centre**
     between **10% and 70% of the window** (and never past
     `window − left − 200px`, keeping the right pane a usable floor);
     double-click restores the default (centre follows the left pane
     again). The choice is session state and survives mode switches.
     **Opening an image or the focus split restores the normal
     layout** — the centre flexes again and the right pane returns to
     its fixed 200–560px drag (the detail views need the width, and
     the right pane is the person detail again).
   - **Precedence**: the import pane (§4.36) keeps the right pane while
     open (the branch selection may update underneath); the person
     detail keeps its Review/Person-mode home (§4.38).

40. **The Review lock** ⇒ the lock IS the
   Review mode:
   - **Indicator only**: a **padlock in the top bar, beside the `Show`
     select** — a pure indicator, never a control: it reads **🔒 exactly
     while Review mode is active** and 🔓 otherwise, and it is not
     clickable. The state derives from `mode === "review"`.
   - **Locked while in Review**: `Show` pins to **New**
     (`provisional`) through the ordinary filter path (§4.10: faces the
     new filter hides leave the selection and their staged ops drop)
     and the select renders **disabled** — on every entry
     into Review (the top-bar *Review* button, the tree's *Review*
     action, the post-delete fallback, and the initial load) and for
     as long as Review stays active. If the entering anchor holds no
     new face, the **position guard** first advances to the next person
     in the step list that does (forward, else the first such person;
     with none, stay and report `no more persons to review`).
   - **Exit is a mode switch**: the user selects **Rolls** or
     **Person** — the ordinary confirm switch (the §4.24 staged-set
     confirm). The select
     **re-enables** and its **value stays** (no forced Show → All, no
     forced follow-up mode): the tab click *is* the exit. The §4.41
     guards (*No new faces*, *Please select a person…*) cover any
     resulting empty state, so nothing else fires on exit.
   - **Reach**: the §4.30 exhaust machinery is mode-gated — verdicts
     made in Review mark and hand over; verdicts in Person/focus/rolls
     never advance, and §4.30's accept keeps its plain path while a
     split is open.
   - **Actions**: no verdict or assignment rule is mode-dependent.

41. **Person mode: sticky person, guard dialogs, counts, status
   colours** ⇒ Person mode's behaviour is otherwise unchanged:
   - **The Person tab is always clickable**: without an anchored
     person a click switches to Person mode, sets **Show → All** (the
     status branches `New`/`Accepted` are then listed — `Rejected` only
     under Show → Rejected, §4.35) and opens the dialog
     *Please select a person in the tree on the left* (a single
     **Close** button). With an anchor the click is the plain mode
     switch — the anchor survives mode switches (§3), so the person
     last worked on (incl. out of the Review workflow, §4.40) is
     still the one shown.
   - **Sticky person**: once selected the user stays on that person. If
     a Show change — or a verdict — leaves the anchored person with
     **zero faces under the current filter** (while holding faces at
     all; faceless shells are their own state and never trigger it),
     Person mode opens *No new faces* — the title follows the filter
     (accepted/rejected; under All *No faces to show*) — with
     **Show All** (sets Show → All) and **Close** (dismissed for that
     person+filter pair until either changes).
   - **The empty state says what to do next**: when the anchored
     person holds **no face under the current Show filter**, the centre
     pane's empty state is guidance, not a bare *nothing to show* — it
     names the active filter and points at the ‹ › controls:
     - the person has faces but none under Show →
       New/Accepted/Rejected: *No **{New/Accepted/Rejected}** faces to
       show — pick another person in the list, or click **›** to step to
       the next person.* The message does **not** suggest switching Show
       to All — the §4.41 guard dialog above already offers **Show All**,
       and the two must not contradict each other;
     - the person has no faces at all (a faceless shell, which the
       guard never triggers): *This person has no faces — pick another
       person in the list, or click **›** to step to the next person.*
     Without an anchored person (and everywhere the pane has no person
     context — Rolls, image detail) the bare *nothing to show* stays.
   - **Focus follows the verdict**: every successful **Accept /
     Reject** moves the anchor to the **acted-on person** — the owner
     of the cursor-as-target face (§4.25) — so Person mode always
     opens at the **last person the user worked on**: the grid-only
     verdict (no anchor yet ⇒ no §4.30 mark, no hand-over — the
     verdict itself anchors the drained person, so the picker dialog
     never dead-ends a relook), the verdict on a person other
     than the current anchor (the anchor follows the action), or a
     run of verdicts (the anchor walks with the work). The update runs
     **after** the mutation succeeds and **after** the pre-mutation
     exhaust mark is captured, so the mark comparison and the §4.30
     hand-over are untouched: when anchor and acted person coincide
     (the common case) the drain hand-over proceeds as the §4.30 rules
     describe.
   - **Top-bar status totals**: the top bar **always** shows the
     **database's live face totals** as
     an overview — `? N` (New), `✓ N` (Accepted), `✗ N` (Rejected) —
     **independent of mode, Show filter and selection** (shown with no
     anchor at all) and re-derived from the refreshed snapshot on every
     mutation (accept, reject, assign/merge, delete). Same chips and
     the colours below; the tooltip reads `totals in the database` —
     never one person's faces. A person's own counts stay in the tree
     badges and the right pane.
   - **One status colour scheme**: **New = red, Accepted =
     green, Rejected = gray, All/default = normal text** — everywhere
     status TEXT appears: the tree's status branches and group branch
     labels, the Show select (its options **and** its closed value),
     the face-card status badges and the count chips
     (`c-prov`/`c-conf`/`c-rej`). The face-rectangle overlay palette
     (§4.11) is a separate mechanism.

42. **Accept/reject icon shortcuts** ⇒ one visual language for
   verdicts everywhere:
   - **Card tick**: the face card's action row gains **✓** beside ✗ —
     accept the card **as is**, with the bar's Accept semantics (live
     stages commit first, then accept; the §4.30 advance in Review)
     under the §4.14 effective-action-scope rule (the selection
     when the card is part of it, else the card). It renders for every
     face the accept can address: **provisional** accepts; **rejected**
     yields the existing *assign a person to bring it back* guidance
     (§4.2/§4.35 — plain accept never un-rejects); a **confirmed** card
     shows no tick (its status badge already reads ✓) and keeps ✗ for
     re-reject.
   - **Cluster header**: every section header carries **✓ and ✗**
     beside *Edit…* — the verdict over the **whole group** (all its
     faceIds — select-all parity; stages commit first on accept,
     §4.14 scope = the group).
   - **Bottom bar**: the selection shortcuts gain the icons —
     **✓ Accept** and **✗ Reject** (semantics unchanged, §4.30).
   - No other behaviour moves: the A/R shortcuts, the dialogs and the
     §4.30 flow stay as they are.

## 5. Related documents

| Document | Contents |
| --- | --- |
| `README.md` | user-facing setup & usage, **Tauri command reference**, **repository layout**, run/build |
| `docs/scripts-design.md` | Python tooling: **§8** legacy harvest (staging DB), **§9** harvest import (staging → copy of `faces.db`) — section numbers shared with this document's § numbering |
| `docs/schema-design.md` | `faces.db` DDL design: tables, identities, state-transition model (§7), version gate, drop & recreate |
| `docs/backend-design.md` | Rust backend architecture: `lib.rs` command surface, `db.rs` data layer, path/env resolution, derived-state maintenance |
| `AGENTS.md` | agent conventions: branching, versioning, testing |

Behaviour rules (§4) are normative for every implementation of them —
`src-tauri/src/db.rs`, the scripts and the frontend all follow §4; the
backend and schema documents describe *structure*, not rules, and point
back here where a rule is needed.
