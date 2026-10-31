#!/usr/bin/env python3
"""WhoT GUI contract checks against the mocked Tauri backend (test/gui-mock).

Requires:
    1. npm run build                  (dist/ current)
    2. python3 dump_snap.py           (snap.json current)
    3. python3 server.py &            (mock server up, default :8123)
    4. a display                      (WebKitGTK default; headless boxes
                                       need Xvfb — Firefox runs without)

Then:
    python3 gui_check.py [PORT]              # WebKitGTK (default, #170)
    WHOT_GUI_DRIVER=firefox python3 gui_check.py   # Firefox (skill needed)

Each check starts from a fresh page load, which reloads /snap.json, so the
in-memory mock state is clean per check. Interaction uses trusted input
(W3C WebDriver actions); synthetic events are unreliable for the app's
window key listeners.

Checks (contract refs: docs/gui-design.md):
  C1  Enter with a live stage stages-then-commits (§4.30, #101)
  C2  'a' with a live stage stages-then-commits (§4.30, #101)
  C3  bar Accept commits the stage (§4.30 — reference path)
  C4  no-op Apply shows feedback (#103)
  C5  #123 stage model: in-context selection change is dialog-free;
      a complete context change asks discard-or-accept either way
  C6  Esc ordering: dialog closes first, stage survives, then clears (Q8)
  C7  one-face section keeps its select-all interaction (#120)
  C8  tree badge counts ignore the face-status filter (#129)
  C9  dialog action rows sit above the typeahead fields (#131)
  C10 no-op Apply is an info toast: no buttons, auto-clears on next action (#132)
  C11 post-merge focus: the centre pane opens the merged target (#133)
  C12 face drag onto a person row: confirmed merge into that person (#135)
  C13 face drag onto a face card: copies the shown description onto the
      whole payload; empty-description cards refuse the drop (#136)
  C15 served stylesheet fully parsed + merge dialog honours #126:
      86vh cap, scrolling list, pinned action row (v3.34/#137)
  C16 Show filter prunes the tree person list (#152, §4.10 — sees
      C8 updated accordingly)
  C18 Rolls pane mirrors the filesystem path hierarchy and Show prunes
      it (#161, v3.60)
  C19 staged dialog-Apply (§4.24) regroups the Description-mode sections
      live (#155, v3.55): Undo returns the committed grouping; bar Accept
      commits the description
  C20 a person with SEVERAL group rows renders under EVERY path
      (§4.16, #156, v3.56 — stepped once; branch bulk-ops dedupe)
  C21 the Show filter (a global control) lives in the top bar (#158,
      v3.57): topbar select present, centre-toolbar select gone, the
      view-local cluster-group seg stays in the person view
  C22 the review exhaust advance lands on the first person after the
      drained one with a reviewable face (§4.30, #159, v3.58) — never on
      the raw successor with nothing left to review
  C23 person-tree D&D re-homes ONE membership (§4.16, #157, v3.59):
      dragged-from row removed, target filed (INSERT OR IGNORE), other
      memberships kept; src==dst drop is a no-op
  C24 the theme is dark: :root sets color-scheme dark and the top-bar
      Show select renders its value text in the theme text colour
      (#158 follow-up — WebKit's light-scheme defaults washed the value
      out against the dark panel)
  C25 the Merge Similar Persons dialog has a visible cancel button in
      its action row — it closes the dialog with nothing applied (#160,
      v3.61 — Esc worked but was invisible)
  C26 the Rolls pinned path-filter row (#162, v3.62): typed folder
      becomes the tree root (branches = its children), typed image file
      opens full-image (root kept), invalid path shows a hint (root
      kept), browse… picks a folder via the mocked native picker, empty
      input roots at '/'
  C27 the centre toolbar is view-scoped (#163, v3.63/v3.64): Rolls
      renders no toolbar at all (nav + seg gone, full grid height) and
      ←/→ are inert there (no person-view yank); Review keeps nav only;
      the person view keeps nav + seg
  C28 'Add group…' lives on person rows only (#164, v3.65): branch
      menu keeps rename/move + delete but no add entry, the root empty
      space offers no menu at all, and the person dialog ADDS the typed
      path as another membership (current groups kept; Move keeps
      replace-all)
  C29 Show=All excludes rejected entirely: the system person `Rejected`
      and its branch list only under Show→Rejected, and the Show tooltip
      spells the contract out (#165, §4.10)
  C30 with a live staged set, bar Accept commits the staged ops and
      accepts the DISPLAYED selection — not just the staged face ids
      (#166, §4.30/§4.24: stage on a few Description-mode faces, select
      every section, Accept → all confirmed)
  C31 the Rolls import pane (#167, §4.36): committing a real,
      not-yet-imported directory (typed or via browse…) opens the pane in
      the RIGHT pane (DetailPane gone, rolls tree still interactive) with
      the per-roll toggles + threshold (--recursive PRE-CHECKED, #169),
      the create-db+dry-run refusal, start → stdout viewport fills from
      the polled status, exit 0 shown; a non-directory path keeps the
      plain #162 hint (no pane)
  C32 the right pane follows the full image (#171, §4.37): card
      double-click → focus mode + the card's person in the right pane;
      rect click switches the pane to the rect's person while focus mode
      AND the Review tab stay put (selection toggles); the import pane
      (§4.36) keeps the right-pane slot through open + rect click, and
      closing it reveals the person anchored underneath; a NULL
      person_id (injected) leaves the anchor untouched
  C33 the person pane's group list + Update person (#172/#173, §4.38):
      the pane lists every membership with an × per row; × stages a
      removal and Add group stages a membership (the mock is NOT
      touched until commit); Update person sits directly above Remove
      person and commits the staged set via move_persons_between_groups;
      a status-seat row renders dimmed with an inert ×; renaming the
      pane person to a KNOWN person re-anchors the pane on the merge
      target and lists ITS groups; the system person Rejected sees the
      list read-only with no Update button
  C34 Modes — the Rolls branch thumbnails (#174, §4.39): the centre is
      a pure hierarchy (no inline .img-grid); a header click toggles AND
      selects the branch; the right pane lists the branch's DIRECT images
      only (non-recursive — thumb paths all sit at the branch, header
      rollup counts more), filename order, selected header styled; the
      selection survives a mode round-trip and clears when the branch
      selection changes; ctrl-click extends it, the thumb context menu's
      Rotate is scoped ('(2)') and lands on both mock images; a thumb
      double-click opens the image detail with the person detail back in
      the right pane (§4.37), '← rolls' returns to the hierarchy with
      the branch's thumbs intact; a branch with no direct images shows
      the drill hint
  C35 Rolls layout while browsing (#174 follow-up, §4.39): entering
      Rolls gives the centre an explicit width equal to the LEFT pane's
      (the right pane flexes — most of the window for the thumbnails);
      dragging the centre|right divider clamps the centre to 10%..70% of
      the window (never past window − left − 200px), double-click
      restores the left-following default, and opening an image restores
      the normal layout (right pane back to its fixed width)
  C36 the Review lock (#175, §4.40): engaging the padlock beside Show
      pins Show → New (select disabled, button latched) and an anchored
      person WITHOUT a new face advances to the next one that has one;
      a verdict in PERSON view with focus open (the locked any-view
      mark) exhausts the person → auto-advance to the next person with
      new faces AND the focus split closes (§4.15); releasing lands in
      Person mode with Show → All re-enabled
  C37 Person mode stickiness + status colours (#176, §4.41): the
      Person tab is clickable without an anchor → the single-Close
      'Please select a person in the tree on the left' dialog +
      Show → All; anchoring a person without new faces and switching
      Show → New opens 'No new faces' with Show All + Close; the top
      bar carries the anchored person's live counts (? new, ✓
      accepted, ✗ rejected); and the status scheme is one colour
      everywhere — the Show select (closed value), the top-bar count
      chips and the tree status branches resolve to the same rgb
      (New = red, Accepted = green, Rejected = gray; All = the normal
      text colour)
  C38 verdict icon shortcuts (#177, §4.42): the card tick accepts ONE
      card as-is (mock: only that face flips to confirmed — the §4.14
      card scope); the cluster header's ✓ flips the WHOLE group's faces
      to confirmed and ✗ rejects them all; the bottom bar's selection
      shortcuts carry the icons (button.ok reads '✓ Accept', button.bad
      '✗ Reject')
  C48 branch rename onto a path the same person already holds is a
      SILENT MERGE, not a UNIQUE-constraint crash (#193, §4.16): the
      person keeps one row at the destination, the rest of the branch
      rewrites normally, no error toast
  C49 stepping from an empty centre (#194, §4.25/§4.41): with the
      anchored person pruned from the step list (Show switch or a
      verdict drain) the empty pane names the active filter and points
      at › (faceless shells get their own hint), and › continues from
      the LAST anchored position (clamped) — not the list start
  C50 merge-confirmation chips are selectable (#196, §4.28): clicking
      a source chip prefills the "Merge into" input (same resolution
      as the typeahead), styles it selected and drops it from the
      moving set (summary math matches typing); the other chip moves
      the target; Esc leaves the data untouched
  R1  layout geometry: heading above cards in every section (#120),
      empty labels are dimmed hints with normal row height (#119)
  R2  selection-toggle render time (informational, §4.31/#109)

Exit code 0 iff all C-checks and the R1 layout rule pass.
"""
import json
import os
import sys
import time

# #170: driver choice — WebKitGTK (the engine Tauri ships, #168) is the
# default; Firefox stays available via WHOT_GUI_DRIVER=firefox. The
# WebKit tester lives in this directory (test infra belongs to the repo);
# the Firefox tester is the personal firefox-testing skill.
DRIVER = os.environ.get("WHOT_GUI_DRIVER", "webkit").strip().lower()

if DRIVER == "firefox":
    try:
        sys.path.insert(0, "/home/stoflom/.pi/agent/skills/firefox-testing")
        from firefox_tester import FirefoxTester as Tester
    except ImportError as e:
        sys.exit(f"firefox-testing skill not importable: {e}\n"
                 f"(expected at /home/stoflom/.pi/agent/skills/firefox-testing)")
elif DRIVER == "webkit":
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from webkit_tester import WebKitTester as Tester
    except ImportError as e:
        sys.exit(f"webkit_tester not importable: {e}")
else:
    sys.exit(f"unknown WHOT_GUI_DRIVER: {DRIVER!r} (use 'webkit' or 'firefox')")

from selenium.webdriver.common.action_chains import ActionChains as AC
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

URL = "http://127.0.0.1:{port}/"

results = []


def record(check, ok, detail):
    results.append({"check": check, "pass": bool(ok), "detail": detail})
    print(f"  [{'PASS' if ok else 'FAIL'}] {check}: {detail}", flush=True)


def js(t, code, *args):
    return t.execute_script(code, *args)


def fresh(t):
    """fresh page = fresh in-memory mock state; wait for the grid to render"""
    t.navigate(URL)
    deadline = time.time() + 30
    ready = False
    while time.time() < deadline:
        err = js(t, "return window.__MOCK_ERROR__ || null")
        if err:
            raise RuntimeError("mock error: " + err)
        if js(t, "return !!window.__MOCK_READY__"):
            ready = True
            break
        time.sleep(0.2)
    if not ready:
        raise RuntimeError("mock never became ready")
    deadline = time.time() + 30
    while time.time() < deadline:
        n = js(t, "return document.querySelectorAll('.face-card').length")
        if n:
            # #188/§4.40: the load lands in Review, where the entry pin
            # fires (Show → New) — the suite's baseline has always been
            # the seed's Show → All, so force it back. The pin may fire
            # AFTER a dispatch (engine-dependent microtask ordering —
            # seen on WebKit), but it consumes itself, so retry until
            # the value sticks (set_show_filter does the retry loop).
            set_show_filter(t, "all")
            return n
        time.sleep(0.3)
    raise RuntimeError(
        "no cards rendered: "
        + js(t, "return (document.body.innerText||'').slice(0,200)"))


def face_by_id(t, fid):
    """the mock record of a face by id (ground truth)"""
    return js(t, r"""
      const f = window.__MOCK_SNAP.faces.find(x => x.id === Number(arguments[0]));
      if (!f) return null;
      const p = f.person_id != null
        ? window.__MOCK_SNAP.persons.find(x => x.id === f.person_id) : null;
      return {id: f.id, name: f.name, person: p ? p.name : null,
              status: f.link_status};
    """, fid)


def first_card_id(t):
    return js(t, "return document.querySelector('.face-card')?.getAttribute('data-face-id')")


def committed(t, fid, wanted):
    """PASS iff face fid is confirmed and renamed to wanted in the mock"""
    f = face_by_id(t, fid)
    return (
        f is not None
        and f["status"] == "confirmed"
        and (f["person"] == wanted or (f["name"] or "").startswith(wanted))
    )


def strip_text(t):
    return js(t, "const s=document.querySelector('.stage-strip');return s?s.textContent.trim():'no strip'")


def q4_dialog(t):
    return js(t, """
      const d = [...document.querySelectorAll('.overlay .dialog')]
        .find(x => x.querySelector('h3')?.textContent === 'Unapplied changes');
      return !!d;
    """)


def dialog_open(t):
    return js(t, """
      return !![...document.querySelectorAll('.overlay .dialog')]
        .some(x => x.querySelector('.scope-seg'));
    """)


def edit_and_apply(t, name):
    """open the first card's Edit dialog, set the name, Apply (stages)."""
    t.find_element(By.CSS_SELECTOR, ".face-card .card-edit").click()
    time.sleep(0.6)
    if name:
        inp = t.find_element(By.CSS_SELECTOR, ".edit-dialog input")
        inp.click()
        inp.clear()
        inp.send_keys(name)
        time.sleep(0.2)
    apply_btn = [b for b in t.find_elements(By.CSS_SELECTOR, ".edit-dialog button")
                 if b.text.strip() == "Apply"][0]
    apply_btn.click()
    time.sleep(0.8)


def blur(t):
    js(t, "if (document.activeElement && document.activeElement.blur) document.activeElement.blur();")
    time.sleep(0.2)


# ---------------------------------------------------------------- checks

def c1_enter_stages_then_commits(t):
    fresh(t)
    fid = first_card_id(t)
    pre = face_by_id(t, fid)
    edit_and_apply(t, "GuiCheck Enter")
    assert "GuiCheck Enter" in strip_text(t), "stage strip missing after Apply"
    assert not dialog_open(t), "dialog should close on Apply"
    mid = face_by_id(t, fid)
    # #165: whatever the face is (provisional on its cluster, or a
    # rejected face on the system person) — Apply must not write
    assert mid["person"] == pre["person"] and mid["status"] == pre["status"], (
        f"Apply must not write (was {pre['status']}/{pre['person']}, "
        f"now {mid['status']}/{mid['person']})")
    blur(t)
    AC(t.driver).send_keys(Keys.ENTER).perform()
    time.sleep(1.5)
    strip = strip_text(t)
    f = face_by_id(t, fid)
    ok = strip == "no strip" and committed(t, fid, "GuiCheck Enter")
    record("C1 Enter stage-then-commit", ok,
           f"strip={strip!r} face {fid} -> {f and (f['status'], f['person'])}")


def c2_a_key_stages_then_commits(t):
    fresh(t)
    fid = first_card_id(t)
    edit_and_apply(t, "GuiCheck AKey")
    blur(t)
    AC(t.driver).send_keys("a").perform()
    time.sleep(1.5)
    strip = strip_text(t)
    f = face_by_id(t, fid)
    ok = strip == "no strip" and committed(t, fid, "GuiCheck AKey")
    record("C2 'a' stage-then-commit", ok,
           f"strip={strip!r} face {fid} -> {f and (f['status'], f['person'])}")


def c3_bar_accept_commits(t):
    fresh(t)
    fid = first_card_id(t)
    edit_and_apply(t, "GuiCheck Accept")  # stages; dialog closed by Apply
    # bottom-bar Accept with a live stage = stage-then-commit (§4.30)
    [b for b in t.find_elements(By.CSS_SELECTOR, ".rulebar button")
     if "Accept" in b.text][0].click()
    time.sleep(1.5)
    strip = strip_text(t)
    f = face_by_id(t, fid)
    ok = strip == "no strip" and committed(t, fid, "GuiCheck Accept")
    record("C3 bar Accept commits", ok,
           f"strip={strip!r} face {fid} -> {f and (f['status'], f['person'])}")


def c4_noop_apply_feedback(t):
    fresh(t)
    t.find_element(By.CSS_SELECTOR, ".face-card .card-edit").click()
    time.sleep(0.6)
    [b for b in t.find_elements(By.CSS_SELECTOR, ".edit-dialog button")
     if b.text.strip() == "Apply"][0].click()
    time.sleep(0.8)
    toast = js(t, "const e=document.querySelector('.toast .toast-text');return e?e.textContent.trim():'none'")
    ok = "nothing to apply" in toast
    record("C4 no-op Apply feedback", ok, f"toast={toast!r}")


def c5_q4_stage_model(t):
    """#123 stage model: a selection change INSIDE the context never asks
       (the Apply → change → Apply loop is dialog-free); only a complete
       context change (another person) asks discard-or-accept — and the
       choice runs the stored action either way."""
    fresh(t)
    cards = t.find_elements(By.CSS_SELECTOR, ".face-card")
    idA = cards[0].get_attribute("data-face-id")
    idB = cards[1].get_attribute("data-face-id")
    cards[0].click()  # plain click sets the range anchor (#69) and selects A
    time.sleep(0.5)
    edit_and_apply(t, "GuiCheck Q4")
    # in-context selection change: NO dialog, stage survives, sel applies
    AC(t.driver).key_down(Keys.SHIFT).click(cards[1]).key_up(Keys.SHIFT).perform()
    time.sleep(1.0)
    mid = {
        "dialog": q4_dialog(t), "strip": strip_text(t),
        "sel": js(t, "return [...document.querySelectorAll('.face-card.selected')].map(c => c.getAttribute('data-face-id'))"),
    }
    sel_ok = (not mid["dialog"]) and mid["strip"] != "no strip" \
        and sorted(mid["sel"]) == sorted([idA, idB])
    if not sel_ok:
        record("C5 #123 stage model", False, f"selection change asked/lost the stage: {mid}")
        return
    # complete context change: open another person — discard-or-accept
    anchor = js(t, "return document.querySelector('.tree-person.selected .tree-name')?.textContent.trim() ?? null")
    nodes = t.find_elements(By.CSS_SELECTOR, ".tree-person")
    other = next((n for n in nodes
                  if n.find_element(By.CSS_SELECTOR, ".tree-name").text.strip() != anchor), None)
    if other is None:
        record("C5 #123 stage model", False, "no second person node to switch to")
        return
    other_name = other.find_element(By.CSS_SELECTOR, ".tree-name").text.strip()
    other.click()
    time.sleep(1.0)
    seen = q4_dialog(t)
    if not seen:
        record("C5 #123 stage model", False,
               f"context change with live set did not ask; strip={strip_text(t)!r}")
        return
    # Esc = discard: pending dropped, the context switch still happens
    AC(t.driver).send_keys(Keys.ESCAPE).perform()
    time.sleep(1.0)
    after = {
        "dialog": q4_dialog(t), "strip": strip_text(t),
        "selected": js(t, "return document.querySelector('.tree-person.selected .tree-name')?.textContent.trim() ?? null"),
    }
    ok = (not after["dialog"]) and after["strip"] == "no strip" \
         and after["selected"] == other_name
    record("C5 #123 stage model", ok,
           f"in-context silent (sel={mid['sel']}), context ask -> discard: {after}")


def c6_esc_ordering(t):
    fresh(t)
    edit_and_apply(t, "GuiCheck Esc")
    # reopen the dialog on the same card (selection unchanged: no Q4 prompt)
    t.find_element(By.CSS_SELECTOR, ".face-card .card-edit").click()
    time.sleep(0.6)
    AC(t.driver).send_keys(Keys.ESCAPE).perform()  # closes dialog only
    time.sleep(0.6)
    mid = {"dialog": dialog_open(t), "q4": q4_dialog(t), "strip": strip_text(t)}
    AC(t.driver).send_keys(Keys.ESCAPE).perform()  # clears the stage
    time.sleep(0.6)
    after = {"strip": strip_text(t)}
    ok = (not mid["dialog"]) and not mid["q4"] and mid["strip"] != "no strip" \
         and after["strip"] == "no strip"
    record("C6 Esc ordering (dialog, then stage)", ok, f"mid={mid} after={after}")


def r1_layout(t):
    fresh(t)
    rep, ok = js(t, r"""
      const secs = [...document.querySelectorAll('.face-section')];
      const sizes = secs.map(s => s.querySelectorAll('.face-card').length);
      const hist = sizes.reduce((m, n) => (m[n] = (m[n] || 0) + 1, m), {});
      const labels = [...document.querySelectorAll('.card-label, .rule-label')];
      const c0 = document.querySelector('.face-card');
      const name = c0 && c0.querySelector('.face-img .card-label.name');
      const img = c0 && c0.querySelector('.face-img');
      const grid = document.querySelector('.face-section .face-grid');
      // #120: no compact one-row sections anymore — the heading always
      // sits on its own row ABOVE the cards in every section
      const noSingleClass = document.querySelectorAll('.face-section.single').length === 0;
      const headingAbove = secs.every(s => {
        const h = s.querySelector('.face-section-header').getBoundingClientRect();
        const c = s.querySelector('.face-card');
        if (!c) return true;
        return h.bottom <= c.getBoundingClientRect().top + 2;
      });
      // #119: empty labels — dimmed hint text (never a 3rem-padded row:
      // the old .empty collision rendered them ~98px tall)
      const empties = [...document.querySelectorAll('.card-label.is-empty, .rule-label.is-empty')];
      const emptyRows = empties.map(e => Math.round(e.getBoundingClientRect().height));
      const emptyHeightsOk = empties.length > 0 && emptyRows.every(h => h > 0 && h <= 30);
      // dim reference: .face-conf is always styled with var(--dim)
      const ref = document.querySelector('.face-conf');
      const refColor = ref ? getComputedStyle(ref).color : null;
      const emptiesDimmed = refColor != null && empties.every(e => getComputedStyle(e).color === refColor);
      // card labels carry per-field classes; the heading's rule labels are
      // identified by position inside .rule (name, group, desc, Edit…)
      // #130: the empty-description hint is the neutral word 'description'
      // (the feature example stayed as the Edit dialog placeholder only)
      const hintDesc = [...document.querySelectorAll('.card-label.desc.is-empty, .rule .rule-label:nth-child(3).is-empty')]
        .every(e => e.textContent === 'description');
      const hintGroup = [...document.querySelectorAll('.card-label.group.is-empty, .rule .rule-label:nth-child(2).is-empty')]
        .every(e => e.textContent === 'Friends|School');
      const ok = noSingleClass && headingAbove && emptyHeightsOk && emptiesDimmed && hintDesc && hintGroup;
      return [ok, {
        sections: secs.length,
        oneFaceSections: sizes.filter(n => n === 1).length,
        sizeHistogram: Object.fromEntries(Object.entries(hist).map(([k, v]) => [k, v]).sort((a, b) => a[0] - b[0])),
        domNodes: document.getElementsByTagName('*').length,
        truncatedLabels: labels.filter(l => l.scrollWidth > l.clientWidth + 1).length,
        totalLabels: labels.length,
        nameStrip: name && img
          ? {frameH: Math.round(img.getBoundingClientRect().height),
             nameH: Math.round(name.getBoundingClientRect().height),
             top: Math.round(name.getBoundingClientRect().top - img.getBoundingClientRect().top)}
          : null,
        gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns : null,
        emptyLabels: {count: empties.length, heights: emptyRows, dimmed: emptiesDimmed},
      }];
    """)
    record("R1 layout: heading above cards + empty hints", ok, json.dumps(rep))


def r2_toggle_perf(t):
    fresh(t)
    times = []
    for i in (0, 1):
        times.append(js(t, r"""
          const cb = document.querySelectorAll('.face-card input[type=checkbox]')[arguments[0]];
          const t0 = performance.now();
          cb.click();
          return new Promise(res => {
            let done = false;
            const finish = (v) => { if (!done) { done = true; res(v); } };
            // headless boxes whose compositor never presents the MiniBrowser
            // window starve rAF (seen on an idle GNOME/Xwayland session) —
            // bound the wait so this informational check can't wedge the suite
            const to = setTimeout(() => finish(null), 1500);
            requestAnimationFrame(() => requestAnimationFrame(() => {
              clearTimeout(to);
              finish(Math.round((performance.now() - t0) * 10) / 10);
            }));
          });
        """, i))
    record("R2 selection-toggle render ms", True,
           str(times) + (" — no paint frame (headless)"
                        if any(v is None for v in times) else ""))


def c7_single_section_selectall(t):
    fresh(t)
    # #120: one-face sections are plain .face-section now — find one by
    # its position in .face-sections (no .single class to select on)
    pos = js(t, """return (() => {
      const secs = [...document.querySelectorAll('.face-section')];
      const i = secs.findIndex(s => s.querySelectorAll('.face-card').length === 1);
      if (i === -1) return null;
      return {i, fid: secs[i].querySelector('.face-card').getAttribute('data-face-id')};
    })()""")
    if pos is None:
        record("C7 one-face section select-all", True,
               "no one-face sections in view — vacuous")
        return
    sel = f".face-sections > .face-section:nth-of-type({pos['i'] + 1})"
    cb = t.find_element(By.CSS_SELECTOR, f"{sel} .select-all input")
    cb.click()
    time.sleep(0.5)
    sel1 = js(t, f"return document.querySelectorAll('{sel} .face-card.selected').length")
    t.find_element(By.CSS_SELECTOR, f"{sel} .select-all input").click()
    time.sleep(0.5)
    sel2 = js(t, f"return document.querySelectorAll('{sel} .face-card.selected').length")
    ok = sel1 == 1 and sel2 == 0
    record("C7 one-face section select-all", ok,
           f"face {pos['fid']}: after 1st click={sel1}, after 2nd={sel2}")


def tree_badges(t):
    """name|total|provisional per tree person, sorted — filter-invariant (#129)"""
    return js(t, """
      return [...document.querySelectorAll('.tree-person')].map(p =>
        (p.querySelector('.tree-name')?.textContent ?? '').trim() + '|' +
        (p.querySelector('.tree-count.total')?.textContent ?? '') + '|' +
        (p.querySelector('.tree-count.prov')?.textContent ?? '')
      ).sort();
    """)


def _show_select_js():
    return (
        "[...document.querySelectorAll('select')]"
        ".find(x => [...x.options].some(o => o.value === arguments[0]))"
    )


def set_show_filter(t, value):
    """flip the top-bar Show filter (§4.10) to `value` and wait for the refetch.

    #188/§4.40: the Review entry pin (Show → New) can fire AFTER our
    dispatch — engine-dependent microtask ordering (seen on WebKit,
    where React also flushes the app's focus-actor updates separately).
    The pin consumes itself, so re-dispatch until the value sticks."""
    for _ in range(4):
        js(t, f"""
          const s = {_show_select_js()};
          if (s && s.value !== arguments[0]) {{
            s.value = arguments[0];
            s.dispatchEvent(new Event('change', {{bubbles: true}}));
          }}
        """, value)
        for _ in range(12):
            if js(t, f"return {_show_select_js()}?.value", value) == value:
                return
            time.sleep(0.2)
    raise RuntimeError(f"Show filter would not take: wanted {value!r}")


def c8_tree_counts_ignore_filter(t):
    """#129: badge VALUES stay raw totals across the status filter.
    #152 makes presence itself filter-relative — a shrinking list is
    expected — so only persons listed under BOTH filters are compared."""
    fresh(t)
    set_show_filter(t, "all")  # the persisted whotrc filter must not tilt the baseline
    before_all = tree_badges(t)
    set_show_filter(t, "provisional")
    after_new = tree_badges(t)
    shared = set(after_new) & set(before_all)
    ok = set(after_new) == shared  # everything listed under New appears verbatim in All
    record("C8 badge totals stay raw across the status filter (#129)", ok,
           f"all={len(before_all)} persons → new={len(after_new)}: "
           f"{len(shared)}/{len(after_new)} badges appear verbatim in the All list")


