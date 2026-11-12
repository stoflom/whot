// #203/#264 (gui-design §4.40) — the centre GRID keeps its scroll place
// across any leave-and-return: the place is saved while the grid is on
// screen (while `active`), and restored whenever the grid RETURNS
// (active flips back on, or `key` — the mode — changes with the grid on
// screen). The container's scroll while the full image is open is the
// focus view's own and never overwrites the saved place (the save gate).
//
// #297 (rule 50, v15.0) — optional persistence: with `persist` (the
// mode) the place also survives an app restart, under the ONE session
// blob (per-mode field, written throttled while active and flushed on
// unmount). The storage merge lives in useSessionState.ts.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type SyntheticEvent,
} from "react";
import type { Mode } from "./sections";
import { persistSessionPatch } from "./useSessionState";
import { parseSession, sessionInitial, SESSION_STORAGE_KEY } from "./sessionState";

export interface ScrollPlace {
  ref: React.RefObject<HTMLDivElement | null>;
  onScroll: (e: SyntheticEvent<HTMLDivElement>) => void;
  /** the saved place (exposed for tests) */
  pos: React.MutableRefObject<number>;
}

const persistedPlace = (persist: Mode | undefined): number | null => {
  if (persist == null) return null;
  try {
    return sessionInitial(parseSession(localStorage.getItem(SESSION_STORAGE_KEY)))
      .scroll[persist] ?? null;
  } catch {
    return null;
  }
};

const saveDelay = 300; // ms — scroll events must not hit storage per event

export function useScrollPlace(
  key: unknown,
  active: boolean,
  persist?: Mode
): ScrollPlace {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useRef(-1); // -1 = not yet placed (restores on first activation)
  const saveTimer = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    if (pos.current < 0) pos.current = persistedPlace(persist) ?? 0;
    const el = ref.current;
    if (el) el.scrollTop = pos.current;
  }, [key, active]);
  const scheduleSave = () => {
    if (persist == null) return;
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      if (pos.current >= 0) persistSessionPatch({ scroll: { [persist]: pos.current } });
    }, saveDelay);
  };
  // the flush: a leave-and-return that outlives the component (a mode
  // switch unmounts the pane) writes the last active place
  useEffect(
    () => () => {
      if (saveTimer.current != null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (persist != null && pos.current >= 0)
        persistSessionPatch({ scroll: { [persist]: pos.current } });
    },
    [persist]
  );
  const onScroll = (e: SyntheticEvent<HTMLDivElement>) => {
    if (!active) return;
    pos.current = e.currentTarget.scrollTop;
    scheduleSave();
  };
  return { ref, onScroll, pos };
}
