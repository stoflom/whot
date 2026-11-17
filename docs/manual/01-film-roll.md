# Chapter 1 — A film roll: import, review, edit, export

Status: written — awaiting review

*What you will learn: the full life of one film roll — bringing it in,
naming its faces, touching up your work, and taking results out.*

## 1.1 Importing a roll

A film roll is any folder of photographs — a camera card's worth, a year of
phone pictures, a scanned archive. Whot looks at every picture in the
folder, finds the faces, and groups the ones that look alike.

1. Open the **Rolls** view in the top bar.
2. In the path box at the top of the centre pane, type the folder's path —
   or click **browse…** and pick the folder.
3. Because the folder is not in Whot yet, the **import pane** opens on the
   right.
4. Look over the options (their defaults are sensible):
   - `--recursive` (ticked) — pictures in sub-folders are included too.
   - `--all` — also import pictures in which no face is found.
   - `--dry-run` — a rehearsal: Whot reports what it *would* do and writes
     nothing.
   - `--threshold` — how alike two faces must look before Whot calls them
     the same person. Leave it at the default unless a roll groups faces
     badly.
5. Click **start**. The pane shows the progress, picture by picture, and a
   final summary.

**Good to know**

- The import runs alongside the app: you can keep reviewing, close the
  pane (✕) or even switch views — the import carries on, and one run at a
  time is the limit. **stop** cancels the run in progress.
- When the run finishes, the new faces appear in the rolls tree and under
  Review. If it fails, the captured output stays on screen; the error text
  can be copied with its **Copy** button for filing a problem report.
- First time ever: Whot shows a *No database yet* dialog. **Open import
  pane** lets you pick your first folder in the same flow — Whot creates
  its record store and imports the roll in one go.
- Faces arrive grouped as `Unknown1`, `Unknown2`, … and are parked under
  the **New** branch, waiting for review.
- Import never writes to your picture files.

![TODO: screenshot — the import pane mid-import]

## 1.2 Reviewing the faces

Reviewing means deciding, face by face, one of three things: **accept**
("this is who I say it is"), **reject** ("not a face worth keeping"), or
**assign** ("this belongs to that person").

Click **Review** in the top bar. Whot shows the pending faces grouped by
their `Unknown…` groups, each with a select-all box and its face count. The
padlock 🔒 beside the `Show` filter reminds you that Review is focused on
the **New** faces; the way out of Review is choosing **Rolls** or **Person**
in the top bar.

**Naming a group** (the normal flow — this accepts and names in one step):

1. Tick the group's faces (or use the header's select-all box).
2. Click **Edit…** in the group header or the rule bar.
3. Type the person's name. Whot suggests names you have used before —
   picking a suggestion sends the faces to that existing person.
4. Optionally type a **Person group** path, e.g. `family|Smith`.
5. Click **Accept** (the dialog's Accept commits what you typed and accepts
   the faces).

**Accepting without a name**: select faces and click **✓ Accept** in the
rule bar (or press `A`). They stay with their `Unknown…` group but count as
reviewed. Faces you have already rejected are skipped by plain accept.

**Rejecting**: select faces and click **✗ Reject** (or press `R`). Rejected
faces move to the **Rejected bin** and are visible only under
`Show → Rejected` (plus the `✗` total in the top bar). Rejecting is safe —
it deletes nothing.

**The way back from the bin is an assignment.** Plain accept never
un-rejects; set `Show → Rejected`, select the faces, and use **Edit…** to
give them a person. That claim moves them out of the bin.

**Good to know**

- Accepting a whole group by naming it is the same as reviewing each face
  by hand — only much faster.
- `Show` decides which faces exist anywhere: `All | New | Accepted |
  Rejected`. Switching it also trims the person list on the left. Set it
  back to `All` to see everyone again.
- Whot marks the moment your changes become visible on screen before the
  record is written; if a change fails, it is rolled back and an error
  toast appears.
