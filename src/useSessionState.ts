// #297 (gui-design rule 50, v15.0) — the thin persistence hook: the ONE
// restore effect (ids validated against the first snapshot; the #176
// boot-guard suppression) and the throttled saves. App keeps only
// setter bindings (rule 50: no App growth). Identity per #98: restore
// is setters only; saves read through the latest render's values in a
// debounced effect — no callback churn.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Snapshot } from "./api";
import {
  parseSession,
  serializeSession,
  sessionInitial,
  SESSION_SCHEMA,
  SESSION_STORAGE_KEY,
  validateIdsFor,
  type SessionBlob,
  type SessionInitial,
} from "./sessionState";
import type { Mode } from "./sections";

const saveDelay = 300; // ms — scroll writes must not hit storage per event

const safeGet = (): string | null => {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
};

/** the synchronous first-render seed (localStorage needs no snapshot —
    ids are reconciled later by useSessionPersistence). */
export function useSessionInitial(): SessionInitial {
  const [initial] = useState<SessionInitial>(() =>
    sessionInitial(parseSession(safeGet()))
  );
  return initial;
}

/** merge `patch` into the stored blob and write it (no debounce — the
    callers schedule; the blob is tiny). */
export function persistSessionPatch(patch: Partial<SessionBlob>): void {
  try {
    const current = parseSession(safeGet());
    const next: SessionBlob = { v: SESSION_SCHEMA, ...(current ?? {}), ...patch };
    if (patch.scroll != null && current?.scroll != null) {
      next.scroll = { ...current.scroll, ...patch.scroll };
    }
    localStorage.setItem(SESSION_STORAGE_KEY, serializeSession(next));
  } catch {
    // storage unavailable — session state is an affordance, never a fault
  }
}

export interface SessionPersistenceDeps {
  /** the #208 snapshot (event-time reads through the ref) */
  snapRef: RefObject<Snapshot | null>;
  mode: Mode;
  personId: number | null;
  imageId: number | null;
  splitImageId: number | null;
  rollRoot: string;
  rollBranch: string;
  rollOpen: Set<string>;
  rollRecursive: Set<string>;
  importDir: string | null;
  treeFilter: string;
  treeCollapsed: Set<string>;
  mountLimit: number;
  paneLeft: number;
  paneRight: number;
  setPersonId: (id: number | null) => void;
  setImageId: (id: number | null) => void;
  setSplitImageId: (id: number | null) => void;
  /** #176: the sticky-person guard's once-per-pair key — pre-seeded on
      the boot restore so the guard dialogs do not fire on it */
  noFacesKeyRef: RefObject<string>;
  faceFilter: string;
}

export function useSessionPersistence(deps: SessionPersistenceDeps) {
  const {
    snapRef,
    mode,
    personId,
    imageId,
    splitImageId,
    rollRoot,
    rollBranch,
    rollOpen,
    rollRecursive,
    importDir,
    treeFilter,
    treeCollapsed,
    mountLimit,
    paneLeft,
    paneRight,
    setPersonId,
    setImageId,
    setSplitImageId,
    noFacesKeyRef,
    faceFilter,
  } = deps;

  // the restore: ids validated against the snapshot that lands (re-run
  // on every snapshot — a dangling id is cleared the way a live one
  // would be). The #176 guard key is pre-seeded on the FIRST restore
  // only, so the boot pair does not open the guard dialogs
  const restoredRef = useRef(false);
  useEffect(() => {
    const snap = snapRef.current;
    if (snap == null) return;
    if (!restoredRef.current) {
      restoredRef.current = true;
      noFacesKeyRef.current = `${personId ?? ""}|${faceFilter}`;
    }
    const v = validateIdsFor(snap, { personId, imageId, splitImageId, rollBranch });
    if (v.personId !== personId) setPersonId(v.personId);
    if (v.imageId !== imageId) setImageId(v.imageId);
    if (v.splitImageId !== splitImageId) setSplitImageId(v.splitImageId);
  }, [
    snapRef,
    personId,
    imageId,
    splitImageId,
    rollBranch,
    faceFilter,
    noFacesKeyRef,
    setPersonId,
    setImageId,
    setSplitImageId,
  ]);

  // the save: one debounced writer for the whole persisted set
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      persistSessionPatch({
        mode,
        personId,
        imageId,
        splitImageId,
        rollRoot,
        rollBranch,
        rollOpen: [...rollOpen],
        rollRecursive: [...rollRecursive],
        importDir,
        treeFilter,
        treeCollapsed: [...treeCollapsed],
        mountLimit,
        paneLeft,
        paneRight,
      });
    }, saveDelay);
    return () => {
      if (saveTimer.current != null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, [
    mode,
    personId,
    imageId,
    splitImageId,
    rollRoot,
    rollBranch,
    rollOpen,
    rollRecursive,
    importDir,
    treeFilter,
    treeCollapsed,
    mountLimit,
    paneLeft,
    paneRight,
  ]);

  // the §4.40 scroll place: written by useScrollPlace through this
  // (the per-mode field merges into the same blob)
  const saveScroll = useCallback((m: Mode, pos: number) => {
    persistSessionPatch({ scroll: { [m]: pos } });
  }, []);
  return { saveScroll };
}
