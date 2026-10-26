import { useEffect, useState } from "react";
import PathTypeahead, { type SuggestOption } from "./PathTypeahead";
import { useOwnsKeyboard } from "../overlays";

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
  /** #97: suggestions over the existing group paths */
  options: SuggestOption[];
}

export default function GroupDialog({
  title,
  body,
  defaultPath,
  submitLabel,
  onSubmit,
  onCancel,
  options,
}: Props) {
  useOwnsKeyboard(); // #138
  const [path, setPath] = useState(defaultPath);
  useEffect(() => setPath(defaultPath), [defaultPath]);
  // #67/#92: group paths are structural — the default selects them whole.
  // #164 retired #92's append mode: no menu pre-fills a '|'-terminated
  // path anymore (the root/branch Add group… producer is gone), so every
  // open is wholesale-replacement.
  const submit = () => onSubmit(path);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog">
        <h3>{title}</h3>
        <p className="dim">{body}</p>
        {/* #131 (§4.33): action row above the typeahead — its suggestions
            open downward and would obscure a bottom row */}
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            cancel
          </button>
          <button onClick={submit}>{submitLabel}</button>
        </div>
        <label>
          Group
          <PathTypeahead
            autoFocus
            className="input-group"
            value={path}
            onChange={setPath}
            options={options}
            title="Group path — '|' separated, e.g. family|lombards (empty = ungrouped)"
            placeholder="e.g. family|lombards (empty = ungrouped)"
            onSubmit={submit}
            onEscape={onCancel}
          />
        </label>
      </div>
    </div>
  );
}
