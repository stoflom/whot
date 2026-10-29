// #174 (gui-design §4.39) — image multi-select over the right-pane
// branch thumbnails: the §4.23 anchor pattern over images — a plain
// click selects just that thumb and moves the anchor, ctrl/⌘ toggles
// (moving the anchor when it selects), shift ranges over the branch's
// display order from the anchor and REPLACES the selection. Pure, so
// the click rules are unit-testable; the pane owns the state.

export interface ImageSel {
  sel: Set<number>;
  /** the last plain/ctrl-selected thumb — shift ranges start here */
  anchor: number | null;
}

export const emptyImageSel = (): ImageSel => ({ sel: new Set(), anchor: null });

/** filename (basename) order — the old leaf grid's sort (§4.39) */
export function byFilename(
  a: { primary_path: string },
  b: { primary_path: string },
): number {
  const base = (p: string) => {
    const i = p.lastIndexOf("/");
    return i === -1 ? p : p.slice(i + 1);
  };
  return base(a.primary_path).localeCompare(base(b.primary_path));
}

/** one thumb click over the branch's display order (§4.23 over images) */
export function clickImage(
  state: ImageSel,
  ordered: number[],
  id: number,
  mods: { ctrl?: boolean; shift?: boolean } = {},
): ImageSel {
  if (mods.shift && state.anchor != null) {
    const ai = ordered.indexOf(state.anchor);
    const ci = ordered.indexOf(id);
    if (ai !== -1 && ci !== -1) {
      const [lo, hi] = ai <= ci ? [ai, ci] : [ci, ai];
      // the anchor stays put — repeated shift-clicks re-anchor the
      // same start (§4.23)
      return { sel: new Set(ordered.slice(lo, hi + 1)), anchor: state.anchor };
    }
    // anchor gone (branch changed / filtered out) — fall through to a
    // plain select, exactly like the face grid's rangeSelect
  }
  if (mods.ctrl) {
    const sel = new Set(state.sel);
    if (sel.has(id)) sel.delete(id);
    else {
      sel.add(id); // moves the anchor when it selects (§4.23)
      return { sel, anchor: id };
    }
    return { sel, anchor: state.anchor };
  }
  return { sel: new Set([id]), anchor: id };
}

/** the menu/keyboard scope (§4.14): the selection when the invoked
    thumb is part of it, otherwise just that thumb — ids outside the
    current branch's list are dropped (§4.39) */
export function imageScope(sel: ImageSel, inBranch: Set<number>, id: number): number[] {
  if (inBranch.has(id) && sel.sel.has(id) && sel.sel.size > 0) {
    return [...sel.sel].filter((x) => inBranch.has(x));
  }
  return [id];
}
