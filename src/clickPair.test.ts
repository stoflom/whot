// §4.44 (#206 stage 2) — the pane layout rules and the #191 click-pair
// decision, extracted from App for testability (pure, DOM-light).
// The wiring itself runs against the WebKitGTK window in gui-mock
// (the layout/interaction checks are the live guards).
import { describe, expect, it } from "vitest";
import { clampRollCenterFor } from "./paneState";
import { isSpuriousPair, type PairClick } from "./clickPair";

describe("clampRollCenterFor (§4.39 #174)", () => {
  const W = 1600; // left 250 → lo 160, hi min(1120, 1150) = 1120
  it("holds the 10% floor and the 70% ceiling", () => {
    expect(clampRollCenterFor(100, W, 250)).toBe(160); // below 10% → floor
    expect(clampRollCenterFor(1200, W, 250)).toBe(1120); // above 70% → ceiling
  });
  it("never lets the centre grow past window − left − 200 (the right pane's floor)", () => {
    // left pane 600: window − 600 − 200 = 800 < 70% (1120) → capped at 800
    expect(clampRollCenterFor(1500, W, 600)).toBe(800);
  });
  it("keeps the 10% floor even when a wide left pane would push hi below lo", () => {
    // left 1400: window − 1400 − 200 = 0 < lo → the floor wins
    expect(clampRollCenterFor(2000, W, 1400)).toBe(160);
  });
  it("keeps an in-range value as-is", () => {
    expect(clampRollCenterFor(500, W, 250)).toBe(500);
  });
  it("rounds the 10%/70% window shares (Math.round)", () => {
    const w = 1001;
    expect(clampRollCenterFor(0, w, 0)).toBe(Math.round(w * 0.1));
    expect(clampRollCenterFor(99999, w, 0)).toBe(
      Math.max(Math.min(Math.round(w * 0.7), w - 200), Math.round(w * 0.1))
    );
  });
});

// --------------------------------------------------- #191 decision rule

describe("isSpuriousPair (#191)", () => {
  // Element stubs carrying only the `contains` relation the rule reads —
  // jsdom-free (vitest runs in node)
  const guardEl: { contains: (o: unknown) => boolean } = {
    contains: () => false,
  };
  const child = { contains: (_o: unknown): boolean => false }; // descendant of guardEl
  guardEl.contains = (o) => o === child;
  const ancestor = { contains: (o: unknown): boolean => o === guardEl }; // ancestor of guardEl
  const stranger = { contains: () => false };

  const rec = {
    el: guardEl as unknown as Element,
    x: 400,
    y: 300,
    t: 1000,
  };
  const click = (over: Partial<PairClick> = {}): PairClick => ({
    target: guardEl as unknown as Element,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    clientX: 400,
    clientY: 300,
    ...over,
  });

  it("swallows the plain member click of the pair (same element, same spot)", () => {
    expect(isSpuriousPair(rec, click(), 2000)).toBe(true);
  });
  it("covers the pair hitting a descendant or ancestor of the right-clicked element", () => {
    expect(isSpuriousPair(rec, click({ target: child as unknown as Element }), 2000)).toBe(true);
    expect(isSpuriousPair(rec, click({ target: ancestor as unknown as Element }), 2000)).toBe(true);
  });
  it("never swallows a click at another spot beyond the 5px tolerance", () => {
    expect(isSpuriousPair(rec, click({ clientX: 395, clientY: 300 }), 2000)).toBe(true); // ≤5 both
    expect(isSpuriousPair(rec, click({ clientX: 394, clientY: 300 }), 2000)).toBe(false); // 6 off
    expect(isSpuriousPair(rec, click({ clientY: 306 }), 2000)).toBe(false);
  });
  it("honours the 3 s sanity bound (at 3000 ms it still counts; past it not)", () => {
    expect(isSpuriousPair(rec, click(), 4000)).toBe(true); // exactly 3000 — not > 3000
    expect(isSpuriousPair(rec, click(), 4001)).toBe(false);
  });
  it("passes modifier clicks through untouched (a real user's chords)", () => {
    expect(isSpuriousPair(rec, click({ ctrlKey: true }), 2000)).toBe(false);
    expect(isSpuriousPair(rec, click({ metaKey: true }), 2000)).toBe(false);
    expect(isSpuriousPair(rec, click({ shiftKey: true }), 2000)).toBe(false);
    expect(isSpuriousPair(rec, click({ altKey: true }), 2000)).toBe(false);
  });
  it("never touches non-left buttons (the contextmenu itself included)", () => {
    expect(isSpuriousPair(rec, click({ button: 2 }), 2000)).toBe(false);
    expect(isSpuriousPair(rec, click({ button: 1 }), 2000)).toBe(false);
  });
  it("without a guard record there is nothing to swallow", () => {
    expect(isSpuriousPair(null, click(), 2000)).toBe(false);
  });
  it("an unrelated element is a genuine user click — not the pair", () => {
    expect(isSpuriousPair(rec, click({ target: stranger as unknown as Element }), 2000)).toBe(false);
  });
});
