import { useEffect, useState } from "react";
import type { Person } from "../api";
import NameTypeahead from "./NameTypeahead";

interface Props {
  count: number;
  defaultName: string;
  defaultGroup: string;
  /** existing persons — name suggestions; picking one merges into it */
  persons: Person[];
  onSubmit: (name: string, group: string) => void;
  onCancel: () => void;
}

export default function AssignDialog({ count, defaultName, defaultGroup, persons, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(defaultName);
  const [group, setGroup] = useState(defaultGroup);
  useEffect(() => {
    setName(defaultName);
    setGroup(defaultGroup);
  }, [defaultName, defaultGroup]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog">
        <h3>Assign person to {count} face(s)</h3>
        <p className="dim">
          Faces become <b>confirmed</b> for this person. If all selected faces belong to a single
          UnknownN with this name, the cluster is renamed in place; unselected faces keep their
          current person.
        </p>
        <label>
          Name
          <NameTypeahead
            autoFocus
            value={name}
            onChange={setName}
            persons={persons}
            onPick={(p) => {
              // the picked person is the merge target — mirror its group
              // unless the user already typed one (#67)
              if (group === defaultGroup) setGroup(p.groups[0] ?? "");
            }}
            onSubmit={() => name.trim() && onSubmit(name, group)}
          />
        </label>
        <label>
          Group
          <input value={group} className="input-group" onChange={(e) => setGroup(e.target.value)}
            placeholder="e.g. family|lombards (empty = ungrouped)"
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && name.trim()) onSubmit(name, group);
            }} />
        </label>
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>cancel</button>
          <button disabled={!name.trim()} onClick={() => onSubmit(name, group)}>
            assign & accept
          </button>
        </div>
      </div>
    </div>
  );
}
