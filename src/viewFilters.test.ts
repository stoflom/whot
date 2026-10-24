// #99 (gui-design §4.10 status filter / §4.9 Description mode).
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { groupByDescription, matchesStatusFilter } from "./viewFilters";

describe("matchesStatusFilter", () => {
  it("'all' matches every status; the others match link_status exactly", () => {
    for (const s of ["provisional", "confirmed", "rejected"]) {
      expect(matchesStatusFilter(s, "all")).toBe(true);
    }
    expect(matchesStatusFilter("provisional", "provisional")).toBe(true);
    expect(matchesStatusFilter("confirmed", "confirmed")).toBe(true);
    expect(matchesStatusFilter("rejected", "rejected")).toBe(true);
    expect(matchesStatusFilter("confirmed", "provisional")).toBe(false);
    expect(matchesStatusFilter("provisional", "rejected")).toBe(false);
    expect(matchesStatusFilter("rejected", "confirmed")).toBe(false);
  });
});

describe("groupByDescription", () => {
  const faces = [
    { id: 1, description: "beard" },
    { id: 2, description: null },
    { id: 3, description: "glasses" },
    { id: 4, description: "beard" },
    { id: 5, description: null },
  ];

  it("one group per description in first-appearance order, no-description last", () => {
    expect(groupByDescription(faces)).toEqual([
      { description: "beard", faceIds: [1, 4] },
      { description: "glasses", faceIds: [3] },
      { description: "", faceIds: [2, 5] },
    ]);
  });

  it("faces without a description land in the trailing empty group", () => {
    expect(groupByDescription([{ id: 9, description: null }])).toEqual([
      { description: "", faceIds: [9] },
    ]);
  });

  it("an empty person yields no sections", () => {
    expect(groupByDescription([])).toEqual([]);
  });
});
