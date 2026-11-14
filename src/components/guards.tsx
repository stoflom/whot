// The #176 (§4.41) Person-mode guard dialogs (gui-design §4.44 round 2
// stage 4, #295) — the no-anchor pointer (single Close, modeless — the
// tree under it stays clickable) and the sticky-person guard (the Show
// All escape). The copy is product language (rule 43); the open/close
// decisions and the Show-All filter switch stay in App.
import ConfirmDialog from "./ConfirmDialog";
import type { FaceFilter } from "../viewFilters";

export function PickPersonDialog({ onClose }: { onClose: () => void }) {
  return (
    <ConfirmDialog
      title="Please select a person in the tree on the left"
      body={
        "Person mode works on the person anchored in the tree — under Show → All " +
        "every status branch (New, Accepted, Rejected) is listed."
      }
      confirmLabel="Close"
      onlyConfirm
      modeless
      onConfirm={onClose}
      onCancel={onClose}
    />
  );
}

/** the Show → filter label in product language (all→All,
    provisional→New, confirmed→Accepted, rejected→Rejected) */
const filterLabel = (f: FaceFilter): string =>
  f === "all"
    ? "All"
    : f === "provisional"
      ? "New"
      : f === "confirmed"
        ? "Accepted"
        : "Rejected";

/** the title's status word stays lowercase, exactly as the inline
    guard wrote it (#176): "No new faces", not "No New faces" */
const filterWord = (f: FaceFilter): string =>
  f === "provisional" ? "new" : f === "confirmed" ? "accepted" : "rejected";

export function NoFacesDialog({
  faceFilter,
  onShowAll,
  onClose,
}: {
  faceFilter: FaceFilter;
  onShowAll: () => void;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      title={
        faceFilter === "all"
          ? "No faces to show"
          : `No ${filterWord(faceFilter)} faces`
      }
      body={
        `This person holds no face under Show → ${filterLabel(faceFilter)}. ` +
        "Show All brings every face back."
      }
      cancelLabel="Close"
      confirmLabel="Show All"
      modeless
      onConfirm={onShowAll}
      onCancel={onClose}
    />
  );
}
