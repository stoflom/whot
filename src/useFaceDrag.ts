// #135/#136 (rule 34) + #260 — the centre pane's face-drag state machine,
// factored out of App.tsx into a co-tested hook. The pure payload/merge
// rules stay in faceDrop.ts; this owns the STATE (the live payload + the
// highlighted drop target) and the five grid handlers that drive it.
//
// Identity (#98): each handler is its own stable useCallback. The two
// that read render values (`onFaceDragOver`/`onFaceDropOnCard` read
// `facesById`) churn only when the snapshot does — exactly as the old
// single `gridHandlers` memo churned — so memo(FaceGrid) keeps skipping
// untouched cards; the purely-ref-driven ones (start/end/leave) are now
// MORE stable than before (they never churned with the grid memo).

import { useCallback, useRef, useState } from "react";
import * as api from "./api";
import type { Face } from "./api";
import { faceDragPayload } from "./faceDrop";
import type { StagedEntry } from "./stage";

export interface FaceDrag {
  /** the live payload (state view — drives the grid + tree highlight) */
  faceDrag: number[] | null;
  /** the highlighted drop-target card (state view) */
  faceDropTarget: number | null;
  /** the payload ref — the tree reads it at event time (v3.33) */
  faceDragRef: { readonly current: number[] | null };
  onFaceDragStart: (id: number, e: React.DragEvent) => void;
  onFaceDragEnd: () => void;
  onFaceDragOver: (id: number, e: React.DragEvent) => void;
  onFaceDragLeave: (id: number) => void;
  onFaceDropOnCard: (id: number, e: React.DragEvent) => void;
  /** the shared clear — the grid handlers and App's tree-drop callback
      all use it (the #252/#260 dup merge: ONE definition) */
  clearFaceDrag: () => void;
}

export function useFaceDrag(
  selRef: { readonly current: Set<number> },
  stagedIdxRef: { readonly current: Map<number, StagedEntry> },
  facesById: Map<number, Face>,
  mutate: (fn: () => Promise<unknown>, clearSel?: boolean) => Promise<boolean>,
): FaceDrag {
  const [faceDrag, setFaceDrag] = useState<number[] | null>(null);
  const faceDragRef = useRef<number[] | null>(null);
  const [faceDropTarget, setFaceDropTarget] = useState<number | null>(null);
  const faceDropTargetRef = useRef<number | null>(null);

  const clearFaceDrag = useCallback(() => {
    faceDragRef.current = null;
    faceDropTargetRef.current = null;
    setFaceDrag(null);
    setFaceDropTarget(null);
  }, []);

  const onFaceDragStart = useCallback(
    (id: number, e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", `face ${id}`); // Firefox needs data
      // rule 34: the whole selection when the card is part of one
      const payload = faceDragPayload(selRef.current, id);
      faceDragRef.current = payload;
      setFaceDrag(payload);
    },
    [selRef]
  );

  const onFaceDragEnd = useCallback(() => {
    clearFaceDrag();
  }, [clearFaceDrag]);

  const onFaceDragOver = useCallback(
    (id: number, e: React.DragEvent) => {
      if (!faceDragRef.current) return;
      // #136: the copy source is what the card SHOWS — a live staged
      // value when one is staged on it, else the committed one (#224:
      // an O(1) index read)
      const staged = stagedIdxRef.current.get(id);
      const desc = (staged?.desc ?? facesById.get(id)?.description ?? "").trim();
      if (!desc) return; // nothing to copy — not a target (Q3)
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (faceDropTargetRef.current !== id) {
        faceDropTargetRef.current = id;
        setFaceDropTarget(id);
      }
    },
    [stagedIdxRef, facesById]
  );

  const onFaceDragLeave = useCallback(
    (id: number) => {
      if (faceDropTargetRef.current === id) {
        faceDropTargetRef.current = null;
        setFaceDropTarget(null);
      }
    },
    []
  );

  const onFaceDropOnCard = useCallback(
    (id: number, e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const payload = faceDragRef.current;
      clearFaceDrag();
      if (!payload) return;
      const staged = stagedIdxRef.current.get(id); // #224: O(1) lookup
      const desc = (staged?.desc ?? facesById.get(id)?.description ?? "").trim();
      if (!desc) return; // double guard — the browser would not have dropped
      const ids = payload.filter((x) => x !== id); // its own desc is a no-op
      if (ids.length === 0) return;
      // one mutate = one refresh; link_status is untouched (a text edit).
      // #209: one batched command instead of one call per dragged face
      void mutate(() => api.setFaceDescriptions(ids, desc));
    },
    [stagedIdxRef, facesById, mutate, clearFaceDrag]
  );

  return {
    faceDrag,
    faceDropTarget,
    faceDragRef,
    onFaceDragStart,
    onFaceDragEnd,
    onFaceDragOver,
    onFaceDragLeave,
    onFaceDropOnCard,
    clearFaceDrag,
  };
}
