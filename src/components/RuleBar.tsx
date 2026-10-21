// #101 (§4.30): the bar's actions ALWAYS act on the selection and never
// confirm (Q2/Q9) — the Edit dialog's scope selector is the only
// object-vs-selection disambiguation. Selection actions grey out at
// N = 0; Undo greys out without a live stage.

interface Props {
  count: number;
  /** a staged (Apply) preview is live — Undo becomes available */
  stageLive: boolean;
  /** with a live stage: re-scope it to the selection; else open the dialog */
  onApply: () => void;
  /** commit the stage (if any) and accept the selection */
  onAccept: () => void;
  /** drop the staged preview (Esc does the same, F1) */
  onUndo: () => void;
  /** open the Edit dialog scoped to the selection */
  onAssign: () => void;
  onReject: () => void;
  onClear: () => void;
}

export default function RuleBar({
  count,
  stageLive,
  onApply,
  onAccept,
  onUndo,
  onAssign,
  onReject,
  onClear,
}: Props) {
  const none = count === 0;
  return (
    <footer className={none && !stageLive ? "rulebar" : "rulebar active"}>
      {none && !stageLive ? (
        <span className="dim">
          select faces (per card, or a whole group via its header checkbox), then act
        </span>
      ) : (
        <>
          <b>{count}</b>
          <span>selected</span>
        </>
      )}
      <button
        disabled={none && !stageLive}
        onClick={onApply}
        title={
          stageLive
            ? "Re-scope the staged preview to the whole selection (#101, §4.24)"
            : "Edit name/group/description — dialog, scope Selection; Apply stages a preview (#101, §4.24)"
        }
      >
        Apply
      </button>
      <button
        className="ok"
        disabled={none && !stageLive}
        onClick={onAccept}
        title={
          stageLive
            ? "Commit the staged preview and accept — advances in Review (#101, §4.30)"
            : `Accept the ${count} selected face(s) — advances in Review (shortcut: A) (#101, §4.30)`
        }
      >
        Accept
      </button>
      <button
        disabled={!stageLive}
        onClick={onUndo}
        title="Undo the staged preview — nothing was written yet; Esc does the same (#101, F1)"
      >
        Undo
      </button>
      <button
        disabled={none}
        onClick={onAssign}
        title="Assign a person — the Edit dialog, scope Selection (#101, §4.24)"
      >
        Assign name…
      </button>
      <button
        className="bad"
        disabled={none}
        onClick={onReject}
        title={`Reject the ${count} selected face(s) — hidden unless the filter shows them (shortcut: R)`}
      >
        Reject
      </button>
      <button className="secondary" disabled={none} onClick={onClear} title="Clear the selection">
        clear
      </button>
    </footer>
  );
}
