import { useEffect, useState } from "react";
import type { Person } from "../api";
import NameTypeahead from "./NameTypeahead";
import PathTypeahead from "./PathTypeahead";
import type { SuggestOption } from "./SuggestInput";
import type { Prefill, StageScope } from "../stage";

// #101 (§4.24) — THE edit dialog: the three value fields (name, group,
// description) with type-ahead, plus the Card | Group | Selection scope
// selector. Apply stages (screen preview), Accept stages + commits
// (Enter = Accept, Esc = Cancel). Cards and headers never host inputs —
// they show labels and this button.

export interface EditResult {
  kind: "apply" | "accept";
  scope: StageScope;
  values: { name: string; group: string; desc: string };
  touched: { name: boolean; group: boolean; desc: boolean };
}

interface Props {
  /** scope preselected per invocation site (§4.24): card → Card,
      header → Group, bottom bar → Selection */
  defaultScope: StageScope;
  /** live face counts of each scope (0 = the choice is disabled) */
  counts: { card: number; group: number; selection: number };
  prefills: Record<StageScope, Prefill>;
  persons: Person[];
  pathOptions: SuggestOption[];
  onDone: (r: EditResult) => void;
  onCancel: () => void;
}

const SCOPES: { id: StageScope; label: string }[] = [
  { id: "card", label: "Card" },
  { id: "group", label: "Group" },
  { id: "selection", label: "Selection" },
];

const MIXED_HINT = "multiple values — type to set all";

export default function EditDialog({
  defaultScope,
  counts,
  prefills,
  persons,
  pathOptions,
  onDone,
  onCancel,
}: Props) {
  // header-open has no card scope (count 0) — never open on an empty scope
  const [scope, setScope] = useState<StageScope>(
    counts[defaultScope] > 0
      ? defaultScope
      : counts.selection > 0
        ? "selection"
        : counts.group > 0
          ? "group"
          : defaultScope
  );
  const base = prefills[scope] ?? {};
  const [name, setName] = useState(base.name ?? "");
  const [group, setGroup] = useState(base.group ?? "");
  const [desc, setDesc] = useState(base.desc ?? "");
  const [touched, setTouched] = useState({ name: false, group: false, desc: false });

  // switching scope re-bases the fields on that scope's values (§4.24)
  useEffect(() => {
    const b = prefills[scope] ?? {};
    setName(b.name ?? "");
    setGroup(b.group ?? "");
    setDesc(b.desc ?? "");
    setTouched({ name: false, group: false, desc: false });
  }, [scope, prefills]);

  const ph = (f: "name" | "group" | "desc") =>
    (base.mixed ?? []).includes(f) ? MIXED_HINT : undefined;

  const done = (kind: EditResult["kind"]) =>
    onDone({ kind, scope, values: { name, group, desc }, touched });

  const enter = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") done("accept");
    if (e.key === "Escape") onCancel();
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog edit-dialog">
        <h3>Edit</h3>
        <p className="dim">
          applies to {counts[scope]} face(s) — <b>Apply</b> previews on the labels,
          <b> Accept</b> writes it (and advances in Review)
        </p>
        <div className="scope-seg" title="Which faces the action covers — the selection unless you choose otherwise (#101, §4.24)">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              className={scope === s.id ? "active" : ""}
              disabled={counts[s.id] === 0 && scope !== s.id}
              onClick={() => setScope(s.id)}
            >
              {s.label} ({counts[s.id]})
            </button>
          ))}
        </div>
        <label>
          Name
          <NameTypeahead
            autoFocus
            value={name}
            onChange={(v) => {
              setName(v);
              setTouched((t) => ({ ...t, name: true }));
            }}
            persons={persons}
            placeholder={ph("name")}
            title="Person name — an existing person is the merge target; empty keeps the current name"
            onPick={() => setTouched((t) => ({ ...t, name: true }))}
            onSubmit={() => done("accept")}
            onEscape={onCancel}
          />
        </label>
        <label>
          Group
          <PathTypeahead
            value={group}
            onChange={(v) => {
              setGroup(v);
              setTouched((t) => ({ ...t, group: true }));
            }}
            options={pathOptions}
            placeholder={ph("group") ?? "ungrouped (empty)"}
            title="Group path — '|' separated; empty files the faces as ungrouped"
            onSubmit={() => done("accept")}
            onEscape={onCancel}
          />
        </label>
        <label>
          Description
          <input
            className="input-desc"
            value={desc}
            placeholder={ph("desc") ?? "e.g. beard|glasses"}
            title="Face description — free text; empty clears it"
            onChange={(e) => {
              setDesc(e.target.value);
              setTouched((t) => ({ ...t, desc: true }));
            }}
            onKeyDown={enter}
          />
        </label>
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            cancel
          </button>
          <button onClick={() => done("apply")}>Apply</button>
          <button className="ok" onClick={() => done("accept")}>
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
