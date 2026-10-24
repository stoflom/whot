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
    edit_and_apply(t, "GuiCheck Enter")
    assert "GuiCheck Enter" in strip_text(t), "stage strip missing after Apply"
    assert not dialog_open(t), "dialog should close on Apply"
    mid = face_by_id(t, fid)
    assert mid["person"].startswith("Unknown"), (
        f"Apply must not write (person {mid['person']})")
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


def c8_tree_counts_ignore_filter(t):
    fresh(t)
    before = tree_badges(t)
    js(t, """
      const s = [...document.querySelectorAll('select')]
        .find(x => [...x.options].some(o => o.value === 'provisional'));
      if (s) { s.value = 'provisional'; s.dispatchEvent(new Event('change', {bubbles: true})); }
    """)
    time.sleep(0.8)
    after = tree_badges(t)
    ok = before is not None and before == after
    detail = f"{len(before or [])} persons, badges { 'identical' if ok else 'CHANGED'}"
    if not ok:
        detail += f" before={before} after={after}"
    record("C8 tree badges ignore the status filter (#129)", ok, detail)


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

    failed = [r for r in results if not r["pass"]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("FAILED:", ", ".join(r["check"] for r in failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
