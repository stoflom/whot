import { useEffect } from "react";
import Dialog from "./Dialog";

// Generic confirmation dialog (#35): used for destructive actions such as
// removing persons. // #326: renders through the shared Dialog wrapper
// (role/aria-modal/aria-label + focus management; the #138 keyboard
// registration rides the wrapper).

interface Props {
  title: string;
  body: string;
  confirmLabel: string;
  /** #101/Q4 — the non-default button's label (default "cancel") */
  cancelLabel?: string;
  /** #176/§4.41: a single-button informational dialog (Esc/backdrop
      still dismiss through onCancel) */
  onlyConfirm?: boolean;
  /** #176/§4.41: the dialog floats — clicks pass through the backdrop
      to the UI it points at (the dialog box itself stays interactive) */
  modeless?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ title, body, confirmLabel, cancelLabel, onlyConfirm, modeless, danger, onConfirm, onCancel }: Props) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);
  return (
    <Dialog label={title} className={modeless ? "modeless" : undefined} modeless={modeless} onBackdrop={onCancel}>
      <div className="dialog">
        <h3>{title}</h3>
        <p className="dim">{body}</p>
        <div className="dialog-actions">
          {!onlyConfirm && (
            <button className="secondary" onClick={onCancel}>{cancelLabel ?? "cancel"}</button>
          )}
          <button className={danger ? "bad" : "ok"} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
