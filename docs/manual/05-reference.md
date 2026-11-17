# Chapter 5 — Reference: modes, panes and dialogs

Status: written — awaiting review

*A field guide to every control in the window. Entries are short by design;
each says what it is for and where to read more. Arranged by screen area,
matching Ch. 0.3's tour.*

## 5.1 Top bar

- **`Review` / `Rolls` / `Person`** — the three views. **Review** works
  through the pending faces (Ch. 1.2); **Rolls** shows your picture folders
  as they are on disk and is the import entry (Ch. 1.1); **Person** focuses
  on one person from the list.
- **`★ N` · `✓ N` · `✗ N`** — the database's live face totals: new,
  accepted, rejected. Always whole-database, whatever you have selected.
- **`Show [All | New | Accepted | Rejected]`** — which faces exist anywhere
  (Ch. 1.2). Switching it also trims the person list and the rolls tree;
  the totals and the list badges always show true counts regardless.
- **🔒 padlock** — an indicator, not a button: locked exactly while Review
  is active (Review pins `Show` to New).
- **`↻`** — re-read everything now. Normally Whot keeps itself up to date
  on its own (including when a window regains focus); use `↻` after a
  change made outside the window.
- **`?`** — the keyboard and mouse shortcut list.
- **⚙** — the settings popover: viewer programs, the similarity
  threshold used for grouping, the merge-name tolerance, and
  **environment…**, the dialog that shows where Whot keeps its records and
  what paths it was given (Ch. 3's path setup lives there; changes take
  effect after a restart).

## 5.2 Left pane — the person list

- **Filter box** — finds a person by name or group; ✕ clears it.
- **`⌃` / `⌄`** — roll every group up / down.
- **`⧉`** — merge similar persons (Ch. 1.4): lists clusters of
  near-identical names with the evidence, then merge / rename / regroup in
  bulk — always with a confirmation, because merging cannot be undone.
- **`New` / `Accepted` / `Rejected` branches** — the three status branches
  Whot manages (Ch. 0.2). They carry no menu and are not drop targets; the
  persons inside them are ordinary rows.
- **Count badges** — each person's row shows total / pending / accepted /
  rejected face counts, always the true numbers.
- **Click / Ctrl-click / Shift-click** — select, add to selection, select a
  range. **Double-click a row** to rename it in place.
- **Drag a row onto a group** — moves that one membership of the person to
  the group; their other groups (if any) stay. **Drag a selection onto a
  person** — merges the selection into that person (confirmed first).
- **Right-click menus** — person rows: rename, move/add group, open,
  select their pending faces, merge into…, remove. Group branches: rename
  or move the group, delete the group, remove everyone in the branch.
  Removing a person **cannot be undone** — their faces go to the Rejected
  bin (assignable back one by one), the person row is gone.

## 5.3 Centre pane — the three views

**Review** — pending faces grouped by their `Unknown…` groups. Each group
header: select-all box, face count, name/group/description labels and one
**Edit…** button. Accepting/naming a group hands over to the next group
automatically; when nothing is left, Whot says so.

**Rolls** — your picture folders mirrored as an expandable tree of
branches. A branch header expands/collapses **and selects** the branch; the
selected branch's pictures appear as thumbnails in the right pane. Each
header carries **⇩** (open the import pane on this branch, Ch. 2.2) and the
☐/☑ **include sub-branch pictures** toggle. The path box on top doubles as
the import entry: typing or browsing to a folder Whot does not know yet
opens the import pane. Branch totals live in the header's tooltip and
ignore the `Show` filter, which decides only what is listed.

**Person** — one person's faces, split into sections by appearance and
similarity, so look-alikes stand out. The toolbar's `Description |
Accuracy` switch chooses how sections are formed (per description tag, or
by likeness). Same selection and actions as Review, minus the automatic
hand-over.

**Double-click** a face card or thumbnail anywhere to open the annotated
full-size view.

## 5.4 The full-size view

One bar above the picture holds everything:

- the picture's **full path**, with a **Copy** button;
- **`‹ n/m ›`** — step through the pictures of the browsed folder (Rolls)
  or through a person's faces (Person/Review); `←`/`→` do the same;
- **⟲ / ⟳** — turn the picture (its face rectangles turn with it);
- **⤓** — export the annotated picture (Ch. 1.5);
- **✕ / ← back** — return to where you were.

A rectangle is drawn around every visible face, colour-coded by status
(accepted green, pending orange, rejected gray). Clicking a rectangle
selects that face and shows its person on the right. Below the picture
sits a strip of that image's face cards.

## 5.5 Right pane

- **Person detail** (Review/Person) — the person's name, their **group
  list** (each row removable ✕, plus an add field; commits with
  **✓ Update person**), note, representative picture (click it to open the
  picture), reference faces, and the **⧉ Merge similar** and
  **✗ Remove person** actions.
- **Rolls thumbnails** — the selected branch's pictures; click to select,
  double-click to open, right-click for actions.
- **Import pane** — the roll import (Ch. 1.1 / Ch. 2.2). It takes over the
  right pane while open and survives view switches; ✕ closes it (a running
  import keeps going).

## 5.6 Rule bar (bottom)

Appears whenever faces are selected:
`N selected · [Apply] [Accept] [Undo°] [Edit…] [✗ Reject] [clear]`.
**Apply** previews pending changes, **Accept** commits them (and accepts
the faces), **Undo** throws the preview away (greyed without one),
**Edit…** opens the shared Edit dialog on the selection, **clear**
empties the selection. In Review, `A` and `Enter` accept the selection,
`R` rejects it.

## 5.7 Dialogs

- **Edit** — the one dialog for names, groups, descriptions and notes,
  with a scope selector (`Card | Group | Selection`) and suggestions
  throughout (Ch. 1.2–1.3). `Apply` stages, `Accept` commits, `Esc`
  cancels.
- **Group dialogs** — type a group path for the selection (replace with
  *Move to group…*, add with *Add group…*).
- **Merge dialogs** — *Merge similar*, *Merge into…* and the drop-on-person
  confirmation. Merging always asks; it cannot be undone.
- **Confirmations** — the "are you sure" dialogs guarding deletes and
  branch-wide removals.
- **Environment** — where Whot keeps its records and which paths it was
  given (⚙ → environment…, also offered on first run). Read-only header,
  editable values; empty means the built-in default applies.
- **No database yet** — first-run dialog offering to build the record
  store and import the first roll in one flow (Ch. 1.1).
- **Shortcuts** — the `?` dialog listing every keyboard and mouse idiom.

## 5.8 Messages

- **Quiet hints** (info) — "nothing to apply", "no more persons to
  review", "assign a person to bring it back". They go away on the next
  action.
- **Errors** — red, stay until dismissed, always with a **Copy** button
  that captures the full message for a problem report.
- **Reserved character reminder** — descriptions may not contain the `|`
  character: a face can have a description consisting of descriptors like
  "beard" and "sunglasses", separated by a `|`, e.g. "beard|sunglasses|cap".
  The `|` is reserved exclusively for this purpose and can therefore not be
  used as part of a descriptor.

## 5.9 The glyphs, in one table

| Glyph | Meaning |
| --- | --- |
| `✓` | accept / commit |
| `✗` | reject / remove |
| `✕` | close or clear (never a rejection) |
| `★` | set as primary face (and the new-faces total) |
| `◈` | add as reference face |
| `⧉` | merge similar |
| `⌃` / `⌄` | roll groups up / down |
| `⤓` | export the annotated picture |
| `‹` / `›` | previous / next |
| `☐` / `☑` | include sub-branch pictures off / on |
| `?` | help |
