import { useEffect, useState } from "react";
import type { Person } from "../api";
import NameTypeahead from "./NameTypeahead";
import { useOwnsKeyboard } from "../overlays";

// Shared merge confirmation (#88, gui-design §4.28). All three entry
// points feed it — context menu, drag-and-drop (target pre-filled) and
// the Merge Similar Persons review dialog. Merging is destructive (no
// undo), so a confirmation that spells out exactly what happens is
// mandatory, DnD included.

const UNKNOWN_RE = /^unknown/i;

interface Props {
  /** persons being merged away (may include the target itself) */
  sources: Person[];
  /** pre-filled target — the DnD drop person; user may still change it */
  defaultTarget?: Person | null;
  /** all persons — typeahead suggestions (UnknownN excluded here) */
  persons: Person[];
  onConfirm: (target: Person) => void;
  onCancel: () => void;
}

export default function MergeIntoDialog({ sources, defaultTarget, persons, onConfirm, onCancel }: Props) {
  useOwnsKeyboard(); // #138
  const candidates = persons.filter((p) => !UNKNOWN_RE.test(p.name));
  const [name, setName] = useState(defaultTarget?.name ?? "");
  useEffect(() => {
    if (defaultTarget) setName(defaultTarget.name);
  }, [defaultTarget]);

  // exact spelling first, then case-insensitive (#87 v4.0 convention) —
  // the confirmed target must be an EXISTING person: merging into a new
  // name is a rename, which "Rename selection to…" does instead
  // Esc cancels — the topmost dialog owns Esc (stacked review dialog
  // hands its Esc to us via the escActive prop)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);

  const trimmed = name.trim();
  const target =
    candidates.find((p) => p.name === trimmed) ??
    candidates.find((p) => p.name.toLowerCase() === trimmed.toLowerCase()) ??
    null;

  const moving = target ? sources.filter((p) => p.id !== target.id) : sources;
  const faceCount = moving.reduce((a, p) => a + p.counts.total, 0);
  const faceless = moving.filter((p) => p.counts.total === 0).length;
  const canMerge = target != null && moving.length > 0 && faceCount > 0;

  const confirm = () => {
    if (canMerge && target) onConfirm(target);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog">
        <h3>{moving.length > 1 ? `Merge ${moving.length} persons` : "Merge person"}</h3>
        <p className="dim">
          <b>{faceCount}</b> face(s) across <b>{moving.length}</b> person(s) move to{" "}
          <b>{target ? target.name : "…"}</b> and become <b>confirmed</b> — rejected faces keep
          their status. Source persons are emptied and deleted once their last face moves;
          {faceless > 0 && ` ${faceless} faceless source(s) are left as-is;`}
          <br />
          No undo — faces themselves are never deleted (§4.13).
        </p>
        {/* #196 (§4.28): the chips are selectable — clicking one
            prefills the target input (the same name resolution as the
            typeahead); the resolved target's chip is selected and
            leaves the moving set */}
        <div className="merge-chips">
          {sources.map((p) => (
            <button
              type="button"
              className={`ev-chip${p.id === target?.id ? " merge-chip-picked" : ""}`}
              key={p.id}
              title={`${p.groups.join(", ") || "(no group)"} — ${p.counts.total} face(s)`}
              onClick={() => setName(p.name)}
            >
              {p.name} · {p.counts.total}f
            </button>
          ))}
        </div>
        <label>
          Merge into
          <NameTypeahead
            autoFocus
            value={name}
            onChange={setName}
            persons={candidates}
            title="Target — must be an existing person; UnknownN clusters cannot receive merges"
            onPick={(p) => setName(p.name)}
            onSubmit={confirm}
          />
        </label>
        {!target && trimmed !== "" && (
          <p className="dim" style={{ color: "var(--bad)" }}>
            no existing person named “{trimmed}” — use “Rename selection to…” to rename instead
          </p>
        )}
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            cancel
          </button>
          <button className="bad" disabled={!canMerge} onClick={confirm} title={canMerge ? "merge (no undo)" : "pick a target with faces to move"}>
            merge
          </button>
        </div>
      </div>
    </div>
  );
}
