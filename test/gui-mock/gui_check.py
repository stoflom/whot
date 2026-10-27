#!/usr/bin/env python3
"""WhoT GUI contract checks against the mocked Tauri backend (test/gui-mock).

Requires:
    1. npm run build                  (dist/ current)
    2. python3 dump_snap.py           (snap.json current)
    3. python3 server.py &            (mock server up, default :8123)

Then:
    python3 gui_check.py [PORT]

Each check starts from a fresh page load, which reloads /snap.json, so the
in-memory mock state is clean per check. Interaction uses trusted input
(Marionette actions); synthetic events are unreliable for the app's window
key listeners.

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
  R1  layout geometry: heading above cards in every section (#120),
      empty labels are dimmed hints with normal row height (#119)
  R2  selection-toggle render time (informational, §4.31/#109)

Exit code 0 iff all C-checks and the R1 layout rule pass.
"""
import json
import sys
import time

try:
    sys.path.insert(0, "/home/stoflom/.pi/agent/skills/firefox-testing")
    from firefox_tester import FirefoxTester
except ImportError as e:
    sys.exit(f"firefox-testing skill not importable: {e}\n"
             f"(expected at /home/stoflom/.pi/agent/skills/firefox-testing)")

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
     if b.text.strip() == "Accept"][0].click()
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
          return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() =>
            res(Math.round((performance.now() - t0) * 10) / 10))));
        """, i))
    record("R2 selection-toggle render ms", True, str(times))


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


def set_show_filter(t, value):
    """flip the top-bar Show filter (§4.10) to `value` and wait for the refetch"""
    js(t, """
      const s = [...document.querySelectorAll('select')]
        .find(x => [...x.options].some(o => o.value === arguments[0]));
      if (s) { s.value = arguments[0]; s.dispatchEvent(new Event('change', {bubbles: true})); }
    """, value)
    time.sleep(0.8)


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
    the Show tooltip spells the contract out."""
    fresh(t)
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
     if b.text.strip() == "Accept"][0].click()
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
    """#161 (v3.60): the Rolls pane is a filesystem-path tree — branch
    headers mirror the primary_path segments (collapsed at start), every
    image is filed under its own file's directory branch once expanded,
    and Show=New prunes images/branches without a provisional face."""
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
    # drill in: expand every closed header until none is left
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
    # every image renders exactly under its own primary_path
    thumbs = js(t, """
      return [...document.querySelectorAll('.img-thumb')].map(b => b.title);
    """)
    all_paths = js(t, "return window.__MOCK_SNAP.images.map(i => i.primary_path)")
    open_ok = sorted(thumbs) == sorted(all_paths)
    # Show=New (branches stay open): only images holding a provisional
    # face survive, elsewhere pruned
    set_show_filter(t, "provisional")
    time.sleep(0.8)
    thumbs_new = js(t, """
      return [...document.querySelectorAll('.img-thumb')].map(b => b.title);
    """)
    expected_new = js(t, """
      const ids = new Set(window.__MOCK_SNAP.faces
        .filter(f => f.link_status === 'provisional').map(f => f.image_id));
      return window.__MOCK_SNAP.images.filter(i => ids.has(i.id)).map(i => i.primary_path);
    """)
    prune_ok = sorted(thumbs_new) == sorted(expected_new)
    set_show_filter(t, "all")
    ok = headers0 == top and open_ok and prune_ok
    record("C18 Rolls pane mirrors the filesystem path tree, Show prunes (#161)", ok,
           f"top-level headers={headers0} (expected {top}); fully expanded "
           f"thumbs={len(thumbs)}/{len(all_paths)} exact={open_ok}; Show=New "
           f"thumbs={len(thumbs_new)}/{len(expected_new)} exact={prune_ok}")


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
     if b.text.strip() == "Accept"][0].click()
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
       (dst_sel). Marionette's trusted mouse events do not raise HTML5 DnD
       in headless Firefox, so the drag events are dispatched with a
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
           if b.text.strip() == "Accept"]
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


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    global URL
    URL = URL.format(port=port)
    with FirefoxTester(headless=True) as t:
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

    failed = [r for r in results if not r["pass"]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("FAILED:", ", ".join(r["check"] for r in failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
