interface Props {
  count: number;
  onAssign: () => void;
  onAccept: () => void;
  onReject: () => void;
  onClear: () => void;
}

export default function RuleBar({ count, onAssign, onAccept, onReject, onClear }: Props) {
  if (count === 0) {
    return (
      <footer className="rulebar">
        <span className="dim">
          select faces (per card, or a whole group via its header checkbox), then act
        </span>
      </footer>
    );
  }
  return (
    <footer className="rulebar active">
      <b>{count}</b>
      <span>selected</span>
      <button
        title={`Assign a name and group to the ${count} selected face(s)`}
        onClick={onAssign}
      >
        Assign name…
      </button>
      <button
        className="ok"
        title={`Accept the ${count} selected face(s) — accepted is the default status`}
        onClick={onAccept}
      >
        Accept
      </button>
      <button
        className="bad"
        title={`Reject the ${count} selected face(s) — hidden unless 'show rejected' is on`}
        onClick={onReject}
      >
        Reject
      </button>
      <button className="secondary" title="Clear the selection" onClick={onClear}>
        clear
      </button>
    </footer>
  );
}
