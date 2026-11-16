# Chapter 3 — Recovering legacy data

Status: outline — writing not started

*What you will learn: how to collect the face names you already made in
other programs — digiKam, Lightroom or darktable — and bring them into
Whot, without risking the work you have already done in Whot.*

## 3.1 What "legacy data" means

- You may already have tagged faces in another program. Recovery collects
  those names and their marked face positions.
- Important promise: recovery never changes Whot's existing face list and
  never touches the other programs' files — it only reads them.
- It does not bring in new pictures or new faces; it only attaches old
  names to the faces Whot already knows.

## 3.2 The safe two-step pattern

Everything happens in two steps, and both are safe by design:

### Step 1 — Collect (harvest)

- What it does: reads the other programs' records and writes them to a
  private, separate collection file.
- What to give it: where your pictures live, and where each program kept
  its records. Where to find each of those (plain pointers, no internals).
- What to do when pictures cannot be found: the path map — a simple list
  you write in a text file that says "where it was then" = "where it is
  now", e.g. an old drive letter pointing at today's external drive.
- You can run the collection again as often as you like; each run starts
  fresh and fills in what the last one missed.
  ![TODO: screenshot — a path map file]

### Step 2 — Try on a copy (import)

- What it does: matches the collected names against Whot's own faces — but
  it works on a **copy** of Whot's records. Your real records are never
  written to.
- Always try first: run it in "just show me" mode and read the summary —
  it tells you how much of the collection could actually be matched.
- Then run it for real; it produces a new copy with the old names attached.
- Every picture that could not be matched is listed by name in a log, so
  you can hunt down the stragglers and run again.

## 3.3 Looking at the result, and deciding

1. Point the app at the new copy and look around: the recovered names
   arrive pending, like any new work — confirm them in the app as usual.
2. Happy with it: keep the copy (the manual says where the switch lives).
3. Not happy: point the app back at your original records and delete the
   copy. Nothing else remembers the copy.

## 3.4 Good to know

- Repeating the whole two-step pattern after fixing your path map is
  normal and safe — the same collection applied twice does not create
  duplicate people.
- If a large share of the pictures could not be found, the run warns you
  loudly and tells you exactly which old locations it could not map.
- Where to get a small practice set to try the whole pattern before
  pointing it at your real archive.
