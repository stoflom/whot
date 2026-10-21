import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Face, Person } from "../api";
import { useFaceImage } from "../hooks";
import NameTypeahead from "./NameTypeahead";

interface Props {
  face: Face;
  selected: boolean;
  hovered: boolean;
  isPrimary: boolean;
  onToggle: (id: number) => void;
  /** plain click: select just this card — drops the range anchor (#69) */
  onSelectOne: (id: number) => void;
  /** shift-click: select the range from the anchor to this card (#69) */
  onRangeSelect: (id: number) => void;
  onHover: (id: number | null) => void;
  /** double-click: open the full image (§3 card double-click) */
  onOpen: (id: number) => void;
  /** right-click context menu (#32) */
  onContextMenu: (id: number, e: ReactMouseEvent) => void;
  /** person's name — the face-meta input assigns that person (#29) */
  personName?: string;
  /** #97 (§4.21) — suggestions for the card's name field */
  personOptions: Person[];
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
  onSelectOne,
  onRangeSelect,
  onHover,
  onOpen,
  onContextMenu,
  personName,
  personOptions,
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
      data-face-id={face.id}              // #96: accept-&-next scroll target
      title={face.name}
      onMouseEnter={() => onHover(face.id)}
      onMouseLeave={() => onHover(null)}
      onDoubleClick={() => onOpen(face.id)}
      onContextMenu={(e) => onContextMenu(face.id, e)}
      // #53 (§4.17): ctrl/cmd-click toggles the selection; #69: plain
      // click drops the anchor (selects just this card), shift-click
      // selects the range from the anchor — double-click-to-open is
      // unaffected
      onClick={(e) => {
        // clicks inside the card's own controls — checkbox, name/desc
        // inputs, ★/◈/✗ buttons — are theirs, never a re-selection:
        // a multi-selection must survive editing a card's fields (#70)
        if (
          (e.target as HTMLElement).closest(
            ".face-check, input, textarea, button"
          )
        )
          return;
        if (e.shiftKey) {
          onRangeSelect(face.id);
        } else if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          onToggle(face.id);
        } else {
          onSelectOne(face.id);
        }
      }}
    >
      <label className="face-check">
        <input
          type="checkbox"
          title="Select — click toggles, Shift-click selects a range"
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
        <NameTypeahead
          className="face-person-name"
          value={pname}
          onChange={setPname}
          persons={personOptions}
          placeholder="person name"
          title={
            scopeMulti
              ? `Assigning applies to all ${selSize} selected faces`
              : "Name"
          }
          // #97: click-away commits (typed values used to need Enter);
          // Esc cancels the edit instead — no same-tick blur, so the
          // stale-closure commit can't fire
          onLeave={commitName}
          onEscape={() => setPname(personName ?? "")}
        />
        <span className="face-conf" title="Confidence — recognizer match score (read-only)">{Math.round(face.confidence * 100)}%</span>
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
