import {
  memo,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Face } from "../api";
import { useFaceImage } from "../hooks";
import { rotStyle } from "../rotation";
import { stagedFieldsForCard, type Stage } from "../stage";

interface Props {
  face: Face;
  selected: boolean;
  isPrimary: boolean;
  /** #101/#123: the live pending set — its fields preview on this card's labels */
  stage: Stage[];
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
      while this card is part of a multi-selection (#49, §4.14). Passed
      only to selected cards (#109): a stable `undefined` is what lets
      an unselected card's memo hold across toggles elsewhere */
  selSize?: number;
  /** #101 (§4.24): the card's only editable surface — the Edit dialog */
  onEdit: (id: number) => void;
  onPrimary: (id: number) => void;
  onRefcrop: (id: number) => void;
  onReject: (id: number) => void;
  /** #135/#136 (rule 34): start dragging this card — or the whole
      selection it is part of (the payload rule lives in App) */
  onFaceDragStart: (id: number, e: ReactDragEvent) => void;
  /** the drag ended (drop, Esc, cancel) — clears the App payload */
  onFaceDragEnd: () => void;
  /** #136: a face drag hovers this card — valid only with a description */
  onFaceDragOver: (id: number, e: ReactDragEvent) => void;
  onFaceDragLeave: (id: number) => void;
  /** #136: a face drag dropped on this card — copy its description */
  onFaceDropOnCard: (id: number, e: ReactDragEvent) => void;
  /** #136: a description drop is currently hovering this card */
  descTarget: boolean;
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
  onFaceDragStart,
  onFaceDragEnd,
  onFaceDragOver,
  onFaceDragLeave,
  onFaceDropOnCard,
  descTarget,
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
  const scopeMulti = selected && (selSize ?? 0) > 1;
  const scopeLabel = scopeMulti ? ` (${selSize} selected)` : "";

  return (
    <div
      className={`face-card status-${face.link_status}${selected ? " selected" : ""}${descTarget ? " desc-target" : ""}`}
      data-face-id={face.id}              // #96: accept-&-next scroll target
      title={face.name}
      // #135/#136 (rule 34): the card is a drag source — the payload is
      // the whole selection when this card is part of one (App decides)
      draggable
      // #135 fix (v3.33): a plain press on an UNSELECTED card selects it
      // first, so a drag started immediately carries it; the payload rule
      // (selection vs single) then applies uniformly. Modifier presses
      // (ctrl/shift) keep the click handler's semantics untouched.
      onMouseDown={(e) => {
        if (
          e.button !== 0 ||
          e.ctrlKey ||
          e.metaKey ||
          e.shiftKey ||
          selected ||
          (e.target as HTMLElement).closest(".face-check, input, textarea, button")
        )
          return;
        onSelectOne(face.id);
      }}
      onDragStart={(e) => onFaceDragStart(face.id, e)}
      onDragEnd={onFaceDragEnd}
      onDragOver={(e) => onFaceDragOver(face.id, e)}
      onDragLeave={() => onFaceDragLeave(face.id)}
      onDrop={(e) => onFaceDropOnCard(face.id, e)}
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
        {img ? (
          // #122: the crop's stored display rotation, independent of the
          // full-image rotation. #135 fix (v3.33): draggable={false} —
          // otherwise pressing on the crop (most of the card's area) starts
          // a native IMAGE drag (a URL, copy-only) that WebKit never drops
          // back into the app; the card div is the drag source
          <img
            src={img}
            alt=""
            style={rotStyle(face.rotation)}
            draggable={false}
          />
        ) : (
          <div className="face-img-loading" />
        )}
        {/* #102: the name sits inside the frame, at the top — its own strip */}
        <span
          className={`card-label name${staged.name != null ? " staged" : ""}${nameVal ? "" : " is-empty"}`}
          title="Person name"
        >
          {nameVal || "–"}
        </span>
        {isPrimary && <span className="face-badge primary">★</span>}
        <span className={`face-badge status status-${face.link_status}`}>
          {face.link_status === "provisional"
            ? "new"
            : face.link_status === "confirmed"
              ? "✓"
              : "✗"}
        </span>
      </div>
      {/* #102: group and description as full-width rows, then accuracy +
          Edit… — the three fields stay visually distinct */}
      <div className="card-row">
        <span
          className={`card-label group${staged.group != null ? " staged" : ""}${groupVal ? "" : " is-empty"}`}
          title="Group — edit via the Edit… dialog"
        >
          {groupVal || "Friends|School"}
        </span>
      </div>
      <div className="card-row">
        <span
          className={`card-label desc${staged.desc != null ? " staged" : ""}${descVal ? "" : " is-empty"}`}
          title="Description — edit via the Edit… dialog"
        >
          {descVal || "description"}
        </span>
      </div>
      <div className="card-foot">
        <span
          className="face-conf"
          title="Confidence — recognizer match score (read-only)"
        >
          {Math.round(face.confidence * 100)}%
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
        {/* #165/§4.35: the Un-reject (undo) affordance retired — plain
            accept never un-rejects, the way back is an assignment; a
            rejected face renders with no action button. */}
        {face.link_status !== "rejected" && (
          <button
            title={
              "Reject face — only rejected faces get a ✗ marker; accepted is the default" +
              scopeLabel
            }
            onClick={() => onReject(face.id)}
          >
            ✗
          </button>
        )}
      </div>
    </div>
  );
}

export default memo(FaceCard);
