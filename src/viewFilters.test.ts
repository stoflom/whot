// #99 (gui-design §4.10 status filter / §4.9 Description mode).
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { filterCounts, groupByDescription, matchesStatusFilter } from "./viewFilters";
import type { PersonCounts } from "./api";

const counts: PersonCounts = { total: 10, provisional: 4, confirmed: 5, rejected: 1 };

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

describe("filterCounts", () => {
  it("'all' hands the counts back untouched", () => {
    expect(filterCounts(counts, "all")).toBe(counts);
  });

  it("a specific filter keeps only its bucket — #28 generalised", () => {
    expect(filterCounts(counts, "provisional")).toEqual({
      total: 4, provisional: 4, confirmed: 0, rejected: 0,
    });
    expect(filterCounts(counts, "confirmed")).toEqual({
      total: 5, provisional: 0, confirmed: 5, rejected: 0,
    });
    expect(filterCounts(counts, "rejected")).toEqual({
      total: 1, provisional: 0, confirmed: 0, rejected: 1,
    });
  });

  it("a person whose bucket is empty reports total 0 — it leaves the tree", () => {
    expect(filterCounts({ total: 3, provisional: 0, confirmed: 3, rejected: 0 }, "provisional").total)
      .toBe(0);
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
