import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Face } from "../api";
import { useFaceImage } from "../hooks";

interface Props {
  face: Face;
  selected: boolean;
  hovered: boolean;
  isPrimary: boolean;
  onToggle: (id: number) => void;
  onHover: (id: number | null) => void;
  /** double-click: open the full image (§3 card double-click) */
  onOpen: (id: number) => void;
  /** right-click context menu (#32) */
  onContextMenu: (id: number, e: ReactMouseEvent) => void;
  /** person's name — the face-meta input assigns that person (#29) */
  personName?: string;
  onAssignName: (faceId: number, name: string) => void;
  onDescription: (id: number, description: string) => void;
  onPrimary: (id: number) => void;
  onRefcrop: (id: number) => void;
  onReject: (id: number) => void;
  onAccept: (id: number) => void;
}

export default function FaceCard({
  face,
  selected,
  hovered,
  isPrimary,
  onToggle,
  onHover,
  onOpen,
  onContextMenu,
  personName,
  onAssignName,
  onDescription,
  onPrimary,
  onRefcrop,
  onReject,
  onAccept,
}: Props) {
  const img = useFaceImage(face.id);
  const [desc, setDesc] = useState(face.description ?? "");
  useEffect(() => setDesc(face.description ?? ""), [face.description]);
  const [pname, setPname] = useState(personName ?? "");
  useEffect(() => setPname(personName ?? ""), [personName]);

  const commit = () => {
    if (desc !== (face.description ?? "")) onDescription(face.id, desc);
  };
  const commitName = () => {
    const v = pname.trim();
    // assigning, not renaming: an existing person merges into (v1.7 §3)
    if (v && v !== personName) onAssignName(face.id, v);
    else setPname(personName ?? "");
  };

  return (
    <div
      className={`face-card status-${face.link_status}${selected ? " selected" : ""}${hovered ? " hovered" : ""}`}
      title={face.name}
      onMouseEnter={() => onHover(face.id)}
      onMouseLeave={() => onHover(null)}
      onDoubleClick={() => onOpen(face.id)}
      onContextMenu={(e) => onContextMenu(face.id, e)}
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
        <input
          className="face-person-name"
          value={pname}
          placeholder="person name"
          title={face.name}
          onChange={(e) => setPname(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setPname(personName ?? "");
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
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
