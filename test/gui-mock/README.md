# GUI mock harness (visual/contract review of the Tauri frontend)

Drives the built frontend against an in-memory mock of the Tauri
backend, seeded from a real `faces.db` dump — in **WebKitGTK by default** (the engine Tauri actually ships, so
engine-specific bugs are caught by the suite), with Firefox retained
as a runtime choice. Used to review the
Review GUI (layout geometry — heading above cards in every section,
dimmed empty-label hints with normal row height, the §4.24/§4.30
stage-then-commit contract, escape-or-accept, Esc ordering, no-op
feedback, selection-toggle render time (§4.31), stepping and
empty-state hints (§4.41), tree/group/merge contracts)
without running the Rust backend or touching the real database.

## Files

| file | role |
| --- | --- |
| `dump_snap.py` | sanitized dump of `data/faces.db` → `snap.json` (gitignored): no personal names, surnames, notes or home paths survive (see Sanitization); `--raw` for a debugging dump |
| `mock.js` | in-memory `window.__TAURI_INTERNALS__` emulator (command list in the file header) |
| `server.py` | serves `dist/`, rewrites `index.html` to load `mock.js` before the app bundle; serves `/snap.json` |
| `webkit_tester.py` | the WebKitGTK driver: Selenium `Remote` → system `WebKitWebDriver`, `.text`/occlusion fixes (see Fidelity notes) |
| `gui_check.py` | the check suite (trusted W3C WebDriver input only; `WHOT_GUI_DRIVER=webkit\|firefox`) |

## Usage

```sh
npm run build            # dist/ must be current
python3 test/gui-mock/dump_snap.py   # sanitized snapshot -> snap.json (see Sanitization)
python3 test/gui-mock/server.py &     # default http://127.0.0.1:8123/
python3 test/gui-mock/gui_check.py    # WebKitGTK (default): exit 0 iff all 64 checks pass (C1–C63, C17 retired, + R1–R2)
WHOT_GUI_DRIVER=firefox python3 test/gui-mock/gui_check.py   # Firefox instead
```

> **C32 is always to be tested stand-alone.** In the full-suite run C32
> (`c32_full_image_follows_person`) fails deterministically under the
> Firefox driver with `ElementClickInterceptedException` — the overlay
> rect click lands on a `selected` sibling (timing-sensitive hit-test,
> see the pre-click note inside the check). Stand-alone (a driver run
> invoking just `c32_full_image_follows_person`, as in the isolation
> runs) it passes reliably. A full-suite abort at C32 is therefore a
> known harness flake, **not** an app regression — re-verify the check
> stand-alone before looking for frontend causes.

Manual poking: open http://127.0.0.1:8123/ in any browser.

## Fidelity notes

- The binary image batch returns a tiny shared JPEG standing in for the
  DB blobs — layout and interaction
  checks only, never pixel checks.
- `person_face_clusters` mirrors the backend's single-linkage clustering
  (cosine similarity, distance = 1 − sim, default threshold 0.40) over the
  person's non-rejected, non-discarded faces.
- `assign_person` emulates §4.1 (rename-in-place / move / create, the
  CLAIM rule — an assignment always confirms what it touches — shell
  deletion, name re-derivation); reject re-homes onto the system
  person `Rejected`, accept never un-rejects, and every person keeps
  their group row or status seat (§4.35).
- `scan_import_dir` consults the seeded `window.__MOCK_ROLL_DIRS__`
  (`{path: imageCount}`, default 0 — "not a directory");
  `start_import`/`stop_import`/`get_import_status` (§4.36) simulate the
  child with a scripted line stream over timers (exit 0) —
  `window.__MOCK_IMPORT__` exposes the live slot to checks.
- Mock state is in-memory and per page-load: every navigation reloads
  `snap.json`, so checks are independent and the real DB is never written.

## Sanitization (the snapshot carries no personal data, #236)

`dump_snap.py` sanitizes its output **by default** — `snap.json` may be
shared freely, and no real name, surname, note or user-home path may
appear in it. `--raw` dumps the snapshot unsanitized for local
debugging fidelity; **never commit or share a `--raw` dump**. The
sanitizer is a pure function (`sanitize_snap`) with these rules and
invariants (pinned by `test/test_sanitize_snap.py`):

