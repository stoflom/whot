// #101 (gui-design §4.24) — the stage/commit model behind grid editing.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import {
  buildStage,
  objectInsideSelection,
  sameIdSet,
  scopeFaceIds,
  stageSummary,
  stagedFieldsForCard,
  stagedFieldsForSection,
  type Stage,
} from "./stage";

describe("scopeFaceIds", () => {
  const sets = { card: [1], group: [1, 2, 3], selection: [2, 4] };
  it("preselects per invocation site (§4.24): card → Card, header → Group, bar → Selection", () => {
    expect(scopeFaceIds("card", sets)).toEqual([1]);
    expect(scopeFaceIds("group", sets)).toEqual([1, 2, 3]);
    expect(scopeFaceIds("selection", sets)).toEqual([2, 4]);
  });
});

describe("buildStage (#77 routing kept)", () => {
  it("nothing touched → nothing to stage", () => {
    expect(buildStage([1], { name: "Alice", group: "", desc: "" }, { name: false, group: false, desc: false })).toBeNull();
  });

  it("an empty/untouched name means unchanged; group and desc may be cleared", () => {
    const st = buildStage([1], { name: "  ", group: "", desc: "" }, { name: true, group: true, desc: false });
    expect(st).toEqual({ faceIds: [1], group: "" });
    const st2 = buildStage([1], { name: "Alice", group: "family", desc: "" }, { name: true, group: false, desc: true });
    expect(st2).toEqual({ faceIds: [1], name: "Alice", desc: "" });
  });

  it("the stage binds the scope's faceIds (§4.24)", () => {
    expect(buildStage([7, 8], { name: "Bob", group: "", desc: "" }, { name: true, group: false, desc: false }))
      .toEqual({ faceIds: [7, 8], name: "Bob" });
  });
});

describe("label overlays (H2)", () => {
  const stage: Stage = { faceIds: [1, 2], name: "Alice", desc: "beard" };
  it("a card inside the stage shows its fields; others show nothing", () => {
    expect(stagedFieldsForCard(stage, 1)).toEqual({ name: "Alice", desc: "beard" });
    expect(stagedFieldsForCard(stage, 9)).toEqual({});
    expect(stagedFieldsForCard(null, 1)).toEqual({});
  });
  it("a header stages on any overlap", () => {
    expect(stagedFieldsForSection(stage, [2, 3])).toEqual({ name: "Alice", desc: "beard" });
    expect(stagedFieldsForSection(stage, [3])).toEqual({});
  });
});

describe("selection rules (Q1/G3)", () => {
  it("inside = any member; outside = not inside", () => {
    const sel = new Set([2, 3]);
    expect(objectInsideSelection([2], sel)).toBe(true);
    expect(objectInsideSelection([1, 2], sel)).toBe(true); // partially selected cluster
    expect(objectInsideSelection([5], sel)).toBe(false);
    expect(objectInsideSelection([], sel)).toBe(false);
  });
  it("sameIdSet compares membership order-insensitively", () => {
    expect(sameIdSet(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(sameIdSet(new Set([1]), new Set([1, 2]))).toBe(false);
  });
});

describe("stageSummary (Q4 dialog copy)", () => {
  it("names every staged field, including clears", () => {
    expect(stageSummary({ faceIds: [1], name: "Alice", group: "", desc: "beard" }))
      .toBe("name “Alice”, group → ungrouped, description “beard”");
    expect(stageSummary({ faceIds: [1], desc: "" })).toBe("description → cleared");
  });
});
