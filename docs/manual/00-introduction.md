# Chapter 0 — Concepts and first look

Status: written — awaiting review

*What you will learn: the handful of words Whot uses, and where things live
in the window.*

## 0.1 What Whot does

Whot looks through folders of photographs, finds every face on every
picture, and groups the faces that look alike. You then give each group a
name — and from that moment, every picture a person appears in is one click
away. Whot does not organise or edit your photographs; it remembers who is
in them, and shares that knowledge with the tools that do (Ch. 4).

## 0.2 The four words you need

- **Film roll** — a folder of photographs you bring into Whot at one time.
- **Face** — one face Whot has found on one picture.
- **Person** — a name in Whot's list ("Aunt May"). One person can have many
  faces; a face belongs to exactly one person.
- **Group** — a folder-like home for persons, e.g. `family|Smith`. The `|`
  character separates the levels, so `family|Smith|Marianne` means
  *family → Smith → Marianne*. Groups can nest as deeply as you like.

  While a person is new, Whot parks them under one of three **status
  branches** in the list: **New** (not yet reviewed), **Accepted**
  (reviewed, not yet filed into a real group) and **Rejected** (the bin —
  see the glossary). You never type these three names yourself; Whot
  manages them.

## 0.3 The window at a glance

![TODO: annotated full-window screenshot with the five areas numbered]

1. **Top bar** — switch between the three views (**Review**, **Rolls**,
   **Person**), see the database-wide face totals (`★` new, `✓` accepted,
   `✗` rejected), choose what the `Show` filter displays, refresh, open the
   keyboard help (`?`) and the settings (⚙).
2. **Left pane** — the list of persons and groups, arranged like folders.
   Type in its filter box to find a person fast.
3. **Centre pane** — the faces or pictures you are currently working on.
   What it shows depends on the view chosen in the top bar.
4. **Right pane** — everything about the one person you have selected:
   their name, groups, note, representative picture and reference faces.
5. **Rule bar** (bottom) — the buttons that act on whatever faces you have
   selected.

The two dividers between the panes can be dragged to resize them;
double-clicking a divider puts it back.

## 0.4 What happens to your photographs

Whot never edits, moves or renames your picture files. It keeps its own
record of faces, names and groups, and always remembers where each picture
lives. You can open the original picture, or the folder it sits in, from
inside Whot at any time (Ch. 1.5).

## 0.5 Glossary

- **accept** — mark a face as reviewed and correct ("yes, this is Aunt
  May"). Accepted faces turn their status badge green (✓).
- **assign** — send one or more faces to a person. Assigning a name is the
  same as accepting and naming at once.
- **description** — the short tag string on a face, e.g. `beard|sunglasses`
  (Ch. 1.3).
- **face** — one face Whot has found on one picture.
- **group** — a folder-like home for persons (`family|Smith`).
- **pending face** — a face not yet accepted or rejected. Pending faces
  show an orange New badge.
- **person** — a named identity one or more faces belong to.
- **primary face** — the one picture that represents a person everywhere
  (star ★).
- **reject** — file a face away in the Rejected bin because it is not a
  face worth keeping (not a face at all, a pet, a poster…). Nothing is
  deleted.
- **film roll** — a folder of photographs brought into Whot at one time.
- **the Rejected bin** — where every rejected face goes. It looks like a
  person called `Rejected…` in the list, is only visible under
  `Show → Rejected`, and the only way to take a face out is to assign it to
  a person (Ch. 1.2).
