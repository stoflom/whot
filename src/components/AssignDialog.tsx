import { useEffect, useState } from "react";
import type { Person } from "../api";
import NameTypeahead from "./NameTypeahead";
import PathTypeahead, { useGroupPathOptions } from "./PathTypeahead";

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
  const pathOptions = useGroupPathOptions(persons);   // #97
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
            title="Name — an existing person merges into; suggestions list matches"
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
          <PathTypeahead
            className="input-group"
            value={group}
            onChange={setGroup}
            options={pathOptions}
            title="Group path — '|' separated, e.g. family|lombards (empty = ungrouped); picking a name above copies its group here"
            placeholder="e.g. family|lombards (empty = ungrouped)"
            onSubmit={() => name.trim() && onSubmit(name, group)}
          />
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
