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
  C5  selection change with a live stage asks escape-or-accept (Q4)
  C6  Esc ordering: dialog closes first, stage survives, then clears (Q8)
  C7  compact single-section keeps its select-all interaction (#108)
  R1  layout geometry + compact single-section rule (#102/#108)
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


def sel_count(t):
    return js(t, "return document.querySelectorAll('.face-card.selected').length")


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


def c5_q4_escape_or_accept(t):
    fresh(t)
    cards = t.find_elements(By.CSS_SELECTOR, ".face-card")
    idA = cards[0].get_attribute("data-face-id")
    idB = cards[1].get_attribute("data-face-id")
    cards[0].click()  # plain click sets the range anchor (#69) and selects A
    time.sleep(0.5)
    edit_and_apply(t, "GuiCheck Q4")
    AC(t.driver).key_down(Keys.SHIFT).click(cards[1]).key_up(Keys.SHIFT).perform()
    time.sleep(1.0)
    seen = q4_dialog(t)
    sel_while = sel_count(t)
    if not seen:
        record("C5 Q4 escape-or-accept", False,
               f"no confirm dialog; sel={sel_while} strip={strip_text(t)!r}")
        return
    # Esc = discard: stage dropped, pending range selection {A,B} applied
    AC(t.driver).send_keys(Keys.ESCAPE).perform()
    time.sleep(0.8)
    after = {
        "dialog": q4_dialog(t), "strip": strip_text(t),
        "sel": js(t, "return [...document.querySelectorAll('.face-card.selected')].map(c => c.getAttribute('data-face-id'))"),
    }
    ok = (not after["dialog"]) and after["strip"] == "no strip" \
         and sorted(after["sel"]) == sorted([idA, idB])
    record("C5 Q4 escape-or-accept", ok,
           f"dialog seen (sel-while={sel_while}), discard -> {after}")


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
      // #108: compact single-card sections — one-face iff .single, and
      // the compact row puts heading + card on one line (multi-card
      // sections must keep the two-row layout)
      const singles = secs.filter(s => s.querySelectorAll('.face-card').length === 1);
      const singleClassed = [...document.querySelectorAll('.face-section.single')];
      const mismatch = singleClassed.length !== singles.length
        || singles.some(s => !s.classList.contains('single'))
        || singleClassed.some(s => s.querySelectorAll('.face-card').length !== 1);
      const rowSample = (el) => {
        if (!el) return null;
        const h = el.querySelector('.face-section-header').getBoundingClientRect();
        const c = el.querySelector('.face-card').getBoundingClientRect();
        return {rowH: Math.round(el.getBoundingClientRect().height),
                sameRow: Math.abs(h.top - c.top) <= 12};
      };
      const singleSample = rowSample(document.querySelector('.face-section.single'));
      const multiSample = rowSample(secs.find(s => s.querySelectorAll('.face-card').length > 1));
      const ok = !mismatch
        && (!singleSample || singleSample.sameRow)
        && (!multiSample || !multiSample.sameRow);
      return [ok, {
        sections: secs.length,
        singleSections: singles.length,
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
        singleSample, multiSample,
      }];
    """)
    record("R1 layout + compact single sections", ok, json.dumps(rep))


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
    fid = js(t, "return document.querySelector('.face-section.single .face-card')?.getAttribute('data-face-id')")
    if fid is None:
        record("C7 single-section select-all", True,
               "no single-card sections in view — vacuous")
        return
    cb = t.find_element(By.CSS_SELECTOR, ".face-section.single .select-all input")
    cb.click()
    time.sleep(0.5)
    sel1 = js(t, "return document.querySelectorAll('.face-section.single .face-card.selected').length")
    t.find_element(By.CSS_SELECTOR, ".face-section.single .select-all input").click()
    time.sleep(0.5)
    sel2 = js(t, "return document.querySelectorAll('.face-section.single .face-card.selected').length")
    ok = sel1 == 1 and sel2 == 0
    record("C7 single-section select-all", ok,
           f"face {fid}: after 1st click={sel1}, after 2nd={sel2}")


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
        c5_q4_escape_or_accept(t)
        c6_esc_ordering(t)
        c7_single_section_selectall(t)

    failed = [r for r in results if not r["pass"]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("FAILED:", ", ".join(r["check"] for r in failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
