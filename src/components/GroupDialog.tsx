import { useEffect, useState } from "react";
import { selectAll } from "../autoText";

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
  const submit = () => onSubmit(path);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog">
        <h3>{title}</h3>
        <p className="dim">{body}</p>
        <label>
          Group
          <input
            autoFocus
            className="input-group"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            title="Group path — '|' separated, e.g. family|lombards (empty = ungrouped)"
            placeholder="e.g. family|lombards (empty = ungrouped)"
            onFocus={selectAll}
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
