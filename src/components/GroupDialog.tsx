import { useEffect, useRef, useState } from "react";
import { groupInputMode, selectAll } from "../autoText";

// §4.16 (#50) — edit a group path: rename/move a branch or move persons
// into a group. The path is `|`-separated; empty means Ungrouped (the
// backend normalises and rejects a literal 'Ungrouped' segment).

interface Props {
  title: string;
  body: string;
  defaultPath: string;
  submitLabel: string;
  onSubmit: (path: string) => void;
  onCancel: () => void;
}

export default function GroupDialog({
  title,
  body,
  defaultPath,
  submitLabel,
  onSubmit,
  onCancel,
}: Props) {
  const [path, setPath] = useState(defaultPath);
  useEffect(() => setPath(defaultPath), [defaultPath]);
  // #92 — a '|'-terminated prefill (root/branch right-click → Add group…)
  // is an append target: keep `parent|`, caret after the pipe, no
  // select-all — the wholesale-replacement rule (#67) stays for every
  // other (structural, whole-path) prefill. Mode derives from the
  // prefill itself, so the dialog cannot open in the wrong one.
  const append = groupInputMode(defaultPath) === "append";
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!append) return;
    const el = inputRef.current;
    if (!el) return;
    // autoFocus fires first; put the caret after the pipe once settled
    const raf = requestAnimationFrame(() => {
      if (document.activeElement === el)
        el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(raf);
  }, [append, defaultPath]);
  const submit = () => onSubmit(path);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog">
        <h3>{title}</h3>
        <p className="dim">{body}</p>
        <label>
          Group
          <input
            ref={inputRef}
            autoFocus
            className="input-group"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            title={
              append
                ? "Pre-filled '<path>|' — type the new segment after the pipe (#92)"
                : "Group path — '|' separated, e.g. family|lombards (empty = ungrouped)"
            }
            placeholder="e.g. family|lombards (empty = ungrouped)"
            onFocus={append ? undefined : selectAll}
            onClick={append ? undefined : selectAll}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") submit();
              if (e.key === "Escape") onCancel();
            }}
          />
        </label>
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            cancel
          </button>
          <button onClick={submit}>{submitLabel}</button>
        </div>
      </div>
    </div>
  );
}