def tree_person_ids(t):
    """Distinct person ids in tree display order — #156: a multi-group
    person renders under every path, so raw row order holds duplicates."""
    return js(t, """
      const out = []; const seen = new Set();
      for (const p of document.querySelectorAll('.tree-person')) {
        const id = String(p.getAttribute('data-person-id'));
        if (!seen.has(id)) { seen.add(id); out.push(id); }
      }
      return out;
    """)


def c16_filter_prunes_tree(t):
    """#152 (§4.10): with Show=New, persons without a provisional face are
    not listed; Show=All lists everyone again (incl. faceless shells)."""
    fresh(t)
    set_show_filter(t, "all")  # the persisted whotrc filter must not tilt the baseline
    all_ids = tree_person_ids(t)
    set_show_filter(t, "provisional")
    new_ids = tree_person_ids(t)
    expected = js(t, """
      return window.__MOCK_SNAP.persons
        .map(p => String(p.id))
        .filter(id => new Set(window.__MOCK_SNAP.faces
          .filter(f => f.link_status === 'provisional' && f.person_id != null)
          .map(f => String(f.person_id))).has(id));
    """)
    set_show_filter(t, "all")
    all_again = tree_person_ids(t)
    subset = set(new_ids) <= set(all_ids)
    exact = sorted(new_ids) == sorted(expected)
    restores = sorted(all_again) == sorted(all_ids)
    ok = subset and exact and restores
    record("C16 Show filter prunes the tree person list (#152)", ok,
           f"all={len(all_ids)} → new={len(new_ids)} (subset={subset}, "
           f"exact-vs-faces={exact}); Show=All restores everyone: {restores}")


def c29_show_rejected_bin_165(t):
    """#165/§4.10: Show=All excludes rejected entirely — the system
    person `Rejected` and its branch list only under Show→Rejected, and
    the Show tooltip spells the contract out (read OUTSIDE Review —
    while Review is active the label instead spells the lock, #188/§4.40
    and C36; the Person tab's modeless picker may open, the tree behind
    it is what this check reads)."""
    fresh(t)
    [b for b in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
     if "Person" in b.text][0].click()
    time.sleep(0.8)
    tip = js(t, """
      const s = [...document.querySelectorAll('select')]
        .find(x => [...x.options].some(o => o.value === 'rejected'));
      return (s && s.closest('label') && s.closest('label').getAttribute('title')) || '';
    """)
    tip_ok = "except rejected" in tip and "Show → Rejected" in tip

    def tree_state():
        return js(t, """
          const nodes = [...document.querySelectorAll('.tree-node-name')]
            .map(x => x.textContent);
          const rej = window.__MOCK_SNAP.persons.find(p => p.name === 'Rejected');
          const rows = rej
            ? document.querySelectorAll(`.tree-person[data-person-id='${rej.id}']`).length
            : 0;
          return {branch: nodes.includes('Rejected'), rows: rows,
                  snapRejected: window.__MOCK_SNAP.faces
                    .filter(f => f.link_status === 'rejected').length};
        """)

    set_show_filter(t, "all")
    all_state = tree_state()
    all_ok = (not all_state["branch"]) and all_state["rows"] == 0
    set_show_filter(t, "provisional")
    prov_state = tree_state()
    prov_ok = (not prov_state["branch"]) and prov_state["rows"] == 0
    set_show_filter(t, "rejected")
    rej_state = tree_state()
    rej_ok = rej_state["branch"] and rej_state["rows"] >= 1
    set_show_filter(t, "all")
    ok = tip_ok and all_ok and prov_ok and rej_ok and all_state["snapRejected"] > 0
    record("C29 Show=All excludes the rejected bin — only Show→Rejected lists it (#165, §4.10)",
           ok, f"tooltip ok={tip_ok} ({tip[:60]!r}); "
               f"all: branch={all_state['branch']} rows={all_state['rows']}; "
               f"new: branch={prov_state['branch']} rows={prov_state['rows']}; "
               f"rejected: branch={rej_state['branch']} rows={rej_state['rows']}; "
               f"snap rejected faces={all_state['snapRejected']}")


def c30_bar_accept_selection_over_stage(t):
    """#166: with a live staged set, bar Accept commits the staged ops AND
    accepts the CURRENT selection — not only the staged face ids. Repro
    (§4.30/§4.24): stage a description on a few Description-mode section
    faces (Apply), then select every section and bar-Accept → all selected
    faces are confirmed and the staged ones carry the description."""
    fresh(t)
    pick = js(t, r"""
      const vis = f => f.person_id != null && (f.state ?? '') !== 'discarded'
                     && f.link_status !== 'rejected';
      for (const p of window.__MOCK_SNAP.persons) {
        const fs = window.__MOCK_SNAP.faces.filter(f => vis(f) && f.person_id === p.id);
        if (fs.length >= 3)
          return {pid: p.id, a: fs[0].id, b: fs[1].id, total: fs.length};
      }
      return null;
    """)
    if not pick:
        record("C30 bar Accept takes the selection over the staged set (#166)", True,
               "no person with 3+ visible faces in the dump — vacuous")
        return
    set_show_filter(t, "all")  # the persisted whotrc filter must not tilt the baseline
    js(t, "document.querySelectorAll('.topbar nav button')[2]?.click();")  # Person tab
    time.sleep(0.8)
    t.find_element(By.CSS_SELECTOR,
                   f".tree-person[data-person-id='{pick['pid']}']").click()
    time.sleep(0.8)
    js(t, r"""
      const s = document.querySelector('.center-toolbar .seg') ?? document.querySelector('.seg');
      const d = [...(s?.querySelectorAll('button') ?? [])]
        .find(b => b.textContent.trim() === 'Description');
      if (d && !d.classList.contains('active')) d.click();
    """)
    time.sleep(0.8)

    # two cards selected → dialog scope Selection → stage the description
    t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{pick['a']}']").click()
    time.sleep(0.4)
    AC(t.driver).key_down(Keys.CONTROL).click(
        t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{pick['b']}']")
    ).key_up(Keys.CONTROL).perform()
    time.sleep(0.4)
    t.find_element(By.CSS_SELECTOR,
                   f".face-card[data-face-id='{pick['a']}'] .card-edit").click()
    time.sleep(0.6)
    sel_btn = [b for b in t.find_elements(By.CSS_SELECTOR, ".edit-dialog .scope-seg button")
               if b.text.strip().startswith("Selection")]
    if not sel_btn:
        record("C30 bar Accept takes the selection over the staged set (#166)", False,
               "dialog has no 'Selection' scope button")
        return
    sel_btn[0].click()
    time.sleep(0.3)
    inp = t.find_element(By.CSS_SELECTOR, ".edit-dialog .input-desc")
    inp.click()
    inp.clear()
    inp.send_keys("side")
    [b for b in t.find_elements(By.CSS_SELECTOR, ".edit-dialog button")
     if b.text.strip() == "Apply"][0].click()
    time.sleep(0.8)
    sections = js(t, "return document.querySelectorAll('.face-section').length")
    staged_ok = js(t, r"""
      const fs = window.__MOCK_SNAP.faces.filter(f => f.person_id === Number(arguments[0]));
      return fs.some(f => (f.description ?? '') === 'side');
    """, pick["pid"])
    if sections < 2 or not staged_ok:
        record("C30 bar Accept takes the selection over the staged set (#166)", False,
               f"stage/regroup failed: sections={sections}, staged={staged_ok}")
        return

    # select EVERY rendered card (both resulting sections) in one gesture
    AC(t.driver).key_down(Keys.CONTROL).send_keys("a").key_up(Keys.CONTROL).perform()
    time.sleep(0.5)
    count = js(t, "const b = document.querySelector('.rulebar b'); "
                  "return b ? Number(b.textContent) : -1")
    [b for b in t.find_elements(By.CSS_SELECTOR, ".rulebar button")
     if "Accept" in b.text][0].click()
    time.sleep(1.6)
    after = js(t, r"""
      const fs = window.__MOCK_SNAP.faces.filter(f => f.person_id === Number(arguments[0]));
      return {total: fs.length,
              confirmed: fs.filter(f => f.link_status === 'confirmed').length,
              side: fs.filter(f => (f.description ?? '') === 'side').length};
    """, pick["pid"])
    ok = (count == pick["total"] and after["confirmed"] == pick["total"]
          and after["side"] >= 2)
    record("C30 bar Accept takes the selection over the staged set (#166)", ok,
           f"selected={count}/{pick['total']}, sections={sections}, "
           f"confirmed={after['confirmed']}/{after['total']}, side-desc={after['side']}")


def c18_rolls_path_tree(t):
    """#161 (v3.60) + #174 (§4.39): the Rolls pane is a filesystem-path
    tree — branch headers mirror the primary_path segments (collapsed at
    start), every directory branch (and its ancestors) renders once
    expanded, the CENTRE renders no thumbnails (#174 — images live as
    the right pane's branch thumbs), and Show=New prunes branches
    without a provisional face."""
    fresh(t)
    set_show_filter(t, "all")  # the persisted whotrc filter must not tilt the baseline
    js(t, """
      document.querySelectorAll('.topbar nav button')[1]?.click();
    """)  # the Rolls tab
    time.sleep(1.2)
    # branches start collapsed: one header per distinct top-level segment
    top = js(t, """
      return [...new Set(window.__MOCK_SNAP.images
        .map(i => i.primary_path.split('/').filter(Boolean)[0]))].length;
    """)
    headers0 = js(t, "return document.querySelectorAll('.roll-header').length")
    # drill in: expand every closed header until none is left (a click
    # now also selects the branch — irrelevant to this check)
    for _ in range(60):
        n = js(t, """
          const closed = [...document.querySelectorAll('.roll-header')]
            .filter(h => h.querySelector('.roll-arrow')?.textContent.trim() === '▸');
          closed.forEach(h => h.click());
          return closed.length;
        """)
        time.sleep(0.1)
        if not n:
            break
    time.sleep(0.5)
    # #174: the centre is a pure hierarchy — no inline grids/thumbs
    center = js(t, r"""
      return {grids: document.querySelectorAll('.rolls .img-grid').length,
              thumbs: document.querySelectorAll('.rolls .img-thumb').length};
    """)
    pure = center["grids"] == 0 and center["thumbs"] == 0
    # every DIRECTORY branch renders: the rel-path of each header title
    # equals the ancestors-closure of the image directories
    def header_paths():
        return js(t, "return [...document.querySelectorAll('.roll-path')].map(x => x.title);")

    def expected_dirs(listed_js):
        return sorted(js(t, r"""
          const dirOf = p => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
          const anc = new Set();
          for (const im of %s) {
            let p = dirOf(im.primary_path);
            while (p && p !== '/') {
              anc.add(p.startsWith('/') ? p.slice(1) : p);
              p = dirOf(p);
            }
          }
          return [...anc];
        """ % listed_js))

    headers = header_paths()
    open_ok = sorted(headers) == expected_dirs("window.__MOCK_SNAP.images")
    # Show=New: branches survive only where a provisional face lists
    set_show_filter(t, "provisional")
    time.sleep(0.8)
    headers_new = header_paths()
    prune_ok = sorted(headers_new) == expected_dirs(
        "window.__MOCK_SNAP.images.filter(i => "
        "new Set(window.__MOCK_SNAP.faces.filter(f => f.link_status === 'provisional')"
        ".map(f => f.image_id)).has(i.id))"
    )
    set_show_filter(t, "all")
    ok = headers0 == top and pure and open_ok and prune_ok
    record("C18 Rolls pane mirrors the filesystem path tree, Show prunes (#161/#174)", ok,
           f"top-level headers={headers0} (expected {top}); centre grids/thumbs="
           f"{center['grids']}/{center['thumbs']} (want 0/0); branches after expand "
           f"={len(headers)} exact={open_ok}; Show=New branches={len(headers_new)} "
           f"exact={prune_ok}")


def c19_staged_desc_regroups(t):
    """#155 (v3.55): in Description mode (cluster-group toggle), a staged
    description edit (dialog Apply, §4.24) regroups the sections LIVE —
    the face moves under the description it will land in on Accept;
    Undo returns the committed grouping; Accept commits it."""
    fresh(t)
    # a person with >= 2 visible faces — target face `a` gets the staged
    # desc, face `b` must stay put
    pick = js(t, """
      const vis = f => f.person_id != null && (f.state ?? '') !== 'discarded'
                     && f.link_status !== 'rejected';
      for (const p of window.__MOCK_SNAP.persons) {
        const fs = window.__MOCK_SNAP.faces.filter(f => vis(f) && f.person_id === p.id);
        if (fs.length >= 2)
          return {pid: p.id, a: fs[0].id, aDesc: fs[0].description ?? '',
                  b: fs[1].id};
      }
      return null;
    """)
    if not pick:
        record("C19 staged Apply regroups Description sections (#155)", True,
               f"no person with 2+ visible faces in the dump — vacuous")
        return
    set_show_filter(t, "all")  # the §4.10 pruning must not hide the target
    js(t, "document.querySelectorAll('.topbar nav button')[2]?.click();")  # Person tab
    time.sleep(0.8)
    t.find_element(By.CSS_SELECTOR,
                   f".tree-person[data-person-id='{pick['pid']}']").click()
    time.sleep(0.8)
    seg = js(t, """
      // the cluster-group seg lives in the person view's center toolbar
      const s = document.querySelector('.center-toolbar .seg')
             ?? document.querySelector('.seg');
      const d = [...(s?.querySelectorAll('button') ?? [])]
        .find(b => b.textContent.trim() === 'Description');
      if (!d) return null;
      const act = s.querySelector('button.active')?.textContent.trim() ?? null;
      if (!d.classList.contains('active')) d.click();
      return act;
    """)
    time.sleep(0.8)

    def header_for(face_id):
        return js(t, """
          const secs = [...document.querySelectorAll('.face-section')];
          const f = secs.find(s =>
            [...s.querySelectorAll('.face-card')]
              .some(c => c.getAttribute('data-face-id') === String(arguments[0])));
          return f ? f.querySelector('.face-section-title')
                   ?.textContent?.trim() ?? '' : null;
        """, face_id)

    before = js(t, """
      return {
        both: [...document.querySelectorAll('.face-section')]
          .map(s => s.querySelector('.face-section-title')?.textContent?.trim()),
        aCard: !!document.querySelector(`.face-card[data-face-id='${arguments[0]}']`)
      };
    """, pick["a"])
    if not before["aCard"]:
        record("C19 staged Apply regroups Description sections (#155)", True,
               f"target card {pick['a']} not rendered — vacuous")
        return
    old_a = header_for(pick["a"])

    # stage the desc change on the card scope
    t.find_element(By.CSS_SELECTOR,
                   f".face-card[data-face-id='{pick['a']}'] .card-edit").click()
    time.sleep(0.6)
    inp = t.find_element(By.CSS_SELECTOR, ".edit-dialog .input-desc")
    inp.click()
    inp.clear()
    inp.send_keys("gui19hat")
    [b for b in t.find_elements(By.CSS_SELECTOR, ".edit-dialog button")
     if b.text.strip() == "Apply"][0].click()
    time.sleep(0.8)
    staged_a = header_for(pick["a"])

    # Undo (discard) restores the committed grouping
    [b for b in t.find_elements(By.CSS_SELECTOR, ".rulebar button")
     if b.text.strip().startswith("Undo")][0].click()
    time.sleep(0.8)
    undone_a = header_for(pick["a"])

    # re-stage and commit through bar Accept — desc write + accept
    t.find_element(By.CSS_SELECTOR,
                   f".face-card[data-face-id='{pick['a']}'] .card-edit").click()
    time.sleep(0.6)
    inp = t.find_element(By.CSS_SELECTOR, ".edit-dialog .input-desc")
    inp.click()
    inp.clear()
    inp.send_keys("gui19hat")
    [b for b in t.find_elements(By.CSS_SELECTOR, ".edit-dialog button")
     if b.text.strip() == "Apply"][0].click()
    time.sleep(0.5)
    [b for b in t.find_elements(By.CSS_SELECTOR, ".rulebar button")
     if "Accept" in b.text][0].click()
    time.sleep(1.5)
    committed_a = header_for(pick["a"])
    mock_desc = js(t, """
      return window.__MOCK_SNAP.faces.find(x => x.id === arguments[0])
        ?.description ?? null;
    """, pick["a"])

    changed = (
        old_a is not None and staged_a is not None
        and "gui19hat" in (staged_a or "")
        and (old_a or "") not in ("gui19hat",)
        and undone_a == old_a
    )
    final = committed_a is not None and "gui19hat" in (committed_a or "") \
        and mock_desc == "gui19hat"
    ok = changed and final
    record("C19 staged Apply regroups Description sections (#155)", ok,
           f"mode switch: {seg!r}→Description; person={pick['pid']} "
           f"description {old_a!r} -> {staged_a!r} (staged) -> "
           f"{undone_a!r} (Undo) -> {committed_a!r} (Accept, mock desc={mock_desc!r})")


def c20_multi_group_renders_everywhere(t):
    """#156 (§4.16, v3.56): a person with SEVERAL person_groups rows
    renders under EVERY listed path — the §9 harvest importer leaves
    multiple rows (additive shell groups, #128), and the old groups[0]
    placement made such a person unfindable in the branch the user filed
    them under."""
    fresh(t)
    set_show_filter(t, "all")  # the §4.10 pruning must not interfere
    pick = js(t, """
      // first person with >= 2 DISTINCT group rows and a matching face
      for (const p of window.__MOCK_SNAP.persons) {
        if (!p.groups || new Set(p.groups).size < 2) continue;
        if (!window.__MOCK_SNAP.faces.some(f => f.person_id === p.id
            && f.link_status !== 'rejected' && (f.state ?? '') !== 'discarded'))
          continue;
        return {pid: p.id, name: p.name, groups: p.groups};
      }
      return null;
    """)
    if not pick:
        record("C20 multi-group renders under every path (#156)", True,
               "no multi-group person in the dump — vacuous")
        return
    rows = js(t, """
      return [...document.querySelectorAll('.tree-person')]
        .filter(x => x.getAttribute('data-person-id') === String(arguments[0]))
        .map(x => {
          // enclosing branch of this placement = the .tree-node whose
          // row block directly holds this row's .tree-children
          const kids = x.closest('.tree-children');
          const holder = kids ? kids.parentElement : null;
          const name = holder?.querySelector('.tree-node-name')?.textContent ?? '';
          return name;
        });
    """, pick["pid"])
    # each distinct group row → one placement, whose enclosing leaf name
    # is the row's last segment
    want = sorted({seg for seg in (g.split("|")[-1] for g in pick["groups"]) if seg})
    got = sorted(set(rows))
    ok = len(rows) == len(set(pick["groups"])) and got == want
    record("C20 multi-group renders under every path (#156)", ok,
           f"{pick['name']} (rows={pick['groups']}) → {len(rows)} rendered "
           f"placements under {got} (want {want})")



def dialog_actions_above_typeahead(dlg_js):
    """JS: true iff .dialog-actions precedes the first typeahead input"""
    return f"""
      const d = {dlg_js};
      if (!d) return null;
      const act = d.querySelector('.dialog-actions');
      const inp = d.querySelector('.typeahead input');
      return act && inp && (act.compareDocumentPosition(inp) & 4) !== 0;
    """


def c9_actions_above_typeahead(t):
    fresh(t)
    t.find_element(By.CSS_SELECTOR, ".face-card .card-edit").click()
    time.sleep(0.6)
    edit_ok = js(t, dialog_actions_above_typeahead(
        "[...document.querySelectorAll('.overlay .dialog')]"
        ".find(x => x.querySelector('.scope-seg'))"))
    AC(t.driver).send_keys(Keys.ESCAPE).perform()
    time.sleep(0.6)
    group_ok = None
    AC(t.driver).context_click(t.find_element(By.CSS_SELECTOR, ".tree-person")).perform()
    time.sleep(0.6)
    items = [b for b in t.find_elements(By.CSS_SELECTOR, ".ctx-item")
             if "Move to group" in b.text]
    if items:
        items[0].click()
        time.sleep(0.8)
        group_ok = js(t, dialog_actions_above_typeahead(
            "[...document.querySelectorAll('.overlay .dialog')]"
            ".find(x => /group/i.test(x.querySelector('h3')?.textContent ?? '')"
            "&& x.querySelector('.typeahead') && !x.querySelector('.scope-seg'))"))
        AC(t.driver).send_keys(Keys.ESCAPE).perform()
        time.sleep(0.4)
    else:
        AC(t.driver).send_keys(Keys.ESCAPE).perform()
    ok = edit_ok is True and (group_ok is True or group_ok is None)
    record("C9 dialog action rows above typeahead (#131)", ok,
           f"edit={edit_ok} group={group_ok}")


def c10_noop_apply_is_info(t):
    fresh(t)
    t.find_element(By.CSS_SELECTOR, ".face-card .card-edit").click()
    time.sleep(0.6)
    [b for b in t.find_elements(By.CSS_SELECTOR, ".edit-dialog button")
     if b.text.strip() == "Apply"][0].click()
    time.sleep(0.8)
    rep = js(t, """
      const info = document.querySelector('.toast.info');
      const err = document.querySelector('.toast:not(.info)');
      return {
        info: info ? info.querySelector('.toast-text')?.textContent.trim() : null,
        infoButtons: info ? info.querySelectorAll('button').length : null,
        errorToast: err ? err.querySelector('.toast-text')?.textContent.trim() : null,
      };
    """)
    ok = (rep["info"] and "nothing to apply" in rep["info"]
          and rep["infoButtons"] == 0 and not rep["errorToast"])
    # the info must survive the action that raised it and clear on the NEXT
    # user action — 'z' is not a bound shortcut (trusted keystroke)
    AC(t.driver).send_keys("z").perform()
    time.sleep(0.8)
    gone = js(t, "return !document.querySelector('.toast.info')")
    ok = ok and gone
    record("C10 no-op Apply is an info toast (#132)", ok, f"{rep} cleared-on-next-action={gone}")


def c11_merge_focuses_target(t):
    fresh(t)
    pick = js(t, r"""
      const rows = [...document.querySelectorAll('.tree-person')].map(n => {
        const name = n.querySelector('.tree-name')?.textContent.trim() ?? '';
        const total = Number(n.querySelector('.tree-count.total')?.textContent ?? 0);
        return {name, total};
      }).filter(r => r.name && !/^unknown/i.test(r.name) && r.total > 0);
      if (rows.length < 2) return null;
      rows.sort((a, b) => b.total - a.total);
      return {source: rows[1].name, target: rows[0].name,
              before: rows[0].total + rows[1].total};
    """)
    if pick is None:
        record("C11 post-merge focus (#133)", True,
               "need two visible named persons with faces — vacuous")
        return
    nodes = t.find_elements(By.CSS_SELECTOR, ".tree-person")
    src = next(e for e in nodes
               if e.find_element(By.CSS_SELECTOR, ".tree-name").text.strip() == pick["source"])
    js(t, "arguments[0].scrollIntoView({block: 'center'})", src)
    time.sleep(0.4)
    AC(t.driver).context_click(src).perform()
    time.sleep(0.6)
    items = [b for b in t.find_elements(By.CSS_SELECTOR, ".ctx-item")
             if "into" in b.text and "Merge" in b.text]
    if not items:
        AC(t.driver).send_keys(Keys.ESCAPE).perform()
        record("C11 post-merge focus (#133)", False, "no Merge-into menu item")
        return
    items[0].click()
    time.sleep(0.8)
    inp = t.find_element(By.CSS_SELECTOR, ".overlay .dialog .typeahead input")
    inp.click()
    inp.send_keys(pick["target"])
    time.sleep(0.6)
    merge_btn = [b for b in t.find_elements(By.CSS_SELECTOR, ".overlay .dialog button.bad")
                 if b.is_enabled()]
    if not merge_btn:
        AC(t.driver).send_keys(Keys.ESCAPE).perform()
        record("C11 post-merge focus (#133)", False, "merge button not enabled")
        return
    merge_btn[0].click()
    time.sleep(1.5)
    rep = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const target = snap.persons.find(p => p.name === arguments[0]);
      const source = snap.persons.find(p => p.name === arguments[1]);
      const sections = [...document.querySelectorAll('.face-section')]
        .map(s => s.querySelector('.rule .rule-label')?.textContent.trim() ?? null);
      const selName = document.querySelector('.tree-person.selected .tree-name')?.textContent.trim() ?? null;
      return {
        targetCount: target ? target.counts.total : null,
        sourceGone: !source,
        centerHasTarget: sections.includes(arguments[0]),
        selectedPerson: selName,
      };
    """, pick["target"], pick["source"])
    ok = (rep["targetCount"] == pick["before"] and rep["sourceGone"]
          and rep["centerHasTarget"] and rep["selectedPerson"] == pick["target"])
    record("C11 post-merge focus (#133)", ok,
           f"target {pick['target']}: {rep} (expected {pick['before']} faces)")


def drag_face(t, src_sel, dst_sel):
    """Simulate an HTML5 drag of a face card (src_sel) onto a drop target
       (dst_sel). Trusted WebDriver mouse events do not raise HTML5 DnD
       reliably (headless Firefox never did; #170 keeps the suite
       engine-neutral), so the drag events are dispatched with a
       shimmed dataTransfer — React's root listeners pick them up.
       Returns 'dropped' (the target highlighted on dragover), 'refused'
       (no highlight — a browser would not deliver a drop), or an error.
       window.__dnd.targetId captures the highlighted card during dragover."""
    started = js(t, r"""
      const src = document.querySelector(arguments[0]);
      const dst = document.querySelector(arguments[1]);
      if (!src || !dst) return "missing nodes";
      window.__dnd = {done: null, accepted: null, targetId: null};
      const mk = (type) => {
        const ev = new Event(type, {bubbles: true, cancelable: true});
        Object.defineProperty(ev, "dataTransfer", {
          value: { _d: {}, effectAllowed: "", dropEffect: "",
                   setData(k, v) { this._d[k] = v; },
                   getData(k) { return this._d[k] ?? ""; } }});
        return ev;
      };
      src.dispatchEvent(mk("dragstart"));
      setTimeout(() => {
        dst.dispatchEvent(mk("dragover"));
        setTimeout(() => {
          window.__dnd.targetId =
            document.querySelector('.face-card.desc-target')
              ?.getAttribute('data-face-id') ?? null;
          window.__dnd.accepted =
            dst.classList.contains("merge-target") ||
            dst.classList.contains("desc-target");
          if (window.__dnd.accepted) dst.dispatchEvent(mk("drop"));
          src.dispatchEvent(mk("dragend"));
          window.__dnd.done = "done";
        }, 80);
      }, 80);
      return "started";
    """, src_sel, dst_sel)
    if started != "started":
        return started
    deadline = time.time() + 10
    while time.time() < deadline:
        st = js(t, "return window.__dnd")
        if st and st.get("done") == "done":
            return "dropped" if st["accepted"] else "refused"
        time.sleep(0.1)
    return "timeout"


def c12_face_drag_merges_into_person(t):
    fresh(t)
    set_show_filter(t, "all")
    pick = js(t, r"""
      const rows = [...document.querySelectorAll('.tree-person')].map(n => {
        const name = n.querySelector('.tree-name')?.textContent.trim() ?? '';
        const total = Number(n.querySelector('.tree-count.total')?.textContent ?? 0);
        return {name, total};
      }).filter(r => r.name && !/^unknown/i.test(r.name) && r.total > 0);
      if (rows.length < 2) return null;
      rows.sort((a, b) => b.total - a.total);
      return {source: rows[1].name, target: rows[0].name,
              targetBefore: rows[0].total, sourceBefore: rows[1].total};
    """)
    if pick is None:
        record("C12 face-drag merge (#135)", True,
               "need two visible named persons with faces — vacuous")
        return
    nodes = t.find_elements(By.CSS_SELECTOR, ".tree-person")
    src = next(e for e in nodes
               if e.find_element(By.CSS_SELECTOR, ".tree-name").text.strip() == pick["source"])
    js(t, "arguments[0].scrollIntoView({block: 'center'})", src)
    time.sleep(0.4)
    src.click()  # centre pane = the source person's faces
    time.sleep(1.0)
    cards = t.find_elements(By.CSS_SELECTOR, ".face-card")
    if len(cards) < 2:
        record("C12 face-drag merge (#135)", True, "source person has < 2 cards — vacuous")
        return
    fid1 = cards[0].get_attribute("data-face-id")
    fid2 = cards[1].get_attribute("data-face-id")
    cards[0].click()
    time.sleep(0.4)
    AC(t.driver).key_down(Keys.CONTROL).click(cards[1]).key_up(Keys.CONTROL).perform()
    time.sleep(0.6)
    # tag the target row for a reliable selector
    js(t, r"""
      const n = [...document.querySelectorAll('.tree-person')]
        .find(x => x.querySelector('.tree-name')?.textContent.trim() === arguments[0]);
      n?.setAttribute('data-gc', '1');
    """, pick["target"])
    drag = drag_face(t, f".face-card[data-face-id='{fid1}']", ".tree-person[data-gc='1']")
    time.sleep(0.8)
    if drag != "dropped":
        record("C12 face-drag merge (#135)", False, f"person row did not accept the face drag: {drag}")
        return
    # the drop CONFIRMS — nothing moved while the dialog is open
    pre = face_by_id(t, fid1)
    dlg = js(t, r"""
      const d = [...document.querySelectorAll('.overlay .dialog')]
        .find(x => /Merge \d+ face\(s\) into/.test(x.querySelector('h3')?.textContent ?? ''));
      return d ? {h3: d.querySelector('h3').textContent.trim(),
                  chips: [...d.querySelectorAll('.ev-chip')].map(c => c.textContent.trim())}
               : null;
    """)
    if pre["person"] != pick["source"] or dlg is None or pick["target"] not in dlg["h3"]:
        record("C12 face-drag merge (#135)", False,
               f"drop did not ask without moving: pre={pre}, dialog={dlg}")
        return
    t.find_element(By.CSS_SELECTOR, ".overlay .dialog button.bad").click()
    time.sleep(1.5)
    rep = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const target = snap.persons.find(p => p.name === arguments[0]);
      const source = snap.persons.find(p => p.name === arguments[1]);
      const f1 = snap.faces.find(f => f.id === Number(arguments[2]));
      const f2 = snap.faces.find(f => f.id === Number(arguments[3]));
      const sections = [...document.querySelectorAll('.face-section')]
        .map(s => s.querySelector('.rule .rule-label')?.textContent.trim() ?? null);
      return {
        dialog: !![...document.querySelectorAll('.overlay .dialog')]
          .some(x => /Merge \d+ face\(s\) into/.test(x.querySelector('h3')?.textContent ?? '')),
        bothMoved: f1?.person_id === target?.id && f2?.person_id === target?.id,
        targetCount: target ? target.counts.total : null,
        sourceAfter: source ? source.counts.total : null,
        centerHasTarget: sections.includes(arguments[0]),
        selectedPerson: document.querySelector('.tree-person.selected .tree-name')?.textContent.trim() ?? null,
      };
    """, pick["target"], pick["source"], fid1, fid2)
    source_ok = (rep["sourceAfter"] is None if pick["sourceBefore"] == 2
                 else rep["sourceAfter"] == pick["sourceBefore"] - 2)
    ok = (not rep["dialog"] and rep["bothMoved"]
          and rep["targetCount"] == pick["targetBefore"] + 2 and source_ok
          and rep["centerHasTarget"] and rep["selectedPerson"] == pick["target"])
    record("C12 face-drag merge (#135)", ok,
           f"{pick['source']} -> {pick['target']}: dialog={dlg['h3']}, {rep}")


