# WhoT Face Manager — GUI Design

**Version: 3.25** (major.minor per `AGENTS.md`; major = new feature, minor =
change/correction; this document is the primary design document — the app
version in `package.json` tracks it)

Revision history is not kept in this document — it lives in the GitHub
issues. The version above is bumped with every change and referenced in
the closing comment of the issue(s) it implements.

Tauri-based desktop app for reviewing, naming, accepting, rejecting and
annotating faces imported by `scripts/import_roll.py` into `data/faces.db`.

v3.16 **split** this document: the script sections (formerly §8/§9) moved
to `docs/scripts-design.md` *keeping their section numbers*, the Tauri
command reference and repository layout moved to `README.md`, and the
database and Rust backend designs live in `docs/schema-design.md` and
`docs/backend-design.md` (§5 below lists every document).

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

Non-goals (v1): moving faces between *known* persons by drag & drop,
deleting faces (persons *can* be removed — §4.13; their faces become
rejected, unowned records), editing embeddings, multi-group membership UI
(one group path per person), i18n.

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

The database carries a single-row `schema_version` table (currently `'1.5'`).
The GUI (`db::connect`) and `import_roll.py` verify it on every connection
and **refuse a missing or mismatched version** with recreate instructions —
exact match, no migrations (AGENTS.md). `scripts/annotation_snapshot.py`
preserves manual annotations across such a drop & recreate.

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
  rejected). The tree's header — **roll up/down buttons on the left,
  filter box on the right, then the Review button** — is **pinned flush
  to the top of the pane** while the list scrolls (#78; one sticky
  block whose panel background covers the full pane width and the
  pane's top padding, so no text can show through above or beside it).
  The filter matches **person name and/or
  group path** (case-insensitive substring); tree stays hierarchical
  below the match.
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
- **Status filter + cluster group** (§4.10/§4.9, #99/#100): the center
  pane's toolbar carries `Show [All | New | Accepted | Rejected]` — the
  face-status filter applied by every view (default All; **New** is the
  `provisional` status, spelled the way the face-card badge spells it) —
  and, to its left, the persons-mode cluster-group toggle
  `[Description | Accuracy]`, both grouped at the bar's right side. The
  toolbar is the center pane's **fixed header**: the sections scroll
  beneath it in their own, shorter scroll area — nothing can scroll past
  above it (#100; sticky pinning was clamped by the pane's padding and
  left that strip). While a mutation is in flight the bar's
  right side shows an animated **busy roller** beside `working…` (the
  `busy` state; `prefers-reduced-motion` disables the spin).
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
   A **cluster-group toggle** sits in the top bar, left of the status
   filter (#99): `Accuracy` (default) keeps the rule above; `Description`
   collapses each appearance to **one section per distinct description**
   over the visible faces — no similarity split: the threshold is not
   consulted and `person_face_clusters` is not called (no IPC). Sections
   are ordered by first appearance with the empty description last,
   titled `(no description)` (Ungrouped convention), and make no
   similarity claims in this mode. The choice persists as
   `cluster_group` in `whotrc.json` (`accuracy` default).
10. **Status filter** (`face_filter`, #99 — generalises #23/#28) ⇒
    `Show [All | New | Accepted | Rejected]` in the top bar: one
    setting (whotrc `face_filter`: `all` (default) | `provisional` — UI
    label **New**, the face-card badge's word (#100) — | `confirmed` —
    UI label **Accepted** — | `rejected`) replacing
    `show_rejected` (whose default `true` *was* `all`; the legacy key is
    ignored on read). The chosen status decides **every view's**
    visibility: the person view's cluster sections and its Rejected
    section, image grids and full-image rectangles, the review grid, the
    **left-pane person presence and counts** — a person with no matching
    face leaves the tree and the surviving bucket drives its counts (#28
    generalised) — and the **right-pane overview totals**. `link_status`
    never changes: the filter is pure display. Switching it **drops
    non-matching faces from the selection** (§4.10's original rule,
    generalised): faces the filter hides can never be bulk-acted on.
    **Review special case**: `All`/`Provisional` show the pending set
    (provisional — the default review is unchanged), `Accepted` shows
    confirmed faces, `Rejected` shows rejected faces.
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
    With `face_filter` set to anything but `all` (§4.10) the removed
    persons — rejected now — vanish
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

    **Append mode** (#92): a `|`-terminated prefill — what a root/branch
    right-click produces — opens the input in *append* mode: the text is
    kept, the caret is placed after the pipe and **no select-all** fires.
    The user right-clicked that branch precisely to type a new twig after
    it; the #67 wholesale-replacement rule (select the structural path)
    stays for every non-`|`-terminated prefill — rename/move a branch,
    move persons to a group, and the empty top-level prefill where
    selecting nothing is a no-op. `groupInputMode()` in `src/autoText.ts`
    derives the mode from the prefill itself, so the dialog cannot open
    in the wrong one.
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
      Applied everywhere such a value can appear: the §4.24 Edit
      dialog's pre-filled fields, the tree inline rename, the detail-pane
      Name field. **Group-path inputs** go further
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
      user already typed one).
    - **Every value field suggests** (#97 → #101 hosts): the name
      typeahead (existing persons, `UnknownN` excluded, pick = merge
      target) and the group-path suggestions (+ an `ungrouped` entry)
      live wherever a value is typed: **the §4.24 Edit dialog** (name
      and group; description stays free text), the detail-pane
      Name/Group, the tree inline rename, `GroupDialog` and the merge
      dialog's bulk-group field — the grid's own fields are labels now
      (#101). One shared widget backs all of it (options + label +
      hint — navigation/Enter/Esc behave identically everywhere); a
      pick never counts as leaving (mousedown keeps focus), and
      click-away still commits where fields stayed inline. Free text
      stays plain: descriptions, notes, the tree filter, the alias
      list, settings numbers.
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
24. **Grid editing: labels + one Edit dialog** (#101 — replaces the
    inline rule inputs of #72/#73 and their blur rules of #93) ⇒
    - **Cards and cluster headers show labels, not inputs**: the three
      value fields — **name, group, description** (headers gain the
      description label; cards show all three) — are per-object,
      **live labels** (H1: an empty group/description renders as a dim
      `–`) plus one **Edit…** button. Labels are display only: they
      update per object when an apply/accept changed some cards and not
      others, and a pending preview marks them (accent underline, H2)
      until accepted.
    - **One shared dialog**: three labelled fields — name, group,
      description — each carrying the §4.21 suggestions (a picked name
      mirrors its group unless one was typed), plus a scope selector
      `Card | Group | Selection` with a live face count (H3). Opening
      it follows the selection rules (Q1/G3): on an object **inside**
      the current selection the selection is kept; **outside**, the
      selection becomes that card (header → that cluster). The
      **scope default follows the invocation site** (final #101
      answer): Edit on a **card → `Card`**, Edit on a **header →
      `Group`**, bottom bar → **`Selection`** (greyed at N = 0); the
      selector switches scope explicitly and **Apply binds the stage to
      the chosen scope's faceIds**, which Accept then commits (the
      review advance works off those ids too).
    - **Buttons**: `Apply` = stage + close (screen preview), `Accept` =
      stage + commit (the shortcut — “Accept is what makes my changes
      permanent”, Q3), `Cancel`/Esc = discard. **Enter = Accept**,
      **Esc = Cancel** — inside the dialog only (G2).
    - **Scope**: every action targets the **selection**; bottom-bar
      buttons and plain keys never confirm (Q2/Q9), and the dialog's
      selector is the *only* object-vs-selection disambiguation,
      chosen before anything runs — the confirmation dialog the Q2
      alignment circled around is unnecessary.
    - **Stage / preview state**: one pending
      `{faceIds, name?, group?, desc?}` bound to its selection; a new
      Apply replaces it; **Undo** (bottom bar, greyed without a
      preview) and **Esc** revert it directly (F1); a **selection
      change while staged asks escape-or-accept** (Q4). Text is never
      dropped silently (Q3).
    - Commit keeps the #77 field routing — a name change through
      `assign_person` (group applied on create/UnknownN-rename, later
      explicit groups via `set_person_group`), a group-only change
      through `set_person_group`, a description change through its own
      setter — an empty field counts as unchanged, unowned faces
      surface a toast. **Rejected faces stay sticky** (§4.2): a stage
      may display on them, the commit skips them (F2).
    - **Retired**: inline inputs on cards and headers, the header
      `apply` button, the #29 FaceAssignDialog, the AssignDialog as a
      separate component (`Assign name…` opens this dialog with scope
      preset to Selection), the #93 `focusLeftHeading` machinery, and
      every auto-apply-on-focus rule. The right-panel DetailPane and
      the tree inline rename **stay inline** (G4: a single person, no
      scope ambiguity).
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
26. **Copyable errors** (#81) ⇒ every error surfaced by the app — the
    fatal `loadError` screen and the runtime error toast — must be
    cleanly copyable for filing issues:
    - error text is selectable (`user-select: text`) and **wraps/scrolls**
      instead of clipping at `max-width`;
    - a **Copy** button writes the full, untruncated message to the
      clipboard (one click; includes the operation that failed and the
      raw error string);
    - the toast no longer dismisses on a plain click (which swallowed
      selections): dismissal is an explicit **✕** button, or the toast
      stays until replaced/cleared; selecting text inside it never
      dismisses it.
27. **Stale-shell sweep** (#84) ⇒ on every `get_snapshot()`, persons
    matching `name LIKE 'Unknown%'` with **zero faces** are deleted
    (leftovers from pre-v1.9 runs or external writers — no code path
    ever revisits them otherwise). Named persons are never swept: an
    empty *named* person is a legitimate future assignment target.
    The sweep is one statement inside the snapshot transaction, cheap
    and idempotent.
28. **Merge Similar Persons** (#88) ⇒ a triage workflow for same-name
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
      merges into that person — a **new drop-target type** beside the
      existing #50 branch/Ungrouped drops. Drop-target highlighting must
      distinguish person vs branch vs Ungrouped unambiguously.

    **Confirmation is mandatory for every merge path** — menu, dialog
    and especially DnD (an accidental drop must not silently destroy):
    one shared dialog spelling `N person(s), M face(s) → <target>`,
    sources emptied and deleted, **no undo** (faces themselves are never
    deleted; §4.13). #50's branch drops stay dialog-free — moving
    between groups is reversible.

    **Execution = existing §4 commands, zero new SQL paths**: merge is
    one `assign_person(face_ids_of_all_sources, target.name,
    target.group)` (§4.1 semantics: sticky rejected, emptied shells
    deleted, derived state recomputed); bulk group is
    `move_persons_to_group` (§4.16); bulk rename is the rename-merge
    helper (§4.1) — identical resulting names merge. Self-merge is a
    no-op; `UnknownN` targets are refused (server-side and pre-validated
    in the UI, including on drop).

    **Settings**: `whotrc.json` gains `merge_name_distance` (default 2,
    clamped 1–3) and `merge_suffix_aliases` (default `[]`), with serde
    defaults so existing files keep loading; editable from the review
    dialog. The detection functions live in one pure TS module,
    unit-tested with **vitest** (the repo's only JS test runner —
    added as a devDependency; a Python mirror is explicitly rejected:
    two implementations of one rule is how they drift).
29. **import_roll decode & CLI contract** (#89/#90) ⇒ one canonical
    decode space, full paths in the log, and honest database errors:

    **Decode chain** (`_decode`, #89) — try decoders in order until one
    produces an image; if all fail, the file is a *per-file* failure and
    the batch continues (#47):
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
    never depending on which decoder won (scripts-design §9.2, v4.2).

    **Sample normalisation to `uint8`** (tifffile path, #89): `uint8`
    passes through; integers scale over their dtype range (`uint16` ⇒
    ÷257); floats with `max ≤ 1.5` are treated as **0..1 linear** and
    gamma-encoded to sRGB (so face detection sees JPEG-like tones for
    32-bit float TIFF exports of raw development), `≤ 255` are kept,
    larger values are treated as 16-bit; NaN/±inf ⇒ 0/255.

    **One full path per item** (#90, #94): the `[i/N] <full path>`
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

    **Database handling** (#90): a missing `FACES_DB` file is reported
    as `database not found: <path>` (+ how to create it) and exits 1
    *before* connecting — `sqlite3.connect()` would otherwise create an
    empty file, which the schema gate then rejected with a bogus
    "wrong schema version" style message. The gate's
    empty-`schema_version`-table case gets its own message instead of
    `schema vempty schema_version table …`.

    **`--create-db`** (#90): builds the database at the `.env`
    `FACES_DB` path from `database/schema.sql`, creating missing parent
    directories. An existing **non-empty** database ⇒ warning on
    stderr, exit 1, nothing written; a stray **0-byte** file (exactly
    what `sqlite3.connect()` leaves behind) counts as absent and is
    replaced, so the #90 artifact heals itself. Combined with
    `--dry-run` ⇒ argparse error (creation is a write). `ROLL_DIR`
    becomes optional with it: omitted ⇒ create and exit 0; given ⇒
    create when needed, then continue with the import.

    **Provider selection** (#91): **CPU is the default** — MIGraphX over
    this machine's amdgpu wedges the GPU (verified 2026-10-21 09:37:
    `ring gfx_0.0.0 timeout` → `MES unrecoverable` → every reset fails →
    gnome-shell SIGABRT kills the session; the then-running app died
    afterwards as a victim in WebKit's `createEGLFence`), so the unsafe
    path must be requested: `--gpu` opts in to MIGraphX (keeping the
    existing automatic CPU fallback when the provider fails to initialise
    or probe), while `--cpu` stays accepted as a **deprecated no-op** —
    it now *is* the default, so old invocations keep working. The
    startup header reports the selected provider (always printed, even
    under `-q`), so every run's log states which one executed.
    `build_parser()` / `validate_args()` are extracted from `main()` so
    the flag contract is unit-testable without a database or the face
    model.

30. **Review mode flow: apply / accept** (#96, matrix finalised #101) ⇒
    two commit levels, and only Review mode moves context:
    - **Apply** (dialog `Apply`, bottom-bar `Apply`) — stages on the
      selection: the labels preview, **no DB write, no regrouping**;
      Undo/Esc revert it (§4.24) and the context never moves.
    - **Accept** (dialog `Accept`, bottom-bar `Accept`, `A`, global
      `Enter` — F3/G2: keys and the bar **never open a dialog**) —
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
      (Q10) — same selection rules, same dialog, same stage/commit;
      only the advance disappears, and the right panel stays extra.
    - **Bottom bar** (Q9): `Apply · Accept · Undo° · Assign name… ·
      Reject · clear` — every action scoped to the selection with no
      confirmation dialog; selection actions grey out at N = 0 and
      `Undo` greys out without a preview. `Assign name…` opens the
      shared Edit dialog with scope preset to Selection.
    - Rejected faces stay sticky (F2); the Esc ordering of Q8 holds:
      dropdown → menus and dialogs → preview-undo → cancel field edit →
      split close.
31. **Render-performance contract** (#98) ⇒ Review mode must stay
    interactive over thousands of cards (4116 faces in ~1226 sections,
    ~70k DOM nodes today):
    - **Hover is not app state**: the pointer crossing cards must not
      re-render the tree — a `hoverRef` feeds the cursor-as-target
      shortcuts (#75) and the highlight is pure CSS
      (`.face-card:hover`, replacing the `.hovered` class path).
    - **Cards and handlers are stable**: `React.memo(FaceCard)` over
      `useCallback`/`useMemo` grid handlers — handler-identity churn
      would defeat the memo instantly.
    - **`sections` is computed once per input change** (`useMemo` over
      snapshot/view/person/focus inputs), never per render.
    - Deferred to the planned Review-Mode requirements review:
      section/window virtualisation (IntersectionObserver, no new
      dependency) and snapshot payload size — decide after measuring
      1–3, not before.


## 5. Related documents

| Document | Contents |
| --- | --- |
| `README.md` | user-facing setup & usage, **Tauri command reference** (the former §5), **repository layout** (the former §6), run/build (the former §7) |
| `docs/scripts-design.md` | Python tooling: **§8** legacy harvest (staging DB), **§9** harvest import (staging → copy of `faces.db`) — section numbers unchanged from this document's v2.0/v3.0 |
| `docs/schema-design.md` | `faces.db` DDL design: tables, identities, schema-version gate, drop & recreate |
| `docs/backend-design.md` | Rust backend architecture: `lib.rs` command surface, `db.rs` data layer, path/env resolution, derived-state maintenance |
| `AGENTS.md` | agent conventions: branching, versioning, testing |

Behaviour rules (§4) are normative for every implementation of them —
`src-tauri/src/db.rs`, the scripts and the frontend all follow §4; the
backend and schema documents describe *structure*, not rules, and point
back here where a rule is needed.
