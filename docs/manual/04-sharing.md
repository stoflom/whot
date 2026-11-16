# Chapter 4 — Sharing your data: darktable, digiKam and Lap

Status: outline — writing not started

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

## 4.2 Sharing with darktable and digiKam

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

## 4.3 Sharing with Lap

- How it works in plain words: Lap reads a database of its own. WhoT cannot
  write into Lap's file while Lap is using it, so WhoT prepares a **copy**
  of the database in the shape Lap understands, and updates that copy.
- Steps: run the Lap sharing step, point Lap at the copy, done.
- What to be careful about: Lap should be reading the copy, not editing a
  different file — say how to check.
- What is not touched: WhoT's own records, and Lap's original file.
  ![TODO: screenshot — pointing Lap at the shared copy]
