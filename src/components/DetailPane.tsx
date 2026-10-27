import { useEffect, useState } from "react";
import type { Person, Refcrop, Snapshot } from "../api";
import { useFaceImage } from "../hooks";
import { rotStyle } from "../rotation";
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
  onGroup: (id: number, group: string) => void;
  onNote: (id: number, note: string) => void;
  // #145: the avatar opens the primary face's full image in focus mode
  onOpenPrimary: (faceId: number) => void;
  onRemoveRefcrop: (faceId: number) => void;
  /** remove this person (§4.13, #35) */
  onRemovePerson?: (id: number) => void;
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
}: {
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  /** #56 (§4.20): input family — 'group' for paths, 'desc' for face
      descriptions; Name/Note keep the default look */
  variant?: "group" | "desc";
  onCommit: (v: string) => void;
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
        <textarea rows={2} className={cls} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} placeholder={placeholder} title={title} />
      ) : persons ? (
        <NameTypeahead value={v} onChange={setV} persons={persons} onSubmit={commit}
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
          onChange={(e) => setV(e.target.value)}
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

function PersonView({ person, refcrops, snapshot, onName, onGroup, onNote, onOpenPrimary, onRemoveRefcrop, onRemovePerson }: PersonViewProps) {
  const primaryImg = useFaceImage(person.primary_face_id);
  const system = person.name === "Rejected"; // #165/§4.35
  // #122: crop rotations are per-face — the primary face and every
  // refcrop spin with their own stored angle
  const rotOf = (faceId: number) =>
    snapshot?.faces.find((f) => f.id === faceId)?.rotation ?? 0;
  const pathOptions = useGroupPathOptions(snapshot?.persons ?? []);   // #97
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
          onCommit={(v) => onName(person.id, v)}
        />
      )}
      {system ? (
        <div className="dp-field">
          <span>Group</span>
          <span className="dim">Rejected — the system seat (#165), not editable</span>
        </div>
      ) : (
        <Editable
          label="Group"
          value={person.groups[0] ?? ""}
          placeholder="e.g. family|lombards (empty = status seat, §4.35)"
          variant="group"
          pathOptions={pathOptions}
          title="Group path — '|' separated, e.g. family|lombards (empty = the person's status seat, §4.35)"
          selectAllOnFocus
          onCommit={(v) => onGroup(person.id, v)}
        />
      )}
      <Editable
        label="Note"
        value={person.note ?? ""}
        multiline
        title="Note — free text about this person"
        onCommit={(v) => onNote(person.id, v)}
      />
      <div className="dp-counts">
        <span>{person.counts.total} faces</span>
        <span className="c-prov">{person.counts.provisional} new</span>
        <span className="c-conf">{person.counts.confirmed} ✓</span>
        <span className="c-rej">{person.counts.rejected} ✗</span>
      </div>
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
