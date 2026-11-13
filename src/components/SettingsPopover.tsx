import { useEffect, useState } from "react";
import type { Settings } from "../api";
import { useOwnsKeyboard } from "../overlays";

interface Props {
  settings: Settings;
  onSave: (s: Settings) => void;
  /** #303 (rule 52): opens the environment dialog (App closes this
      popover and swaps) */
  onEnv?: () => void;
  onClose: () => void;
}

export default function SettingsPopover({ settings, onSave, onEnv, onClose }: Props) {
  useOwnsKeyboard(); // #138 (the shortcut guard never saw this popover)
  // #248: the topmost overlay owns Esc — the popover had no field-level
  // escape at all, so Esc was dead until focus left the inputs
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const [threshold, setThreshold] = useState(settings.cluster_threshold);
  const [refcropN, setRefcropN] = useState(settings.refcrop_n);
  // #273 → the popover's fields: the two system viewers are free-text
  // program paths (v12.2, #279 — show/edit them like the other entries)
  const [imageViewer, setImageViewer] = useState(settings.image_viewer);
  const [directoryViewer, setDirectoryViewer] = useState(settings.directory_viewer);
  useEffect(() => {
    setThreshold(settings.cluster_threshold);
    setRefcropN(settings.refcrop_n);
    setImageViewer(settings.image_viewer);
    setDirectoryViewer(settings.directory_viewer);
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
            title="0–1: minimum similarity for faces to group under one person"
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
            title="How many reference crops to keep per person (top by confidence)"
            value={refcropN}
            onChange={(e) => setRefcropN(parseInt(e.target.value) || 1)}
          />
        </label>
        {/* #273/v12.2 (#279): the system viewers — free text; empty means
            the system default opener (never a lost setting) */}
        <label>
          Image viewer (the Open in system viewer program)
          <input
            type="text"
            title="Program for the Open in system viewer entry — empty uses the system default"
            placeholder="empty = system default"
            value={imageViewer}
            onChange={(e) => setImageViewer(e.target.value)}
          />
        </label>
        <label>
          Directory viewer (the Open roll path program)
          <input
            type="text"
            title="Program / file manager for the Open roll path entry — empty uses the system default"
            placeholder="empty = system default"
            value={directoryViewer}
            onChange={(e) => setDirectoryViewer(e.target.value)}
          />
        </label>
        <div className="dialog-actions">
          {onEnv && (
            <button className="secondary" title="the machine's paths in whotrc.json's env object" onClick={onEnv}>
              environment…
            </button>
          )}
          <button className="secondary" onClick={onClose}>cancel</button>
          <button onClick={() => onSave({ ...settings, ...clamped, image_viewer: imageViewer, directory_viewer: directoryViewer })}>save</button>
        </div>
      </div>
    </div>
  );
}
