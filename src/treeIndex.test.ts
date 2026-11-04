// #223 (F-M1/F-M2) — the person tree's index pass. The suite pins the
// extraction's contract: buildTree's placement/sort rules are verbatim
// (they moved from PersonTree.tsx), and the index (one post-order pass)
// answers exactly what the per-node subtreeMatch walks and the
// recursive countPersons sums answered — for every filter, on every
// subtree, in the same order.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import type { Person } from "./api";
import {
  buildTree,
  indexTree,
  orderedVisiblePersonIds,
  orderedVisiblePersonIdsFromTree,
  type TreeNode,
} from "./treeIndex";

function person(
  id: number,
  name: string,
  groups: string[],
  total = 1
): Person {
  return {
    id,
    name,
    state: "imported",
    note: null,
    primary_face_id: null,
    primary_pinned: 0,
    created_at: "",
    groups,
    counts: { total, provisional: 0, confirmed: 0, rejected: 0 },
  } as Person;
}

/** the OLD reference implementation (verbatim from the pre-#223
    PersonTree) — the index must answer identically on every input */
function referenceOrder(persons: Person[], filter: string): number[] {
  const tree = buildTree(persons);
  const byId = new Map(persons.map((p) => [p.id, p]));
  const f = filter.trim().toLowerCase();
  const matches = (p: Person) =>
    f === "" ||
    p.name.toLowerCase().includes(f) ||
    p.groups.some((g) => g.toLowerCase().includes(f));
  const subtreeMatch = (node: TreeNode): boolean =>
    node.personIds.some((id) => {
      const p = byId.get(id);
      return !!p && matches(p);
    }) || node.children.some(subtreeMatch);
  const out: number[] = [];
  const seen = new Set<number>();
  const walk = (node: TreeNode, isRoot: boolean) => {
    if (!isRoot && !subtreeMatch(node)) return;
    for (const id of node.personIds) {
      if (seen.has(id)) continue;
      const p = byId.get(id);
      if (p && matches(p)) {
        out.push(id);
        seen.add(id);
      }
    }
    for (const c of node.children) walk(c, false);
  };
  walk(tree, true);
  return out;
}

/** the OLD per-node badge count (verbatim countPersons) */
function referenceCount(node: TreeNode, persons: Person[], filter: string): number {
  const byId = new Map(persons.map((p) => [p.id, p]));
  const f = filter.trim().toLowerCase();
  const matches = (p: Person) =>
    f === "" ||
    p.name.toLowerCase().includes(f) ||
    p.groups.some((g) => g.toLowerCase().includes(f));
  const countPersons = (n: TreeNode): number => {
    if (f !== "") {
      return (
        n.personIds.filter((id) => byId.get(id) && matches(byId.get(id)!)).length +
        n.children.reduce((acc, c) => acc + countPersons(c), 0)
      );
    }
    return (
      n.personIds.length + n.children.reduce((acc, c) => acc + countPersons(c), 0)
    );
  };
  return countPersons(node);
}

const fixture = [
  person(1, "Burgit Oosthuizen", ["Friends", "Friends|PHS"], 19),
  person(2, "Esther Buchanan", ["Friends", "Friends|PHS"], 30),
  person(3, "Mary", ["Family|Lombard-PaMa|Friends"], 2),
  person(4, "Solo", [], 1),
  person(5, "Unknown7", [], 5),
  person(6, "Rejected", ["Rejected"], 3),
];

/** every subtree of the tree (the root's children, recursively) */
function subtrees(node: TreeNode, out: TreeNode[] = []): TreeNode[] {
  for (const c of node.children) {
    out.push(c);
    subtrees(c, out);
  }
  return out;
}

describe("indexTree (#223) — one pass answers the walks", () => {
  const persons = fixture;
  const byId = new Map(persons.map((p) => [p.id, p]));

  for (const filter of ["", "friends", "MARY", "phs", "unknown", "zzz"]) {
    it(`matches the reference walk and counts for filter ${filter.trim() || "''"}`, () => {
      const tree = buildTree(persons);
      const idx = indexTree(tree, byId, filter);
      // the root's entry: match iff any person is visible; count = the
      // reference badge count
      const root = idx.get(tree)!;
      expect(root.match).toBe(referenceCount(tree, persons, filter) > 0);
      expect(root.count).toBe(referenceCount(tree, persons, filter));
      // every subtree: match/count identical to the old walks
      for (const node of subtrees(tree)) {
        const e = idx.get(node)!;
        expect(e.count).toBe(referenceCount(node, persons, filter));
        // match ⇔ the subtree holds a visible person (count > 0 — the
        // same predicate subtreeMatch computed, recursion included)
        expect(e.match).toBe(e.count > 0);
      }
    });
  }

  it("an empty filter matches everything (the unfiltered badge counts)", () => {
    const tree = buildTree(persons);
    const idx = indexTree(tree, byId, "");
    const friends = tree.children.find((c) => c.name === "Friends")!;
    // per-placement counting: p1 twice (Friends, Friends|PHS), p2 twice,
    // Mary once under Family|Lombard-PaMa|Friends, Solo/Unknown7/
    // Rejected once each — 8 placements over 6 persons
    expect(idx.get(friends)!.count).toBe(4);
    expect(idx.get(tree)!.count).toBe(8);
  });

  it("a filter matching only a deep descendant marks every ancestor", () => {
    const tree = buildTree(persons);
    const idx = indexTree(tree, byId, "lombard");
    const family = tree.children.find((c) => c.name === "Family")!;
    expect(idx.get(family)!.match).toBe(true);
    expect(idx.get(family)!.count).toBe(1);
    expect(idx.get(tree)!.match).toBe(true);
  });

  it("a filter matching nothing: match=false everywhere, count=0", () => {
    const tree = buildTree(persons);
    const idx = indexTree(tree, byId, "zzz-nothing");
    for (const e of idx.values()) {
      expect(e.match).toBe(false);
      expect(e.count).toBe(0);
    }
  });
});

describe("orderedVisiblePersonIdsFromTree (#223)", () => {
  const persons = fixture;

  for (const filter of ["", "friends", "MARY", "phs", "unknown", "zzz"]) {
    it(`the shared-tree walk equals the reference order for filter ${filter.trim() || "''"}`, () => {
      const tree = buildTree(persons);
      expect(orderedVisiblePersonIdsFromTree(tree, persons, filter)).toEqual(
        referenceOrder(persons, filter)
      );
    });
  }

  it("building the tree once and walking it per filter matches building per walk", () => {
    // App's #223 shape: one buildTree, many walks (deferred filter)
    const tree = buildTree(persons);
    const a = orderedVisiblePersonIdsFromTree(tree, persons, "friends");
    const b = orderedVisiblePersonIdsFromTree(tree, persons, "mary");
    expect(a).toEqual(referenceOrder(persons, "friends"));
    expect(b).toEqual(referenceOrder(persons, "mary"));
  });

  it("a multi-group person is stepped once, at the first placement (#156 kept)", () => {
    const tree = buildTree(persons);
    const ids = orderedVisiblePersonIdsFromTree(tree, persons, "");
    for (const id of [1, 2, 3]) {
      expect(ids.filter((x) => x === id).length).toBe(1);
    }
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe("orderedVisiblePersonIds (#223 — the standalone wrapper)", () => {
  it("equals the shared-tree form (build here = build once there)", () => {
    const persons = fixture;
    expect(orderedVisiblePersonIds(persons, "friends")).toEqual(
      orderedVisiblePersonIdsFromTree(buildTree(persons), persons, "friends")
    );
  });
});
