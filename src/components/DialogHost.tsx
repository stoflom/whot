// #331 — the dialog host subtree, extracted verbatim from App.tsx's
// render: every overlay the app opens — the merge cluster (similar /
// into / face-level / add-group), the annotated-export dialog, the
// shared Edit dialog, the chrome dialogs (help / settings / env), the
// #295 context-confirm guard, the Person-mode guard dialogs, the
// remove confirmation, the context menu and the two toasts. App stays
// the state owner — the props ARE the existing values and callbacks,
// relocated; no behaviour change. The contract suite (C1–C74) pins the
// surface.
import type { Dispatch, SetStateAction } from "react";
import * as api from "../api";
import type {
  Face,
  ImageRow,
  Person,
  Settings,
  Snapshot,
} from "../api";
import type { FaceFilter } from "../viewFilters";
import type { Mode } from "../sections";
import {
  addTokens,
  buildStage,
  expandAddStage,
  stagedFieldsForCard,
  upsertStage,
  type Prefill,
  type Stage,
  type StageScope,
} from "../stage";
import { faceMergePlan } from "../faceDrop";
import type { GroupOp } from "../groupList";
import type { SuggestOption } from "./SuggestInput";
import type { MenuState } from "./ContextMenu";
import MergeSimilarDialog from "./MergeSimilarDialog";
import MergeIntoDialog from "./MergeIntoDialog";
import FaceMergeDialog from "./FaceMergeDialog";
import AddGroupDialog from "./AddGroupDialog";
import AnnotatedExportDialog from "./AnnotatedExportDialog";
import EditDialog from "./EditDialog";
import HelpDialog from "./HelpDialog";
import SettingsPopover from "./SettingsPopover";
import EnvDialog from "./EnvDialog";
import ContextConfirmDialog from "./ContextConfirmDialog";
import { PickPersonDialog, NoFacesDialog } from "./guards";
import ConfirmRemoveDialog from "./ConfirmRemoveDialog";
import ContextMenu from "./ContextMenu";
import { ErrorToast, InfoToast } from "./ErrorNotice";

export interface EditState {
  defaultScope: StageScope;
  card: number[];
  group: number[];
  prefills: Record<StageScope, Prefill>;
}

