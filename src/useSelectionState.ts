// The face-selection layer (gui-design §4.44 round 2 stage 2, #293) —
// ONE hook owns the `sel` state, its mirroring `selRef`, the
// latest-selection anchor (`lastSelRef`, the #53 Ctrl-G fallback / #88
// merge target) and the #69 range anchor, plus the whole ref-driven
// handler family: `changeSel`, `toggle`, `toggleMany`, `rectToggle`,
// `actionScope`, `selectOnly`, `rangeSelect` and `renderedIds`. Also
// the tree's `selPersons` state (its #35/#62/#200 select logic — the
// context confirm, the re-anchor, the mode routing — stays in App's
// `handleTreeSelect`; only the state moves here).
//
// Identity per #98: every handler reads the live selection through
// `selRef` — a selection change churns no callback identity, so
// memo(FaceCard) and the menu/grid handlers keep skipping re-renders.
// The view-context reactions a toggle triggers (`closeSplitForFaces`,
// #52 — and `followCrop`, #201/§4.37) are injected deps with the same
// churn rates the inline handlers had.
//
// `imgSel` (the §4.23 right-pane thumb selection) stays App-owned: its
// branch-reset lives in the root/branch state block, above this hook's
// placement (the #167/#174 session state must keep clearing it).

import { useCallback, useRef, useState, type RefObject } from "react";
import type { Face } from "./api";
import type { Section } from "./components/FaceGrid";

export interface SelectionDeps {
  /** #52 (§4.15): the split follows the selection — it closes itself
      when the selection moves to a different image and stays open while
      the new selection is on the image it already shows; manual opens
      always win */
  closeSplitForFaces: (ids: number[]) => void;
  /** #201 (§4.37) — a crop click in the focus split follows the same
      plain-anchor rule as the overlay rects (#171): the right pane moves
      to the clicked face's person; a NULL person_id leaves it as it was */
  followCrop: (id: number) => void;
  /** #98: stable setter identity */
  setPersonId: (id: number | null) => void;
  /** #282: read at event time, never a dependency */
  facesByIdRef: RefObject<Map<number, Face>>;
  /** the rendered card order sources (§4.44 stage 1: App-owned) */
  sectionsRef: RefObject<Section[]>;
  sectionsForImageRef: RefObject<(imgId: number) => Section[]>;
  /** the focus split routes `renderedIds` to the split's own sections */
  splitImageId: number | null;
}

export function useSelectionState(deps: SelectionDeps) {
  const {
    closeSplitForFaces,
    followCrop,
    setPersonId,
    facesByIdRef,
    sectionsRef,
    sectionsForImageRef,
    splitImageId,
  } = deps;

  const [sel, setSel] = useState<Set<number>>(new Set());
  const [selPersons, setSelPersons] = useState<Set<number>>(new Set());

  // #98 (§4.31) — the "latest selection" is a ref: the pointer crossing
  // cards must never re-render the app; callbacks read it at event time
  const selRef = useRef<Set<number>>(new Set());
  selRef.current = sel;
  const lastSelRef = useRef<number | null>(null);
  // #69 — anchor + shift-click range selection over the rendered card
  // order (sections render back-to-back, so ranges may span sections)
  const anchorRef = useRef<number | null>(null);

  // #123: a selection change INSIDE the context never asks — the
  // Apply → change → Apply loop is dialog-free by design
  const changeSel = useCallback((next: Set<number>) => {
    setSel(next);
  }, []);

  const toggle = useCallback(
    (id: number) => {
      anchorRef.current = id; // #69: the toggled card becomes the range anchor
      closeSplitForFaces([id]);
      followCrop(id); // #201 (§4.37): the right pane follows the crop
      const n = new Set(selRef.current);
      if (n.has(id)) n.delete(id);
      else {
        n.add(id);
        lastSelRef.current = id;
      }
      changeSel(n);
    },
    [closeSplitForFaces, followCrop, changeSel]
  );
  const toggleMany = useCallback(
    (ids: number[], on: boolean) => {
      if (on && ids.length > 0) lastSelRef.current = ids[ids.length - 1];
      const n = new Set(selRef.current);
      ids.forEach((i) => (on ? n.add(i) : n.delete(i)));
      changeSel(n);
    },
    [changeSel]
  );
  // #171 (§4.37) — a rect click in a full-image view toggles the
  // selection as before AND moves the right pane to that face's person:
  // a plain anchor (no context change, no view switch — deliberately
  // not handleTreeSelect's §4.15 yank); a NULL person_id (legacy rows)
  // leaves the anchor untouched. FaceOverlay renders only in the focus
  // split and the rolls detail, so this is scoped to the full-image
  // surfaces by construction.
  const rectToggle = useCallback(
    (id: number) => {
      toggle(id);
      const f = facesByIdRef.current.get(id);
      if (f && f.person_id != null) setPersonId(f.person_id);
    },
    [toggle, facesByIdRef, setPersonId]
  );

  // #49 (§4.14) — effective action scope: the active selection when the
  // invoked card is part of it, otherwise just that card. Reads selRef so
  // the callback identity never changes with the selection (#98).
  const actionScope = useCallback((id: number): number[] => {
    const s = selRef.current;
    return s.has(id) && s.size > 1 ? [...s] : [id];
  }, []);

  const renderedIds = useCallback(
    () =>
      (splitImageId != null
        ? sectionsForImageRef.current(splitImageId)
        : sectionsRef.current
      ).flatMap((s) => s.faceIds),
    [splitImageId, sectionsRef, sectionsForImageRef]
  );
  // plain click: select just this card, drop the anchor
  const selectOnly = useCallback(
    (id: number) => {
      anchorRef.current = id;
      closeSplitForFaces([id]);
      followCrop(id); // #201 (§4.37): the right pane follows the crop
      lastSelRef.current = id;
      changeSel(new Set([id]));
    },
    [closeSplitForFaces, followCrop, changeSel]
  );
  // shift-click: the contiguous range anchor…clicked card; the anchor
  // stays put so repeated shift-clicks re-anchor the same start, the
  // clicked card becomes the new last-selected
  const rangeSelect = useCallback(
    (id: number) => {
      const ids = renderedIds();
      const ai = anchorRef.current == null ? -1 : ids.indexOf(anchorRef.current);
      const ci = ids.indexOf(id);
      if (ai === -1 || ci === -1) {
        // anchor gone (filtered/removed) or card not in this view
        selectOnly(id);
        return;
      }
      const [lo, hi] = ai <= ci ? [ai, ci] : [ci, ai];
      lastSelRef.current = id;
      changeSel(new Set(ids.slice(lo, hi + 1)));
    },
    [renderedIds, selectOnly, changeSel]
  );

  return {
    sel,
    setSel,
    selRef,
    lastSelRef,
    anchorRef,
    changeSel,
    toggle,
    toggleMany,
    rectToggle,
    actionScope,
    renderedIds,
    selectOnly,
    rangeSelect,
    selPersons,
    setSelPersons,
  };
}

export type SelectionState = ReturnType<typeof useSelectionState>;
