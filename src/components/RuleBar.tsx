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
      <button onClick={onAssign}>Assign name…</button>
      <button className="ok" onClick={onAccept}>Accept</button>
      <button className="bad" onClick={onReject}>Reject</button>
      <button className="secondary" onClick={onClear}>
        clear
      </button>
    </footer>
  );
}
