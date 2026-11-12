// The #123 context-change guard dialog (gui-design §4.44 round 2
// stage 4, #295) — the copy + button contract as a dedicated
// component. The open/close decision and the accept/discard actions
// stay in App (the commit engine reads them); this is the mount-gated
// surface only. Copy is product language (rule 43).
import ConfirmDialog from "./ConfirmDialog";
import { stageSummarySet, type Stage } from "../stage";

export default function ContextConfirmDialog({
  pending,
  onAccept,
  onDiscard,
}: {
  pending: Stage[];
  onAccept: () => void;
  onDiscard: () => void;
}) {
  return (
    <ConfirmDialog
      title="Unapplied changes"
      body={
        // #123: the context switch drops staged edits either way —
        // the body stays reference-free (§4.43)
        `Staged: ${stageSummarySet(pending)} — accept writes it to the ` +
        "database, discard drops it; the context switches either way"
      }
      confirmLabel="accept"
      cancelLabel="discard"
      onCancel={onDiscard}
      onConfirm={onAccept}
    />
  );
}
