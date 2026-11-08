// #203/#264 (gui-design §4.40) — the centre GRID keeps its scroll place
// across any leave-and-return: the place is saved while the grid is on
// screen (while `active`), and restored whenever the grid RETURNS
// (active flips back on, or `key` — the mode — changes with the grid on
// screen). The container's scroll while the full image is open is the
// focus view's own and never overwrites the saved place (the save gate).
import { useLayoutEffect, useRef, type SyntheticEvent } from "react";

export interface ScrollPlace {
  ref: React.RefObject<HTMLDivElement | null>;
  onScroll: (e: SyntheticEvent<HTMLDivElement>) => void;
  /** the saved place (exposed for tests) */
  pos: React.MutableRefObject<number>;
}

export function useScrollPlace(key: unknown, active: boolean): ScrollPlace {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useRef(0);
  useLayoutEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (el) el.scrollTop = pos.current;
  }, [key, active]);
  const onScroll = (e: SyntheticEvent<HTMLDivElement>) => {
    if (active) pos.current = e.currentTarget.scrollTop;
  };
  return { ref, onScroll, pos };
}
