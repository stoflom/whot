import { useEffect, useRef, useState } from "react";
import type { Person, Refcrop, Snapshot } from "../api";
import { useFaceImage } from "../hooks";
import { rotStyle } from "../rotation";
import { applyGroupOps, isSeat, stageAdd, stageRemove, stageRehome, type GroupOp } from "../groupList";
import NameTypeahead from "./NameTypeahead";
import PathTypeahead, { useGroupPathOptions } from "./PathTypeahead";
import type { SuggestOption } from "./SuggestInput";
import { matchesStatusFilter, type FaceFilter } from "../viewFilters";
import { selectAll } from "../autoText";

interface Props {
  person: Person | null;
  refcrops: Refcrop[];
  snapshot: Snapshot | null;
  /** #99: face-status filter in the overview totals (#28 generalised) */
  faceFilter: FaceFilter;
  onName: (id: number, name: string) => void;
  onNote: (id: number, note: string) => void;
  // #145: the avatar opens the primary face's full image in focus mode
  onOpenPrimary: (faceId: number) => void;
  onRemoveRefcrop: (faceId: number) => void;
  /** remove this person (§4.13, #35) */
  onRemovePerson?: (id: number) => void;
  /** #172/#173 (§4.38): the pane's Update person commit — the pending
      name (rename-merge), the pending note, then the staged group ops,
      in that order, against the surviving person; resolves true when
      everything committed (the pane then clears its staging) */
  onUpdate?: (id: number, name: string, note: string, ops: GroupOp[]) => Promise<boolean>;
}

function Editable({
  label,
  value,
  placeholder,
  multiline,
  variant,
  onCommit,
  persons,
  pathOptions,
  title,
  selectAllOnFocus,
  onDraft,
}: {
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  /** #56 (§4.20): input family — 'group' for paths, 'desc' for face
      descriptions; Name/Note keep the default look */
  variant?: "group" | "desc";
  onCommit: (v: string) => void;
  /** #172 (§4.38): live draft mirror for the parent (Update person) */
  onDraft?: (v: string) => void;
  /** #67: existing persons → name suggestions (Name field only) */
  persons?: Person[];
  /** #97: existing group paths → path suggestions (Group field only) */
  pathOptions?: SuggestOption[];
  /** #65/#67: hint shown on hover; select-all-on-focus (group paths) */
  title?: string;
  selectAllOnFocus?: boolean;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v !== value) onCommit(v);
  };
  const cls = variant === "group" ? "input-group" : variant === "desc" ? "input-desc" : undefined;
  return (
    <label className="dp-field">
      <span>{label}</span>
      {multiline ? (
        <textarea rows={2} className={cls} value={v} onChange={(e) => { setV(e.target.value); onDraft?.(e.target.value); }} onBlur={commit} placeholder={placeholder} title={title} />
      ) : persons ? (
        <NameTypeahead value={v} onChange={(nv) => { setV(nv); onDraft?.(nv); }} persons={persons} onSubmit={commit}
          // #97: click-away commits — a typed-but-unsubmitted name used to
          // be discarded silently when focus moved elsewhere
          onLeave={commit} title={title} />
      ) : pathOptions ? (
        <PathTypeahead className={cls} value={v} onChange={setV} options={pathOptions}
          onSubmit={commit} onLeave={commit} placeholder={placeholder} title={title} />
      ) : (
        <input
          className={cls}
          value={v}
          onChange={(e) => { setV(e.target.value); onDraft?.(e.target.value); }}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onFocus={selectAllOnFocus ? selectAll : undefined}
          onClick={selectAllOnFocus ? selectAll : undefined}
          title={title}
          placeholder={placeholder}
        />
      )}
    </label>
  );
}

interface PersonViewProps extends Omit<Props, "person"> {
  person: Person;
}

// one reference group per appearance (person_refcrops.description = §4.6);
// get_refcrops orders by (description, seq), so groups and rows stay sorted
function groupRefcrops(rcs: Refcrop[]): [string, Refcrop[]][] {
  const m = new Map<string, Refcrop[]>();
  for (const rc of rcs) {
    const arr = m.get(rc.description) ?? [];
    arr.push(rc);
    m.set(rc.description, arr);
  }
  return [...m.entries()];
}

