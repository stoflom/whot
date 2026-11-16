# Chapter 5 — Reference: modes, panes and dialogs

Status: outline — writing not started

*A field guide to every control in the window. Entries are short by design;
each says what it is for and where to read more.*

## 5.1 Top bar

- **Tabs `Review` / `Rolls` / `Person`** — the three views; what each shows.
- **`Show` filter `All | New | Accepted | Rejected`** — which faces exist
  anywhere; note that it also trims the person tree, and that `All` hides
  rejected faces unless you pick `Rejected`.
- **`↻`** — re-read everything now (normally the app keeps itself up to
  date on its own).
- **Settings (⚙)** — the settings popover; each setting in one line.

## 5.2 Left pane — the person tree

- What the tree shows: groups as folders, persons inside them, and the
  three status branches (`New`, `Accepted`, `Rejected`) that collect
  not-yet-filed persons.
- Why a person may appear under more than one group.
- **Drag and drop** — moving a person between groups; what exactly moves.
- **Right-click menus** — one entry per menu and per item (rows, group
  branches, cards).
- **`⧉ merge similar`** — the helper that finds near-identical names.

## 5.3 Centre pane — the three modes

- **Review mode** — pending faces grouped by their placeholder groups;
  working through them (links to Ch. 1.2).
- **Rolls mode** — your picture folders as they are on disk; how branches
  and thumbnails work; selecting a folder selects its pictures.
- **Person mode** — one person's faces; the cluster-group toggle and what
  it shows.
- **Double-click behaviour** in each mode — the annotated full-size view.
- **Full-size view** — face rectangles on the picture, the `‹ n/m ›`
  stepper and the arrow keys, how to leave it.

## 5.4 Detail pane

- Every field and control: name, group path, note, primary face,
  reference crops (what they are for), counts.

## 5.5 Rule bar

- The buttons that act on the current selection; which buttons appear when.

## 5.6 Dialogs

One short entry each — purpose, what it asks, what it does, whether it can
be undone:

- **Edit dialog** — renaming/describing.
- **Group dialogs** — create a group, choose a group for faces/persons.
- **Merge into person / Merge similar / Face merge** — the three merging
  helpers, and that merging is always confirmed because it cannot be undone.
- **Confirmation dialogs** — the generic "are you sure" and its rules.
- **Environment dialog** — where your copy of WhoT keeps its records and
  settings (read-only view).
- **First-run dialog** — what appears when no records exist yet.
- **Import pane** — choosing a folder, the options, progress, stopping.

## 5.7 Messages

- **Toasts** — the small confirmations and errors at the edge of the
  window; what kinds appear.
- **Reserved character reminder** — descriptions may not contain the `|`
  character: a face can have a description consisting of descriptors like
  "beard" and "sunglasses", separated by a `|`, e.g. "beard|sunglasses|cap".
  The `|` is reserved exclusively for this purpose and can therefore not be
  used as part of a descriptor.
