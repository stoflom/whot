// #259 — the commit engine's pure core (commit.ts), co-tested like
// stage.ts / reviewFlow.ts: the #77 op routing (what one staged op
// becomes, in call order — including the batch grouping: one distinct
// owner per group-only stage, one value per description command),
// the whole-run plan (F5 gap-proof resume), the group-op owners, and
// the accept routing / advance scope.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import type { Face, Person } from "./api";
import {
  ownersForGroupOps,
  planCommit,
  planStageOps,
  remainingAfterFailure,
  reviewScope,
  routeAccept,
} from "./commit";
import { acceptAdvancePlan, type ReviewTarget } from "./reviewFlow";

const person = (id: number, name: string): Person => ({
  id,
  name,
  state: "ok",
  note: null,
  primary_face_id: null,
  primary_pinned: 0,
  created_at: "",
  groups: [],
  counts: { total: 0, provisional: 0, confirmed: 0, rejected: 0 },
});

const face = (id: number, person_id: number | null, link_status = "provisional"): Face =>
  ({
    id,
    image_id: 1,
    person_id,
    x: 0, y: 0, w: 0, h: 0,
    name: null,
    seq: 1,
    description: null,
    confidence: 1,
    link_status,
    state: "ok",
    rotation: 0,
    import_id: null,
  }) as unknown as Face;

const faces = (fs: Face[]) => new Map(fs.map((f) => [f.id, f]));
const persons = (ps: Person[]) => new Map(ps.map((p) => [p.id, p]));

describe("planStageOps (#259) — the #77 routing, in call order", () => {
  it("a NAME stage leads with assign_person; the group rides its argument", () => {
    const out = planStageOps(
      { faceIds: [1, 2], name: "Alice" },
      faces([face(1, 7), face(2, 7)]),
      persons([])
    );
    expect(out).toEqual([
      { kind: "assign", ids: [1, 2], name: "Alice", group: "" },
    ]);
  });

  it("a NAME stage with a group lands set_person_group ONLY when the target person pre-existed (F2)", () => {
    const fs = faces([face(1, 7)]);
    const ps = persons([person(9, "Smith")]);
    // name taken by person 9 — the group part must not touch assign_person
    expect(
      planStageOps({ faceIds: [1], name: "Smith", group: "family" }, fs, ps)
    ).toEqual([
      { kind: "assign", ids: [1], name: "Smith", group: "family" },
      { kind: "setPersonGroup", personId: 9, group: "family" },
    ]);
    // new name — no set_person_group (the group argument covers create)
    expect(
      planStageOps({ faceIds: [1], name: "New Name", group: "family" }, fs, ps)
    ).toEqual([
      { kind: "assign", ids: [1], name: "New Name", group: "family" },
    ]);
  });

  it("name wins over group (the original if/elseif) — a name+group stage never runs the group-only path", () => {
    const out = planStageOps(
      { faceIds: [1], name: "Alice", group: "family" },
      faces([face(1, 7)]),
      persons([])
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "assign", name: "Alice" });
  });

  it("a GROUP-ONLY stage: one cmd per DISTINCT owner (grouped by person), in first-seen order", () => {
    const fs = faces([face(1, 7), face(2, 9), face(3, 7), face(4, 9)]);
    expect(planStageOps({ faceIds: [1, 2, 3, 4], group: "family" }, fs, persons([])))
      .toEqual([
        { kind: "setPersonGroup", personId: 7, group: "family" },
        { kind: "setPersonGroup", personId: 9, group: "family" },
      ]);
  });

  it("a GROUP-ONLY stage with no writer hits the #165 defensive info branch — and desc still commits", () => {
    const fs = faces([face(1, null)]);
    const out = planStageOps({ faceIds: [1], group: "family", desc: "a|b" }, fs, persons([]));
    expect(out).toEqual([
      { kind: "info", msg: "nothing to group — these faces have no person" },
      { kind: "setDescription", ids: [1], desc: "a|b" },
    ]);
  });

  it("a DESCRIPTION stage is ONE batched command over the whole id set (#209)", () => {
    const out = planStageOps(
      { faceIds: [1, 2, 3], desc: "beard|glasses" },
      faces([face(1, 7), face(2, 9), face(3, 9)]),
      persons([])
    );
    expect(out).toEqual([
      { kind: "setDescription", ids: [1, 2, 3], desc: "beard|glasses" },
    ]);
  });

  it("name + desc: assign first, then the description command (order pinned)", () => {
    const out = planStageOps(
      { faceIds: [1], name: "Alice", desc: "d" },
      faces([face(1, 7)]),
      persons([])
    );
    expect(out.map((a) => a.kind)).toEqual(["assign", "setDescription"]);
  });
});

describe("planCommit (#259) — the whole-run plan", () => {
  const A = { faceIds: [1, 2] };
  const B = { faceIds: [2, 3], desc: "x" };

  it("no staged ops and no group edits = no run at all", () => {
    expect(planCommit([], undefined, undefined)).toBeNull();
    expect(planCommit([], [], [])).toBeNull();
  });

  it("#181: a list-only Accept (group edits only) still runs", () => {
    const plan = planCommit([], undefined, [{ from: "a", to: "b" }]);
    expect(plan).not.toBeNull();
    expect(plan!.opsLive).toBe(true);
    expect(plan!.union).toEqual([]);
  });

  it("the staged union dedups ops that overlap faces", () => {
    const plan = planCommit([A, B], undefined, undefined);
    expect(plan!.union).toEqual([1, 2, 3]);
    expect(plan!.acceptScope).toEqual([1, 2, 3]); // empty acceptIds ⇒ the union
  });

  it("the caller's displayed scope wins when non-empty (#166)", () => {
    expect(planCommit([A], [5], undefined)!.acceptScope).toEqual([5]);
    expect(planCommit([A], [], undefined)!.acceptScope).toEqual([1, 2]); // empty ⇒ fallback
  });

  it("claimed = some staged op carries a NAME (rejected faces are already claimed, §4.35)", () => {
    expect(planCommit([B], undefined, undefined)!.claimed).toBe(false);
    expect(planCommit([{ ...B, name: " Alice " }], undefined, undefined)!.claimed).toBe(true);
    // whitespace-only name claims nothing
    expect(planCommit([{ ...B, name: "  " }], undefined, undefined)!.claimed).toBe(false);
  });
});

