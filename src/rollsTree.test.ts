// #226 (F-M5) — the Rolls pane's hierarchy maths, extracted pure from
// RollsPane.tsx. The regression contract: rollupIndex's per-node totals
// and pruned/sorted sub-branch lists are EQUIVALENT to the verbatim old
// per-render recursive walks (rollup + hasListed + the sorted filter)
// for every node of the fixture trees, under every Show filter — the
// fusion into one post-order pass must not move a single counter.

import { describe, expect, it } from "vitest";
import type { Face, ImageRow } from "./api";
import { buildTree, faceTotalsOf, rollupIndex, type DirNode, type Totals } from "./rollsTree";

// ---- verbatim old walks (RollsPane.tsx before #226) — the oracle ----

function rollup(node: DirNode, faceTotals: Map<number, Totals>): Totals {
  const t: Totals = { img: node.images.length, pending: 0, done: 0, rejected: 0 };
  for (const img of node.images) {
    const f = faceTotals.get(img.id);
    if (f) {
      t.pending += f.pending;
      t.done += f.done;
      t.rejected += f.rejected;
    }
  }
  for (const child of node.children.values()) {
    const c = rollup(child, faceTotals);
    t.img += c.img;
    t.pending += c.pending;
    t.done += c.done;
    t.rejected += c.rejected;
  }
  return t;
}

function hasListed(node: DirNode, listed: Set<number>): boolean {
  if (node.images.some((x) => listed.has(x.id))) return true;
  for (const child of node.children.values()) if (hasListed(child, listed)) return true;
  return false;
}

const oldBranches = (node: DirNode, listed: Set<number>): DirNode[] =>
  [...node.children.values()]
    .filter((c) => hasListed(c, listed))
    .sort((a, b) => a.name.localeCompare(b.name));

// ---- fixtures ----

const img = (id: number, primary_path: string): ImageRow => ({
  id,
  primary_path,
  width: 100,
  height: 80,
  orientation: null,
  rotation: 0,
  rtype: null,
  state: "ok",
  first_import_id: null,
  last_import_id: null,
});

const face = (id: number, image_id: number, link_status: string): Face => ({
  id,
  image_id,
  person_id: null,
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  name: "",
  seq: 0,
  description: null,
  state: "ok",
  import_id: null,
  created_at: "",
  link_status: link_status as Face["link_status"],
  confidence: 1,
  rotation: 0,
});

// a roll with: deep nesting, a file at the root, sibling branches that
// sort non-alphabetically in insertion order, and an emptied subtree
const IMAGES: ImageRow[] = [
  img(1, "/roll/a/one.jpg"),
  img(2, "/roll/a/two.jpg"),
  img(3, "/roll/a/b/deep.jpg"),
  img(4, "/roll/zeta.jpg"),
  img(5, "/roll/m/n.jpg"),
  img(6, "/roll/m/o/p.jpg"),
  img(7, "/empty/q.jpg"), // outside the /roll root
];

const FACES: Face[] = [
  face(11, 1, "provisional"),
  face(12, 1, "confirmed"),
  face(13, 2, "rejected"),
  face(14, 3, "confirmed"),
  // image 4 faceless — listed under 'all' only (#127/#128 shells)
  face(15, 5, "provisional"),
  face(16, 6, "confirmed"),
  // image 7 has no faces at all
];

const FILTERS = ["all", "provisional", "confirmed", "rejected"] as const;

describe("buildTree (#226, verbatim)", () => {
  it("files images under their directory branches, filename excluded", () => {
    const tree = buildTree(IMAGES, "/roll");
    expect(tree.name).toBe("");
    expect(tree.images.map((x) => x.id)).toEqual([4]); // file at the root
    const a = tree.children.get("a")!;
    expect(a.images.map((x) => x.id)).toEqual([1, 2]);
    expect(a.children.get("b")!.images.map((x) => x.id)).toEqual([3]);
    expect(tree.children.has("empty")).toBe(false); // outside the root
  });

  it("roots the whole tree at '/'", () => {
    const tree = buildTree(IMAGES, "/");
    expect(tree.children.has("roll")).toBe(true);
    expect(tree.images).toEqual([]); // no file directly at '/'
  });
});

