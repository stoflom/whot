# GUI mock harness (visual/contract review of the Tauri frontend)

Drives the built frontend in headless Firefox against an in-memory mock of
the Tauri backend, seeded from a real `faces.db` dump. Used to review the
Review GUI (layout geometry incl. the compact one-face sections (#108),
§4.24/§4.30 stage-then-commit contract, Q4 escape-or-accept, Esc
ordering, #103 no-op feedback, selection-toggle render time (§4.31/#109))
without running the Rust backend or touching the real database.

## Files

| file | role |
| --- | --- |
| `dump_snap.py` | read-only dump of `data/faces.db` → `snap.json` (gitignored) |
| `mock.js` | in-memory `window.__TAURI_INTERNALS__` emulator (command list in the file header) |
| `server.py` | serves `dist/`, rewrites `index.html` to load `mock.js` before the app bundle; serves `/snap.json` |
| `gui_check.py` | the check suite (headless Firefox via the `firefox-testing` skill; trusted input only) |

## Usage

```sh
npm run build            # dist/ must be current
python3 test/gui-mock/dump_snap.py
python3 test/gui-mock/server.py &     # default http://127.0.0.1:8123/
python3 test/gui-mock/gui_check.py    # exit 0 iff the contract checks (C1–C7, R1) pass
```

Manual poking: open http://127.0.0.1:8123/ in any browser.

## Fidelity notes

- Image commands return small SVG placeholders — layout and interaction
  checks only, never pixel checks.
- `person_face_clusters` is simplified (one cluster per description, sim
  0.9); the person view's cluster section is not exercised by the checks.
- `assign_person` emulates §4.1 (rename-in-place / move / create, sticky
  rejected, shell deletion, name re-derivation).
- Mock state is in-memory and per page-load: every navigation reloads
  `snap.json`, so checks are independent and the real DB is never written.

## Requirements

- `selenium` + `webdriver-manager` (geckodriver auto-downloaded) and a
  `firefox` binary on PATH.
- The `firefox-testing` skill at `/home/stoflom/.pi/agent/skills/firefox-testing`
  (imported by `gui_check.py`; adjust the path if the skill moves).