def c14_drag_sources(t):
    # v3.33 (rule 34 implementation notes): the face crop and the tree
    # avatar must NOT be native drag sources — a press on the image would
    # start an image/URL drag (copy-only) that WebKit never drops back
    # into the app; the card div and the person row are the sources
    fresh(t)
    set_show_filter(t, "all")  # the persisted whotrc filter must not tilt the baseline
    bad = js(t, r"""
      const bad = [];
      document.querySelectorAll('.face-card img').forEach(i => {
        if (i.draggable) bad.push('face-crop img');
      });
      document.querySelectorAll('.tree-avatar img').forEach(i => {
        if (i.draggable) bad.push('tree-avatar img');
      });
      if (!document.querySelector('.face-card')?.draggable)
        bad.push('face-card not draggable');
      const rows = [...document.querySelectorAll('.tree-person')];
      const row = rows.find(r =>
        (r.querySelector('.tree-name')?.textContent ?? '').trim() !== 'Rejected');
      if (!row?.draggable) bad.push('tree-person not draggable');
      return bad;
    """)
    # #165/§4.35: the system person's row (only listed under Show →
    # Rejected) is never a drag source either
    set_show_filter(t, "rejected")
    bad += js(t, r"""
      const row = [...document.querySelectorAll('.tree-person')]
        .find(r => (r.querySelector('.tree-name')?.textContent ?? '').trim() === 'Rejected');
      return row && row.draggable ? ['system person row draggable'] : [];
    """)
    set_show_filter(t, "all")
    record("C14 drag sources (v3.33 WebKit fixes)", not bad,
           "; ".join(bad) if bad
           else "face crops + avatars inert; cards + rows are the sources")


def c13_face_drag_copies_description(t):
    fresh(t)
    set_show_filter(t, "all")
    pick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      for (const p of snap.persons) {
        if (/^unknown/i.test(p.name)) continue;
        const fs = snap.faces.filter(f => f.person_id === p.id);
        const withDesc = fs.filter(f => (f.description ?? '').trim() !== '');
        if (withDesc.length < 1 || fs.length < 2) continue;
        const tg = withDesc[0];
        const rest = fs.filter(f => f.id !== tg.id);
        const s = rest.find(f => (f.description ?? '') !== tg.description) ?? rest[0];
        const o = rest.find(f => f.id !== s.id) ?? null;
        const e = rest.find(f => (f.description ?? '').trim() === '') ?? null;
        const rowIdx = [...document.querySelectorAll('.tree-person')]
          .findIndex(n => n.querySelector('.tree-name')?.textContent.trim() === p.name);
        if (rowIdx < 0) continue;
        return {person: p.name, rowIdx,
                target: tg.id, targetDesc: tg.description,
                source: s.id, sourceDesc: s.description ?? null,
                other: o ? o.id : null, empty: e ? e.id : null};
      }
      return null;
    """)
    if pick is None:
        record("C13 face-drag description copy (#136)", True,
               "need a person with a described face + another face — vacuous")
        return
    js(t, "document.querySelectorAll('.tree-person')[arguments[0]].scrollIntoView({block: 'center'})", pick["rowIdx"])
    time.sleep(0.4)
    js(t, "document.querySelectorAll('.tree-person')[arguments[0]].click()", pick["rowIdx"])
    time.sleep(1.0)
    # 1) empty-description card is NOT a target: refused, nothing changes
    if pick["empty"]:
        drag = drag_face(t, f".face-card[data-face-id='{pick['source']}']",
                         f".face-card[data-face-id='{pick['empty']}']")
        time.sleep(0.6)
        pre = js(t, r"""
          const f = window.__MOCK_SNAP.faces.find(x => x.id === Number(arguments[0]));
          return {desc: f?.description ?? null};
        """, pick["source"])
        if drag != "refused" or pre["desc"] != pick["sourceDesc"]:
            record("C13 face-drag description copy (#136)", False,
                   f"empty-description card must refuse: drag={drag}, {pre}")
            return
    # 2) select the payload (source + optional other) and drop on the target
    src_card = t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{pick['source']}']")
    js(t, "arguments[0].scrollIntoView({block: 'center'})", src_card)
    time.sleep(0.4)
    src_card.click()
    time.sleep(0.4)
    if pick["other"]:
        other_card = t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{pick['other']}']")
        js(t, "arguments[0].scrollIntoView({block: 'center'})", other_card)
        time.sleep(0.3)
        AC(t.driver).key_down(Keys.CONTROL).click(other_card).key_up(Keys.CONTROL).perform()
        time.sleep(0.5)
    drag = drag_face(t, f".face-card[data-face-id='{pick['source']}']",
                     f".face-card[data-face-id='{pick['target']}']")
    time.sleep(1.5)
    rep = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const g = (id) => {
        const f = snap.faces.find(x => x.id === Number(id));
        return f ? {desc: f.description ?? null, name: f.name} : null;
      };
      return {
        source: g(arguments[0]), target: g(arguments[1]),
        other: arguments[2] ? g(arguments[2]) : null,
        toast: document.querySelector('.toast:not(.info)')?.textContent.trim() ?? null,
      };
    """, pick["source"], pick["target"], pick["other"] or "")
    ok = (drag == "dropped" and rep["source"]["desc"] == pick["targetDesc"]
          and rep["target"]["desc"] == pick["targetDesc"] and rep["toast"] is None
          and (pick["other"] is None or rep["other"]["desc"] == pick["targetDesc"]))
    record("C13 face-drag description copy (#136)", ok,
           f"{pick['person']}: drag={drag}, {rep}")


def c15_merge_dialog_scroll(t):
    # v3.34 (#137): a truncated rule + duplicate block in styles.css (since
    # 631a90e/#67) desynced the CSS parser — the sheet stopped after the
    # typeahead section, so #126's cap/scroll CSS never applied. Two locks:
    # the sheet must parse to its final rule, and the open dialog must
    # honour #126 (capped, scrolling list, action row in the viewport)
    fresh(t)
    parse_bad = js(t, r"""
      const sheet = [...document.styleSheets][0];
      const rules = [...sheet.cssRules];
      const bad = [];
      if (rules.length === 0) bad.push('no rules parsed');
      else if (rules.at(-1).selectorText !== '.merge-spacer')
        bad.push('sheet stops at ' + rules.at(-1).selectorText);
      const btn = document.querySelector('button.merge-open');
      if (btn) btn.click();
      return bad;
    """)
    time.sleep(0.4)
    m = js(t, r"""
      const bad = [...arguments[0]];
      const dlg = document.querySelector('.merge-dialog');
      if (!dlg) { bad.push('dialog did not open'); return {bad, m: null}; }
      const dcs = getComputedStyle(dlg);
      const list = dlg.querySelector('.merge-list');
      const lcs = list ? getComputedStyle(list) : null;
      const cl = dlg.querySelector('.merge-cluster');
      const ccs = cl ? getComputedStyle(cl) : null;
      const foot = dlg.querySelector('.merge-foot');
      const dr = dlg.getBoundingClientRect();
      const fr = foot ? foot.getBoundingClientRect() : null;
      const cap = window.innerHeight * 0.86;
      if (dcs.maxHeight === 'none') bad.push('dialog max-height not applied');
      else if (dr.height > cap + 2) bad.push('dialog exceeds 86vh cap');
      if (!lcs || lcs.overflowY !== 'auto') bad.push('list not scrollable');
      if (!lcs || lcs.minHeight !== '0px') bad.push('list min-height not 0');
      if (!ccs || ccs.flexShrink !== '0') bad.push('clusters shrink instead of scrolling');
      if (!fr || fr.bottom > window.innerHeight + 1) bad.push('action row below viewport');
      return {bad, m: {dialogH: Math.round(dr.height), capPx: Math.round(cap)}};
    """, parse_bad)
    ok = not m["bad"]
    record("C15 merge dialog: sheet fully parsed, #126 cap + scroll list + pinned footer (v3.34/#137)",
           ok, "; ".join(m["bad"]) if m["bad"]
           else f"last rule .merge-spacer; cap {m['m']}")


def c21_show_filter_in_topbar(t):
    """:0158 (v3.57): the Show status filter is a GLOBAL control and lives
    in the top bar where every tab can reach it — not in the person view's
    centre toolbar next to the view-local cluster-group seg."""
    fresh(t)
    topbar = js(t, """
      return {
        sel: !!document.querySelector('.topbar select'),
        opts: [...(document.querySelector('.topbar select')?.options ?? [])]
          .map(o => o.value),
        val: document.querySelector('.topbar select')?.value ?? null,
        centre: !!document.querySelector('.center-toolbar select'),
        seg: !!document.querySelector('.center-toolbar .seg'),
      };
    """)
    ok = (topbar["sel"] and topbar["centre"] is False
          and set(["all", "provisional", "confirmed", "rejected"]
                  ).issubset(set(topbar["opts"])))
    record("C21 Show filter lives in the top bar (#158)", ok,
           f"topbar select={topbar['sel']} (opts={topbar['opts']}, "
           f"value={topbar['val']}), centre toolbar select={topbar['centre']}, "
           f"centre seg on review={topbar['seg']} (hidden, #163 → C27)")


def c22_review_exhaust_skips_reviewed(t):
    """#159 (§4.30, v3.58): after the last review verdict on a person the
    exhaust advance lands on the first person AFTER them in the tree list
    that still has a face of the review status — never on the raw
    successor (which may hold nothing to review → 'nothing to show' with
    pending faces elsewhere)."""
    fresh(t)
    set_show_filter(t, "all")
    pick = js(t, r"""
      // a person with pending faces whose NEXT tree-list entry has none
      const seen = new Set(); const ids = [];
      for (const el of document.querySelectorAll('.tree-person')) {
        const id = String(el.getAttribute('data-person-id'));
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
      }
      const pend = id => window.__MOCK_SNAP.faces.filter(
        f => f.person_id === Number(id) && f.link_status === 'provisional').length;
      for (let i = 0; i + 1 < ids.length; i++)
        if (pend(ids[i]) > 0 && pend(ids[i + 1]) === 0) {
          const p = window.__MOCK_SNAP.persons.find(x => String(x.id) === ids[i]);
          return {a: ids[i], aname: p?.name, b: ids[i + 1]};
        }
      return null;
    """)
    if not pick:
        record("C22 review exhaust skips reviewed persons (#159)", True,
               "no person followed by a pending-less neighbour — vacuous")
        return
    t.find_element(By.CSS_SELECTOR,
                   f".tree-person[data-person-id='{pick['a']}']").click()
    time.sleep(1.0)
    js(t, "[...document.querySelectorAll('.topbar nav button')][0].click();")
    time.sleep(1.0)
    # select-all the acted person's review section, then Accept
    acted = js(t, r"""
      for (const s of document.querySelectorAll('.face-section')) {
        const title = s.querySelector('.face-section-title')?.textContent ?? '';
        if (title === arguments[0]) {
          const cb = s.querySelector('.select-all input');
          if (cb) cb.click();
          return title;
        }
      }
      return null;
    """, pick["aname"])
    time.sleep(0.6)
    acc = [b for b in t.find_elements(By.CSS_SELECTOR, ".rulebar button")
           if "Accept" in b.text]
    acc[0].click()
    time.sleep(2.5)
    landed = js(t, r"""
      const id = Number(document.querySelector('.tree-person.selected')
        ?.getAttribute('data-person-id'));
      const info = document.querySelector('.info')?.textContent ?? null;
      return {
        landed: id,
        landedHasPending: window.__MOCK_SNAP.faces.some(
          f => f.person_id === id && f.link_status === 'provisional'),
        info,
        view: [...document.querySelectorAll('.topbar nav button')]
          .filter(x => x.className.includes('active'))
          .map(x => x.textContent.trim().split('\n')[0]),
      };
    """)
    ok = landed["landedHasPending"] or (
      landed["info"] is not None
      and "no more persons to review" in landed["info"])
    # the old bug parked on the raw successor — recorded either way
    ok = ok and landed["landed"] != pick["b"]
    record("C22 review exhaust skips reviewed persons (#159)", ok,
           f"acted {pick['aname']} (next list entry {pick['b']} has nothing "
           f"to review) → landed on person {landed['landed']} "
           f"(pending={landed['landedHasPending']}, info={landed['info']!r})")


def c23_dnd_moves_one_membership(t):
    """#157 (§4.16, v3.59, owner ruling): dragging a person row onto a
    branch re-homes THAT membership — remove the dragged-from row, file
    into the target (INSERT OR IGNORE), keep every other membership.
    Christiaan Swart (Friends + Friends|Swartse) dragged from Friends
    onto Friends|Swartse ends up in exactly Friends|Swartse."""

    drag = r"""
      // find a person placement row by its branch path, and the target
      // branch header by path — then dispatch an HTML5 drag (shimmed
      // dataTransfer, like drag_face)
      const pid = arguments[0], srcPath = arguments[1], dstPath = arguments[2];
      const headerOf = (h) => {
        // a branch wrapper = [div.tree-node (header), div.tree-children
        // (rows only), child branch wrappers…] — so the parent header is
        // the parent wrapper's FIRST child, and the root container (no
        // direct .tree-node child) ends the climb
        const parts = [];
        let cur = h;
        while (cur) {
          const nm = cur.querySelector(':scope > .tree-node-name')
            ?.textContent.trim();
          if (nm == null) return null;
          parts.unshift(nm);
          const wrap = cur.parentElement;
          const pw = wrap && wrap.parentElement;
          if (!pw) break;
          const parentHeader = pw.firstElementChild;
          if (!parentHeader || !parentHeader.classList
              || !parentHeader.classList.contains('tree-node')) break;
          cur = parentHeader;
        }
        return parts.join('|');
      };
      const rows = [...document.querySelectorAll(
        `.tree-person[data-person-id='${pid}']`)];
      const src = rows.find((r) => {
        const kids = r.closest('.tree-children');
        const h = kids ? kids.previousElementSibling : null;
        return h ? headerOf(h) === srcPath : false;
      });
      const dst = [...document.querySelectorAll('.tree-node')].find(
        (n) => headerOf(n) === dstPath);
      if (!src || !dst) return {src: !!src, dst: !!dst};
      window.__dndmove = {started: true};
      const mk = (type) => {
        const ev = new Event(type, {bubbles: true, cancelable: true});
        Object.defineProperty(ev, "dataTransfer", {
          value: { _d: {}, effectAllowed: "", dropEffect: "",
                   setData(k, v) { this._d[k] = v; },
                   getData(k) { return this._d[k] ?? ""; } }});
        return ev;
      };
      src.dispatchEvent(mk("dragstart"));
      setTimeout(() => {
        dst.dispatchEvent(mk("dragover"));
        setTimeout(() => {
          dst.dispatchEvent(mk("drop"));
          src.dispatchEvent(mk("dragend"));
          window.__dndmove.done = true;
        }, 80);
      }, 80);
      return {src: true, dst: true};
    """

    def groups_of(t, pid):
        return js(t, """
          const p = window.__MOCK_SNAP.persons.find(x => x.id === Number(arguments[0]));
          return p?.groups ?? null;
        """, pid)

    def placements(t, pid):
        return js(t, """
          return [...document.querySelectorAll(
            `.tree-person[data-person-id='${arguments[0]}']`)].length;
        """, pid)

    # --- A: the owner's scenario — Christiaan Swart (1304)
    # Friends + Friends|Swartse, Friends-row dropped on Friends|Swartse
    fresh(t)
    set_show_filter(t, "all")
    before = groups_of(t, 1304)
    if not (isinstance(before, list) and set(before) == {"Friends", "Friends|Swartse"}):
        record("C23 D&D moves ONE membership (#157)", True,
               f"Christiaan Swart rows changed in the dump (now {before}) — vacuous")
        return
    r = js(t, drag, 1304, "Friends", "Friends|Swartse")
    time.sleep(1.6)
    after = groups_of(t, 1304)
    a_ok = (r.get("src") and r.get("dst") and after == ["Friends|Swartse"]
            and placements(t, 1304) == 1)
    detail_a = (f"owner case: {before} dropped Friends→Friends|Swartse: "
                f"drag={r} → {after}, placements={placements(t, 1304)}")

    # --- B: cross-move — Esther (1248) Friends + Friends|PHS, Friends-row
    # dropped onto Friends|Swartse: Friends membership leaves, target filed
    fresh(t)
    set_show_filter(t, "all")
    before = groups_of(t, 1248)
    if not (isinstance(before, list) and set(before) == {"Friends", "Friends|PHS"}):
        record("C23 D&D moves ONE membership (#157)", True,
               f"Esther rows changed in the dump (now {before}) — vacuous")
        return
    r = js(t, drag, 1248, "Friends", "Friends|Swartse")
    time.sleep(1.6)
    after = groups_of(t, 1248)
    b_ok = (r.get("src") and r.get("dst") and sorted(after)
            == sorted(["Friends|PHS", "Friends|Swartse"]))
    detail_b = (f"cross-move: {before} dropped Friends→Friends|Swartse → {after}")

    # --- C: no-op — Esther's Friends|PHS placement dropped onto its own
    # branch (src == dst): nothing changes, both rows remain
    fresh(t)
    set_show_filter(t, "all")
    before = groups_of(t, 1248)
    r = js(t, drag, 1248, "Friends|PHS", "Friends|PHS")
    time.sleep(1.6)
    after = groups_of(t, 1248)
    c_ok = (r.get("src") and r.get("dst") and after == before
            and placements(t, 1248) == 2)
    detail_c = f"no-op drop: {before} onto itself → {after}, placements={placements(t, 1248)}"

    record("C23 D&D moves ONE membership (#157)", a_ok and b_ok and c_ok,
           f"{detail_a}; {detail_b}; {detail_c}")


def c24_dark_scheme_native_controls(t):
    """#158 follow-up (v3.59.1): the theme is dark — :root must declare
    color-scheme: dark so native form controls (the select's dropdown
    list and arrow, scrollbars) render dark-scheme, and the top-bar Show
    select's value text must be the theme text colour. WebKit's
    light-scheme defaults washed the value text out against the dark
    panel."""
    fresh(t)
    r = js(t, """
      const scheme = getComputedStyle(document.documentElement).colorScheme;
      const sel = document.querySelector('.topbar-right select');
      return {
        scheme: scheme,
        selColor: sel ? getComputedStyle(sel).color : null,
      };
    """)
    # --text is #dce4ee
    ok = (isinstance(r, dict)
          and r.get("scheme") == "dark"
          and r.get("selColor") == "rgb(220, 228, 238)")
    detail = (f"color-scheme={r.get('scheme') if r else None} "
              f"(want dark); topbar select value text="
              f"{r.get('selColor') if r else None} "
              f"(want rgb(220, 228, 238))")
    record("C24 dark color-scheme, legible top-bar select (#158 follow-up)",
           ok, detail)


def c25_merge_dialog_cancel_button(t):
    """#160 (v3.61): the Merge Similar Persons action row ends with a
    visible secondary 'cancel' button — enabled regardless of the
    selection, and clicking it closes the dialog with nothing applied
    (the dismiss Esc/overlay-click already offered, but invisibly)."""
    fresh(t)
    opened = js(t, r"""
      const b = document.querySelector('button.merge-open');
      if (!b) return {opened: false};
      b.click();
      return {opened: !!document.querySelector('.merge-dialog')};
    """)
    time.sleep(0.4)
    opened = js(t, "return !!document.querySelector('.merge-dialog')")
    btn = js(t, r"""
      const foot = document.querySelector('.merge-dialog .merge-foot');
      if (!foot) return {foot: false};
      const bs = [...foot.querySelectorAll('button')];
      const c = bs.find(x => x.textContent.trim() === 'cancel');
      if (!c) return {foot: true, cancel: false};
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      return {
        foot: true, cancel: true,
        secondary: c.classList.contains('secondary'),
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
        last: c === bs.at(-1),
        enabled: !c.disabled,
      };
    """)
    closed = js(t, r"""
      const c = [...document.querySelectorAll('.merge-dialog .merge-foot button')]
        .find(x => x.textContent.trim() === 'cancel');
      if (!c) return null;
      c.click();
      return 'clicked';
    """)
    time.sleep(0.4)
    gone = js(t, "return document.querySelector('.merge-dialog') == null")
    ok = bool(opened) and bool(btn.get('cancel')) \
        and bool(btn.get('secondary')) and bool(btn.get('visible')) \
        and bool(btn.get('last')) and bool(btn.get('enabled')) \
        and closed == 'clicked' and gone is True
    record("C25 Merge Similar dialog: visible cancel button closes it (#160)", ok,
           f"opened={opened}; button={btn}; click={closed}; closed={gone}")


def c26_rolls_path_filter(t):
    """#162 (v3.62): the Rolls pane's pinned path-filter row — a typed
    folder becomes the root the hierarchy branches from, a typed image
    path opens that image full-image (root untouched), an invalid path
    is refused with a dim hint (root kept), and browse… feeds the
    mocked native folder picker through the same validation."""
    fresh(t)
    set_show_filter(t, "all")
    js(t, "document.querySelectorAll('.topbar nav button')[1]?.click();")  # Rolls
    time.sleep(1.2)

    def set_path(v):
        js(t, r"""
          const el = document.querySelector('.roll-filter input');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, arguments[0]);
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
        """, v)
        time.sleep(0.5)

    def headers():
        return js(t, "return [...document.querySelectorAll('.roll-path')].map(x => x.textContent)")

    def input_value():
        return js(t, "return document.querySelector('.roll-filter input')?.value ?? null")

    def expected_children(root):
        return js(t, r"""
          const root = arguments[0];
          const pre = root === '/' ? '/' : root + '/';
          const kids = new Set();
          for (const i of window.__MOCK_SNAP.images) {
            if (!i.primary_path.startsWith(pre)) continue;
            const rest = root === '/' ? i.primary_path.slice(1) : i.primary_path.slice(root.length + 1);
            const seg = rest.split('/').filter(Boolean)[0];
            if (seg) kids.add(seg);
          }
          return [...kids].sort();
        """, root)

    # row pinned at the top of the pane (sticky, like the tree header)
    row = js(t, r"""
      const el = document.querySelector('.roll-filter');
      if (!el) return {row: false};
      const inp = el.querySelector('input');
      const btn = [...el.querySelectorAll('button')].find(b => b.textContent.includes('browse'));
      return {row: true, pos: getComputedStyle(el).position, input: !!inp, browse: !!btn};
    """)

    # 1) typed folder → root: top-level branches = its child segments
    root1 = "/home/stoflom/Pictures/OtherPictures"
    set_path(root1)
    h1 = headers()
    exp1 = expected_children(root1)

    # 2) invalid path → hint, root kept
    set_path("/no/such/dir")
    hint = js(t, "return document.querySelector('.roll-filter-hint')?.textContent ?? null")
    h2 = headers()

    # 3) typed image file → full-image mode, root untouched
    img_path = js(t, "return window.__MOCK_SNAP.images.find(i => i.primary_path.includes('Camera'))?.primary_path ?? null")
    set_path(img_path)
    detail = js(t, r"""
      const d = document.querySelector('.image-detail');
      return d ? (d.querySelector('.image-meta div')?.textContent ?? null) : null;
    """)
    js(t, "[...document.querySelectorAll('.image-detail-top button')].find(b => b.textContent.includes('rolls'))?.click();")
    time.sleep(0.6)
    back_val = input_value()

    # 4) browse… (mocked native picker) → same validation, new root
    root2 = "/home/stoflom/Pictures"
    js(t, "window.__MOCK_DIALOG_PICK__ = arguments[0];", root2)
    js(t, "[...document.querySelectorAll('.roll-filter button')].find(b => b.textContent.includes('browse')).click();")
    time.sleep(0.6)
    h4 = headers()
    exp4 = expected_children(root2)

    # 5) empty input → '/' → whole tree (top segment = 'home')
    js(t, "delete window.__MOCK_DIALOG_PICK__;")
    set_path("")
    h5 = headers()
    exp5 = expected_children("/")

    ok = (
        row.get("row") and row.get("pos") == "sticky" and row.get("input") and row.get("browse")
        and h1 == exp1 and len(h1) > 0
        and hint is not None and "no images under" in hint and h2 == h1
        and detail == img_path and back_val == root1
        and h4 == exp4 and len(h4) > 0
        and h5 == exp5 and input_value() == "/"
    )
    record("C26 Rolls path filter: root / filename-open / refusal / browse (#162)", ok,
           f"row={row}; typed root {len(h1)} branch(es) expected={len(exp1)} exact={h1 == exp1}; "
           f"hint={hint!r}; file → detail={detail is not None} "
           f"(root kept={back_val == root1}); browse {len(h4)}/{len(exp4)} exact={h4 == exp4}; "
           f"clear → {len(h5)}/{len(exp5)} exact={h5 == exp5}")


