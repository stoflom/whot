// #331 — PersonTree's dialog cluster, extracted verbatim from
// PersonTree.tsx's render: the §4.16 group dialogs (rename/move branch,
// move persons), the shared AddGroupDialog (#256) and the delete-group
// confirmation. PersonTree stays the state owner — the props ARE the
// existing values and callbacks, relocated; no behaviour change. The
// contract suite (C1–C74) pins the surface.
import type { Dispatch, SetStateAction } from "react";
import type { Person } from "../api";
import type { SuggestOption } from "./SuggestInput";
import { firstRealGroup, normalizeGroupPath } from "../groupList";
import GroupDialog from "./GroupDialog";
import AddGroupDialog from "./AddGroupDialog";
import ConfirmDialog from "./ConfirmDialog";

export type TreeGroupDialog =
  | { kind: "rename-branch"; path: string }
  | { kind: "move-persons"; ids: number[] }
  | { kind: "add-group"; ids: number[] }
  | null;

export interface ConfirmDeleteGroup {
  path: string;
  count: number;
}

interface Props {
  groupDialog: TreeGroupDialog;
  confirmDeleteGroup: ConfirmDeleteGroup | null;
  persons: Person[];
  /** the person lookup the move dialog's prefill reads (#233) */
  byId: Map<number, Person>;
  pathOptions: SuggestOption[];
  onRenameGroup: (path: string, norm: string) => void;
  onMovePersons: (ids: number[], path: string) => void;
  onAddGroup: (ids: number[], norm: string) => void;
  onDeleteGroup: (path: string) => void;
  setGroupDialog: Dispatch<SetStateAction<TreeGroupDialog>>;
  setConfirmDeleteGroup: Dispatch<SetStateAction<ConfirmDeleteGroup | null>>;
}

export default function TreeDialogs({
  groupDialog,
  confirmDeleteGroup,
  persons,
  byId,
  pathOptions,
  onRenameGroup,
  onMovePersons,
  onAddGroup,
  onDeleteGroup,
  setGroupDialog,
  setConfirmDeleteGroup,
}: Props) {
  return (
    <>
      {/* #256 — the "add-group" kind is the shared AddGroupDialog
          (title/body/normalization in ONE place); the other two stay.
          #165/§4.35 (status seats) + §4.16 (add vs replace) — the
          dialog bodies stay reference-free (§4.43) */}
      {groupDialog && groupDialog.kind !== "add-group" && (
        <GroupDialog
          options={pathOptions}
          title={
            groupDialog.kind === "rename-branch"
              ? "Rename / move group"
              : groupDialog.ids.length > 1
                ? `Move ${groupDialog.ids.length} persons to a group`
                : "Move person to a group"
          }
          body={
            groupDialog.kind === "rename-branch"
              ? "The whole branch — including sub-branches — follows to the new path. " +
                "Empty = everybody falls to their status seat."
              : // #233 (§4.35 display rule) lives in the defaultPath below
                "Replaces each person's group path (empty = their status seat). " +
                "Faces and names are untouched."
          }
          defaultPath={
            groupDialog.kind === "rename-branch"
              ? groupDialog.path
              // #233 (§4.35 display rule): the prefill is the person's
              // first REAL group — a status seat never shows as the
              // current group
              : firstRealGroup(byId.get(groupDialog.ids[0])?.groups ?? [])
          }
          submitLabel={
            groupDialog.kind === "rename-branch" ? "move group" : "move"
          }
          onSubmit={(path) => {
            const d = groupDialog;
            setGroupDialog(null);
            if (d.kind === "rename-branch") {
              // compare normalised (#42 via #256's normalizeGroupPath):
              // whitespace-only edits are a no-op
              const norm = normalizeGroupPath(path);
              if (norm !== d.path) onRenameGroup(d.path, norm);
            } else {
              onMovePersons(d.ids, path);
            }
          }}
          onCancel={() => setGroupDialog(null)}
        />
      )}
      {groupDialog?.kind === "add-group" && (
        <AddGroupDialog
          ids={groupDialog.ids}
          persons={persons}
          options={pathOptions}
          onSubmit={(ids, norm) => {
            setGroupDialog(null);
            if (norm && ids.length > 0) onAddGroup(ids, norm);
          }}
          onCancel={() => setGroupDialog(null)}
        />
      )}
      {confirmDeleteGroup && (
        <ConfirmDialog
          title={`Delete group '${confirmDeleteGroup.path}'`}
          body={
            // #165/§4.35: absorbed persons fall to their status seat —
            // the body stays reference-free (§4.43)
            `${confirmDeleteGroup.count} person(s) — including any sub-branches — ` +
            "fall to their status seat. Faces, names and statuses are untouched."
          }
          confirmLabel="delete group"
          danger
          onConfirm={() => {
            const d = confirmDeleteGroup;
            setConfirmDeleteGroup(null);
            onDeleteGroup(d.path);
          }}
          onCancel={() => setConfirmDeleteGroup(null)}
        />
      )}
    </>
  );
}
