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
    expect(foldName("  John   Smith ")).toBe("john smith");
    expect(foldName("JOHN SMITH")).toBe("john smith");
  });

  it("strips a trailing seq suffix (#82)", () => {
    expect(normalizeName("John Smith 2")).toBe("john smith");
    expect(normalizeName("John Smith 12")).toBe("john smith");
    // digits inside the name are not a seq suffix
    expect(normalizeName("Bossa Nova")).toBe("bossa nova");
    expect(normalizeName("2001 A Space")).toBe("2001 a space");
  });

  it("strips alias tokens repeatedly", () => {
    const g = [["jr", "junior"], ["sr", "senior"]];
    expect(stripSuffixAliases("john smith jr", g)).toBe("john smith");
    expect(stripSuffixAliases("john smith junior", g)).toBe("john smith");
    // no alias group match — untouched
    expect(stripSuffixAliases("john smith iii", g)).toBe("john smith iii");
    // without groups, never strips
    expect(stripSuffixAliases("john smith jr", [])).toBe("john smith jr");
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
    expect(damerauLevenshtein("smiht", "smith", 3)).toBe(1);
    // sanity: plain Levenshtein would score this 2
    expect(damerauLevenshtein("smith", "smiht", 1)).toBe(1);
  });

  it("basic substitutions / insertions / deletions", () => {
    expect(damerauLevenshtein("john", "joh", 3)).toBe(1); // deletion
    expect(damerauLevenshtein("john", "johhn", 3)).toBe(1); // insertion
    expect(damerauLevenshtein("john", "kahn", 3)).toBe(2); // two subs: j→k, o→a
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
    expect(classifyNames("John Smith", "john  smith", 2, []))
      .toEqual({ kind: "fold", distance: 0 });
  });

  it("seq-suffix only → seq", () => {
    expect(classifyNames("John Smith", "John Smith 2", 2, []))
      .toEqual({ kind: "seq", distance: 0 });
  });

  it("alias tokens → alias (without them: edit or nothing)", () => {
    const g = [["jr", "junior"]];
    expect(classifyNames("J. Smith", "J. Smith Junior", 1, g))
      .toEqual({ kind: "alias", distance: 0 });
    // without aliases " Jr" is a 3-char insertion: below max=2, fine at 3
    expect(classifyNames("J. Smith", "J. Smith Jr", 2, [])).toBeNull();
    expect(classifyNames("J. Smith", "J. Smith Jr", 3, [])?.kind).toBe("edit");
  });

  it("single-edit misspelling → edit, two-edit respects the max", () => {
    expect(classifyNames("John Smith", "John Smyth", 2, []))
      .toEqual({ kind: "edit", distance: 1 });
    // smithh is ONE insertion — distance 1; a real 2-edit pair:
    expect(classifyNames("John Smith", "John Smithh", 2, []))
      .toEqual({ kind: "edit", distance: 1 });
    expect(classifyNames("John Smith", "John Smythh", 2, []))
      .toEqual({ kind: "edit", distance: 2 });
    expect(classifyNames("John Smith", "John Smythh", 1, [])).toBeNull();
    // transposition counts as 1 (#88 rationale)
    expect(classifyNames("John Smith", "John Smiht", 1, []))
      .toEqual({ kind: "edit", distance: 1 });
  });

  it("unrelated names → null", () => {
    expect(classifyNames("John Smith", "Koos Kat", 3, [])).toBeNull();
  });
});

describe("clusterPersons", () => {
  it("clusters case/seq variants of one name into a single cluster", () => {
    const cs = clusterPersons(persons("John Smith", "JOHN SMITH", "John Smith 2", "Koos Kat"));
    expect(cs).toHaveLength(1);
    expect(cs[0].members.map((m) => m.name)).toEqual(
      ["John Smith", "JOHN SMITH", "John Smith 2"]);
    expect(cs[0].label).toBe("John Smith"); // first member by id
    expect(cs[0].key).toBe("john smith");
    expect(cs[0].edges).toHaveLength(3); // every pair linked
  });

  it("default distance 2 catches two-edit misspellings; distance 1 does not", () => {
    // "Smithh" is a single insertion (distance 1) — a real two-edit pair:
    // smith -> smythh = substitute y, insert h
    const cs2 = clusterPersons(persons("John Smith", "John Smythh"));
    expect(cs2).toHaveLength(1);
    expect(cs2[0].edges[0]).toMatchObject({ kind: "edit", distance: 2 });
    const cs1 = clusterPersons(persons("John Smith", "John Smythh"), { distance: 1 });
    expect(cs1).toHaveLength(0);
    // a single insertion clusters even at the strictest distance
    expect(clusterPersons(persons("John Smith", "John Smithh"), { distance: 1 })).toHaveLength(1);
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
    // smih~smith(1), smith~smithth(2), smih~smithth(3 > max 2 → no edge)
    const cs = clusterPersons(persons("smih", "smith", "smithth"));
    expect(cs).toHaveLength(1);
    expect(cs[0].members).toHaveLength(3);
    expect(cs[0].edges.map((e) => `${e.a}-${e.b}`)).toEqual(["1-2", "2-3"]);
  });

  it("excludes Unknown* importer clusters (Unknown7 ~ Unknown8 would be distance 1)", () => {
    expect(clusterPersons(persons("Unknown7", "Unknown8", "John", "Johh"))).toHaveLength(1);
    const cs = clusterPersons(persons("Unknown7", "Unknown8"));
    expect(cs).toHaveLength(0);
  });

  it("excludes the reject-bin family RejectedN AND legacy Rejected (#266/§4.28/§4.35)", () => {
    // Rejected1 ~ Rejected2 (distance 1) and Rejected ~ Rejected1 would
    // cluster — all three are writer-owned bins, never merge material
    expect(clusterPersons(persons("Rejected1", "Rejected2", "John", "Johh"))).toHaveLength(1);
    expect(clusterPersons(persons("Rejected", "Rejected1"))).toHaveLength(0);
    const cs = clusterPersons(persons("Rejected1", "Rejected2"));
    expect(cs).toHaveLength(0);
  });

  it("suffix aliases group Jr/Junior only when enabled (default off)", () => {
    const ps = persons("John Smith", "John Smith Junior");
    expect(clusterPersons(ps)).toHaveLength(0); // distance 3 > 2
    const cs = clusterPersons(ps, { suffixAliases: [["jr", "junior"]] });
    expect(cs).toHaveLength(1);
    expect(cs[0].edges[0].kind).toBe("alias");
  });

  it("zero-face members are kept but contribute nothing (issue spec)", () => {
    nextId = 1;
    const ps = [person("John Smith", 3), { ...person("John Smith 2"), counts: { total: 0, provisional: 0, confirmed: 0, rejected: 0 } }];
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
    expect(clusterPersons(persons("John Smith", "Koos Kat", "Bart Nelles"))).toHaveLength(0);
  });
});
