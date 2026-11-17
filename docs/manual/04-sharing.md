# Chapter 4 — Sharing your data: darktable, digiKam and Lap

Status: Lap section written against the preliminary scripts in the separate
`lap` workspace (to re-check when they are finalised); darktable/digiKam
sidecar writing is outstanding — §4.2 stays marked *planned* until it ships.

*What you will learn: how the face knowledge you built in Whot travels to
the applications you use for managing your picture collection.*

## 4.1 What is shared, and what is not

- What travels: the persons you have named, the groups they live in, and
  the faces they own (descriptions included — see Ch. 1.3).
- What never travels: nothing is removed or changed in Whot, and your
  picture files are never rewritten. Sharing only *adds* information
  somewhere else for another application to read.
- General rule: each sharing step produces its own output, and running it
  again is safe — it updates what was written before instead of duplicating
  it.
- Placeholder names (`Unknown1`, …) and the Rejected bin never travel:
  they carry no real identity yet.

## 4.2 Sharing with darktable and digiKam
*(planned — this step is not yet available)*

The plan, in plain words: many picture programs keep extra facts about a
photograph in a small companion file that sits beside the picture and
travels with it (its "sidecar file"). Whot will write its face knowledge
into those companion files, so darktable, digiKam and Lightroom pick the
names up as if you had tagged the faces there yourself — the names
organised the same way as in Whot, the photographs themselves untouched.

**Until this step ships, nothing you can click or run writes sidecar
files.** This section is a promise of behaviour, documented so you know
what to expect; the rest of this chapter covers what works today.

## 4.3 Sharing with Lap
*(preliminary — the scripts live in the separate `lap` workspace, and the
steps below should be re-checked once they are finalised)*

Lap keeps a library file of its own. Whot never writes into Lap's original
file — instead it makes a **dated copy** of Lap's library (e.g.
`lap-20261116-103000.db`) and brings your face knowledge into that copy.

1. Open a terminal window and go to the folder where the Lap tools live
   (`lap/scripts`).
2. **Rehearse first** — this shows exactly what would change and writes
   nothing at all:

   ```sh
   python3 import_person_faces.py --dry-run
   ```

3. Run it for real (same command without `--dry-run`). It reads Whot's
   records strictly read-only, makes the dated copy, and fills it in.

**What arrives in Lap:**

- Every person you have named who actually appears on a picture Lap knows
  about, matched to Lap's pictures **by the pictures' content, not by
  their file names** — a file that merely has the right name is skipped
  and reported, never filled with the wrong face.
- The person's groups arrive as tags under Lap's People group, e.g.
  `People|family|Smith`. A person filed nowhere gets a plain
  `People|<name>` tag.
- The face positions arrive with the pictures, so Lap shows the same face
  rectangles Whot showed you.

**What is protected:**

- Whot's own records are only ever read.
- Lap's original library file is never written; the copy is a new file
  beside it (or wherever the tools are configured to put it).
- Persons already present in Lap (matched by name, ignoring
  capitalisation) are updated, not duplicated.

**Good to know:**

- Where a picture cannot be matched in Lap at all, neither it nor any
  person seen only on it is imported — nothing half-fills.
- Each run produces a fresh dated copy, so experimenting is free: point
  Lap at the newest copy, and delete the ones you no longer want.
- For Lap to match pictures by content, Lap's own duplicate scan should
  have run once (that is what populates its content list).

![TODO: screenshot — pointing Lap at the shared dated copy]
