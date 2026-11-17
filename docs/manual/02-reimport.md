# Chapter 2 — Re-importing a film roll

Status: written — awaiting review

*What you will learn: how to bring a roll in a second time — after you have
added pictures to it, or after your face-recognition review has moved on —
without losing the naming work you have already done.*

## 2.1 When to re-import

Typical reasons:

- Pictures were **added** to a folder you already imported.
- Faces you once left pending — or even rejected — are **recognisable
  now**, because you have since named the person they belong to.
- You want the roll looked at again after a first import that grouped
  faces badly.

In one sentence: re-importing looks at the pictures again and matches what
it finds against what it found last time, so your accepted work stays put.

## 2.2 How to re-import

Two ways to reach the same place:

- From the rolls tree: click a folder branch's **⇩** icon, or right-click
  the branch → **Re-import…**. The import pane opens with **Re-import**
  already ticked for that folder.
- From the path box: commit the folder's path as for a first import
  (Ch. 1.1) and tick **Re-import** in the options.

Then click **start** and watch the progress as usual. `--dry-run` works
here too — a rehearsal that writes nothing.

## 2.3 What changes and what is protected

- **Protected**: every face you have **accepted** stays exactly as you left
  it, and faces set aside permanently stay that way too.
- **Second chance**: faces that were still **pending**, and faces you had
  **rejected**, are matched against what Whot knows today. A face that now
  matches a named person is re-linked to them (still pending — you confirm
  in Review as usual). Even a rejected face gets this second look: the
  re-scan is your deliberate rework of the roll.
- **New pictures** in the same folder import as usual, alongside the old.
- **Left alone**: old face positions on a picture that the new look cannot
  match up are kept untouched and simply counted in the report.

**Good to know**

- Running the same re-import twice does not create duplicates — the second
  run recognises its own earlier work.
- Each run is recorded as its own import, so the report can always tell
  you what a given run changed: pictures reworked, faces kept, re-linked,
  newly found, left unmatched.
- If a picture was previously imported *without* faces being found, a
  re-import that now finds some turns it into a normal scanned picture.

![TODO: screenshot — the import pane with Re-import ticked]

## 2.4 Checking the result

1. The newly re-linked pending faces appear under `Show → New` — review
   them as usual (Ch. 1.2).
2. Read the run's summary in the import pane: it names how many pictures
   were reworked and how their faces fared.
3. Anything unexpected? Your accepted faces were never in the re-import's
   way — check the summary counts for unmatched faces, and re-run at will;
   repeat runs change nothing beyond the report.