def c27_center_toolbar_view_matrix(t):
    """#163 (v3.63/v3.64): the centre toolbar is view-scoped — Rolls
    renders NO toolbar at all (nav cluster + Description/Accuracy seg
    both gone; the grid gets the pane's full height) and ←/→ person
    stepping is inert there (stepPerson always lands in the person view
    — it used to yank a rolls browser away); Review keeps the nav
    cluster without the seg; the person view keeps both (seg = §4.9)."""
    fresh(t)  # lands on Review
    def bar():
        return js(t, "return document.querySelector('.center-toolbar') != null")
    def seg():
        return js(t, "return !!document.querySelector('.center-toolbar .seg')")
    def nav():
        return js(t, "return document.querySelectorAll('.center-toolbar .toolbar-left button').length")
    def active_tab():
        return js(t, "return document.querySelector('.topbar nav .active')?.textContent.split(' ')[0] ?? null")
    def go(i):
        js(t, "[...document.querySelectorAll('.topbar nav button')][arguments[0]].click();", i)
        time.sleep(0.8)
    review_bar, review_seg, review_nav = bar(), seg(), nav()
    go(1)  # Rolls
    rolls_bar, rolls_seg, rolls_nav = bar(), seg(), nav()
    # ←/→ must be inert in Rolls — no yank to the person view
    js(t, "window.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));")
    time.sleep(0.6)
    after_key_tab = active_tab()
    after_key_bar = bar()
    js(t, "document.querySelector('.tree-person')?.click();")  # personId (tab is disabled without one)
    time.sleep(0.8)
    go(2)  # Person
    person_bar, person_seg, person_nav = bar(), seg(), nav()
    ok = (review_bar and review_seg is False and review_nav == 2
          and rolls_bar is False and rolls_seg is False and rolls_nav == 0
          and after_key_tab == "Rolls" and after_key_bar is False
          and person_bar and person_seg is True and person_nav == 2)
    record("C27 centre toolbar is view-scoped: none in Rolls, seg person-only (#163)", ok,
           f"bar/seg/nav — review={review_bar}/{review_seg}/{review_nav} "
           f"(want True/False/2), rolls={rolls_bar}/{rolls_seg}/{rolls_nav} "
           f"(want False/-/0), person={person_bar}/{person_seg}/{person_nav} "
           f"(want True/True/2); ArrowRight in rolls → tab={after_key_tab} "
           f"bar={after_key_bar} (want Rolls/False)")


def c28_add_group_person_rows_only(t):
    """#164 (v3.65): 'Add group…' lives on person rows only — the branch
    menu keeps Rename/move + Delete but no add entry, the tree root's
    empty space offers no menu at all (#54 superseded), and the person
    dialog ADDS the typed path as another membership: every current
    group is kept (Move to group… keeps the replace-all semantics)."""
    fresh(t)
    set_show_filter(t, "all")

    def ctx_labels():
        return js(t, "return [...document.querySelectorAll('.ctx-item')].map(x => x.textContent.trim())")

    def close_menu():
        js(t, "document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))")
        time.sleep(0.3)

    # 1) branch menu — real branch 'Friends': no Add, keeps rename/delete
    js(t, r"""
      const n = [...document.querySelectorAll('.tree-node')]
        .find(x => x.querySelector('.tree-node-name')?.textContent === 'Friends');
      if (n) n.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 80, clientY: 220}));
      window.__C28_branch = !!n;
    """)
    time.sleep(0.4)
    branch_found = js(t, "return window.__C28_branch")
    branch_items = ctx_labels()
    close_menu()
    branch_closed = js(t, "return document.querySelectorAll('.ctx-menu').length") == 0

    # 2) root empty space — no menu at all
    js(t, r"""
      const root = [...document.querySelectorAll('.person-tree > div')]
        .find(d => !d.classList.contains('tree-header'));
      root?.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 60, clientY: 420}));
    """)
    time.sleep(0.4)
    root_menus = js(t, "return document.querySelectorAll('.ctx-menu').length")

    # 3) person row — 'Add group…' → dialog → typed path becomes ANOTHER membership
    picked = js(t, r"""
      const p = window.__MOCK_SNAP.persons.find(x =>
        (x.groups?.length ?? 0) > 0 && x.counts?.total > 0 && !/^Unknown/.test(x.name) &&
        // #165: pick a REAL group — filing drops a status seat, which this
        // check's keep-all assertion does not model
        x.groups.some(g => !['New', 'Accepted', 'Rejected'].includes(g)));
      if (!p) return null;
      window.__C28 = {id: p.id, groups: p.groups.slice()};
      const row = document.querySelector(`.tree-person[data-person-id='${p.id}']`);
      if (!row) return null;
      row.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 120, clientY: 300}));
      return {id: p.id, groups: p.groups.slice()};
    """)
    time.sleep(0.4)
    person_items = ctx_labels()
    clicked = js(t, r"""
      const it = [...document.querySelectorAll('.ctx-item')]
        .find(x => x.textContent.trim() === 'Add group…');
      if (!it) return null;
      it.click();
      return true;
    """)
    time.sleep(0.5)
    dlg = js(t, r"""
      const h = document.querySelector('.dialog h3')?.textContent ?? null;
      return {open: !!document.querySelector('.dialog'), title: h};
    """)
    new_path = "GuiC28Grp"
    typed = js(t, r"""
      const el = document.querySelector('.dialog input');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, arguments[0]);
      el.dispatchEvent(new Event('input', {bubbles: true}));
      return true;
    """, new_path)
    submitted = js(t, r"""
      const b = [...document.querySelectorAll('.dialog-actions button')]
        .find(x => x.textContent.trim() === 'add group');
      if (!b) return false;
      b.click();
      return true;
    """)
    time.sleep(1.4)
    after = js(t, r"""
      const p = window.__MOCK_SNAP.persons.find(x => x.id === window.__C28.id);
      const rows = document.querySelectorAll(`.tree-person[data-person-id='${window.__C28.id}']`).length;
      return {groups: p ? p.groups.slice() : null, rows: rows,
              dialogGone: !document.querySelector('.dialog')};
    """)

    no_add_on_branch = not any(x.startswith("Add group") for x in branch_items)
    branch_keeps = (any("Rename/move group" in x for x in branch_items)
                    and any("Delete group" in x for x in branch_items))
    person_has_add = "Add group…" in person_items
    groups_ok = (after.get("groups") is not None and picked is not None
                 and new_path in after["groups"]
                 and all(g in after["groups"] for g in picked["groups"]))
    rows_ok = after.get("rows") == len(after.get("groups") or [])
    ok = (branch_found and branch_closed and no_add_on_branch and branch_keeps
          and root_menus == 0 and picked is not None and person_has_add
          and clicked and dlg.get("open") and typed and submitted
          and after.get("dialogGone") and groups_ok and rows_ok)
    record("C28 branch/root have no Add group…, person row adds a membership (#164)", ok,
           f"branch found={branch_found} closed={branch_closed} items={branch_items}; "
           f"root menus={root_menus}; person items has-add={person_has_add}; "
           f"dialog={dlg} typed={typed} submitted={submitted}; groups "
           f"{picked['groups'] if picked else None} → {after.get('groups')} "
           f"(kept + {new_path}: {groups_ok}); rows={after.get('rows')} "
           f"(want {len(after.get('groups') or [])}): {rows_ok}")


def c31_rolls_import_pane(t):
    """#167/#186 (§4.36): a real, not-yet-imported directory committed in
    the Rolls path filter (typed AND via browse…) opens the import pane in
    the right pane — DetailPane gone, the rolls tree still interactive —
    with the per-roll toggles MINUS --create-db (#186: a usable database
    exists in this flow, so the checkbox could only fail; the combo
    refusal now lives in C47's first-run pane where it is offered), start
    filling the stdout viewport from the polled mock status, and exit 0
    shown; a non-directory path keeps the plain #162 hint."""
    fresh(t)
    set_show_filter(t, "all")
    # seed one "real" directory holding 3 not-yet-imported images
    js(t, "window.__MOCK_ROLL_DIRS__ = {'/mnt/rolls/new-roll': 3};")
    js(t, "document.querySelectorAll('.topbar nav button')[1]?.click();")  # Rolls
    time.sleep(1.2)

    def set_path(v):
        js(t, r"""
          const el = document.querySelector('.roll-filter input');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, arguments[0]);
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
        """, v)
        time.sleep(0.6)

    # 1) a real directory → the import pane opens in the right pane
    set_path("/mnt/rolls/new-roll")
    pane = js(t, r"""
      const p = document.querySelector('.import-pane');
      if (!p) return {open: false};
      const labels = [...p.querySelectorAll('.import-opts label')];
      const toggles = labels.map(l => l.textContent.trim().split(/\s+/)[0]);
      return {
        open: true,
        detailGone: !document.querySelector('.dp-person'),
        dir: p.querySelector('.import-path')?.textContent ?? null,
        db: [...p.querySelectorAll('.import-path')][1]?.textContent ?? null,
        toggles,
        // #186: --create-db is GONE here — a usable database exists
        createDbAbsent: !labels.some(l => l.textContent.includes('--create-db')),
        // #169: --recursive starts CHECKED — the probe that opened the
        // pane found its images below the top level
        recursiveDefault: (() => {
          const l = labels.find(x => x.textContent.includes('--recursive'));
          return l ? l.querySelector('input[type=checkbox]').checked : null;
        })(),
        threshold: !!p.querySelector('.import-opts input[type=number]'),
        start: !![...p.querySelectorAll('button')].find(b => b.textContent.trim() === 'start'),
        stop: !![...p.querySelectorAll('button')].find(b => b.textContent.trim() === 'stop'),
        state: p.textContent.includes('idle'),
      };
    """)

    # 2) start → the stdout viewport fills from the polled status
    js(t, "[...document.querySelectorAll('.import-actions button')].find(b => b.textContent.trim() === 'start').click();")
    time.sleep(2.0)  # the mock streams 8 lines over ~1 s; the pane polls at 300 ms
    log = js(t, r"""
      const p = document.querySelector('.import-pane');
      const log = p.querySelector('.import-log');
      return {
        text: log?.textContent ?? '',
        // WebKit exposes only the prefixed -webkit-user-select (value
        // 'text' — the CSS applied); Firefox has the unprefixed one
        selectable: log ? (getComputedStyle(log).userSelect ??
                           getComputedStyle(log).webkitUserSelect ?? null) : null,
        state: [...p.querySelectorAll('.import-actions span')][0]?.textContent ?? null,
      };
    """)

    # 3) a non-directory path keeps the plain #162 hint (no pane opens);
    #    close the pane first (§4.36: only ✕ closes it)
    js(t, "[...document.querySelectorAll('.import-head button')].find(b => b.textContent.includes('✕'))?.click();")
    time.sleep(0.3)
    js(t, "document.querySelectorAll('.topbar nav button')[1]?.click();")  # re-render rolls
    time.sleep(0.8)
    set_path("/no/such/dir")
    after = js(t, r"""
      return {
        hint: document.querySelector('.roll-filter-hint')?.textContent ?? null,
        paneGone: !document.querySelector('.import-pane'),
      };
    """)

    exp_toggles = ["--dry-run", "--all", "--gpu", "--recursive", "--threshold"]  # #186: no --create-db
    ok = (
        pane.get("open") and pane.get("detailGone")
        and pane.get("dir") == "/mnt/rolls/new-roll"
        and pane.get("db") == "/mock/data/faces.db"
        and pane.get("toggles") == exp_toggles
        and pane.get("createDbAbsent")
        and pane.get("threshold") and pane.get("start") and pane.get("stop")
        and pane.get("recursiveDefault") is True
        and pane.get("state")
        and "WhoT import_roll" in log.get("text", "")
        and "done — imported 3 image(s)" in log.get("text", "")
        and log.get("selectable") == "text"
        and log.get("state") == "exit 0"
        and after.get("hint") is not None and "no images under" in after.get("hint", "")
        and after.get("paneGone")
    )
    record("C31 Rolls import pane: dir → pane in right pane, toggles (no --create-db #186), recursive default on, stdout viewport, exit 0 (#167/#169)",
           ok,
           f"pane={pane}; log state={log.get('state')!r} "
           f"selectable={log.get('selectable')!r} chars={len(log.get('text', ''))}; "
           f"non-dir hint={after.get('hint')!r} paneGone={after.get('paneGone')}")


def c32_full_image_follows_person(t):
    """#171 (§4.37): the right pane follows the full image —
    card double-click opens focus mode AND shows that card's person in
    the right pane (Overview → person); a rect click switches the pane
    to the rect's person while focus mode AND the Review tab stay put
    (selection toggles); the import pane (§4.36) keeps the right-pane
    slot through entry + rect click (anchor updates underneath — closing
    the pane reveals the rect's person); a NULL person_id (injected via
    a mock-snapshot mutation + focus-refresh) leaves the anchor as-is."""
    fresh(t)
    set_show_filter(t, "all")

    # pick a review card whose image also holds a non-rejected face of
    # ANOTHER person — one card drives all four phases
    pick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const byId = new Map(snap.faces.map(f => [f.id, f]));
      const pname = (pid) => snap.persons.find(p => p.id === pid)?.name ?? null;
      const cards = [...document.querySelectorAll('.face-card')]
        .map(c => Number(c.dataset.faceId));
      for (const cid of cards) {
        const f = byId.get(cid);
        if (!f || f.person_id == null) continue;
        const other = snap.faces.find(x =>
          x.image_id === f.image_id && x.id !== f.id &&
          x.person_id != null && x.person_id !== f.person_id &&
          x.link_status !== 'rejected');
        if (other) return {cardId: cid, cardPid: f.person_id, cardName: pname(f.person_id),
                           otherFace: other.id, otherPid: other.person_id,
                           otherName: pname(other.person_id)};
      }
      return null;
    """)
    if pick is None:
        record("C32 right pane follows the full image (#171/§4.37)", True,
               "need a card whose image holds two persons' faces — vacuous")
        return

    def right_name():
        return js(t, r"""
          const dp = document.querySelector('.dp-person');
          return dp ? (dp.querySelector('input')?.value ?? null) : null;
        """)

    def view_state():
        return js(t, r"""
          const active = document.querySelector('.topbar nav button.active');
          return {focus: !!document.querySelector('.focus-pane'),
                  importPane: !!document.querySelector('.import-pane'),
                  personPane: !!document.querySelector('.dp-person'),
                  overview: !!document.querySelector('.dp-summary'),
                  tab: (active?.textContent ?? '').trim().split(/\s+/)[0] ?? ''};
        """)

    # ── phase A: entry anchor + rect switch, both surfaces stay put ────
    before = view_state()
    # PRE-CLICK, then double-click: the first click on an UNSELECTED card
    # triggers the selection re-render, which at low compositing rates
    # stretches that click's down→up past ~900ms — WebKit then measures
    # down1→down2 beyond its ~500ms double-click window and never
    # synthesises dblclick (no focus mode). The pre-click absorbs the
    # re-render; both double-click clicks then land render-free.
    card = t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{pick['cardId']}']")
    js(t, "arguments[0].scrollIntoView({block:'center'})", card)
    time.sleep(0.3)
    card.click()
    time.sleep(0.6)
    card = t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{pick['cardId']}']")
    AC(t.driver).double_click(card).perform()
    time.sleep(0.8)
    entry = view_state()
    entry_name = right_name()

    rect = t.find_element(By.CSS_SELECTOR, f"[data-overlay-face='{pick['otherFace']}']")
    rect.click()
    time.sleep(0.6)
    after_rect = view_state()
    rect_name = right_name()
    rect_selected = js(t, r"""
      return document.querySelector(arguments[0])?.classList.contains('selected') ?? false;
    """, f"[data-overlay-face='{pick['otherFace']}']")

    # ── phase B: the import pane keeps the slot; anchor updates under it ─
    js(t, "window.__MOCK_ROLL_DIRS__ = {'/mnt/rolls/new-roll': 3};")
    js(t, "document.querySelectorAll('.topbar nav button')[1]?.click();")  # Rolls (closes focus)
    time.sleep(0.8)
    js(t, r"""
      const el = document.querySelector('.roll-filter input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '/mnt/rolls/new-roll');
      el.dispatchEvent(new Event('input', {bubbles: true}));
      el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    """)
    time.sleep(0.8)
    import_open = view_state()

    js(t, "document.querySelectorAll('.topbar nav button')[0]?.click();")  # Review
    time.sleep(0.8)
    card2 = t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{pick['cardId']}']")
    js(t, "arguments[0].scrollIntoView({block:'center'})", card2)
    time.sleep(0.3)
    card2.click()  # pre-click — same WebKit double-click-window fix as phase A
    time.sleep(0.6)
    card2 = t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{pick['cardId']}']")
    AC(t.driver).double_click(card2).perform()  # entry anchor updates UNDER the import pane
    time.sleep(0.8)
    under_entry = view_state()
    rect2 = t.find_element(By.CSS_SELECTOR, f"[data-overlay-face='{pick['otherFace']}']")
    rect2.click()  # rect anchor updates UNDER the import pane
    time.sleep(0.6)
    under_rect = view_state()
    # close the import pane → the anchor revealed underneath must be the RECT's person
    js(t, r"""
      [...document.querySelectorAll('.import-head button')]
        .find(b => b.textContent.includes('✕'))?.click();
    """)
    time.sleep(0.6)
    revealed = view_state()
    revealed_name = right_name()

    # ── phase C: NULL person_id leaves the anchor untouched ─────────────
    # f5 = the entry card's face (its person ≠ the current anchor),
    # person_id nulled + name stamped so the focus-refresh is observable
    js(t, r"""
      const f = window.__MOCK_SNAP.faces.find(x => x.id === arguments[0]);
      f.person_id = null;
      f.name = 'NULLGUARD';
      window.dispatchEvent(new Event('focus'));   // F12-style snapshot reload
    """, pick["cardId"])
    refreshed = False
    for _ in range(20):
        time.sleep(0.3)
        if js(t, r"""
          return [...document.querySelectorAll('.face-rect-label')]
            .some(x => x.textContent.trim() === 'NULLGUARD');
        """):
            refreshed = True
            break
    anchor_before_null = right_name()
    null_rect = t.find_element(By.CSS_SELECTOR, f"[data-overlay-face='{pick['cardId']}']")
    null_rect.click()
    time.sleep(0.6)
    after_null = view_state()
    after_null_name = right_name()

    ok = (
        before.get("overview") and not before.get("personPane")   # fresh = Overview
        and entry.get("focus") and entry.get("tab", "").startswith("Review")
        and entry_name == pick["cardName"]                          # entry anchor
        and after_rect.get("focus")                                 # view never left
        and after_rect.get("tab", "").startswith("Review")
        and rect_name == pick["otherName"]                          # rect switch
        and rect_selected                                            # toggle still works
        and import_open.get("importPane") and not import_open.get("personPane")
        and under_entry.get("focus") and under_entry.get("importPane")
        and under_rect.get("importPane") and not under_rect.get("personPane")
        and revealed.get("personPane") and not revealed.get("importPane")
        and revealed_name == pick["otherName"]                       # anchor under the pane
        and refreshed                                                 # mutation observable
        and after_null.get("personPane") and after_null_name == anchor_before_null
        and anchor_before_null == pick["otherName"]
    )
    record("C32 right pane follows the full image (#171/§4.37): entry, rect switch, import-pane slot, NULL guard",
           ok,
           f"entry: {before.get('overview')}→focus={entry.get('focus')} name={entry_name!r} "
           f"(want {pick['cardName']!r}); rect: name={rect_name!r} (want {pick['otherName']!r}) "
           f"focus={after_rect.get('focus')} tab={after_rect.get('tab')!r} selected={rect_selected}; "
           f"import slot: open={import_open.get('importPane')} under-entry={under_entry.get('importPane')} "
           f"under-rect={under_rect.get('importPane')} revealed={revealed_name!r}; "
           f"null guard: refreshed={refreshed} anchor {anchor_before_null!r}→{after_null_name!r}")


def c33_person_group_list_update(t):
    """#172/#173 (§4.38): the person pane's group list + Update person —
    the pane lists every membership; × stages a removal (the row leaves
    the staged display, the mock untouched) and Add group stages a new
    membership; the staged set commits via the Update person button
    (directly above Remove person) through move_persons_between_groups;
    a status-seat row is inert (× disabled); renaming the pane person to
    a KNOWN person re-anchors the pane on the merge target and lists ITS
    groups; the system person Rejected sees the list read-only with no
    Update button."""
    fresh(t)
    set_show_filter(t, "all")

    def rows():
        return js(t, r"""
          return [...document.querySelectorAll('.dp-groups .dp-group-row')].map(li => ({
            path: li.querySelector('.dp-group-path')?.textContent.trim() ?? '',
            seat: !!li.querySelector('.dp-group-path.seat'),
            xDisabled: li.querySelector('.dp-group-x')?.disabled ?? null,
            staged: li.classList.contains('staged'),
          }));
        """)

    def pane_name():
        return js(t, r"""
          return document.querySelector('.dp-person .typeahead input')?.value ?? null;
        """)

    def set_input(sel, value, enter=True):
        js(t, r"""
          const el = document.querySelector(arguments[0]);
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, arguments[1]);
          el.dispatchEvent(new Event('input', {bubbles: true}));
        """, sel, value)
        if enter:
            js(t, r"""
              document.querySelector(arguments[0])
                ?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
            """, sel)

    def wait_for(pred, tries=25):
        for _ in range(tries):
            time.sleep(0.3)
            if pred():
                return True
        return False

    def select_person(pid):
        row = t.find_element(By.CSS_SELECTOR, f".tree-person[data-person-id='{pid}']")
        js(t, "arguments[0].scrollIntoView({block:'center'})", row)
        time.sleep(0.3)
        row.click()
        time.sleep(0.8)

    # ── phase A: a multi-group person lists every membership ───────────
    pick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const m = snap.persons.find(p =>
        p.groups.length > 1 && !/^unknown/i.test(p.name) && p.name !== 'Rejected');
      return m ? {id: m.id, name: m.name, groups: [...m.groups]} : null;
    """)
    if pick is None:
        record("C33 group list + Update person (#172/#173, §4.38)", True,
               "need a multi-group person in the seed — vacuous")
        return
    select_person(pick["id"])
    phase_a = js(t, r"""
      const up = document.querySelector('.dp-update');
      const rm = document.querySelector('.dp-remove');
      return {pane: !!document.querySelector('.dp-person'),
              update: !!up, aboveRemove: up ? up.nextElementSibling === rm : null,
              remove: !!rm};
    """)
    listed = rows()

    # ── phase B: stage × + add, mock untouched until Update person ─────
    g0, g1 = pick["groups"][0], pick["groups"][1]
    x0 = t.find_element(By.CSS_SELECTOR, ".dp-groups .dp-group-row .dp-group-x")
    x0.click()
    time.sleep(0.5)
    after_x = rows()
    mock_after_x = js(t, r"""
      return window.__MOCK_SNAP.persons.find(p => p.id === arguments[0])?.groups ?? null;
    """, pick["id"])
    set_input(".dp-add-group .typeahead input", "Ck33|Sub", enter=False)
    time.sleep(0.3)
    add_btn = t.find_element(By.CSS_SELECTOR, ".dp-add-group .dp-add-btn")
    add_btn.click()
    time.sleep(0.5)
    after_add = rows()
    mock_after_add = js(t, r"""
      return window.__MOCK_SNAP.persons.find(p => p.id === arguments[0])?.groups ?? null;
    """, pick["id"])
    t.find_element(By.CSS_SELECTOR, ".dp-update").click()
    committed = wait_for(lambda: js(t, r"""
      const p = window.__MOCK_SNAP.persons.find(x => x.id === arguments[0]);
      return !!p && p.groups.includes('Ck33|Sub') && !p.groups.includes(arguments[1]);
    """, pick["id"], g0))
    mock_after = js(t, r"""
      return window.__MOCK_SNAP.persons.find(p => p.id === arguments[0])?.groups ?? null;
    """, pick["id"])
    staged_clear = wait_for(lambda: not any(r["staged"] for r in rows()))

    # ── phase C: a status-seat row is inert ────────────────────────────
    seat_pick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const p = snap.persons.find(x => /^unknown/i.test(x.name));
      return p ? {id: p.id, groups: [...p.groups]} : null;
    """)
    if seat_pick:
        select_person(seat_pick["id"])
        seat_rows = rows()
    else:
        seat_rows = None

    # ── phase D: rename to a KNOWN person re-anchors on the target ─────
    mpick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const named = snap.persons.filter(p => p.name !== 'Rejected' &&
        !/^unknown/i.test(p.name) && p.counts.total > 0);
      if (named.length < 2) return null;
      const [a, b] = named;
      return {srcId: a.id, srcName: a.name, srcTotal: a.counts.total,
              dstId: b.id, dstName: b.name, dstTotal: b.counts.total,
              dstGroups: [...b.groups]};
    """)
    merge_ok = None
    if mpick:
        select_person(mpick["srcId"])
        set_input(".dp-person .typeahead input", mpick["dstName"], enter=True)
        merge_ok = wait_for(lambda: js(t, r"""
          const snap = window.__MOCK_SNAP;
          return !snap.persons.some(p => p.id === arguments[0]) &&
                 (snap.persons.find(p => p.id === arguments[1])?.counts.total ?? 0)
                   === arguments[2] + arguments[3];
        """, mpick["srcId"], mpick["dstId"], mpick["srcTotal"], mpick["dstTotal"]))
        anchor = js(t, r"""
          return {name: document.querySelector('.dp-person .typeahead input')?.value ?? null,
                  groups: [...document.querySelectorAll('.dp-groups .dp-group-path')]
                    .map(x => x.textContent.trim())};
        """)
    else:
        anchor = None

    # ── phase E: the system person sees the list read-only ─────────────
    set_show_filter(t, "rejected")
    rej_id = js(t, r"""
      return window.__MOCK_SNAP.persons.find(p => p.name === 'Rejected')?.id ?? null;
    """)
    sys_ok = None
    if rej_id is not None and js(t, f"return !!document.querySelector(\".tree-person[data-person-id='{rej_id}']\")"):
        select_person(rej_id)
        sys_ok = js(t, r"""
          return !document.querySelector('.dp-update') &&
                 !document.querySelector('.dp-groups') &&
                 !!document.querySelector('.dp-person .dim');
        """)

    want_after = sorted([g for g in pick["groups"] if g != g0] + ["Ck33|Sub"])
    ok = (
        phase_a["pane"] and phase_a["update"] and phase_a["aboveRemove"] and phase_a["remove"]
        and [r["path"] for r in listed] == pick["groups"]           # every membership listed
        and all(not r["xDisabled"] for r in listed)                  # real rows removable
        and [r["path"] for r in after_x] == pick["groups"][1:]      # × stages: row leaves
        and mock_after_x == pick["groups"]                           # …mock untouched
        and [r["path"] for r in after_add] == pick["groups"][1:] + ["Ck33|Sub"]
        and after_add[-1]["staged"]                                 # add staged, styled
        and mock_after_add == pick["groups"]                         # …mock untouched
        and committed and sorted(mock_after or []) == want_after     # Update commits the set
        and staged_clear                                             # staging cleared after commit
        and seat_rows is not None and seat_rows
        and all(r["seat"] and r["xDisabled"] for r in seat_rows)     # seat rows inert
        and (merge_ok is not False and anchor is not None)
        and (mpick is None or (anchor["name"] == mpick["dstName"]
                               and anchor["groups"] == mpick["dstGroups"]))  # re-anchored
        and sys_ok is not False                                       # system person read-only
    )
    record("C33 group list + Update person (#172/#173, §4.38): stage ×/add, commit, seat inert, merge re-anchor, system read-only",
           ok,
           f"listed={[r['path'] for r in listed]} (want {pick['groups']}); "
           f"after×={[r['path'] for r in after_x]} mockUntouched={mock_after_x == pick['groups']}; "
           f"afterAdd={[r['path'] for r in after_add]} staged={after_add[-1]['staged'] if after_add else None}; "
           f"committed={committed} mock={mock_after} stagedClear={staged_clear}; "
           f"seat={seat_rows}; merge={merge_ok} anchor={anchor}; system={sys_ok}")


