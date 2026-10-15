import { useEffect } from "react";

// Generic confirmation dialog (#35): used for destructive actions such as
// removing persons.

interface Props {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ title, body, confirmLabel, danger, onConfirm, onCancel }: Props) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog">
        <h3>{title}</h3>
        <p className="dim">{body}</p>
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>cancel</button>
          <button className={danger ? "bad" : "ok"} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
