import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Face } from "../api";
import { useFaceImage } from "../hooks";
import { selectAllIfAuto } from "../autoText";

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
  /** total selection size — ★/◈ are single-face actions and grey out
      while this card is part of a multi-selection (#49, §4.14) */
  selSize: number;
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
  selSize,
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
  // unowned faces (removed person, §4.13): no primary/reference actions
  const unowned = face.person_id == null;
  // #49 (§4.14): this card is part of a multi-selection — ★/◈ cannot
  // apply to more than one face, so they are greyed out, never re-routed
  const scopeMulti = selected && selSize > 1;
  const scopeLabel = scopeMulti ? ` (${selSize} selected)` : "";

  return (
    <div
      className={`face-card status-${face.link_status}${selected ? " selected" : ""}${hovered ? " hovered" : ""}`}
      title={face.name}
      onMouseEnter={() => onHover(face.id)}
      onMouseLeave={() => onHover(null)}
      onDoubleClick={() => onOpen(face.id)}
      onContextMenu={(e) => onContextMenu(face.id, e)}
      // #53 (§4.17): ctrl/cmd-click toggles the selection — the tree's
      // idiom mirrored on cards; plain click stays inert so
      // double-click-to-open is unaffected
      onClick={(e) => {
        // the checkbox has its own toggle — don't double-fire on bubbled clicks
        if ((e.target as HTMLElement).closest(".face-check")) return;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          onToggle(face.id);
        }
      }}
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
          title={
            scopeMulti
              ? `Assigning applies to all ${selSize} selected faces`
              : "Name"
          }
          onChange={(e) => setPname(e.target.value)}
          onFocus={selectAllIfAuto} // #67: UnknownN is replaced wholesale
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
        className="face-desc input-desc"
        placeholder="desc e.g. beard|glasses"
        // #58 (§4.14): per-card inputs honour the selection scope —
        // editing here updates every selected face, say so up front
        title={
          scopeMulti
            ? `Editing applies to all ${selSize} selected faces`
            : "Description"
        }
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <div className="face-actions">
        <button
          title={
            scopeMulti
              ? `Set as primary face${scopeLabel} — single-face action, not available`
              : isPrimary
                ? "Primary face"
                : "Set as primary face"
          }
          className={isPrimary ? "on" : ""}
          disabled={unowned || isPrimary || scopeMulti}
          onClick={() => !isPrimary && onPrimary(face.id)}
        >
          ★
        </button>
        <button
          title={
            scopeMulti
              ? `Add as reference face${scopeLabel} — single-face action, not available`
              : "Add as reference face"
          }
          onClick={() => onRefcrop(face.id)}
          disabled={face.link_status !== "confirmed" || unowned || scopeMulti}
        >
          ◈
        </button>
        <button
          title={
            (face.link_status === "rejected"
              ? "Un-reject (accept) face — back to the accepted default"
              : "Reject face — only rejected faces get a ✗ marker; accepted is the default") +
            scopeLabel
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
