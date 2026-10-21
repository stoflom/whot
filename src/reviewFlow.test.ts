// #96 (§4.30) — Review accept-&-next planning.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { acceptAdvancePlan } from "./reviewFlow";

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
