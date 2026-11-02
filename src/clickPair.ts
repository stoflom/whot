// §4.44 (gui-design v3.94, #206 stage 2) — the click-pair guard as a
// hook, with its decision rule pure (co-tested). 

import { useEffect } from "react";

// #191 — WebKitGTK quirk (the engine Tauri ships): a right-click on
// ANY element is followed by a spurious LEFT `click` (button=0, no
// modifiers) on that same element — at the SAME pixel — after the
// `contextmenu`. The click is queued behind the contextmenu's
// re-render, so its lag is render-proportional (sub-100 ms on the
// tree/thumbs, ~1 s on the big face grid). On every selectable (tree
// rows, face cards, thumbs) its plain-click path replaces the
// multi-selection with the clicked item, silently collapsing the
// scope the menu/rulebar act on. Swallow the synthetic pair: button
// 0, no modifiers, the right-clicked element (or one of its
// descendants/ancestors) at the right-click's spot, within a 3 s
// sanity bound. A real user's mouse (and Firefox) never produce the
// pair — a second deliberate click lands elsewhere, and modifier
// clicks pass through untouched. One document-capture guard covers
// every element class (React 19 delegates to the root container, so
// capture at document wins).

export interface ClickPairRecord {
  el: Element;
  x: number;
  y: number;
  t: number;
}

/** the click properties the decision reads — a full MouseEvent has them all */
export interface PairClick {
  target: Element;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  clientX: number;
  clientY: number;
}

/** the #191 decision, pure: swallow THIS click as the spurious pair's
    member? (The caller performs the swallowing and clears the record.) */
export function isSpuriousPair(
  guard: ClickPairRecord | null,
  e: PairClick,
  now: number
): boolean {
  if (!guard) return false;
  if (
    now - guard.t > 3000 ||
    e.button !== 0 ||
    e.ctrlKey || e.metaKey || e.shiftKey || e.altKey
  )
    return false;
  const el = e.target;
  const sameElement =
    el === guard.el || el.contains(guard.el) || guard.el.contains(el);
  const sameSpot =
    Math.abs(e.clientX - guard.x) <= 5 &&
    Math.abs(e.clientY - guard.y) <= 5;
  return sameElement && sameSpot;
}

/** the document-capture wiring (see #191 above) — keep it ONE effect for
    the whole app: React 19 delegates at the root container, so capture
    at the document wins over every React handler. */
export function useClickPairGuard(): void {
  useEffect(() => {
    let guard: ClickPairRecord | null = null;
    const onCtx = (e: MouseEvent) => {
      guard = { el: e.target as Element, x: e.clientX, y: e.clientY, t: Date.now() };
    };
    const onClick = (e: MouseEvent) => {
      // a native event's fields are prototype accessors — spread is empty;
      // build the record explicitly
      if (
        !isSpuriousPair(
          guard,
          {
            target: e.target as Element,
            button: e.button,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            clientX: e.clientX,
            clientY: e.clientY,
          },
          Date.now()
        )
      )
        return;
      e.stopPropagation();
      e.preventDefault();
      guard = null;
    };
    document.addEventListener("contextmenu", onCtx, true);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("contextmenu", onCtx, true);
      document.removeEventListener("click", onClick, true);
    };
  }, []);
}
