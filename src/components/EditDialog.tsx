import { useEffect, useMemo, useRef, useState } from "react";
import type { Person } from "../api";
import NameTypeahead from "./NameTypeahead";
import PathTypeahead from "./PathTypeahead";
import SuggestInput from "./SuggestInput";
import GroupListEditor from "./GroupListEditor";
import { applyGroupOps, type GroupOp } from "../groupList";
import { descApplyPick, descCurrentToken } from "../descTags";
import type { SuggestOption } from "./SuggestInput";
import { useOwnsKeyboard } from "../overlays";
import type { Prefill, StageScope } from "../stage";

// #101 (§4.24) — THE edit dialog: the four value fields (name, group,
// description, note #307) with type-ahead on the first three, plus the
// Card | Group | Selection scope selector. #123: Apply extends the
// pending set (screen only), Accept commits the whole set (Enter =
// Accept, Esc = Cancel — discard). #124: Reject decides the scope
// immediately (a verdict, not a field edit). #307 (v19.0): the buttons
// are blur-proof — clicking Apply/Accept acts as if Enter had been
// pressed in the focused field first (preventDefault keeps the focus,
// and the commit reads each field's LIVE DOM value as the last word, so
// an engine-lost input event can never drop typed text). Cards and
// headers never host inputs — they show labels and this button.

export interface EditResult {
  kind: "apply" | "accept";
  scope: StageScope;
  values: { name: string; group: string; desc: string; note: string };
  touched: { name: boolean; group: boolean; desc: boolean; note: boolean };
  /** #181 (§4.38): the group-LIST edits — staged locally, committed by
      Accept (the name first, then the memberships on the surviving
      person); Apply leaves them local */
  groupOps: GroupOp[];
}

