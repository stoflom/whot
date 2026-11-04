// #223 (F-M1/F-M2, round-2 perf) — the person tree's index pass. The
// tree structure (buildTree) and the two queries App and the pane run
// over it live here as PURE functions:
//   • App builds the tree ONCE per treePersons change and hands it to
//     PersonTree (the pane no longer rebuilds it per render), and walks
//     it once for the #31 step list (orderedVisiblePersonIdsFromTree).
//   • PersonTree indexes it ONCE per (tree, persons, filter) change —
//     one post-order pass producing every node's match/count — and the
//     render reads the entries, replacing the per-node O(n·depth)
//     subtreeMatch walks and recursive countPersons sums.
// Nothing here touches state, DOM or IPC (§4.44 rule 44 shape).

import type { Person } from "./api";

export interface TreeNode {
  name: string;
  personIds: number[];
  children: TreeNode[];
}

export function buildTree(persons: Person[]): TreeNode {
  const root: TreeNode = { name: "", personIds: [], children: [] };
  const find = (parent: TreeNode, name: string): TreeNode => {
    let n = parent.children.find((c) => c.name === name);
    if (!n) {
      n = { name, personIds: [], children: [] };
      parent.children.push(n);
    }
    return n;
  };
  // #153 (§3): group placement first — a person with a group row renders
  // under their first path even when named UnknownN (the user may group
  // an UnknownN they remember by face but not by name). #165 (§4.35):
  // every person carries ≥ 1 group row since v1.7 — the virtual
  // Unknown/Ungrouped branches are retired and appear only as a
  // fail-visible fallback for a groupless person (an invariant breach no
  // writer can produce; created lazily, so healthy snapshots never show
  // them). #156 (v3.56): a person with SEVERAL group rows renders under
  // every listed path — the §9 harvest importer legally leaves multiple
  // person_groups rows per person (§9.6/#128 additive shell groups), and
  // hiding them on all but the alphabetically-first branch made the
  // person unfindable in the branch the user filed them under. Each
  // distinct row is one placement; duplicates are impossible (PK).
  for (const p of persons) {
    if (p.groups.length > 0) {
      for (const g of p.groups) {
        const parts = g.split("|").filter(Boolean);
        let node = root;
        for (const part of parts) node = find(node, part);
        node.personIds.push(p.id);
      }
    } else {
      find(root, p.name.startsWith("Unknown") ? "Unknown" : "Ungrouped").personIds.push(p.id);
    }
  }
  // #61 (§3): within every branch, biggest clusters first — persons
  // ordered by face count desc; ties by name, then id (deterministic).
  // Sub-branches keep their (snapshot) order.
  const byId = new Map(persons.map((p) => [p.id, p]));
  const sortNodes = (n: TreeNode) => {
    n.personIds.sort((a, b) => {
      const pa = byId.get(a);
      const pb = byId.get(b);
      const d = (pb?.counts.total ?? 0) - (pa?.counts.total ?? 0);
      if (d !== 0) return d;
      const c = (pa?.name ?? "").localeCompare(pb?.name ?? "");
      return c !== 0 ? c : a - b;
    });
    n.children.forEach(sortNodes);
  };
  sortNodes(root);
  return root;
}

/** one node's indexed view facts */
export interface TreeIndexEntry {
  /** does the subtree hold a filter-visible person? (the render's
      subtreeMatch — a node with none renders nothing) */
  match: boolean;
  /** visible persons in the subtree, per PLACEMENT (a multi-group person
      counts under every branch that lists them — the badge rule the
      render has always shown; with an empty filter this is every
      placement, i.e. the old countPersons' unfiltered branch) */
  count: number;
}

/** node -> view facts, one post-order pass over the tree */
export type TreeIndex = Map<TreeNode, TreeIndexEntry>;

export function indexTree(
  tree: TreeNode,
  byId: Map<number, Person>,
  filter: string,
): TreeIndex {
  const f = filter.trim().toLowerCase();
  const matches = (p: Person) =>
    f === "" ||
    p.name.toLowerCase().includes(f) ||
    p.groups.some((g) => g.toLowerCase().includes(f));
  const idx: TreeIndex = new Map();
  const walk = (node: TreeNode): TreeIndexEntry => {
    let count = 0;
    for (const id of node.personIds) {
      const p = byId.get(id);
      if (p && matches(p)) count++;
    }
    let match = count > 0;
    for (const c of node.children) {
      const e = walk(c);
      count += e.count;
      match = match || e.match;
    }
    const entry = { match, count };
    idx.set(node, entry);
    return entry;
  };
  walk(tree);
  return idx;
}

/** Person ids in the tree's visual (filtered) display order — the
 * ‹ › / arrow-key person stepping walks this list (#31). A multi-group
 * person renders under every path (#156) but is stepped once, at the
 * first placement reached. The tree is handed in (App builds it once
 * per treePersons change, #223) and the filter walk runs over the
 * post-order index instead of re-matching every subtree. */
export function orderedVisiblePersonIdsFromTree(
  tree: TreeNode,
  persons: Person[],
  filter: string,
): number[] {
  const byId = new Map(persons.map((p) => [p.id, p]));
  const idx = indexTree(tree, byId, filter);
  const f = filter.trim().toLowerCase();
  const matches = (p: Person) =>
    f === "" ||
    p.name.toLowerCase().includes(f) ||
    p.groups.some((g) => g.toLowerCase().includes(f));
  const out: number[] = [];
  const seen = new Set<number>();
  const walk = (node: TreeNode, isRoot: boolean) => {
    if (!isRoot && !idx.get(node)?.match) return;
    for (const id of node.personIds) {
      if (seen.has(id)) continue; // #156: one placement only per id
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

/** the standalone form (tree built here) — App uses the FromTree form
    so the tree is built once and shared with the pane (#223) */
export function orderedVisiblePersonIds(persons: Person[], filter: string): number[] {
  return orderedVisiblePersonIdsFromTree(buildTree(persons), persons, filter);
}
