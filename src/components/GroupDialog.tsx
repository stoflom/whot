import { useEffect, useState } from "react";
import { groupInputMode } from "../autoText";
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
  // #92/#97 — a '|'-terminated prefill (root/branch right-click → Add
  // group…) is an append target: keep `parent|`, caret after the pipe,
  // no select-all; every other prefill keeps the wholesale replacement
  // (#67). The mode derives from the prefill itself (groupInputMode).
  const append = groupInputMode(defaultPath) === "append";
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
            select={append ? "none" : "all"}
            caretEnd={append}
            title={
              append
                ? "Pre-filled '<path>|' — type the new segment after the pipe (#92)"
                : "Group path — '|' separated, e.g. family|lombards (empty = ungrouped)"
            }
            placeholder="e.g. family|lombards (empty = ungrouped)"
            onSubmit={submit}
            onEscape={onCancel}
          />
        </label>
      </div>
    </div>
  );
}