interface Props {
  // the snapshot every dialog reads its persons/faces/settings from
  snap: Snapshot | null;
  // §4.28 merge triage + #135 face-level confirm (useMergeFlow state)
  mergeOpen: boolean;
  mergeAnchor: number | null;
  mergeInto: { sourceIds: number[]; targetId?: number } | null;
  faceMerge: { faceIds: number[]; targetId: number } | null;
  faceAddGroup: { ids: number[] } | null;
  exportImage: ImageRow | null;
  edit: EditState | null;
  // chrome + guards
  helpOpen: boolean;
  settingsOpen: boolean;
  envOpen: boolean;
  noDb: boolean;
  // the toasts
  error: string | null;
  info: string | null;
  contextConfirm: { fn: () => void } | null;
  pickPersonDialog: boolean;
  noFacesDialog: boolean;
  confirmRemove: number[] | null;
  menu: MenuState | null;
  // rule bar's staged set + selection context (the Edit dialog's scopes)
  pending: Stage[];
  sel: Set<number>;
  /** the live selection at event time (#228 F-L4) */
  selRef: { readonly current: Set<number> };
  /** the live staged set at event time */
  pendingRef: { readonly current: Stage[] };
  personId: number | null;
  faceFilter: FaceFilter;
  // derived lookups + the option lists
  personsById: Map<number, Person>;
  facesById: Map<number, Face>;
  personOptions: Person[];
  pathOptions: SuggestOption[];
  descOptions: SuggestOption[];
  // §4.28/§4.44 callbacks (the useMergeFlow members)
  saveMergeSettings: (patch: Partial<Settings>) => Promise<void>;
  openMergeInto: (sourceIds: number[], targetId?: number) => void;
  applyGroupToSelection: (ids: number[], group: string) => void;
  renamePersons: (ids: number[]) => void;
  closeMergeDialog: () => void;
  confirmMerge: (target: Person) => void;
  confirmFaceMerge: () => Promise<unknown>;
  addPersonsToGroup: (ids: number[], path: string) => void;
  faceVisible: (f: Face) => boolean;
  // the commit chain + verdicts (§4.44)
  commitPending: (all: Stage[], acceptIds?: number[], groupOps?: GroupOp[]) => Promise<void>;
  doReject: (ids: number[]) => void;
  markExhaust: () => void;
  mutate: (fn: () => Promise<unknown>, clearSel?: boolean) => Promise<boolean>;
  refresh: () => Promise<unknown>;
  changeFaceFilter: (f: FaceFilter) => void;
  closeMenu: () => void;
  // the setters (stable useState functions)
  setMergeInto: Dispatch<SetStateAction<{ sourceIds: number[]; targetId?: number } | null>>;
  setFaceMerge: Dispatch<SetStateAction<{ faceIds: number[]; targetId: number } | null>>;
  setFaceAddGroup: Dispatch<SetStateAction<{ ids: number[] } | null>>;
  setExportImage: Dispatch<SetStateAction<ImageRow | null>>;
  setEdit: Dispatch<SetStateAction<EditState | null>>;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setEnvOpen: Dispatch<SetStateAction<boolean>>;
  setContextConfirm: Dispatch<SetStateAction<{ fn: () => void } | null>>;
  setPickPersonDialog: Dispatch<SetStateAction<boolean>>;
  setNoFacesDialog: Dispatch<SetStateAction<boolean>>;
  setConfirmRemove: Dispatch<SetStateAction<number[] | null>>;
  setSelPersons: Dispatch<SetStateAction<Set<number>>>;
  setPersonId: Dispatch<SetStateAction<number | null>>;
  setMode: Dispatch<SetStateAction<Mode>>;
  setPending: Dispatch<SetStateAction<Stage[]>>;
  setInfo: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

export default function DialogHost(p: Props) {
  const {
    snap, mergeOpen, mergeAnchor, mergeInto, faceMerge, faceAddGroup,
    exportImage, edit, helpOpen, settingsOpen, envOpen, noDb, contextConfirm,
    pickPersonDialog, noFacesDialog, confirmRemove, menu, pending, sel,
    selRef, pendingRef, personId, faceFilter, personsById, facesById,
    personOptions, pathOptions, descOptions, error, info, saveMergeSettings,
    openMergeInto, applyGroupToSelection, renamePersons, closeMergeDialog,
    confirmMerge, confirmFaceMerge, addPersonsToGroup, faceVisible,
    commitPending, doReject, markExhaust, mutate, refresh, changeFaceFilter,
    closeMenu, setMergeInto, setFaceMerge, setFaceAddGroup, setExportImage,
    setEdit, setHelpOpen, setSettingsOpen, setEnvOpen, setContextConfirm,
    setPickPersonDialog, setNoFacesDialog, setConfirmRemove, setSelPersons,
    setPersonId, setMode, setPending, setInfo, setError,
  } = p;
  return (
    <>
      {mergeOpen && snap && (
        <MergeSimilarDialog
          persons={snap.persons}
          settings={snap.settings}
          // v13.0 (#287): the anchored route — only the pane person's
          // cluster; null (the tree route) lists everything
          anchorId={mergeAnchor ?? undefined}
          onSaveSettings={saveMergeSettings}
          onMergeInto={(ids) => openMergeInto(ids)}
          onApplyGroup={applyGroupToSelection}
          onRename={renamePersons}
          onClose={closeMergeDialog}
          escActive={mergeInto == null && edit == null}
        />
      )}
      {mergeInto && snap && (
        <MergeIntoDialog
          sources={mergeInto.sourceIds
            .map((id) => personsById.get(id))
            .filter((p): p is Person => !!p)}
          defaultTarget={
            mergeInto.targetId != null
              ? personsById.get(mergeInto.targetId) ?? null
              : null
          }
          persons={snap.persons}
          onConfirm={confirmMerge}
          onCancel={() => setMergeInto(null)}
        />
      )}
      {faceMerge && snap && personsById.get(faceMerge.targetId) && (
        <FaceMergeDialog
          plan={faceMergePlan(
            faceMerge.faceIds,
            faceMerge.targetId,
            snap.faces,
            snap.persons,
          )}
          sourceNames={new Map(snap.persons.map((p) => [p.id, p.name]))}
          target={personsById.get(faceMerge.targetId)!}
          onConfirm={() => void confirmFaceMerge()}
          onCancel={() => setFaceMerge(null)}
        />
      )}
      {/* #165/§4.35 (status seats) + §4.16 (add vs replace) — the
          body stays reference-free (§4.43); #256 — the shared
          AddGroupDialog (title/body/normalization live in ONE place) */}
      {faceAddGroup && (
        <AddGroupDialog
          ids={faceAddGroup.ids}
          persons={snap?.persons ?? []}
          options={pathOptions}
          onSubmit={(ids, norm) => {
            setFaceAddGroup(null);
            if (norm && ids.length > 0) addPersonsToGroup(ids, norm);
          }}
          onCancel={() => setFaceAddGroup(null)}
        />
      )}
      {/* #298 (rule 51): the annotated-image export — the bar's ⤓ and
          the image-area menu's entry both land here; the faces are the
          §4.10 visible pass of the invoked image */}
      {exportImage && (
        <AnnotatedExportDialog
          image={exportImage}
          faces={
            snap
              ? snap.faces.filter(
                  (f) => f.image_id === exportImage.id && faceVisible(f)
                )
              : []
          }
          personName={(pid) =>
            pid != null ? personsById.get(pid)?.name ?? null : null}
          onClose={() => setExportImage(null)}
          onSaved={setInfo}
          onError={setError}
        />
      )}
      {edit && snap && (
        <EditDialog
          defaultScope={edit.defaultScope}
          counts={{
            card: edit.card.length,
            group: edit.group.length,
            selection: sel.size,
          }}
          prefills={edit.prefills}
          persons={personOptions}
          pathOptions={pathOptions}
          descOptions={descOptions}
          onDone={(r) => {
            const ids =
              r.scope === "card"
                ? edit.card
                : r.scope === "group"
                  ? edit.group
                  : [...selRef.current];
            setEdit(null);
            // #231/#263 (§4.24): a `|` add-mode description expands per face
            // against its displayed value (staged overlay over
            // committed); faces the add leaves unchanged drop out
            const st = buildStage(ids, r.values, r.touched);
            const stages =
              st?.desc != null && addTokens(st.desc).length > 0
                ? expandAddStage(st, (id) =>
                    stagedFieldsForCard(pendingRef.current, id).desc ??
                    facesById.get(id)?.description ??
                    "")
                : st
                  ? [st]
                  : null;
            if (!stages) {
              if (r.kind === "accept") {
                // nothing field-staged — Accept still accepts the scope
                // (§4.30); #181: a list-only Accept commits the group
                // ops through the same chain (no stage, just the ops)
                if (ids.length > 0) void commitPending([], ids, r.groupOps);
                return;
              }
              if (r.groupOps.length > 0) {
                // Apply leaves the list edits LOCAL — they preview in
                // the list itself and commit with Accept (#181)
                setInfo("group changes commit with Accept");
                return;
              }
              // #103: a no-op Apply says so — reference-free (§4.43)
              setInfo("nothing to apply — change a field first");
              return;
            }
            if (r.kind === "apply") {
              // #123: extend the set (#231: an add-mode submit can be
              // several concrete stages)
              setPending((p) => stages.reduce((acc, s) => upsertStage(acc, s), p));
              return;
            }
            // #166: the staged ops commit first, then this dialog's
            // chosen scope is accepted (the set edits, never the scope);
            // #181: the list edits ride along (name first, memberships
            // against the surviving person)
            void commitPending(
              stages.reduce((acc, s) => upsertStage(acc, s), pendingRef.current),
              ids,
              r.groupOps,
            );
          }}
          onReject={(scope) => {
            // #124: a verdict, not a field edit — commits immediately.
            // #165/§4.35: the *Un-reject (accept)* relabel retired — an
            // assignment claims (the dialog's Accept with a NAME), and
            // the button is disabled on a fully-rejected scope.
            const ids =
              scope === "card"
                ? edit.card
                : scope === "group"
                  ? edit.group
                  : [...selRef.current];
            setEdit(null);
            // F2: doReject drops the newly-moot stages itself (#141)
            void doReject(ids);
          }}
          rejected={{
            card:
              edit.card.length > 0 &&
              edit.card.every((id) => facesById.get(id)?.link_status === "rejected"),
            group:
              edit.group.length > 0 &&
              edit.group.every((id) => facesById.get(id)?.link_status === "rejected"),
            selection:
              sel.size > 0 &&
              [...sel].every((id) => facesById.get(id)?.link_status === "rejected"),
          }}
          onCancel={() => setEdit(null)}
        />
      )}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {settingsOpen && snap && (
        <SettingsPopover
          settings={snap.settings}
          onClose={() => setSettingsOpen(false)}
          onEnv={() => {
            setSettingsOpen(false);
            setEnvOpen(true);
          }}
          onSave={async (s) => {
            await api.setSettings(s).catch((e) => setError(String(e)));
            setSettingsOpen(false);
            await refresh().catch((e) => setError(String(e)));
          }}
        />
      )}
      {envOpen && !noDb && (
        // #303 (rule 52): the main app's entry (the first-run surface
        // renders its own above) — the save refreshes the snapshot
        <EnvDialog
          onClose={() => setEnvOpen(false)}
          onError={setError}
          onSave={async (s) => {
            await api.setSettings(s);
            await refresh();
            setInfo("environment saved — path changes take effect after a restart");
          }}
        />
      )}
      {contextConfirm && pending.length > 0 && (
        // §4.44 round 2 stage 4 (#295): the guard surface is the
        // component; the accept/discard actions stay App-side
        <ContextConfirmDialog
          pending={pending}
          onDiscard={() => {
            const act = contextConfirm.fn;
            setContextConfirm(null);
            setPending([]);
            act();
          }}
          onAccept={() => {
            const all = pending;
            const act = contextConfirm.fn;
            setContextConfirm(null);
            void commitPending(all).then(act);
          }}
        />
      )}
      {/* #176 (§4.41): the Person-mode guard dialogs — the no-anchor
          pointer (single Close) and the sticky-person guard
          (components/guards.tsx, §4.44 stage 4) */}
      {pickPersonDialog && (
        <PickPersonDialog onClose={() => setPickPersonDialog(false)} />
      )}
      {noFacesDialog && (
        <NoFacesDialog
          faceFilter={faceFilter}
          onShowAll={() => {
            setNoFacesDialog(false);
            changeFaceFilter("all");
          }}
          onClose={() => setNoFacesDialog(false)}
        />
      )}
      {confirmRemove && (
        <ConfirmRemoveDialog
          ids={confirmRemove}
          onConfirm={(ids) => {
            markExhaust(); // #125: removing may empty the current person
            setConfirmRemove(null);
            setSelPersons((prev) => {
              const n = new Set(prev);
              for (const id of ids) n.delete(id);
              return n;
            });
            if (personId != null && ids.includes(personId)) {
              setPersonId(null);
              setMode("review");
            }
            mutate(() => api.removePersons(ids), true);
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      {error && <ErrorToast message={error} onDismiss={() => setError(null)} />}
      {info && <InfoToast message={info} />}
    </>
  );
}
