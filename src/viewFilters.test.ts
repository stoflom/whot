// #99 (gui-design §4.10 status filter / §4.9 Description mode).
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { stagedFieldsForCard, type Stage } from "./stage";
import {
  emptyStateHint,
  groupByDescription,
  matchesStatusFilter,
  personTreeMembers,
} from "./viewFilters";

describe("personTreeMembers (#152, rewritten by #165)", () => {
  const persons = [
    { id: 1, name: "Unknown1" }, // new only
    { id: 2, name: "Mary" }, // accepted only
    { id: 3, name: "Unknown3" }, // rejected only
    { id: 4, name: "Unknown4" }, // mixed
    { id: 5, name: "Ghost" }, // faceless shell
    { id: 6, name: "Rejected" }, // the system person (#165/§4.35)
  ];
  const faces = [
    { person_id: 1, link_status: "provisional" },
    { person_id: 2, link_status: "confirmed" },
    { person_id: 3, link_status: "rejected" },
    { person_id: 4, link_status: "provisional" },
    { person_id: 4, link_status: "confirmed" },
    { person_id: 4, link_status: "rejected" },
    { person_id: 6, link_status: "rejected" },
    { person_id: null, link_status: "provisional" }, // unowned — no person to list
  ];

  it("'all' (everything except rejected) keeps non-rejected holders + faceless shells, drops all-rejected persons and the system person", () => {
    expect(personTreeMembers(persons, faces, "all").map((p) => p.id)).toEqual([1, 2, 4, 5]);
  });

  it("'provisional' lists only persons with ≥ 1 provisional face", () => {
    expect(personTreeMembers(persons, faces, "provisional").map((p) => p.id)).toEqual([1, 4]);
  });

  it("'confirmed' lists only persons with ≥ 1 confirmed face", () => {
    expect(personTreeMembers(persons, faces, "confirmed").map((p) => p.id)).toEqual([2, 4]);
  });

  it("'rejected' lists every holder of a rejected face — incl. the system person", () => {
    expect(personTreeMembers(persons, faces, "rejected").map((p) => p.id)).toEqual([3, 4, 6]);
  });

  it("an empty face set: 'all' still lists the faceless persons (never the system person); a status filter lists nobody", () => {
    expect(personTreeMembers(persons, [], "provisional")).toEqual([]);
    expect(personTreeMembers(persons, [], "rejected")).toEqual([]);
    expect(personTreeMembers(persons, [], "all").map((p) => p.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("matchesStatusFilter (#165)", () => {
  it("'all' means every status EXCEPT rejected; the others match link_status exactly", () => {
    expect(matchesStatusFilter("provisional", "all")).toBe(true);
    expect(matchesStatusFilter("confirmed", "all")).toBe(true);
    expect(matchesStatusFilter("rejected", "all")).toBe(false);
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

  // #155: the Description-mode sections compose the §4.24 staged preview
  // into the grouping — App.tsx maps each face to its effective
  // description (staged over committed) before calling this
  it("#155: grouping over staged descriptions — a staged face moves sections live", () => {
    const committed = [
      { id: 1, description: "beard" },
      { id: 2, description: null },
      { id: 3, description: "glasses" },
    ];
    // Apply with Description=hat on face 1, and a staged clear on face 2
    const pending: Stage[] = [
      { faceIds: [1], desc: "hat" },
      { faceIds: [2], desc: "" },
    ];
    expect(
      groupByDescription(
        committed.map((f) => ({
          id: f.id,
          description: stagedFieldsForCard(pending, f.id).desc ?? f.description ?? ""
        }))
      )
    ).toEqual([
      { description: "hat", faceIds: [1] },
      { description: "glasses", faceIds: [3] },
      { description: "", faceIds: [2] }, // staged to (no description)
    ]);
    // no stages at all → committed grouping, unchanged
    expect(
      groupByDescription(
        committed.map((f) => ({
          id: f.id,
          description: stagedFieldsForCard([], f.id).desc ?? f.description ?? ""
        }))
      )
    ).toEqual([
      { description: "beard", faceIds: [1] },
      { description: "glasses", faceIds: [3] },
      { description: "", faceIds: [2] },
    ]);
  });
});

describe("emptyStateHint (#194, §4.41)", () => {
  it("a faceless shell (total 0) gets its own variant under every filter", () => {
    const msg = "This person has no faces — pick another person in the list, or click › to step to the next person.";
    for (const f of ["all", "provisional", "confirmed", "rejected"] as const)
      expect(emptyStateHint(0, f)).toBe(msg);
  });

  it("the filtered variants name the active filter and point at ›", () => {
    const tail = " pick another person in the list, or click › to step to the next person.";
    expect(emptyStateHint(3, "provisional")).toBe(`No New faces to show —${tail}`);
    expect(emptyStateHint(3, "confirmed")).toBe(`No Accepted faces to show —${tail}`);
    expect(emptyStateHint(3, "rejected")).toBe(`No Rejected faces to show —${tail}`);
    expect(emptyStateHint(3, "all")).toBe(`No faces to show —${tail}`);
  });

  it("never suggests 'set Show to All' (the §4.41 guard dialog offers it — no contradiction)", () => {
    for (const f of ["all", "provisional", "confirmed", "rejected"] as const)
      for (const total of [0, 5])
        expect(emptyStateHint(total, f)).not.toContain("Show to All");
  });
});
