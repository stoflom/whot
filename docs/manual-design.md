# WhoT Face Manager — User Manual Design

**Version: 1.0** (major.minor per `AGENTS.md`; major = new chapter or restructuring,
minor = change or correction of the manual design; a chapter revision that
only fills in planned content does not bump this document — the chapter's own
status line records its progress).

This document governs the **user manual**: a set of short, non-technical
documents that teach a photo-collecting user — not a programmer — how to use
WhoT. The manual is a *communication* deliverable: it describes behaviour that
already exists (or is specified in the design documents); it never invents
behaviour. Where the manual and a design document disagree, the design
document is right and the manual must be fixed. Issues for manual work carry
the `manual` label.

## 1. Audience and goal

- The reader manages a personal photo archive and has used ordinary desktop
  photo software. They are not expected to know programming, databases or
  command lines.
- Goal: the reader can, without outside help, import and review a film roll,
  re-import one, recover older face data, and share their WhoT results with
  other applications.
- Every chapter is **short and to the point**: task-first, steps in order, no
  background theory a reader does not need to act.

## 2. Document set

All manual files live in `docs/manual/`:

| File | Chapter | Master-issue sub-issue |
|---|---|---|
| `docs/manual/README.md` | Manual front page: what WhoT does, table of contents | — (part of the master issue) |
| `docs/manual/00-introduction.md` | Ch. 0 — Concepts and first look | Chapter 0 |
| `docs/manual/01-film-roll.md` | Ch. 1 — A film roll: import, review, edit, export | Chapter 1 |
| `docs/manual/02-reimport.md` | Ch. 2 — Re-importing a film roll | Chapter 2 |
| `docs/manual/03-legacy-recovery.md` | Ch. 3 — Recovering legacy data | Chapter 3 |
| `docs/manual/04-sharing.md` | Ch. 4 — Sharing your data: darktable, digiKam, Lap | Chapter 4 |
| `docs/manual/05-reference.md` | Ch. 5 — Reference: modes, panes and dialogs | Chapter 5 |

Each chapter file opens with a one-line status note
(`Status: outline — writing not started`) so progress is visible at a glance.

## 3. Style rules

1. **Plain words.** Never use: SQL, SQLite, embeddings, hashes, BLAKE3,
   clusters (say "group of similar faces"), sidecar internals, Tauri, React,
   Python, or design-document section numbers (`§4.x`). The app is always
   "the app" or "WhoT".
2. **Permitted technical touching points.** A chapter may name a *file or
   folder the user can see and act on* (e.g. the roll folder, the database
   copy that Lap reads, the sidecar file that darktable reads) — described
   functionally, never by internals.
3. **Task-first structure.** Each chapter: one-sentence "what you can do",
   then numbered how-to steps, then a short "good to know" list of rules the
   reader cannot change (reserved characters, what is undone/not undone).
4. **Steps.** Imperative voice, one action per step, UI labels in the exact
   wording the interface shows (e.g. `Show`, `↻ merge similar`).
5. **Screenshots.** Every chapter lists its screenshots as
   `![TODO: description]` placeholders until real ones are captured.
6. **Reserved character rule** (stated verbatim wherever descriptions are
   taught or referenced — Ch. 1 and Ch. 5):

   > A face can have a description consisting of a string of descriptors
   > like, "beard" and "sunglasses", separated by a `|`, e.g. "baby",
   > "beard|sunglasses|cap". The `|` is reserved exclusively for this purpose
   > and can therefore not be used as part of a descriptor.

7. **No duplication.** A rule is explained fully once; other chapters link
   to it ("see Ch. 1, *Describing a face*").
8. **Honesty about danger.** Anything that cannot be undone (merging
   persons, deleting a group) is marked as such in the step itself, not in
   fine print.

## 4. Terminology (fixed across the manual)

| Manual term | Meaning for the reader |
|---|---|
| film roll | a folder of photographs brought into WhoT at one time |
| face | one detected face on one picture |
| person | a named identity one or more faces belong to |
| group | a folder-like home for persons (e.g. `family|Smith`) |
| description | the short tag string on a face (`beard|sunglasses`) |
| pending faces | faces not yet accepted or rejected |
| the Rejected bin | the hidden "person" holding every rejected face |

## 5. Chapter briefs

- **Ch. 0 — Concepts and first look.** What WhoT is for, the four-word
  mental model (rolls → faces → persons → groups), the window's five areas
  at a glance, glossary.
- **Ch. 1 — A film roll.** The full life of a roll: import (choose folder,
  what happens, watching progress), review (pending faces, accept / reject /
  assign, naming), editing (renaming, moving between groups, describing
  faces — the `|` rule, primary face, rotating), export (annotated full-size
  images, opening originals).
- **Ch. 2 — Re-importing a film roll.** When to re-import, what changes and
  what is protected (accepted work stays), how to run it, how to tell it
  worked.
- **Ch. 3 — Recovering legacy data.** What "legacy" means (faces you already
  named in digiKam, Lightroom or darktable), the safe two-step pattern
  (collect → try on a copy), fixing photos that cannot be found (path
  mapping in plain words), checking the result, keeping or discarding.
- **Ch. 4 — Sharing your data.** Sending WhoT's face knowledge to other
  applications: darktable and digiKam (WhoT writes its person names into the
  pictures' sidecar files), Lap (WhoT updates a copy of its own database
  that Lap can read). What is written, what is not touched, how to verify.
- **Ch. 5 — Reference.** A field guide to every visible control: top bar
  (tabs, `Show` filter, refresh, settings), left pane person tree (status
  branches, drag and drop, right-click menus), centre pane's three modes
  (Review, Rolls, Person), detail pane, rule bar, full-size view with the
  face rectangles, and one short entry per dialog and message. Alphabetical
  or by screen area — by screen area, matching Ch. 0's tour.

## 6. Non-goals

- No setup or installation instructions (those stay in `README.md`; the
  manual links to it once for the "who sets up my copy" case).
- No descriptions of future or unimplemented behaviour beyond clearly marked
  "planned" notes inside Ch. 4 where an export target is not yet shipping.
- No developer-facing content: that stays in the design documents.
