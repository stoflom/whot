import { useEffect, useState } from "react";
import type { Person, Refcrop, Snapshot } from "../api";
import { useFaceImage } from "../hooks";

interface Props {
  person: Person | null;
  refcrops: Refcrop[];
  snapshot: Snapshot | null;
  onName: (id: number, name: string) => void;
  onGroup: (id: number, group: string) => void;
  onNote: (id: number, note: string) => void;
  onSetPrimary: (faceId: number) => void;
  onRemoveRefcrop: (faceId: number) => void;
}

function Editable({
  label,
  value,
  placeholder,
  multiline,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  onCommit: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v !== value) onCommit(v);
  };
  return (
    <label className="dp-field">
      <span>{label}</span>
      {multiline ? (
        <textarea rows={2} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} placeholder={placeholder} />
      ) : (
        <input
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

function PersonView({ person, refcrops, onName, onGroup, onNote, onSetPrimary, onRemoveRefcrop }: PersonViewProps) {
  const primaryImg = person.primary_face_id ? useFaceImage(person.primary_face_id) : null;
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
      <h3>
        Reference faces ({refcrops.length})
      </h3>
      <div className="dp-refcrops">
        {refcrops.map((rc) => (
          <div className="refcrop" key={rc.face_id} title={rc.filename}>
            <img src={rc.image} alt="" />
            <span className="refcrop-desc">
              {rc.description.startsWith("pin:") ? "📌 " : ""}
              {rc.description}
            </span>
            <button className="refcrop-x" title="Remove reference face" onClick={() => onRemoveRefcrop(rc.face_id)}>
              ×
            </button>
          </div>
        ))}
        {refcrops.length === 0 && <span className="dim">no reference faces yet (confirm faces first)</span>}
      </div>
    </div>
  );
}

export default function DetailPane(props: Props) {
  const { person, snapshot } = props;
  if (person) {
    return <PersonView {...props} person={person} />;
  }
  if (!snapshot) return <div className="dim">loading…</div>;
  const t = { total: 0, provisional: 0, confirmed: 0, rejected: 0 };
  for (const f of snapshot.faces) {
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