def c34_rolls_branch_thumbnails(t):
    """#174 (§4.39): Modes — the Rolls centre is a pure hierarchy and
    the right pane holds the SELECTED branch's images: a header click
    toggles AND selects; the thumbs are the branch's DIRECT images only
    (non-recursive), selection survives a mode round-trip and clears on
    a branch change, ctrl-click extends, the context menu Rotate is
    scoped and lands on both mock images (new mock rotate_image); a
    thumb double-click opens the image detail with the person detail
    back in the right pane (§4.37), '← rolls' returns with the branch's
    thumbs intact; a branch without direct images shows the drill hint."""
    fresh(t)
    set_show_filter(t, "all")
    js(t, "document.querySelectorAll('.topbar nav button')[1]?.click();")  # Rolls
    time.sleep(0.8)

    # ── target dirs: one WITH direct+deeper images, one WITHOUT direct
    pick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const dirOf = p => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
      const dirs = new Map();
      for (const im of snap.images) dirs.set(dirOf(im.primary_path), (dirs.get(dirOf(im.primary_path)) || 0) + 1);
      // the target: direct+deeper images, MOST direct thumbs (≥ 2 — the
      // ctrl-click phase needs two)
      let withKids = null, best = 1;
      // a branch with NO direct images but deeper ones (ancestor scan —
      // such a branch is never any image's own directory)
      let withoutDirect = null;
      const cand = new Set();
      for (const im of snap.images) {
        const d = dirOf(im.primary_path);
        const kids = snap.images.some(x => dirOf(x.primary_path) !== d && x.primary_path.startsWith(d + '/'));
        const n = dirs.get(d) || 0;
        if (kids && n > best) { best = n; withKids = d; }
        let p = d;
        while (p && p !== '/') { cand.add(p); p = dirOf(p); }
      }
      for (const P of cand) {
        const direct = snap.images.some(im => dirOf(im.primary_path) === P);
        const deeper = snap.images.some(im => im.primary_path.startsWith(P + '/'));
        if (!direct && deeper) { withoutDirect = P; break; }
      }
      return {withKids, withoutDirect};
    """)

    def drill(path):
        """open every ancestor (click only when closed) and ALWAYS click
        the LAST segment — a click toggles AND selects (#174), so an
        already-open target still gets selected (and, yes, collapsed —
        the right pane reads the state, not the open set)"""
        segs = [s for s in path.strip('/').split('/') if s]
        for i, seg in enumerate(segs):
            last = i == len(segs) - 1
            state = js(t, r"""
              const prefix = arguments[0], seg = arguments[1], last = arguments[2];
              let container = document.querySelector('.rolls');
              for (const p of prefix) {
                const s = [...container.children].find(x => x.classList.contains('roll') &&
                  x.querySelector(':scope > .roll-header .roll-path')?.textContent.trim() === p);
                if (!s) return 'no-parent';
                container = s.querySelector(':scope > .roll-children');
                if (!container) return 'closed-parent';
              }
              const target = [...container.children].find(x => x.classList.contains('roll') &&
                x.querySelector(':scope > .roll-header .roll-path')?.textContent.trim() === seg);
              if (!target) return 'not-found';
              const isOpen = !!target.querySelector(':scope > .roll-children');
              if (last || !isOpen) target.querySelector(':scope > .roll-header').click();
              return 'ok';
            """, segs[:i], seg, last)
            time.sleep(0.6)
            if state != "ok":
                return False
        return True

    def pane_state():
        return js(t, r"""
          const thumbs = [...document.querySelectorAll('.rolls-thumbs .img-thumb')];
          return {
            thumbs: thumbs.map(b => b.title),
            selected: document.querySelectorAll('.img-thumb.selected').length,
            head: document.querySelector('.rolls-thumbs-head')?.textContent ?? null,
            hint: document.querySelector('.rolls-thumbs-empty')?.textContent ?? null,
            centerGrids: document.querySelectorAll('.rolls .img-grid').length,
            centerThumbs: document.querySelectorAll('.rolls .img-thumb').length,
            selHdr: document.querySelector('.roll-header.selected .roll-path')?.textContent.trim() ?? null,
            selCounts: document.querySelector('.roll-header.selected .roll-counts')?.textContent.trim() ?? null,
            detail: !!document.querySelector('.image-detail'),
            dp: !!document.querySelector('.dp-person') || !!document.querySelector('.dp-summary'),
          };
        """)

    if pick is None or pick["withKids"] is None:
        record("C34 Modes — Rolls branch thumbnails (#174/§4.39)", True,
               "need a branch with direct + deeper images — vacuous")
        return

    # ── phase A: the centre is a pure hierarchy ────────────────────────
    a = pane_state()

    # ── phase B: drill to the target — direct images only in the pane ─
    drilled = drill(pick["withKids"])
    b = pane_state()
    base = pick["withKids"].rstrip('/').split('/')[-1]
    direct = [i for i in js(t, "return window.__MOCK_SNAP.images.map(x => x.primary_path)")
              if os.path.dirname(i) == pick["withKids"]]
    rollup_n = int(b["selCounts"].split()[0]) if b["selCounts"] else -1

    # ── mode round-trip: the branch selection is session state ────────
    js(t, "document.querySelectorAll('.topbar nav button')[0]?.click();")  # Review
    time.sleep(0.8)
    # #188/§4.40: entering Review re-pins Show → New (an async settings
    # write) — this check's baseline is Show → All (harness dispatch
    # through the disabled select) or the thumbs prune to the pending
    # images only. Wait for the pin to LAND first: dispatching 'all'
    # while it is in flight early-returns (settings still read 'all')
    # and the pin then wins the race.
    pin_deadline = time.time() + 5
    while time.time() < pin_deadline:
        if js(t, "return document.querySelector('.topbar-right select')?.value") == "provisional":
            break
        time.sleep(0.2)
    set_show_filter(t, "all")
    settle = time.time() + 5
    while time.time() < settle:
        if js(t, "return document.querySelector('.topbar-right select')?.value") == "all":
            break
        time.sleep(0.2)
    js(t, "document.querySelectorAll('.topbar nav button')[1]?.click();")  # Rolls
    time.sleep(0.8)
    after_trip = pane_state()

    # ── phase C: selection (click, ctrl-click) + scoped Rotate ────────
    def thumb(i):
        return t.find_elements(By.CSS_SELECTOR, ".rolls-thumbs .img-thumb")[i]
    thumb(0).click()
    time.sleep(0.4)
    sel_one = pane_state()["selected"]
    t2 = thumb(1)
    AC(t.driver).key_down(Keys.CONTROL).click(t2).key_up(Keys.CONTROL).perform()
    time.sleep(0.4)
    c = pane_state()
    two_ids = js(t, r"""
      return [...document.querySelectorAll('.rolls-thumbs .img-thumb.selected')]
        .map(b => window.__MOCK_SNAP.images.find(x => x.primary_path === b.title)?.id);
    """)
    AC(t.driver).context_click(t2).perform()
    time.sleep(0.6)
    rot_items = [b for b in t.find_elements(By.CSS_SELECTOR, ".ctx-item")
                 if "Rotate 90° CW" in b.text]
    rotated_ok = False
    if rot_items:
        rot_items[0].click()
        time.sleep(1.2)
        rotated_ok = js(t, r"""
          const [a, b] = arguments[0];
          return window.__MOCK_SNAP.images
            .filter(x => x.id === a || x.id === b)
            .every(x => x.rotation === 90);
        """, two_ids)

    # ── phase D: a DIFFERENT branch clears the selection, and its
    #    drill hint (the branch has no direct images) ──────────────────
    # (drilling to a non-ancestor-of-target path keeps the opened
    # ancestors intact for the re-drill below; the last segment is
    # always clicked — toggle + select)
    d = None
    f_hint = None
    if pick["withoutDirect"]:
        drilled_alt = drill(pick["withoutDirect"])
        d = pane_state() if drilled_alt else None
        f_hint = d["hint"] if d else None

    # ── back to the target for the open round-trip ─────────────────────
    re_drilled = drill(pick["withKids"])
    # ── phase E: double-click opens; person detail returns; ← rolls ────
    e1 = pane_state()
    tgt = thumb(0)
    js(t, "arguments[0].scrollIntoView({block:'center'})", tgt)
    time.sleep(0.3)
    tgt.click()  # pre-click: absorb the selection re-render (WebKit dblclick window)
    time.sleep(0.5)
    tgt = thumb(0)
    AC(t.driver).double_click(tgt).perform()
    time.sleep(1.0)
    e2 = pane_state()
    back = t.find_element(By.CSS_SELECTOR, ".image-detail-top button")
    back.click()
    time.sleep(0.8)
    e3 = pane_state()

    ok = (
        a["centerGrids"] == 0 and a["centerThumbs"] == 0            # centre pure
        and drilled and b["selHdr"] == base                          # branch selected
        and len(b["thumbs"]) == len(direct) > 0                      # direct children…
        and rollup_n > len(direct)                                   # …≠ the rollup (non-recursive)
        and all(os.path.dirname(p) == pick["withKids"] for p in b["thumbs"])
        and after_trip["thumbs"] == b["thumbs"]                      # survives a mode round-trip
        and sel_one == 1                                             # click selects one
        and c["selected"] == 2 and "2 selected" in (c["head"] or "")  # ctrl-click extends
        and rotated_ok                                                # scoped Rotate landed
        and (d is None or d["selected"] == 0)                         # branch change clears
        and (f_hint is None or "no images directly at this path" in f_hint)
        and re_drilled
        and e1["thumbs"] and e2["detail"] and e2["dp"]               # dblclick → detail + person pane
        and not e2["thumbs"]
        and not e3["detail"] and e3["thumbs"] == e1["thumbs"]         # ← rolls: back, intact
    )
    record("C34 Modes — Rolls branch thumbnails (#174/§4.39): pure hierarchy, direct-only thumbs, selection lifecycle, scoped rotate, open round-trip, drill hint",
           ok,
           f"centre grids/thumbs={a['centerGrids']}/{a['centerThumbs']}; "
           f"drill={drilled} sel={b['selHdr']!r} (want {base!r}) thumbs={len(b['thumbs'])} "
           f"direct={len(direct)} rollup={rollup_n} head={b['head']!r}; "
           f"roundtrip={after_trip['thumbs'] == b['thumbs']}; select 1→{sel_one} ctrl→{c['selected']} "
           f"head={c['head']!r} rotate={rotated_ok} ids={two_ids}; "
           f"parent-clear={d and d['selected']} alt={pick['withoutDirect']!r} hint={f_hint!r} "
           f"re-drill={re_drilled}; "
           f"open: detail={e2['detail']} dp={e2['dp']} thumbs={e2['thumbs'] and len(e2['thumbs'])}; "
           f"back: detail={e3['detail']} thumbs={len(e3['thumbs'])}")


def c35_rolls_layout(t):
    """#174 follow-up (§4.39): browsing Rolls gives the centre an
    explicit width that starts at the LEFT pane's width (the right pane
    flexes — most of the window for the thumbnails); the centre|right
    divider drags the centre clamped to 10%..70% of the window (never
    past window − left − 200px), double-click restores the left-
    following default, and opening an image restores the normal layout
    (right pane back to its fixed width)."""
    fresh(t)
    set_show_filter(t, "all")
    js(t, "document.querySelectorAll('.topbar nav button')[1]?.click();")  # Rolls
    time.sleep(1.0)

    def widths():
        return js(t, r"""
          const c = document.querySelector('main.center');
          const l = document.querySelector('aside.left');
          const r = document.querySelector('aside.right');
          return {w: window.innerWidth, center: c.offsetWidth,
                  left: l.offsetWidth, right: r.offsetWidth};
        """)

    def drag_divider(dx):
        """synthetic drag of the centre|right divider: mousedown on it,
        twelve window-level mousemoves (the app listens on window),
        mouseup — deterministic and independent of the viewport"""
        js(t, r"""
          const el = document.querySelector('main.center + .v-divider');
          const rect = el.getBoundingClientRect();
          const x0 = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          el.dispatchEvent(new MouseEvent('mousedown', {clientX: x0, clientY: y, bubbles: true}));
          const steps = 12, d = arguments[0];
          for (let i = 1; i <= steps; i++)
            window.dispatchEvent(new MouseEvent('mousemove',
              {clientX: x0 + (d * i) / steps, clientY: y, bubbles: true}));
          window.dispatchEvent(new MouseEvent('mouseup', {clientX: x0 + d, clientY: y, bubbles: true}));
        """, dx)
        time.sleep(0.5)

    w0 = widths()
    # round-half-up like the app's Math.round (Python round is banker's)
    rnd = lambda x: int(x + 0.5)
    exp_lo = rnd(w0["w"] * 0.1)
    exp_hi = max(min(rnd(w0["w"] * 0.7), w0["w"] - w0["left"] - 200), exp_lo)
    initial_ok = abs(w0["center"] - w0["left"]) <= 2 and w0["right"] > w0["center"]

    div = t.find_element(By.CSS_SELECTOR, "main.center + .v-divider")
    # ── floor: drag the divider far LEFT → the centre shrinks to 10% ──
    drag_divider(-w0["w"])
    floor = widths()
    floor_ok = abs(floor["center"] - exp_lo) <= 2
    # ── cap: drag far RIGHT → min(70%, window − left − 200) ───────────
    drag_divider(2 * w0["w"])
    cap = widths()
    cap_ok = abs(cap["center"] - exp_hi) <= 2 and cap["right"] >= 190
    # ── double-click: back to the left-following default ──────────────
    AC(t.driver).double_click(div).perform()
    time.sleep(0.5)
    reset = widths()
    reset_ok = abs(reset["center"] - reset["left"]) <= 2 and reset["right"] > reset["center"]

    # ── an open image restores the normal layout (right = fixed 290) ──
    img = js(t, "return window.__MOCK_SNAP.images[0].primary_path")
    js(t, r"""
      const el = document.querySelector('.roll-filter input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, arguments[0]);
      el.dispatchEvent(new Event('input', {bubbles: true}));
      el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    """, img)
    time.sleep(1.2)
    opened = widths()
    detail = js(t, "return !!document.querySelector('.image-detail')")
    # centre flexes again: window − left − right − the two 1px dividers
    restored_ok = (detail and abs(opened["right"] - 290) <= 2
                   and abs(opened["center"] - (opened["w"] - opened["left"] - 290 - 2)) <= 6)

    ok = initial_ok and floor_ok and cap_ok and reset_ok and restored_ok
    record("C35 Rolls layout while browsing (#174/§4.39): centre = left pane, divider drags the centre 10–70%, dbl-click resets, an open image restores the normal layout",
           ok,
           f"win={w0['w']} initial c/l/r={w0['center']}/{w0['left']}/{w0['right']} "
           f"(centre==left: {initial_ok}); floor {floor['center']} (want {exp_lo}): {floor_ok}; "
           f"cap {cap['center']} (want {exp_hi}, right {cap['right']} ≥ 190): {cap_ok}; "
           f"reset c/l={reset['center']}/{reset['left']}: {reset_ok}; "
           f"opened: detail={detail} c/l/r={opened['center']}/{opened['left']}/{opened['right']} "
           f"(right≈290, centre≈{opened['w'] - opened['left'] - 290 - 2}): {restored_ok}")


def c36_review_lock(t):
    """#175 rewritten by #188 (§4.40): the lock IS the Review mode —
    the padlock beside Show is a pure INDICATOR (a span, never
    clickable): 🔒 + Show disabled exactly while Review is active.
    Entering Review pins Show → New through the ordinary filter path
    and runs the position guard (an anchored person without a new face
    advances to the next one that has any); leaving via the
    Rolls/Person tab re-enables the select with its VALUE kept (no
    forced Show → All, no forced mode, no release action — the padlock
    ignores clicks in either state); and with the session lock gone a
    verdict made OUTSIDE Review never advances the context and never
    closes the focus split (the #175 any-view mark is dead — the old
    check asserted exactly the opposite while locked)."""
    fresh(t)   # Show → All baseline (fresh forces it after the load pin)

    def lock_state():
        return js(t, r"""
          const b = document.querySelector('.lock-btn');
          const s = document.querySelector('.topbar-right select');
          return {btn: !!b, isSpan: !!b && b.tagName === 'SPAN',
                  isButton: !!document.querySelector('button.lock-btn'),
                  latched: !!b && b.classList.contains('locked'),
                  pressed: b?.getAttribute('aria-pressed') ?? null,
                  disabled: s?.disabled ?? null, value: s?.value ?? null,
                  labelTitle: document.querySelector('.topbar-right label')?.getAttribute('title') ?? '',
                  padlockTitle: b?.getAttribute('title') ?? '',
                  selected: document.querySelector('.tree-person.selected')
                    ? Number(document.querySelector('.tree-person.selected').dataset.personId)
                    : null,
                  focus: !!document.querySelector('.focus-pane'),
                  tab: (document.querySelector('.topbar nav button.active')?.textContent ?? '')
                    .trim().split(/\s+/)[0] ?? ''};
        """)

    def click_tab(name):
        [b for b in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
         if name in b.text][0].click()
        time.sleep(1.0)

    # ── phase 1: in Review (the load) — indicator + disabled, a span
    #    (not a button), no aria-pressed, rule-worded tooltips, and the
    #    harness's Show → All baseline intact ──────────────────────────
    p1 = lock_state()
    p1_ok = (p1["btn"] and p1["isSpan"] and not p1["isButton"]
             and p1["latched"] and p1["pressed"] is None
             and p1["disabled"] and p1["value"] == "all"
             and p1["tab"].startswith("Review")
             and "Locked to New while Review is active" in p1["labelTitle"]
             and "locked to New while Review is active" in p1["padlockTitle"])

    # ── phase 2: exit via Rolls keeps the value; the padlock ignores
    #    clicks (there is no engage/release any more) ─────────────────
    set_show_filter(t, "confirmed")   # harness dispatch — a real user can't
    click_tab("Rolls")
    p2 = lock_state()
    t.find_element(By.CSS_SELECTOR, ".lock-btn").click()
    time.sleep(0.8)
    p2_after = lock_state()
    p2_ok = (p2["tab"].startswith("Rolls") and not p2["disabled"]
             and p2["value"] == "confirmed"                    # value KEPT on exit
             and not p2["latched"]
             and "unlocked outside Review" in p2["padlockTitle"]
             and p2_after["tab"].startswith("Rolls")           # the click did nothing
             and not p2_after["latched"] and not p2_after["disabled"]
             and p2_after["value"] == "confirmed")

    # ── phase 3: enter Review — pins New + disabled + locked, and the
    #    position guard advances off a fully-reviewed anchor ──────────
    pick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const done = snap.persons.find(p => p.name !== 'Rejected' &&
        !/^unknown/i.test(p.name) && p.counts.total > 0 && p.counts.provisional === 0
        && p.counts.confirmed > 0);
      const two = snap.persons.find(p => p.name !== 'Rejected' &&
        !/^unknown/i.test(p.name) && p.counts.provisional >= 2);
      const twoFid = two ? snap.faces.find(f =>
        f.person_id === two.id && f.link_status === 'provisional')?.id ?? null : null;
      return done && two && twoFid != null
        ? {doneId: done.id, twoId: two.id, twoFid: twoFid} : null;
    """)
    if pick is None:
        record("C36 the Review lock (#175/§4.40, rewritten #188): indicator span, pin+guard on entry, value kept on exit, no any-view advance",
               p1_ok and p2_ok,
               f"need a fully-reviewed person + a person with ≥2 new faces — vacuous; p1={p1} p2={p2}")
        return
    t.find_element(By.CSS_SELECTOR, f".tree-person[data-person-id='{pick['doneId']}']").click()
    time.sleep(0.8)
    click_tab("Review")
    p3 = lock_state()
    landed = js(t, r"""
      const el = document.querySelector('.tree-person.selected');
      const id = el ? Number(el.dataset.personId) : null;
      const p = id == null ? null : window.__MOCK_SNAP.persons.find(x => x.id === id);
      return {id, hasNew: p ? p.counts.provisional > 0 : false};
    """)
    p3_ok = (p3["tab"].startswith("Review") and p3["disabled"] and p3["latched"]
             and p3["value"] == "provisional"                 # pinned New on entry
             and landed["id"] not in (None, pick["doneId"])    # position guard
             and landed["hasNew"])

    # ── phase 4: while locked the indicator still ignores clicks ─────
    t.find_element(By.CSS_SELECTOR, ".lock-btn").click()
    time.sleep(0.8)
    p4 = lock_state()
    p4_ok = (p4["tab"].startswith("Review") and p4["disabled"] and p4["latched"]
             and p4["value"] == "provisional")

    # ── phase 5/6: exit via Person (value kept again); a verdict made
    #    OUTSIDE Review — person view with the focus split open — must
    #    NOT advance the context and NOT close the focus: the #175
    #    any-view mark died with the session lock ─────────────────────
    click_tab("Person")
    p5 = lock_state()
    t.find_element(By.CSS_SELECTOR, f".tree-person[data-person-id='{pick['twoId']}']").click()
    time.sleep(0.8)
    # open focus on EXACTLY the new face targeted below (the roll lists
    # every face of THAT image)
    card = t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{pick['twoFid']}']")
    js(t, "arguments[0].scrollIntoView({block:'center'})", card)
    time.sleep(0.3)
    card.click()          # pre-click: absorb the selection re-render
    time.sleep(0.5)
    card = t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{pick['twoFid']}']")
    AC(t.driver).double_click(card).perform()
    time.sleep(1.0)
    focus_before = lock_state()
    fcard = t.find_element(
        By.CSS_SELECTOR, f".focus-pane .face-card[data-face-id='{pick['twoFid']}']")
    js(t, "arguments[0].scrollIntoView({block:'center'})", fcard)
    time.sleep(0.3)
    fcard.click()
    time.sleep(0.5)
    accept = [b for b in t.find_elements(By.CSS_SELECTOR, ".rulebar button")
              if "Accept" in b.text and b.is_enabled()]
    accepted = bool(accept)
    if accept:
        accept[0].click()
        time.sleep(1.5)
    p6 = lock_state()
    two_prov = js(t, r"""
      return window.__MOCK_SNAP.faces.filter(
        f => f.person_id === Number(arguments[0]) && f.link_status === 'provisional').length;
    """, pick["twoId"])
    p56_ok = (p5["tab"].startswith("Person") and not p5["disabled"]
              and p5["value"] == "provisional"               # value kept (2nd exit)
              and not p5["latched"]
              and accepted
              and focus_before["focus"]                      # focus opened
              and p6["focus"]                                # …and STAYS open (#175 gone)
              and p6["tab"].startswith("Person")             # no hand-over anywhere
              and p6["selected"] == pick["twoId"]            # anchor unchanged
              and two_prov >= 1)                             # partial: two had ≥2

    ok = p1_ok and p2_ok and p3_ok and p4_ok and p56_ok
    record("C36 the Review lock (#175/§4.40, rewritten #188): indicator span, pin+guard on entry, value kept on exit, no any-view advance",
           ok,
           f"1(load): span={p1['isSpan']} btn={p1['isButton']} locked={p1['latched']} "
           f"disabled={p1['disabled']} value={p1['value']!r}; "
           f"2(exit→Rolls): value={p2['value']!r} enabled={not p2['disabled']} "
           f"lock={p2['latched']} clickNoOp={p2_after['tab']}/{p2_after['latched']}; "
           f"3(entry): value={p3['value']!r} disabled={p3['disabled']} "
           f"guard {pick['doneId']}→{landed}; "
           f"4(locked click): {p4['tab']}/{p4['value']!r}/{p4['latched']}; "
           f"5/6(→Person, verdict outside Review): kept={p5['value']!r} "
           f"accepted={accepted} focus {focus_before['focus']}→{p6['focus']} "
           f"tab={p6['tab']!r} sel={p6['selected']} (want {pick['twoId']}) twoProv={two_prov}")


def status_totals(t):
    """ground truth: DB-wide status totals over the whole mock snapshot
       (#179 — what the top bar's chips must read)"""
    return js(t, r"""
      const out = {provisional: 0, confirmed: 0, rejected: 0};
      for (const f of window.__MOCK_SNAP.faces) {
        if (f.link_status in out) out[f.link_status]++;
      }
      return out;
    """)


def topbar_totals(t):
    """the rendered top-bar status chips (#179) — null when absent"""
    return js(t, r"""
      const c = document.querySelector('.status-counts');
      return c ? {title: c.getAttribute('title') ?? '',
                  n: c.querySelector('.c-prov')?.textContent.trim() ?? '',
                  a: c.querySelector('.c-conf')?.textContent.trim() ?? '',
                  r: c.querySelector('.c-rej')?.textContent.trim() ?? ''} : null;
    """)


def chip_texts(total):
    """the chip strings a set of status totals must render as"""
    return (f"? {total['provisional']}",
            f"✓ {total['confirmed']}",
            f"✗ {total['rejected']}")


