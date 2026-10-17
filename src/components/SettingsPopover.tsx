import { useEffect, useState } from "react";
import type { Settings } from "../api";

interface Props {
  settings: Settings;
  onSave: (s: Settings) => void;
  onClose: () => void;
}

export default function SettingsPopover({ settings, onSave, onClose }: Props) {
  const [threshold, setThreshold] = useState(settings.cluster_threshold);
  const [refcropN, setRefcropN] = useState(settings.refcrop_n);
  useEffect(() => {
    setThreshold(settings.cluster_threshold);
    setRefcropN(settings.refcrop_n);
  }, [settings]);

  // #48 — min/max attributes only steer the spinner; typed values pass
  // them, so clamp on save (threshold ∈ [0,1], refcrop_n ≥ 1)
  const clamped = {
    cluster_threshold: Math.min(1, Math.max(0, Number.isFinite(threshold) ? threshold : 0)),
    refcrop_n: Math.max(1, Math.floor(Number.isFinite(refcropN) ? refcropN : 1)),
  };

  return (
    <div className="overlay settings-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog settings">
        <h3>Settings</h3>
        <label>
          Similarity threshold (person view grouping)
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            onChange={(e) => setThreshold(parseFloat(e.target.value) || 0)}
          />
        </label>
        <label>
          Reference faces per person (auto, top-N by confidence)
          <input
            type="number"
            min={1}
            max={30}
            step={1}
            value={refcropN}
            onChange={(e) => setRefcropN(parseInt(e.target.value) || 1)}
          />
        </label>
        <div className="shortcuts">
          <h4>Keyboard</h4>
          <ul>
            <li><b>←</b> / <b>→</b> — previous / next person (tree order)</li>
            <li><b>Ctrl-G</b> — select/deselect the whole section (hovered or last-selected card)</li>
            <li><b>Ctrl-click</b> — toggle a face card in the selection</li>
            <li><b>Esc</b> — close split, dialog or context menu</li>
            <li><b>Enter</b> — commit an edited field</li>
            <li>face-card name — assign that person (asks: this face or whole group)</li>
            <li>double-click — rename a person · open a face's full image</li>
            <li>right-click — context menus on tiles and images</li>
          </ul>
        </div>
        <div className="dialog-actions">
          <button className="secondary" onClick={onClose}>cancel</button>
          <button onClick={() => onSave({ ...settings, ...clamped })}>save</button>
        </div>
      </div>
    </div>
  );
}
