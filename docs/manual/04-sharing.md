# Chapter 4 — Sharing your data: darktable, digiKam and Lap

Status: outline — writing not started
(Lap: preliminary scripts exist in the separate `lap` workspace, see
`docs/manual-design.md` §5; darktable/digiKam sidecar writing: outstanding
— §4.2 stays marked *planned* until it ships.)

*What you will learn: how the face knowledge you built in Whot travels to
the applications you use for managing your picture collection.*

## 4.1 What is shared, and what is not

- What travels: person names, group paths, and the faces they belong to
  (including face descriptions, see Ch. 1.3).
- What never travels: nothing is removed or changed in WhoT; your picture
  files are never rewritten — sharing only *adds* information for the other
  application to read.
- General rule: each sharing step works on its own output; running it
  again is safe and updates what was written before.
  ![TODO: screenshot — one picture's shared result in another application]

## 4.2 Sharing with darktable and digiKam *(planned — the sidecar writer is not yet available)*

- How it works in plain words: many picture programs keep extra facts about
  a photograph in a small companion file that sits beside the picture and
  travels with it. WhoT writes its face knowledge into that companion file,
  so darktable and digiKam pick the names up as if you had tagged them
  there yourself.
- What you will see in the other program: the person names, organised the
  same way as in WhoT.
- What is not touched: the photographs themselves, and WhoT's own records.
- Steps: choose the pictures (a roll, or your whole collection), run the
  sharing step, open darktable/digiKam and check the names arrived.
- Good to know: a picture program that has the picture open at that moment
  may not notice new companion-file facts immediately — reopen it.
  ![TODO: screenshot — the names as they appear in darktable/digiKam]

## 4.3 Sharing with Lap *(preliminary scripts exist; to re-check when final)*

- How it works in plain words: Lap keeps a library file of its own. WhoT
  never writes into Lap's original file — instead it makes a **dated copy**
  of Lap's library and brings the face knowledge into that copy.
- What is shared, and what is held back:
  - Only persons you have actually named are shared. Placeholder names
    (`Unknown1`, …) and the Rejected bin are left out — they carry no real
    identity.
  - Every group the person belongs to arrives as a `People|…` tag in Lap,
    e.g. `People|family|Smith`. Persons filed nowhere get a plain
    `People|<name>` tag.
  - Face positions arrive with the pictures, so Lap shows the same face
    rectangles WhoT showed you.
- Safety rails:
  - **Try before you commit**: a preview mode shows exactly what would
    change and writes nothing at all.
  - **The right pictures only**: each picture's identity is confirmed by
    its content, not just its file name — a file that merely has the right
    name is skipped and reported, never filled with the wrong face.
  - Where a picture cannot be matched in Lap at all, neither it nor any
    person seen only on it is imported.
  - Persons already present in Lap (matched by name, ignoring
    capitalisation) are updated, not duplicated.
- Steps: run the Lap sharing step, look at the preview, run it for real,
  then point Lap at the new dated copy.
- Good to know: each run produces a fresh dated copy, so repeating the step
  is safe; your Lap original and WhoT's own records are never touched.
  ![TODO: screenshot — pointing Lap at the shared dated copy]