def c37_person_sticky_colors(t):
    """#176 (§4.41): the Person tab is clickable without an anchor (the
    single-Close pointer dialog + Show → All); a Show change that hides
    every face of the anchored person opens 'No new faces' (Show All /
    Close); the top bar shows the DB-WIDE status totals (#179 — anchored
    or not they read the whole database, never just the person); and
    the status colour scheme is ONE colour everywhere — select closed
    value, count chips and tree status branches resolve to the same rgb
    per status (New red, Accepted green, Rejected gray; All = normal)."""
    fresh(t)
    set_show_filter(t, "all")

    def dialog():
        return js(t, r"""
          const d = document.querySelector('.overlay .dialog');
          if (!d) return null;
          return {title: d.querySelector('h3')?.textContent.trim() ?? '',
                  buttons: [...d.querySelectorAll('button')].map(b => b.textContent.trim())};
        """)

    def show_select():
        return js(t, "return document.querySelector('.topbar-right select')?.value ?? null;")

    def set_show(value):
        js(t, r"""
          const el = document.querySelector('.topbar-right select');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(el, arguments[0]);
          el.dispatchEvent(new Event('change', {bubbles: true}));
        """, value)
        time.sleep(1.0)

    def tab_active():
        return js(t, r"return (document.querySelector('.topbar nav button.active')?.textContent ?? '').trim().split(/\s+/)[0] ?? '';")

    # ── phase 1: the Person tab without an anchor ────────────────────
    person_btn = [b for b in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
                  if "Person" in b.text][0]
    not_disabled = js(t, """
      const b = [...document.querySelectorAll('.topbar nav button')]
        .find(x => x.textContent.includes('Person'));
      return b ? !b.disabled : false;
    """)
    person_btn.click()
    time.sleep(1.0)
    d1 = dialog()
    p1 = {"show": show_select(), "tab": tab_active()}
    close1 = [b for b in t.find_elements(By.CSS_SELECTOR, ".overlay .dialog button")
              if b.text.strip() == "Close"]
    if close1:
        close1[0].click()
        time.sleep(0.6)
    d1_gone = dialog() is None

    # ── phase 2: anchor a person WITHOUT new faces; Show → New ────────
    pick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const p = snap.persons.find(x => x.name !== 'Rejected' &&
        !/^unknown/i.test(x.name) && x.counts.total > 0 && x.counts.provisional === 0
        && x.counts.confirmed > 0);
      return p ? {id: p.id, counts: {...p.counts}} : null;
    """)
    if pick is None:
        record("C37 Person stickiness + status colours (#176/§4.41)", True,
               "need a fully-reviewed person — vacuous")
        return
    t.find_element(By.CSS_SELECTOR, f".tree-person[data-person-id='{pick['id']}']").click()
    time.sleep(0.8)
    set_show("provisional")
    d2 = dialog()
    show_all = [b for b in t.find_elements(By.CSS_SELECTOR, ".overlay .dialog button")
                if b.text.strip() == "Show All"]
    if show_all:
        show_all[0].click()
        time.sleep(1.0)
    d2_gone = dialog() is None

    # ── phase 3: the top-bar totals are DB-wide (#179) even while a
    #    person is anchored — they must ignore the anchor ─────────────
    counts = topbar_totals(t)
    want = status_totals(t)
    counts_ok = (counts is not None
                 and (counts['n'], counts['a'], counts['r']) == chip_texts(want)
                 and counts['title'] == "totals in the database")

    # ── phase 4: one colour scheme everywhere ────────────────────────
    def rgb(sel):
        return js(t, r"""
          const el = document.querySelector(arguments[0]);
          return el ? getComputedStyle(el).color : null;
        """, sel)

    set_show("provisional")  # dismissed in phase 2 for this pair — no dialog
    new_rgb = {"select": rgb(".topbar-right select"),
               "chip": rgb(".status-counts .c-prov"),
               "branch": rgb(".tree-node.status-new .tree-node-name")}
    set_show("confirmed")
    ok_rgb = {"select": rgb(".topbar-right select"),
              "chip": rgb(".status-counts .c-conf"),
              "branch": rgb(".tree-node.status-accepted .tree-node-name")}
    set_show("rejected")
    # the anchored person may hold no rejected face — the guard dialog
    # can pop here; it does not affect computed styles behind the overlay
    rej_rgb = {"select": rgb(".topbar-right select"),
               "chip": rgb(".status-counts .c-rej"),
               "branch": rgb(".tree-node.status-rejected .tree-node-name")}
    set_show("all")
    all_rgb = rgb(".topbar-right select")
    normal_rgb = rgb("body")  # All = the default text colour (--text)

    def same(d):
        vals = [v for v in d.values() if v]
        return len(vals) == 3 and len(set(vals)) == 1

    colors_ok = (same(new_rgb) and same(ok_rgb) and same(rej_rgb)
                 and len({new_rgb["chip"], ok_rgb["chip"], rej_rgb["chip"]}) == 3  # distinct
                 and all_rgb == normal_rgb)                                        # All = normal text

    ok = (not_disabled
          and d1 is not None and "Please select a person" in d1["title"]
          and d1["buttons"] == ["Close"]                       # single Close button
          and p1["show"] == "all" and p1["tab"].startswith("Person")
          and d1_gone
          and d2 is not None and d2["title"] == "No new faces"
          and sorted(d2["buttons"]) == ["Close", "Show All"]
          and show_all and d2_gone and show_select() == "all"
          and counts_ok and colors_ok)
    record("C37 Person stickiness + status colours (#176/§4.41): no-anchor dialog + Show All, 'No new faces' guard, top-bar DB totals (#179), one colour scheme",
           ok,
           f"tab enabled={not_disabled}; dialog1={d1} show={p1['show']} tab={p1['tab']!r} closed={d1_gone}; "
           f"dialog2={d2} closed={d2_gone} show={show_select()!r}; counts={counts} (want ? {want['provisional']} ✓ {want['confirmed']} ✗ {want['rejected']}); "
           f"rgb new={new_rgb} ok={ok_rgb} rej={rej_rgb} all={all_rgb} vs normal={normal_rgb}")


def c38_verdict_icons(t):
    """#177 (§4.42): the verdict icon shortcuts — the card's ✓ accepts
    ONE card as-is (the §4.14 card scope: only that face flips in the
    mock), the cluster header's ✓/✗ verdict the WHOLE group (every face
    of the section confirms / rejects), and the bottom bar's selection
    shortcuts carry the icons (✓ Accept / ✗ Reject, semantics
    unchanged — C30 covers the bar behaviour)."""
    fresh(t)
    set_show_filter(t, "all")

    def sections():
        return js(t, r"""
          return [...document.querySelectorAll('.face-section')].map(s => ({
            key: s.dataset.sectionKey ?? '',
            prov: [...s.querySelectorAll('.face-card.status-provisional')]
              .map(c => Number(c.dataset.faceId)),
            all: [...s.querySelectorAll('.face-card')].map(c => Number(c.dataset.faceId)),
          }));
        """)

    def statuses(ids):
        return js(t, r"""
          const want = new Set(arguments[0]);
          return window.__MOCK_SNAP.faces
            .filter(f => want.has(f.id))
            .map(f => `${f.id}:${f.link_status}`);
        """, ids)

    secs = sections()
    a = next((s for s in secs if len(s["prov"]) >= 2), None)
    b = next((s for s in secs if s is not a and len(s["prov"]) >= 1), None)
    if a is None or b is None:
        record("C38 verdict icon shortcuts (#177/§4.42)", True,
               "need two sections holding provisional faces — vacuous")
        return

    # ── the card tick: ONE card, as-is (§4.14 card scope) ────────────
    one = a["prov"][0]
    t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{one}'] .card-accept").click()
    time.sleep(1.2)
    one_ok = statuses([one]) == [f"{one}:confirmed"]
    rest_still = all(s.endswith(":provisional")
                     for s in statuses([i for i in a["prov"][1:]]))

    # ── the cluster header ✓: the whole group ───────────────────────
    t.find_element(By.CSS_SELECTOR,
                   f".face-section[data-section-key='{a['key']}'] .sec-accept").click()
    time.sleep(1.5)
    group_ok = all(s.endswith(":confirmed") for s in statuses(a["prov"]))

    # #189/§4.41: the tick + section ✓ can DRAIN a's person — the anchor
    # now follows the verdict, so §4.30's hand-over fires and lands in
    # Person mode (the design's #125 flow). The ✗ below needs the review
    # grid, so re-enter Review first (a no-op when no hand-over ran).
    [b for b in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
     if "Review" in b.text][0].click()
    time.sleep(1.0)

    # ── and ✗: the whole other group ─────────────────────────────────
    t.find_element(By.CSS_SELECTOR,
                   f".face-section[data-section-key='{b['key']}'] .sec-reject").click()
    time.sleep(1.5)
    reject_ok = all(s.endswith(":rejected") for s in statuses(b["prov"]))

    # ── the bar carries the icons ────────────────────────────────────
    js(t, "arguments[0].scrollIntoView({block:'center'})",
       t.find_element(By.CSS_SELECTOR, ".face-card"))
    t.find_element(By.CSS_SELECTOR, ".face-card").click()
    time.sleep(0.5)
    bar = js(t, r"""
      const btn = (cls) => [...document.querySelectorAll(`.rulebar button.${cls}`)]
        .map(b => b.textContent.trim());
      return {ok: btn('ok'), bad: btn('bad')};
    """)
    bar_ok = bar["ok"] == ["✓ Accept"] and bar["bad"] == ["✗ Reject"]

    ok = one_ok and rest_still and group_ok and reject_ok and bar_ok
    record("C38 verdict icon shortcuts (#177/§4.42): card tick = one card as-is, cluster ✓/✗ = the whole group, bar icons",
           ok,
           f"card {one} → {statuses([one])} (others still provisional: {rest_still}); "
           f"group {a['key']} ✓ → confirmed={group_ok}; group {b['key']} ✗ → rejected={reject_ok}; bar={bar}")


def c39_rename_seated_person(t):
    """#178 (§4.1): a status seat never reaches assign_person. Phase A:
    an unfiled UnknownN (seat New) renamed through the pane's Update
    person to a NEW name — no 'reserved group name' error, the id and
    the pane anchor survive, the claim confirms the faces and the seat
    derives to Accepted (§4.35). Phase B: a seated person renamed to a
    KNOWN name — a clean merge, with the pane re-anchored on the target
    listing ITS groups (§4.38). Phase C: merging another person INTO
    the phase-A product (a named person holding only a seat) succeeds
    and leaves its group untouched (F2 — the merge callers pass "")."""
    fresh(t)
    set_show_filter(t, "all")

    def wait_for(pred, tries=30):
        for _ in range(tries):
            time.sleep(0.3)
            if pred():
                return True
        return False

    def err():
        return js(t, r"""return document.querySelector('.toast[role="alert"] .toast-text')?.textContent ?? null""")

    def set_name(value, enter=True):
        # the pane's Name field (the first .typeahead input in .dp-person)
        js(t, r"""
          const el = document.querySelector('.dp-person .typeahead input');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, arguments[0]);
          el.dispatchEvent(new Event('input', {bubbles: true}));
        """, value)
        if enter:
            js(t, r"""
              document.querySelector('.dp-person .typeahead input')
                ?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
            """)

    def select_person(pid):
        row = t.find_element(By.CSS_SELECTOR, f".tree-person[data-person-id='{pid}']")
        js(t, "arguments[0].scrollIntoView({block:'center'})", row)
        time.sleep(0.3)
        row.click()
        time.sleep(0.8)

    # ── phase A: an unfiled UnknownN renamed in place (the #178 repro) ──
    apick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const p = snap.persons.find(x => /^unknown/i.test(x.name) && x.counts.total > 0
                   && x.groups.length === 1 && x.groups[0] === 'New');
      if (!p) return null;
      const taken = new Set(snap.persons.map(x => x.name));
      let nm = 'Ck39Renamed';
      for (let i = 2; taken.has(nm); i++) nm = 'Ck39Renamed' + i;
      return {id: p.id, total: p.counts.total,
              faces: snap.faces.filter(f => f.person_id === p.id).map(f => f.id),
              new: nm};
    """)
    if apick is None:
        record("C39 rename of a seated person (#178/§4.1)", True,
               "no unfiled UnknownN with faces in the seed — vacuous")
        return
    select_person(apick["id"])
    set_name(apick["new"], enter=False)       # the repro: type, then Update person
    time.sleep(0.4)
    t.find_element(By.CSS_SELECTOR, ".dp-update").click()
    a_ok = wait_for(lambda: js(t, r"""
      const p = window.__MOCK_SNAP.persons.find(x => x.id === arguments[0]);
      return !!p && p.name === arguments[1] && p.groups.length === 1
             && p.groups[0] === 'Accepted';
    """, apick["id"], apick["new"]))
    a_claim = js(t, r"""
      const want = new Set(arguments[0]);
      const fs = window.__MOCK_SNAP.faces.filter(f => want.has(f.id));
      return fs.length === arguments[1] && fs.every(f => f.link_status === 'confirmed');
    """, apick["faces"], apick["total"])
    a_anchor = js(t, r"""
      const el = document.querySelector('.dp-person .typeahead input');
      const row = document.querySelector(arguments[0]);
      return {pane: el ? el.value : null,
              tree: row ? row.textContent.trim() : null};
    """, f".tree-person[data-person-id='{apick['id']}'] .tree-name")
    a_err = err()

    # ── phase B: a seated person renamed to a KNOWN name ⇒ clean merge ──
    bpick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const src = snap.persons.find(x => /^unknown/i.test(x.name) && x.counts.total > 0);
      const dst = snap.persons.find(x => x.id !== arguments[0] && !/^unknown/i.test(x.name)
                     && x.name !== 'Rejected' && x.counts.total > 0
                     && x.groups.length === 1 && !['New','Accepted','Rejected'].includes(x.groups[0]));
      if (!src || !dst) return null;
      return {srcId: src.id, srcTotal: src.counts.total,
              dstId: dst.id, dstName: dst.name, dstTotal: dst.counts.total,
              dstGroups: [...dst.groups]};
    """, apick["id"])
    merge_b = None
    anchor_b = None
    if bpick:
        select_person(bpick["srcId"])
        set_name(bpick["dstName"], enter=False)
        time.sleep(0.4)
        t.find_element(By.CSS_SELECTOR, ".dp-update").click()
        merge_b = wait_for(lambda: js(t, r"""
          const snap = window.__MOCK_SNAP;
          return !snap.persons.some(p => p.id === arguments[0]) &&
                 (snap.persons.find(p => p.id === arguments[1])?.counts.total ?? 0)
                   === arguments[2] + arguments[3];
        """, bpick["srcId"], bpick["dstId"], bpick["srcTotal"], bpick["dstTotal"]))
        anchor_b = js(t, r"""
          const el = document.querySelector('.dp-person .typeahead input');
          return {name: el ? el.value : null,
                  groups: [...document.querySelectorAll('.dp-groups .dp-group-path')]
                    .map(x => x.textContent.trim())};
        """)
    b_err = err()

    # ── phase C: merge INTO the seated rename product (F2: "", never the seat) ──
    cpick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const dst = snap.persons.find(x => x.id === arguments[0]);
      const src = snap.persons.find(x => x.id !== arguments[0] && x.counts.total > 0
                     && !/^unknown/i.test(x.name) && x.name !== 'Rejected');
      if (!dst || !src) return null;
      return {dstId: dst.id, dstName: dst.name, dstTotal: dst.counts.total,
              srcId: src.id, srcTotal: src.counts.total};
    """, apick["id"])
    merge_c = None
    if cpick:
        select_person(cpick["srcId"])
        AC(t.driver).context_click(
            t.find_element(By.CSS_SELECTOR, f".tree-person[data-person-id='{cpick['srcId']}']")
        ).perform()
        time.sleep(0.6)
        items = [b for b in t.find_elements(By.CSS_SELECTOR, ".ctx-item")
                 if "into" in b.text and "Merge" in b.text]
        if not items:
            AC(t.driver).send_keys(Keys.ESCAPE).perform()
        else:
            items[0].click()
            time.sleep(0.8)
            inp = t.find_element(By.CSS_SELECTOR, ".overlay .dialog .typeahead input")
            inp.click()
            inp.send_keys(cpick["dstName"])
            time.sleep(0.6)
            btn = [b for b in t.find_elements(By.CSS_SELECTOR, ".overlay .dialog button.bad")
                   if b.is_enabled()]
            if btn:
                btn[0].click()
                merge_c = wait_for(lambda: js(t, r"""
                  const snap = window.__MOCK_SNAP;
                  return !snap.persons.some(p => p.id === arguments[0]) &&
                         (snap.persons.find(p => p.id === arguments[1])?.counts.total ?? 0)
                           === arguments[2] + arguments[3];
                """, cpick["srcId"], cpick["dstId"], cpick["srcTotal"], cpick["dstTotal"]))
    c_groups = js(t, r"""
      return window.__MOCK_SNAP.persons.find(p => p.id === arguments[0])?.groups ?? null;
    """, apick["id"])
    c_err = err()

    ok = (a_ok and a_claim
          and a_anchor["pane"] == apick["new"] and a_anchor["tree"] == apick["new"]
          and a_err is None
          and (bpick is None or (merge_b is True and b_err is None
                                 and anchor_b["name"] == bpick["dstName"]
                                 and anchor_b["groups"] == bpick["dstGroups"]))
          and (cpick is None or (merge_c is True and c_err is None
                                 and c_groups == ["Accepted"])))
    record("C39 rename of a seated person (#178/§4.1): in-place rename ⇒ Accepted seat, rename-to-known merges + re-anchors, merge INTO a seated target keeps its group",
           ok,
           f"A: renamed={a_ok} claimed={a_claim} anchor={a_anchor} err={a_err}; "
           f"B: pick={bpick} merged={merge_b} anchor={anchor_b} err={b_err}; "
           f"C: pick={cpick} merged={merge_c} groups={c_groups} err={c_err}")


def c40_db_status_totals(t):
    """#179 (§4.41): the top bar's status totals are DB-wide and live —
    present with NO anchor and equal to the whole snapshot, unchanged by
    the Show filter and by the mode (Rolls), and updated by verdicts
    (one card accept: ? −1 / ✓ +1; one card reject: ? −1 / ✗ +1)."""
    fresh(t)
    set_show_filter(t, "all")

    # ── phase A: visible with no anchor, reading the whole database ──
    base = status_totals(t)
    c0 = topbar_totals(t)
    anchor0 = js(t, "return !!document.querySelector('.tree-person.selected')")
    a_ok = (not anchor0 and c0 is not None
            and c0["title"] == "totals in the database"
            and (c0["n"], c0["a"], c0["r"]) == chip_texts(base))

    # ── phase B: the Show filter and the mode never tilt the totals ──
    set_show_filter(t, "provisional")
    c_filter = topbar_totals(t)
    set_show_filter(t, "all")
    rolls = [b for b in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
             if "Rolls" in b.text][0]
    rolls.click()
    time.sleep(1.0)
    c_rolls = topbar_totals(t)
    rev = [b for b in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
           if "Review" in b.text][0]
    rev.click()
    time.sleep(1.0)
    def texts(c):
        return None if c is None else (c["n"], c["a"], c["r"])
    b_ok = (texts(c_filter) == chip_texts(base)
            and texts(c_rolls) == chip_texts(base))

    # ── phase C: verdicts move the totals (live) ─────────────────────
    prov = js(t, r"""
      return [...document.querySelectorAll('.face-card.status-provisional')]
        .map(x => Number(x.dataset.faceId)).slice(0, 2);
    """)
    if len(prov) < 2:
        record("C40 top-bar DB status totals (#179/§4.41): no-anchor + DB-wide, filter/mode-independent, live verdicts",
               a_ok and b_ok,
               f"only {len(prov)} visible provisional cards — verdict phases vacuous; "
               f"A: anchor0={anchor0} chips={c0} want={chip_texts(base)}; "
               f"B: filter={texts(c_filter)} rolls={texts(c_rolls)}")
        return

    acc = t.find_element(By.CSS_SELECTOR,
                         f".face-card[data-face-id='{prov[0]}'] .card-accept")
    acc.click()
    time.sleep(1.5)
    after_acc = status_totals(t)
    c1 = topbar_totals(t)
    acc_ok = (texts(c1) == chip_texts(after_acc)
              and after_acc["provisional"] == base["provisional"] - 1
              and after_acc["confirmed"] == base["confirmed"] + 1)

    # #189: the accept may have drained that person — the anchor follows
    # the verdict, so §4.30's hand-over can leave Review; the reject card
    # must be found in the review grid (a no-op when no hand-over ran)
    active = js(t, r"""
      return (document.querySelector('.topbar nav button.active')?.textContent ?? '')
        .trim().split(/\s+/)[0] ?? '';
    """)
    if active != "Review":
        [b for b in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
         if "Review" in b.text][0].click()
        time.sleep(1.0)

    rej = t.find_element(By.CSS_SELECTOR,
                         f".face-card[data-face-id='{prov[1]}'] button[title^='Reject face']")
    js(t, "arguments[0].scrollIntoView({block:'center'})", rej)
    time.sleep(0.3)
    rej = t.find_element(By.CSS_SELECTOR,
                         f".face-card[data-face-id='{prov[1]}'] button[title^='Reject face']")
    rej.click()
    time.sleep(1.5)
    after_rej = status_totals(t)
    c2 = topbar_totals(t)
    rej_ok = (texts(c2) == chip_texts(after_rej)
              and after_rej["provisional"] == after_acc["provisional"] - 1
              and after_rej["rejected"] == after_acc["rejected"] + 1
              and after_rej["confirmed"] == after_acc["confirmed"])

    ok = a_ok and b_ok and acc_ok and rej_ok
    record("C40 top-bar DB status totals (#179/§4.41): no-anchor + DB-wide, filter/mode-independent, live on accept + reject",
           ok,
           f"A: anchor0={anchor0} chips={c0} want={chip_texts(base)}; "
           f"B: filter={texts(c_filter)} rolls={texts(c_rolls)}; "
           f"C: accept {prov[0]} → chips={texts(c1)} snap={after_acc}; "
           f"reject {prov[1]} → chips={texts(c2)} snap={after_rej}")


def c41_verdict_focuses_person(t):
    """#189 (§4.41 'Focus follows the verdict'): Phase A — the grid-only
    verdict on a person nobody picked (no anchor ⇒ no #125 mark, the app
    stays in Review) now ANCHORS the drained person, so Person mode
    opens at them instead of the §4.41 picker dead end; under Show → New
    the drained person is tree-pruned and the 'No new faces' guard may
    stand in front (Show All reveals them) — the pane must be theirs
    either way. Phase B — a verdict on ANOTHER person while a different
    one is anchored follows the action: the anchor moves to the acted
    person, the §4.30 hand-over does NOT fire (its mark belongs to the
    old anchor, #148) and the act stays in Review; Person mode opens at
    the acted person."""
    fresh(t)
    set_show_filter(t, "provisional")

    def pane_name():
        return js(t, r"""
          return document.querySelector('.dp-person .typeahead input')?.value ?? null;
        """)

    def tab():
        return js(t, r"""
          return (document.querySelector('.topbar nav button.active')?.textContent ?? '')
            .trim().split(/\s+/)[0] ?? '';
        """)

    def dialog_title():
        return js(t, r"""
          return document.querySelector('.overlay .dialog h3')?.textContent.trim() ?? null;
        """)

    def bar_accept():
        acc = [b for b in t.find_elements(By.CSS_SELECTOR, ".rulebar button")
               if "Accept" in b.text]
        if not acc:
            return False
        acc[0].click()
        time.sleep(2.5)
        return True

    def prov_left(pid):
        return js(t, r"""
          return window.__MOCK_SNAP.faces.filter(
            f => f.person_id === Number(arguments[0]) &&
                 f.link_status === 'provisional').length;
        """, pid)

    # ── phase A: grid-only verdict, no anchor ever ───────────────────
    pick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const p = snap.persons.find(x => x.name !== 'Rejected' &&
        snap.faces.filter(f => f.person_id === x.id && f.link_status === 'provisional').length === 1 &&
        snap.faces.filter(f => f.person_id === x.id).length > 1);
      return p ? {id: p.id, name: p.name} : null;
    """)
    if pick is None:
        record("C41 focus follows the verdict (#189/§4.41): grid-only verdict anchors the drained person, another-person verdict re-anchors without the hand-over",
               True, "need a person with exactly one new face — vacuous")
        return
    started = {"tab": tab(), "anchor0": js(t, "return !!document.querySelector('.tree-person.selected')")}
    sel = js(t, r"""
      const s = [...document.querySelectorAll('.face-section')].find(
        x => x.dataset.sectionKey === 'rev-' + arguments[0]);
      if (!s) return null;
      const cb = s.querySelector('.select-all input');
      if (!cb) return null;
      cb.click();
      return s.dataset.sectionKey;
    """, pick["id"])
    time.sleep(0.6)
    accepted = sel is not None and bar_accept()
    a = {"tab": tab(), "pane": pane_name(), "dlg": dialog_title(),
         "left": prov_left(pick["id"])}
    a_ok = (accepted and started["tab"] == "Review" and not started["anchor0"]
            and a["tab"] == "Review"            # no mark was possible — no jump
            and a["left"] == 0                   # drained
            and a["pane"] == pick["name"]        # focus landed on them
            and a["dlg"] != "Please select a person in the tree on the left")

    # Person mode opens AT the drained person (the §4.41 guard may sit
    # in front under Show → New — Show All must reveal the same pane)
    person_btn = [b for b in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
                  if "Person" in b.text][0]
    person_btn.click()
    time.sleep(1.2)
    b = {"pane": pane_name(), "dlg": dialog_title()}
    guard = b["dlg"] == "No new faces"
    if guard:
        show_all = [x for x in t.find_elements(By.CSS_SELECTOR, ".overlay .dialog button")
                    if x.text.strip() == "Show All"]
        if show_all:
            show_all[0].click()
            time.sleep(1.0)
        b = {"pane": pane_name(), "dlg": dialog_title()}
    b_ok = (b["pane"] == pick["name"]
            and b["dlg"] != "Please select a person in the tree on the left"
            and (b["dlg"] is None or guard))     # only the §4.41 guard may show

    # ── phase B: verdict on ANOTHER person while one is anchored ─────
    fresh(t)
    set_show_filter(t, "provisional")
    pick2 = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const prov = id => snap.faces.filter(
        f => f.person_id === id && f.link_status === 'provisional').length;
      const xs = snap.persons.filter(x => x.name !== 'Rejected' &&
        prov(x.id) >= 2 && snap.faces.filter(f => f.person_id === x.id).length > 2);
      const x = xs[0];
      if (!x) return null;
      const z = snap.persons.find(y => y.id !== x.id && y.name !== 'Rejected' &&
        prov(y.id) >= 1 && snap.faces.filter(f => f.person_id === y.id).length > 1);
      return z ? {xid: x.id, xname: x.name, zid: z.id, zname: z.name} : null;
    """)
    c_ok = None
    c = {}
    if pick2:
        # anchor Z (tree click → Person mode), then back to Review
        t.find_element(By.CSS_SELECTOR,
                       f".tree-person[data-person-id='{pick2['zid']}']").click()
        time.sleep(1.0)
        [b2 for b2 in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
         if "Review" in b2.text][0].click()
        time.sleep(1.0)
        c["before"] = {"tab": tab(), "pane": pane_name()}
        # ONE card of X's section — a partial verdict (X keeps new faces
        # and stays listed, so the tree selection can prove the anchor)
        card = t.find_element(By.CSS_SELECTOR,
                              f".face-section[data-section-key='rev-{pick2['xid']}'] .face-card")
        js(t, "arguments[0].scrollIntoView({block:'center'})", card)
        time.sleep(0.3)
        card = t.find_element(By.CSS_SELECTOR,
                              f".face-section[data-section-key='rev-{pick2['xid']}'] .face-card")
        card.click()
        time.sleep(0.5)
        accepted2 = bar_accept()
        time.sleep(1.0)
        c["after"] = {
            "tab": tab(), "pane": pane_name(),
            "sel": js(t, r"""
              const el = document.querySelector('.tree-person.selected');
              return el ? Number(el.dataset.personId) : null;
            """),
            "xleft": prov_left(pick2["xid"]),
        }
        person_btn = [b for b in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
                      if "Person" in b.text][0]
        person_btn.click()
        time.sleep(1.2)
        c["person"] = {"pane": pane_name(), "dlg": dialog_title()}
        c_ok = (accepted2
                and c["before"]["tab"] == "Review"
                and c["before"]["pane"] == pick2["zname"]   # anchor was Z
                and c["after"]["tab"] == "Review"            # #148: no hand-over
                and c["after"]["pane"] == pick2["xname"]     # focus followed the action
                and c["after"]["sel"] == pick2["xid"]        # …and the tree shows it
                and c["after"]["xleft"] >= 1                 # partial: X still listed
                and c["person"]["pane"] == pick2["xname"]
                and c["person"]["dlg"] is None)               # X still has new faces
    else:
        c_ok = True  # vacuous sub-phase

    ok = a_ok and b_ok and c_ok
    record("C41 focus follows the verdict (#189/§4.41): grid-only verdict anchors the drained person (Person opens at them, no picker), another-person verdict re-anchors without the §4.30 hand-over",
           ok,
           f"A: started={started} picked={pick} → {a} accepted={accepted}; "
           f"B(after Person): {b} guard={guard}; "
           f"C: pick={pick2} {c}")


