// The merge engine (gui-design §4.44 round 2 stage 5, #296) — ONE hook
// owns the merge state and its ordering: the #88/#287 triage
// (`mergeOpen`/`mergeAnchor` — null = the tree route, non-null = the
// anchored detail-panel route), the shared §4.28 person-merge
// confirmation (`mergeInto`), the #135 face-level confirmation
// (`faceMerge`, the rule 34 drop-on-person-row path), the refusals and
// designed no-ops, the one-transaction `assign_person` merges and the
// #133 post-merge re-anchor. The dialogs (MergeSimilarDialog/
// MergeIntoDialog/FaceMergeDialog) read the state; this engine owns
// the ordering.
//
// Identity per #98: every callback churns at exactly the rate its
// inline version did (the same deps, relocated); the view reactions —
// the anchor/image/mode setters, the #260 drag clear, the #101
// Edit-dialog open — are injected deps.

import { useCallback, useState } from "react";
import * as api from "./api";
import type { Person, Settings, Snapshot } from "./api";
import type { Mode } from "./sections";
import { faceMergePlan } from "./faceDrop";
import { faceIdsOf } from "./nameCluster";
import type { StageScope } from "./stage";

export interface MergeFlowDeps {
  snap: Snapshot | null;
  personsById: Map<number, Person>;
  /** the one IPC seam (App binds this hook's sibling transports) */
  mutate: (fn: () => Promise<unknown>, clearSel?: boolean) => Promise<boolean>;
  refresh: () => Promise<void>;
  setInfo: (m: string) => void;
  setError: (m: string) => void;
  setPersonId: (id: number | null) => void;
  setImageId: (id: number | null) => void;
  setMode: (m: Mode) => void;
  /** #260: the shared face-drag clear (App side of the drag hook) */
  clearFaceDrag: () => void;
  /** #101: rename-selection opens the shared Edit dialog */
  openEdit: (
    defaultScope: StageScope,
    target?: { card?: number; group?: number[] },
    selectionOverride?: number[]
  ) => void;
}

