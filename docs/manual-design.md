# WhoT Face Manager — User Manual Design

**Version: 2.0** (v1.0: the initial design; v2.0: added the installation
chapter. Major.minor per `AGENTS.md`; major = new chapter or restructuring,
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
| `docs/manual/06-installation.md` | Ch. 6 — Installation (Linux: package or sources) | Chapter 6 |

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
  **Implementation status (2026-11):** Lap export exists as preliminary
  scripts in the separate `lap` workspace (`scripts/import_person_faces.py`;
  `scripts/import_darktable_tags.py` is the *reverse* direction — darktable
  tags/ratings into Lap — and belongs to Ch. 3's topic, not Ch. 4). Ch. 4's
  Lap section is written against those scripts' user-visible behaviour only
  (dated working copy, preview-before-commit, picture identity checked by
  content, only named persons shared); it must be re-checked when the
  scripts are finalised or integrated into this repository. The
  darktable/Lightroom/digiKam sidecar *writer* is still outstanding — until
  it ships, §4.2 stays a clearly marked *planned* section.
- **Ch. 5 — Reference.** A field guide to every visible control: top bar
  (tabs, `Show` filter, refresh, settings), left pane person tree (status
  branches, drag and drop, right-click menus), centre pane's three modes
  (Review, Rolls, Person), detail pane, rule bar, full-size view with the
  face rectangles, and one short entry per dialog and message. Alphabetical
  or by screen area — by screen area, matching Ch. 0's tour.
- **Ch. 6 — Installation (Linux only, two routes).** **§6.1 from a
  package** — the three Linux variants the build produces (`.deb`,
  `.rpm`, AppImage), each with its prerequisites, what first use sets up
  (the user config and data home), and the honest limitation that the
  roll-import scripts are not packaged yet. **§6.2 from sources** —
  first the *minimal* route to a running app (Node, the Rust toolchain,
  the WebKitGTK/GTK system libraries, `npm install`, `npm run tauri
  dev`), then the *full development platform* (the same `npm run tauri
  build` that produces the packages, plus the test suites: vitest /
  `tsc` / ESLint, `cargo test` with a built `dist/`, the Python pytest
  suite, and the mocked-backend GUI harness). Both routes end with the
  **insightface venv** in brief: creating it, the packages it needs, and
  pointing Whot at it (`INSIGHTFACE_PATH` — `.env` in repo mode, the
  environment dialog in installed mode). This is the one chapter allowed
  to be command-heavy: every command it prints is one the reader must
  type, and package names are named exactly. It stays on Linux; macOS
  and Windows are out of scope.

## 6. Non-goals

- No descriptions of future or unimplemented behaviour beyond clearly marked
  "planned" notes inside Ch. 4 where an export target is not yet shipping.
- No developer-facing content: that stays in the design documents. (The
  one exception is Ch. 6, which by necessity walks through the developer
  platform's own installation for the from-sources route — but as steps
  to run, not as architecture.)
- Installation is **Linux-only** for now: the package route covers the
  three variants the build produces, the sources route assumes a Linux
  desktop. macOS and Windows are out of scope.
