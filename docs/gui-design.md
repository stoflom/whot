# WhoT Face Manager — GUI Design

**Version: 3.13** (major.minor per `AGENTS.md`; major = new feature, minor =
change/correction)

Revision history is not kept in this document — it lives in the GitHub
issues. The version above is bumped with every change and referenced in
the closing comment of the issue(s) it implements.

Tauri-based desktop app for reviewing, naming, accepting, rejecting and
annotating faces imported by `scripts/import_roll.py` into `data/faces.db`.

Since v2.0 the design also covers `scripts/harvest_legacy.py` (§8): the
read-only harvester that captures face & person knowledge from the archival
sources (sidecar XMP files, the Lightroom catalog and its sidecars, digiKam's
core and recognition databases) into a *staging database* for a subsequent
importer to merge into `faces.db`.  Since v3.0 that importer is specified:
`scripts/import_harvested.py` (§9) attaches harvested persons to the faces
insightface already detected — recovery of legacy work, never new images,
faces or detections — and writes only to a vacuumed **copy** of `faces.db`.

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
| Python | **none** at runtime | insightface only runs in the import and
  harvest scripts (§8) |

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
  Within every branch, persons are ordered by **face count, most first**
  (#61; ties broken by name, then id — deterministic, no sort toggle);
  sub-branches keep their order. The stepping shortcuts and the
  selection ranges therefore follow this display order.
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
  unchanged) and is **pinned at the top of the pane** — only the film roll
  below scrolls (#57, §4.19). The **film roll** shows only that image's
  face cards
  (horizontal scroll strip; all card operations keep working). The
  regular grid is hidden while the mode is active. Closable via ×/Esc;
  selection and current view survive; single-click selection is
  unaffected (the two clicks of a double-click cancel each other out).
  **Lifecycle (#51/#52/#62, §4.15)**: the mode ends when a person is
  selected — tree row or stepping (always — the attention has shifted,
  §4.15) — when a card/rectangle selection moves to a different image,
  or the user navigates explicitly (top-bar tabs, *Review*); the
  face-rectangle menu hides *Open full image* while its image is the one
  already open.
- **Face vs person tiles** (#30): face crops render as **rounded squares
  with a large corner radius**, so a face tile never reads as a person
  tile (whose avatar is a small circle) without cropping the face tight.
- **Face-card name input** (#29): the name in a face card's `face-meta`
  row is a text input like the description field below it; committing it
  **assigns that person** — an existing person is merged into, a new one is
  created (`assign_person` semantics, never a collision error). A
  small dialog asks whether to apply it to **just this face** or the
  **whole group** of the face's current person (§4.1 move/rename-in-place,
  group path preserved for the current person on a whole-group rename)
  — but is **skipped whenever the card is part of an active selection
  of any size** (#59): the selection *is* the disambiguation and the
  assign applies to it directly (§4.14 scope). The dialog is also
  **skipped when it cannot disambiguate** (§1.10): a
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
Double-click opens the full-image focus mode (§3).
- **Accept/reject asymmetry** (#63): *accepted* (`confirmed`) is the
  default status, so the card's reject **button** is the only styled
  action embellishment; acceptance is indicated by the status badge's
  `✓`. Tooltips on both states spell this out. More generally, every
  tooltip is user-facing prose: sentence-style capitalisation, no issue
  numbers, and cryptic-symbol buttons (`⌃`/`⌄`, `✕`) always name their
  action (#64, #65).
- **Input families** (#56, §4.20): group-path inputs and face-description
  inputs carry different frames and backgrounds everywhere they appear —
  solid accent-tinted frame for group paths, dashed second-accent frame
  for descriptions — so *where a person lives* and *what a face looks
  like* are never confusable at a glance (frame style also carries the
  distinction for colour-blind users).

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
   rule:** assignments (rename, merge, whole-group, section rule) never
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
    silently applied to a single card. **Per-card inputs (name,
    description) honour the same scope** (#58): editing one on a card that
    is part of a selection applies the change to the **whole
    selection**, following the general GUI rule that whenever a
    selection is active, edits apply to the whole set — for all
    editable properties, unless an action is explicitly single-item.
    For the name input this also means the #29 disambiguation dialog is
    suppressed while the card is selected: an active selection — **of
    any size, including a single face** (#59) — is itself the answer to
    "just this face or whole group?", so the dialog appears only for
    cards outside any selection.
15. **Split-pane lifecycle** (#51/#52, #62) ⇒ the double-click image
    split:
    - a **tree-row select** (plain, ctrl/cmd or shift) and **person
      stepping** (‹ › / ← →) **always** end it — selecting another
      person means the attention has shifted to them, whether or not
      they have a face on the open image (#62, superseding #52's
      relevance check);
    - a **card/rectangle select** ends it when the new selection's
      `image_id` differs from `splitImageId` and it **stays open** when
      the new selection is a face **on the open image** (focus mode
      depends on this);
    - manual opens — card double-click, *Open beside (split)*, *Open
      full image* — always win; Esc/× keep their meaning. In the
      rectangle context menu the *Open full image* entry is hidden
      while `face.image_id` is already the open image (#51).
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
    operations keep working; no other faces are shown). The image and its
    header row are **pinned at the top** of the pane while the film roll
    scrolls beneath it (#57) — the user works against the image, so it
    never scrolls out of sight; the pinned block gets a solid backdrop so
    cards pass behind it cleanly. The regular grid
    is hidden while the mode is active; it returns when the mode ends:
    × / **Esc**, a left-pane selection or person stepping (§4.15), or
    explicit navigation (top-bar tabs, *Review*). Selection and view
    state survive as before; the former side-by-side split and its
    draggable divider are gone.
20. **Input families** (#56) ⇒ group-path inputs (`family|lombards`) and
    face-description inputs (`beard|glasses`) are **visually distinct**
    everywhere they appear: group paths get a solid accent-tinted frame
    and slightly tinted background (structural, hierarchical value),
    descriptions a dashed frame in a second accent colour (free-form
    per-face tags) — the frame *style* carries the distinction for
    colour-blind users, the hues only reinforce it. Applied to the
    section rule bar's group field, the face-card desc input, the
    AssignDialog/GroupDialog group fields and the detail pane's Group
    field (Name/Note keep the default look; `Editable` gains a variant).
    The tints stay legible in the dark theme and clear of the
    warn/ok/bad status colours.
21. **Auto-filled fields & name typeahead** (#67) ⇒ two related input
    behaviours:
    - **Select-all for generated values**: when an input holds
      *auto-generated* text — today an `UnknownN` name — focusing it
      *or clicking into it* selects the whole value (for as long as it
      stays auto-generated), so the first keystroke replaces it
      wholesale. User-entered values keep normal caret behaviour.
      Applied everywhere such a value can appear: the face-card name
      input, the tree inline rename, the detail-pane Name field and the
      AssignDialog's pre-filled name. **Group-path inputs** go further
      and always select all on focus, user-entered value or not — a
      group path is a structural value that is replaced wholesale,
      never edited in place (#67 follow-up, confirmed in testing) — on
      focus and on click alike.
    - **Name typeahead**: the AssignDialog and the detail-pane Name
      field suggest existing persons (substring match, max 8, `UnknownN`
      names excluded — the point is to reach a real name; each row shows
      the person's group because **picking a suggestion merges into that
      person**, assign-not-rename §3). Arrow keys + Enter navigate,
      Enter without a highlight submits as before, Esc closes the
      dropdown before it touches anything else. In the AssignDialog a
      pick mirrors the target's group into the group field (unless the
      user already typed one). Face-card and tree-rename typeahead are
      deferred until this interaction proves itself.
22. **Keyboard shortcut set** (#68, extends #53) ⇒ shortcuts act on the
    selection, or on the hovered/last-selected card when nothing is
    selected (the Ctrl-G rule): **Ctrl-G** toggles the section **under
    the mouse cursor** — no prior click or card hover required (#74,
    cursor hit-test via the section's `data-section-key`) — falling back
    to the hovered/last-selected card's section (#53); **Space** toggles
    the card itself, **Ctrl-A** selects
    all cards of the current view, **A**/**R** accept/reject the
    selection (the rule-bar buttons' scope), ←/→ step persons (#31) and
    Esc closes split/dialog/menu (§4.19). Shortcuts are suppressed while
    typing in any input and while a menu or dialog is open. Context-menu
    items display their shortcut as a right-aligned dim hint
    (`MenuItem.hint`); the rule-bar tooltips and the settings popover's
    Keyboard list document the set. No shortcuts for destructive
    actions (remove person, delete group) — they keep confirm dialogs.
23. **Anchor + shift-click ranges** (#69) ⇒ a plain card click selects
    just that card and drops the *range anchor*; **Shift-click** selects
    the contiguous run of rendered cards from the anchor up to and
    including the clicked card, replacing the selection. Ranges are
    computed over the flat rendered order, so they may span section
    boundaries — the context menus, rule-bar buttons and A/R shortcuts
    then act on the whole set through the existing selection scope
    (§4.14). Ctrl/⌘-click keeps its toggle meaning (#53) and moves the
    anchor when it selects; Space follows the hovered card. A vanished
    anchor (filtered/removed card) degrades shift-click to a plain
    select. Double-click-to-open is unaffected.
24. **Section-header rule inputs** (#72/#73) ⇒ the name/group inputs in
    a section header are the *direct* assignment path: they commit on
    **Enter or blur** like every other field (change-guarded against the
    section's defaults) as well as via the explicit **apply** button —
    changing them is the operation itself, no button click required.
    Scope precedence: **an active selection wins, whatever its extent**
    — a cross-group selection is applied in full and never narrowed to
    the header's own section (narrowing to `section∩selection` used to
    drop the other groups' cards silently); only with **no selection**
    do the inputs fall back to **every face of their own section**.
    Tooltips state the precedence. Commit distinguishes the two fields
    (#77): a **name change** keeps the `assign_person` path (accept +
    name; group applied on create/UnknownN-rename — and when the target
    person pre-existed, an *explicitly typed* group is applied
    afterwards via `set_person_group`, since F2 only guards implicit
    merges); a **group-only change** skips `assign_person` entirely and
    calls `set_person_group` on the persons owning the scope — which
    also enables filing an **UnknownN** cluster into a group *without*
    naming it (remember the face, not the name): `set_person_group`
    never validates names, while `assign_person` rejects `Unknown*`.
    An empty name field counts as "not changed"; unowned faces surface
    a toast instead of failing silently.
25. **Cursor-as-target rule** (#75, generalises #74) ⇒ with no explicit
    selection the mouse cursor decides the target: a face-card context
    menu opened on an **empty selection selects that card first**
    (anchor + last-selected), so the menu's scope, the rule bar and the
    letter shortcuts all agree; **A**/**R** fall back to the hovered
    card instead of no-oping. Ctrl-G's cursor hit-test (§4.22) and
    Space's hovered-card scope are the same rule — the cursor is the
    implicit selection whenever there is no explicit one. **←/→**
    stepping honours it too (#76): with no selected person the first
    step starts from the person under the cursor (tree rows expose
    `data-person-id`), falling back to the list's start/end when the
    cursor is over no tree row.

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
  scripts/                         # Python tooling (dev-time only)
    import_roll.py                 # roll import into data/faces.db
    annotation_snapshot.py         # annotation export/restore across drop&recreate
    harvest_legacy.py              # §8: read-only archival harvester
    import_harvested.py            # §9: attach harvested persons (copy-only)
    legacy/                        # archived importers, superseded by harvest_legacy.py
  database/
    schema.sql                     # faces.db DDL (v1.5)
    harvest_schema.sql             # staging DDL for harvest_legacy.py (§8, v1.0)
  test/                            # Python unit tests (import + harvest helpers)
  docs/                            # design + review documents
  config/whotrc.json              # created at runtime
  data/faces.db                   # (existing; never touched by §8/§9 scripts)
```

## 7. Run / build

- dev: `npm run tauri dev`
- prod: `npm run tauri build` → `src-tauri/target/release/bundle/`

Non-goals (v1): moving faces between *known* persons by drag & drop,
deleting faces (persons *can* be removed — §4.13; their faces become
rejected, unowned records), editing embeddings, multi-group membership UI
(one group path per person), i18n.

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