def c42_edit_label_everywhere(t):
    """#180 (§4.24): ONE label — 'Edit…' — for every opener of the shared
    Edit dialog: the rule-bar button, the face-card button and the
    cluster-header button read 'Edit…', the face context menu item reads
    'Edit…' ('Edit… (N selected)' for a multi-scope), the dialog title
    is 'Edit', and no opener says 'Assign' any more."""
    fresh(t)
    set_show_filter(t, "all")

    def menu_texts():
        return js(t, r"""
          return [...document.querySelectorAll('.ctx-item')].map(x => x.textContent.trim());
        """)

    def close_menu():
        AC(t.driver).send_keys(Keys.ESCAPE).perform()
        time.sleep(0.4)

    # ── the card buttons, the header buttons and the rule bar ─────────
    ids = js(t, r"""
      return [...document.querySelectorAll('.face-card')].slice(0, 2)
        .map(c => Number(c.dataset.faceId));
    """)
    if len(ids) < 2:
        record("C42 'Edit…' everywhere (#180/§4.24): one label for every dialog opener", True,
               "need at least two face cards — vacuous")
        return
    card = t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{ids[0]}']")
    js(t, "arguments[0].scrollIntoView({block:'center'})", card)
    time.sleep(0.3)
    card.click()          # select it — the rule bar shows
    time.sleep(0.5)
    state = js(t, r"""
      const bar = [...document.querySelectorAll('.rulebar button')].map(b => b.textContent.trim());
      const cardBtns = [...document.querySelectorAll('.face-card button')].map(b => b.textContent.trim());
      const headBtns = [...document.querySelectorAll('.face-section button')].map(b => b.textContent.trim());
      const all = [...bar, ...cardBtns, ...headBtns];
      return {bar, cardBtns, headBtns,
              editBar: bar.filter(x => x.startsWith('Edit')),
              editCard: cardBtns.filter(x => x === 'Edit…').length,
              editHead: headBtns.filter(x => x === 'Edit…').length,
              assign: all.filter(x => x.includes('Assign'))};
    """)
    btn_ok = (state["editBar"] == ["Edit…"] and state["editCard"] >= 1
              and state["editHead"] >= 1 and not state["assign"])

    # the rule bar's Edit… opens the dialog titled 'Edit' (Cancel closes)
    edit_btn = [b for b in t.find_elements(By.CSS_SELECTOR, ".rulebar button")
                if b.text.strip().startswith("Edit")][0]
    edit_btn.click()
    time.sleep(0.8)
    opened = js(t, r"""
      const d = document.querySelector('.overlay .dialog');
      return d ? (d.querySelector('h3')?.textContent.trim() ?? '') : null;
    """)
    cancel = t.find_elements(By.CSS_SELECTOR, ".overlay .dialog button.secondary")
    if cancel:
        cancel[0].click()
        time.sleep(0.5)
    dialog_ok = opened == "Edit" and not js(t, "return !!document.querySelector('.overlay .dialog')")

    # ── the face context menu: single scope, then a 2-face multi ──────
    AC(t.driver).context_click(
        t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{ids[0]}']")).perform()
    time.sleep(0.6)
    single = menu_texts()
    close_menu()
    # the single-phase click left {ids[0]} selected — ctrl-click adds the
    # second card (a plain click would TOGGLE it off)
    AC(t.driver).key_down(Keys.CONTROL).click(
        t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{ids[1]}']")).key_up(Keys.CONTROL).perform()
    time.sleep(0.4)
    AC(t.driver).context_click(
        t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{ids[1]}']")).perform()
    time.sleep(0.6)
    multi = menu_texts()
    close_menu()

    single_ok = "Edit…" in single and not any("Assign" in x for x in single)
    multi_ok = "Edit… (2 selected)" in multi and not any("Assign" in x for x in multi)

    ok = btn_ok and dialog_ok and single_ok and multi_ok
    record("C42 'Edit…' everywhere (#180/§4.24): one label for every dialog opener, no 'Assign' left",
           ok,
           f"bar edit={state['editBar']} card×{state['editCard']} head×{state['editHead']} "
           f"assign-left={state['assign']}; dialog={opened!r} closed={dialog_ok}; "
           f"menu single={single_ok} multi={multi_ok} (multi items: {[x for x in multi if 'Edit' in x]})")


def c43_single_only_menu_items(t):
    """#182 (§4.14): one-item-only context-menu entries grey out when the
    scope exceeds one item — the face menu's 'Open full image'
    (2-card scope), the thumbnail menu's 'Open image' + 'Open full image
    (focused)' (2-thumb scope) and the tree person menu's one-person
    trio (Open person / Rename… / Select their pending faces) — while
    the scope-wide entries (Accept, Rotate…) stay enabled; and every
    one of them is enabled again for a single-item scope.

    Each phase also asserts the SELECTION SURVIVES the right-click:
    WebKitGTK fires a spurious left click on the just-right-clicked
    element right after the contextmenu (#191), and on every selectable
    its plain-click path replaces the multi-selection with the clicked
    item — the face/thumbnail menus bake their items at contextmenu time
    so they still look multi-scope while the selection underneath is
    already collapsed to one."""
    fresh(t)
    set_show_filter(t, "all")

    def item(label_text):
        return js(t, r"""
          const want = arguments[0];
          const el = [...document.querySelectorAll('.ctx-item')]
            .find(x => x.textContent.trim().startsWith(want));
          return el ? {found: true, disabled: el.disabled} : {found: false};
        """, label_text)

    def close_menu():
        AC(t.driver).send_keys(Keys.ESCAPE).perform()
        time.sleep(0.4)

    # ── phase A: the face menu (review grid) ──────────────────────────
    ids = js(t, r"""
      return [...document.querySelectorAll('.face-card')].slice(0, 2)
        .map(c => Number(c.dataset.faceId));
    """)
    if len(ids) < 2:
        record("C43 one-item-only menu entries disable for a multi-scope (#182/§4.14)", True,
               "need at least two face cards — vacuous")
        return
    c0 = f".face-card[data-face-id='{ids[0]}']"
    c1 = f".face-card[data-face-id='{ids[1]}']"
    js(t, "arguments[0].scrollIntoView({block:'center'})", t.find_element(By.CSS_SELECTOR, c0))
    time.sleep(0.3)
    t.find_element(By.CSS_SELECTOR, c0).click()
    time.sleep(0.4)
    AC(t.driver).key_down(Keys.CONTROL).click(
        t.find_element(By.CSS_SELECTOR, c1)).key_up(Keys.CONTROL).perform()
    time.sleep(0.4)
    AC(t.driver).context_click(t.find_element(By.CSS_SELECTOR, c1)).perform()
    time.sleep(0.6)
    a_multi = item("Open full image")
    a_scope = item("Accept")          # scope-wide: enabled in BOTH states
    # #191: the spurious post-right-click click must not collapse the
    # 2-card selection (the menu items are baked at contextmenu time,
    # so only the selection state betrays the collapse)
    a_sel = js(t, "return [...document.querySelectorAll('.face-card')]"
                ".filter(x => x.classList.contains('selected')).length")
    close_menu()
    t.find_element(By.CSS_SELECTOR, c0).click()      # plain click replaces → {c0}
    time.sleep(0.4)
    AC(t.driver).context_click(t.find_element(By.CSS_SELECTOR, c0)).perform()
    time.sleep(0.6)
    a_single = item("Open full image")
    close_menu()
    a_ok = (a_multi["found"] and a_multi["disabled"]
            and a_scope["found"] and not a_scope["disabled"]
            and a_single["found"] and not a_single["disabled"]
            and a_sel == 2)

    # ── phase B: the thumbnail menu (Rolls) ───────────────────────────
    [b for b in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
     if "Rolls" in b.text][0].click()
    time.sleep(1.0)
    pick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const dirOf = p => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
      const dirs = new Map();
      for (const im of snap.images) {
        const d = dirOf(im.primary_path);
        if (d !== '/') dirs.set(d, (dirs.get(d) || 0) + 1);
      }
      let best = null, nbest = 1;
      for (const [d, n] of dirs) if (n > nbest) { best = d; nbest = n; }
      return best ? {dir: best, n: nbest} : null;
    """)
    b_ok = None
    if pick:
        def drill(path):
            segs = [s for s in path.strip('/').split('/') if s]
            for i, seg in enumerate(segs):
                last = i == len(segs) - 1
                state = js(t, r"""
                  const prefix = arguments[0], seg = arguments[1], last = arguments[2];
                  let container = document.querySelector('.rolls');
                  for (const p of prefix) {
                    const s = [...container.children].find(x => x.classList.contains('roll') &&
                      x.querySelector(':scope > .roll-header .roll-path')?.textContent.trim() === p);
                    if (!s) return 'no-parent';
                    container = s.querySelector(':scope > .roll-children');
                    if (!container) return 'closed-parent';
                  }
                  const target = [...container.children].find(x => x.classList.contains('roll') &&
                    x.querySelector(':scope > .roll-header .roll-path')?.textContent.trim() === seg);
                  if (!target) return 'not-found';
                  const isOpen = !!target.querySelector(':scope > .roll-children');
                  if (last || !isOpen) target.querySelector(':scope > .roll-header').click();
                  return 'ok';
                """, segs[:i], seg, last)
                time.sleep(0.6)
                if state != "ok":
                    return False
            return True

        drilled = drill(pick["dir"])

        def thumb(i):
            return t.find_elements(By.CSS_SELECTOR, ".rolls-thumbs .img-thumb")[i]

        thumb(0).click()          # plain click selects ONE
        time.sleep(0.4)
        t2 = thumb(1)
        AC(t.driver).key_down(Keys.CONTROL).click(t2).key_up(Keys.CONTROL).perform()
        time.sleep(0.4)
        AC(t.driver).context_click(t2).perform()
        time.sleep(0.6)
        b_open = item("Open image")
        b_full = item("Open full image (focused)")
        b_rot = item("Rotate 90° CW")     # scope-wide: stays enabled
        # #191: the 2-thumb selection must survive the right-click
        # (the '· N selected' header is the visible witness)
        b_sel = js(t, "return (document.querySelector('.rolls-thumbs-head')"
                      "?.textContent) || ''")
        close_menu()
        thumb(0).click()                  # back to a single selection
        time.sleep(0.4)
        AC(t.driver).context_click(thumb(0)).perform()
        time.sleep(0.6)
        b_open_s = item("Open image")
        b_full_s = item("Open full image (focused)")
        close_menu()
        b_ok = (drilled
                and b_open["found"] and b_open["disabled"]
                and b_full["found"] and b_full["disabled"]
                and b_rot["found"] and not b_rot["disabled"]
                and b_open_s["found"] and not b_open_s["disabled"]
                and b_full_s["found"] and not b_full_s["disabled"]
                and "2 selected" in b_sel)

    # ── phase C: the tree person menu ─────────────────────────────────
    [b for b in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
     if "Review" in b.text][0].click()
    time.sleep(1.0)
    pids = js(t, r"""
      return [...document.querySelectorAll('.tree-person')]
        .map(x => Number(x.dataset.personId))
        .filter(id => (window.__MOCK_SNAP.persons.find(p => p.id === id)?.counts.provisional ?? 0) > 0)
        .slice(0, 2);
    """)  # persons WITH pending faces — 'Select their pending faces' is
         # then disabled only by the multi-scope (#182), never by content
    c_ok = None
    if len(pids) == 2:
        r0 = f".tree-person[data-person-id='{pids[0]}']"
        r1 = f".tree-person[data-person-id='{pids[1]}']"
        js(t, "arguments[0].scrollIntoView({block:'center'})", t.find_element(By.CSS_SELECTOR, r0))
        time.sleep(0.3)
        t.find_element(By.CSS_SELECTOR, r0).click()   # single
        time.sleep(0.6)
        AC(t.driver).key_down(Keys.CONTROL).click(
            t.find_element(By.CSS_SELECTOR, r1)).key_up(Keys.CONTROL).perform()
        time.sleep(0.4)
        AC(t.driver).context_click(t.find_element(By.CSS_SELECTOR, r1)).perform()
        time.sleep(0.6)
        c_open = item("Open person")
        c_ren = item("Rename…")
        c_pend = item("Select their pending faces")
        c_move = item(f"Move 2 persons to group…")   # scope-wide: enabled
        # #191: the 2-row selection must survive the right-click (the
        # menu re-renders from it, so a collapse would also break the
        # scope labels above — assert the state directly as well);
        # rows mark the anchor with 'selected' and multi-membership with
        # 'multi-selected' (the anchor row carries both)
        c_sel = js(t, "return [...document.querySelectorAll('" +
                    ".tree-person')].filter(x =>"
                    " x.classList.contains('selected') ||"
                    " x.classList.contains('multi-selected')).length")
        close_menu()
        t.find_element(By.CSS_SELECTOR, r0).click()   # back to single
        time.sleep(0.6)
        AC(t.driver).context_click(t.find_element(By.CSS_SELECTOR, r0)).perform()
        time.sleep(0.6)
        c_open_s = item("Open person")
        c_ren_s = item("Rename…")
        c_pend_s = item("Select their pending faces")
        close_menu()
        c_ok = (c_open["found"] and c_open["disabled"]
                and c_ren["found"] and c_ren["disabled"]
                and c_pend["found"] and c_pend["disabled"]
                and c_move["found"] and not c_move["disabled"]
                and c_open_s["found"] and not c_open_s["disabled"]
                and c_ren_s["found"] and not c_ren_s["disabled"]
                and c_pend_s["found"] and not c_pend_s["disabled"]
                and c_sel == 2)
    else:
        c_ok = True  # vacuous sub-phase

    ok = a_ok and (b_ok is not False) and c_ok
    record("C43 one-item-only menu entries disable for a multi-scope (#182/§4.14): face/thumbnail/tree menus",
           ok,
           f"A: multi={a_multi} scope={a_scope} single={a_single} sel={a_sel}; "
           f"B: pick={pick} open={b_open} full={b_full} rot={b_rot} "
           f"single open={b_open_s} full={b_full_s} sel={b_sel!r} (ok={b_ok}); "
           f"C: pids={pids} open={c_open} rename={c_ren} pend={c_pend} move={c_move} "
           f"single open={c_open_s} rename={c_ren_s} sel={c_sel} (ok={c_ok})")


def c44_rotate_image_cascades(t):
    """#183 (§4.32): rotating the IMAGE cascades the delta to every crop
    on it — the focus header's ⟳ button advances images.rotation AND
    every face of that image by +90 in the mock — while a CROP rotation
    never touches the image (the face menu's 'Rotate crop 90° CW' moves
    that one face by +90; the image and its other crops stay)."""
    fresh(t)
    set_show_filter(t, "all")
    pick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const byImg = new Map();
      for (const f of snap.faces) {
        const a = byImg.get(f.image_id) ?? [];
        a.push(f.id); byImg.set(f.image_id, a);
      }
      for (const [imgId, fids] of byImg) {
        if (fids.length < 2 || !snap.images.some(x => x.id === imgId)) continue;
        // the card must be IN the grid — the review sections hold the
        // provisional faces (under Show → All too, §4.10)
        const prov = snap.faces.filter(f =>
          f.image_id === imgId && f.link_status === 'provisional').map(f => f.id);
        if (prov.length) return {imgId, fids, provFid: prov[0]};
      }
      return null;
    """)
    if not pick:
        record("C44 rotate image cascades to its crops (#183/§4.32)", True,
               "no image with ≥2 faces — vacuous")
        return

    def rots():
        return js(t, r"""
          const img = window.__MOCK_SNAP.images.find(x => x.id === arguments[0]);
          const faces = window.__MOCK_SNAP.faces.filter(f => f.image_id === arguments[0])
            .map(f => ({id: f.id, rot: f.rotation ?? 0}));
          return {img: img?.rotation ?? null, faces};
        """, pick["imgId"])

    fid = pick["provFid"]
    card = t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{fid}']")
    js(t, "arguments[0].scrollIntoView({block:'center'})", card)
    time.sleep(0.3)
    card.click()
    time.sleep(0.5)
    card = t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{fid}']")
    AC(t.driver).double_click(card).perform()
    time.sleep(1.0)
    before = rots()

    # ⟳ in the focus header — the image AND every crop
    t.find_element(By.CSS_SELECTOR, ".focus-top button[title^='Rotate 90° clockwise']").click()
    time.sleep(1.2)
    after_img = rots()
    cascade_ok = (after_img["img"] == (before["img"] + 90) % 360
                  and len(after_img["faces"]) == len(before["faces"])
                  and all(a["rot"] == (b["rot"] + 90) % 360
                          for a, b in zip(after_img["faces"], before["faces"])))

    # close the focus (Esc), then a CROP rotation via the face menu
    AC(t.driver).send_keys(Keys.ESCAPE).perform()
    time.sleep(0.8)
    t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{fid}']").click()  # single scope
    time.sleep(0.4)
    AC(t.driver).context_click(
        t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{fid}']")).perform()
    time.sleep(0.6)
    items = [b for b in t.find_elements(By.CSS_SELECTOR, ".ctx-item")
             if b.text.strip() == "Rotate crop 90° CW"]
    rotated = False
    if items and items[0].is_enabled():
        items[0].click()
        time.sleep(1.2)
        rotated = True
    after_crop = rots()
    face_rot = next((f["rot"] for f in after_crop["faces"] if f["id"] == fid), None)
    others = [f["rot"] for f in after_crop["faces"] if f["id"] != fid]
    crop_ok = (rotated
               and face_rot == (next(f["rot"] for f in after_img["faces"] if f["id"] == fid) + 90) % 360
               and after_crop["img"] == after_img["img"]            # the image never moves
               and all(r == next(f["rot"] for f in after_img["faces"] if f["id"] == i)
                       for r, i in zip(others, [f["id"] for f in after_crop["faces"] if f["id"] != fid])))

    ok = cascade_ok and crop_ok
    record("C44 rotate image cascades to its crops (#183/§4.32): image ⟳ moves every face, crop rotate leaves the image",
           ok,
           f"pick={pick} before={before} after ⟳={after_img} (cascade={cascade_ok}); "
           f"crop menu item={bool(items)} → {after_crop} (crop={crop_ok})")


def c45_face_menu_add_group(t):
    """#184 (§4.18): the face menu's 'Add group…' — a scope over N
    DISTINCT persons reads 'Add group to N persons…' and the
    GroupDialog adds the typed path as ANOTHER membership to all N (the
    #164 add semantics — every real group kept); a single-person scope
    reads plain 'Add group…'. Both pick persons are FILED (real group)
    so the kept-membership assertion is exact."""
    fresh(t)
    set_show_filter(t, "all")
    pick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const SEATS = ['New', 'Accepted', 'Rejected'];
      const byId = new Map(snap.persons.map(p => [p.id, p]));
      const filed = id => {
        const p = byId.get(id);
        return !!p && p.groups.some(g => !SEATS.includes(g));
      };
      const prov = snap.faces.filter(f =>
        f.link_status === 'provisional' && f.person_id != null && filed(f.person_id));
      for (const a of prov) {
        for (const b of prov)
          if (a.id !== b.id && a.person_id !== b.person_id)
            return {a: a.id, b: b.id, pa: a.person_id, pb: b.person_id};
      }
      return null;
    """)
    if not pick:
        record("C45 face menu 'Add group…' over N persons (#184/§4.18)", True,
               "need two provisional faces of DIFFERENT filed persons — vacuous")
        return

    def groups():
        return js(t, r"""
          const g = id => (window.__MOCK_SNAP.persons.find(p => p.id === id)?.groups ?? []).slice();
          return {pa: g(arguments[0]), pb: g(arguments[1])};
        """, pick["pa"], pick["pb"])

    def card(fid):
        return t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{fid}']")

    before = groups()
    js(t, "arguments[0].scrollIntoView({block:'center'})", card(pick["a"]))
    time.sleep(0.3)
    card(pick["a"]).click()
    time.sleep(0.4)
    # the two cards can sit far apart — AC clicks need b in the viewport
    js(t, "arguments[0].scrollIntoView({block:'center'})", card(pick["b"]))
    time.sleep(0.3)
    AC(t.driver).key_down(Keys.CONTROL).click(card(pick["b"])).key_up(Keys.CONTROL).perform()
    time.sleep(0.4)
    AC(t.driver).context_click(card(pick["b"])).perform()
    time.sleep(0.6)
    labels = js(t, r"""
      return [...document.querySelectorAll('.ctx-item')].map(x => x.textContent.trim());
    """)
    two_ok = "Add group to 2 persons…" in labels
    clicked = js(t, r"""
      const it = [...document.querySelectorAll('.ctx-item')]
        .find(x => x.textContent.trim() === 'Add group to 2 persons…');
      if (!it) return false;
      it.click();
      return true;
    """)
    time.sleep(0.5)
    title = js(t, "return document.querySelector('.dialog h3')?.textContent.trim() ?? null;")
    typed = js(t, r"""
      const el = document.querySelector('.dialog input');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, arguments[0]);
      el.dispatchEvent(new Event('input', {bubbles: true}));
      return true;
    """, "Ck45|Grp")
    submitted = js(t, r"""
      const b = [...document.querySelectorAll('.dialog-actions button')]
        .find(x => x.textContent.trim() === 'add group');
      if (!b) return false;
      b.click();
      return true;
    """)
    time.sleep(1.2)
    after = groups()

    def expect(old):
        real = [g for g in old if g not in ("New", "Accepted", "Rejected")]
        return sorted(set(real + ["Ck45|Grp"]))     # kept + added
    added_ok = (sorted(after["pa"]) == expect(before["pa"])
                and sorted(after["pb"]) == expect(before["pb"]))

    # single-person scope reads plain 'Add group…'
    card(pick["a"]).click()          # plain click replaces the selection
    time.sleep(0.4)
    AC(t.driver).context_click(card(pick["a"])).perform()
    time.sleep(0.6)
    labels1 = js(t, r"""
      return [...document.querySelectorAll('.ctx-item')].map(x => x.textContent.trim());
    """)
    AC(t.driver).send_keys(Keys.ESCAPE).perform()
    time.sleep(0.4)
    single_ok = ("Add group…" in labels1
                 and "Add group to 2 persons…" not in labels1)

    ok = (two_ok and clicked and title == "Add a group to 2 persons"
          and typed and submitted and added_ok and single_ok)
    record("C45 face menu 'Add group…' over N persons (#184/§4.18): 2-person label + adds to both with groups kept, single scope plain",
           ok,
           f"pick={pick} before={before} two-label={two_ok} title={title!r} "
           f"after={after} (kept+added={added_ok}); single={single_ok}")


def c46_edit_dialog_group_list(t):
    """#181 (§4.38): a KNOWN name fronts the person's group list in the
    Edit dialog — the shared rows (× removal, add row); the edits stage
    locally and Accept commits them AFTER the name (a list-only Accept
    runs the chain too), landing on the SURVIVING person (the merge
    target when the name merges); a NEW name keeps the single Group
    field."""
    fresh(t)
    set_show_filter(t, "all")

    def pick_filed(exclude=()):
        return js(t, r"""
          const snap = window.__MOCK_SNAP;
          const SEATS = ['New', 'Accepted', 'Rejected'];
          const ex = arguments[0];
          const byId = new Map(snap.persons.map(p => [p.id, p]));
          for (const f of snap.faces) {
            if (f.link_status !== 'provisional' || f.person_id == null) continue;
            if (ex.includes(f.person_id)) continue;
            const p = byId.get(f.person_id);
            if (!p || /^unknown/i.test(p.name) || p.name === 'Rejected') continue;
            const real = p.groups.filter(g => !SEATS.includes(g));
            if (real.length >= 1)
              return {fid: f.id, pid: p.id, name: p.name, groups: p.groups.slice(), real};
          }
          return null;
        """, list(exclude))

    def open_dialog(fid):
        """the card's Edit… button"""
        return js(t, r"""
          const c = document.querySelector(`.face-card[data-face-id='${arguments[0]}']`);
          if (!c) return false;
          const b = [...c.querySelectorAll('button')].find(x => x.textContent.trim() === 'Edit…');
          if (!b) return false;
          b.scrollIntoView({block: 'center'});
          b.click();
          return true;
        """, fid)

    def rows():
        return js(t, r"""
          return {
            list: !!document.querySelector('.edit-dialog .ed-groups'),
            paths: [...document.querySelectorAll('.edit-dialog .ed-groups .dp-group-path')]
              .map(x => x.textContent.trim()),
            single: [...document.querySelectorAll('.edit-dialog .typeahead input')]
              .some(i => (i.placeholder ?? '').includes('ungrouped')),
          };
        """)

    def set_name(v):
        js(t, r"""
          const el = document.querySelector('.edit-dialog .typeahead input');
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, arguments[0]);
          el.dispatchEvent(new Event('input', {bubbles: true}));
        """, v)
        time.sleep(0.4)

    def click_btn(sel, text):
        return js(t, r"""
          const b = [...document.querySelectorAll(arguments[0])]
            .find(x => x.textContent.trim() === arguments[1]);
          if (!b) return false;
          b.click();
          return true;
        """, sel, text)

    def set_add(v):
        js(t, r"""
          const el = document.querySelector('.edit-dialog .dp-add-group .typeahead input');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, arguments[0]);
          el.dispatchEvent(new Event('input', {bubbles: true}));
        """, v)
        time.sleep(0.3)

    def groups_of(pid):
        return js(t, r"""
          return (window.__MOCK_SNAP.persons.find(p => p.id === arguments[0])?.groups ?? []).slice();
        """, pid)

    # ── phase A: known (prefilled) name → the list; a list-only Accept
    #    commits × the row + the added path ────────────────────────────
    a = pick_filed()
    if not a:
        record("C46 Edit dialog group list (#181/§4.38)", True,
               "need a provisional face of a filed person — vacuous")
        return
    js(t, "arguments[0].scrollIntoView({block:'center'})",
       t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{a['fid']}']"))
    time.sleep(0.3)
    opened = open_dialog(a["fid"])
    time.sleep(0.6)
    pa = rows()
    pa_ok = (opened and pa["list"] and pa["paths"] == a["groups"] and not pa["single"])
    x = t.find_element(By.CSS_SELECTOR, ".edit-dialog .ed-groups .dp-group-x")
    x.click()
    time.sleep(0.4)
    set_add("Ck46|G2")
    click_btn(".edit-dialog .dp-add-btn", "Add group")
    time.sleep(0.4)
    untouched = groups_of(a["pid"]) == a["groups"]    # staged only
    click_btn(".edit-dialog .dialog-actions button", "Accept")
    time.sleep(1.5)
    a_after = groups_of(a["pid"])
    dialog_gone = not js(t, "return !!document.querySelector('.edit-dialog')")
    a_commit_ok = (untouched and a_after == ["Ck46|G2"] and dialog_gone)

    # ── phase B: a NEW name keeps the single Group field ──────────────
    b = pick_filed(exclude=[a["pid"]])
    b_ok = None
    pb = None
    if b:
        js(t, "arguments[0].scrollIntoView({block:'center'})",
           t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{b['fid']}']"))
        time.sleep(0.3)
        open_dialog(b["fid"])
        time.sleep(0.6)
        set_name("Ck46NewPerson")
        pb = rows()
        b_ok = (not pb["list"] and pb["single"])
        click_btn(".edit-dialog .dialog-actions button", "cancel")
        time.sleep(0.4)

    # ── phase C: a name MERGE — the ops land on the target ───────────
    c = pick_filed(exclude=[a["pid"], b["pid"] if b else -1])
    c_ok = None
    c_state = {}
    if c and b:
        js(t, "arguments[0].scrollIntoView({block:'center'})",
           t.find_element(By.CSS_SELECTOR, f".face-card[data-face-id='{c['fid']}']"))
        time.sleep(0.3)
        open_dialog(c["fid"])
        time.sleep(0.6)
        set_name(a["name"])              # a KNOWN name — the list appears
        pc = rows()
        # stage on the TARGET'S list: × their row, add another
        x = t.find_element(By.CSS_SELECTOR, ".edit-dialog .ed-groups .dp-group-x")
        x.click()
        time.sleep(0.4)
        set_add("Ck46|G3")
        click_btn(".edit-dialog .dp-add-btn", "Add group")
        time.sleep(0.4)
        c_before = groups_of(a["pid"])   # still ['Ck46|G2'] — staged only
        click_btn(".edit-dialog .dialog-actions button", "Accept")
        time.sleep(1.8)
        c_after = groups_of(a["pid"])
        merged_face = js(t, r"""
          const f = window.__MOCK_SNAP.faces.find(x => x.id === arguments[0]);
          return f ? f.person_id : null;
        """, c["fid"])
        c_state = {"list": pc["list"], "before": c_before, "after": c_after, "owner": merged_face}
        c_ok = (pc["list"] and c_before == ["Ck46|G2"]
                and c_after == ["Ck46|G3"]
                and merged_face == a["pid"])   # the face landed on the TARGET

    ok = pa_ok and a_commit_ok and (b_ok is not False) and (c_ok is not False)
    record("C46 Edit dialog group list (#181/§4.38): known name fronts the list, staged ops commit on Accept (list-only too), merge ops hit the target, new name keeps the single field",
           ok,
           f"A: pick={a} rows={pa} staged-only={untouched} after={a_after} closed={dialog_gone}; "
           f"B: pick={b} → {pb} (ok={b_ok}); C: pick={c} {c_state} (ok={c_ok})")


def c47_first_run_no_database(t):
    """#185/#186 (§4.36): with NO usable database the app shows the
    first-run dialog instead of the raw error — 'No database yet' with
    Retry + Open import pane; the offer picks a folder natively and
    shows the STANDALONE import pane with --create-db pre-checked
    (--dry-run then refused by the existing combo rule), ✕ returns to
    the dialog, and once a usable database exists Retry loads the normal
    app. NOT fresh(): there are no cards to wait for — the no-DB state
    is seeded through the mock's ?no_db=1 init param."""
    t.navigate(URL + "?no_db=1")
    appeared = False
    for _ in range(30):
        time.sleep(0.4)
        if js(t, "return !!document.querySelector('.first-run .dialog')"):
            appeared = True
            break
    if not appeared:
        record("C47 first-run (#185/#186): no usable DB → dialog → standalone pane (--create-db pre-checked, combo refused) → Retry loads the app",
               False, "the first-run dialog never appeared")
        return
    d = js(t, r"""
      const dlg = document.querySelector('.first-run .dialog');
      return {
        title: dlg.querySelector('h3')?.textContent.trim() ?? '',
        buttons: [...dlg.querySelectorAll('button')].map(b => b.textContent.trim()),
        noFatal: !document.body.innerText.includes('Could not load database'),
      };
    """)
    d_ok = (d["title"] == "No database yet"
            and d["buttons"] == ["Retry", "Open import pane"]
            and d["noFatal"])

    # the offer — the native picker returns the seeded folder
    js(t, "window.__MOCK_DIALOG_PICK__ = '/mnt/rolls/first-roll';")
    js(t, r"""
      [...document.querySelectorAll('.first-run .dialog button')]
        .find(b => b.textContent.trim() === 'Open import pane').click();
    """)
    pane_up = False
    for _ in range(25):
        time.sleep(0.4)
        if js(t, "return !!document.querySelector('.first-run .import-pane')"):
            pane_up = True
            break
    p = js(t, r"""
      const el = document.querySelector('.first-run .import-pane');
      if (!el) return null;
      const labels = [...el.querySelectorAll('.import-opts label')];
      const cd = labels.find(l => l.textContent.includes('--create-db'));
      return {
        dir: el.querySelector('.import-path')?.textContent ?? null,
        hasCreateDb: !!cd,
        createDbChecked: cd ? cd.querySelector('input[type=checkbox]').checked : null,
        toggles: labels.map(l => l.textContent.trim().split(/\s+/)[0]),
      };
    """)
    pane_ok = (pane_up and p is not None
               and p["dir"] == "/mnt/rolls/first-roll"
               and p["hasCreateDb"] and p["createDbChecked"] is True)  # #185 pre-checked

    # the combo rule — reachable HERE (the option exists with no DB):
    # create-db pre-checked ⇒ --dry-run is refused up front
    js(t, r"""
      const labels = [...document.querySelectorAll('.import-opts label')];
      const l = labels.find(x => x.textContent.includes('--dry-run'));
      l.querySelector('input[type=checkbox]').click();
    """)
    time.sleep(0.4)
    combo = js(t, r"""
      const el = document.querySelector('.first-run .import-pane');
      const start = [...el.querySelectorAll('button')].find(b => b.textContent.trim() === 'start');
      return {err: !!el.querySelector('.import-error'), startDisabled: start?.disabled ?? null};
    """)
    combo_ok = combo["err"] and combo["startDisabled"]

    # ✕ back to the dialog
    js(t, "[...document.querySelectorAll('.import-head button')].find(b => b.textContent.includes('✕')).click();")
    time.sleep(0.5)
    back_ok = js(t, "return !!document.querySelector('.first-run .dialog') && !document.querySelector('.first-run .import-pane')")

    # a usable database now exists → Retry loads the normal app
    js(t, "delete window.__MOCK_NO_DB__;")
    js(t, r"""
      [...document.querySelectorAll('.first-run .dialog button')]
        .find(b => b.textContent.trim() === 'Retry').click();
    """)
    retry_ok = False
    for _ in range(30):
        time.sleep(0.4)
        if js(t, "return !!document.querySelector('.face-card') && !document.querySelector('.first-run')"):
            retry_ok = True
            break

    ok = d_ok and pane_ok and combo_ok and back_ok and retry_ok
    record("C47 first-run (#185/#186): no usable DB → dialog → standalone pane (--create-db pre-checked, combo refused) → ✕ back → Retry loads the app",
           ok,
           f"dialog={d} (ok={d_ok}); pane={p} (ok={pane_ok}); combo={combo} (ok={combo_ok}); "
           f"back={back_ok} retry={retry_ok}")


def c48_branch_rename_clash_merges(t):
    """#193 (§4.16, v3.87): renaming a branch onto a path that the SAME
    person already holds is a SILENT MERGE, not a UNIQUE-constraint
    crash — the person keeps one row at the destination, the rest of the
    branch rewrites normally, no error toast, the tree re-renders. Setup:
    a person whose ONLY group is a root branch G gets a second branch
    'ClashC48', then the whole G branch is renamed onto 'ClashC48' —
    the person's G row would collide with their kept ClashC48 row. They
    must end with exactly one row: ClashC48."""
    fresh(t)
    set_show_filter(t, "all")

    def groups_of(t, pid):
        return js(t, """
          const p = window.__MOCK_SNAP.persons.find(x => x.id === Number(arguments[0]));
          return p?.groups ?? null;
        """, pid)

    def click_ctx_item(t, label):
        time.sleep(0.4)
        clicked = js(t, r"""
          const it = [...document.querySelectorAll('.ctx-item')]
            .find(x => x.textContent.trim() === arguments[0]);
          if (!it) return null; it.click(); return true;
        """, label)
        time.sleep(0.5)
        return clicked

    def type_and_submit(t, value, label):
        # type and submit are SEPARATE script ticks — the submit closure
        # reads React state, which only lands after the input event's
        # re-render (one-tick typing would submit the stale path)
        typed = js(t, r"""
          const el = document.querySelector('.dialog input');
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, arguments[0]);
          el.dispatchEvent(new Event('input', {bubbles: true}));
          return true;
        """, value)
        time.sleep(0.4)
        submitted = js(t, r"""
          const b = [...document.querySelectorAll('.dialog-actions button')]
            .find(x => x.textContent.trim() === arguments[0]);
          if (!b) return false;
          b.click();
          return true;
        """, label)
        time.sleep(1.4)
        return typed and submitted

    # a person whose ONLY group is a root-level real branch, with a face
    # visible under Show All (so their row renders)
    pick = js(t, r"""
      const snap = window.__MOCK_SNAP;
      for (const p of snap.persons) {
        if ((p.groups?.length ?? 0) !== 1) continue;
        const g = p.groups[0];
        if (g.includes('|') || ['New', 'Accepted', 'Rejected'].includes(g)) continue;
        if ((p.counts?.total ?? 0) === 0) continue;
        if (!snap.faces.some(f => f.person_id === p.id && f.link_status !== 'rejected'))
          continue;
        return {id: p.id, name: p.name, g};
      }
      return null;
    """)
    if not pick:
        record("C48 branch rename onto a held path merges, no UNIQUE crash (#193)", True,
               "no single root-group person in the dump — vacuous")
        return
    pid, g, X = pick["id"], pick["g"], "ClashC48"

    # 1) add the second branch so the rename will collide
    js(t, r"""
      const row = document.querySelector(`.tree-person[data-person-id='${arguments[0]}']`);
      if (row) row.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 120, clientY: 300}));
      window.__C48_row = !!row;
    """, pid)
    added = (click_ctx_item(t, "Add group…")
             and type_and_submit(t, X, "add group"))
    staged = groups_of(t, pid)
    clash_ready = (isinstance(staged, list) and set(staged) == {g, X})

    # 2) rename the whole G branch onto the held path — the clash.
    # headerOf reconstructs the FULL path of a header (C23's helper) —
    # leaf names repeat across nesting ('Friends' may exist under
    # several parents), so match on the full path, never the leaf
    def hdr(code):
        return HEADER_OF + code

    HEADER_OF = r"""
      const headerOf = (h) => {
        const parts = [];
        let cur = h;
        while (cur) {
          const nm = cur.querySelector(':scope > .tree-node-name')
            ?.textContent.trim();
          if (nm == null) return null;
          parts.unshift(nm);
          const wrap = cur.parentElement;
          const pw = wrap && wrap.parentElement;
          if (!pw) break;
          const parentHeader = pw.firstElementChild;
          if (!parentHeader || !parentHeader.classList
              || !parentHeader.classList.contains('tree-node')) break;
          cur = parentHeader;
        }
        return parts.join('|');
      };
    """
    js(t, hdr(r"""
      const n = [...document.querySelectorAll('.tree-node')]
        .find(x => headerOf(x) === arguments[0]);
      if (n) n.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 80, clientY: 220}));
      window.__C48_branch = !!n;
    """), g)
    renamed = (click_ctx_item(t, "Rename/move group…")
               and type_and_submit(t, X, "move group"))
    branch_found = js(t, "return window.__C48_branch")

    after = groups_of(t, pid)
    toast = js(t, "return document.querySelector('.toast[role=alert]')?.textContent ?? null")
    src_gone = js(t, hdr(r"""
      return ![...document.querySelectorAll('.tree-node')]
        .some(x => headerOf(x) === arguments[0]);
    """), g)
    dst_branch = js(t, hdr(r"""
      return [...document.querySelectorAll('.tree-node')]
        .some(x => headerOf(x) === arguments[0]);
    """), X)
    rows = js(t, "return document.querySelectorAll(`.tree-person[data-person-id='${arguments[0]}']`).length", pid)

    # the merge: the person ends with EXACTLY the one held row
    merged = (isinstance(after, list) and after == [X])
    ok = (branch_found and added and clash_ready and renamed and merged
          and toast is None and src_gone and dst_branch and rows == 1)
    record("C48 branch rename onto a held path merges, no UNIQUE crash (#193)", ok,
           f"{pick['name']} ({pid}) in '{g}'; +{X} → {staged} (clash_ready={clash_ready}); "
           f"renamed {g}→{X}: {after} (merged={merged}); toast={toast!r}; "
           f"'{g}' gone={src_gone} '{X}' branch={dst_branch}; rows={rows} (want 1)")


def c49_step_from_empty_state(t):
    """#194 (§4.25/§4.41, v3.87): with the anchored person OUT of the
    current step list (a verdict drained them and the Show filter pruned
    them, or a Show switch hid every face) the empty centre pane says
    WHAT TO DO — it names the active filter and points at › (the bare
    'nothing to show' is gone) — and › continues from the LAST anchored
    position (clamped), not the list start. Two paths: (A) a Show switch
    prunes the anchor; (B) the §4.41 guard Close on a verdict drain.
    Faceless shells (total 0) get their own hint."""
    HINT_SHELL = ("This person has no faces — pick another person in the list, "
                  "or click › to step to the next person.")

    def step_ids(t):
        """distinct tree-list ids in display order (the step list)"""
        return js(t, r"""
          const seen = new Set(); const ids = [];
          for (const el of document.querySelectorAll('.tree-person')) {
            const id = String(el.getAttribute('data-person-id'));
            if (!seen.has(id)) { seen.add(id); ids.push(id); }
          }
          return ids;
        """)

    def click_next(t):
        b = t.find_element(By.CSS_SELECTOR,
                           ".center-toolbar .toolbar-left button[title='next person (→)']")
        b.click()
        time.sleep(1.2)

    def landed_id(t):
        return js(t, "return Number(document.querySelector('.tree-person.selected')?.getAttribute('data-person-id'))")

    def close_guard(t, label="Close"):
        return js(t, r"""
          const b = [...document.querySelectorAll('.overlay .dialog button')]
            .find(x => x.textContent.trim() === arguments[0]);
          if (!b) return false; b.click(); return true;
        """, label)

    # ── A: Show switch prunes the anchor (hint + › from last position) ──
    fresh(t)
    set_show_filter(t, "all")
    pick = js(t, r"""
      const ids = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('.tree-person')) {
        const id = String(el.getAttribute('data-person-id'));
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
      }
      const snap = window.__MOCK_SNAP;
      for (let i = 1; i < ids.length; i++) {          // i ≥ 1 so last-pos ≠ 0
        const fs = snap.faces.filter(f => f.person_id === Number(ids[i]));
        if (fs.length > 0 && fs.every(f => f.link_status === 'provisional'))
          return {id: ids[i], idx: i};
      }
      return null;
    """)
    if not pick:
        record("C49 step from an empty centre: hint + › from last anchored position (#194)", True,
               "no provisional-only person past index 0 — vacuous")
        return
    t.find_element(By.CSS_SELECTOR,
                   f".tree-person[data-person-id='{pick['id']}']").click()
    time.sleep(1.0)
    # switch to the Person tab (the anchor holds a new face — no guard)
    [b for b in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
     if "Person" in b.text][0].click()
    time.sleep(1.0)
    # Show → Accepted hides every one of the anchor's (provisional) faces
    set_show_filter(t, "confirmed")
    time.sleep(1.4)
    # the §4.41 sticky-person guard may stand in front — Close it
    guard = js(t, "return document.querySelector('.overlay .dialog h3')?.textContent.trim() ?? null")
    if guard:
        close_guard(t, "Close")
        time.sleep(0.8)
    hint_a = js(t, "return document.querySelector('.center .empty')?.textContent?.trim() ?? null")
    pos_a = js(t, "return document.querySelector('.center-toolbar .nav-pos')?.textContent?.trim() ?? null")
    newlist_a = step_ids(t)
    hint_a_ok = (hint_a == "No Accepted faces to show — pick another person in the list, "
                 "or click › to step to the next person.")
    # nav-pos reads '–/N' while the anchor is out of the list
    pruned_a = pos_a is not None and pos_a.startswith("–")
    click_next(t)
    want_a_idx = min(min(pick["idx"], len(newlist_a) - 1) + 1, len(newlist_a) - 1)
    want_a = int(newlist_a[want_a_idx]) if newlist_a else None
    landed_a = landed_id(t)
    a_ok = hint_a_ok and pruned_a and want_a is not None and landed_a == want_a

    # ── B: a verdict drain + guard Close (hint + › from last position) ──
    fresh(t)
    set_show_filter(t, "provisional")
    pick2 = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const seen = new Set(); const ids = [];
      for (const el of document.querySelectorAll('.tree-person')) {
        const id = String(el.getAttribute('data-person-id'));
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
      }
      for (let i = 1; i < ids.length; i++) {          // i ≥ 1 so last-pos ≠ 0
        const fs = snap.faces.filter(f => f.person_id === Number(ids[i]));
        if (fs.length === 1 && fs[0].link_status === 'provisional')
          return {id: ids[i], idx: i};
      }
      return null;
    """)
    b_ok = False
    detail_b = "no single-new-face person past index 0 — vacuous"
    if pick2:
        t.find_element(By.CSS_SELECTOR,
                       f".tree-person[data-person-id='{pick2['id']}']").click()
        time.sleep(1.0)
        [b for b in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
         if "Person" in b.text][0].click()
        time.sleep(1.0)
        # Description mode: the mock only clusters CONFIRMED faces, so an
        # accuracy-mode section for a provisional-only person is empty —
        # description sections are built straight from the visible faces.
        js(t, r"""
          const b = [...document.querySelectorAll('.center-toolbar .seg button')]
            .find(x => x.textContent.trim() === 'Description');
          if (b) b.click();
          window.__C49seg = !!b;
        """)
        time.sleep(0.8)
        # accept the anchor's single new face from the Person view (#177 ✓)
        # — one face ⇒ exactly one section ⇒ one section-accept button
        js(t, r"""
          const b = document.querySelector('.face-section .sec-accept');
          if (b) b.click();
          window.__C49 = !!b;
        """)
        time.sleep(2.2)
        guard2 = js(t, "return document.querySelector('.overlay .dialog h3')?.textContent.trim() ?? null")
        if guard2:
            close_guard(t, "Close")
            time.sleep(0.8)
        hint_b = js(t, "return document.querySelector('.center .empty')?.textContent?.trim() ?? null")
        newlist_b = step_ids(t)
        hint_b_ok = (hint_b == "No New faces to show — pick another person in the list, "
                    "or click › to step to the next person.")
        click_next(t)
        want_b_idx = min(min(pick2["idx"], len(newlist_b) - 1) + 1, len(newlist_b) - 1)
        want_b = int(newlist_b[want_b_idx]) if newlist_b else None
        landed_b = landed_id(t)
        b_ok = (js(t, "return window.__C49seg")
                and js(t, "return window.__C49")
                and hint_b_ok and want_b is not None and landed_b == want_b)
        detail_b = (f"drained {pick2['id']} (idx {pick2['idx']}) → hint={hint_b!r} "
                    f"(ok={hint_b_ok}); › landed {landed_b} want {want_b} (list {len(newlist_b)})")

    # ── C: a faceless shell's own hint (the §4.41 guard never fires) ──
    fresh(t)
    set_show_filter(t, "all")
    shell = js(t, r"""
      const snap = window.__MOCK_SNAP;
      for (const el of document.querySelectorAll('.tree-person')) {
        const id = Number(el.getAttribute('data-person-id'));
        const p = snap.persons.find(x => x.id === id);
        if (p && (p.counts?.total ?? 0) === 0) return id;
      }
      return null;
    """)
    c_ok = False
    detail_c = "no faceless shell in the tree — vacuous"
    if shell is not None:
        t.find_element(By.CSS_SELECTOR,
                       f".tree-person[data-person-id='{shell}']").click()
        time.sleep(1.0)
        [b for b in t.find_elements(By.CSS_SELECTOR, ".topbar nav button")
         if "Person" in b.text][0].click()
        time.sleep(1.0)
        hint_c = js(t, "return document.querySelector('.center .empty')?.textContent?.trim() ?? null")
        c_ok = (hint_c == HINT_SHELL)
        detail_c = f"shell {shell} → hint={hint_c!r} (ok={c_ok})"

    ok = a_ok and (b_ok or "vacuous" in detail_b) and (c_ok or "vacuous" in detail_c)
    record("C49 step from an empty centre: hint + › from last anchored position (#194)", ok,
           f"A show-switch: hint_ok={hint_a_ok} pruned={pruned_a} landed {landed_a} want {want_a}; "
           f"B verdict-drain: {detail_b}; C shell: {detail_c}")


def c50_merge_chips_pick_target(t):
    """#196 (§4.28): the merge-confirmation chips are selectable. Enter
    through the person context menu over a two-person selection
    (`Merge 2 persons into…`), so the dialog carries two source chips.
    Clicking a chip prefills the "Merge into" input with that person's
    name (the same resolution as the typeahead), styles it selected,
    drops it from the moving set (the summary math must match typing),
    and clicking the other chip moves the target. Esc leaves the data
    untouched."""
    fresh(t)
    pick = js(t, r"""
      const rows = [...document.querySelectorAll('.tree-person')].map(n => {
        const name = n.querySelector('.tree-name')?.textContent.trim() ?? '';
        const total = Number(n.querySelector('.tree-count.total')?.textContent ?? 0);
        return {name, total};
      }).filter(r => r.name && !/^unknown/i.test(r.name)
                    && !/^(new|accepted|rejected)$/i.test(r.name) && r.total > 0);
      if (rows.length < 2) return null;
      rows.sort((a, b) => b.total - a.total);
      return {a: rows[0], b: rows[1]};
    """)
    if pick is None:
        record("C50 merge chips: click a chip to pick the target (#196)", True,
               "need two visible named persons with faces — vacuous")
        return
    nodes = t.find_elements(By.CSS_SELECTOR, ".tree-person")
    row_a = next(e for e in nodes
                 if e.find_element(By.CSS_SELECTOR, ".tree-name").text.strip() == pick["a"]["name"])
    row_b = next(e for e in nodes
                 if e.find_element(By.CSS_SELECTOR, ".tree-name").text.strip() == pick["b"]["name"])
    row_a.click()
    time.sleep(0.5)
    AC(t.driver).key_down(Keys.CONTROL).click(row_b).key_up(Keys.CONTROL).perform()
    time.sleep(0.5)
    AC(t.driver).context_click(row_b).perform()
    time.sleep(0.6)
    items = [b for b in t.find_elements(By.CSS_SELECTOR, ".ctx-item")
             if "Merge" in b.text and "into" in b.text]
    if not items:
        AC(t.driver).send_keys(Keys.ESCAPE).perform()
        record("C50 merge chips: click a chip to pick the target (#196)", False,
               "no 'Merge … into…' menu item on the 2-person selection")
        return
    items[0].click()
    time.sleep(0.8)

    chips = t.find_elements(By.CSS_SELECTOR, ".merge-chips button.ev-chip")
    chips_ok = len(chips) == 2
    chip_a = next((c for c in chips
                   if c.text.strip().startswith(pick["a"]["name"])), None)
    chip_b = next((c for c in chips
                   if c.text.strip().startswith(pick["b"]["name"])), None)
    chips_ok = chips_ok and chip_a is not None and chip_b is not None

    # click chip A → it becomes the target
    if chips_ok:
        chip_a.click()
    time.sleep(0.6)
    st = js(t, r"""
      const inp = document.querySelector('.overlay .dialog .typeahead input');
      const chips = [...document.querySelectorAll('.merge-chips button.ev-chip')];
      const picked = chips.filter(c => c.classList.contains('merge-chip-picked'));
      const sum = document.querySelector('.overlay .dialog p.dim')?.textContent ?? '';
      const merge = [...document.querySelectorAll('.overlay .dialog button.bad')]
        .find(b => /merge/i.test(b.textContent));
      return {
        name: inp?.value ?? null,
        pickedText: picked.map(c => c.textContent.trim()),
        summary: sum,
        mergeEnabled: merge ? merge.disabled === false : null,
        pickedBg: picked.length
          ? getComputedStyle(picked[0]).backgroundColor : null,
        plainBg: chips.length > 1
          ? getComputedStyle(chips.find(c => !c.classList.contains('merge-chip-picked'))).backgroundColor : null,
      };
    """)
    a_ok = (st["name"] == pick["a"]["name"]
            and st["pickedText"] == [pick["a"]["name"] + " · " + str(pick["a"]["total"]) + "f"]
            and st["summary"].count(pick["a"]["name"]) >= 1
            and str(pick["b"]["total"]) in st["summary"]
            and "1 person" in st["summary"]
            and st["mergeEnabled"] is True
            and st["pickedBg"] and st["plainBg"] and st["pickedBg"] != st["plainBg"])

    # click chip B → the target moves
    if chips_ok:
        chip_b.click()
    time.sleep(0.6)
    st2 = js(t, r"""
      const inp = document.querySelector('.overlay .dialog .typeahead input');
      const chips = [...document.querySelectorAll('.merge-chips button.ev-chip')];
      return {
        name: inp?.value ?? null,
        picked: chips.filter(c => c.classList.contains('merge-chip-picked')).map(c => c.textContent.trim()),
      };
    """)
    b_ok = (st2["name"] == pick["b"]["name"]
            and st2["picked"] == [pick["b"]["name"] + " · " + str(pick["b"]["total"]) + "f"])

    # Esc → dialog closes, nothing merged
    AC(t.driver).send_keys(Keys.ESCAPE).perform()
    time.sleep(0.8)
    rep = js(t, r"""
      const snap = window.__MOCK_SNAP;
      const a = snap.persons.find(p => p.name === arguments[0]);
      const b = snap.persons.find(p => p.name === arguments[1]);
      return {
        dialogGone: !document.querySelector('.overlay .dialog'),
        aCount: a ? a.counts.total : null,
        bCount: b ? b.counts.total : null,
      };
    """, pick["a"]["name"], pick["b"]["name"])
    c_ok = (rep["dialogGone"] and rep["aCount"] == pick["a"]["total"]
            and rep["bCount"] == pick["b"]["total"])

    record("C50 merge chips: click a chip to pick the target (#196)",
           chips_ok and a_ok and b_ok and c_ok,
           f"chips(2)={chips_ok}; A→target ok={a_ok} {st}; B→target ok={b_ok}; "
           f"esc-untouched ok={c_ok} {rep}")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    global URL
    URL = URL.format(port=port)
    with Tester(headless=True) as t:
        t.set_window_size(1600, 1000)
        r1_layout(t)
        r2_toggle_perf(t)
        c1_enter_stages_then_commits(t)
        c2_a_key_stages_then_commits(t)
        c3_bar_accept_commits(t)
        c4_noop_apply_feedback(t)
        c5_q4_stage_model(t)
        c6_esc_ordering(t)
        c7_single_section_selectall(t)
        c8_tree_counts_ignore_filter(t)
        c9_actions_above_typeahead(t)
        c10_noop_apply_is_info(t)
        c11_merge_focuses_target(t)
        c12_face_drag_merges_into_person(t)
        c13_face_drag_copies_description(t)
        c14_drag_sources(t)
        c15_merge_dialog_scroll(t)
        c16_filter_prunes_tree(t)
        c18_rolls_path_tree(t)
        c19_staged_desc_regroups(t)
        c20_multi_group_renders_everywhere(t)
        c21_show_filter_in_topbar(t)
        c22_review_exhaust_skips_reviewed(t)
        c23_dnd_moves_one_membership(t)
        c24_dark_scheme_native_controls(t)
        c25_merge_dialog_cancel_button(t)
        c26_rolls_path_filter(t)
        c27_center_toolbar_view_matrix(t)
        c28_add_group_person_rows_only(t)
        c29_show_rejected_bin_165(t)
        c30_bar_accept_selection_over_stage(t)
        c31_rolls_import_pane(t)
        c32_full_image_follows_person(t)
        c33_person_group_list_update(t)
        c34_rolls_branch_thumbnails(t)
        c35_rolls_layout(t)
        c36_review_lock(t)
        c37_person_sticky_colors(t)
        c38_verdict_icons(t)
        c39_rename_seated_person(t)
        c40_db_status_totals(t)
        c41_verdict_focuses_person(t)
        c42_edit_label_everywhere(t)
        c43_single_only_menu_items(t)
        c44_rotate_image_cascades(t)
        c45_face_menu_add_group(t)
        c46_edit_dialog_group_list(t)
        c47_first_run_no_database(t)
        c48_branch_rename_clash_merges(t)
        c49_step_from_empty_state(t)
        c50_merge_chips_pick_target(t)

    failed = [r for r in results if not r["pass"]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("FAILED:", ", ".join(r["check"] for r in failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
