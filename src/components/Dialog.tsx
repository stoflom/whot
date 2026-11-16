// #326 — the ONE dialog chrome: every modal overlay renders through
// this wrapper so assistive tech sees a real dialog (role="dialog",
// aria-modal, aria-label from the title) instead of an unnamed div.
// While open it moves the initial focus inside, keeps Tab inside (the
// trap), and restores the previously focused element on close.
//
// It also carries the #138 overlay registration (useOwnsKeyboard) —
// the wrapper IS the open lifetime of the dialog, so a dialog can no
// longer forget to register.
import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useOwnsKeyboard } from "../overlays";

/** the focus-trap candidate — the standard focusable set */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  /** aria-label — the dialog's title (its name to assistive tech) */
  label: string;
  /** extra overlay classes ("modeless", "settings-overlay", …) */
  className?: string;
  /** #176/§4.41 modeless — the click-through pointer (guards.tsx):
      the background stays interactive, so NO aria-modal, NO initial
      focus move, NO trap (the #138 keyboard registration is kept —
      the modeless pointer still owns the keyboard while mounted) */
  modeless?: boolean;
  /** the backdrop mousedown (the click-outside-to-close behaviour) */
  onBackdrop?: () => void;
  children: ReactNode;
}

export default function Dialog({
  label,
  className,
  modeless = false,
  onBackdrop,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useOwnsKeyboard(); // #138 — an open dialog owns the keyboard
  useEffect(() => {
    if (modeless) return;
    const el = ref.current;
    if (!el) return;
    // the element focused before this dialog opened — restored on close
    const prev = (document.activeElement as HTMLElement | null) ?? null;
    // initial focus: a child that already grabbed it (React's autoFocus
    // runs before this effect) keeps it; otherwise the first focusable
    // element, otherwise the dialog box itself
    if (!el.contains(document.activeElement)) {
      (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    }
    // the focus trap — Tab/Shift+Tab cycle inside this dialog. Stacked
    // dialogs: only the one THAT CONTAINS THE FOCUS acts, so the
    // topmost (which grabbed it on open) owns the trap.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (!el.contains(document.activeElement)) return;
      const items = [
        ...el.querySelectorAll<HTMLElement>(FOCUSABLE),
      ].filter((n) => n !== el);
      if (items.length === 0) {
        e.preventDefault(); // nothing inside — keep focus on the box
        el.focus();
        return;
      }
      const idx = items.indexOf(document.activeElement as HTMLElement);
      if (idx === -1) {
        // on the dialog box itself (tabIndex=-1) — go with the direction
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
        e.preventDefault();
        return;
      }
      if (e.shiftKey && idx === 0) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && idx === items.length - 1) {
        e.preventDefault();
        items[0].focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // restore on close — the previously focused element, if it is
      // still in the document (its own dialog may have closed too)
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [modeless]);
  return (
    <div
      ref={ref}
      className={className ? `overlay ${className}` : "overlay"}
      role="dialog"
      aria-label={label}
      aria-modal={modeless ? undefined : true}
      tabIndex={-1}
      onMouseDown={(e: ReactMouseEvent<HTMLDivElement>) => {
        if (!modeless && e.target === e.currentTarget) onBackdrop?.();
      }}
    >
      {children}
    </div>
  );
}