interface Props {
  /** scope preselected per invocation site (§4.24): card → Selection
      when inside a multi-face selection, else Card (#230); header →
      Group; bottom bar → Selection */
  defaultScope: StageScope;
  /** live face counts of each scope (0 = the choice is disabled) */
  counts: { card: number; group: number; selection: number };
  /** #124: is the scope fully rejected? the Reject button is then
      disabled — an assignment is the only way back (#165, §4.35) */
  rejected: Record<StageScope, boolean>;
  prefills: Record<StageScope, Prefill>;
  persons: Person[];
  pathOptions: SuggestOption[];
  /** #262 (§4.21): the existing description tags — type-ahead options
      for the Description field (most-used first, count as hint) */
  descOptions: SuggestOption[];
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
  descOptions,
  onDone,
  onReject,
  onCancel,
}: Props) {
  // header-open has no card scope (count 0) — never open on an empty scope
  useOwnsKeyboard(); // #138
  // #248: the topmost overlay owns Esc — the field-level onEscape covers
  // only the typeaheads/desc input, so Esc must work from the dialog
  // body too (ConfirmDialog/FaceMergeDialog idiom)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);
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
  const [note, setNote] = useState(base.note ?? "");
  const [touched, setTouched] = useState({ name: false, group: false, desc: false, note: false });
  // #181 (§4.38): the staged membership edits of the group LIST — shown
  // while the Name field holds a KNOWN person's name (the same list the
  // details pane shows, §4.38); a new/empty name keeps the single field
  const [groupOps, setGroupOps] = useState<GroupOp[]>([]);
  const knownName = name.trim();
  // #228 (F-L5): the known-person lookup is indexed once per persons
  // change — the old linear `find` with a `.trim()` per person ran per
  // keystroke
  const byTrimmedName = useMemo(
    () => new Map(persons.map((p) => [p.name.trim(), p])),
    [persons]
  );
  const known = knownName ? byTrimmedName.get(knownName) ?? null : null;

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
    if (!t.note) setNote(b.note ?? "");
    // #181: the list staging is per name — it survives only while the
    // name field (its owner) survives the re-base
    if (!t.name) setGroupOps([]);
  }, [scope, prefills]);

  const ph = (f: "name" | "group" | "desc" | "note") =>
    (base.mixed ?? []).includes(f) ? MIXED_HINT : undefined;

  // #307 (v19.0): the LIVE DOM elements behind the fields — the commit
  // reads them as the last word. A DOM value diverging from the dialog
  // state means an input event was lost at the engine level: the DOM
  // value wins and the field counts as touched.
  const nameRef = useRef<HTMLInputElement | null>(null);
  const groupRef = useRef<HTMLInputElement | null>(null);
  const descRef = useRef<HTMLInputElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  // #181 (§4.38): the group list's pending drafts (add row, inline
  // re-home) — Accept acts as Enter in the focused field first, so a
  // typed-but-unstaged entry must stage before the commit (v19.0:
  // the blur-proof buttons never blur it)
  const groupFlush = useRef<(() => GroupOp[]) | null>(null);

  const done = (kind: EditResult["kind"]) => {
    const live = (
      el: HTMLInputElement | HTMLTextAreaElement | null,
      v: string,
    ): { value: string; touched: boolean } => {
      if (el == null || el.value === v) return { value: v, touched: false };
      return { value: el.value, touched: true };
    };
    const n = live(nameRef.current, name);
    const g = live(groupRef.current, group);
    const d = live(descRef.current, desc);
    const nt = live(noteRef.current, note);
    // the group list's pending drafts stage NOW (a no-op when none are
    // pending) — the flushed set is what Accept commits
    const flushed = groupFlush.current?.() ?? groupOps;
    onDone({
      kind,
      scope,
      values: { name: n.value, group: g.value, desc: d.value, note: nt.value },
      touched: {
        name: touched.name || n.touched,
        group: touched.group || g.touched,
        desc: touched.desc || d.touched,
        note: touched.note || nt.touched,
      },
      groupOps: flushed,
    });
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
          {/* #165/§4.35 + §4.2, #266 wording: rejected faces come back
              only via an assignment; Reject moves the scope onto a
              rejected cluster person — the titles stay reference-free
              (§4.43). #307: the action buttons are blur-proof — mousedown
              never takes the focus from a field (the DetailPane "Update
              person" idiom), so a click acts as if Enter was pressed
              first and typed text can never be lost to the click */}
          <button
            className="warn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onReject(scope)}
            disabled={rejected[scope]}
            title={
              rejected[scope]
                ? "already rejected — an assignment is the way back"
                : "reject the scope now (moves the faces onto a rejected cluster person)"
            }
          >
            Reject
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => done("apply")}
          >
            Apply
          </button>
          <button
            className="ok"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => done("accept")}
          >
            Accept
          </button>
        </div>
        {/* #101/§4.24: which faces the action covers — the tooltip
            stays reference-free (§4.43) */}
        <div className="scope-seg" title="Which faces the action covers — the selection unless you choose otherwise">
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
            inputRef={(el) => (nameRef.current = el)}
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
          // the shared rows (✕ removal, inline re-home, add), staged
          // locally here; Accept commits them after the name lands
          <div className="ed-groups-field">
            <span>Groups ({applyGroupOps(known.groups, groupOps).length})</span>
            <GroupListEditor
              groups={known.groups}
              ops={groupOps}
              onOps={setGroupOps}
              options={pathOptions}
              className="ed-groups"
              flushRef={groupFlush}
            />
          </div>
        ) : (
          <label>
            Person group
            <PathTypeahead
              value={group}
              inputRef={(el) => (groupRef.current = el)}
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
          Face description
          {/* #262/#270 (§4.21): type-ahead over the existing description
              tags — free text stays free text, suggestions only assist.
              Matching runs over the CURRENT token (after the last `|`),
              so compounds build incrementally (beard|s → side →
              beard|side); a pick replaces only that token, so the
              `|` add-mode prefix survives (|b → |beard). */}
          <SuggestInput
            className="input-desc"
            value={desc}
            inputRef={(el) => (descRef.current = el)}
            placeholder={ph("desc") ?? "e.g. beard|glasses"}
            title="Face description — free text; empty clears it. Start with | to ADD tags to the current ones (e.g. |beard → beard|glasses), no duplicates"
            options={descOptions}
            select="none"
            queryFor={descCurrentToken}
            onChange={(v) => {
              setDesc(v);
              setTouched((t) => ({ ...t, desc: true }));
            }}
            // the pick is a discrete event after the re-render, so the
            // closure's desc IS the pre-pick value (the functional form
            // would see onChange's already-updated state and lose the
            // typed prefix); descApplyPick swaps only the current token
            onPick={(o) => setDesc(descApplyPick(desc, o.value))}
            onSubmit={() => done("accept")}
            onEscape={onCancel}
          />
        </label>
        <label>
          Note
          {/* #307 (v19.0): the person note — the pane's free text (§4.37),
              plain multiline input (Enter inserts a newline there; Esc
              still cancels via the dialog-level listener; the buttons
              commit). A leading `|` is the concat-add (the remainder is
              appended to EACH person's existing note — with several
              persons in scope each keeps its own note); plain text
              replaces; touched + empty clears. */}
          <textarea
            className="input-note"
            rows={2}
            value={note}
            placeholder={ph("note") ?? "person note — free text (start with | to append)"}
            title="Person note — free text, stored on the person (the details pane shows it). Start with | to APPEND to the current notes — with several persons in scope each keeps its own note; empty clears"
            ref={noteRef}
            onChange={(e) => {
              setNote(e.target.value);
              setTouched((t) => ({ ...t, note: true }));
            }}
            onKeyDown={(e) => {
              // #68: typing must not fire the app's global shortcuts;
              // Esc keeps its dialog meaning (cancel), Enter stays a
              // newline (multiline — the buttons commit)
              e.stopPropagation();
              if (e.key === "Escape") onCancel();
            }}
          />
        </label>
      </div>
    </div>
  );
}
