# Chapter 3 — Recovering legacy data

Status: written — awaiting review

*What you will learn: how to collect the face names you already made in
other programs — digiKam, Lightroom or darktable — and bring them into
Whot, without risking the work you have already done in Whot.*

## 3.1 What "legacy data" means

You may already have spent hours tagging faces in another program.
Recovery collects those names and the face positions they mark, and
attaches them to the faces Whot has found on the same pictures.

Two promises, kept by design:

- Recovery **only reads** the other programs' records — it never changes
  them, and never touches your picture files.
- It **never adds** pictures or faces to Whot. A picture Whot has not
  imported cannot receive a recovered name.

## 3.2 The safe two-step pattern

### Step 1 — Collect

Whot reads the records of each program you point it at — digiKam's face
database, a Lightroom catalogue, darktable's sidecar files — and writes
everything it finds into a private, separate collection file of its own.

1. Open a terminal window (the plain window where commands are typed).
2. Run the collect step once per source, e.g.:

   ```sh
   python3 scripts/harvest_legacy.py --out faces-collected.db \
       --images "/path/to/pictures" \
       --digikam-db "/path/to/digikam.db"
   ```

   (run it from the Whot project folder; each source you have —
   `--digikam-db`, `--lightroom-catalog`, darktable sidecars along the
   `--images` trees — is a separate switch, and a switch you leave out
   simply means "this source does not apply to me".)

3. **When pictures cannot be found**, write a small *path map* file — a
   plain text list that says where things were then versus where they are
   now, one rule per line:

   ```text
   # where it was then          = where it is now
   D:/images/PicFiles           = /media/usb/PicFiles
   ```

   and hand the file to the collect step with `--path-map yourmap.txt`.
   Old drive letters pointing at today's external drives are the normal
   case. Lines starting with `!` deliberately switch a whole subtree off.

4. Re-run the collect step as often as needed; each run starts fresh and
   fills in what the last one missed. If a large share of the pictures
   still cannot be found, the run ends with a loud warning naming the
   locations it could not map — extend the path map and go again.

### Step 2 — Try on a copy

The second step matches the collected names against Whot's own faces — but
it works on a **copy** of Whot's records. Your real records are never
written to.

1. **Rehearse first**, with a switch that shows what would happen:

   ```sh
   python3 scripts/import_harvested.py faces-collected.db --dry-run
   ```

   The summary tells you how much of the collection could actually be
   matched (`usable faces N/M (P%)`) and writes a log listing every
   picture that could not be matched, by its full path — hunt down the
   stragglers, extend the path map, collect again.

2. **Run it for real** (same command without the rehearsal switch). It
   produces a new dated copy of Whot's records with the old names
   attached, plus the matching log. Matching is strict: a face is claimed
   only when the recovered position clearly overlaps Whot's own face on
   the same picture.

## 3.3 Looking at the result, and deciding

1. Point the app at the new copy (the manual for your setup explains the
   switch — or symlink the copy over the app's record file) and open Whot.
2. The recovered names arrive **pending**, like any new work: spot-check
   the persons and confirm them in Review as usual.
3. **Happy** → keep the copy: leave the app pointed at it (or move it into
   place after backing up the original).
4. **Not happy** → point the app back at the original and delete the copy.
   Nothing else remembers it.

## 3.4 Good to know

- **Repeating is normal and safe**: applying the same collection twice
  does not create duplicate people — the second run recognises its own
  earlier work and changes nothing.
- Where a recovered person is new, Whot creates them; where the name
  matches someone already in Whot, the faces join that person.
- Every recovered link arrives pending — nothing is ever confirmed behind
  your back.
- Before pointing the pattern at your whole archive, try it on a small
  practice set: Whot ships a hand-picked sample folder with real legacy
  data for exactly this (ask the person who set up your copy, or see the
  project README's *archive fixture*).
