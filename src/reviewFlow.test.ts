// #96 (§4.30) — Review accept-&-next planning.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import type { Face, Snapshot } from "./api";
import {
  acceptAdvancePlan,
  exhaustAdvanceTarget,
  reviewStatusOf,
  verdictAdvanceTarget,
} from "./reviewFlow";

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

// #234 (gui-design rule 45) — the advance-target prefetch prediction:
// a verdict that drains the anchored person predicts the exhaust
// advance, so the caller can prefetch the target's clusters/refcrops
// in parallel with the verdict IPC.
describe("reviewStatusOf", () => {
  it("`all` reviews provisional; the other filters review themselves", () => {
    expect(reviewStatusOf("all")).toBe("provisional");
    expect(reviewStatusOf("provisional")).toBe("provisional");
    expect(reviewStatusOf("confirmed")).toBe("confirmed");
    expect(reviewStatusOf("rejected")).toBe("rejected");
  });
});

describe("verdictAdvanceTarget (#234)", () => {
  function faceOf(
    id: number,
    person: number | null,
    status: "provisional" | "confirmed" | "rejected",
  ): Face {
    return {
      id,
      image_id: 9,
      person_id: person,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      name: "",
      seq: 0,
      description: null,
      confidence: 0,
      link_status: status,
      state: "live",
      rotation: 0,
      import_id: null,
      created_at: "",
    } as Face;
  }
  // persons 3 (anchor) and 5 carry provisional faces; person 8 has
  // ONLY a confirmed face (no review candidate under `all`); 3 is
  // FIRST in the step list, 5 last
  const snap: Snapshot = {
    version: 1,
    persons: [],
    faces: [
      faceOf(1, 3, "provisional"),
      faceOf(2, 3, "provisional"),
      faceOf(8, 8, "confirmed"),
      faceOf(7, 5, "provisional"),
    ],
    images: [],
    imports: [],
    settings: {
      cluster_threshold: 0.4,
      refcrop_n: 6,
      face_filter: "all",
      cluster_group: "accuracy",
      merge_name_distance: 2,
      merge_suffix_aliases: [],
    },
  };
  // a second scenario for the status-dependent predicate: person 3's
  // faces are ALREADY confirmed, so an accept on them is a flip no-op
  // and drains them under Show=confirmed — but not under Show=all
  // (they carry no provisional face to begin with)
  const snapConfirmed: Snapshot = {
    version: 1,
    persons: [],
    faces: [
      faceOf(1, 3, "confirmed"),
      faceOf(2, 3, "confirmed"),
      faceOf(8, 8, "confirmed"),
      faceOf(7, 5, "provisional"),
    ],
    images: [],
    imports: [],
    settings: {
      cluster_threshold: 0.4,
      refcrop_n: 6,
      face_filter: "all",
      cluster_group: "accuracy",
      merge_name_distance: 2,
      merge_suffix_aliases: [],
    },
  };
  const stepIds = [3, 8, 5];

  it("a draining accept predicts the advance target", () => {
    expect(verdictAdvanceTarget(snap, stepIds, 3, 0, [1, 2], "confirmed", "all")).toBe(5);
  });

  it("a draining reject predicts the advance target too", () => {
    expect(verdictAdvanceTarget(snap, stepIds, 3, 0, [1, 2], "rejected", "all")).toBe(5);
  });

  it("a PARTIAL verdict does not drain the anchor (no target)", () => {
    expect(verdictAdvanceTarget(snap, stepIds, 3, 0, [1], "confirmed", "all")).toBeNull();
  });

  it("a verdict on ANOTHER person's faces leaves the anchor in place", () => {
    expect(verdictAdvanceTarget(snap, stepIds, 3, 0, [7], "rejected", "all")).toBeNull();
  });

  it("the drain + the advance predicate follow the review status (POST-flip face set)", () => {
    // scenario 1: 3's faces are provisional — under `all` the draining
    // accept skips person 8 (no provisional face there) and lands on 5
    expect(verdictAdvanceTarget(snap, stepIds, 3, 0, [1, 2], "confirmed", "all")).toBe(5);
    // ...and under Show=confirmed the SAME verdict does NOT drain 3 —
    // the flip leaves 1+2 as CONFIRMED faces, which the filter reviews
    expect(verdictAdvanceTarget(snap, stepIds, 3, 0, [1, 2], "confirmed", "confirmed")).toBeNull();
    // scenario 2: 3's faces are already confirmed — a REJECT flips them
    // to rejected; under Show=confirmed that drains 3 and the candidate
    // is 8 (its confirmed face), NOT 5 (a provisional face is no
    // candidate there)
    expect(verdictAdvanceTarget(snapConfirmed, stepIds, 3, 0, [1, 2], "rejected", "confirmed")).toBe(8);
    // ...and under Show=all the same reject drains 3 too (3 holds no
    // provisional face), skipping 8 and landing on 5
    expect(verdictAdvanceTarget(snapConfirmed, stepIds, 3, 0, [1, 2], "rejected", "all")).toBe(5);
    // an ACCEPT on already-confirmed faces is a flip no-op — 3 keeps
    // its confirmed faces and is never drained by it
    expect(verdictAdvanceTarget(snapConfirmed, stepIds, 3, 0, [1, 2], "confirmed", "confirmed")).toBeNull();
  });

  it("a draining verdict on the LAST person has no forward target", () => {
    expect(verdictAdvanceTarget(snap, stepIds, 5, 2, [7], "confirmed", "all")).toBeNull();
  });
});
