// #101 (gui-design §4.24) — the stage/commit model behind grid editing.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import {
  addTokens,
  applyAdd,
  buildStage,
  dropStagesForFaces,
  expandAddStage,
  indexStagedSet,
  objectInsideSelection,
  sameIdSet,
  scopeFaceIds,
  stageSummary,
  stageSummarySet,
  stagedFieldsForCard,
  stagedFieldsForIndex,
  stagedFieldsForSection,
  stagedFieldsForSectionIndex,
  upsertStage,
  prefillForFaces,
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

describe("the pending set (#123)", () => {
  it("upsert extends the set; a re-Apply on the same faceIds replaces that op (latest wins)", () => {
    const a: Stage = { faceIds: [1, 2], name: "Alice" };
    const b: Stage = { faceIds: [3], desc: "beard" };
    expect(upsertStage([], a)).toEqual([a]);
    expect(upsertStage([a], b)).toEqual([a, b]);
    const c: Stage = { faceIds: [2, 1], desc: "glasses" };
    const set = upsertStage([a, b], c);
    expect(set).toHaveLength(2);
    expect(set[0]).toEqual(c); // replaced in place, order kept
    expect(set[1]).toEqual(b);
  });
  it("dropStagesForFaces drops every op touching a rejected face (F2)", () => {
    const a: Stage = { faceIds: [1, 2], name: "Alice" };
    const b: Stage = { faceIds: [3], desc: "beard" };
    expect(dropStagesForFaces([a, b], [2])).toEqual([b]);
    expect(dropStagesForFaces([a, b], [])).toEqual([a, b]);
  });
  it("stagedFieldsForCard merges covering ops, later ops win", () => {
    const a: Stage = { faceIds: [1], name: "Alice", desc: "beard" };
    const b: Stage = { faceIds: [1], desc: "glasses" };
    expect(stagedFieldsForCard([a, b], 1)).toEqual({ name: "Alice", desc: "glasses" });
    expect(stagedFieldsForCard([a, b], 9)).toEqual({});
    expect(stagedFieldsForCard([], 1)).toEqual({});
  });
  it("stageSummarySet names every op and the total face count", () => {
    const a: Stage = { faceIds: [1, 2], name: "Alice" };
    const b: Stage = { faceIds: [2, 3], desc: "beard" };
    expect(stageSummarySet([a, b]))
      .toBe("name “Alice” · 2 face(s)  /  description “beard” · 2 face(s) — 3 face(s) staged");
    expect(stageSummarySet([])).toBe("");
  });
});

describe("prefillForFaces (#199 — the prefill is what the cards show)", () => {
  const committed = (id: number) => {
    const map: Record<number, { name: string; group: string; desc: string }> = {
      1: { name: "Alice", group: "Family", desc: "beard" },
      2: { name: "Alice", group: "Family", desc: "glasses" },
      3: { name: "Bob", group: "Friends", desc: "" },
    };
    return map[id];
  };

  it("uniform committed values prefill as-is (no pending set)", () => {
    expect(prefillForFaces([1], committed, [])).toEqual({
      name: "Alice",
      group: "Family",
      desc: "beard",
    });
    expect(prefillForFaces([], committed, [])).toEqual({});
  });

  it("the staged overlay wins over the committed value (the Apply → re-Edit loop)", () => {
    const set: Stage[] = [{ faceIds: [1], desc: "beard|glasses" }];
    const p = prefillForFaces([1], committed, set);
    expect(p.desc).toBe("beard|glasses");
    expect(p.name).toBe("Alice");
    expect(p.group).toBe("Family");
    expect(p.mixed).toBeUndefined();
  });

  it("a staged group of '' (ungrouped) overlays the committed group", () => {
    const set: Stage[] = [{ faceIds: [1], group: "" }];
    expect(prefillForFaces([1], committed, set).group).toBe("");
  });

  it("later ops win when two stages cover the same face", () => {
    const set: Stage[] = [
      { faceIds: [1], desc: "one" },
      { faceIds: [1], desc: "one|two" },
    ];
    expect(prefillForFaces([1], committed, set).desc).toBe("one|two");
  });

  it("mixed faces ⇒ NO value for that field, just the mixed flag (never a literal)", () => {
    const p = prefillForFaces([1, 2], committed, []);
    expect(p.desc).toBeUndefined();
    expect(p.mixed).toEqual(["desc"]);
    expect(p.name).toBe("Alice");
  });

  it("a staged overlay can REMOVE a disagreement (uniform after staging)", () => {
    const set: Stage[] = [{ faceIds: [1, 2], desc: "same" }];
    expect(prefillForFaces([1, 2], committed, set)).toEqual({
      name: "Alice",
      group: "Family",
      desc: "same",
    });
  });

  it("disagreeing persons ⇒ mixed name + group together", () => {
    const p = prefillForFaces([1, 3], committed, []);
    expect(p.name).toBeUndefined();
    expect(p.group).toBeUndefined();
    expect(p.desc).toBeUndefined();
    expect(p.mixed).toEqual(["name", "group", "desc"]);
  });
});

