// #99 (gui-design §4.10 status filter / §4.9 Description mode).
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import {
  groupByDescription,
  matchesStatusFilter,
  personTreeMembers,
  removableUnknownShellIds,
} from "./viewFilters";

describe("removableUnknownShellIds (#154, v3.54)", () => {
  const persons = [
    { id: 10, name: "Unknown1" }, // provisional remains
    { id: 11, name: "Unknown2" }, // all decided
    { id: 12, name: "Unknown3" }, // faceless (the §4.27 sweep keeps it out of the snapshot anyway)
    { id: 13, name: "Mary" }, // named — never a target
    { id: 14, name: "Unknown-hat" }, // Unknown-prefixed but not UnknownN — still a target (GLOB 'Unknown*' rule)
  ];
  const faces = [
    { person_id: 10, link_status: "provisional" },
    { person_id: 11, link_status: "rejected" },
    { person_id: 12, link_status: "confirmed" }, // arms an Unknown, same rule as 'rejected'
    { person_id: 13, link_status: "rejected" },
  ];

  it("removes only Unknowns with zero New and zero Accepted faces — no filter argument", () => {
    expect(removableUnknownShellIds(persons, faces)).toEqual([11, 14]);
    expect(removableUnknownShellIds(persons, [])).toEqual([10, 11, 12, 14]);
  });

  it("named persons are never targets", () => {
    expect(removableUnknownShellIds(persons, faces)).not.toContain(13);
  });
});

describe("personTreeMembers (#152)", () => {
  const persons = [
    { id: 1 }, // new only
    { id: 2 }, // accepted only
    { id: 3 }, // rejected only
    { id: 4 }, // mixed
    { id: 5 }, // faceless shell
  ];
  const faces = [
    { person_id: 1, link_status: "provisional" },
    { person_id: 2, link_status: "confirmed" },
    { person_id: 3, link_status: "rejected" },
    { person_id: 4, link_status: "provisional" },
    { person_id: 4, link_status: "confirmed" },
    { person_id: 4, link_status: "rejected" },
    { person_id: null, link_status: "provisional" }, // unowned — no person to list
  ];

  it("'all' lists every person, including faceless shells", () => {
    expect(personTreeMembers(persons, faces, "all")).toEqual(persons);
  });

  it("'provisional' lists only persons with ≥ 1 provisional face", () => {
    expect(personTreeMembers(persons, faces, "provisional").map((p) => p.id)).toEqual([1, 4]);
  });

  it("'confirmed' lists only persons with ≥ 1 confirmed face", () => {
    expect(personTreeMembers(persons, faces, "confirmed").map((p) => p.id)).toEqual([2, 4]);
  });

  it("'rejected' lists only persons with ≥ 1 rejected face", () => {
    expect(personTreeMembers(persons, faces, "rejected").map((p) => p.id)).toEqual([3, 4]);
  });

  it("an empty face set under a non-all filter lists nobody but persons survive under 'all'", () => {
    expect(personTreeMembers(persons, [], "provisional")).toEqual([]);
    expect(personTreeMembers(persons, [], "all")).toEqual(persons);
  });
});

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
