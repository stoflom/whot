import type { Person } from "../api";
import { normalizeGroupPath } from "../groupList";
import type { SuggestOption } from "./PathTypeahead";
import GroupDialog from "./GroupDialog";

// #256 — the ONE "Add group" dialog, shared by App's face menu and the
// tree's person rows (§4.16 + #165/§4.35, #164/§4.18): the typed path
// becomes an ADDITIONAL membership — every current group of the
// person(s) is kept; a status seat, if any, is dropped instead. Faces
// and names are untouched. Title/body/normalization live here; the
// host owns opening/closing and the IPC call (§4.43 — reference-free).
//
// The submit contract keeps the pre-refactor shape: onSubmit ALWAYS
// fires (the host closes the dialog there) with the normalized path —
// an empty one is a closed dialog silently, no IPC.

interface Props {
  /** the persons the group is ADDED to */
  ids: number[];
  /** the persons snapshot — the single-person title looks the name up */
  persons: Person[];
  /** #97: suggestions over the existing group paths */
  options: SuggestOption[];
  /** (ids, normalized path) — the host closes and dispatches */
  onSubmit: (ids: number[], path: string) => void;
  onCancel: () => void;
}

export default function AddGroupDialog({
  ids,
  persons,
  options,
  onSubmit,
  onCancel,
}: Props) {
  const byId = new Map(persons.map((p) => [p.id, p]));
  return (
    <GroupDialog
      options={options}
      title={
        ids.length > 1
          ? `Add a group to ${ids.length} persons`
          : `Add a group to '${byId.get(ids[0])?.name ?? "?"}'`
      }
      body={
        "Adds this path as ANOTHER group — every current group of the person(s) " +
        "is kept (a person can belong to several); a status seat, if any, " +
        "is dropped instead. Faces and names are untouched."
      }
      defaultPath=""
      submitLabel="add group"
      onSubmit={(path) => onSubmit(ids, normalizeGroupPath(path))}
      onCancel={onCancel}
    />
  );
}
