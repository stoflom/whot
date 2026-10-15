import { useEffect } from "react";

// Disambiguation for the face-card name input (#29 correction, design v1.7):
// the typed name assigns a person (existing merged into, new created) — this
// dialog asks whether the assignment covers just this face or the whole
// group of the face's current person (§4.1 move / rename-in-place).

interface Props {
  name: string;
  /** face count of the current person (what "whole group" covers) */
  groupCount: number;
  onSingle: () => void;
  onGroup: () => void;
  onCancel: () => void;
}

export default function FaceAssignDialog({ name, groupCount, onSingle, onGroup, onCancel }: Props) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog">
        <h3>Assign {name}</h3>
        <p className="dim">
          Assign to <b>{name}</b> — an existing person is merged into, a new one
          is created; faces become <b>confirmed</b>. Apply to:
        </p>
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>cancel</button>
          <button onClick={onSingle}>just this face</button>
          <button className="ok" onClick={onGroup}>
            whole group ({groupCount} {groupCount === 1 ? "face" : "faces"})
          </button>
        </div>
      </div>
    </div>
  );
}