describe("faceTotalsOf (#226, verbatim)", () => {
  it("counts raw per-image statuses, filter-independent", () => {
    const { faceTotals } = faceTotalsOf(FACES, IMAGES, "all");
    expect(faceTotals.get(1)).toEqual({ img: 1, pending: 1, done: 1, rejected: 0 });
    expect(faceTotals.get(2)).toEqual({ img: 1, pending: 0, done: 0, rejected: 1 });
    expect(faceTotals.get(4)).toBeUndefined(); // faceless
  });

  it("the listed set follows the Show filter", () => {
    expect(faceTotalsOf(FACES, IMAGES, "all").listed.has(4)).toBe(true);
    // #305: image 2 holds only a rejected face — it lists under All too
    expect(faceTotalsOf(FACES, IMAGES, "all").listed.has(2)).toBe(true);
    expect(faceTotalsOf(FACES, IMAGES, "confirmed").listed.has(4)).toBe(false);
    expect(faceTotalsOf(FACES, IMAGES, "confirmed").listed.has(3)).toBe(true);
    expect(faceTotalsOf(FACES, IMAGES, "rejected").listed.has(1)).toBe(false);
  });
});

describe("rollupIndex (#226) — equivalence with the verbatim walks", () => {
  for (const root of ["/", "/roll", "/roll/a"] as const) {
    for (const filter of FILTERS) {
      it(`root=${root} filter=${filter}: every node's totals and branches match`, () => {
        const tree = buildTree(IMAGES, root);
        const { faceTotals, listed } = faceTotalsOf(FACES, IMAGES, filter);
        const { totals, visible } = rollupIndex(tree, faceTotals, listed);

        // every node of the tree got an entry, and each matches the old
        // recursion exactly
        const walk = (node: DirNode) => {
          expect(totals.get(node)).toEqual(rollup(node, faceTotals));
          expect(visible.get(node)).toEqual(oldBranches(node, listed));
          for (const c of node.children.values()) walk(c);
        };
        walk(tree);
      });
    }
  }

  it("an emptied subtree is pruned; its totals still count toward the parent", () => {
    // under 'confirmed' image 5 (provisional) unlists m/n's own image,
    // but m/o still holds a confirmed one — m survives via its child
    const tree = buildTree(IMAGES, "/roll");
    const { faceTotals, listed } = faceTotalsOf(FACES, IMAGES, "confirmed");
    const { visible, totals } = rollupIndex(tree, faceTotals, listed);
    const m = tree.children.get("m")!;
    expect(visible.get(m)!.map((c) => c.name)).toEqual(["o"]);
    // the parent's totals stay raw (#129) — filter-independent
    expect(totals.get(m)).toEqual({ img: 2, pending: 1, done: 1, rejected: 0 });
  });

  it("branches are name-sorted regardless of insertion order", () => {
    const tree = buildTree(IMAGES, "/roll");
    const { faceTotals, listed } = faceTotalsOf(FACES, IMAGES, "all");
    const { visible } = rollupIndex(tree, faceTotals, listed);
    // insertion order is a, zeta(file? no — zeta is a file), m → children
    // of the root are a, m; sorted alphabetically
    expect(visible.get(tree)!.map((c) => c.name)).toEqual(["a", "m"]);
  });

  it("an empty tree yields empty maps with the root present", () => {
    const tree = buildTree([], "/");
    const { faceTotals, listed } = faceTotalsOf([], [], "all");
    const { totals, visible } = rollupIndex(tree, faceTotals, listed);
    expect(totals.get(tree)).toEqual({ img: 0, pending: 0, done: 0, rejected: 0 });
    expect(visible.get(tree)).toEqual([]);
  });
});
