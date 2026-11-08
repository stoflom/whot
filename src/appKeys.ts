// #258 — App's global keyboard dispatcher and its §-Q8 Esc stack,
// relocated byte-for-byte from App.tsx into ONE co-tested hook.
//
// The 15(-17)-property "latest-value" object App used to write out
// TWICE (the useRef initial value + the per-render re-assignment, the
// house #228/#222 pattern) becomes the SINGLE `input` object the hook
// takes — one literal, stored once per render, and the once-bound
// listener reads it at event time.
//
// Only the volatile render values ride `input`. The refs that live
// across events (the Q4 context-confirm bail signal, the live pending
// stage, the cursor/hover anchors) stay in App — the hook receives
// them plus the two state transitions the Esc stack needs.
//
// The guards are preserved EXACTLY (this is a relocation, not a
// rewrite): the #96/#53/#68 typing+focus bail, the #255 data-owns-keys
// bail, the Q8 overlay-count bail (#138 — ONE registry count covers
// every overlay layer), the #187 stale-window context-confirm bail
// (both stacks), then the #53/#68/#75/~§4.30/#96/#235/#95 shortcuts.

import { useEffect, useRef, type RefObject } from "react";
import type { Mode } from "./sections";
import type { Section } from "./components/FaceGrid";
import type { Stage } from "./stage";

export interface AppKeysInput {
  overlayCount: number;
  sections: Section[];
  sectionsForImage: (imgId: number) => Section[];
  sectionUnderCursor: (rendered: Section[]) => Section | undefined;
  sel: Set<number>;
  splitImageId: number | null;
  imageId: number | null;
  mode: Mode;
  toggle: (id: number) => void;
  toggleMany: (ids: number[], on: boolean) => void;
  changeSel: (next: Set<number>) => void;
  commitPending: (all: Stage[], acceptIds?: number[]) => unknown;
  acceptAndNext: (ids: number[], claimed?: boolean) => unknown;
  doReject: (ids: number[]) => void;
  stepPerson: (dir: 1 | -1) => void;
  stepImage: (dir: 1 | -1) => void;
}

export interface AppKeysInternals {
  contextConfirmRef: RefObject<{ fn: () => void } | null>;
  pendingRef: RefObject<Stage[]>;
  hoverRef: RefObject<number | null>;
  lastSelRef: RefObject<number | null>;
  /** #123: Esc on a live stage = Undo — the whole set drops */
  clearPending: () => void;
  /** #25: Esc closes the double-click image split */
  closeSplit: () => void;
}

