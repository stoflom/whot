// #333 — the ONE APG roving-tabindex tree-key handler (extracted from
// PersonTree's treeItemKey and RollsPane's branchKey): this pins the
// shared contract at the unit level — Enter/Space activate, Up/Down
// rove, Right/Left expand/collapse (branch only), Left climbs on a
// non-expanded item. The two hosts' end-to-end wiring is covered in
// components/treeKeys.test.tsx. The handler is a pure function over
// the event + a DOM query, so the tests drive it directly.
// Run: npm test (vitest run; jsdom pragma — focus).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rovingTreeKey } from "./treeKeys";

// jsdom does not implement scrollIntoView — the handler calls it
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** a minimal keydown: the handler calls preventDefault */
function ev(key: string, shift = false) {
  const e = {
    key,
    shiftKey: shift,
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
  };
  return e as unknown as React.KeyboardEvent;
}

/** a fake tree host: the selector finds these three items */
function host() {
  const wrap = document.createElement("div");
  for (const id of ["a", "b", "c"]) {
    const el = document.createElement("button");
    el.setAttribute("data-id", id);
    wrap.appendChild(el);
  }
  document.body.appendChild(wrap);
  return wrap;
}

const at = (id: string) =>
  document.querySelector(`[data-id="${id}"]`) as HTMLElement;
const active = () => document.activeElement?.getAttribute("data-id");

const opts = {
  selector: "[data-id]",
  attr: "data-id",
  onActivate: vi.fn(),
  onToggle: vi.fn(),
  isBranch: false,
  expanded: false,
  parentKey: null,
} as const;

describe("rovingTreeKey (#333 — the shared APG tree handler)", () => {
  it("Enter and Space activate (preventDefault)", () => {
    host();
    const activate = vi.fn();
    for (const key of ["Enter", " "]) {
      const e = ev(key);
      rovingTreeKey(e, { ...opts, id: "b", onActivate: activate });
      expect(e.defaultPrevented).toBe(true);
    }
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("ArrowDown/ArrowUp rove among the items, clamped at the ends", () => {
    host();
    at("b").focus();
    rovingTreeKey(ev("ArrowDown"), { ...opts, id: "b" });
    expect(active()).toBe("c");
    rovingTreeKey(ev("ArrowDown"), { ...opts, id: "c" });
    expect(active()).toBe("c"); // clamped — no next item
    rovingTreeKey(ev("ArrowUp"), { ...opts, id: "c" });
    expect(active()).toBe("b");
    at("a").focus();
    rovingTreeKey(ev("ArrowUp"), { ...opts, id: "a" });
    expect(active()).toBe("a"); // clamped
  });

  it("Right/Left expand and collapse a BRANCH; Left climbs otherwise", () => {
    host();
    const toggle = vi.fn();
    // collapsed branch: Right expands, Left climbs to the parent
    rovingTreeKey(ev("ArrowRight"), { ...opts, id: "b", isBranch: true, expanded: false, onToggle: toggle, parentKey: "a" });
    expect(toggle).toHaveBeenCalledTimes(1);
    rovingTreeKey(ev("ArrowLeft"), { ...opts, id: "b", isBranch: true, expanded: false, onToggle: toggle, parentKey: "a" });
    expect(active()).toBe("a");
    // expanded branch: Right is a no-op, Left collapses
    rovingTreeKey(ev("ArrowRight"), { ...opts, id: "b", isBranch: true, expanded: true, onToggle: toggle, parentKey: "a" });
    expect(toggle).toHaveBeenCalledTimes(1);
    rovingTreeKey(ev("ArrowLeft"), { ...opts, id: "b", isBranch: true, expanded: true, onToggle: toggle, parentKey: "a" });
    expect(toggle).toHaveBeenCalledTimes(2);
    // a row (isBranch: false) never expands/collapses — Left climbs
    at("b").focus();
    rovingTreeKey(ev("ArrowRight"), { ...opts, id: "b", isBranch: false, expanded: false, onToggle: toggle, parentKey: "a" });
    expect(toggle).toHaveBeenCalledTimes(2);
    rovingTreeKey(ev("ArrowLeft"), { ...opts, id: "b", isBranch: false, expanded: false, onToggle: toggle, parentKey: "a" });
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(active()).toBe("a");
  });

  it("Left without a parent key is a no-op", () => {
    host();
    at("b").focus();
    rovingTreeKey(ev("ArrowLeft"), { ...opts, id: "b", isBranch: true, expanded: false, parentKey: null });
    expect(active()).toBe("b");
  });
});
