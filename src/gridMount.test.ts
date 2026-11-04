// #214 — the incremental-mount reveal rule.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import {
  GRID_MOUNT_INITIAL,
  growLimit,
  mountLimitFor,
  REVEAL_MARGIN,
} from "./gridMount";

describe("mountLimitFor (#214)", () => {
  it("grows the prefix to include the target plus the margin", () => {
    expect(mountLimitFor(100, 20, GRID_MOUNT_INITIAL)).toBe(20 + 1 + REVEAL_MARGIN);
    expect(mountLimitFor(100, 0, GRID_MOUNT_INITIAL)).toBe(GRID_MOUNT_INITIAL);
    expect(mountLimitFor(100, 30, 12)).toBe(30 + 1 + REVEAL_MARGIN);
  });

  it("clamps to the section count", () => {
    expect(mountLimitFor(8, 7, GRID_MOUNT_INITIAL)).toBe(8);
    expect(mountLimitFor(12, 3, GRID_MOUNT_INITIAL)).toBe(GRID_MOUNT_INITIAL);
  });

  it("never shrinks an already-deeper prefix", () => {
    expect(mountLimitFor(100, 5, 60)).toBe(60);
    expect(mountLimitFor(100, 50, 60)).toBe(60);
  });

  it("leaves the limit untouched for a missing target", () => {
    expect(mountLimitFor(100, -1, GRID_MOUNT_INITIAL)).toBe(GRID_MOUNT_INITIAL);
  });
});

describe("growLimit (#214)", () => {
  it("grows geometrically so deep targets converge in a few steps", () => {
    expect(growLimit(GRID_MOUNT_INITIAL)).toBe(GRID_MOUNT_INITIAL + 8);
    let n = GRID_MOUNT_INITIAL;
    for (let i = 0; i < 12; i++) n = growLimit(n);
    expect(n).toBeGreaterThanOrEqual(995);
  });

  it("never grows by less than the step", () => {
    expect(growLimit(2)).toBe(2 + 8);
    expect(growLimit(16)).toBe(16 + 8);
  });
});

// #225 (F-M4) — the same rule now windows every heavy surface: the
// person grid, the image-detail grid and the focus film roll share the
// App-owned prefix (the reveal rule stays review-only by construction —
// those effects gate on mode), and RollsThumbs windows its branch thumbs
// in-pane with its own limit (reset per branch). These tests pin the
// growth contract the new surfaces rely on.
describe("growLimit (#225 — the extended surfaces)", () => {
  it("converges on a flat 5k branch in a handful of sentinel hits", () => {
    // RollsThumbs' worst case: one flat directory, thousands of thumbs
    let n = GRID_MOUNT_INITIAL;
    let hits = 0;
    while (n < 5000) {
      n = growLimit(n);
      hits++;
    }
    expect(n).toBeGreaterThanOrEqual(5000);
    expect(hits).toBeLessThanOrEqual(16); // geometric: ~15 hits for 5k
  });

  it("the first sentinel hit already covers a small branch/person view", () => {
    // a person with a handful of sections never windowing-paints twice
    expect(growLimit(GRID_MOUNT_INITIAL)).toBeGreaterThanOrEqual(20);
  });
});