function PersonView({ person, refcrops, snapshot, onName, onNote, onOpenPrimary, onRemoveRefcrop, onRemovePerson, onUpdate }: PersonViewProps) {
  const primaryImg = useFaceImage(person.primary_face_id);
  const system = person.name === "Rejected"; // #165/§4.35
  // #172/#173 (§4.38) — pane-local staging for the group list plus the
  // name/note drafts Update person commits; the staging resets whenever
  // the pane RE-ANCHORS (the person changes — tree select, any §4.37
  // path, a rename-merge onto the target) and the drafts resync on a
  // committed rename/note of the same person
  const [ops, setOps] = useState<GroupOp[]>([]);
  const [addPath, setAddPath] = useState("");
  const [editing, setEditing] = useState<{ path: string; value: string } | null>(null);
  const [nameDraft, setNameDraft] = useState(person.name);
  const [noteDraft, setNoteDraft] = useState(person.note ?? "");
  const pidRef = useRef(person.id);
  useEffect(() => {
    if (pidRef.current !== person.id) {
      pidRef.current = person.id;
      setOps([]);
      setAddPath("");
      setEditing(null);
      setNameDraft(person.name);
      setNoteDraft(person.note ?? "");
    }
    // the id guard makes the wider dep list a no-op for same-person
    // name/note changes (the sync effects below own those)
  }, [person.id, person.name, person.note]);
  useEffect(() => setNameDraft(person.name), [person.name]);
  useEffect(() => setNoteDraft(person.note ?? ""), [person.note]);
  // #122: crop rotations are per-face — the primary face and every
  // refcrop spin with their own stored angle
  const rotOf = (faceId: number) =>
    snapshot?.faces.find((f) => f.id === faceId)?.rotation ?? 0;
  const pathOptions = useGroupPathOptions(snapshot?.persons ?? []);   // #97
  // the staged result — the committed memberships with the ops applied
  const display = applyGroupOps(person.groups, ops);
  const commit = (next: GroupOp[]) => {
    // a successful commit clears the staging — the ops must never
    // replay over the already-committed result
    void (onUpdate?.(person.id, nameDraft, noteDraft, next) ?? Promise.resolve(false)).then(
      (ok) => {
        if (ok) {
          setOps([]);
          setAddPath("");
          setEditing(null);
        }
      }
    );
  };
  const stageAddPath = (thenCommit: boolean) => {
    const next = stageAdd(ops, display, addPath);
    if (!next) return; // reserved/empty/duplicate: informed no-op
    setOps(next);
    setAddPath("");
    // Enter stages the typed path AND commits the whole staged set
    // (§4.38) — against the ops INCLUDING it; the button only stages
    if (thenCommit) commit(next);
  };
  const commitEdit = () => {
    if (!editing) return;
    const next = stageRehome(ops, display, editing.path, editing.value);
    if (next) setOps(next);
    setEditing(null);
  };
  return (
    <div className="dp-person" key={person.id}>
      {/* #145: this avatar IS the primary face — clicking it opens the
          face's full image in focus mode (the old handler called
          setPrimary(primary_face_id): a self-no-op). Opening is the
          view-context-change path, honouring the confirm dialog (#123). */}
      <div
        className="dp-avatar"
        title={person.primary_face_id ? "Open the primary face's full image (focus mode)" : undefined}
        onClick={() => person.primary_face_id && onOpenPrimary(person.primary_face_id)}
      >
        {primaryImg ? (
          <img src={primaryImg} alt="" style={rotStyle(rotOf(person.primary_face_id ?? -1))} />
        ) : (
          <span>?</span>
        )}
      </div>
      {system ? (
        <div className="dp-field">
          <span>Name</span>
          <span className="dim">Rejected — the system person (#165), not renameable</span>
        </div>
      ) : (
        <Editable
          label="Name"
          value={person.name}
          persons={snapshot?.persons}
          title="Name — an existing person merges into (Enter commits)"
          onDraft={setNameDraft}
          onCommit={(v) => onName(person.id, v)}
        />
      )}
      {system ? (
        <div className="dp-field">
          <span>Groups</span>
          <span className="dim">Rejected — the system seat (#165), not editable</span>
        </div>
      ) : (
        // #172 (§4.38) — the group LIST replaces the single field: every
        // membership with an × that stages its removal (a status-seat row
        // is dimmed with an inert × — system furniture, §4.35); rows are
        // editable inline (re-home that one membership); Add group stages
        // a new membership; the staged set commits via Enter-in-add or
        // the Update person button (#173) — never per-gesture
        <div className="dp-field">
          <span>Groups ({display.length})</span>
          <ul className="dp-groups">
            {display.map((g) => {
              const seat = isSeat(g);
              const staged = ops.some((o) => o.to === g);
              return (
                <li key={g} className={`dp-group-row${staged ? " staged" : ""}`}>
                  {editing?.path === g ? (
                    <PathTypeahead
                      className="input-group dp-group-edit"
                      value={editing.value}
                      onChange={(v) => setEditing({ path: g, value: v })}
                      options={pathOptions}
                      autoFocus
                      onSubmit={commitEdit}
                      onEscape={() => setEditing(null)}
                      onLeave={commitEdit}
                      title="Re-home this membership (Enter commits, Esc cancels)"
                    />
                  ) : seat ? (
                    <span
                      className="dp-group-path seat"
                      title="status seat (§4.35) — system-written, never removed"
                    >
                      {g}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="dp-group-path"
                      title="click to edit — re-homes just this membership (§4.16)"
                      onClick={() => setEditing({ path: g, value: g })}
                    >
                      {g}
                    </button>
                  )}
                  <button
                    type="button"
                    className="dp-group-x"
                    disabled={seat}
                    title={
                      seat
                        ? "status seat (§4.35) — never removed"
                        : "remove this membership (staged — commit with Update person)"
                    }
                    onClick={() => {
                      const next = stageRemove(ops, display, g);
                      if (next) setOps(next);
                    }}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="dp-add-group">
            <PathTypeahead
              className="input-group"
              value={addPath}
              onChange={setAddPath}
              options={pathOptions}
              placeholder="e.g. family|lombards"
              title="Add a group membership — staged, Enter commits the staged set (§4.38)"
              onSubmit={() => stageAddPath(true)}
            />
            <button
              type="button"
              className="dp-add-btn"
              disabled={!addPath.trim()}
              title="stage this membership — commit with Enter or Update person"
              onClick={() => stageAddPath(false)}
            >
              Add group
            </button>
          </div>
        </div>
      )}
      <Editable
        label="Note"
        value={person.note ?? ""}
        multiline
        title="Note — free text about this person"
        onDraft={setNoteDraft}
        onCommit={(v) => onNote(person.id, v)}
      />
      <div className="dp-counts">
        <span>{person.counts.total} faces</span>
        <span className="c-prov">{person.counts.provisional} new</span>
        <span className="c-conf">{person.counts.confirmed} ✓</span>
        <span className="c-rej">{person.counts.rejected} ✗</span>
      </div>
      {/* #173 (§4.38) — Update person, directly above Remove person and
          styled like it: commits the pending name (rename-merge), the
          pending note and the staged group ops, in that order — the same
          action as Enter. mousedown must NOT blur the focused field: a
          blur-commit would race the ordered commit below (a late rename
          could clobber freshly applied group ops) */}
      {!system && (
        <button
          type="button"
          className="dp-update"
          onMouseDown={(e) => e.preventDefault()}
          title={
            ops.length > 0
              ? "Commit the pending name/note and the staged group changes — same as Enter (§4.38)"
              : "Commit any pending name/note change — same as Enter (§4.38)"
          }
          onClick={() => commit(ops)}
        >
          Update person
        </button>
      )}
      <button
        className="bad dp-remove"
        title={
          system
            ? "The system person cannot be removed (#165, §4.35)"
            : "Reject all this person's faces onto the Rejected system person and remove them (no undo)"
        }
        disabled={system}
        onClick={() => onRemovePerson?.(person.id)}
      >
        Remove person
      </button>
      <h3>
        Reference faces ({refcrops.length})
      </h3>
      <div className="dp-refcrops">
        {groupRefcrops(refcrops).map(([group, rows]) => (
          <div className="refcrop-group" key={group !== "" ? group : "none"}>
            <div className="refcrop-group-title">
              {group !== "" ? group : "no description"} ({rows.length})
            </div>
            {rows.map((rc) => (
              <div className="refcrop" key={rc.face_id} title={rc.filename}>
                <img src={rc.image} alt="" style={rotStyle(rotOf(rc.face_id))} />
                <span className="refcrop-desc">
                  {rc.pinned ? "📌 " : ""}#{rc.seq}
                </span>
                <button className="refcrop-x" title="Remove reference face" onClick={() => onRemoveRefcrop(rc.face_id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        ))}
        {refcrops.length === 0 && <span className="dim">no reference faces yet (confirm faces first)</span>}
      </div>
    </div>
  );
}

export default function DetailPane(props: Props) {
  const { person, snapshot, faceFilter } = props;
  if (person) {
    return <PersonView {...props} person={person} />;
  }
  if (!snapshot) return <div className="dim">loading…</div>;
  const t = { total: 0, provisional: 0, confirmed: 0, rejected: 0 };
  const faces = snapshot.faces.filter((f) => matchesStatusFilter(f.link_status, faceFilter));
  for (const f of faces) {
    t.total++;
    t[f.link_status as keyof typeof t]++;
  }
  const known = snapshot.persons.filter((p) => !p.name.startsWith("Unknown")).length;
  return (
    <div className="dp-summary">
      <h3>Overview</h3>
      <p>
        {snapshot.persons.length} persons ({known} named) · {snapshot.images.length} images ·{" "}
        {snapshot.imports.length} rolls
      </p>
      <p>
        {t.total} faces: <span className="c-prov">{t.provisional} new</span> ·{" "}
        <span className="c-conf">{t.confirmed} confirmed</span> ·{" "}
        <span className="c-rej">{t.rejected} rejected</span>
      </p>
      <p className="dim">
        Select a person in the tree, or work through the Review grid. After any change all panes
        refresh automatically.
      </p>
    </div>
  );
}
