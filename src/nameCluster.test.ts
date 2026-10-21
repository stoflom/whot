// Unit tests for the Merge Similar Persons detection module (#88).
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import {
  clampDistance,
  classifyNames,
  clusterPersons,
  damerauLevenshtein,
  foldName,
  normalizeName,
  stripSuffixAliases,
} from "./nameCluster";
import type { Person } from "./api";

let nextId = 1;
function person(name: string, faces = 1): Person {
  return {
    id: nextId++,
    name,
    state: "created",
    note: null,
    primary_face_id: null,
    primary_pinned: 0,
    created_at: "2026-10-20 00:00:00",
    groups: [],
    counts: { total: faces, provisional: 0, confirmed: faces, rejected: 0 },
  };
}
/** fresh ids per test — clustering must be order-stable, not id-dependent */
function persons(...names: string[]): Person[] {
  nextId = 1;
  return names.map((n) => person(n));
}

describe("normalization", () => {
  it("folds case and collapses whitespace", () => {
    expect(foldName("  Winnie   Pelser ")).toBe("winnie pelser");
    expect(foldName("WINNIE PELSER")).toBe("winnie pelser");
  });

  it("strips a trailing seq suffix (#82)", () => {
    expect(normalizeName("Winnie Pelser 2")).toBe("winnie pelser");
    expect(normalizeName("Winnie Pelser 12")).toBe("winnie pelser");
    // digits inside the name are not a seq suffix
    expect(normalizeName("Bossa Nova")).toBe("bossa nova");
    expect(normalizeName("2001 A Space")).toBe("2001 a space");
  });

  it("strips alias tokens repeatedly", () => {
    const g = [["jr", "junior"], ["sr", "senior"]];
    expect(stripSuffixAliases("winnie pelser jr", g)).toBe("winnie pelser");
    expect(stripSuffixAliases("winnie pelser junior", g)).toBe("winnie pelser");
    // no alias group match — untouched
    expect(stripSuffixAliases("winnie pelser iii", g)).toBe("winnie pelser iii");
    // without groups, never strips
    expect(stripSuffixAliases("winnie pelser jr", [])).toBe("winnie pelser jr");
  });
});

describe("clampDistance", () => {
  it("clamps to 1..3 with 2 as the fallback", () => {
    expect(clampDistance(0)).toBe(1);
    expect(clampDistance(99)).toBe(3);
    expect(clampDistance(2.4)).toBe(2);
    expect(clampDistance(NaN)).toBe(2);
  });
});

describe("damerauLevenshtein (OSA)", () => {
  it("counts a transposition as ONE edit (the whole point vs plain Levenshtein)", () => {
    expect(damerauLevenshtein("pelsre", "pelser", 3)).toBe(1);
    // sanity: plain Levenshtein would score this 2
    expect(damerauLevenshtein("pelser", "pelsre", 1)).toBe(1);
  });

  it("basic substitutions / insertions / deletions", () => {
    expect(damerauLevenshtein("winnie", "winne", 3)).toBe(1); // deletion
    expect(damerauLevenshtein("winnie", "winnnie", 3)).toBe(1); // insertion
    expect(damerauLevenshtein("winnie", "lennie", 3)).toBe(2); // two subs: w→l, i→e
    expect(damerauLevenshtein("", "abc", 3)).toBe(3);
    expect(damerauLevenshtein("abc", "", 3)).toBe(3);
    expect(damerauLevenshtein("same", "same", 3)).toBe(0);
  });

  it("band cut-off returns max+1 out of range", () => {
    expect(damerauLevenshtein("abc", "xyz", 2)).toBe(3); // 3 > 2
    expect(damerauLevenshtein("abc", "xyz", 3)).toBe(3);
    expect(damerauLevenshtein("kitten", "sitting", 2)).toBe(3); // > band
    expect(damerauLevenshtein("kitten", "sitting", 3)).toBe(3);
  });
});

describe("classifyNames", () => {
  it("case/whitespace only → fold", () => {
    expect(classifyNames("Winnie Pelser", "winnie  pelser", 2, []))
      .toEqual({ kind: "fold", distance: 0 });
  });

  it("seq-suffix only → seq", () => {
    expect(classifyNames("Winnie Pelser", "Winnie Pelser 2", 2, []))
      .toEqual({ kind: "seq", distance: 0 });
  });

  it("alias tokens → alias (without them: edit or nothing)", () => {
    const g = [["jr", "junior"]];
    expect(classifyNames("W. Pelser", "W. Pelser Junior", 1, g))
      .toEqual({ kind: "alias", distance: 0 });
    // without aliases " Jr" is a 3-char insertion: below max=2, fine at 3
    expect(classifyNames("W. Pelser", "W. Pelser Jr", 2, [])).toBeNull();
    expect(classifyNames("W. Pelser", "W. Pelser Jr", 3, [])?.kind).toBe("edit");
  });

  it("single-edit misspelling → edit, two-edit respects the max", () => {
    expect(classifyNames("Winnie Pelser", "Winnie Pelsar", 2, []))
      .toEqual({ kind: "edit", distance: 1 });
    // pelserr is ONE insertion — distance 1; a real 2-edit pair:
    expect(classifyNames("Winnie Pelser", "Winnie Pelserr", 2, []))
      .toEqual({ kind: "edit", distance: 1 });
    expect(classifyNames("Winnie Pelser", "Winnie Pelsherr", 2, []))
      .toEqual({ kind: "edit", distance: 2 });
    expect(classifyNames("Winnie Pelser", "Winnie Pelsherr", 1, [])).toBeNull();
    // transposition counts as 1 (#88 rationale)
    expect(classifyNames("Winnie Pelser", "Winnie Pelsre", 1, []))
      .toEqual({ kind: "edit", distance: 1 });
  });

  it("unrelated names → null", () => {
    expect(classifyNames("Winnie Pelser", "Koos Kat", 3, [])).toBeNull();
  });
});

