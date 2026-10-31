import { useEffect, useRef, useState } from "react";
import type { Person } from "../api";
import NameTypeahead from "./NameTypeahead";
import PathTypeahead from "./PathTypeahead";
import GroupListEditor from "./GroupListEditor";
import { applyGroupOps, type GroupOp } from "../groupList";
import type { SuggestOption } from "./SuggestInput";
import { useOwnsKeyboard } from "../overlays";
import type { Prefill, StageScope } from "../stage";

// #101 (§4.24) — THE edit dialog: the three value fields (name, group,
// description) with type-ahead, plus the Card | Group | Selection scope
// selector. #123: Apply extends the pending set (screen only), Accept
// commits the whole set (Enter = Accept, Esc = Cancel — discard). #124:
// Reject decides the scope immediately (a verdict, not a field edit).
// Cards and headers never host inputs — they show labels and this button.

export interface EditResult {
  kind: "apply" | "accept";
  scope: StageScope;
  values: { name: string; group: string; desc: string };
  touched: { name: boolean; group: boolean; desc: boolean };
  /** #181 (§4.38): the group-LIST edits — staged locally, committed by
      Accept (the name first, then the memberships on the surviving
      person); Apply leaves them local */
  groupOps: GroupOp[];
}

interface Props {
  /** scope preselected per invocation site (§4.24): card → Card,
      header → Group, bottom bar → Selection */
  defaultScope: StageScope;
  /** live face counts of each scope (0 = the choice is disabled) */
  counts: { card: number; group: number; selection: number };
  /** #124: is the scope fully rejected? the Reject button is then
      disabled — an assignment is the only way back (#165, §4.35) */
  rejected: Record<StageScope, boolean>;
  prefills: Record<StageScope, Prefill>;
  persons: Person[];
  pathOptions: SuggestOption[];
  onDone: (r: EditResult) => void;
  /** #124: commit the verdict on the scope now */
  onReject: (scope: StageScope) => void;
  onCancel: () => void;
}

const SCOPES: { id: StageScope; label: string }[] = [
  { id: "card", label: "Card" },
  { id: "group", label: "Group" },
  { id: "selection", label: "Selection" },
];

// #199 (§4.24): mixed-scope placeholder — placeholder only, the value
// stays '' (a literal `various` value would be staged and committed)
const MIXED_HINT = "various — type to set all";

export default function EditDialog({
  defaultScope,
  counts,
  rejected,
  prefills,
  persons,
  pathOptions,
  onDone,
  onReject,
  onCancel,
}: Props) {
  // header-open has no card scope (count 0) — never open on an empty scope
  useOwnsKeyboard(); // #138
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
  // #181 (§4.38): the staged membership edits of the group LIST — shown
  // while the Name field holds a KNOWN person's name (the same list the
  // details pane shows, §4.38); a new/empty name keeps the single field
  const [groupOps, setGroupOps] = useState<GroupOp[]>([]);
  const knownName = name.trim();
  const known = knownName ? persons.find((p) => p.name.trim() === knownName) ?? null : null;

  // #197 (§4.24): a scope switch (or a snapshot refresh re-basing the
  // prefills) keeps every field the user already TOUCHED in this dialog
  // session — only untouched fields re-base on the new scope's prefill.
  // The latest touched flags live in a ref: they must not be a dep
  // (a touch would re-fire the re-base) but the effect needs them fresh.
  const touchedRef = useRef(touched);
  useEffect(() => {
    touchedRef.current = touched;
  }, [touched]);
  useEffect(() => {
    const b = prefills[scope] ?? {};
    const t = touchedRef.current;
    if (!t.name) setName(b.name ?? "");
    if (!t.group) setGroup(b.group ?? "");
    if (!t.desc) setDesc(b.desc ?? "");
    // #181: the list staging is per name — it survives only while the
    // name field (its owner) survives the re-base
    if (!t.name) setGroupOps([]);
  }, [scope, prefills]);

  const ph = (f: "name" | "group" | "desc") =>
    (base.mixed ?? []).includes(f) ? MIXED_HINT : undefined;

  const done = (kind: EditResult["kind"]) =>
    onDone({ kind, scope, values: { name, group, desc }, touched, groupOps });

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
          applies to {counts[scope]} face(s) — <b>Apply</b> stages it (preview,
          nothing is written yet), <b>Accept</b> writes the whole pending set
          (and advances in Review), <b>Reject</b> decides the scope now
        </p>
        {/* #131 (§4.33): the action row sits ABOVE the fields — the
            typeahead suggestions open downward and would obscure a bottom
            row while they are showing */}
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            cancel
          </button>
          <button
            className="warn"
            onClick={() => onReject(scope)}
            disabled={rejected[scope]}
            title={
              rejected[scope]
                ? "already rejected — an assignment is the way back (#165, §4.35)"
                : "reject the scope now (moves the faces onto the Rejected system person, §4.2)"
            }
          >
            Reject
          </button>
          <button onClick={() => done("apply")}>Apply</button>
          <button className="ok" onClick={() => done("accept")}>
            Accept
          </button>
        </div>
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
        {known ? (
          // #181 (§4.38): a KNOWN name fronts that person's group LIST —
          // the shared rows (× removal, inline re-home, add), staged
          // locally here; Accept commits them after the name lands
          <div className="ed-groups-field">
            <span>Groups ({applyGroupOps(known.groups, groupOps).length})</span>
            <GroupListEditor
              groups={known.groups}
              ops={groupOps}
              onOps={setGroupOps}
              options={pathOptions}
              className="ed-groups"
            />
          </div>
        ) : (
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
        )}
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
      </div>
    </div>
  );
}