describe("remainingAfterFailure (#259) — the F5 gap-proof resume", () => {
  const all = [{ faceIds: [1] }, { faceIds: [2] }, { faceIds: [3] }];
  it("the failed op AND everything after stays staged and retryable", () => {
    expect(remainingAfterFailure(all, 1)).toEqual([
      { faceIds: [2] },
      { faceIds: [3] },
    ]);
    // nothing applied yet ⇒ the whole set stays
    expect(remainingAfterFailure(all, 0)).toEqual(all);
    // all ops applied ⇒ nothing stays staged
    expect(remainingAfterFailure(all, 3)).toEqual([]);
  });
});

describe("ownersForGroupOps (#259) — the #181 owners", () => {
  it("the staged deltas carry the FRESH owner — later deltas win, scanned last-first", () => {
    const fs = faces([face(1, 7), face(2, 7)]);
    const deltas = [
      { faces: [{ id: 1, person_id: 9 }] },
      { faces: [{ id: 2, person_id: 11 }] },
      { faces: [{ id: 1, person_id: 13 }] }, // the claim moved face 1 again
    ];
    expect(ownersForGroupOps([1, 2], deltas as never, fs)).toEqual([13, 11]);
  });

  it("untouched faces fall back to the pre-existing snapshot; null owners never claim", () => {
    const fs = faces([face(1, 7), face(2, null)]);
    expect(ownersForGroupOps([1, 2], [], fs)).toEqual([7]);
  });

  it("dedups to one owner per distinct person (one call per op over ALL owners, #209)", () => {
    const fs = faces([face(1, 7), face(2, 7), face(3, 9)]);
    expect(ownersForGroupOps([1, 2, 3], [], fs)).toEqual([7, 9]);
  });
});

describe("routeAccept + reviewScope (#259) — the accept routing / advance", () => {
  const sections = [
    { key: "s0", faceIds: [10, 11] },
    { key: "s1", faceIds: [20] },
    { key: "s2", faceIds: [30, 31] },
  ];
  const fresh = (id: number, status = "provisional") => faces([face(id, 1, status)]);
  const rejectedOnly = (ids: number[]) => faces(ids.map((id) => face(id, 1, "rejected")));

  it("#165: an unclaimed rejected-only scope is inert with guidance", () => {
    expect(routeAccept("review", [1], rejectedOnly([1]), false, null, null, sections)).toEqual({ kind: "inert" });
    expect(routeAccept("person", [1, 2], rejectedOnly([1, 2]), false, null, null, sections)).toEqual({ kind: "inert" });
  });

  it("a claimed stage name skips the rejected-only guard (§4.35: the claim did the work)", () => {
    expect(routeAccept("review", [1], rejectedOnly([1]), true, null, null, sections)).toMatchObject({ kind: "review" });
  });

  it("the accepted scope overlaps rejected faces — still routable (not EVERY id rejected)", () => {
    const fs = faces([face(1, 1, "rejected"), face(2, 1, "provisional")]);
    expect(routeAccept("review", [1, 2], fs, false, null, null, sections)).toMatchObject({ kind: "review" });
  });

  it("#188/§4.40: outside Review the verdict is plain (no any-view widening)", () => {
    for (const mode of ["person", "rolls"] as const)
      expect(routeAccept(mode, [1], fresh(1), false, null, null, sections)).toEqual({ kind: "plain" });
  });

  it("Review: the acted key anchors on last-selected › hovered › first id (§4.25)", () => {
    expect(routeAccept("review", [10, 11], fresh(10), false, 11, 10, sections)).toMatchObject({
      kind: "review", actedKey: "s0",
    });
    const last = routeAccept("review", [20], fresh(20), false, null, null, sections);
    expect(last).toMatchObject({ kind: "review", actedKey: "s1" }); // ids[0] fallback
    const hover = routeAccept("review", [30], fresh(30), false, null, 31, sections);
    expect(hover).toMatchObject({ kind: "review", actedKey: "s2" });
  });

  it("an anchor outside every section ⇒ actedKey null ⇒ no advance at all", () => {
    const r = routeAccept("review", [10], fresh(10), false, 99, null, sections);
    expect(r).toEqual({ kind: "review", actedKey: null });
    const plan = acceptAdvancePlan(sections, (r as { actedKey: string | null }).actedKey, [10]);
    expect(plan).toBeNull();
    expect(reviewScope(plan)).toEqual({ selection: [], reveal: null });
  });

  it("the advance scope: partial accept stays on the section's REMAINING faces; a drained one hands over", () => {
    // partial: face 11 not accepted
    let plan: ReviewTarget | null = acceptAdvancePlan(sections, "s0", [10]);
    expect(reviewScope(plan)).toEqual({ selection: [11], reveal: 11 });
    // drained: hand over to the NEXT section's faces entirely
    plan = acceptAdvancePlan(sections, "s1", [20]);
    expect(reviewScope(plan)).toEqual({ selection: [30, 31], reveal: 30 });
    // last section: the advance clears the selection
    plan = acceptAdvancePlan(sections, "s2", [30, 31]);
    expect(reviewScope(plan)).toEqual({ selection: [], reveal: null });
  });
});