- Keyboard: `A` accepts and `R` rejects the selection, `Space` ticks the
  card under the mouse, `Ctrl-A` selects the whole view, `←`/`→` step
  between persons. The `?` button lists all shortcuts.

![TODO: screenshot — the Review view with a pending group]

## 1.3 Editing your work

**Renaming a person**: double-click the person's row in the left pane and
type the new name (Enter commits, Esc cancels), or edit the **Name** field
in the right pane. If the new name is already taken by another person, the
two are merged — the faces join the existing person.

**Moving a person to another group**: drag the person's row onto a group in
the left pane; or right-click the row and choose **Move to group…** (this
replaces their group). **Add group…** in the same menu adds an *additional*
group — a person may live under several.

**Describing a face** — a face can carry a short description made of
descriptors such as "beard" and "sunglasses":

> A face can have a description consisting of a string of descriptors like,
> "beard" and "sunglasses", separated by a `|`, e.g. "baby",
> "beard|sunglasses|cap". The `|` is reserved exclusively for this purpose
> and can therefore not be used as part of a descriptor.

1. Select the face(s) and open **Edit…**.
2. In **Face description**, type the tags separated by `|`. Whot suggests
   tags you have used before and completes them.
3. **Apply** previews the change on the cards; **Accept** makes it
   permanent; **Undo** throws the preview away.

Tip: starting the field with `|` *adds* tags instead of replacing —
typing `|beard` on a face that already says `baby` makes it
`baby|beard`. Whot never creates duplicates.

**Choosing a person's representative picture**: on a face card, click
**★ set as primary**. Whot also keeps a small set of **reference faces**
per person and per appearance automatically; pin any face to the set with
**◈ add as reference**.

**Rotating**: use ⟲ / ⟳ on a card (correct one face crop) or on a full
image (turns the whole picture, together with its face rectangles). The
rotation sticks.

**Merging two persons who turned out to be the same**: select them in the
left pane (Ctrl-click), drag onto the person to keep, and confirm in the
dialog Whot shows. Merging **cannot be undone** — the faces join the target
and the empty shells disappear — which is why Whot always asks first.

![TODO: screenshot — the Edit dialog]

## 1.4 Fixing groups

- **Create**: right-click a person row → **Add group…** and type a new
  path (e.g. `friends|college`). The group exists as soon as a person is
  in it.
- **Rename or move a group**: right-click the group branch →
  **rename/move…**. Every person inside moves with it.
- **Delete a group**: right-click the branch → **delete group** (Whot
  asks to confirm). The persons fall back to their status branch
  (New/Accepted) — nobody is lost, but they are no longer filed, so re-group
  them as needed.
- **Tidy up near-identical names**: click the **⧉** button at the top of
  the left pane. Whot lists clusters of names that look alike (case
  variants, "Smith" vs "Smith 2", small typos), with the evidence for each.
  Tick the ones that are the same person and merge them into one — again
  with a confirmation, because merging cannot be undone.

## 1.5 Exporting what you made

**The annotated full-size view**: double-click any face card or thumbnail
and the full picture opens with a rectangle around every visible face,
labelled with the person's name. Hover a rectangle to find its card;
click a rectangle to select that face. Close with **✕** or `Esc`.

**Stepping through a roll**: with a full image open, the bar above it
shows `‹ n/m ›` — the arrows (or the `←`/`→` keys) walk through the
pictures of the folder you are browsing.

**Saving an annotated picture**: click **⤓** (or right-click the image →
**Export annotated image…**). Choose file type (PNG/JPEG/WebP), size, and
where to save; the exported file is the picture exactly as you see it,
rectangles and names baked in. **Open after export** shows the result in
your image viewer immediately.

**Opening the original**: right-click a face card or image →
**Open in system viewer** opens the original picture; **Open roll path**
shows its folder in the file manager.

What you have built also travels outward — to darktable, digiKam or Lap —
without touching your photographs. That is Chapter 4.

![TODO: screenshot — the annotated full-size view with the export button]