describe("label overlays (H2)", () => {
  const stage: Stage = { faceIds: [1, 2], name: "Alice", desc: "beard" };
  it("a card inside the set shows its fields; others show nothing", () => {
    expect(stagedFieldsForCard([stage], 1)).toEqual({ name: "Alice", desc: "beard" });
    expect(stagedFieldsForCard([stage], 9)).toEqual({});
    expect(stagedFieldsForCard([], 1)).toEqual({});
  });
  it("a header stages on any overlap", () => {
    expect(stagedFieldsForSection([stage], [2, 3])).toEqual({ name: "Alice", desc: "beard" });
    expect(stagedFieldsForSection([stage], [3])).toEqual({});
  });
});

describe("indexStagedSet (#224 — the pending set indexed once per change)", () => {
  // ops chosen to exercise every merge corner: multi-face ops, a cleared
  // group (''), a later op overriding one field only, a face under three ops
  const ops: Stage[] = [
    { faceIds: [1, 2], name: "Alice", desc: "beard" },
    { faceIds: [2, 3], group: "" },
    { faceIds: [3], desc: "glasses" },
    { faceIds: [1], name: "Alicia" }, // later op wins the name on face 1
  ];

  it("per-face lookups equal stagedFieldsForCard for every face (later ops win)", () => {
    const idx = indexStagedSet(ops);
    for (const id of [1, 2, 3, 9]) {
      expect(stagedFieldsForIndex(idx, id)).toEqual(stagedFieldsForCard(ops, id));
    }
    expect(stagedFieldsForIndex(idx, 1)).toEqual({ name: "Alicia", desc: "beard" });
    expect(stagedFieldsForIndex(idx, 2)).toEqual({ name: "Alice", desc: "beard", group: "" });
    expect(stagedFieldsForIndex(idx, 3)).toEqual({ desc: "glasses", group: "" });
    expect(stagedFieldsForIndex(idx, 9)).toEqual({});
  });

  it("every section subset merges identically to stagedFieldsForSection — in either id order", () => {
    const idx = indexStagedSet(ops);
    const universe = [1, 2, 3, 4];
    // all 2^4 subsets: the section merge must not depend on the ids'
    // order (the old scan merged in OP order; the index reproduces that
    // via the winning-op position, not the face order)
    for (let mask = 0; mask < 1 << universe.length; mask++) {
      const ids = universe.filter((_, i) => mask & (1 << i));
      expect(stagedFieldsForSectionIndex(idx, ids))
        .toEqual(stagedFieldsForSection(ops, ids));
      expect(stagedFieldsForSectionIndex(idx, [...ids].reverse()))
        .toEqual(stagedFieldsForSection(ops, ids));
    }
  });

  it("an op covering a section face stages the whole heading — fields aimed at any of its faces included", () => {
    // the merge is per OP, not per face: the index must reproduce it
    const set: Stage[] = [{ faceIds: [1, 2], name: "Alice" }];
    const idx = indexStagedSet(set);
    expect(stagedFieldsForSectionIndex(idx, [2, 3])).toEqual({ name: "Alice" });
    expect(stagedFieldsForSection(set, [2, 3])).toEqual({ name: "Alice" });
  });

  it("a later op that does not set a field keeps the earlier op's value (per face and per section)", () => {
    const set: Stage[] = [
      { faceIds: [1], name: "Alice" },
      { faceIds: [1, 2], group: "" },
    ];
    const idx = indexStagedSet(set);
    expect(stagedFieldsForIndex(idx, 1)).toEqual({ name: "Alice", group: "" });
    expect(stagedFieldsForSection(set, [1, 2])).toEqual({ name: "Alice", group: "" });
    expect(stagedFieldsForSectionIndex(idx, [1, 2])).toEqual(
      stagedFieldsForSection(set, [1, 2])
    );
  });

  it("the lookup is a map read — the structure carries the cost once, not per lookup", () => {
    // the acceptance's API-level equivalent: the index is a Map keyed by
    // face id, built in ONE pass over the ops; a lookup touches one
    // entry regardless of how many ops or faces the set holds
    const big: Stage[] = Array.from({ length: 500 }, (_, i) => ({
      faceIds: [i, i + 1],
      desc: `d${i}`,
    }));
    const idx = indexStagedSet(big);
    expect(idx).toBeInstanceOf(Map);
    expect(idx.size).toBe(501); // one entry per distinct face — nothing per-lookup
    expect(stagedFieldsForIndex(idx, 250)).toEqual({ desc: "d250" }); // later op wins
    expect(stagedFieldsForIndex(idx, 0)).toEqual({ desc: "d0" });
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

describe("stageSummary (dialog copy)", () => {
  it("names every staged field, including clears", () => {
    expect(stageSummary({ faceIds: [1], name: "Alice", group: "", desc: "beard" }))
      .toBe("name “Alice”, group → ungrouped, description “beard”");
    expect(stageSummary({ faceIds: [1], desc: "" })).toBe("description → cleared");
  });
});

describe("add mode `+` (#231, §4.24)", () => {
  it("addTokens: only `+`-prefixed values yield tokens — split on |, trimmed, empties dropped", () => {
    expect(addTokens("+beard")).toEqual(["beard"]);
    expect(addTokens("+beard|glasses ")).toEqual(["beard", "glasses"]);
    expect(addTokens("+ beard | |scarf")).toEqual(["beard", "scarf"]);
    expect(addTokens("beard|+glasses")).toEqual([]); // prefix only at the start
    expect(addTokens("beard")).toEqual([]);
    expect(addTokens("+")).toEqual([]);
    expect(addTokens("")).toEqual([]);
  });

  it("applyAdd: existing order kept, new tokens in typed order, NO duplicates", () => {
    expect(applyAdd("", ["beard"])).toBe("beard");
    expect(applyAdd("red_hair|blue_eyes", ["beard"])).toBe("red_hair|blue_eyes|beard");
    expect(applyAdd("beard", ["beard"])).toBe("beard"); // already there — no-op
    expect(applyAdd("beard|glasses", ["glasses", "beard", "scarf"])).toBe("beard|glasses|scarf");
    expect(applyAdd("  ", ["beard"])).toBe("beard"); // whitespace is not a token
  });

  it("buildStage: a lone `+` (no tokens) never stages — the 'nothing to apply' path", () => {
    expect(
      buildStage([1], { name: " ", group: "", desc: "+" }, { name: true, group: false, desc: true })
    ).toBeNull();
    expect(
      buildStage([1], { name: " ", group: "", desc: "+ | " }, { name: true, group: false, desc: true })
    ).toBeNull();
    // a `+` value WITH tokens still stages (the expansion happens at Apply)
    expect(
      buildStage([1], { name: " ", group: "", desc: "+beard" }, { name: false, group: false, desc: true })
    ).toEqual({ faceIds: [1], desc: "+beard" });
  });

  const shown = (map: Record<number, string>) => (id: number) => map[id] ?? "";

  it("expandAddStage: each face resolves against its displayed value; no-op faces drop out", () => {
    const st: Stage = { faceIds: [1, 2, 3, 4], desc: "+beard" };
    const d = shown({ 1: "beard", 2: "glasses", 3: "beard|glasses", 4: "" });
    expect(expandAddStage(st, d)).toEqual([
      { faceIds: [2], desc: "glasses|beard" },
      { faceIds: [4], desc: "beard" },
    ]);
    // face 1 already has it, face 3 already has it — untouched (no re-seq churn)
  });

  it("expandAddStage: a uniform result collapses to the original single stage", () => {
    const st: Stage = { faceIds: [1, 2], desc: "+beard" };
    expect(expandAddStage(st, shown({ 1: "", 2: "" }))).toEqual([
      { faceIds: [1, 2], desc: "beard" },
    ]);
  });

  it("expandAddStage: every face a no-op and no field part → null (nothing to apply)", () => {
    const st: Stage = { faceIds: [1, 2], desc: "+beard" };
    expect(expandAddStage(st, shown({ 1: "beard", 2: "beard|hat" }))).toBeNull();
  });

  it("expandAddStage: a name/group part rides its own stage over the full id set", () => {
    const st: Stage = { faceIds: [1, 2], name: "Alice", desc: "+beard" };
    expect(expandAddStage(st, shown({ 1: "beard", 2: "glasses" }))).toEqual([
      { faceIds: [1, 2], name: "Alice" },
      { faceIds: [2], desc: "glasses|beard" },
    ]);
  });

  it("expandAddStage: a uniform add WITH a field part keeps the single-stage shape", () => {
    const st: Stage = { faceIds: [1, 2], group: "Family", desc: "+beard" };
    expect(expandAddStage(st, shown({ 1: "", 2: "" }))).toEqual([
      { faceIds: [1, 2], group: "Family", desc: "beard" },
    ]);
  });

  it("expandAddStage: a non-add stage passes through untouched", () => {
    const st: Stage = { faceIds: [1], desc: "beard|glasses" };
    expect(expandAddStage(st, shown({ 1: "beard" }))).toEqual([st]);
  });

  it("expandAddStage: multi-token adds keep typed order after each face's own list", () => {
    const st: Stage = { faceIds: [1, 2], desc: "+scarf|beard" };
    expect(expandAddStage(st, shown({ 1: "beard", 2: "" }))).toEqual([
      { faceIds: [1], desc: "beard|scarf" },
      { faceIds: [2], desc: "scarf|beard" },
    ]);
  });
});
