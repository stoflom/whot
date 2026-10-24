import { describe, expect, it } from "vitest";
import { faceDragPayload, faceMergePlan } from "./faceDrop";

// rule 34 (#135/#136) — the drag-payload rule and the face-level merge
// plan are pure: the GUI-mock harness drives the full DOM flow, these
// lock the decisions behind it.

const faces = [
  { id: 1, person_id: 10 },
  { id: 2, person_id: 10 },
  { id: 3, person_id: 20 },
  { id: 4, person_id: null },
  { id: 5, person_id: 30 },
];
const persons = [
  { id: 10, name: "Alice" },
  { id: 20, name: "Bob" },
  { id: 30, name: "Carol" },
];

describe("faceDragPayload (rule 34)", () => {
  it("an unselected card drags just itself", () => {
    expect(faceDragPayload(new Set([1, 3]), 2)).toEqual([2]);
  });
  it("a selected card in a multi-selection drags the whole selection", () => {
    expect(faceDragPayload(new Set([1, 2, 3]), 2)).toEqual([1, 2, 3]);
  });
  it("a single-card selection drags just that card", () => {
    expect(faceDragPayload(new Set([1]), 1)).toEqual([1]);
  });
  it("an empty selection drags just the dragged card", () => {
    expect(faceDragPayload(new Set<number>(), 2)).toEqual([2]);
  });
});

describe("faceMergePlan (#135)", () => {
  it("moves the payload minus the target's own faces, grouped by source", () => {
    const plan = faceMergePlan([1, 3, 5], 30, faces, persons);
    expect(plan.movers).toEqual([1, 3]);
    expect([...plan.bySource.keys()]).toEqual([10, 20]);
    expect(plan.bySource.get(10)).toEqual([1]);
    expect(plan.unowned).toEqual([]);
    // Bob loses his only face; Alice keeps face 2
    expect(plan.emptied).toEqual(["Bob"]);
  });
  it("lists every source that loses its LAST face", () => {
    const plan = faceMergePlan([1, 2, 3], 30, faces, persons);
    expect(plan.movers).toEqual([1, 2, 3]);
    expect(plan.bySource.get(10)).toEqual([1, 2]);
    expect(plan.emptied).toEqual(["Alice", "Bob"]);
  });
  it("counts unowned movers and keeps the per-person grouping", () => {
    const plan = faceMergePlan([1, 4], 30, faces, persons);
    expect(plan.movers).toEqual([1, 4]);
    expect(plan.unowned).toEqual([4]);
    expect([...plan.bySource.keys()]).toEqual([10]);
    // Alice keeps face 2
    expect(plan.emptied).toEqual([]);
  });
  it("a source losing only some faces is not emptied", () => {
    const plan = faceMergePlan([2], 30, faces, persons);
    expect(plan.movers).toEqual([2]);
    expect(plan.emptied).toEqual([]);
  });
  it("a payload entirely on the target has no movers", () => {
    const plan = faceMergePlan([5], 30, faces, persons);
    expect(plan.movers).toEqual([]);
    expect(plan.bySource.size).toBe(0);
    expect(plan.unowned).toEqual([]);
    expect(plan.emptied).toEqual([]);
  });
  it("mixed payload: only the faces off-target move", () => {
    const plan = faceMergePlan([1, 5], 30, faces, persons);
    expect(plan.movers).toEqual([1]);
    expect(plan.emptied).toEqual([]); // Alice keeps face 2
  });
  it("unknown face ids in the payload are ignored", () => {
    const plan = faceMergePlan([1, 999], 30, faces, persons);
    expect(plan.movers).toEqual([1]);
  });
});
