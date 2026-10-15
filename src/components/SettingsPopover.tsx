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
        <div className="dialog-actions">
          <button className="secondary" onClick={onClose}>cancel</button>
          <button onClick={() => onSave({ cluster_threshold: threshold, refcrop_n: refcropN })}>
            save
          </button>
        </div>
      </div>
    </div>
  );
}