export function useMergeFlow(deps: MergeFlowDeps) {
  const {
    snap,
    personsById,
    mutate,
    refresh,
    setInfo,
    setError,
    setPersonId,
    setImageId,
    setMode,
    clearFaceDrag,
    openEdit,
  } = deps;

  // #88 (§4.28): Merge Similar Persons triage + shared merge confirmation;
  // v13.0 (#287): mergeAnchor != null = the anchored detail-panel route
  // (the dialog lists only that person's cluster); null = the tree route
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeAnchor, setMergeAnchor] = useState<number | null>(null);
  const [mergeInto, setMergeInto] = useState<
    { sourceIds: number[]; targetId?: number } | null
  >(null);
  // #135 (rule 34): a face drag dropped on a person row — face-level
  // merge confirmation (the §4.28 person-level dialog moves whole persons)
  const [faceMerge, setFaceMerge] = useState<
    { faceIds: number[]; targetId: number } | null
  >(null);

  const openMergeDialog = useCallback(() => {
    setMergeAnchor(null);
    setMergeOpen(true);
  }, []);
  const openMergeSimilar = useCallback((id: number) => {
    setMergeAnchor(id);
    setMergeOpen(true);
  }, []);
  const closeMergeDialog = useCallback(() => {
    setMergeOpen(false);
    setMergeAnchor(null);
  }, []);

  const saveMergeSettings = useCallback(
    async (patch: Partial<Settings>) => {
      if (!snap) return;
      try {
        await api.setSettings({ ...snap.settings, ...patch });
        await refresh().catch((e) => setError(String(e)));
      } catch (e) {
        setError(String(e));
      }
    },
    [snap, refresh],
  );

  /** menu / DnD path: open the shared confirmation (§4.28). Refuses an
      UnknownN *target* up-front (also refused server-side) and treats a
      drop onto the only selection as the designed no-op. */
  const openMergeInto = useCallback(
    (sourceIds: number[], targetId?: number) => {
      if (!snap) return;
      if (targetId != null) {
        const target = snap.persons.find((p) => p.id === targetId);
        if (target && /^unknown/i.test(target.name)) {
          setError(
            "cannot merge into an UnknownN cluster — it is an importer placeholder, not a person",
          );
          return;
        }
        if (sourceIds.every((id) => id === targetId)) {
          setInfo("already merged — the drop target is the only selection");
          return;
        }
      }
      setMergeInto({ sourceIds, targetId });
    },
    [snap],
  );

  const confirmMerge = useCallback(
    async (target: Person) => {
      if (!snap || !mergeInto) return;
      const sourceIds = mergeInto.sourceIds.filter((id) => id !== target.id);
      // target's own faces stay put: only the sources' faces move (§4.28)
      const faceIds = snap.faces
        .filter((f) => f.person_id != null && sourceIds.includes(f.person_id))
        .map((f) => f.id);
      setMergeInto(null);
      if (faceIds.length === 0) {
        setInfo("nothing to merge — the selected persons have no faces");
        return;
      }
      // one assign_person call = one transaction, §4.1 merge semantics
      // (claim on rejected, emptied shells deleted, derived state recomputed).
      // #178/§4.1: the group is never applied to an existing target (F2)
      // — pass "" so a STATUS SEAT can never reach assign_person's
      // up-front path validation (#165: an unfiled target's groups[0]
      // IS their seat)
      const ok = await mutate(() => api.assignPerson(faceIds, target.name, ""));
      if (ok) {
        // #133 (§4.28): the centre pane opens the merged target — all the
        // combined faces (a failed merge leaves the selection unchanged)
        setPersonId(target.id);
        setImageId(null);
        setMode("person");
      }
    },
    [snap, mergeInto, mutate],
  );

  // #135 (rule 34): a face drag dropped on a person row — the same
  // shared merge validation as every path; the confirmation is the
  // face-level dialog (whole-person merges use the §4.28 one)
  const onFacesDropped = useCallback(
    (faceIds: number[], targetId: number) => {
      // the drag is over — clear the payload and highlights (App side,
      // the shared clear from useFaceDrag, #260)
      clearFaceDrag();
      if (!snap) return;
      const target = personsById.get(targetId);
      if (!target) return;
      // §4.28: an UnknownN cluster is an importer placeholder, not a
      // person — refused here and server-side; the message stays
      // reference-free (§4.43)
      if (/^unknown/i.test(target.name)) {
        setError(
          "cannot merge into an UnknownN cluster — it is an importer placeholder, not a person",
        );
        return;
      }
      const plan = faceMergePlan(faceIds, target.id, snap.faces, snap.persons);
      if (plan.movers.length === 0) {
        setInfo(
          `all ${faceIds.length} face(s) are already on ${target.name} — nothing to move`,
        );
        return;
      }
      setFaceMerge({ faceIds: plan.movers, targetId });
    },
    [snap, personsById, clearFaceDrag],
  );

  const confirmFaceMerge = useCallback(async () => {
    if (!snap || !faceMerge) return;
    const target = personsById.get(faceMerge.targetId);
    const faceIds = faceMerge.faceIds;
    setFaceMerge(null);
    if (!target) return;
    // one assign_person call = one transaction, §4.1 merge semantics
    // (claim on rejected, emptied shells deleted, derived state recomputed)
    // #178/§4.1: "" — never the target's group (F2 ignores it anyway,
    // and for an unfiled target groups[0] IS their status seat, which
    // #165's up-front validation refuses)
    const ok = await mutate(() => api.assignPerson(faceIds, target.name, ""));
    if (ok) {
      // #133 (rule 34): the centre pane opens the merged target
      setPersonId(target.id);
      setImageId(null);
      setMode("person");
    }
  }, [snap, faceMerge, personsById, mutate]);

  /** bulk rename/merge over a person selection: open the Edit dialog
      over all their faces (§4.1 rename-merge, #101) */
  const renamePersons = useCallback(
    (ids: number[]) => {
      if (!snap) return;
      const faceIds = faceIdsOf(snap.faces, new Set(ids));
      if (faceIds.length === 0) {
        setInfo("no faces to rename — the selection has no faces");
        return;
      }
      // #101: rename-selection opens the shared dialog scoped to all
      // faces of those persons (a synthetic Group scope)
      openEdit("group", { group: faceIds });
    },
    [snap, openEdit],
  );

  /** bulk group apply from the review dialog (§4.16, reversible) */
  const applyGroupToSelection = useCallback((ids: number[], group: string) => {
    if (ids.length === 0) return;
    void mutate(() => api.movePersonsToGroup(ids, group));
  }, [mutate]);

  return {
    mergeOpen,
    mergeAnchor,
    mergeInto,
    setMergeInto,
    faceMerge,
    setFaceMerge,
    openMergeDialog,
    openMergeSimilar,
    closeMergeDialog,
    saveMergeSettings,
    openMergeInto,
    confirmMerge,
    onFacesDropped,
    confirmFaceMerge,
    renamePersons,
    applyGroupToSelection,
  };
}

export type MergeFlow = ReturnType<typeof useMergeFlow>;
