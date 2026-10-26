/**
 * #138 (§4.30, Q8 stack): "An open modal owns the keyboard".
 *
 * Every overlay layer above preview-undo — dialog, context menu,
 * popover, merge confirm — registers itself here while it is mounted.
 * All overlay components are rendered conditionally only while they are
 * open, so the mount lifetime IS the open lifetime: App-owned layers,
 * the tree's own menus/dialog and the merge dialogs all count, with no
 * hand-maintained state list to drift.
 *
 * App reads `useOverlayCount()` and gates BOTH keyboard guards (the
 * Esc-stack effect and the letter/arrow shortcuts) on it — one source
 * of truth. A future modal means "call the hook", not "remember two
 * lists".
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

interface OverlayCtx {
  count: number;
  register: () => () => void;
}

const Ctx = createContext<OverlayCtx>({ count: 0, register: () => () => {} });

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const register = useCallback(() => {
    setCount((c) => c + 1);
    return () => setCount((c) => Math.max(0, c - 1));
  }, []);
  return <Ctx.Provider value={{ count, register }}>{children}</Ctx.Provider>;
}

/** an overlay calls this once at its top level — while mounted it owns the keyboard */
export function useOwnsKeyboard(): void {
  const { register } = useContext(Ctx);
  useEffect(() => register(), [register]);
}

/** live count of open overlay layers (modal-owner rule of Q8) */
export function useOverlayCount(): number {
  return useContext(Ctx).count;
}