export function useAppKeys(input: AppKeysInput, x: AppKeysInternals): void {
  // the house latest-value pattern: assign once per render, read at
  // event time — the listener below binds once for the app lifetime
  const inputRef = useRef(input);
  inputRef.current = input;
  const xRef = useRef(x);
  xRef.current = x;

  // ── the global keydown dispatcher (#68/#53/#96/#95/#235/#255) ──
  // #228 (F-L3): everything volatile is read via inputRef above — the
  // listener binds once for the app's lifetime (no exhaustive-deps
  // disable needed: the empty dep list is literally correct)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const {
        overlayCount, sections, sectionsForImage, sectionUnderCursor,
        sel, splitImageId, imageId,
        mode,
        toggle, toggleMany, changeSel, commitPending, acceptAndNext, doReject,
        stepPerson, stepImage,
      } = inputRef.current;
      const { contextConfirmRef, pendingRef, hoverRef, lastSelRef } = xRef.current;
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" ||
          tgt.tagName === "SELECT" || tgt.isContentEditable ||
          // #96: Enter/Space activate a focused button natively — never
          // double them with the shortcuts below
          tgt.tagName === "BUTTON" ||
          // #255: a focused a11y control (tree node / roll header / pane
          // divider) owns its own keys — never step/accept behind it
          tgt.hasAttribute("data-owns-keys"))
      )
        return;
      // an open modal dialog owns the keyboard (Q8 stack): never act
      // behind it — the #138 registry count covers EVERY overlay layer,
      // App-owned or child-owned (the old state list let the face-merge
      // dialog, tree menus/group dialog and the settings popover slip
      // through)
      if (overlayCount > 0) return;
      // #187: same stale-count window as the Esc stack — never act
      // (select-all, Accept, reject, step …) behind a queued/open Q4 dialog
      if (contextConfirmRef.current != null && pendingRef.current.length > 0) return;
      // #53 (§4.17): Ctrl-G toggles the whole section — the one under
      // the mouse cursor first (#74), else the hovered card's, else the
      // most recently selected card's; preventDefault so webkit cannot
      // steal the chord
      if ((e.ctrlKey || e.metaKey) && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        // in focus mode the rendered sections are the film roll's (#55)
        const rendered =
          splitImageId != null ? sectionsForImage(splitImageId) : sections;
        let section = sectionUnderCursor(rendered);
        if (!section) {
          const targetId = hoverRef.current ?? lastSelRef.current;
          if (targetId == null) return;
          section = rendered.find((s) => s.faceIds.includes(targetId));
        }
        if (!section || section.faceIds.length === 0) return;
        const all = section.faceIds.every((id) => sel.has(id));
        toggleMany(section.faceIds, !all);
        return;
      }
      // #68 — core shortcut set: scope follows the hovered/last-selected
      // card (like Ctrl-G); plain letters only, dialogs/menus/inputs above
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        const rendered =
          splitImageId != null ? sectionsForImage(splitImageId) : sections;
        changeSel(new Set(rendered.flatMap((s) => s.faceIds)));
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === " ") {
          const targetId = hoverRef.current ?? lastSelRef.current;
          if (targetId == null) return;
          e.preventDefault();
          toggle(targetId);
        } else if (e.key === "a" || e.key === "A") {
          // §4.30/#166: Accept is stage-then-commit — with a live pending
          // set the keys do what the bottom-bar Accept does: commit the
          // staged ops, then accept the DISPLAYED scope (selection, else
          // the hovered card — cursor-as-target §4.25) with the review
          // advance
          if (pendingRef.current.length > 0) {
            e.preventDefault();
            const ids =
              sel.size > 0 ? [...sel] : hoverRef.current != null ? [hoverRef.current] : [];
            void commitPending(pendingRef.current, ids);
            return;
          }
          // #75: cursor-as-target — the hovered card stands in for the
          // selection when there is none
          const ids =
            sel.size > 0 ? [...sel] : hoverRef.current != null ? [hoverRef.current] : [];
          if (ids.length > 0) {
            e.preventDefault();
            acceptAndNext(ids);          // #96: advances in review mode
          }
        } else if (e.key === "Enter" && mode === "review") {
          // #96 (§4.30): Enter with no field focused = Accept & next —
          // in-field Enter keeps its commit meaning (the guard above
          // already keeps inputs out of this handler) — #166: a live
          // pending set commits its ops, then accepts the displayed scope
          if (pendingRef.current.length > 0) {
            e.preventDefault();
            const ids =
              sel.size > 0 ? [...sel] : hoverRef.current != null ? [hoverRef.current] : [];
            void commitPending(pendingRef.current, ids);
            return;
          }
          const ids =
            sel.size > 0 ? [...sel] : hoverRef.current != null ? [hoverRef.current] : [];
          if (ids.length > 0) {
            e.preventDefault();
            acceptAndNext(ids);
          }
        } else if (e.key === "r" || e.key === "R") {
          const ids =
            sel.size > 0 ? [...sel] : hoverRef.current != null ? [hoverRef.current] : [];
          if (ids.length > 0) {
            e.preventDefault();
            doReject(ids);
          }
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          const dir: 1 | -1 = e.key === "ArrowRight" ? 1 : -1;
          if (mode === "rolls") {
            // #235 (rule 46): in Rolls the arrows step the OPEN film-
            // roll image; while browsing (no image open) they stay inert
            // and keep their native scroll behaviour (#163)
            if (imageId == null) return;
            e.preventDefault();
            stepImage(dir);
          } else {
            // #95: plain arrows step persons (§4.22/#31) — they were
            // dead because this block returned before the arrow checks
            e.preventDefault();
            stepPerson(dir);
          }
        }
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── the Esc stack (#25/#47/#101/#123/#187; §4.19 + the Q8 stack) ──
  // dialogs/menus/popovers own Esc first, then a live stage's
  // preview-undo (F1), then the split — while typing, Esc always
  // cancels the field itself. The #123 context-change dialog is one of
  // those dialogs: dropping the set under it both violates the stack
  // and unmounts the dialog mid-dispatch
  // #25 — Esc closes the double-click image split
  // #138: which overlays are open is ONE registry count, not a list of
  // states — the ladder state list has drifted before (face-merge, tree
  // menus, group dialog were invisible to it)
  useEffect(() => {
    if (input.overlayCount > 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tgt = e.target as HTMLElement | null;
      const typing =
        !!tgt &&
        (tgt.tagName === "INPUT" ||
          tgt.tagName === "TEXTAREA" ||
          tgt.tagName === "SELECT" ||
          tgt.isContentEditable);
      // #187: a queued/open Q4 dialog owns Esc even before the
      // overlayCount chain catches up — preview-undo here would drop the
      // set behind it and unmount the dialog mid-dispatch
      if (xRef.current.contextConfirmRef.current != null && xRef.current.pendingRef.current.length > 0) return;
      if (xRef.current.pendingRef.current.length > 0) {
        if (!typing) {
          xRef.current.clearPending(); // #123: Undo = Cancel — the whole set drops
          e.preventDefault();
        }
        return;
      }
      if (input.splitImageId != null) xRef.current.closeSplit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input.overlayCount, input.splitImageId]);
}
