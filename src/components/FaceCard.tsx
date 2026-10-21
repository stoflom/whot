import { memo, type MouseEvent as ReactMouseEvent } from "react";
import type { Face } from "../api";
import { useFaceImage } from "../hooks";
import { stagedFieldsForCard, type Stage } from "../stage";

interface Props {
  face: Face;
  selected: boolean;
  isPrimary: boolean;
  /** #101: the live stage — its fields preview on this card's labels */
  stage: Stage | null;
  onToggle: (id: number) => void;
  /** plain click: select just this card — drops the range anchor (#69) */
  onSelectOne: (id: number) => void;
  /** shift-click: select the range from the anchor to this card (#69) */
  onRangeSelect: (id: number) => void;
  /** double-click: open the full image (§3 card double-click) */
  onOpen: (id: number) => void;
  /** right-click context menu (#32) */
  onContextMenu: (id: number, e: ReactMouseEvent) => void;
  /** the card's person (name + group path) — shown as labels (#101) */
  personName?: string;
  personGroup?: string;
  /** total selection size — ★/◈ are single-face actions and grey out
      while this card is part of a multi-selection (#49, §4.14) */
  selSize: number;
  /** #101 (§4.24): the card's only editable surface — the Edit dialog */
  onEdit: (id: number) => void;
  onPrimary: (id: number) => void;
  onRefcrop: (id: number) => void;
  onReject: (id: number) => void;
  onAccept: (id: number) => void;
}

// #98 (§4.31): memoised — with the grid handlers stable (one useMemo in
// App), every selection/mutation re-render skips the cards whose own
// props did not change (thousands of cards in review mode).
// #101 (§4.24): the card shows labels (name, group, description) + one
// Edit… button — no inline inputs, no blur/commit machinery.
function FaceCard({
  face,
  selected,
  isPrimary,
  stage,
  onToggle,
  onSelectOne,
  onRangeSelect,
  onOpen,
  onContextMenu,
  personName,
  personGroup,
  selSize,
  onEdit,
  onPrimary,
  onRefcrop,
  onReject,
  onAccept,
}: Props) {
  const img = useFaceImage(face.id);
  const staged = stagedFieldsForCard(stage, face.id);
  const nameVal = staged.name ?? personName ?? "";
  const groupVal = staged.group ?? personGroup ?? "";
  const descVal = staged.desc ?? face.description ?? "";
  // unowned faces (removed person, §4.13): no primary/reference actions
  const unowned = face.person_id == null;
  // #49 (§4.14): this card is part of a multi-selection — ★/◈ cannot
  // apply to more than one face, so they are greyed out, never re-routed
  const scopeMulti = selected && selSize > 1;
  const scopeLabel = scopeMulti ? ` (${selSize} selected)` : "";

  return (
    <div
      className={`face-card status-${face.link_status}${selected ? " selected" : ""}`}
      data-face-id={face.id}              // #96: accept-&-next scroll target
      title={face.name}
      onDoubleClick={() => onOpen(face.id)}
      onContextMenu={(e) => onContextMenu(face.id, e)}
      // #53 (§4.17): ctrl/cmd-click toggles the selection; #69: plain
      // click drops the anchor (selects just this card), shift-click
      // selects the range from the anchor — double-click-to-open is
      // unaffected
      onClick={(e) => {
        // clicks inside the card's own controls — checkbox, Edit and the
        // ★/◈/✗ buttons — are theirs, never a re-selection: a
        // multi-selection must survive acting on one card (#70)
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
        <span
          className={`card-label name${staged.name != null ? " staged" : ""}${nameVal ? "" : " empty"}`}
          title="Person name"
        >
          {nameVal || "–"}
        </span>
        <span
          className="face-conf"
          title="Confidence — recognizer match score (read-only)"
        >
          {Math.round(face.confidence * 100)}%
        </span>
      </div>
      <div className="card-values">
        <span
          className={`card-label${staged.group != null ? " staged" : ""}${groupVal ? "" : " empty"}`}
          title="Group"
        >
          {groupVal || "–"}
        </span>
        <span
          className={`card-label${staged.desc != null ? " staged" : ""}${descVal ? "" : " empty"}`}
          title="Description"
        >
          {descVal || "–"}
        </span>
        <button
          className="ghost card-edit"
          onClick={() => onEdit(face.id)}
          title="Edit name/group/description — dialog, scope Card (#101, §4.24)"
        >
          Edit…
        </button>
      </div>
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

export default memo(FaceCard);
