# WhoT Face Manager — GUI Design

**Version: 1.14** (major.minor per `AGENTS.md`; major = new feature, minor =
change/correction)

**Change log**

- **1.14** (2026-10-17, follow-up round #53–#55 — all frontend):
  - §4.17 — **selection accelerators** (#53): Ctrl/⌘-click on a face-card
    body toggles that card in the selection (same idiom as tree rows;
    plain click stays inert so double-click-to-open is unaffected);
    **Ctrl-G** toggles the whole section — the one holding the hovered
    card, else the one holding the most recently selected card. Listed in
    the settings popover's shortcut set.
  - §3/§4.18 — **Add group…** (#54) on the context menus of every *real*
    branch and of the tree root: a path dialog prefilled with `<parent>|`
    that moves the **current tree selection** into the new group. Option 3
    of #54: groups derive from person paths, so an empty group cannot
    exist — the entry is disabled without a selection and the virtual
    `Unknown`/`Ungrouped` nodes do not offer it.
  - §3/§4.19 — the card double-click split becomes a **full-image focus
    mode** (#55): the annotated image spans the center pane's full width
    with a **film roll** of just that image's faces below; the regular
    grid is hidden while the mode is active. Ends on ×/Esc, a left-pane
    selection that leaves the image (§4.15) or explicit navigation. The
    side-by-side split and its draggable divider are removed.
- **1.13** (2026-10-17, review/tree interaction round #49–#52):
  - §4.14 — **selection-scoped face actions** (#49): when the right-clicked
    face card is part of an active selection, the face context menu
    (*Accept* / *Reject* / *Assign to person…*) and the card's ✗/undo
    button act on the **whole selection**, matching the rule-bar buttons;
    single-face actions — ★ primary and ◈ reference — are **greyed out**
    whenever the effective scope would be more than one face. With no
    selection (or the card not in it) every action targets just that card.
  - §4.15 — **split-pane lifecycle** (#51/#52): the face-rectangle context
    menu no longer offers *Open full image* when that very image is already
    open in the split; the split **closes automatically** when the
    selection moves to a different image (tree row select, person stepping,
    card/rectangle select) and **stays open** when the new selection is on
    the same image. Manual opens (double-click, *Open beside*, *Open full
    image*) always win.
  - §4.16 — **group management** (#50): the branch context menu gains
    *Rename/move group…* and *Delete group* (members — including
    sub-branches — fall to Ungrouped); the person menu gains *Move to
    group…* acting on the current multi-selection; persons, selections and
    whole branches also move by **mouse drag** onto a branch node or onto
    Ungrouped (cycle guard; `Ungrouped` is reserved as a typed path
    segment). New backend commands `rename_group`, `delete_group`,
    `move_persons_to_group` (§5) — membership only, faces untouched.
- **1.12** (2026-07-21, review round #36–#48 — correctness/robustness, no new
  features):
  - §4.1/§4.2 — **`rejected` is sticky**: `assign_person` (rename, merge,
    whole-group, section rule) never changes the `link_status` of a face that
    is currently `rejected`; rename/merge may *move* it with its person but
    never un-reject it. The only exit is an explicit accept (§4.3 / the face
    menu's *Un-reject (accept)*). Previously a rename/merge of a person
    silently re-confirmed all of its rejected faces (#36).
  - §4.1/§3 — the review-section rule bar no longer prefills `Unknown` as the
    group for `UnknownN` sections, and renaming a *faceless* person away from
    an `UnknownN` name clears the `Unknown` group — a renamed person always
    leaves the Unknown branch, from every entry point (#38).
  - §4.13 — re-claiming a removed person's faces goes through an explicit
    accept (§4.3), consistent with the sticky rule (a section rule can still
    *name* them, but it cannot un-reject them).
  - Backend robustness: `recompute_refcrops` skips faces with a NULL
    `preview` instead of aborting the whole transaction (#39); group paths
    are normalized at write time (segments trimmed, empties dropped, empty
    result = ungrouped) (#42); `set_person_name` re-runs the person's
    primary/refcrop recompute so it is symmetric with `assign_person` (#43);
    `get_settings` warns (eprintln) when `whotrc.json` is malformed instead
    of silently resetting to defaults (#44); `l2_vectors` rejects embedding
    blobs whose byte length is not a multiple of 4 instead of truncating them
    silently (#45); person deletion explicitly deletes `person_groups` and
    `person_refcrops` rows in addition to the FK cascade (#46);
    `person_face_clusters` reports similarity 0.0 (not 1.0) for a face with
    no embedding (#41).
  - Scripts: `annotation_snapshot.py restore` now deletes `UnknownN` persons
    left faceless by the restore and backfills the machine primary and
    refcrops (top-N per appearance, excluding the primary, honoring pinned
    rows) for each restored person, so a fresh restore opens in a fully
    derived state (#37); the importer and snapshot tool write **all**
    timestamps in UTC (`YYYY-MM-DD HH:MM:SS`) so persons and faces from one
    run read consistently (#40).
  - Frontend: `Esc` no longer closes a split view while a dialog, context
    menu or the settings popover is open (#47); settings inputs are clamped
    on save (threshold ∈ [0, 1], `refcrop_n` ≥ 1) (#48).
- **1.11** (2026-10-15, #29 final follow-up): **"person already exists" is
  unreachable from the GUI.** Every rename entry point — tree row,
  context menu, detail pane — routes through one rename-merge helper
  over *all* the person's faces (`assign_person` merge semantics); a
  faceless person renamed to an existing name merges by deletion (empty
  set), an empty input is a no-op, and renaming an `UnknownN` in these
  non-visible-group flows clears its `Unknown` group (F7 preserved). The
  face-card whole-group flow clears the `Unknown` group the same way.
  `set_person_name` keeps its uniqueness rule as a backend/API invariant
  only.
- **1.10** (2026-10-15, #29 refinement): the face-card assign dialog is
  **skipped when it cannot disambiguate** — if the face's person has only
  one face (whole group == just this face) or the face is unowned (§4.13),
  the assignment applies directly; the single-face case still preserves
  the person's group path (rename-in-place semantics). The dialog only
  appears when "whole group" genuinely covers more than the one face.
- **1.9** (2026-10-15, GUI-feedback on #29/#35): §4.1 — **renaming a
  person in the tree routes through `assign_person`** over all of the
  person's faces: a colliding name **merges** into the existing person
  instead of erroring (the `set_person_name` uniqueness rule remains only
  for the detail pane and for faceless persons). §4.13 housekeeping — a
  person left with **zero faces** by an assignment is deleted (stale
  shell; groups/refcrops cascade), so merges no longer leave the wrongly
  named person behind in the tree.
- **1.8** (2026-10-15, #35 — removing unwanted persons): §4.13 —
  `remove_person(s)`: all faces of the person(s) become `rejected`, are
  detached (`person_id = NULL`), the person row is deleted (groups and
  refcrops cascade); one transaction, no undo, no schema change — the
  faces remain in the DB as rejected/unowned records. §3 — **Remove
  person** in the person-tile context menu and in the reference-set
  (detail) pane; tree rows support **multi-select** (click / ctrl-click
  toggles / shift-click extends over the visible order) feeding bulk
  actions (context menu shows *Remove N persons*); **branch context
  menus** on tree nodes (*remove all unknown persons* on the Unknown
  root, *remove all persons in this branch* elsewhere); the image-detail
  grid titles unowned faces "unassigned". §7 — the v1 non-goal
  "deleting persons/faces" is lifted for **persons** (faces are never
  deleted, only rejected).
- **1.7** (2026-10-15, #29 correction): the face-card name input is an
  **assign** action, not a rename — typing an existing person's name
  merges into it (never a "person already exists" error); on commit (Enter
  or blur) a small dialog asks whether the assignment applies to **just
  this face** or the **whole group** of its current person (all its faces,
  keeping the current group path on rename-in-place). The detail pane's
  rename keeps `set_person_name`'s uniqueness rule.
- **1.6** (2026-10-15, GUI-feedback round on 1.5): §3 — **‹ › / ← → step
  persons** in the tree's visual order (not sections; #31 re-scoped) and
  the shortcut set is documented (settings popover lists it); face tiles
  use **large-radius rounded corners** instead of the tight oval (#30
  correction); with `show_rejected` off **persons whose faces are all
  rejected vanish from the tree** and the overview person count follows
  (#28 clarified: rejected = not up for review, empty `UnknownN`s
  disappear); the face-card name in `face-meta` becomes a **text input**
  like the description field — committing renames the person (#29
  addition); full images get their own context menu with **open in system
  viewer** (Rust `open_image` + opener plugin) because the webkit default
  menu's entries do not work in Tauri (#33 correction).
- **1.5** (2026-10-15, UX batch #28–#34): §3 — face tiles are **portrait
  ovals** so they read differently from person tiles (#30); with
  `show_rejected` off the left-pane counts and the right-pane overview
  exclude rejected faces as well (§4.10, #28); double-clicking a person
  tree row **renames inline** (#29); the center toolbar gains **‹ ›
  section stepping** plus `←`/`→` keys (#31); face/person/image tiles get
  **right-click context menus** with grouped selection/action entries (#32)
  while full images keep the default webview menu (#33); pane dividers
  are **draggable** (double-click resets, session-persisted) and grids
  reflow (#34).
- **1.4** (2026-10-15, #27 decisions — A / S3-yes / S4-yes / status-quo-yes):
  §4.12 — **import-time appearance inheritance**: the importer's corpus is
  keyed by `(person, COALESCE(description,''))`; the matched face inherits
  the winning group's description and takes its `seq` from that group
  (match/no-match unchanged — max over a partition equals max over the set).
  §4.9/§3 — the person view partitions faces by appearance (distinct
  description) and clusters by similarity *within* each appearance; section
  headers carry the appearance name when there is more than one. §5 —
  `person_face_clusters` returns `[{description, clusters}]`. (S3 was
  delivered in 1.3.)
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

The database carries a single-row `schema_version` table (currently `'1.5'`).
The GUI (`db::connect`) and `import_roll.py` verify it on every connection
and **refuse a missing or mismatched version** with recreate instructions —
exact match, no migrations (AGENTS.md). `scripts/annotation_snapshot.py`
preserves manual annotations across such a drop & recreate.

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
  view's `Rejected` section, rejected cards in image grids, rejected
  rectangles in full-image views, **the left-pane person counts and the
  right-pane overview totals** (#28). A rejected face is *not up for
  review*: when the toggle is off, **a person whose faces are all rejected
  disappears from the tree and the overview person count** (an `UnknownN`
  whose only face was rejected vanishes; it stays as long as any face
  remains).
- **Full-image views** (§4.11): every full-size image — the Rolls image
  detail and the card double-click split — always draws one **active,
  name-labelled rectangle** per visible face of that image, colour-coded by
  `link_status`; hover highlights the rectangle and its card (bidirectional),
  click toggles the face's selection.
- **Card double-click — full-image focus** (#55, §4.19): double-clicking a
  face card opens the center pane's **focus mode**: the annotated full
  image spans the pane's full width (height-fitted, §4.11 overlay
  unchanged) and a **film roll** below shows only that image's face cards
  (horizontal scroll strip; all card operations keep working). The
  regular grid is hidden while the mode is active. Closable via ×/Esc;
  selection and current view survive; single-click selection is
  unaffected (the two clicks of a double-click cancel each other out).
  **Lifecycle (#51/#52, §4.15)**: the mode ends when the selection moves
  to a different image (tree row, person stepping, card/rectangle
  select) or the user navigates explicitly (top-bar tabs, *Review*); the
  face-rectangle menu hides *Open full image* while its image is the one
  already open.
- **Face vs person tiles** (#30): face crops render as **rounded squares
  with a large corner radius**, so a face tile never reads as a person
  tile (whose avatar is a small circle) without cropping the face tight.
- **Face-card name input** (#29): the name in a face card's `face-meta`
  row is a text input like the description field below it; committing it
  **assigns that person** — an existing person is merged into, a new one is
  created (`assign_person` semantics, never a collision error) — and a
  small dialog asks whether to apply it to **just this face** or the
  **whole group** of the face's current person (§4.1 move/rename-in-place,
  group path preserved for the current person on a whole-group rename).
  The dialog is **skipped when it cannot disambiguate** (§1.10): a
  single-face person or an unowned face assigns directly. The full
  derived label stays in the tooltip; the detail pane's rename routes
  through the same rename-merge helper (§4.1).
- **Inline rename** (#29): double-clicking a person row in the tree turns
  its name into an entry field (Enter/blur commits via the rename-merge
  helper, §4.1, Esc cancels — same pattern as the detail-pane fields;
  validation errors surface as toast).
- **Section stepping** (#31): ‹ › buttons in the center toolbar — and the
  `←`/`→` **shortcuts** — step through the persons in the tree's current
  (filtered) display order, selecting each (person view); disabled at the
  ends, `n/m` indicator in the toolbar. Shortcuts never fire while an
  input or dialog has focus; the current set is listed in the settings
  popover (`Esc` closes overlays, `Enter` commits fields).
- **Context menus** (#32): face cards, person rows and image thumbs show a
  right-click menu with grouped entries — *selection* (select/deselect/
  select-all/clear) and *actions* (accept/reject, primary, reference,
  assign, open image …) — reusing the same commands and selection state.
  **Tree rows** additionally support **multi-select** (click sets the
  selection, ctrl/cmd-click toggles, shift-click extends over the tree's
  visible order; the anchor row stays the person shown) and offer
  **Remove person / Remove N persons** (§4.13); **branch headers** have
  their own menu — *remove all unknown persons* on the `Unknown` root,
  *remove all persons in this branch* on any group branch (counts shown,
  confirm dialog required) — and, on real group branches, *rename/move
  group…*, *delete group* and *add group…* (§4.16/§4.18, #50/#54; the
  tree root offers *add group…* too). The reference-set pane exposes
  **Remove person** as a button.
- **Group management & drag-and-drop** (#50, §4.16): real group branches
  (not the virtual `Unknown`/`Ungrouped` nodes) can be **renamed/moved**
  (a path dialog, prefilled; the whole subtree follows the prefix rewrite)
  and **deleted** (persons — incl. sub-branches — fall to Ungrouped; faces
  untouched). Persons and multi-selections **move to a group** via the
  person context menu (path dialog) or by **dragging** rows onto a branch
  node or onto Ungrouped; whole branches drag the same way (a drop onto
  the branch itself or into its own subtree is refused). Drops and dialog
  submits normalise the path like every other group write (#42).
- **Add group…** (#54, §4.18): the branch/root context menu offers *add
  group…* — a path dialog prefilled with `<parent>|` (root: empty) that
  moves the **current tree selection** into the new group. Groups are
  derived from person paths, so an empty group cannot exist: the entry is
  disabled without a selection, and the virtual `Unknown`/`Ungrouped`
  nodes do not offer it (a path under them is meaningless — Unknown is
  name-driven, Ungrouped reserved).
- **Full images get their own context menu** (#33
  correction): the webkit
  default menu appears but its entries ("open image in new window", …)
  are not functional inside Tauri, so image areas intercept
  `contextmenu` too and offer a working **open in system viewer** (the
  Rust `open_image` command writes the BLOB to a temp file and hands it
  to the opener plugin).
- **Resizable panes** (#34): the left/right pane dividers and the #25 split
  divider are draggable with clamps and double-click reset (session state);
  the face/image grids already reflow via `auto-fill` and follow the pane
  sizes.
- **Person view**: clicking a person in the tree shows *that person's* faces
  in the center pane, **partitioned by appearance** (distinct description)
  and then **grouped by similarity to the primary face** within each
  appearance (single-linkage, `cluster_threshold`, section shows min
  similarity) so impostors stand out; when a person has more than one
  appearance, section headers carry the appearance name. Same
  selection/operations as Review.
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
     Ungrouped), all selected faces `link_status='confirmed'` — **except
     `rejected` faces, which keep their status** (sticky rule, §4.2). The
     old `UnknownN` number is retired and never reused (importer numbering
     is max-based over remaining names — safe).
   - If selected faces span multiple persons or the name is new: move the
     selected faces to that person (create if needed), `confirmed` (a
     `rejected` face keeps its status — §4.2), `reassigned=1`. Faces **not**
     selected stay with their original person
     (e.g. `UnknownN`) for later assignment or rejection.
   - Assigning to a name that matches an **existing person merges** the
     selection into that person (names are not required to be unique for
     assign); the target person's group path and note are **left untouched**
     in that case. The group field only applies to the rename-in-place /
     new-person branches (review F2/F22). The same holds for a **tree
     rename**: it is routed through `assign_person` over *all* the person's
     faces, so a misspelling corrected to an existing name merges instead
     of erroring. A person left with **zero faces** by an assignment is
     deleted (stale shell — §4.13 housekeeping). This applies to **every
     GUI rename** (tree, context menu, detail pane) via one rename-merge
     helper: the `set_person_name` collision error can never surface in
     the GUI; a *faceless* person renamed to an existing name merges by
     deletion, an empty input is a no-op, and renaming an `UnknownN` in
     these flows clears its `Unknown` group (F7 — the group argument is
     not user-visible there; the review-section rule bar likewise defaults
     the group to empty for `UnknownN` sections, so a rename always leaves
     the Unknown branch from every entry point).
   - After any assignment the person enters the importer's *known corpus*
     automatically (name not `Unknown*` + confirmed faces); corpus entries
     are per `(person, description)` — see §4.12.
2. **Reject** ⇒ `link_status='rejected'`. Rejected faces: excluded from
   similarity grouping, primary-face eligibility, refcrops and importer
   corpora. Reversible: re-selecting + Accept sets `confirmed`. **Sticky
   rule (1.12):** assignments (rename, merge, whole-group, section rule) never
   change a face that is currently `rejected` — they may move it with its
   person, but never un-reject it; an explicit accept (§4.3) is the only exit.
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
   Since 1.4 the clustering runs **within each appearance group** (distinct
   `COALESCE(description,'')`), against the same primary-face reference
   (§4.9/§3), so another legitimate appearance reads as its own appearance
   section instead of an impostor cluster — and a true impostor still shows
   as a low-similarity cluster inside the appearance it impersonates.
10. **Rejected-face visibility** ⇒ the `show_rejected` setting (default
    `true`, persisted in `whotrc.json`). When off: the person view's
    `Rejected` section and rejected cards/rectangles in image grids and
    full-image views are hidden, the **left-pane person counts and the
    right-pane overview exclude rejected faces** (#28), and any *selected*
    rejected faces are deselected at toggle time — hidden faces can never
    be bulk-acted on. `link_status` itself is unchanged; the toggle is
    pure display (§3).
11. **Full-image annotation** ⇒ every full-size image draws one rectangle
    per visible face from `faces.x/y/w/h` against the canonical
    `images.width/height` coordinate space, percentage-scaled so it stays
    correct at any rendered size. Rectangles are active: hover highlights
    rectangle + card (shared hover state), click toggles selection; colours
    follow `link_status` (warn/ok/bad). `no-face` images and hidden faces
    (§4.10) draw no rectangles.
12. **Import-time appearance inheritance** (#27 option A) ⇒ the importer's
    known/unknown corpora are keyed by `(person, COALESCE(description,''))` —
    a *partition* of the person's confirmed vectors, so the winning person
    and match/no-match are identical to pooled matching (max over a
    partition = max over the set; vector row order is fixed with
    `ORDER BY faces.id`, corpus wins ties over unknowns). The matched face
    **inherits the winning group's description** at insert time (`''` ⇒
    none), takes its `seq` from that `(person, description)` group, and its
    label derives accordingly — imported matches arrive already labelled
    with the appearance they matched. Faces with no match above threshold
    still cluster into new `UnknownN` persons (accepted status quo).
13. **Removing a person** (#35) ⇒ `remove_persons(person_ids)`, one
    transaction per call: every face of each person becomes
    `link_status='rejected'`, is detached (`person_id = NULL`) and the
    person row is deleted — `person_groups` and `person_refcrops` cascade,
    any *other* person's stale primary pointer at these faces is cleared
    first. **No undo** (the faces themselves are never deleted; they stay
    in the DB as rejected, unowned records and can be re-claimed by an
    explicit accept (§4.3), optionally followed by an assignment; a section
    rule can name them but cannot un-reject them (sticky rule, §4.2).
    With `show_rejected` off the removed persons vanish
    immediately; the image-detail grid titles unowned faces
    "unassigned". Available from the person-tile context menu (also for a
    multi-selection), the reference-set pane and — batched — from tree
    branch menus (§3).
14. **Selection-scoped face actions** (#49) ⇒ every face action has one
    *effective scope*: the active selection when the invoked card is part
    of it (`sel.size > 1`), otherwise just that card. Context-menu entries
    (*Accept*, *Reject*, *Assign to person…*) and the card's ✗/undo button
    all honour this scope — the same ids the rule-bar buttons would act
    on — so "select whole section → reject" rejects the section from any
    entry point. Actions that cannot apply to more than one face —
    **★ set as primary** and **◈ add as reference** — are greyed out
    (disabled) whenever the effective scope would exceed one face, never
    silently applied to a single card. Per-card inputs (name, description)
    always stay single-face.
15. **Split-pane lifecycle** (#51/#52) ⇒ the double-click image split
    closes automatically when the selection moves to a **different**
    image: a tree-row select (plain, ctrl/cmd or shift), person stepping
    (‹ › / ← →) or selecting a card/rectangle whose `image_id` differs
    from `splitImageId`. It **stays open** when the new selection is a
    face (or a person with a face) **on the open image**. Manual opens —
    card double-click, *Open beside (split)*, *Open full image* — always
    win; Esc/× keep their meaning. In the rectangle context menu the
    *Open full image* entry is hidden while `face.image_id` is already the
    open image (#51).
16. **Group management** (#50) ⇒ membership-only operations in one
    transaction each; faces, names, statuses, primaries and refcrops are
    untouched:
    - `rename_group(old, new)` — rewrites the path prefix for every person
      inside the branch (the branch itself or any sub-branch). `new`
      empty ⇒ the whole subtree drops to Ungrouped. A branch cannot be
      moved inside itself (`new == old` or `new` prefixed by `old`).
    - `delete_group(path)` — deletes the `person_groups` rows of the whole
      subtree; those persons become Ungrouped (structure below the branch
      is not preserved — re-group by move/rename).
    - `move_persons_to_group(person_ids, group)` — replaces each person's
      group path with the target (empty ⇒ Ungrouped); works for any
      selection, wherever the persons live (incl. Unknown/Ungrouped).
    All three normalise the path (#42) and reject a literal `Ungrouped`
    segment (reserved pseudo-group; `Unknown` stays a normal branch).
    GUI entry points: branch menu (*rename/move…*, *delete group* with
    confirm dialog), person menu (*move to group…* for the selection), and
    drag-and-drop of persons/selections/branches onto branch nodes or
    Ungrouped (virtual nodes are not draggable/renameable themselves).
17. **Selection accelerators** (#53) ⇒ Ctrl/⌘-click on a face-card body
    toggles that card in the selection — the tree's idiom, now mirrored
    on cards; plain click stays inert so double-click-to-open is
    unaffected. **Ctrl-G** toggles the whole section: the one holding the
    hovered card, else the one holding the most recently selected card
    (no-op when neither exists); all-selected ⇒ deselect, otherwise
    select all. Shortcuts obey the existing guards (never while an input
    or dialog has focus, `preventDefault` so webkit cannot steal Ctrl-G)
    and are listed in the settings popover.
18. **Add group…** (#54) ⇒ context menu of every *real* branch and of the
    tree root; a `GroupDialog` prefilled with `<parent>|` (root: empty)
    that runs `move_persons_to_group` (§4.16) over the **current tree
    selection**. Since branches derive from person paths, "creating" a
    group *is* moving persons into it (option 3 of #54) — the entry is
    disabled when no persons are selected; virtual `Unknown`/`Ungrouped`
    nodes do not offer it.
19. **Full-image focus mode** (#55) ⇒ opening a full image (card
    double-click or *Open full image*) turns the center pane into a
    focused workspace: the annotated image spans the pane's full width
    (height-fitted, §4.11 unchanged) with a **film roll** below — one
    horizontal, scrollable strip of that image's face cards (all card
    operations keep working; no other faces are shown). The regular grid
    is hidden while the mode is active; it returns when the mode ends:
    × / **Esc**, a left-pane selection that leaves the image (§4.15), or
    explicit navigation (top-bar tabs, *Review*). Selection and view
    state survive as before; the former side-by-side split and its
    draggable divider are gone.

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
- `get_refcrops(person_id) → [{seq, description, pinned, face_id, image: base64}]
  grouped by appearance (§4.6)`
- `open_image(image_id) → ()` — write `images.preview` to a temp file and
  open it with the system viewer (opener plugin; §3 context menus)
- `person_face_clusters(person_id, threshold) →
  [{description, clusters: [[{face_id, sim}]]}]` — appearance partitions,
  similarity clusters inside each (§4.9)

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
- `remove_persons(person_ids)` — §4.13 (reject + detach + delete, no undo)
- `rename_group(old_path, new_path)` / `delete_group(path)` /
  `move_persons_to_group(person_ids, group)` — §4.16 (#50) group
  membership: prefix rewrite / subtree drop to Ungrouped / per-person
  replace; normalised (#42), `Ungrouped` segment reserved
- `get_settings()` / `set_settings(json)` — `config/whotrc.json`

## 6. File layout

```
whot/
  package.json  vite.config.ts  index.html      # frontend
  src/                              # React app
    main.tsx  App.tsx  api.ts      # api.ts = typed tauri invoke wrapper
    components/  PersonTree.tsx  FaceCard.tsx  FaceGrid.tsx
                 RuleBar.tsx  DetailPane.tsx  RollsPane.tsx  AssignDialog.tsx
                 GroupDialog.tsx  FaceOverlay.tsx   # active rectangles on full-size images
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
deleting faces (persons *can* be removed — §4.13; their faces become
rejected, unowned records), editing embeddings, multi-group membership UI
(one group path per person), i18n.
