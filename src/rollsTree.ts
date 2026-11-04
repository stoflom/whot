// #226 (F-M5) — the Rolls pane's hierarchy maths, extracted pure from
// RollsPane.tsx. buildTree is verbatim; rollupIndex fuses the old
// per-render recursive passes (rollup + hasListed + the sorted-children
// filter) into ONE post-order walk over the tree, so an expand/collapse
// toggle re-renders branches from precomputed maps instead of re-running
// O(depth × images) recursion per header. Equivalence with the verbatim
// walks is regression-tested in rollsTree.test.ts.

import type { Face, ImageRow } from "./api";
import { listedImages, type FaceFilter } from "./viewFilters";

/** a directory node — images sit in their own directory, sub-directories branch below */
export interface DirNode {
  name: string;
  children: Map<string, DirNode>;
  images: ImageRow[];
}

/** raw counters over a set of images */
export interface Totals {
  img: number;
  pending: number;
  done: number;
  rejected: number;
}

/** split every primary_path into DIRECTORY segments relative to the #162
    root and file the image under its directory — #174 (§4.39): the
    FILENAME segment is no longer a branch (the old leaf twig whose
    inline thumbnail the right-pane thumbs replaced); a file directly
    at the root lives in the tree's root node (shown by the right pane
    when the root branch is selected) */
export function buildTree(images: ImageRow[], root: string): DirNode {
  const rootPrefix = root === "/" ? "/" : `${root}/`;
  const inRoot = images.filter((x) => x.primary_path.startsWith(rootPrefix));
  const rel = (p: string) => (root === "/" ? p : p.slice(root.length + 1));
  const tree: DirNode = { name: "", children: new Map(), images: [] };
  for (const img of inRoot) {
    let node = tree;
    const segs = rel(img.primary_path).split("/").filter(Boolean);
    for (const seg of segs.slice(0, -1)) { // stop BEFORE the filename
      let next = node.children.get(seg);
      if (!next) {
        next = { name: seg, children: new Map(), images: [] };
        node.children.set(seg, next);
      }
      node = next;
    }
    node.images.push(img);
  }
  return tree;
}

/** per-image raw face counters + the Show-filter presence set (§4.10,
    shared with the right-pane thumbnails, #174): an image is listed
    iff it holds ≥ 1 face matching the filter; under 'all'
    every image is listed (faceless shells included) */
export function faceTotalsOf(
  faces: Face[],
  images: ImageRow[],
  faceFilter: FaceFilter
): { faceTotals: Map<number, Totals>; listed: Set<number> } {
  const faceTotals = new Map<number, Totals>();
  for (const f of faces) {
    let t = faceTotals.get(f.image_id);
    if (!t) {
      t = { img: 1, pending: 0, done: 0, rejected: 0 };
      faceTotals.set(f.image_id, t);
    }
    if (f.link_status === "provisional") t.pending++;
    else if (f.link_status === "confirmed") t.done++;
    else if (f.link_status === "rejected") t.rejected++;
  }
  return { faceTotals, listed: listedImages(images, faces, faceFilter) };
}

/** one post-order pass over the tree:
    - totals: branch totals over every image beneath the branch — raw,
      filter-independent (#129) — for EVERY node (the old rollup ran
      per rendered header per render);
    - visible: the branch's sub-branches that hold a listing image
      somewhere beneath them (the old hasListed filter), name-sorted —
      a branch the Show filter empties is pruned */
export function rollupIndex(
  tree: DirNode,
  faceTotals: Map<number, Totals>,
  listed: Set<number>
): { totals: Map<DirNode, Totals>; visible: Map<DirNode, DirNode[]> } {
  const totals = new Map<DirNode, Totals>();
  const visible = new Map<DirNode, DirNode[]>();
  const walk = (node: DirNode): Totals => {
    const t: Totals = { img: node.images.length, pending: 0, done: 0, rejected: 0 };
    for (const img of node.images) {
      const f = faceTotals.get(img.id);
      if (f) {
        t.pending += f.pending;
        t.done += f.done;
        t.rejected += f.rejected;
      }
    }
    const kids: DirNode[] = [];
    for (const child of node.children.values()) {
      const c = walk(child);
      t.img += c.img;
      t.pending += c.pending;
      t.done += c.done;
      t.rejected += c.rejected;
      // the old hasListed: the branch holds a listing image somewhere
      // beneath it (its own images count too)
      if (
        child.images.some((x) => listed.has(x.id)) ||
        (visible.get(child)?.length ?? 0) > 0
      )
        kids.push(child);
    }
    kids.sort((a, b) => a.name.localeCompare(b.name));
    totals.set(node, t);
    visible.set(node, kids);
    return t;
  };
  walk(tree);
  return { totals, visible };
}
