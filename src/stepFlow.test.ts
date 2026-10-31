// #194 (gui-design §4.25) — where a ‹ › step starts when the anchored
// person is not in the current step list. Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { stepBase } from "./stepFlow";

describe("stepBase (#194, §4.25)", () => {
  it("the anchored person's position wins (every precedence above it moot)", () => {
    expect(stepBase(2, 0, 4, 10)).toBe(2);
    expect(stepBase(0, -1, -1, 10)).toBe(0);
    expect(stepBase(9, 3, 0, 10)).toBe(9);
  });

  it("no anchor: the person under the cursor anchors the step (#76, even over the remembered position)", () => {
    expect(stepBase(-1, 3, 0, 10)).toBe(3);
    expect(stepBase(-1, 8, 2, 10)).toBe(8);
  });

  it("no anchor, cursor over no person row: the last anchored position, clamped to a shrunken list", () => {
    expect(stepBase(-1, -1, 5, 10)).toBe(5);
    // the anchor was pruned on the last verdict (§4.10): the remembered
    // index outruns the list — clamp, never jump to start/end
    expect(stepBase(-1, -1, 5, 4)).toBe(3);
    expect(stepBase(-1, -1, 99, 1)).toBe(0);
  });

  it("no person ever anchored (lastPos -1): -1 — the caller keeps the historical start/end fallback", () => {
    expect(stepBase(-1, -1, -1, 10)).toBe(-1);
    expect(stepBase(-1, -1, -1, 1)).toBe(-1);
  });

  it("an empty list has no base at all", () => {
    expect(stepBase(-1, -1, 3, 0)).toBe(-1);
    expect(stepBase(-1, -1, -1, 0)).toBe(-1);
  });
});
