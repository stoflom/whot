// #96 (§4.30) — Review accept-&-next planning.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { acceptAdvancePlan, exhaustAdvanceTarget } from "./reviewFlow";

const sections = [
  { key: "rev-1", faceIds: [1, 2, 3] },
  { key: "rev-2", faceIds: [4, 5] },
  { key: "rev-3", faceIds: [6] },
];

describe("acceptAdvancePlan", () => {
  it("partial accept stays on the acted-on section with its remaining faces", () => {
    expect(acceptAdvancePlan(sections, "rev-1", [1, 2])).toEqual({
      sectionKey: "rev-1",
      faceIds: [3],
    });
  });

  it("fully accepted section hands over to the NEXT section in order", () => {
    expect(acceptAdvancePlan(sections, "rev-1", [1, 2, 3])).toEqual({
      sectionKey: "rev-2",
      faceIds: [4, 5],
    });
    expect(acceptAdvancePlan(sections, "rev-2", [4, 5])).toEqual({
      sectionKey: "rev-3",
      faceIds: [6],
    });
  });

  it("the last section clears the selection (null)", () => {
    expect(acceptAdvancePlan(sections, "rev-3", [6])).toBeNull();
  });

  it("without an anchor (or an unknown one) there is no target", () => {
    expect(acceptAdvancePlan(sections, null, [1])).toBeNull();
    expect(acceptAdvancePlan(sections, "rev-404", [1])).toBeNull();
    expect(acceptAdvancePlan([], "rev-1", [1])).toBeNull();
  });

  it("accepting faces outside the acted section does not move it", () => {
    // ids not in the acted section are simply not 'remaining' blockers
    expect(acceptAdvancePlan(sections, "rev-1", [4, 5, 1, 2, 3])).toEqual({
      sectionKey: "rev-2",
      faceIds: [4, 5],
    });
  });
});

// #159 (§4.30, v3.58) — the exhaust advance skips persons with nothing
// left to review instead of parking on the raw tree-list successor.
describe("exhaustAdvanceTarget (#159)", () => {
  const list = [10, 20, 30, 40, 50];
  const faces = new Set([30, 50]); // ids with a reviewable face
  const has = (id: number) => faces.has(id);

  it("the immediate successor is taken when they have a reviewable face", () => {
    expect(exhaustAdvanceTarget([10, 30], 10, 0, has)).toBe(30);
  });

  it("faceless/no-status successors are skipped forward", () => {
    // 11's successor 20 has nothing under `has` → skip to 30
    expect(exhaustAdvanceTarget(list, 10, 0, has)).toBe(30);
    expect(exhaustAdvanceTarget(list, 30, 2, has)).toBe(50);
  });

  it("land on nothing after the list runs out of review candidates", () => {
    expect(exhaustAdvanceTarget(list, 50, 4, has)).toBeNull();
    expect(exhaustAdvanceTarget([10, 20], 10, 0, () => false)).toBeNull();
  });

  it("the Show-filter pruning case: the marked person left the list, scan continues from the captured gap", () => {
    // 20 had the last reviewable face and was pruned; the captured index 1
    // is now the gap — the scan must continue AFTER that position
    expect(exhaustAdvanceTarget([10, 30, 40, 50], 20, 1, has)).toBe(30);
    // ...and land on the next status carrier even if the gap neighbours
    // decided people only
    expect(exhaustAdvanceTarget([10, 40, 50], 20, 1, has)).toBe(50);
  });

  it("an unlocatable mark with invalid captured index scans from the start", () => {
    expect(exhaustAdvanceTarget(list, 99, -1, has)).toBe(30);
    expect(exhaustAdvanceTarget(list, 99, -1, () => false)).toBeNull();
  });

  it("a captured index beyond the (pruned) list leaves no forward candidate", () => {
    expect(exhaustAdvanceTarget([10, 30], 99, 12, has)).toBeNull();
  });

  it("no mark, no target", () => {
    expect(exhaustAdvanceTarget(list, null, 0, has)).toBeNull();
  });
});
