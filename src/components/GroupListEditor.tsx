import { useEffect, useRef, useState } from "react";
import PathTypeahead from "./PathTypeahead";
import type { SuggestOption } from "./PathTypeahead";
import {
  applyGroupOps,
  stageAdd,
  stageRemove,
  stageRehome,
  type GroupOp,
} from "../groupList";

// #181 (§4.38/#4.24) — the group-LIST editor, SHARED by the person
// details pane (#172) and the Edit dialog (#181): every REAL
// membership is a row — the status seat is never rendered (§4.35/#233
// display rule: a seated person's list is empty, and the staged
// preview drops the seat when a real group is added), ✕ stages a
// removal, an inline row edit re-homes that one membership (§4.16) and
// the add row stages a new one. Purely CONTROLLED — the parent owns the
// staged ops and the commit (Update person in the pane, Accept in the
// dialog); this component owns only the add-input and inline-edit
// drafts (both local, both wiped by a remount on re-anchor/dialog
// open).

interface Props {
  /** the committed memberships (may include the status seat — it is
      never rendered, §4.35/#233) */
  groups: string[];
  /** the staged ops (pane/dialog-local) */
  ops: GroupOp[];
  onOps: (ops: GroupOp[]) => void;
  /** the #97 path suggestions */
  options: SuggestOption[];
  /** the rows wrapper class — .dp-groups in the pane, .ed-groups in
      the dialog (the row classes themselves are shared) */
  className: string;
  /** Enter in the add row commits the staged set (the pane, §4.38);
      the dialog commits only via Accept, so it omits this */
  onAddCommit?: (next: GroupOp[]) => void;
  /** #307 (v19.0): the parent's commit button is blur-proof (mousedown
      preventDefault — the §4.38 "Update person"/dialog-Accept idiom),
      so a pending add-row or inline-re-home draft never sees a blur.
      The parent invokes flush() right before committing: it stages the
      pending drafts (each field's LIVE DOM value is the last word — an
      engine-lost input event must not drop the typed path, the same
      rule the four value fields follow) and returns the ops to commit
      (unchanged ops when nothing is pending). */
  flushRef?: { current: (() => GroupOp[]) | null };
}

export default function GroupListEditor({
  groups,
  ops,
  onOps,
  options,
  className,
  onAddCommit,
  flushRef,
}: Props) {
  const [addPath, setAddPath] = useState("");
  const [editing, setEditing] = useState<{ path: string; value: string } | null>(null);
  // #307 (v19.0): the live DOM elements behind the drafts — the parent's
  // commit reads them as the last word (an engine-lost input event must
  // not drop the typed path)
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  // the staged result — the REAL memberships with the ops applied (the
  // status seat is filtered out, §4.35/#233)
  const display = applyGroupOps(groups, ops);
  const stageAddPath = (commitAfter: boolean) => {
    const next = stageAdd(ops, display, addPath);
    if (!next) return; // reserved/empty/duplicate: informed no-op
    onOps(next);
    setAddPath("");
    // Enter stages the typed path AND commits the whole staged set
    // (§4.38) — against the ops INCLUDING it; the button only stages
    if (commitAfter) onAddCommit?.(next);
  };
  const commitEdit = () => {
    if (!editing) return;
    const next = stageRehome(ops, display, editing.path, editing.value);
    if (next) onOps(next);
    setEditing(null);
  };
  // the flush the blur-proof parents invoke before committing —
  // re-registered after every render so the closure never goes stale
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = (): GroupOp[] => {
      let out = ops;
      if (editing) {
        // the inline re-home draft: the live DOM value is the last word
        const v = editInputRef.current?.value ?? editing.value;
        const next = stageRehome(out, display, editing.path, v);
        if (next) out = next;
        setEditing(null);
      }
      const live = addInputRef.current;
      const path = live && live.value !== addPath ? live.value : addPath;
      if (path.trim()) {
        const next = stageAdd(out, applyGroupOps(groups, out), path);
        if (next) {
          out = next;
          setAddPath(""); // cleared only when it actually staged
        }
      }
      if (out !== ops) onOps(out);
      return out;
    };
  });
  return (
    <>
      <ul className={className}>
        {display.length === 0 ? (
          // #233 (§4.35/#233): the person holds no real membership
          // (their status seat is never a row) — the dimmed hint keeps
          // the list's slot, like the pane's other empty states
          <li className="dp-group-empty">no groups yet — add one below</li>
        ) : (
          display.map((g) => {
            const staged = ops.some((o) => o.to === g);
            // §4.16 (inline re-home) + §4.38 (staged add): the row/add
            // titles stay reference-free (§4.43)
            return (
              <li key={g} className={`dp-group-row${staged ? " staged" : ""}`}>
                {editing?.path === g ? (
                  <PathTypeahead
                    className="input-group dp-group-edit"
                    value={editing.value}
                    inputRef={(el) => (editInputRef.current = el)}
                    onChange={(v) => setEditing({ path: g, value: v })}
                    options={options}
                    autoFocus
                    onSubmit={commitEdit}
                    onEscape={() => setEditing(null)}
                    onLeave={commitEdit}
                    title="Re-home this membership (Enter commits, Esc cancels)"
                  />
                ) : (
                  <button
                    type="button"
                    className="dp-group-path"
                    title="click to edit — re-homes just this membership"
                    onClick={() => setEditing({ path: g, value: g })}
                  >
                    {g}
                  </button>
                )}
                <button
                  type="button"
                  className="dp-group-x"
                  title="remove this membership (staged — commit with Update person)"
                  onClick={() => {
                    const next = stageRemove(ops, display, g);
                    if (next) onOps(next);
                  }}
                >
                  ✕
                </button>
              </li>
            );
          })
        )}
      </ul>
      <div className="dp-add-group">
        <PathTypeahead
          className="input-group"
          value={addPath}
          inputRef={(el) => (addInputRef.current = el)}
          onChange={setAddPath}
          options={options}
          placeholder="e.g. family|smiths"
          title="Add a group membership — staged, Enter commits the staged set"
          onSubmit={() => stageAddPath(true)}
        />
        <button
          type="button"
          className="dp-add-btn"
          disabled={!addPath.trim()}
          title="stage this membership — commit with Enter or the parent's commit"
          onClick={() => stageAddPath(false)}
        >
          Add group
        </button>
      </div>
    </>
  );
}
