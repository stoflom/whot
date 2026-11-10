// v12.2 (#279) — the ? help screen: the shortcuts list moved out of the
// settings popover (it crowded the popover's value fields; §4.48). A
// plain modal dialog like every other overlay: registers with the
// overlay registry (useOwnsKeyboard #138), carries the window-level
// Esc handler (#248 — v5.5) and click-away dismissal.
import { useEffect } from "react";
import { useOwnsKeyboard } from "../overlays";

interface Props {
  onClose: () => void;
}

export default function HelpDialog({ onClose }: Props) {
  useOwnsKeyboard();
  // #248: the topmost overlay owns Esc — a field-level escape cannot
  // cover a list-only dialog, so this listener IS its Esc
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  return (
    <div className="overlay settings-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog settings">
        <h3>Shortcuts</h3>
        <div className="shortcuts">
          <ul>
            <li><b>←</b> / <b>→</b> — previous / next person (tree order; from the person under the cursor if none is selected); in the Rolls view, while a full image is open, the previous / next image of the selected branch</li>
            <li><b>Ctrl-G</b> — select/deselect the group under the cursor (else the hovered or last-selected card's section)</li>
            <li><b>Space</b> — toggle selection of the hovered / last-selected card</li>
            <li><b>Ctrl-A</b> — select all cards in the current view</li>
            <li><b>A</b> / <b>R</b> — accept / reject the selection (the hovered card if nothing is selected)</li>
            <li><b>click</b> — select a single card (drops the range anchor)</li>
            <li><b>Shift-click</b> — select everything from the anchor to the clicked card</li>
            <li><b>Ctrl-click</b> — toggle a face card in the selection</li>
            <li><b>Esc</b> — close split, dialog or context menu</li>
            <li><b>Enter</b> — commit an edited field</li>
            <li>face-card name — assign that person (asks: this face or whole group — unless the card is selected, then the whole selection)</li>
            <li>double-click — rename a person · open a face's full image</li>
            <li>right-click — context menus on tiles and images</li>
          </ul>
        </div>
        <div className="dialog-actions">
          <button className="secondary" onClick={onClose}>close</button>
        </div>
      </div>
    </div>
  );
}
