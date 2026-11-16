// #333 — the ONE APG roving-tabindex tree-key handler. #255 put the
// pattern on the person tree's rows/branches, the Rolls pane's branch
// headers and the pane dividers; two near-identical implementations
// (PersonTree's treeItemKey, RollsPane's branchKey) risked drifting
// apart — this shared form is exactly both contracts:
//   Enter/Space activate · Up/Down rove focus among the visible items
//   (DOM order == display order) · Right expands a collapsed branch ·
//   Left collapses an expanded one, otherwise climbs to the parent.
// The focused element is found by a CSS selector + attribute pair, so
// each host passes its own (the pane dividers keep their own handler).
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export interface RovingKeys {
  /** the focused item's own key value (matched against `attr`) */
  id: string;
  /** the CSS selector of the roving items */
  selector: string;
  /** the attribute that carries the key value on each item */
  attr: string;
  /** Enter/Space — the item's activation (a row select, a branch's
      toggle+select, …) */
  onActivate: () => void;
  /** Right on a collapsed branch / Left on an expanded one */
  onToggle: () => void;
  /** the item is a branch node (rows pass false — arrows never
      expand/collapse them) */
  isBranch: boolean;
  /** the branch's current expanded state (rows pass false) */
  expanded: boolean;
  /** Left on a non-expanded item: climb to this key (null = nothing) */
  parentKey: string | null;
}

export function rovingTreeKey(e: ReactKeyboardEvent, o: RovingKeys): void {
  const items = () =>
    Array.from(document.querySelectorAll<HTMLElement>(o.selector));
  const focusKey = (k: string | null) => {
    if (k == null) return;
    const el = items().find((h) => h.getAttribute(o.attr) === k);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  };
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    o.onActivate();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const list = items();
    const idx = list.findIndex((h) => h.getAttribute(o.attr) === o.id);
    focusKey(
      list[idx + (e.key === "ArrowDown" ? 1 : -1)]?.getAttribute(o.attr) ??
        null
    );
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    if (o.isBranch && !o.expanded) o.onToggle();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (o.isBranch && o.expanded) o.onToggle();
    else focusKey(o.parentKey);
  }
}