describe("clusterPersons", () => {
  it("clusters case/seq variants of one name into a single cluster", () => {
    const cs = clusterPersons(persons("Winnie Pelser", "WINNIE PELSER", "Winnie Pelser 2", "Koos Kat"));
    expect(cs).toHaveLength(1);
    expect(cs[0].members.map((m) => m.name)).toEqual(
      ["Winnie Pelser", "WINNIE PELSER", "Winnie Pelser 2"]);
    expect(cs[0].label).toBe("Winnie Pelser"); // first member by id
    expect(cs[0].key).toBe("winnie pelser");
    expect(cs[0].edges).toHaveLength(3); // every pair linked
  });

  it("default distance 2 catches two-edit misspellings; distance 1 does not", () => {
    // "Pelserr" is a single insertion (distance 1) — a real two-edit pair:
    // pelser -> pelsherr = insert h, insert r
    const cs2 = clusterPersons(persons("Winnie Pelser", "Winnie Pelsherr"));
    expect(cs2).toHaveLength(1);
    expect(cs2[0].edges[0]).toMatchObject({ kind: "edit", distance: 2 });
    const cs1 = clusterPersons(persons("Winnie Pelser", "Winnie Pelsherr"), { distance: 1 });
    expect(cs1).toHaveLength(0);
    // a single insertion clusters even at the strictest distance
    expect(clusterPersons(persons("Winnie Pelser", "Winnie Pelserr"), { distance: 1 })).toHaveLength(1);
  });

  it("clamps an out-of-range configured distance", () => {
    // "a" → "abcd" is distance 3: clusters at (clamped) 99→3 and at 3,
    // never at 1
    expect(clusterPersons(persons("a", "abcd"), { distance: 99 })).toHaveLength(1);
    expect(clusterPersons(persons("a", "abcd"), { distance: 3 })).toHaveLength(1);
    expect(clusterPersons(persons("a", "abcd"), { distance: 1 })).toHaveLength(0);
  });

  it("single-linkage chains: A~B, B~C clusters all three (edges explain who is linked to whom)", () => {
    // wit ~ witt (1), witt ~ witte (1), wit ~ witte (2) — all ≤ 2
    const cs = clusterPersons(persons("wit", "witt", "witte"));
    expect(cs).toHaveLength(1);
    expect(cs[0].members).toHaveLength(3);
    // edges sorted by (a, b): 1-2, 1-3, 2-3 — all three pairs present,
    // including the direct 1-3 edge the chain does not need
    const pairs = cs[0].edges.map((e) => `${e.a}-${e.b}:${e.distance}`);
    expect(pairs).toEqual(["1-2:1", "1-3:2", "2-3:1"]);
  });

  it("a chain that exceeds the max still clusters via the bridge", () => {
    // pels~pelse(1), pelse~pelserr(2), pels~pelserr(3 > max 2 → no edge)
    const cs = clusterPersons(persons("pels", "pelse", "pelserr"));
    expect(cs).toHaveLength(1);
    expect(cs[0].members).toHaveLength(3);
    expect(cs[0].edges.map((e) => `${e.a}-${e.b}`)).toEqual(["1-2", "2-3"]);
  });

  it("excludes Unknown* importer clusters (Unknown7 ~ Unknown8 would be distance 1)", () => {
    expect(clusterPersons(persons("Unknown7", "Unknown8", "Winnie", "Winni"))).toHaveLength(1);
    const cs = clusterPersons(persons("Unknown7", "Unknown8"));
    expect(cs).toHaveLength(0);
  });

  it("suffix aliases group Jr/Junior only when enabled (default off)", () => {
    const ps = persons("Winnie Pelser", "Winnie Pelser Junior");
    expect(clusterPersons(ps)).toHaveLength(0); // distance 3 > 2
    const cs = clusterPersons(ps, { suffixAliases: [["jr", "junior"]] });
    expect(cs).toHaveLength(1);
    expect(cs[0].edges[0].kind).toBe("alias");
  });

  it("zero-face members are kept but contribute nothing (issue spec)", () => {
    nextId = 1;
    const ps = [person("Winnie Pelser", 3), { ...person("Winnie Pelser 2"), counts: { total: 0, provisional: 0, confirmed: 0, rejected: 0 } }];
    const cs = clusterPersons(ps);
    expect(cs[0].members.map((m) => m.counts.total)).toEqual([3, 0]);
  });

  it("is deterministic: same input, same output (sorted members and clusters)", () => {
    const ps = persons("Bbb", "Bbb 2", "Aaa", "Aaa 2");
    const a = clusterPersons(ps);
    const b = clusterPersons([...ps].reverse());
    expect(a.map((c) => c.key)).toEqual(b.map((c) => c.key));
    expect(a[0].members.map((m) => m.id)).toEqual(b[0].members.map((m) => m.id));
  });

  it("singletons are never returned", () => {
    expect(clusterPersons(persons("Winnie Pelser", "Koos Kat", "Bart Nelles"))).toHaveLength(0);
  });
});
