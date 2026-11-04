// §4.44 (gui-design v3.94, #206 stage 2) — the session pane widths (#34)
// and the §4.39 Rolls browsing centre width (#174) as a hook: App keeps
// the named state it always had, the layout rules live here.

import { useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type SetStateAction } from "react";

export interface PaneSizes {
  left: number;
  right: number;
}

export interface PaneSizesApi {
  paneSizes: PaneSizes;
  setPaneSizes: Dispatch<SetStateAction<PaneSizes>>;
  /** #174: null = follow the left pane's width (the default) */
  rollCenter: number | null;
  setRollCenter: Dispatch<SetStateAction<number | null>>;
  rollCenterPx: number;
  startDrag: (edge: "left" | "right") => (e: ReactMouseEvent) => void;
}

/** #174/§4.39 — the clamp rule, pure (the right pane keeps a usable
    floor while the centre may take 10%..70% of the window) */
export function clampRollCenterFor(
  px: number,
  innerWidth: number,
  leftPane: number,
): number {
  const lo = Math.round(innerWidth * 0.1);
  const hi = Math.max(
    Math.min(Math.round(innerWidth * 0.7), innerWidth - leftPane - 200),
    lo
  );
  return Math.min(Math.max(px, lo), hi);
}

/** #34 — pane sizes (session state); defaults match the stylesheet
    (#55: the image-split size is gone — the focus mode takes the pane).
    #174 follow-up (§4.39): Rolls mode's CENTRE width while browsing —
    null = follow the left pane's width (the default: most of the
    window goes to the right pane's thumbnails, which flex to fill);
    an explicit px persists for the session. While it applies, the
    centre|right divider drags the CENTRE instead of the right pane. */
export function usePaneSizes(rollsBrowse: boolean): PaneSizesApi {
  const [paneSizes, setPaneSizes] = useState<PaneSizes>({ left: 250, right: 290 });
  const [rollCenter, setRollCenter] = useState<number | null>(null);
  const rollCenterPx = clampRollCenterFor(
    rollCenter ?? paneSizes.left,
    window.innerWidth,
    paneSizes.left
  );
  const dragRef = useRef<{ edge: "left" | "right"; startX: number; start: number } | null>(
    null
  );
  const startDrag = (edge: "left" | "right") => (e: ReactMouseEvent) => {
    e.preventDefault();
    // read once at drag start — the layout class must not flip mid-drag
    const browse = rollsBrowse;
    dragRef.current = {
      edge,
      startX: e.clientX,
      start: edge === "right" && browse ? rollCenterPx : paneSizes[edge],
    };
    // #226 (F-M6): the drag used to setPaneSizes/setRollCenter per raw
    // mousemove — one whole-App render per event (the hover listener
    // already rAF-throttles its own work; the drag now does too). The
    // latest pointer position is coalesced to at most one state update
    // per frame; mouseup flushes the final position so the committed
    // size is the pointer's last word, not the last frame's.
    let raf = 0;
    let pendingX: number | null = null;
    const apply = (clientX: number) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = clientX - d.startX;
      if (d.edge === "left") {
        setPaneSizes((s) => ({ ...s, left: Math.min(Math.max(d.start + dx, 160), 480) }));
        return;
      }
      if (browse) {
        // #174/§4.39: divider right = centre wider (right pane flexes)
        setRollCenter(clampRollCenterFor(d.start + dx, window.innerWidth, paneSizes.left));
        return;
      }
      setPaneSizes((s) => ({ ...s, right: Math.min(Math.max(d.start - dx, 200), 560) }));
    };
    const move = (ev: MouseEvent) => {
      pendingX = ev.clientX;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const x = pendingX;
        pendingX = null;
        if (x != null) apply(x);
      });
    };
    const up = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      const x = pendingX;
      pendingX = null;
      if (x != null) apply(x); // commit the final size
      dragRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return { paneSizes, setPaneSizes, rollCenter, rollCenterPx, setRollCenter, startDrag };
}
