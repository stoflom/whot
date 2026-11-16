# Chapter 1 — A film roll: import, review, edit, export

Status: outline — writing not started

*What you will learn: the full life of one film roll — bringing it in,
naming its faces, touching up your work, and taking results out.*

## 1.1 Importing a roll

- What a roll is (pointer to Ch. 0.2).
- How to import:
  1. Open the `Rolls` view and choose to import (or start it from the
     import pane).
  2. Pick the folder that holds the photographs.
  3. Watch the progress; the app tells you when it is done.
- What happens during import, in plain words: every picture is looked at,
  every face found is remembered, similar faces are grouped together, and
  each group gets a placeholder name like `Unknown1`.
- Good to know:
  - Pictures without any faces can be brought in too (say where the switch
    for that is).
  - Import runs in the background; you can keep working, and you can stop
    it while it runs.
  - Nothing is written to your picture files.
  ![TODO: screenshot — the import pane mid-import]

## 1.2 Reviewing the faces

- What "review" means: every face waits for one of three decisions —
  **accept** (it is who you say it is), **reject** (it is not a face worth
  keeping), or **assign** (it belongs to a person you already named).
- The `Show` filter in the top bar decides which faces you see
  (`All | New | Accepted | Rejected`).
- How to name a group of pending faces:
  1. Select the group (`Unknown1`, `Unknown2`, …) in the centre pane.
  2. Type the person's name and, if you wish, their group path.
  3. Confirm — the person is created and the faces are accepted.
- How to reject a face: select it, press **Reject**. Rejected faces move to
  the Rejected bin (see Ch. 0.5); the only way back is to assign them to a
  person.
- How to accept or assign:
  - Accept: the face stays where it is but counts as reviewed.
  - Assign: send one or more selected faces to an existing person, or to a
    brand-new one.
- Good to know:
  - Naming a placeholder group accepts all of its faces at once.
  - Rejecting is safe — it never deletes anything, it only files the face
    away.
  ![TODO: screenshot — the Review view with a pending group]

## 1.3 Editing your work

- Renaming a person (detail pane or right-click menu).
- Moving a person to another group (drag onto a group in the left pane, or
  the person's group path in the detail pane).
- **Describing a face**: a face can carry a short description made of
  descriptors such as "beard" and "sunglasses".
  - State verbatim: a face can have a description consisting of a string of
    descriptors like, "beard" and "sunglasses", separated by a `|`, e.g.
    "baby", "beard|sunglasses|cap". The `|` is reserved exclusively for this
    purpose and can therefore not be used as part of a descriptor.
  - How to set it (per face, or for several faces at once).
  - Good to know: the description travels with the face wherever it shows,
    including exports (Ch. 1.5) and sharing (Ch. 4).
- Choosing a person's **primary face** — the picture that represents them.
- Rotating pictures and faces (whole picture, or one face).
- Merging two persons who turned out to be the same — **cannot be undone**;
  the app always asks first.
- ![TODO: screenshot — the detail pane]

## 1.4 Fixing groups

- Creating, renaming and deleting groups.
- Good to know: a person always keeps at least one group; deleting a group
  sends its persons back to their review state, it never deletes persons.
- Merging similar names (the `⧉ merge similar` helper) — when to use it,
  how to read its suggestions.

## 1.5 Exporting what you made

- Opening a face at full size with all its rectangles drawn, and stepping
  through the pictures of a roll (`‹ n/m ›` or the arrow keys).
- Opening the original picture or its folder from WhoT.
- What "export" means for a roll: the annotated full-size view, the
  person's reference crops, and how the same knowledge reaches other
  applications (full story in Ch. 4).
  ![TODO: screenshot — the annotated full-size view]
