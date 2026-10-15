import { useEffect, useState } from "react";
import type { Face } from "../api";
import { useFaceImage } from "../hooks";

interface Props {
  face: Face;
  selected: boolean;
  isPrimary: boolean;
  onToggle: (id: number) => void;
  onDescription: (id: number, description: string) => void;
  onPrimary: (id: number) => void;
  onRefcrop: (id: number) => void;
  onReject: (id: number) => void;
  onAccept: (id: number) => void;
}

export default function FaceCard({
  face,
  selected,
  isPrimary,
  onToggle,
  onDescription,
  onPrimary,
  onRefcrop,
  onReject,
  onAccept,
}: Props) {
  const img = useFaceImage(face.id);
  const [desc, setDesc] = useState(face.description ?? "");
  useEffect(() => setDesc(face.description ?? ""), [face.description]);

  const commit = () => {
    if (desc !== (face.description ?? "")) onDescription(face.id, desc);
  };

  return (
    <div
      className={`face-card status-${face.link_status}${selected ? " selected" : ""}`}
      title={face.name}
    >
      <label className="face-check">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(face.id)}
        />
      </label>
      <div className="face-img">
        {img ? <img src={img} alt="" /> : <div className="face-img-loading" />}
        {isPrimary && <span className="face-badge primary">★</span>}
        <span className={`face-badge status status-${face.link_status}`}>
          {face.link_status === "provisional"
            ? "new"
            : face.link_status === "confirmed"
              ? "✓"
              : "✗"}
        </span>
      </div>
      <div className="face-meta">
        <span className="face-name">{face.name}</span>
        <span className="face-conf">{Math.round(face.confidence * 100)}%</span>
      </div>
      <input
        className="face-desc"
        placeholder="desc e.g. beard|glasses"
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <div className="face-actions">
        <button
          title={isPrimary ? "Primary face" : "Set as primary face"}
          className={isPrimary ? "on" : ""}
          onClick={() => !isPrimary && onPrimary(face.id)}
        >
          ★
        </button>
        <button
          title="Add as reference face"
          onClick={() => onRefcrop(face.id)}
          disabled={face.link_status !== "confirmed"}
        >
          ◈
        </button>
        <button
          title={
            face.link_status === "rejected" ? "Un-reject (accept) face" : "Reject face"
          }
          className={face.link_status === "rejected" ? "reject" : ""}
          onClick={() =>
            face.link_status === "rejected" ? onAccept(face.id) : onReject(face.id)
          }
        >
          {face.link_status === "rejected" ? "undo" : "✗"}
        </button>
      </div>
    </div>
  );
}
