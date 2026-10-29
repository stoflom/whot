// #174 (gui-design §4.39) — image selection over the branch thumbnails.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { byFilename, clickImage, emptyImageSel, imageScope } from "./imageSelect";

describe("byFilename (#174)", () => {
  it("orders by basename", () => {
    const rows = [
      { primary_path: "/b/z.jpg" },
      { primary_path: "/a/a.jpg" },
      { primary_path: "/c/a.jpg" },
    ];
    expect([...rows].sort(byFilename).map((r) => r.primary_path)).toEqual([
      "/a/a.jpg",
      "/c/a.jpg",
      "/b/z.jpg",
    ]);
  });
});

describe("clickImage — the §4.23 anchor pattern over images", () => {
  const order = [1, 2, 3, 4, 5];

  it("plain click selects just that thumb and moves the anchor", () => {
    const s = clickImage({ sel: new Set([3]), anchor: 3 }, order, 1);
    expect([...s.sel]).toEqual([1]);
    expect(s.anchor).toBe(1);
  });

  it("ctrl-click toggles; selecting moves the anchor, deselecting keeps it", () => {
    let s = clickImage(emptyImageSel(), order, 2, { ctrl: true });
    expect([...s.sel]).toEqual([2]);
    expect(s.anchor).toBe(2);
    s = clickImage(s, order, 4, { ctrl: true });
    expect([...s.sel].sort((a, b) => a - b)).toEqual([2, 4]);
    expect(s.anchor).toBe(4);
    s = clickImage(s, order, 4, { ctrl: true }); // deselect
    expect([...s.sel]).toEqual([2]);
    expect(s.anchor).toBe(4); // deselect keeps the anchor (§4.23)
  });

  it("shift-click ranges from the anchor, replaces, keeps the anchor", () => {
    let s = clickImage(emptyImageSel(), order, 2);
    s = clickImage(s, order, 4, { shift: true });
    expect([...s.sel]).toEqual([2, 3, 4]);
    expect(s.anchor).toBe(2);
    s = clickImage(s, order, 1, { shift: true }); // same anchor, other side
    expect([...s.sel]).toEqual([1, 2]);
    expect(s.anchor).toBe(2);
  });

  it("a vanished anchor falls back to a plain select (rangeSelect parity)", () => {
    const s = clickImage({ sel: new Set(), anchor: 99 }, order, 3, { shift: true });
    expect([...s.sel]).toEqual([3]);
    expect(s.anchor).toBe(3);
  });

  it("a clicked id outside the branch falls back to a plain select", () => {
    const s = clickImage({ sel: new Set(), anchor: 2 }, order, 99, { shift: true });
    expect([...s.sel]).toEqual([99]);
  });
});

describe("imageScope (§4.14 over images)", () => {
  const inBranch = new Set([1, 2, 3]);
  const branchSel = { sel: new Set([2, 3, 9]), anchor: 2 }; // 9 = stale

  it("an invoked thumb inside the selection scopes to the selection, stale ids dropped", () => {
    expect(imageScope(branchSel, inBranch, 2).sort()).toEqual([2, 3]);
  });

  it("an invoked thumb outside the selection scopes to just that thumb", () => {
    expect(imageScope(branchSel, inBranch, 1)).toEqual([1]);
    expect(imageScope(emptyImageSel(), inBranch, 1)).toEqual([1]);
  });
});
