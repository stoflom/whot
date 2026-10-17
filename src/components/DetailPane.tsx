import { useEffect, useState } from "react";
import type { Person, Refcrop, Snapshot } from "../api";
import { useFaceImage } from "../hooks";

interface Props {
  person: Person | null;
  refcrops: Refcrop[];
  snapshot: Snapshot | null;
  /** respect the show_rejected toggle in the overview totals (#28) */
  showRejected: boolean;
  onName: (id: number, name: string) => void;
  onGroup: (id: number, group: string) => void;
  onNote: (id: number, note: string) => void;
  onSetPrimary: (faceId: number) => void;
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
}: {
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  /** #56 (§4.20): input family — 'group' for paths, 'desc' for face
      descriptions; Name/Note keep the default look */
  variant?: "group" | "desc";
  onCommit: (v: string) => void;
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
        <textarea rows={2} className={cls} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} placeholder={placeholder} />
      ) : (
        <input
          className={cls}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder={placeholder}
        />
      )}
    </label>
  );
}

interface PersonViewProps extends Omit<Props, "snapshot"> {
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

function PersonView({ person, refcrops, onName, onGroup, onNote, onSetPrimary, onRemoveRefcrop, onRemovePerson }: PersonViewProps) {
  const primaryImg = useFaceImage(person.primary_face_id);
  return (
    <div className="dp-person" key={person.id}>
      <div className="dp-avatar" onClick={() => person.primary_face_id && onSetPrimary(person.primary_face_id)}>
        {primaryImg ? <img src={primaryImg} alt="" /> : <span>?</span>}
      </div>
      <Editable
        label="Name"
        value={person.name}
        onCommit={(v) => onName(person.id, v)}
      />
      <Editable
        label="Group"
        value={person.groups[0] ?? ""}
        placeholder="e.g. family|lombards (empty = ungrouped)"
        variant="group"
        onCommit={(v) => onGroup(person.id, v)}
      />
      <Editable
        label="Note"
        value={person.note ?? ""}
        multiline
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
        title="Reject all this person's faces and remove them (no undo)"
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
                <img src={rc.image} alt="" />
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
  const { person, snapshot, showRejected } = props;
  if (person) {
    return <PersonView {...props} person={person} />;
  }
  if (!snapshot) return <div className="dim">loading…</div>;
  const t = { total: 0, provisional: 0, confirmed: 0, rejected: 0 };
  const faces = showRejected
    ? snapshot.faces
    : snapshot.faces.filter((f) => f.link_status !== "rejected");
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
        <span className="c-conf">{t.confirmed} confirmed</span>
        {showRejected && (
          <>
            · <span className="c-rej">{t.rejected} rejected</span>
          </>
        )}
      </p>
      <p className="dim">
        Select a person in the tree, or work through the Review grid. After any change all panes
        refresh automatically.
      </p>
    </div>
  );
}