- `persons.name`: every real-name person → `John Smith{n}` (id order;
  `UnknownN` and the system person `Rejected` are structural and stay).
- `person_groups.path`: every non-reserved segment → a generic
  `Group{n}`, one generic **per distinct segment** (first-seen order) —
  injective, so the tree's branch shape and ordering are unchanged and
  the sanitized corpus never merges two different branches into one.
  The reserved status seats (`Accepted`, `New`, `Rejected`) stay.
- `faces.name`: rebuilt from the mapped person name with the same
  `name[-description]-seq` formula the mock's renumber uses, so labels
  stay coherent before **and** after any renumber.
- `persons.note` and free-text `faces.description`: name-bearing words
  replaced via a dictionary built from the real-name tokens + the
  original segment names (plus a small curated list for stray personal
  words, e.g. `Dawid`) → the neutral word `person`.
- `images.primary_path` / `imports.path`: only the home component
  rewritten (`/home/stoflom/…` → `/home/tester/…`), plus **directory
  segments carrying a person-name word** → one `Dir{n}` per distinct
  segment (injective, first-seen in the images' id order; imports
  inherit the same segment map — the annotator used personal names as
  directory labels). Filenames stay; so does the generic directory
  structure. Every dynamic check (C34, C63's filename walk, the path
  filter) discovers these branches by path, and each path remains
  consistent within the snapshot; the branches' alpha-sort may shift
  for the renamed segments.
- Invariants: deterministic across runs, identity-preserving (same
  distinct name always → same generic name), order-preserving (no sort
  order changes), counts and ids untouched, and the scan gate: no
  real-name token survives in the serialized JSON.

## Requirements

**WebKitGTK (default)**

- `selenium` and the system `WebKitWebDriver` binary (package
  `webkitgtk-driver`/`webkit2gtk-driver`), MiniBrowser at
  `/usr/libexec/webkit2gtk-4.1/MiniBrowser`.
- A display — WebKitGTK has no headless mode: run on a desktop
  session or under Xvfb (`xorg-x11-server-Xvfb`) on CI. On a
  **headless box with an X11 session but no active display** (screen
  off, no console, remote handover) the Xwayland compositor idles: the
  automation window reports `visibilityState: hidden`, WebKit suspends
  `requestAnimationFrame` and IntersectionObserver callbacks, and the
  grid's incremental mount (#214) never grows — checks that need deep
  cards then time out, and X11 modifier/right-click combos can deadlock
  the session. Run under a private virtual display instead (Xvfb, or
  Xvnc — `Xvnc :123 -geometry 1600x1000 -depth 24 -SecurityTypes None`
  — with `DISPLAY=:123`), which composites regardless of the desktop
  state.
- No skill needed: `webkit_tester.py` lives in this directory and
  spawns its own driver process per run (a crashed run cannot leak a
  wedged session into the next one).

**Firefox (`WHOT_GUI_DRIVER=firefox`)**

- `selenium` + `webdriver-manager` (geckodriver auto-downloaded) and a
  `firefox` binary on PATH (true headless — no display needed).
- The `firefox-testing` skill at `/home/stoflom/.pi/agent/skills/firefox-testing`
  (imported only for this driver; adjust the path if the skill moves).

## WebKit quirks the tester papers over

- **`.text`**: WebKitWebDriver's `getElementText` returns `''` or a
  fragment where `innerText` is exact (the person tree's `.tree-name`
  reported `''`); `WebKitElement.text` routes through the `innerText`
  attribute, which matches what Firefox's `.text` returns.
- **Occluded clicks**: WebKitWebDriver hit-tests BEFORE dispatching
  events, so a click over an open typeahead popup is rejected even
  though a real click would blur the input first, close the list
  (`SuggestInput.onBlur`) and land. `WebKitElement.click` reproduces
  that sequence once (blur → React re-render → retry) and propagates a
  still-intercepted error.
- **`user-select`**: only the prefixed `-webkit-user-select` is exposed
  on computed styles (the un-prefixed `userSelect` is `null`) — the C31
  viewport check reads either.
- **`WebKitWebDriver` flags** use `--port=N` (equals form);
  per-element screenshots are 404 — `screenshot_element` crops the
  viewport instead (the suite itself never screenshots).
