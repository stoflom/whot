// #172 (gui-design §4.38) — the person pane's staged group-list edits.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { applyGroupOps, isSeat, stageAdd, stageRemove, stageRehome, validPath } from "./groupList";

describe("applyGroupOps (#172, §4.38)", () => {
  it("no ops = the committed memberships, in order", () => {
    expect(applyGroupOps(["Family|Lombard", "Friends|PHS"], [])).toEqual([
      "Family|Lombard",
      "Friends|PHS",
    ]);
  });

  it("applies ops IN ORDER: add, re-home, remove", () => {
    expect(
      applyGroupOps(["A"], [
        { from: "", to: "B" }, // add B
        { from: "A", to: "C" }, // re-home A → C
        { from: "B", to: "" }, // remove B
      ])
    ).toEqual(["C"]);
  });

  it("a re-home onto an existing path merges the rows (backend INSERT OR IGNORE)", () => {
    expect(applyGroupOps(["A", "B"], [{ from: "A", to: "B" }])).toEqual(["B"]);
  });

  it("adding an already-present path is a no-op", () => {
    expect(applyGroupOps(["A"], [{ from: "", to: "A" }])).toEqual(["A"]);
  });

  it("a later op sees the earlier op's result (remove a just-added path)", () => {
    expect(
      applyGroupOps(["A"], [
        { from: "", to: "B" },
        { from: "B", to: "" },
      ])
    ).toEqual(["A"]);
  });
});

describe("stageAdd (#172, §4.38)", () => {
  it("stages a new membership", () => {
    expect(stageAdd([], ["A"], "B")).toEqual([{ from: "", to: "B" }]);
  });

  it("trims the typed path", () => {
    expect(stageAdd([], ["A"], "  B  ")).toEqual([{ from: "", to: "B" }]);
  });

  it("refuses duplicates against the staged display", () => {
    // staged display includes a not-yet-committed add
    expect(stageAdd([{ from: "", to: "B" }], ["A", "B"], "B")).toBeNull();
  });

  it("refuses empty and reserved-segment paths (the backend's rule, #165)", () => {
    expect(stageAdd([], ["A"], "")).toBeNull();
    expect(stageAdd([], ["A"], "   ")).toBeNull();
    expect(stageAdd([], ["A"], "New")).toBeNull();
    expect(stageAdd([], ["A"], "Family|Rejected")).toBeNull();
    expect(stageAdd([], ["A"], "Ungrouped")).toBeNull();
    expect(stageAdd([], ["A"], "Unknown")).toBeNull();
  });

  it("appends after existing staged ops (commit order preserved)", () => {
    expect(stageAdd([{ from: "A", to: "" }], ["B"], "C")).toEqual([
      { from: "A", to: "" },
      { from: "", to: "C" },
    ]);
  });
});

describe("stageRemove (#172, §4.38)", () => {
  it("stages the removal of one membership", () => {
    expect(stageRemove([], ["A", "B"], "A")).toEqual([{ from: "A", to: "" }]);
  });

  it("refuses a status seat (§4.35 — the row's × is disabled)", () => {
    expect(stageRemove([], ["New"], "New")).toBeNull();
    expect(isSeat("Accepted")).toBe(true);
    expect(isSeat("Family|Lombard")).toBe(false);
  });

  it("× on a not-yet-committed add just forgets that add", () => {
    expect(
      stageRemove([{ from: "", to: "B" }], ["A", "B"], "B")
    ).toEqual([]);
  });

  it("removing a re-homed row stages a removal of the staged target", () => {
    expect(
      stageRemove([{ from: "A", to: "C" }], ["C"], "C")
    ).toEqual([
      { from: "A", to: "C" },
      { from: "C", to: "" },
    ]);
  });

  it("refuses an unknown path", () => {
    expect(stageRemove([], ["A"], "B")).toBeNull();
  });
});

describe("stageRehome (#172, §4.38)", () => {
  it("stages the re-home of that one membership (§4.16 D&D semantics)", () => {
    expect(stageRehome([], ["A", "B"], "A", "X")).toEqual([{ from: "A", to: "X" }]);
  });

  it("editing a staged add retargets it — the row stays one add op", () => {
    expect(
      stageRehome([{ from: "", to: "B" }], ["A", "B"], "B", "C")
    ).toEqual([{ from: "", to: "C" }]);
  });

  it("refuses seats, self-edits, bad paths and unknown rows", () => {
    expect(stageRehome([], ["New"], "New", "X")).toBeNull(); // seat
    expect(stageRehome([], ["A"], "A", "A")).toBeNull(); // no-op
    expect(stageRehome([], ["A"], "A", "New|X")).toBeNull(); // reserved segment
    expect(stageRehome([], ["A"], "A", " ")).toBeNull(); // empty
    expect(stageRehome([], ["A"], "B", "X")).toBeNull(); // not in display
  });

  it("keeps earlier ops and stages the re-home after them", () => {
    expect(
      stageRehome([{ from: "", to: "B" }], ["A", "B"], "A", "C")
    ).toEqual([
      { from: "", to: "B" },
      { from: "A", to: "C" },
    ]);
  });
});

describe("validPath (#165 parity)", () => {
  it("accepts normal paths, refuses empty/reserved", () => {
    expect(validPath("Family|Lombard")).toBe(true);
    expect(validPath("  Family  ")).toBe(true);
    expect(validPath("")).toBe(false);
    expect(validPath("Rejected")).toBe(false);
    expect(validPath("a|Unknown|b")).toBe(false);
  });
});
