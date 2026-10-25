import { useEffect } from "react";
import type { Person } from "../api";
import type { FaceMergePlan } from "../faceDrop";

// #135 (rule 34) — face-level merge confirmation. A face drag dropped on a
// person row cannot use the §4.28 person-level dialog (that one moves whole
// persons); this one spells the move by owner. Confirmation is mandatory —
// every merge path confirms, DnD included.

interface Props {
  plan: FaceMergePlan;
  /** display names for the plan's bySource person ids */
  sourceNames: Map<number, string>;
  /** the dropped person — fixed; the drop already chose it */
  target: Person;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function FaceMergeDialog({
  plan,
  sourceNames,
  target,
  onConfirm,
  onCancel,
}: Props) {
  // Esc cancels (the dialog is never stacked — the overlay blocks any
  // other interaction while open)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);

  const sources = [...plan.bySource.entries()]
    .map(([pid, ids]) => ({
      name: sourceNames.get(pid) ?? `#${pid}`,
      count: ids.length,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const canMerge = plan.movers.length > 0;

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="dialog">
        <h3>
          Merge {plan.movers.length} face(s) into {target.name}
        </h3>
        <p className="dim">
          <b>{plan.movers.length}</b> face(s) move to <b>{target.name}</b>
          {target.groups[0] ? ` (${target.groups[0]})` : ""} — rejected faces
          keep their status, the rest become confirmed.
          {plan.emptied.length > 0 && (
            <>
              <br />
              Source person(s) with no faces left are deleted:{" "}
              <b>{plan.emptied.join(", ")}</b>.
            </>
          )}
          <br />
          No undo — faces themselves are never deleted (§4.13).
        </p>
        <div className="merge-chips">
          {sources.map((s) => (
            <span
              className="ev-chip"
              key={s.name}
              title={`${s.count} face(s) from ${s.name}`}
            >
              {s.name} · {s.count}f
            </span>
          ))}
          {plan.unowned.length > 0 && (
            <span className="ev-chip" title="unowned faces (removed person, §4.13)">
              unowned · {plan.unowned.length}f
            </span>
          )}
        </div>
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            cancel
          </button>
          <button
            className="bad"
            disabled={!canMerge}
            onClick={onConfirm}
            title="merge (no undo)"
          >
            merge
          </button>
        </div>
      </div>
    </div>
  );
}
