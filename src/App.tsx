import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from "react";
import * as api from "./api";
import type {
  AppearanceGroup,
  Delta,
  Face,
  ImageRow,
  ImportOptions,
  Person,
  Refcrop,
} from "./api";
import EditDialog from "./components/EditDialog";
// §4.44 round 2 stage 4 (#295): the guard/confirm dialog surfaces —
// the copy + button contracts as components, actions stay App-side
import ContextConfirmDialog from "./components/ContextConfirmDialog";
import { PickPersonDialog, NoFacesDialog } from "./components/guards";
import ConfirmRemoveDialog from "./components/ConfirmRemoveDialog";
import AddGroupDialog from "./components/AddGroupDialog";
import { ErrorToast, FatalError, InfoToast } from "./components/ErrorNotice";
import { FullImageBar } from "./components/FullImageBar";
import MergeSimilarDialog from "./components/MergeSimilarDialog";
import MergeIntoDialog from "./components/MergeIntoDialog";
import { isRejectedBin } from "./personNames";
import { personDataSig } from "./personSig";
import { PrefetchCache } from "./prefetch";
import { useFaceDrag } from "./useFaceDrag";
import {
  ownersForGroupOps,
  planCommit,
  planStageOps,
  remainingAfterFailure,
  reviewScope,
  routeAccept,
} from "./commit";
import {
  flipLinkStatus,
  restoreLinkStatus,
  type Verdict,
} from "./verdictFlip";
import { mountLimitFor, growLimit } from "./gridMount";
import {
  firstRealGroup,
  renameGroupFor as renameGroup,
  type GroupOp,
} from "./groupList";
import {
  acceptAdvancePlan,
  exhaustAdvanceTarget,
  verdictAdvanceTarget,
} from "./reviewFlow";
import { faceMergePlan } from "./faceDrop";
import { useAppKeys } from "./appKeys";
import FaceMergeDialog from "./components/FaceMergeDialog";
import {
  emptyStateHint,
  listedImages,
  matchesStatusFilter,
  personTreeMembers,
  type ClusterGroup,
  type FaceFilter,
} from "./viewFilters";
import { stepBase } from "./stepFlow";
import { groupPathOptions } from "./components/PathTypeahead";
import { descTagOptions } from "./descTags";
import { useScrollPlace } from "./scrollPlace";
import {
  addTokens,
  buildStage,
  dropStagesForFaces,
  expandAddStage,
  indexStagedSet,
  objectInsideSelection,
  stageSummarySet,
  stagedFieldsForCard,
  upsertStage,
  prefillForFaces,
  type Prefill,
  type Stage,
  type StageScope,
} from "./stage";
import ContextMenu, { type MenuGroup, type MenuState } from "./components/ContextMenu";
import DetailPane from "./components/DetailPane";
import { useOverlayCount } from "./overlays";
import FaceGrid, { type Section } from "./components/FaceGrid";
import FaceOverlay from "./components/FaceOverlay";
import PersonTree from "./components/PersonTree";
// #223 (F-M1): the tree is built ONCE per treePersons change and shared
// with the pane; the step list walks the shared tree
import { buildTree, orderedVisiblePersonIdsFromTree } from "./treeIndex";
import RollsPane from "./components/RollsPane";
import RollsThumbs from "./components/RollsThumbs";
import ImportPane from "./components/ImportPane";
import FirstRun from "./components/FirstRun";
import RuleBar from "./components/RuleBar";
import SettingsPopover from "./components/SettingsPopover";
import HelpDialog from "./components/HelpDialog";
import {
  byFilename,
  clickImage,
  emptyImageSel,
  imageStepTarget,
  type ImageSel,
} from "./imageSelect";
import { faceMenuGroups, imageAreaMenuGroups, rollBranchMenuGroups, thumbMenuGroups } from "./menus";
// §4.44 (gui-design v3.94): the centre-pane section derivations are the
// pure, co-tested buildSections/sectionsForImageOf; App owns only the
// identities (see the #98 rules there)
import {
  buildSections,
  firstCropPerson,
  sectionsForImage as sectionsForImageOf,
  sectionsPersonKey,
} from "./sections";
// §4.44 round 2 (#291/#292): the detail derivations — pure/co-tested,
// App keeps only the useMemo bindings
import {
  facesOfImage,
  fullImageOpenFor,
  imageRowFor,
  splitStepFor,
  stepIndexIn,
} from "./detailView";
// §4.44 stage 2 (#206): the pane layout rules + the #191 click-pair
// guard — pure/co-tested, App owns only the wiring
import { usePaneSizes, clampRollCenterFor } from "./paneState";
import { useClickPairGuard } from "./clickPair";
// §4.44 + #222 (F-H3): the review-verdict callbacks — the #98 identity
// rule lives in the hook (person anchor read via refs), co-tested
import { useReviewVerdicts } from "./reviewVerdicts";
// §4.44 round 2 stage 2 (#293): the face-selection layer — the sel
// state + mirroring refs + the whole ref-driven handler family
import { useSelectionState } from "./useSelectionState";
// §4.44 round 2 stage 3 (#294): the backend sync layer — snapshot
// state + the #219 delta transport + the #208 focus probe
import { useSnapshotSync } from "./useSnapshotSync";
// #297 (rule 50): session persistence — the synchronous seed + the
// restore/save effects (App keeps only setter bindings)
import { useSessionInitial, useSessionPersistence } from "./useSessionState";
// §4.44 round 2 stage 5 (#296): the merge engine — triage + §4.28
// confirmation + the #135 face-level path, co-tested
import { useMergeFlow } from "./useMergeFlow";

type Mode = "review" | "rolls" | "person";

/** #219 — a mutation's result is a `Delta` (apply locally) vs `void`
    (config-only / non-DB command → full refresh). */
function isDelta(x: unknown): x is Delta {
  return typeof x === "object" && x != null && "version" in x && "drifted" in x;
}

// #234 (rule 45): the shared empty in-flight set — a stable identity so
// the grid's `inFlight` prop churns nothing while no verdict is pending
const INFLIGHT_EMPTY: Set<number> = new Set();

export default function App() {
  // §4.44 round 2 stage 3 (#294): the backend sync layer — the snapshot
  // state, the #219 delta transport, the #208 version probe + focus
  // reload and the #185 first-run routing (useSnapshotSync.ts,
  // co-tested). `mutate` below binds applyDeltas/refresh as the one IPC
  // seam the other modules bind to.
  const {
    snap,
    setSnap,
    snapRef,
    loadError,
    setLoadError,
    noDb,
    setNoDb,
    refresh,
    applyDeltas,
    onImported,
  } = useSnapshotSync();
  // #297 (rule 50): the synchronous session seed (localStorage needs no
  // snapshot — the ids are reconciled by useSessionPersistence below)
  const sessionInitial = useSessionInitial();
  const [mode, setMode] = useState<Mode>(() => sessionInitial.mode);
  // #176 (§4.41): the Person-mode guard dialogs — the no-anchor picker
  // pointer (modeless — the tree under it stays clickable) and the
  // sticky-person guard (once per person+filter pair)
  const [pickPersonDialog, setPickPersonDialog] = useState(false);
  const [noFacesDialog, setNoFacesDialog] = useState(false);
  const noFacesKeyRef = useRef("");
  const [personId, setPersonId] = useState<number | null>(() => sessionInitial.personId);
  // the pointer dialog follows its purpose: it closes as soon as a
  // person is anchored or the user leaves Person mode
  useEffect(() => {
    if (pickPersonDialog && (personId != null || mode !== "person"))
      setPickPersonDialog(false);
  }, [pickPersonDialog, personId, mode]);
  // #191 — the WebKitGTK right-click/left-click synthetic pair guard
  // (the rule and its wiring live in clickPair.ts, §4.44 co-tested)
  useClickPairGuard();
  const [imageId, setImageId] = useState<number | null>(() => sessionInitial.imageId);
  // #162: the Rolls path-filter root — session state so it survives tab
  // switches (RollsPane unmounts when the view changes); '/' = whole tree
  const [rollRoot, setRollRoot] = useState<string>(() => sessionInitial.rollRoot);
  // #274: latest-value ref — the menu callback reads it without churning
  // its identity (the #228 rule)
  const rollRootRef = useRef(rollRoot);
  rollRootRef.current = rollRoot;
  // #174 (§4.39): the selected branch of the Rolls path hierarchy —
  // session state like the root (survives mode switches): absolute
  // path, defaults to the root itself, re-validated when the root
  // changes (a selection outside the new root falls back to it)
  const [rollBranch, setRollBranch] = useState<string>(() => sessionInitial.rollBranch);
  // #265: the open branches of the Rolls path hierarchy — session
  // state like the root (RollsPane unmounts while a roll's grid is
  // open; returning must show the tree the way it was)
  const [rollOpenSet, setRollOpenSet] = useState<Set<string>>(
    () => new Set(sessionInitial.rollOpen)
  );
  const toggleRollBranch = useCallback((path: string) => {
    setRollOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  // v12.4 (#280)/§4.39: the per-branch recursive-grid state — ABSOLUTE
  // paths, session state like the open-set; the selected branch's grid
  // lists every descendant image while ticked
  const [rollRecursive, setRollRecursive] = useState<Set<string>>(
    () => new Set(sessionInitial.rollRecursive)
  );
  const toggleRollRecursive = useCallback((path: string) => {
    setRollRecursive((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  // #174 (§4.39): the right-pane thumbnail selection — the §4.23
  // anchor pattern over images; clears when the branch selection
  // changes (a different thumb set)
  const [imgSel, setImgSel] = useState<ImageSel>(emptyImageSel());
  useEffect(() => setImgSel(emptyImageSel()), [rollBranch]);
  const changeRollRoot = useCallback((p: string) => {
    setRollRoot(p);
    setRollBranch((prev) =>
      p === "/" || prev === p || prev.startsWith(`${p}/`) ? prev : p
    );
    setImgSel(emptyImageSel());
  }, []);
  // #167 (§4.36): the import pane's directory — session state in the
  // DetailPane's right-pane slot (survives tab switches); null = closed.
  // v12.4 (#280): the branch re-import routes pre-check Re-import, so
  // the pane state carries optional initial options alongside the dir
  const [importDir, setImportDir] = useState<string | null>(
    () => sessionInitial.importDir
  );
  const [importInitial, setImportInitial] = useState<
    Partial<Omit<ImportOptions, "rollDir">> | null
  >(null);
  const [confirmRemove, setConfirmRemove] = useState<number[] | null>(null);
  // #98 (§4.31) — hover is a ref: the pointer crossing cards must never
  // re-render the app. The highlight is synced imperatively
  // (data-sync-hover on card + overlay rect) by the mousemove/scroll
  // listener below. (The selection refs live in useSelectionState, #293.)
  const hoverRef = useRef<number | null>(null);
  // #228 (F-L4): the menu callbacks read the selections through these
  // refs so memo(RollsThumbs) is not re-rendered by a face/image
  // selection change via callback identity churn
  const imgSelRef = useRef<ImageSel>(emptyImageSel());
  imgSelRef.current = imgSel;
  // #275 (v11.4): the full-image face step, defined below (it needs
  // splitRow) but read by useAppKeys above — the house latest-value
  // ref pattern (the key listener reads it at event time)
  const stepSplitFaceRef = useRef<(dir: 1 | -1) => void>(() => {});
  // #98: sections handed to callbacks defined *before* them (the memoised
  // grid handlers) — same latest-value pattern as selRef/hoverRef
  const sectionsRef = useRef<Section[]>([]);
  const sectionsForImageRef = useRef<(imgId: number) => Section[]>(() => []);
  const [splitImageId, setSplitImageId] = useState<number | null>(
    () => sessionInitial.splitImageId
  );
  // #200 reopened (gui-design v3.93, §4.40): the pending review
  // re-anchor scroll — a tree select during Review re-anchors the
  // review, and the grid scrolls to that person's section through a
  // layout effect (deterministic, post-commit; rAF is frame-starved
  // in occluded/automated WebKit and must not gate user-visible work)
  const [reanchor, setReanchor] = useState<{ pid: number } | null>(null);
  // #214 (§4.40/§4.30 reveal): the centre grid's incremental mount —
  // the grid renders a PREFIX of sections and grows toward the
  // viewport edge / reveal targets (gridMount.ts). App-owned (like
  // reviewScrollRef) so the depth survives grid unmounts: the §4.40
  // scroll restore then lands on heights the user already scrolled
  // through. #225 (F-M4): the prefix covers every centre surface now —
  // review, person, image detail and the focus film roll (the gui-mock
  // harness scroll-reaches its subjects the real way, so the in-view
  // card contracts C12/C13 hold through the sentinel growth).
  // #214/#225: the mounted prefix — the review grid, the person grid,
  // the image-detail grid and the focus film roll all grow toward the
  // viewport edge (the sentinel); the App owns the limit so the depth
  // survives grid unmounts, and the reveal rule (§4.40 re-anchor, §4.30
  // accept-&-next) grows into the target before the scroll runs.
  // RollsThumbs windows its branch thumbs with the same rule in-pane.
  const [mountLimit, setMountLimit] = useState<number>(
    () => sessionInitial.mountLimit
  );
  const growMount = useCallback(
    () => setMountLimit((n) => growLimit(n)),
    []
  );
  // #214: the accept-&-next reveal target (§4.30) — grown into the
  // mounted prefix first, then scrolled into view by the layout effect
  // below (post-commit; replaces the frame-dependent double-rAF, which
  // could never reach an unmounted card)
  const [revealFace, setRevealFace] = useState<number | null>(null);
  // v14.0 (#288): the pane's refcrop *Select in grid* — the same
  // grow-then-scroll reveal, but it WAITS while the face is absent (the
  // Show-filter switch refetches the grid a beat later)
  const [focusFace, setFocusFace] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // the centre shows the HIERARCHY (no image open, no focus split) —
  // the detail views need the full width again (§4.39)
  const rollsBrowse = mode === "rolls" && imageId == null && splitImageId == null;
  // #34/#174 (§4.39) — the session pane widths and the Rolls browsing
  // centre width: the state + drag logic live in paneState.ts (§4.44
  // co-tested clamp rule); App keeps the named handles it always had
  const { paneSizes, setPaneSizes, rollCenterPx, setRollCenter, startDrag } =
    usePaneSizes(rollsBrowse, {
      left: sessionInitial.paneLeft,
      right: sessionInitial.paneRight,
    });
  // #255: keyboard resize for the pane dividers (the mouse drag is
  // startDrag; the arrows step the SAME size the drag clamps to). The
  // divider owns its keys (data-owns-keys) so the global arrow-step
  // guard above bails while it is focused.
  const dividerKey = (
    e: React.KeyboardEvent,
    edge: "left" | "right"
  ) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const right = e.key === "ArrowRight";
    if (edge === "left") {
      setPaneSizes((s) => ({ ...s, left: Math.min(Math.max(s.left + (right ? 20 : -20), 160), 480) }));
      return;
    }
    if (rollsBrowse) {
      // #174/§4.39: while browsing the centre|right divider drives the
      // centre width, not the right pane
      setRollCenter((rc) =>
        clampRollCenterFor((rc ?? paneSizes.left) + (right ? -20 : 20), window.innerWidth, paneSizes.left)
      );
      return;
    }
    setPaneSizes((s) => ({ ...s, right: Math.min(Math.max(s.right + (right ? -20 : 20), 200), 560) }));
  };
  const [clusters, setClusters] = useState<AppearanceGroup[] | null>(null);
  const [refcrops, setRefcrops] = useState<Refcrop[]>([]);
  // #53 (§4.17): most recently selected card — Ctrl-G's fallback target
  // when nothing is hovered — lives in useSelectionState now (lastSelRef)
  // (the merge engine state lives in useMergeFlow, §4.44 round 2 #296)
  // #135/#136 (rule 34) + #260: face drag & drop — the machine is the
  // co-tested `useFaceDrag` hook (below): the payload + drop-target
  // state, the refs that mirror them, and the five grid handlers. A
  // drag must not churn the grid memo while it is in flight, so the
  // handlers read the live values through refs (the #98 identity rule).
  // #135: a face drag dropped on a person row — face-level merge
  // confirmation (the §4.28 person-level dialog moves whole persons)
  // #184 (§4.18): the face menu's 'Add group…' — the dialog over every
  // DISTINCT person of the scope (the tree owns its own instance for
  // person rows)
  const [faceAddGroup, setFaceAddGroup] = useState<{ ids: number[] } | null>(null);
  // #101 (§4.24): grid editing lives in one dialog; #123: Apply extends
  // the pending SET (screen only, nothing commits), Accept commits it all
  const [edit, setEdit] = useState<{
    defaultScope: StageScope;
    card: number[];
    group: number[];
    prefills: Record<StageScope, Prefill>;
  } | null>(null);
  const [pending, setPending] = useState<Stage[]>([]);
  const pendingRef = useRef<Stage[]>([]);
  pendingRef.current = pending;
  // #224 (F-M3): the pending set indexed once per set change — every
  // staged lookup (card labels, section keys, drag sources) becomes a
  // map read instead of a scan of the ops per face. The array stays the
  // engine of the stage/commit model (upsert/drop/commit); the index is
  // its preview.
  const stagedIdx = useMemo(() => indexStagedSet(pending), [pending]);
  const stagedIdxRef = useRef(stagedIdx);
  stagedIdxRef.current = stagedIdx;
  /** #123: a CONTEXT change (person / view / focus) with a live set asks
      drop-or-accept — the stored action runs after the choice. The action is
      wrapped in an object: a bare function passed to a useState setter is
      read as a function-form updater and executed immediately (storing its
      return value) instead of being stored — which silently disabled the
      context-change dialog (#123, found via gui-mock C5) */
  const [contextConfirm, setContextConfirm] = useState<{ fn: () => void } | null>(null);
  // #187: the Q4 dialog's open is set SYNCHRONOUSLY with the click that
  // queues it — unlike the #138 registry count (a passive-effect chain
  // measured at >1 s under load), so BOTH keyboard guards read this
  // render-time ref (the pendingRef pattern) and never act behind the
  // dialog: dropping the set there unmounts it mid-dispatch and its own
  // Esc listener never runs the stored context switch (#123)
  const contextConfirmRef = useRef<{ fn: () => void } | null>(null);
  contextConfirmRef.current = contextConfirm;

  const [error, setError] = useState<string | null>(null);
  // #132 (§4.26): guidance/info — expected no-ops, quiet toast, no Copy,
  // auto-goes-away on the next user action (any click or keystroke)
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // #31: the tree's text filter (declared early — stepIds needs it, #125)
  const [filter, setFilter] = useState<string>(() => sessionInitial.treeFilter);
  // #297 (rule 50): the tree's collapsed set — lifted out of PersonTree so
  // it persists across restarts. The toggle is identity-stable (a plain
  // setter wrapper) so memo(PersonTree) is not churned by a toggle.
  const [treeCollapsed, setTreeCollapsed] = useState<Set<string>>(
    () => new Set(sessionInitial.treeCollapsed)
  );
  const toggleTreeCollapsed = useCallback(
    (updater: SetStateAction<Set<string>>) => setTreeCollapsed(updater),
    []
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  // v12.2 (#279) — the ? help screen (top-bar ghost button beside ⚙)
  const [helpOpen, setHelpOpen] = useState(false);

  // #132: the info toast survives the action that raised it and clears on
  // the NEXT user action — capture phase, so it beats any child handler
  useEffect(() => {
    if (info == null) return;
    const clear = () => setInfo(null);
    window.addEventListener("pointerdown", clear, { capture: true });
    window.addEventListener("keydown", clear, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", clear, { capture: true });
      window.removeEventListener("keydown", clear, { capture: true });
    };
  }, [info]);

  // #282 (N1): the id maps key on the ARRAYS, not the whole snapshot — a
  // person-only delta (group/note/name) rebuilds neither, so the handler
  // chain that reads them through refs (below) keeps its identity and
  // memo(FaceCard) skips untouched cards on those mutations too
  const facesById = useMemo(
    () => new Map((snap?.faces ?? []).map((f) => [f.id, f])),
    [snap?.faces]
  );
  const personsById = useMemo(
    () => new Map((snap?.persons ?? []).map((p) => [p.id, p])),
    [snap?.persons]
  );
  // #282 (N1): the #98 identity rule — handlers that only READ the id
  // maps do so through this ref (the pendingRef pattern), so their
  // identities never churn with a delta and memo(FaceCard) skips every
  // untouched card on a verdict.
  const facesByIdRef = useRef(facesById);
  facesByIdRef.current = facesById;

  // ------------------------------------------------------------ selection

  // #52 (§4.15): the split follows the selection — it closes itself when
  // the selection moves to a different image and stays open while the new
  // selection is on the image it already shows; manual opens always win
  const closeSplitForFaces = useCallback(
    (ids: number[]) => {
      if (splitImageId == null) return;
      if (!ids.some((id) => facesByIdRef.current.get(id)?.image_id === splitImageId))
        setSplitImageId(null);
    },
    [splitImageId]
  );

  // #201 (§4.37) — a crop click in the focus split follows the same
  // plain-anchor rule as the overlay rects (#171): the right pane moves
  // to the clicked face's person; a NULL person_id leaves it as it was
  const followCrop = useCallback(
    (id: number) => {
      if (splitImageId == null) return;
      const f = facesByIdRef.current.get(id);
      if (f && f.person_id != null) setPersonId(f.person_id);
    },
    [splitImageId]
  );

  // §4.44 round 2 stage 2 (#293): the face-selection layer — the sel
  // state + its mirroring refs and the whole ref-driven handler family
  // (useSelectionState.ts, co-tested). Identity per #98: a selection
  // change churns no callback identity; the injected view-context
  // reactions keep the churn they always had. `imgSel` (the §4.23
  // right-pane thumb selection) stays App-owned above — its branch
  // reset lives in the root/branch state block.
  const {
    sel,
    setSel,
    selRef,
    lastSelRef,
    anchorRef,
    changeSel,
    toggle,
    toggleMany,
    rectToggle,
    actionScope,
    selectOnly,
    rangeSelect,
    selPersons,
    setSelPersons,
  } = useSelectionState({
    closeSplitForFaces,
    followCrop,
    setPersonId,
    facesByIdRef,
    sectionsRef,
    sectionsForImageRef,
    splitImageId,
  });
  const selectedPerson = personId != null ? personsById.get(personId) ?? null : null;
  // #99 (§4.10): the status filter — one value drives every view's
  // visibility, tree presence/counts (#28 generalised) and the review set
  const faceFilter = (snap?.settings.face_filter ?? "all") as FaceFilter;
  // #297 (rule 50): the persistence — the ONE restore effect (ids
  // validated against the snapshot; the #176 boot-guard key pre-seeded)
  // and the throttled save of the whole persisted set. Setters only —
  // no callback churn (#98).
  useSessionPersistence({
    snapRef,
    mode,
    personId,
    imageId,
    splitImageId,
    rollRoot,
    rollBranch,
    rollOpen: rollOpenSet,
    rollRecursive,
    importDir,
    treeFilter: filter,
    treeCollapsed,
    mountLimit,
    paneLeft: paneSizes.left,
    paneRight: paneSizes.right,
    setPersonId,
    setImageId,
    setSplitImageId,
    noFacesKeyRef,
    faceFilter,
  });
  const clusterGroup = snap?.settings.cluster_group ?? "accuracy";
  const clusterThreshold = snap?.settings.cluster_threshold ?? 0.4;
  // #215: a stable identity — the memo(pane) handlers below carry it
  const faceVisible = useCallback(
    (f: Face) => matchesStatusFilter(f.link_status, faceFilter),
    [faceFilter]
  );
  // #127/#128 → #152, #165 (§4.10): the face-status filter decides the
  // tree's person presence — All now means everything EXCEPT rejected:
  // persons holding ≥ 1 non-rejected face stay (plus the faceless
  // shells, #127/#128), the reject-bin persons `RejectedN` never show
  // outside Show → Rejected (§4.35/#266); New/Accepted/Rejected list
  // only persons holding ≥ 1 face of that status; the listed badges
  // stay raw totals (#129's badge rule — unchanged, only presence moved)
  const treePersons = useMemo(
    () => (snap ? personTreeMembers(snap.persons, snap.faces, faceFilter) : []),
    [snap, faceFilter],
  );
  // #152: the selection survives its person dropping out of the tree —
  // the detail pane keeps working off the unfiltered snapshot (the person
  // view shows no faces for them under the filter)
  const displayPerson = useMemo(
    () => (personId != null ? personsById.get(personId) ?? null : null),
    [personsById, personId]
  );
  // #122: person id -> primary face's stored crop rotation (tree avatars)
  const primaryRot = useMemo(() => {
    const m = new Map<number, number>();
    if (!snap) return m;
    const rot = new Map(snap.faces.map((f) => [f.id, f.rotation]));
    for (const p of snap.persons)
      if (p.primary_face_id != null) m.set(p.id, rot.get(p.primary_face_id) ?? 0);
    return m;
  }, [snap]);
  // #31 — the review step list: the persons in the tree's current
  // (filtered) display order; declared early — #125's exhaust check and
  // doAccept/doReject need the index before their point of use.
  // #223 (F-M1): the tree is built once per treePersons change (shared
  // with the pane) and the step walk runs over it; the filter is
  // deferred so a keystroke does not re-walk synchronously (the pane
  // defers its own copy the same way, #215)
  const tree = useMemo(() => buildTree(treePersons), [treePersons]);
  const deferredStepFilter = useDeferredValue(filter);
  const stepIds = useMemo(
    () => orderedVisiblePersonIdsFromTree(tree, treePersons, deferredStepFilter),
    [tree, treePersons, deferredStepFilter]
  );
  // #283 (N6): the step index of the anchor — one O(n) scan per
  // [stepIds, personId] change, not per render (the old inline indexOf
  // ran on every App render)
  const stepIdx = useMemo(
    () => (personId != null ? stepIds.indexOf(personId) : -1),
    [stepIds, personId]
  );

  // #213: one person-data signature per snapshot — the cluster and
  // refcrop effects below key on IT instead of the snapshot identity, so
  // a verdict on an unrelated person (or any unrelated mutation) no
  // longer re-fetches the anchored person's refcrop images or recomputes
  // their clusters. `refcropEpoch` covers what the snapshot cannot see:
  // pin changes (add/remove_refcrop write person_refcrops only).
  const [refcropEpoch, setRefcropEpoch] = useState(0);
  const personSig = useMemo(
    () => personDataSig(displayPerson, snap?.faces ?? [], snap?.settings ?? null),
    [displayPerson, snap]
  );

  // similarity clusters for the person view (Accuracy mode only —
  // Description mode needs no IPC at all, #99). #213: recomputed only
  // when this person's clustering inputs move (the #211 backend cache
  // catches the repeated reads)
  useEffect(() => {
    let live = true;                  // #246: the fetch dies with the deps
    if (
      mode === "person" &&
      personId != null &&
      personSig &&
      clusterGroup === "accuracy"
    ) {
      // #234 (rule 45): a prefetched advance target — consume it only
      // when the person's data is unchanged since the prefetch
      const hit = prefetchRef.current.getClusters(
        personId,
        clusterThreshold,
        personSig
      );
      if (hit) {
        setClusters(hit);
        return;
      }
      api
        .personFaceClusters(personId, clusterThreshold)
        .then((groups) => {
          if (live) setClusters(groups);   // #246: stale fetches never land
        })
        .catch((e) => {
          if (live) setError(String(e));
        });
    } else {
      setClusters(null);
    }
    return () => {      // #246: a person switch / view change revokes any
      live = false;     // in-flight fetch — person A's clusters can never
    };                  // render in person B's view
  }, [mode, personId, personSig, clusterGroup, clusterThreshold]);

  // refcrops for the detail pane. #213: keyed on the person-data
  // signature + the pin epoch (pin changes are invisible to the
  // snapshot, so doRefcrop/paneRemoveRefcrop bump the epoch)
  useEffect(() => {
    let live = true;                  // #246: the fetch dies with the deps
    if (personId == null || !personSig) {
      setRefcrops([]);
      return;
    }
    // #234 (rule 45): a prefetched advance target (see the cluster
    // effect) — the §213 signature guards against a changed person
    const hit = prefetchRef.current.getRefcrops(personId, personSig);
    if (hit) {
      setRefcrops(hit);
      return;
    }
    api
      .getRefcrops(personId)
      .then((crops) => {
        if (live) setRefcrops(crops); // #246: stale fetches never land
      })
      .catch((e) => {
        // #246: errors surface like every other fetch — an emptied strip
        // that pretends "no refcrops" hides a broken fetch
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [personId, personSig, refcropEpoch]);

  // #25 — Esc closes the double-click image split
  // #138: which overlays are open is ONE registry count, not a list of
  // states — the ladder state list has drifted before (face-merge, tree
  // menus, group dialog were invisible to it)
  // #258: the Esc stack + the global keydown dispatcher live in the
  // useAppKeys hook (src/appKeys.ts) — they run below, where every
  // input they take is in scope
  const overlayCount = useOverlayCount();

  // #133: resolves to whether the operation AND the refresh succeeded —
  // callers may act only on success (errors are still surfaced as the
  // error toast, never thrown)
  // #219: a mutating command returns a `Delta` — apply it locally
  // instead of a full re-fetch (a `void` result, e.g. set_settings, and
  // a drifted delta fall back to the full refresh).
  const mutate = useCallback(
    async (fn: () => Promise<unknown>, clearSel = false): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const result = await fn();
        const deltas = (Array.isArray(result) ? result : [result]).filter(isDelta);
        if (deltas.length > 0) {
          // #281: in plan order against the live stamp — a drifted or
          // base-stale delta (external write before/mid-command) falls
          // back to one full refresh, the rest of the plan with it
          await applyDeltas(deltas);
        } else {
          await refresh(); // non-delta command (settings) / void result
        }
        if (clearSel) setSel(new Set());
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh, applyDeltas]
  );

  // #122: rotations are server state — command, then refresh
  const rotateImg = useCallback(
    (imageId: number, delta: number) => mutate(() => api.rotateImage(imageId, delta)),
    [mutate]
  );
  // #174 (§4.39): rotate a whole thumbnail scope — one batched command
  // (#209), one refresh
  const rotateImages = useCallback(
    (ids: number[], delta: number) => mutate(() => api.rotateImages(ids, delta)),
    [mutate]
  );
  const rotateFace = useCallback(
    (faceId: number, delta: number) => mutate(() => api.rotateFace(faceId, delta)),
    [mutate]
  );

  // #123: a selection change INSIDE the context never asks — the
  // Apply → change → Apply loop is dialog-free by design. (`changeSel`
  // itself is useSelectionState's, #293.)

  // #123: only a complete context change (another person, a view switch,
  // focus open/close) asks drop-or-accept while the set is live — the
  // stored action runs after the choice, on BOTH branches
  const confirmContext = useCallback((action: () => void) => {
    if (pendingRef.current.length > 0) setContextConfirm({ fn: action });
    else action();
  }, []);
  // #187: the set can empty through a path that bypasses the dialog's
  // own handlers (an Enter-commit behind it inside the stale-count
  // window, a filter drop) — the dialog unmounts on
  // `pending.length === 0`, so drop the guard signal with it or the
  // keyboard stays owned by a dialog that is no longer there
  useEffect(() => {
    if (contextConfirm != null && pending.length === 0) setContextConfirm(null);
  }, [contextConfirm, pending]);

  // ------------------------------------------------------------ mutations

  const doAssign = useCallback(
    (ids: number[], name: string, group: string) =>
      mutate(() => api.assignPerson(ids, name, group), true),
    [mutate]
  );
  // #184 (§4.18/#164 semantics): ADD a membership — from='' deletes
  // nothing, INSERT OR IGNORE files them, every current group is kept —
  // shared by the tree's person rows and the face menu's entry
  const addPersonsToGroup = useCallback(
    (ids: number[], path: string) =>
      void mutate(() => api.movePersonsBetweenGroups(ids, "", path)),
    [mutate]
  );
  // #125: a verdict that might empty the current person in Review marks
  // the step index pre-mutation; the refreshed-snapshot effect below
  // consumes it and steps past (exactly what “›” does)
  // #148: the mark also remembers the person it was set for and is
  // consumed unconditionally — a mark that lingers (e.g. the refresh
  // lands after the user left Review) must never fire much later against
  // whatever person the selection holds then
  const exhaustAtRef = useRef(-1);
  const exhaustPidRef = useRef<number | null>(null);
  // #234 (rule 45) — optimistic verdicts: the flip, the in-flight
  // bookkeeping and the advance-target prefetch all live in one stable
  // callback, so the #98/#222 identity chain
  // markExhaust → doAccept/doReject → faceMenu → gridHandlers stays
  // put. Every render-value it needs is read via a latest-value ref
  // (the pendingRef pattern).
  const [inFlight, setInFlight] = useState<Set<number>>(INFLIGHT_EMPTY);
  const inFlightRef = useRef(inFlight);
  inFlightRef.current = inFlight;
  // (snapRef is useSnapshotSync's mirror — #294)
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const personIdRef = useRef(personId);
  personIdRef.current = personId;
  const faceFilterRef = useRef(faceFilter);
  faceFilterRef.current = faceFilter;
  const stepIdsRef = useRef(stepIds);
  stepIdsRef.current = stepIds;
  const stepIdxRef = useRef(stepIdx);
  stepIdxRef.current = stepIdx;
  const clusterGroupRef = useRef(clusterGroup);
  clusterGroupRef.current = clusterGroup;
  const clusterThresholdRef = useRef(clusterThreshold);
  clusterThresholdRef.current = clusterThreshold;
  const personsByIdRef = useRef(personsById);
  personsByIdRef.current = personsById;
  // #234: prefetched advance-target data — consumed by the cluster/
  // refcrop effects only when the target's §213 signature is unchanged;
  // #257: bounded + typed (an LruCache of a discriminated union — the
  // `as` casts are gone)
  const prefetchRef = useRef(new PrefetchCache());
  const prefetchTarget = useCallback((target: number) => {
    const s = snapRef.current;
    if (!s) return;
    const sig = personDataSig(
      personsByIdRef.current.get(target) ?? null,
      s.faces,
      s.settings ?? null
    );
    if (sig == null) return;
    if (clusterGroupRef.current === "accuracy") {
      const threshold = clusterThresholdRef.current;
      api
        .personFaceClusters(target, threshold)
        .then((clusters) => {
          prefetchRef.current.setClusters(target, threshold, sig, clusters);
        })
        .catch(() => {}); // best-effort — the normal fetch covers a miss
    }
    api
      .getRefcrops(target)
      .then((refcrops) => {
        prefetchRef.current.setRefcrops(target, sig, refcrops);
      })
      .catch(() => {});
  }, []);
  const verdictMutate = useCallback(
    (
      fn: () => Promise<unknown>,
      ids: number[],
      to: Verdict,
      clearSel = false
    ): Promise<boolean> => {
      const s = snapRef.current;
      let prior: Map<number, Face> | null = null;
      if (s) {
        const r = flipLinkStatus(s, ids, to);
        if (r.next !== s) {
          prior = r.prior;
          setSnap(r.next); // the cards respond BEFORE the IPC begins
        }
        const pid = personIdRef.current;
        if (modeRef.current === "review" && pid != null) {
          const target = verdictAdvanceTarget(
            s,
            stepIdsRef.current,
            pid,
            stepIdxRef.current,
            ids,
            to,
            faceFilterRef.current
          );
          if (target != null) prefetchTarget(target);
        }
      }
      const flight = new Set(inFlightRef.current);
      for (const id of ids) flight.add(id);
      inFlightRef.current = flight;
      setInFlight(flight);
      return mutate(fn, clearSel).then((ok) => {
        if (inFlightRef.current.size > 0) {
          const rest = new Set(inFlightRef.current);
          for (const id of ids) rest.delete(id);
          inFlightRef.current = rest.size > 0 ? rest : INFLIGHT_EMPTY;
          setInFlight(inFlightRef.current);
        }
        if (!ok) {
          // roll the flip back and clear THIS verdict's exhaust mark
          // (#148 — it used to be cleared in the focus callback, which
          // never ran on failure)
          if (prior && prior.size > 0)
            setSnap((cur) => (cur ? restoreLinkStatus(cur, prior) : cur));
          exhaustAtRef.current = -1;
          exhaustPidRef.current = null;
        }
        return ok;
      });
    },
    [mutate, prefetchTarget, setInFlight, setSnap]
  );
  // §4.44 + #222 (F-H3): the verdict callbacks live in reviewVerdicts.ts
  // (hook module, co-tested) — the #98 identity rule is preserved there:
  // the person anchor is read via refs, so markExhaust → doAccept/
  // doReject → faceMenu → gridHandlers stay identity-stable across a
  // person advance / tree select and memo(FaceCard) skips untouched
  // cards on every verdict
  const { markExhaust, focusActed, focusActedUnlessNoop, doAccept, doReject } =
    useReviewVerdicts({
      mode,
      personId,
      stepIdx,
      facesById,
      verdictMutate,
      setInfo,
      setPending,
      setPersonId,
      lastSelRef,
      hoverRef,
      exhaustAtRef,
      exhaustPidRef,
    });
  // #58 (§4.14): per-card inputs honour the same scope — editing the
  // description of a card inside a multi-selection updates the whole
  // selection; applied sequentially because each call re-assigns seq
  // within its new (person, description) group (§4.4) and concurrent
  // transactions could compute the same next seq
  // #282 (N1): both read facesById through the ref — the identities
  // never churn with a delta (they feed the gridHandlers memo)
  const doPrimary = useCallback(
    (id: number) => {
      const f = facesByIdRef.current.get(id);
      if (f && f.person_id != null) mutate(() => api.setPrimaryFace(f.person_id!, id));
    },
    [mutate]
  );
  const doRefcrop = useCallback(
    (id: number) => {
      const f = facesByIdRef.current.get(id);
      if (f && f.person_id != null)
        // #213: pin changes are invisible to the snapshot signature —
        // bump the epoch so the strip refetches
        void mutate(() => api.addRefcrop(f.person_id!, id)).then((ok) => {
          if (ok) setRefcropEpoch((n) => n + 1);
        });
    },
    [mutate]
  );

  // #35 — tree selection: click selects, ctrl/cmd toggles, shift extends
  // over the tree's visible order; the anchor row stays the person shown.
  // #62 — a tree select shifts the attention to that person, so the full
  // image closes whether the person appears in it or not (§4.15); #52's
  // person-relevance check is gone on purpose
  // #215: stable identity (the memo(PersonTree) rule) — changes only
  // with the context it actually reads, never per selection toggle
  const handleTreeSelect = useCallback((id: number, e?: ReactMouseEvent) => {
    // #123: a tree select shifts attention to another person — with a
    // live pending set that is a context change (drop-or-accept)
    confirmContext(() => {
      if (splitImageId != null) setSplitImageId(null);
      if (e?.ctrlKey || e?.metaKey) {
        setSelPersons((prev) => {
          const n = new Set(prev);
          if (n.has(id)) n.delete(id);
          else n.add(id);
          return n;
        });
        setPersonId(id); // anchor follows the click; view unchanged
      } else if (e?.shiftKey && personId != null) {
        const a = stepIds.indexOf(personId);
        const b = stepIds.indexOf(id);
        if (a === -1 || b === -1) return;
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelPersons(new Set(stepIds.slice(lo, hi + 1)));
        setPersonId(id);
      } else {
        setSelPersons(new Set([id]));
        setPersonId(id);
        if (mode === "review") {
          // #200 reopened (gui-design v3.93, §4.40): Review is sticky —
          // a tree select re-anchors the review instead of yanking into
          // Person mode: the clicked person becomes the review focus
          // (the step index points at them; the split already closed
          // above — the attention shifted) and the grid scrolls to
          // their section (the re-anchor layout effect — declared after
          // the scroll-restore, so the section wins when the full image
          // just closed), so the toolbar index and the visible place
          // never disagree; stepping and verdicts then continue from
          // there. The Rolls/Person tab clicks remain the only exit.
          setReanchor({ pid: id });
        } else {
          setMode("person");
        }
        setImageId(null);
      }
    });
  }, [confirmContext, splitImageId, stepIds, personId, mode]);
  const doRemovePersons = useCallback((ids: number[]) => {
    if (ids.length > 0) setConfirmRemove(ids);
  }, []);

  // renameGroup — the #153/#178/#165 rule now lives in
  // groupList.renameGroupFor (§4.44: pure, co-tested; imported above as
  // `renameGroup`, so every call site keeps its meaning)

  // rename-merge (v1.9/v1.11): EVERY GUI rename (tree, context menu,
  // detail pane) routes through assign over all the person's faces — a
  // colliding name merges; the 'person already exists' error is
  // unreachable from the GUI. Returns the SURVIVING person's id — the
  // merge target when the name was taken — or null on failure, so the
  // pane can re-anchor on who the faces now belong to (#172/§4.38)
  const renameMerge = useCallback(
    async (id: number, n: string): Promise<number | null> => {
      if (!snap) return null;
      const name = n.trim();
      const p = personsById.get(id);
      if (!name || name === p?.name) return id; // empty / no-op: never an error
      const taken = snap.persons.find((x) => x.id !== id && x.name === name);
      const ids = snap.faces.filter((f) => f.person_id === id).map((f) => f.id);
      if (ids.length === 0) {
        // faceless person: rename, or merge-by-deletion when the name is taken
        const ok = taken
          ? await mutate(() => api.removePersons([id]), false)
          : await mutate(() => api.setPersonName(id, name), false);
        return ok ? (taken?.id ?? id) : null;
      }
      const ok = await doAssign(ids, name, renameGroup(p));
      return ok ? (taken?.id ?? id) : null;
    },
    [snap, personsById, mutate, doAssign]
  );
  const renameOrMerge = useCallback(
    (id: number, n: string) => {
      // §4.38/#172: a rename-merge re-anchors the pane on the surviving
      // person (the merge target) — the origin shell is deleted
      void renameMerge(id, n).then((t) => t != null && setPersonId(t));
    },
    [renameMerge]
  );

  // #215: the remaining stable pane handlers (the memo(pane) identity
  // rule — see gridHandlers below)
  const renameGroupCmd = useCallback(
    (oldPath: string, newPath: string) => mutate(() => api.renameGroup(oldPath, newPath)),
    [mutate]
  );
  const deleteGroupCmd = useCallback(
    (path: string) => mutate(() => api.deleteGroup(path)),
    [mutate]
  );
  const movePersonsCmd = useCallback(
    (ids: number[], path: string, src?: string) => {
      // #157 (v3.59): a tree D&D drop carries the dragged placement's
      // branch path — re-home THAT membership (remove the dragged-from
      // row when the person has it, file into the target; other
      // memberships kept). Same branch → no-op: the person already
      // renders under the target. Without src (dialog paths) the §4.16
      // replace-all keeps its meaning.
      if (src != null) {
        if (src === path) return;
        void mutate(() => api.movePersonsBetweenGroups(ids, src, path));
        return;
      }
      void mutate(() => api.movePersonsToGroup(ids, path));
    },
    [mutate]
  );
  // (openMergeDialog/openMergeSimilar/closeMergeDialog are useMergeFlow's
  // — §4.44 round 2 #296; the setters keep the #215/#98 identity rule)
  const selectPendingFaces = useCallback(
    (id: number) => {
      if (!snap) return;
      const ids = snap.faces
        .filter((f) => f.person_id === id && f.link_status === "provisional")
        .map((f) => f.id);
      toggleMany(ids, true);
    },
    [snap, toggleMany]
  );
  const paneNote = useCallback(
    (id: number, n: string) => mutate(() => api.setPersonNote(id, n)),
    [mutate]
  );
  const paneRemovePerson = useCallback(
    (id: number) => doRemovePersons([id]),
    [doRemovePersons]
  );
  const paneOpenPrimary = useCallback(
    (fid: number) => {
      const f = facesById.get(fid);
      if (f) confirmContext(() => setSplitImageId(f.image_id));
    },
    [facesById, confirmContext]
  );
  // v14.0 (#288): the pane's reference-image (refcrop) routes — the
  // centre grid's own handlers, addressed by face (the refcrop row
  // carries only the face_id; the image derives from it)
  const paneOpenRefcropImage = useCallback(
    (faceId: number) => {
      const f = facesById.get(faceId);
      if (f) confirmContext(() => setSplitImageId(f.image_id));
    },
    [facesById, confirmContext]
  );
  const paneRemoveRefcrop = useCallback(
    (fid: number) => {
      if (personId == null) return;
      // #213: pin changes are invisible to the snapshot signature
      void mutate(() => api.removeRefcrop(personId, fid)).then((ok) => {
        if (ok) setRefcropEpoch((n) => n + 1);
      });
    },
    [personId, mutate]
  );

  // #172/#173 (§4.38) — the person pane's Update person commit: the
  // pending name FIRST (the rename-merge helper, which may re-anchor),
  // then the pending note, then the staged group ops IN ORDER against
  // the surviving person; a failed name/note commit aborts the ops so
  // they can never land on a person the merge just deleted
  const updatePerson = useCallback(
    (id: number, name: string, note: string, ops: GroupOp[]): Promise<boolean> =>
      (async () => {
        const target = await renameMerge(id, name);
        if (target == null) return false;
        // #209: the note and the list edits land in ONE mutate (one
        // refresh per user action); a failure still aborts what follows
        // (a failed name/note never lets the ops land on a person the
        // merge just deleted)
        const noteChanged =
          note.trim() !== (personsById.get(id)?.note ?? "").trim();
        if (noteChanged || ops.length > 0) {
          const ok = await mutate(async () => {
            const ds: Delta[] = [];
            if (noteChanged) ds.push(await api.setPersonNote(id, note));
            for (const op of ops)
              ds.push(await api.movePersonsBetweenGroups([target], op.from, op.to));
            return ds;
          });
          if (!ok) return false;
        }
        setPersonId(target);
        return true;
      })(),
    [renameMerge, personsById, mutate]
  );

  // #23/#99 — change the status filter; faces the new filter hides leave
  // the selection so they can never be bulk-acted on invisibly (§4.10)
  // v14.0 (#288): identity-stable (the #98 rule) — the pane's refcrop
  // *Select in grid* calls it to surface a face the Show filter hides
  const changeFaceFilter = useCallback((next: FaceFilter) => {
    if (!snap || next === snap.settings.face_filter) return;
    const visible = new Set(
      snap.faces
        .filter((f) => matchesStatusFilter(f.link_status, next))
        .map((f) => f.id)
    );
    const kept = [...selRef.current].filter((id) => visible.has(id));
    if (kept.length !== selRef.current.size) changeSel(new Set(kept));
    // #141 (F2): pending ops on now-hidden faces are invisible to the
    // user yet still committed by the next Accept, with the staged strip
    // counting faces that no longer display anywhere — drop them
    setPending((p) => dropStagesForFaces(p, [...selRef.current].filter((id) => !visible.has(id))));
    mutate(() => api.setSettings({ ...snap.settings, face_filter: next }));
  }, [snap, mutate]);
  // v14.0 (#288) — *Select in grid* (also the refcrop row's
  // double-click): single-select (a card click), the Show filter first
  // switches to one that shows the face (a refcrop is a confirmed face
  // — "confirmed" is the narrowest such filter), then the lazy grid
  // grows-then-scrolls it into view (the focusFace reveal below);
  // defined after changeFaceFilter (its dep array reads it eagerly —
  // a TDZ hazard if hoisted above)
  const paneSelectRefcrop = useCallback(
    (faceId: number) => {
      const snap = snapRef.current;
      const f = snap?.faces.find((x) => x.id === faceId);
      if (!snap || !f) return; // stale row — no grid target
      const filter = (snap.settings.face_filter ?? "all") as FaceFilter;
      if (!matchesStatusFilter(f.link_status, filter)) {
        changeFaceFilter(f.link_status === "confirmed" ? "confirmed" : "all");
      }
      changeSel(new Set([faceId]));
      setFocusFace(faceId);
    },
    [changeFaceFilter, changeSel]
  );
  // #188 (§4.40) — the lock IS the mode: entering Review (any route,
  // incl. the initial load) pins Show → New through the ordinary filter
  // path; once per entry (pinnedRef) so later changes stick — the user
  // is locked out by the disabled select, while a test harness may
  // still dispatch changes
  const pinnedRef = useRef(false);
  useEffect(() => {
    if (mode !== "review") {
      pinnedRef.current = false;
      return;
    }
    if (pinnedRef.current || !snap) return;
    pinnedRef.current = true;
    changeFaceFilter("provisional");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, snap]);
  // #203 + reopened (gui-design v3.93, §4.40) + #264: the centre GRID
  // keeps its scroll place in EVERY mode — the place is saved while the
  // grid is on screen (the hook's gate: not while the full image is
  // open, whose container scroll is the focus view's own) and restored
  // whenever the grid RETURNS — a mode switch or the full image closing
  // — so the toolbar index and the visible place never disagree
  // #297 (rule 50): the `mode` also persists the place across restarts.
  // The key carries the loading state: on a boot restore the grid
  // mounts EMPTY (the snapshot has not landed) and a place beyond the
  // empty range clamps to 0 — re-keying when the content arrives
  // re-applies the restored place (the in-session §4.40 path is
  // unaffected: the key then changes only with the mode).
  const centerScroll = useScrollPlace(
    mode + (snap ? "" : "-loading"),
    splitImageId == null,
    mode,
  );
  // #200 reopened (gui-design v3.93, §4.40): the tree re-anchor scroll —
  // layout effect (post-commit, pre-paint, no frame dependency); the
  // optional chain: a tree person without a review section (no face
  // under the review status) re-anchors without a scroll target.
  // #214: grown into the mounted prefix first (the effect re-runs on the
  // growth), then scrolled — one-shot, cleared after the attempt
  useLayoutEffect(() => {
    if (reanchor == null || mode !== "review") return;
    const key = `rev-${reanchor.pid}`;
    const idx = sectionsRef.current.findIndex((s) => s.key === key);
    if (idx >= 0 && idx >= mountLimit) {
      setMountLimit(mountLimitFor(sectionsRef.current.length, idx, mountLimit));
      return;
    }
    setReanchor(null);
    document
      .querySelector(`.face-section[data-section-key="${key}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [reanchor, mode, mountLimit]);
  // #214: the accept-&-next reveal (§4.30) — the same grow-then-scroll
  // pattern as the re-anchor above; one-shot
  useLayoutEffect(() => {
    if (revealFace == null) return;
    const idx = sectionsRef.current.findIndex((s) => s.faceIds.includes(revealFace));
    if (idx < 0) {
      setRevealFace(null); // gone — nothing to reveal
      return;
    }
    if (idx >= mountLimit) {
      setMountLimit(mountLimitFor(sectionsRef.current.length, idx, mountLimit));
      return;
    }
    document
      .querySelector(`[data-face-id="${revealFace}"]`)
      ?.scrollIntoView({ block: "nearest" });
    setRevealFace(null);
  }, [revealFace, mountLimit]);
  // v14.0 (#288): the refcrop *Select in grid* scroll — the same
  // grow-then-scroll as above, but it WAITS while the face is absent
  // (the Show-filter switch refetches the grid a beat later) and drops
  // itself once the focused person no longer holds the face
  useLayoutEffect(() => {
    if (focusFace == null) return;
    const idx = sectionsRef.current.findIndex((s) => s.faceIds.includes(focusFace));
    if (idx < 0) {
      if (
        personId != null &&
        !snapRef.current?.faces.some(
          (f) => f.id === focusFace && f.person_id === personId
        )
      ) {
        setFocusFace(null);
      }
      return;
    }
    if (idx >= mountLimit) {
      setMountLimit(mountLimitFor(sectionsRef.current.length, idx, mountLimit));
      return;
    }
    document
      .querySelector(`[data-face-id="${focusFace}"]`)
      ?.scrollIntoView({ block: "nearest" });
    setFocusFace(null);
  }, [focusFace, mountLimit, personId, snap]);
  // #188/§4.40 — the position guard, on ENTRY only (a mode transition;
  // the mount has no anchor): an anchored person without a new face
  // advances to the next person in the step list that has one (forward,
  // else the first; none ⇒ stay + toast)
  useEffect(() => {
    if (mode !== "review" || personId == null || !snap) return;
    const has = (id: number) =>
      snap.faces.some((f) => f.person_id === id && f.link_status === "provisional");
    if (has(personId)) return;
    const nextId = exhaustAdvanceTarget(stepIds, personId, stepIdx, has);
    if (nextId != null) setPersonId(nextId);
    else setInfo("no more persons to review");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  // #99 (§4.9): persons-view cluster grouping — accuracy (default) or one
  // section per description; display-only, the selection is untouched
  const setClusterGroup = (next: ClusterGroup) => {
    if (!snap || next === snap.settings.cluster_group) return;
    mutate(() => api.setSettings({ ...snap.settings, cluster_group: next }));
  };

  // #32 — tile context menus; full images keep the default webview menu (#33)
  const openMenu = useCallback((e: ReactMouseEvent, groups: MenuGroup[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, groups });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  // #101 (§4.24): the dialog engine — openEdit reads the sections via
  // the latest-value ref (it only fires on events), so the memoised
  // grid handlers and faceMenu can share it without ordering traps
  // #282 (N1): the maps are read through refs (identity-stable for the
  // memoised grid handlers / faceMenu below — see facesByIdRef)
  const prefillFor = useCallback(
    (ids: number[]): Prefill =>
      // #199 (§4.24): the prefill is what the card SHOWS — the staged
      // overlay (later ops win) over the committed value
      prefillForFaces(
        ids,
        (id) => {
          const f = facesByIdRef.current.get(id);
          const p = f?.person_id != null ? personsByIdRef.current.get(f.person_id) : undefined;
          // #165/§4.35/#266: the reject-bin persons' reserved name/seat
          // never prefills — a claim needs a typed name (untouched = no
          // stage). #233 (§4.35 display rule): a status seat never
          // prefills either — the group prefill is the person's first
          // REAL group
          const system = p != null && isRejectedBin(p.name);
          return {
            name: system ? "" : p?.name ?? "",
            group: system ? "" : firstRealGroup(p?.groups ?? []),
            desc: f?.description ?? "",
          };
        },
        pendingRef.current,
      ),
    []
  );

  /** Q1/G3 + invocation-site defaults (§4.24): Edit on a card →
      Selection when it sits inside a multi-face selection, else Card
      (#230); header → Group; bottom bar → Selection */
  const openEdit = useCallback(
    (
      defaultScope: StageScope,
      target?: { card?: number; group?: number[] },
      selectionOverride?: number[]
    ) => {
      if (!snapRef.current) return;
      const card = target?.card != null ? [target.card] : [];
      const group =
        target?.group ??
        (target?.card != null
          ? sectionsRef.current.find((s) => s.faceIds.includes(target.card!))?.faceIds ?? []
          : []);
      const objIds = target?.group ?? card;
      const reselect =
        objIds.length > 0 && !objectInsideSelection(objIds, selRef.current);
      // selection rules: inside keeps the selection, outside becomes the object
      if (reselect) changeSel(new Set(objIds));
      const selIds = selectionOverride ?? (reselect ? objIds : [...selRef.current]);
      // #147: never open the shared dialog without a concrete target —
      // every scope would read "0 face(s)" and all its actions be no-ops
      if (selIds.length === 0) return;
      setEdit({
        defaultScope,
        card,
        group,
        prefills: {
          card: prefillFor(card),
          group: prefillFor(group),
          selection: prefillFor(selIds),
        },
      });
    },
    [changeSel, prefillFor]
  );

  // #282 (N1): the map read goes through the ref so the identity never
  // churns with a delta (faceMenu feeds the gridHandlers memo — a churn
  // re-renders every mounted section and its cards)
  const faceMenu = useCallback((id: number, e: ReactMouseEvent) => {
    const f = facesByIdRef.current.get(id);
    if (!f) return;
    // #75 (cursor-as-target, generalises #74): with an empty selection
    // the right-clicked card selects automatically — the menu then
    // visibly acts on it and the rule bar / A-R / Ctrl-G all agree
    if (selRef.current.size === 0) {
      anchorRef.current = id;
      lastSelRef.current = id;
      changeSel(new Set([id]));
    }
    // §4.44 stage 4: the composition is the pure faceMenuGroups; this
    // wrapper feeds it the live values (refs — the #98 identity rule)
    openMenu(e, faceMenuGroups({
      id,
      face: f,
      sel: selRef.current,
      actionScope,
      section: sectionsRef.current.find((s) => s.faceIds.includes(id)) ?? null,
      facesById: facesByIdRef.current,
      toggle,
      toggleMany,
      doAccept,
      doReject,
      doPrimary,
      doRefcrop,
      rotateFace,
      changeSel,
      openEdit,
      openFullImage: (face) =>
        confirmContext(() => {
          setSplitImageId(face.image_id);
          if (face.person_id != null) setPersonId(face.person_id);
        }),
      addFaceGroup: (ids) => setFaceAddGroup({ ids }),
      splitImageId,
    }));
  }, [actionScope, toggle, toggleMany, doAccept, doReject,
      doPrimary, doRefcrop, splitImageId, openMenu, openEdit, changeSel,
      confirmContext, rotateFace]);

  // #174 (§4.39): the selected branch's images for the right pane —
  // DIRECT children only (the directory of primary_path equals the
  // branch — never the recursion), Show-listed (§4.10, shared helper),
  // filename order; `deeper` drives the drill hint
  const branchThumbs = useMemo(() => {
    const dirOf = (p: string) => {
      const i = p.lastIndexOf("/");
      return i <= 0 ? "/" : p.slice(0, i);
    };
    if (!snap) return { images: [] as ImageRow[], deeper: false };
    const listed = listedImages(snap.images, snap.faces, faceFilter);
    const under = rollBranch === "/" ? "/" : `${rollBranch}/`;
    // v12.4 (#280)/§4.39: the branch's recursive toggle — ticked lists
    // every descendant image, not just the ones filed *at* the branch
    const recursive = rollRecursive.has(rollBranch);
    const inBranch = recursive
      ? snap.images.filter((x) => x.primary_path.startsWith(under))
      : snap.images.filter((x) => dirOf(x.primary_path) === rollBranch);
    const deeper = snap.images.some(
      (x) =>
        listed.has(x.id) &&
        dirOf(x.primary_path) !== rollBranch &&
        x.primary_path.startsWith(under)
    );
    return {
      images: inBranch.filter((x) => listed.has(x.id)).sort((a, b) => byFilename(a, b)),
      deeper,
    };
  }, [snap, rollBranch, faceFilter, rollRecursive]);
  // thumb clicks — §4.23's anchor pattern over the branch's display
  // order (face selection untouched); the pane drops stale ids itself
  const thumbClick = useCallback(
    (id: number, mods: { ctrl: boolean; shift: boolean }) =>
      setImgSel((s) => clickImage(s, branchThumbs.images.map((x) => x.id), id, mods)),
    [branchThumbs]
  );
  // #269 (§4.37 On entry): a faceless Rolls image open re-anchors the
  // right pane on the open image's first visible face crop (spatial
  // reading order); null (no crop / NULL person) leaves the current
  // anchor untouched. Reads snap + face filter through refs so the
  // callback identity never churns (the #228 F-L4 rule).
  const anchorFirstCrop = useCallback((id: number) => {
    const pid = firstCropPerson(snapRef.current, id, faceFilterRef.current);
    if (pid != null) setPersonId(pid);
  }, []);
  // the thumbnail double-click / path-filter file entry: the #142 view-
  // context change behind the #123 drop-or-accept dialog
  const openThumb = useCallback(
    (id: number) =>
      confirmContext(() => {
        setMode("rolls");
        setImageId(id);
        anchorFirstCrop(id); // #269 (§4.37): the right pane follows the first crop
      }),
    [confirmContext, anchorFirstCrop]
  );
  // #235 (rule 46) — film-roll image stepping: ‹/› walk the selected
  // branch's listed images — the right pane's own thumbnails, list and
  // order (imageStepTarget). A step is a view-context change (the #123
  // confirm, like openThumb) and explicit navigation ends focus mode
  // (§4.15); the new image opens at the top of the centre scroll.
  // Off-list open image / list end → null: the buttons are disabled.
  const stepImage = useCallback(
    (dir: 1 | -1) => {
      const id = imageStepTarget(
        branchThumbs.images.map((x) => x.id),
        imageId,
        dir,
      );
      if (id == null) return;
      confirmContext(() => {
        if (splitImageId != null) setSplitImageId(null);
        setImageId(id);
        centerScroll.ref.current?.scrollTo({ top: 0 });
      });
    },
    [branchThumbs, imageId, splitImageId, confirmContext, centerScroll.ref],
  );

  // #274 — full image → Rolls mode with the path tree opened and
  // selected at the image's own branch (the dir-of-primary_path rule,
  // §4.22): the end state of clicking *Rolls* and expanding the tree
  // down to that branch. A root that would exclude the branch falls
  // back to the whole tree; every ancestor of the branch (relative
  // segment paths — the openSet keys) joins the open set, so the tree
  // is fully expanded at the target. Explicit navigation ends focus
  // (§4.15): the #123 dialog guards the context change.
  const openRollBranch = useCallback(
    (id: number) =>
      confirmContext(() => {
        const img = snapRef.current?.images.find((i) => i.id === id);
        if (!img) return;
        const k = img.primary_path.lastIndexOf("/");
        const branch = k <= 0 ? "/" : img.primary_path.slice(0, k);
        const root = rollRootRef.current;
        const effRoot =
          root === "/" || branch.startsWith(`${root}/`) ? root : "/";
        if (effRoot !== root) changeRollRoot(effRoot);
        if (branch !== "/") {
          const rel =
            effRoot === "/" ? branch : branch.slice(effRoot.length + 1);
          setRollOpenSet((prev) => {
            const next = new Set(prev);
            for (let p = rel; p !== ""; ) {
              next.add(p);
              const j = p.lastIndexOf("/");
              p = j <= 0 ? "" : p.slice(0, j);
            }
            return next;
          });
        }
        setRollBranch(branch);
        setMode("rolls");
        setImageId(null);
        if (splitImageId != null) setSplitImageId(null);
      }),
    [confirmContext, changeRollRoot, splitImageId]
  );
  // v14.0 (#288) — the pane's refcrop *Open roll* / *Open roll path*
  // (the image's own routes, addressed by face); defined right below
  // openRollBranch (dep arrays read it eagerly — TDZ above)
  const paneOpenRefcropRoll = useCallback(
    (faceId: number) => {
      const img = facesById.get(faceId)?.image_id;
      if (img != null) openRollBranch(img);
    },
    [facesById, openRollBranch]
  );
  const paneOpenRefcropRollPath = useCallback(
    (faceId: number) => {
      const img = facesById.get(faceId)?.image_id;
      if (img != null) api.openRoll(img).catch((err) => setError(String(err)));
    },
    [facesById]
  );
  // v12.5 (#284): the branch menu's *Open roll* — select the branch
  // (its grid lands in the right pane) and add it to the open-set when
  // closed; unlike the header click's toggle this never collapses an
  // open branch. A rendered branch's ancestors are already open (it is
  // visible in the tree), so the branch's own rel path suffices.
  // Identity-stable (setters stable, the root read through the ref —
  // the #98 identity rule).
  const openRollAt = useCallback((absPath: string) => {
    setRollBranch(absPath);
    const root = rollRootRef.current;
    const rel =
      absPath === "/"
        ? ""
        : root === "/"
          ? absPath.slice(1)
          : absPath.startsWith(`${root}/`)
            ? absPath.slice(root.length + 1)
            : null;
    if (rel !== "" && rel != null) {
      setRollOpenSet((prev) => (prev.has(rel) ? prev : new Set(prev).add(rel)));
    }
  }, []);
  // v12.4 (#280): the latest recursive state for the event-time menu
  // read (the #98 identity rule — branchMenu must not churn per toggle)
  const rollRecursiveRef = useRef(rollRecursive);
  rollRecursiveRef.current = rollRecursive;
  // §4.36 branch route: the header ⇩ / the menu's Re-import… open the
  // import pane on the branch with Re-import pre-checked (every tree
  // branch holds imported images; the pane's own gating rules apply)
  // #282 (N2): the functional update drops `splitImageId` from the
  // deps — the identity stays put for the memo(RollsPane) prop check
  const reimportBranch = useCallback((path: string) => {
    setImportDir(path);
    setImportInitial({ reimport: true });
    setImageId(null);
    setSplitImageId((cur) => (cur != null ? null : cur));
  }, []);
  // #282 (N2): identity-stable (the setters are stable) — see the
  // RollsPane JSX note
  const onImportDir = useCallback((path: string) => {
    setImportDir(path);
    setImportInitial(null);
  }, []);
  const branchMenu = useCallback(
    (e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, path: string) => {
      openMenu(e as unknown as ReactMouseEvent, rollBranchMenuGroups({
        path,
        onOpenRoll: openRollAt,
        onOpenRollPath: (p) =>
          api.openDir(p).catch((err) => setError(String(err))),
        onReimport: reimportBranch,
        recursive: rollRecursiveRef.current.has(path),
        onToggleRecursive: toggleRollRecursive,
      }));
    },
    [openMenu, openRollAt, reimportBranch, toggleRollRecursive]
  );
  const imageAreaMenu = useCallback(
    (e: ReactMouseEvent, imageId: number) => {
      if (!snap) return;
      const faces = snap.faces.filter(
        (f) => f.image_id === imageId && faceVisible(f)
      );
      openMenu(e, imageAreaMenuGroups({
        imageId,
        faces,
        // #268: non-empty return = original not found, temp copy opened —
        // quiet info toast (the success path is silent)
        openInViewer: (id) =>
          api
            .openImage(id)
            .then((msg) => { if (msg) setInfo(msg); })
            .catch((err) => setError(String(err))),
        // #272: the surface image's importing roll (null = never imported)
        rollImportId:
          snap.images.find((i) => i.id === imageId)?.last_import_id ?? null,
        // #274: Rolls mode with the tree opened at the image's branch
        // (the #123 dialog lives in openRollBranch)
        openRoll: openRollBranch,
        // #272 (gui-design v11.1): the image's own directory in the file
        // manager — a stale directory reaches the error toast (#144)
        openRollPath: (imageId) =>
          api.openRoll(imageId).catch((err) => setError(String(err))),
        rotateImage: rotateImg,
        changeSel,
      }));
    },
    // #228 (F-L4): sel read via selRef — the callback identity must not
    // churn per face selection (it re-renders memo(RollsThumbs))
    [snap, faceVisible, openMenu, rotateImg, changeSel, openRollBranch]
  );

  const imageMenu = useCallback(
    (image: ImageRow, e: ReactMouseEvent) => {
      if (!snap) return;
      const inBranch = new Set(branchThumbs.images.map((x) => x.id));
      const faces = snap.faces.filter(
        (f) => f.image_id === image.id && faceVisible(f)
      );
      openMenu(e, thumbMenuGroups({
        image,
        imgSel: imgSelRef.current,
        inBranch,
        faces,
        sel: selRef.current,
        openImageInView: (id) =>
          confirmContext(() => {
            setMode("rolls");
            setImageId(id);
            anchorFirstCrop(id); // #269 (§4.37): the right pane follows the first crop
          }),
        rotateImages,
        // #268: non-empty return = original not found, temp copy opened —
        // quiet info toast (the success path is silent)
        openInViewer: (id) =>
          api
            .openImage(id)
            .then((msg) => { if (msg) setInfo(msg); })
            .catch((err) => setError(String(err))),
        // #272: branch images that have a roll (id → last_import_id)
        rollImport: new Map(
          snap.images
            .filter((i) => i.last_import_id != null)
            .map((i): [number, number] => [i.id, i.last_import_id as number])
        ),
        // #272 (gui-design v11.1): each image's own directory in the
        // file manager — a stale directory reaches the error toast (#144)
        openRollPath: (imageId) =>
          api.openRoll(imageId).catch((err) => setError(String(err))),
        doAccept,
        changeSel,
      }));
    },
    // #228 (F-L4): sel/imgSel read via refs (see imageAreaMenu)
    [snap, branchThumbs, faceVisible, openMenu, confirmContext,
     rotateImages, doAccept, changeSel, anchorFirstCrop]
  );

  // ------------------------------------------------------------ sections

  // #97/#98: one suggestion source per snapshot — stable identity
  const personOptions = useMemo(() => snap?.persons ?? [], [snap]);
  const pathOptions = useMemo(() => groupPathOptions(personOptions), [personOptions]);
  // #262 (§4.21): the description tag vocabulary — distinct tokens of
  // the snapshot's face descriptions (pure, co-tested in descTags.ts)
  const descOptions = useMemo(() => descTagOptions(snap?.faces ?? []), [snap]);

  // #135/#136 (rule 34) + #260: the face-drag machine — one hook owns the
  // state/refs and the five identity-stable grid handlers (co-tested in
  // useFaceDrag.test.tsx). Placed after facesById/mutate so the handlers
  // read the current snapshot; the grid memo below re-binds only when
  // facesById does (same churn the old inline handlers had).
  const {
    faceDrag,
    faceDropTarget,
    faceDragRef,
    onFaceDragStart,
    onFaceDragEnd,
    onFaceDragOver,
    onFaceDragLeave,
    onFaceDropOnCard,
    clearFaceDrag,
  } = useFaceDrag(selRef, stagedIdxRef, facesByIdRef, mutate);

  // #177 (§4.42): the accept path behind the ✓ — bound through a ref
  // so this early memo (#98 identity rule) keeps a stable callback
  const acceptFlowRef = useRef<(ids: number[]) => void>(() => {});
  // #98 (§4.31): the card handlers are ONE memo — identity changes only
  // when their inputs do (never per hover, never per selection change:
  // sel/hover/sections are read through refs), which is what lets
  // memo(FaceCard) skip untouched cards
  const gridHandlers = useMemo(() => ({
    faces: facesById,
    persons: personsById,
    onContextMenu: faceMenu,
    onToggle: toggle,
    onSelectOne: selectOnly,
    onRangeSelect: rangeSelect,
    onOpen: (id: number) => {
      const f = facesById.get(id);
      // #123: opening focus mode is a view-context change; #171/§4.37:
      // the right pane follows the opening face's person (NULL keeps
      // the previous anchor)
      if (f)
        confirmContext(() => {
          setSplitImageId(f.image_id);
          if (f.person_id != null) setPersonId(f.person_id);
        });
    },
    onToggleMany: toggleMany,
    onPrimary: doPrimary,
    onRefcrop: doRefcrop,
    // #49/#101: the card's actions honour the effective scope — the
    // selection when the card is part of it (member-preserving), else
    // just the card; bottom-bar/keys never confirm (Q2/Q9)
    onReject: (id: number) => doReject(actionScope(id)),
    // #177 (§4.42): ✓ on the card (bar semantics under the §4.14
    // scope) and ✓/✗ on the cluster header (the whole group)
    onAccept: (id: number) => acceptFlowRef.current(actionScope(id)),
    onAcceptGroup: (ids: number[]) => acceptFlowRef.current(ids),
    onRejectGroup: (ids: number[]) => doReject(ids),
    // #101: the grid's only editable surface — one dialog. #230 (§4.24):
    // inside a multi-face selection the scope defaults to the whole
    // selection (the actionScope the card's accept/reject already
    // honour); a lone card stays Card
    onEditCard: (id: number) =>
      openEdit(actionScope(id).length > 1 ? "selection" : "card", { card: id }),
    onEditGroup: (ids: number[]) => openEdit("group", { group: ids }),
    // #135/#136 (rule 34) + #260: the face-drag handlers are the
    // identity-stable callbacks from useFaceDrag (co-tested) — they read
    // the live payload through refs, so the grid memo never churns while
    // a drag is in flight
    onFaceDragStart,
    onFaceDragEnd,
    onFaceDragOver,
    onFaceDragLeave,
    onFaceDropOnCard,
  }), [facesById, personsById, faceMenu, toggle, selectOnly, rangeSelect,
      toggleMany, doPrimary, doRefcrop, doReject, actionScope, openEdit,
      confirmContext, mutate, onFaceDragStart, onFaceDragEnd, onFaceDragOver,
      onFaceDragLeave, onFaceDropOnCard]);

  // one section per person over an image's faces — the Rolls image
  // detail and the #55 focus-mode film roll share it (§4.44: the rule
  // is the pure sectionsForImage; this is the identity-stable wrapper)
  const sectionsForImage = useCallback(
    (imgId: number): Section[] =>
      sectionsForImageOf(snap, personsById, imgId, faceFilter),
    [snap, personsById, faceFilter]
  );

  // #98 (§4.31): memoised — computed once per snapshot/view/person/focus
  // change (sectionsForImage is a stable useCallback, so the memo holds),
  // never per render. §4.44: the grouping rules are the pure
  // buildSections (sections.ts, co-tested); App owns only the identities.
  // #222 (F-H3): the person inputs are value-gated through
  // sectionsPersonKey — in Review the derivations never read the anchor,
  // so the memo keys on null there and a verdict advance / tree select
  // rebuilds nothing (section objects survive referentially, the
  // O(total faces) regroup stays out of the verdict path). The staged
  // index (#224) is fed only where the grouping reads it (person
  // Description mode, #155) — a Review Apply regroups nothing.
  const sectionsPerson = sectionsPersonKey(mode, personId);
  const sectionsPersonObj =
    sectionsPerson != null ? personsById.get(sectionsPerson) ?? null : null;
  const sectionsStagedIdx =
    mode === "person" && clusterGroup === "description" ? stagedIdx : null;
  const sections: Section[] = useMemo(
    () =>
      buildSections({
        snap,
        mode,
        imageId,
        personId: sectionsPerson,
        selectedPerson: sectionsPersonObj,
        clusters,
        facesById,
        faceFilter,
        clusterGroup,
        stagedIdx: sectionsStagedIdx,
        sectionsForImage,
      }),
    [snap, mode, imageId, sectionsPerson, sectionsPersonObj, clusters, facesById,
     faceFilter, clusterGroup, sectionsStagedIdx, sectionsForImage] // #155/#224: the staged (§4.24) descriptions drive the regroup, gated to where it is read
  );
  sectionsRef.current = sections;
  sectionsForImageRef.current = sectionsForImage;
  // #215: the focus film-roll sections — memoised per split image (the
  // inline sectionsForImage(splitRow.id) built a fresh array identity on
  // every App render, defeating memo(FaceGrid))
  const splitSections = useMemo(
    () => (splitImageId != null ? sectionsForImage(splitImageId) : []),
    [sectionsForImage, splitImageId]
  );

  // #96 (§4.30) — Review mode: accept advances the context; person and
  // focus mode route to the plain accept (context only ever moves by the
  // user's own hand there). The plan comes from the pre-accept sections,
  // which stay valid across the refresh — see reviewFlow.ts.
  // #259: the gate + mode routing + advance dance are the pure
  // routeAccept/reviewScope (commit.ts, co-tested); App binds the mark,
  // the verdict mutate and the focus follow in the same order.
  const acceptAndNext = useCallback(
    async (ids: number[], claimed = false) => {
      if (!snap) return;
      const route = routeAccept(
        mode,
        ids,
        facesById,
        claimed,
        lastSelRef.current,
        hoverRef.current,
        sections
      );
      // #165/§4.35: plain accept never un-rejects — a rejected-only scope
      // is inert with guidance (commitPending passes claimed=true after a
      // staged NAME assignment has already done the claiming)
      if (route.kind === "inert") {
        setInfo("assign a person to bring it back");
        return;
      }
      if (route.kind === "plain") {
        // #188/§4.40 + reopened (gui-design v3.93): the lock is the mode —
        // no any-view widening; the plain path applies only OUTSIDE Review
        // (a focus/rolls split is then its own context)
        const ok = await verdictMutate(
          () => api.acceptFaces(ids),
          ids,
          "confirmed",
          true
        );
        if (ok) focusActed(ids); // #189/§4.41: focus follows the verdict
        return;
      }
      markExhaust(); // #125: accepting may empty the current person
      const plan = acceptAdvancePlan(sections, route.actedKey, ids);
      // #140: the selection rewrite / scroll-to-next used to run
      // unconditionally — a failed accept (error toast from mutate) wiped
      // the selection and pointed the cursor at a plan built from
      // pre-failure state. Everything below runs only on success.
      // (#139: commitPending runs the staged ops before calling this —
      // each op its own mutate so a mid-set failure can be re-staged.)
      const ok = await verdictMutate(
        () => api.acceptFaces(ids),
        ids,
        "confirmed",
        false
      );
      if (!ok) return;
      // #189/§4.41: focus follows the verdict — with the #125 interplay
      // guard (focusActedUnlessNoop): a no-op anchor re-set would
      // clobber the exhaust hand-over on engines that flush this update
      // as its own commit (WebKit); see the helper's comment.
      focusActedUnlessNoop(ids, personId);
      const { selection, reveal } = reviewScope(plan);
      setSel(new Set(selection));
      if (reveal != null) {
        // #214: post-commit reveal — the layout effect below grows the
        // mounted prefix to the target section first, then scrolls
        // (replaces the frame-dependent double-rAF, which could never
        // reach an unmounted card)
        setRevealFace(reveal);
      }
    },
    [
      snap,
      mode,
      sections,
      verdictMutate,
      markExhaust,
      facesById,
      personId,
      focusActed,
      focusActedUnlessNoop,
    ]
  );

  // #125 (§4.30): a verdict (Accept / Reject / Delete Person) that leaves
  // the current person without a face under the review status steps past
  // it — exactly what “›” does — instead of a black centre panel. The
  // mark is set pre-mutation; this effect consumes it once the refreshed
  // snap lands. Partial verdicts (the person still has review faces)
  // never fire it.
  useEffect(() => {
    const at = exhaustAtRef.current;
    if (at < 0) return;
    // #234 (rule 45): a verdict in flight — the optimistic flip has
    // already landed, the authoritative delta has not. Consuming the
    // mark now would advance on stale data; the post-delta refresh
    // re-runs this effect with the flight cleared.
    if (inFlightRef.current.size > 0) return;
    // #148: consume unconditionally — the mark must never linger across
    // view switches / person changes and fire from stale state later
    const markedPid = exhaustPidRef.current;
    exhaustAtRef.current = -1;
    exhaustPidRef.current = null;
    const pid = personId;
    // #148: the mark only ever advances the person it was set for — if
    // the user navigated between mark and refresh, the verdict's
    // fall-through no longer applies (that person's own verdict either
    // set a fresh mark or the user took over)
    if (pid == null || pid !== markedPid || !snap) return;
    const status =
      faceFilter === "confirmed" || faceFilter === "rejected" ? faceFilter : "provisional";
    if (snap.faces.some((f) => f.person_id === pid && f.link_status === status)) return;
    // #159 (§4.30, v3.58): the advance target is the first person ANCHOR
    // forward — in the tree list — that still has a face of the review
    // status. The old code landed on the immediate successor whatever
    // they hold, so under Show=All (faceless shell persons everywhere in
    // the list) and Show=New (a fully reviewed person loses their last
    // matching face) the advance parked on a person with nothing to
    // review — the reported 'nothing to show' centre pane with pending
    // faces elsewhere. reviewFlow.exhaustAdvanceTarget re-derives the
    // marked person's position from the CURRENT list (the §4.10 pruning
    // may have removed them on this very refresh) and falls back to the
    // captured index as the pruning gap.
    const nextId = exhaustAdvanceTarget(stepIds, pid, at, (id) =>
      snap.faces.some((f) => f.person_id === id && f.link_status === status)
    );
    if (nextId == null) {
      setInfo("no more persons to review");
      return;
    }
    setPersonId(nextId);
    // #200 (§4.40): the fall-through advances INSIDE Review — the mode
    // never changes here (the old setMode("person") yanked the user out
    // of the review workflow)
    if (mode !== "review") setMode("person");
    setImageId(null);
    // §4.15/#175: the advance ends an open full image/focus — the
    // person on screen is no longer the one shown (stepping closes it too)
    if (splitImageId != null) setSplitImageId(null);
    // #234 (rule 45): `inFlight` is a dep — the flight CLEAR re-runs this
    // effect so a mark deferred during the in-flight window is consumed
    // on the authoritative snap (the delta render can land before the
    // flight clear — the guard must not swallow the mark)
  }, [snap, mode, personId, faceFilter, stepIds, splitImageId, inFlight]);

  // #176 (§4.41) — the sticky person: a Show change (or a verdict) that
  // hides EVERY face of the anchored person opens the guard dialog once
  // per person+filter pair (Close dismisses until either changes);
  // faceless shells (total 0) are their own state and never trigger it
  useEffect(() => {
    if (mode !== "person" || personId == null || !snap) return;
    const p = personsById.get(personId);
    if (!p || p.counts.total === 0) return;
    const visible = snap.faces.some(
      (f) => f.person_id === personId && matchesStatusFilter(f.link_status, faceFilter)
    );
    if (visible) return;
    const key = `${personId}|${faceFilter}`;
    if (noFacesKeyRef.current === key) return;
    noFacesKeyRef.current = key;
    setNoFacesDialog(true);
  }, [mode, personId, snap, personsById, faceFilter]);
  // …and the guard closes as soon as the pair becomes workable again
  // (Show All, a filter change, another anchor, another mode)
  useEffect(() => {
    if (!noFacesDialog) return;
    if (mode !== "person" || personId == null || !snap) {
      setNoFacesDialog(false);
      return;
    }
    const p = personsById.get(personId);
    if (
      !p ||
      p.counts.total === 0 ||
      snap.faces.some(
        (f) => f.person_id === personId && matchesStatusFilter(f.link_status, faceFilter)
      )
    )
      setNoFacesDialog(false);
  }, [noFacesDialog, mode, personId, snap, personsById, faceFilter]);

  // #101 (§4.24) — stage/commit engine: Apply stages (no DB — the labels
  // preview), Accept commits the stage ops through the shared
  // accept-and-advance path; Esc/Undo revert (F1) and a selection change
  // while staged asks escape-or-accept (Q4). The dialog-opening half
  // (prefillFor/openEdit) lives above faceMenu, which needs it too.
  // #259: the routing is the PURE plan (stage.ts-styled commit.ts,
  // co-tested); App binds it to the IPC in plan order.
  const stageOps = useCallback(
    async (st: Stage): Promise<Delta[]> => {
      const deltas: Delta[] = [];
      for (const a of planStageOps(st, facesById, personsById)) {
        switch (a.kind) {
          case "info":
            setInfo(a.msg);
            break;
          case "assign":
            deltas.push(await api.assignPerson(a.ids, a.name, a.group));
            break;
          case "setPersonGroup":
            deltas.push(await api.setPersonGroup(a.personId, a.group));
            break;
          case "setDescription":
            deltas.push(await api.setFaceDescriptions(a.ids, a.desc));
            break;
        }
      }
      return deltas;
    },
    [facesById, personsById]
  );

  /** #123/#166 — commit the WHOLE pending set: the ops in order through
      the #77 routing, then accept over the caller's DISPLAYED scope (bar/
      keys: selection or cursor-as-target, dialog: its chosen scope) — the
      staged set supplies the edits only; an empty scope falls back to the
      staged ids. The review advance anchors as before — last-selected,
      hovered, first id). #259: the plan (what runs at all, the claimed
      flag, the scope, the resume-after-failure list) is the pure
      commit.ts core; App binds the sequencing. */
  const commitPending = useCallback(
    async (all: Stage[], acceptIds?: number[], groupOps?: GroupOp[]) => {
      const plan = planCommit(all, acceptIds, groupOps);
      if (!plan) return;
      const { opsLive, claimed, acceptScope } = plan;
      // #219: collect the staged ops' deltas — they carry the fresh
      // face→owner mapping (the claim/merge moves faces between persons),
      // so the group ops below need no full snapshot re-fetch.
      const deltas: Delta[] = [];
      // #281: the plan's deltas apply in order against the live stamp
      // (`applyDeltas` — a drifted/base-stale delta is one full refresh)
      const flush = () => applyDeltas(deltas);
      let done = 0;
      try {
        for (; done < all.length; done++) {
          deltas.push(...(await stageOps(all[done])));
        }
      } catch (e) {
        // the applied prefix (ops 1..done−1) is in; the failed op and
        // everything after it stays staged and retryable — Accept again
        // re-runs the idempotent field writes and continues from here
        setError(`Accept stopped at op ${done + 1}/${all.length}: ${e}`);
        setPending(remainingAfterFailure(all, done));
        await flush(); // #219: land the deltas that did apply
        return;
      }
      // #166: acceptance runs over the caller's displayed scope — the
      // staged set only staged the edits (empty scope ⇒ the staged ids)
      const ids = acceptScope;
      // #181 (§4.38): the dialog's group-LIST edits — the name has
      // landed, so the scope's faces now name the SURVIVING person (the
      // merge target when the name was taken, the renamed/created one
      // otherwise); the owner comes from the staged deltas (fresh) or the
      // pre-existing snap for untouched faces
      if (opsLive) {
        const owners = ownersForGroupOps(ids, deltas, facesById);
        // #209: ONE call per op over ALL owners (the command is
        // per-person independent) — no refresh per call; the accept
        // below lands exactly one delta for the whole action. A failed
        // op surfaces the error toast and does not abort the rest (the
        // old per-mutate swallow-and-continue). A merge may have deleted
        // some owners — one existing owner still applies the op for all
        // (the old per-owner calls toasted on each deleted one).
        for (const op of groupOps!) {
          try {
            deltas.push(await api.movePersonsBetweenGroups(owners, op.from, op.to));
          } catch (e) {
            setError(String(e));
          }
        }
      }
      // #219: land the staged + group-op deltas locally, then the accept
      // delta lands through acceptAndNext's mutate. A drifted delta falls
      // back to one full refresh.
      await flush();
      await acceptAndNext(ids, claimed);
      setPending([]);
    },
    [acceptAndNext, stageOps, applyDeltas, facesById, refresh]
  );

  // #177 (§4.42) — accept a scope EXACTLY like the bar accepts the
  // selection: live stages commit first (#166), then the accept (+
  // the §4.30 advance in Review). Re-bound every render so the callers
  // through acceptFlowRef always see the current pending set.
  acceptFlowRef.current = (ids: number[]) =>
    pending.length > 0 ? void commitPending(pending, ids) : acceptAndNext(ids);

  /** bottom-bar Apply (Q2/Q9, #123): opens the dialog on the selection —
      the Apply loop extends the set; it never re-scopes or commits.
      #147: with a live stage but an empty selection (staged ops survive
      selection changes by design) the dialog scopes onto the staged
      set's faces instead of opening dead at every scope = 0 */
  const barApply = () => {
    if (!snap) return;
    if (selRef.current.size === 0) {
      const staged = [...new Set(pendingRef.current.flatMap((o) => o.faceIds))];
      if (staged.length === 0) return; // undoable only in theory; RuleBar
                                       // disables Apply here anyway
      openEdit("selection", undefined, staged);
      return;
    }
    openEdit("selection");
  };
  // #234 (rule 45): the bar's verdicts disable while any selected face
  // is in flight (its optimistic flip / delta is pending)
  const barInFlight = useMemo(
    () => [...sel].some((id) => inFlight.has(id)),
    [sel, inFlight]
  );

  // #31 — person stepping: ‹ › and ← → walk the persons in the tree's
  // current (filtered) display order (stepIds/stepIdx declared early —
  // #125); the shortcut set is listed in the settings popover
  // shared cursor position for the cursor-as-target rules (#74/#75/#76)
  const mouseRef = useRef({ x: -1, y: -1 });
  // #194 (§4.25): the LAST anchored person's position in the current step
  // list — the step base when the anchor has left the list (stepIdx -1,
  // e.g. a verdict drained it and §4.10 pruned it under Show → New) and
  // the cursor hit missed (the cursor is over the ‹ › buttons themselves).
  // Updated wherever the anchor lands, so every selection path feeds it.
  const lastStepPosRef = useRef(-1);
  useEffect(() => {
    if (personId == null) return;
    const i = stepIds.indexOf(personId);
    if (i !== -1) lastStepPosRef.current = i;
  }, [personId, stepIds]);
  const stepPerson = useCallback(
    (dir: 1 | -1) => {
      // #76 — cursor-as-target (§4.25): with no selected person the
      // person under the mouse cursor anchors the step (mouseRef is the
      // same ref object every render, so this closure never goes stale)
      let cursorIdx = -1;
      if (stepIdx === -1) {
        const el = document.elementFromPoint(
          mouseRef.current.x,
          mouseRef.current.y
        );
        const v = el
          ?.closest("[data-person-id]")
          ?.getAttribute("data-person-id");
        cursorIdx = v == null ? -1 : stepIds.indexOf(parseInt(v, 10));
      }
      // #194 (§4.25): the base chain — anchored position, cursor, last
      // anchored position (clamped), else the start/end fallback below
      const base = stepBase(stepIdx, cursorIdx, lastStepPosRef.current, stepIds.length);
      const next =
        base === -1
          ? dir === 1
            ? 0
            : Math.max(stepIds.length - 1, 0)
          : Math.min(Math.max(base + dir, 0), stepIds.length - 1);
      const id = stepIds[next];
      if (id == null) return;
      // #62 — attention shifted to the new person: the full image ends
      // whether they appear in it or not (§4.15, same rule as a tree-row
      // select; #52's relevance check dropped) — #123: stepping is a
      // context change (drop-or-accept with a live set)
      confirmContext(() => {
        if (splitImageId != null) setSplitImageId(null);
        setPersonId(id);
        // #200 (§4.40): Review is sticky — stepping advances the anchor
        // INSIDE Review; the mode switch runs only from another mode
        // (the Rolls/Person tab clicks are the only Review exit)
        if (mode !== "review") setMode("person");
        setImageId(null);
      });
    },
    [stepIdx, stepIds, splitImageId, confirmContext, mode]
  );
  // #194 (§4.41) — the empty state says what to do next: the anchored
  // person holds no face under the current Show filter, so the bare
  // "nothing to show" becomes guidance naming the active filter and
  // pointing at ‹ › (see emptyStateHint). Person context only (Person
  // mode + anchored person); everywhere else the bare message stays (the
  // grid falls back when the hint is undefined).
  const emptyHint =
    mode === "person" && selectedPerson
      ? emptyStateHint(selectedPerson.counts.total, faceFilter)
      : undefined;
  // #74 — section under the mouse cursor: Ctrl-G must work with the
  // cursor anywhere inside a group, without a prior click/hover on one
  // of its cards — the cursor position is tracked, the DOM resolves it
  useEffect(() => {
    // #98: one delegated listener feeds BOTH the cursor-as-target
    // shortcuts (hoverRef) and the card ↔ overlay-rect highlight
    // (data-sync-hover) — no React state, no re-render per hover
    let last: number | null = null;
    const sync = (id: number | null) => {
      if (id === last) return;
      if (last != null)
        document
          .querySelectorAll(`[data-face-id="${last}"], [data-overlay-face="${last}"]`)
          .forEach((el) => el.removeAttribute("data-sync-hover"));
      if (id != null)
        document
          .querySelectorAll(`[data-face-id="${id}"], [data-overlay-face="${id}"]`)
          .forEach((el) => el.setAttribute("data-sync-hover", ""));
      last = id;
      hoverRef.current = id;
    };
    const recompute = () => {
      const el = document.elementFromPoint(mouseRef.current.x, mouseRef.current.y);
      const hit = el?.closest?.("[data-face-id],[data-overlay-face]") as HTMLElement | null;
      const raw =
        hit?.getAttribute("data-face-id") ?? hit?.getAttribute("data-overlay-face");
      sync(raw == null || Number.isNaN(parseInt(raw, 10)) ? null : parseInt(raw, 10));
    };
    // #215: at most one recompute per frame — elementFromPoint plus the
    // querySelectorAll pair must not run per raw mousemove/scroll event
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recompute();
      });
    };
    const move = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
      schedule();
    };
    window.addEventListener("mousemove", move);
    // scrolling moves cards under a stationary pointer (mouseenter-equivalent)
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("scroll", schedule, { capture: true } as EventListenerOptions);
      cancelAnimationFrame(raf);
      sync(null);
    };
  }, []);
  const sectionUnderCursor = (rendered: Section[]): Section | undefined => {
    const el = document.elementFromPoint(mouseRef.current.x, mouseRef.current.y);
    const key = el
      ?.closest("[data-section-key]")
      ?.getAttribute("data-section-key");
    return key ? rendered.find((s) => s.key === key) : undefined;
  };
  // #258: the hot keydown listener + Esc stack are the useAppKeys hook
  // (src/appKeys.ts) — the ONE input object replaces the 15-property
  // keyRef literal App used to write out twice; every guard is
  // byte-for-byte the relocation's source
  useAppKeys(
    {
      overlayCount,
      sections,
      sectionsForImage,
      sectionUnderCursor,
      sel,
      splitImageId,
      imageId,
      mode,
      toggle,
      toggleMany,
      changeSel,
      commitPending,
      acceptAndNext,
      doReject,
      stepPerson,
      stepImage,
      stepSplitFace: (d) => stepSplitFaceRef.current(d),
    },
    {
      contextConfirmRef,
      pendingRef,
      hoverRef,
      lastSelRef,
      clearPending: () => setPending([]),
      closeSplit: () => setSplitImageId(null),
    }
  );

  const pendingCount = useMemo(
    () => snap?.faces.filter((f) => f.link_status === "provisional").length ?? 0,
    [snap]
  );

  // #179 (§4.41): the top bar's DB-wide status totals — an overview of
  // the whole database, independent of mode/filter/selection; one pass
  // per refreshed snapshot so every verdict lands (#98: memoised)
  const statusTotals = useMemo(() => {
    const t = { provisional: 0, confirmed: 0, rejected: 0 };
    for (const f of snap?.faces ?? []) {
      if (f.link_status === "provisional") t.provisional++;
      else if (f.link_status === "confirmed") t.confirmed++;
      else if (f.link_status === "rejected") t.rejected++;
    }
    return t;
  }, [snap]);

  // ------------------------------------------------- #88 Merge Similar Persons

  // §4.44 round 2 stage 5 (#296): the merge engine — the #88/#287 triage
  // state, the shared §4.28 confirmation, the #135 face-level path, the
  // refusals/no-ops, the one-transaction assign_person merges and the
  // #133 re-anchor (useMergeFlow.ts, co-tested). The view reactions are
  // injected deps; the callbacks churn at exactly the old rates (#98).
  const {
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
  } = useMergeFlow({
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
  });

  // #228 (F-L1): the focus/detail image rows and their face lists are
  // memoised — the old inline `snap.faces.filter(...)` per render handed
  // FaceOverlay a fresh array every time (and the two image lookups were
  // linear scans per render); with stable identities memo(FaceOverlay)
  // can skip when only unrelated state moved
  // #291/#292 (§4.44 round 2): the detail derivations are the pure
  // src/detailView.ts — the open image's row, the branch step index
  // (rule 46), the Show-filtered face lists (§4.10), the full-image-open
  // rule and the focus-bar face step composition. App keeps only these
  // useMemo bindings — same deps, same churn rates (#98 untouched).
  const imgRow: ImageRow | undefined = useMemo(
    () => imageRowFor(snap, imageId),
    [snap, imageId]
  );
  // #235 (rule 46) — the open image's position in the branch's listed
  // roll (the cluster's `n` of `n/m`); -1 = not in the list (opened
  // from the path filter in another branch, or the Show filter no
  // longer lists it) → `–/m`, both buttons disabled
  const imgStepIdx = useMemo(
    () => stepIndexIn(branchThumbs.images, imageId),
    [branchThumbs, imageId],
  );
  const splitRow: ImageRow | undefined = useMemo(
    () => imageRowFor(snap, splitImageId),
    [snap, splitImageId]
  );
  const focusFaces = useMemo(
    () => (splitRow ? facesOfImage(snap, splitRow.id, faceFilter) : []),
    [snap, splitRow, faceFilter]
  );
  const detailFaces = useMemo(
    () => (imgRow ? facesOfImage(snap, imgRow.id, faceFilter) : []),
    [snap, imgRow, faceFilter]
  );
  // #275 (gui-design v11.3) — a full image is up on either surface: the
  // card-double-click split (focus pane) or the Rolls image detail.
  // While it is, the centre's own toolbar does not render: the single
  // bar above the image carries the mode's nav cluster instead
  const fullImageOpen = fullImageOpenFor(splitRow, mode, imageId, imgRow);
  // #275 (gui-design v11.4) — the focus bar's FACE step: the right-pane
  // person's editable faces in the view's display order (person grid
  // sections in Person, the pinned-filter faces in Review) and the open
  // image's position in that list — the pure rule is splitStepFor
  // (detailView.ts, co-tested over personFaceList/splitStepPos)
  const splitStep = useMemo(
    () =>
      splitStepFor(
        mode,
        personId,
        sections,
        snap?.faces ?? [],
        faceFilter,
        facesById,
        splitRow
      ),
    [mode, personId, sections, snap, faceFilter, facesById, splitRow]
  );
  // one step = open the full image holding the target face; the view
  // STAYS in full-image mode (the bar is the only grid return). At the
  // first/last face (or an unlisted image) the step is a no-op — the
  // arrows and the ← → keys share the rule
  const stepSplitFace = useCallback(
    (dir: 1 | -1) => {
      const idx = splitStep.pos + dir;
      if (splitStep.pos === -1 || idx < 0 || idx >= splitStep.ids.length) return;
      const f = facesById.get(splitStep.ids[idx]);
      if (f == null) return;
      confirmContext(() => setSplitImageId(f.image_id));
    },
    [splitStep, facesById, confirmContext]
  );
  stepSplitFaceRef.current = stepSplitFace;

  if (noDb) {
    // #185 (§4.36): no usable database — the first-run screen owns the
    // whole flow incl. the dialog → import-pane switch (components/
    // FirstRun.tsx, §4.44 stage 3); App routes its outcomes onto the
    // loadError/noDb/error states exactly as the inline branch did
    return (
      <FirstRun
        refresh={refresh}
        onUsable={() => setNoDb(false)}
        onBroken={(m) => setLoadError(m)}
        onError={setError}
      />
    );
  }
  if (loadError) {
    return <FatalError title="Could not load database" message={loadError} />;
  }
  if (!snap) {
    return <div className="dim center-msg">loading…</div>;
  }

  return (
    <div className="app">
      <header className="topbar">
        {/* #198 (§4.9): the whot mark beside the title */}
        <img className="topbar-logo" src="/whot.svg" alt="" />
        <h1>WhoT <span className="dim">Face Manager</span></h1>
        <nav>
          <button
            className={mode === "review" ? "active" : ""}
            onClick={() =>
              // #123: a tab switch is a view-context change
              confirmContext(() => {
                setMode("review");
                setImageId(null);
                setSplitImageId(null); // #55 (§4.19): explicit navigation ends focus mode
              })
            }
          >
            Review <span className="pill">{pendingCount}</span>
          </button>
          <button
            className={mode === "rolls" ? "active" : ""}
            onClick={() =>
              confirmContext(() => {
                setMode("rolls");
                setSplitImageId(null); // #55 (§4.19)
              })
            }
          >
            Rolls
          </button>
          <button
            className={mode === "person" ? "active" : ""}
            onClick={() =>
              confirmContext(() => {
                setMode("person");
                setImageId(null);
                setSplitImageId(null); // #55 (§4.19)
                // #176 (§4.41): no anchor yet — land in Person mode with
                // Show → All (the status branches are listed) and point
                // at the tree
                if (personId == null) {
                  changeFaceFilter("all");
                  setPickPersonDialog(true);
                }
              })
            }
            title={
              personId == null
                ? "no person anchored yet — pick one in the tree"
                : undefined
            }
          >
            Person
          </button>
        </nav>
        <span className="topbar-right">
          {busy && (
            <>
              {/* #100: an animated roller — a static word is too easy to miss */}
              <span className="busy-roller" title="working…" />
              <span className="dim">working…</span>
            </>
          )}
          {/* #158 (§3, v3.57): the Show filter lives in the top bar — it is
              a global control applied across all panes (#99, §4.10) and not
              something the Person view (or any single pane) owns. #175:
              rejected faces are reachable only via Show → Rejected
              (#165/§4.10); #175/§4.40: locked to New while Review runs —
              the titles stay reference-free (§4.43) */}
          <label
            title={
              mode === "review"
                ? "Locked to New while Review is active — leave Review via the Rolls or Person tab"
                : "All = everything except rejected; rejected faces appear only under Show → Rejected; switching it drops hidden faces from the selection"
            }
          >
            show
            <select
              value={faceFilter}
              disabled={mode === "review"}
              // #176 (§4.41): the closed value speaks the status colour
              className={`st-${faceFilter}`}
              onChange={(e) => changeFaceFilter(e.target.value as FaceFilter)}
            >
              <option value="all">All</option>
              <option value="provisional">New</option>
              <option value="confirmed">Accepted</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
          {/* #188 (§4.40): the padlock is a pure INDICATOR — 🔒 exactly
              while Review mode is active (Show pinned New + disabled);
              never clickable, no engage/release. #175: its tooltips stay
              reference-free (§4.43) */}
          <span
            className={`lock-btn${mode === "review" ? " locked" : ""}`}
            title={
              mode === "review"
                ? "Show is locked to New while Review is active — leave via the Rolls or Person tab"
                : "Show is unlocked outside Review"
            }
          >
            {mode === "review" ? "🔒" : "🔓"}
          </span>
          {/* #179 (§4.41): the DB-wide status totals — always visible,
              an overview of the database; never scoped to the anchor,
              the mode or the filter */}
          <span className="status-counts" title="totals in the database">
            <span className="c-prov" title="new faces">★ {statusTotals.provisional}</span>
            <span className="c-conf" title="accepted faces">✓ {statusTotals.confirmed}</span>
            <span className="c-rej" title="rejected faces">✗ {statusTotals.rejected}</span>
          </span>
          <button
            className="ghost"
            onClick={() => refresh().catch((e) => setError(String(e)))}
            title="Refresh"
          >
            ↻
          </button>
          {/* v12.2 (#279): ? opens the shortcuts help screen — ? is now
              taken in the top bar, which is why the New totals chip
              became ★ */}
          <button
            className="ghost"
            onClick={() => setHelpOpen(true)}
            title="Keyboard shortcuts"
          >
            ?
          </button>
          <button className="ghost" onClick={() => setSettingsOpen(true)} title="Settings">
            ⚙
          </button>
        </span>
      </header>

      <div className="main">
        <aside className="left" style={{ width: paneSizes.left }}>
          <PersonTree
            tree={tree}
            persons={treePersons}
            primaryRot={primaryRot}
            selectedId={personId}
            filter={filter}
            onFilter={setFilter}
            collapsed={treeCollapsed}
            onSetCollapsed={toggleTreeCollapsed}
            onSelect={handleTreeSelect}
            selectedIds={selPersons}
            onRemovePersons={doRemovePersons}
            onRename={renameOrMerge}
            // #50 (§4.16) — group management: membership only, faces untouched
            onRenameGroup={renameGroupCmd}
            onDeleteGroup={deleteGroupCmd}
            onMovePersons={movePersonsCmd}
            // #164 (§4.18): 'Add group…' on person rows — ADD a membership
            // (from='' deletes nothing, INSERT OR IGNORE files them; every
            // current group is kept); #184 shares it with the face menu
            onAddGroup={addPersonsToGroup}
            onError={setError}
            onOpenMerge={openMergeDialog}
            onMergeInto={openMergeInto}
            // #135 (rule 34): face drags from the centre pane — merge
            // into the dropped person (validation + dialog in App)
            faceDragIds={faceDrag}
            // v3.33: acceptance in the tree reads this ref at event time
            faceDragRef={faceDragRef}
            onDropFaces={onFacesDropped}
            onRenameSelection={renamePersons}
            onSelectPending={selectPendingFaces}
          />
        </aside>
        <div
          className="v-divider"
          role="separator"
          aria-orientation="vertical"
          aria-valuetext={`${paneSizes.left}px`}
          tabIndex={0}
          data-owns-keys
          onKeyDown={(e) => dividerKey(e, "left")}
          onMouseDown={startDrag("left")}
          onDoubleClick={() => setPaneSizes((s) => ({ ...s, left: 250 }))}
          title="drag to resize, double-click to reset, arrow keys to adjust"
        />

        <main
          className={splitRow ? "center focus" : "center"}
          // #174/§4.39: browsing Rolls — the centre holds its explicit
          // width (default = the left pane's); the right pane flexes
          style={rollsBrowse ? { width: rollCenterPx, flex: "none" } : undefined}
        >
          {/* #163 (v3.64): browsing Rolls renders no centre toolbar at
              all — no nav cluster (person stepping always lands in
              Person — it used to yank a rolls browser away), no seg
              (§4.9); the grid gets the pane's full height. #275 (rule
              46 refined): a FULL IMAGE is up with its OWN single bar —
              path, the mode's ‹ n/m › cluster, rotation, close/back —
              so no centre toolbar renders while one is open */}
          {!fullImageOpen && (mode !== "rolls" || imageId != null) ? (
          <div className="center-toolbar">
            <span className="toolbar-left">
              {mode === "rolls" ? (
                <>
                  <button
                    className="ghost"
                    onClick={() => stepImage(-1)}
                    disabled={
                      branchThumbs.images.length === 0 ||
                      imgStepIdx === -1 ||
                      imgStepIdx <= 0
                    }
                    title="previous image (←)"
                  >
                    ‹
                  </button>
                  <span className="nav-pos">
                    {branchThumbs.images.length > 0
                      ? `${imgStepIdx === -1 ? "–" : imgStepIdx + 1}/${branchThumbs.images.length}`
                      : "–"}
                  </span>
                  <button
                    className="ghost"
                    onClick={() => stepImage(1)}
                    disabled={
                      branchThumbs.images.length === 0 ||
                      imgStepIdx === -1 ||
                      imgStepIdx >= branchThumbs.images.length - 1
                    }
                    title="next image (→)"
                  >
                    ›
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="ghost"
                    onClick={() => stepPerson(-1)}
                    disabled={stepIds.length === 0 || (stepIdx !== -1 && stepIdx <= 0)}
                    title="previous person (←)"
                  >
                    ‹
                  </button>
                  <span className="nav-pos">
                    {stepIds.length > 0
                      ? `${stepIdx === -1 ? "–" : stepIdx + 1}/${stepIds.length}`
                      : "–"}
                  </span>
                  <button
                    className="ghost"
                    onClick={() => stepPerson(1)}
                    disabled={
                      stepIds.length === 0 || (stepIdx !== -1 && stepIdx >= stepIds.length - 1)
                    }
                    title="next person (→)"
                  >
                    ›
                  </button>
                </>
              )}
            </span>
            {/* #99/#100: the cluster-group seg hugs the right side of the
                person view — the Show filter is a global control and lives
                in the top bar (#158, v3.57); #163: person view ONLY —
                cluster_group shapes that view's sections alone (§4.9), so
                Review and Rolls must not show it; its title stays
                reference-free (§4.43) */}
            {mode === "person" && (
            <span className="toolbar-right">
            <span
              className="seg"
              title="Person view: how faces form sections — Accuracy = similarity clusters within each description; Description = one section per description (threshold ignored)"
            >
              <button
                className={clusterGroup === "description" ? "active" : ""}
                onClick={() => setClusterGroup("description")}
              >
                Description
              </button>
              <button
                className={clusterGroup === "accuracy" ? "active" : ""}
                onClick={() => setClusterGroup("accuracy")}
              >
                Accuracy
              </button>
            </span>
            </span>
            )}
          </div>
          ) : null}
          {/* #100: the bar is the pane's real header — only the area below
              it scrolls, so no section content can ever pass above it */}
          <div
            className="center-scroll"
            ref={centerScroll.ref}
            onScroll={centerScroll.onScroll}
          >
          <div className={splitRow ? "center-focus" : undefined}>
            {splitRow ? (
              // #55 (§4.19) — full-image focus mode: the annotated image
              // takes the pane's full width, a film roll below shows only
              // this image's faces; the regular grid returns when the mode
              // ends (✕/Esc, §4.15 selection move, explicit navigation)
              <div className="focus-pane">
                {/* #275: the ONE full-image bar (focus surface) — the
                    person stepper keeps its #76/#194 fallback rules;
                    the #123 dialog lives in stepPerson/close */}
                <FullImageBar
                  img={splitRow}
                  step={stepSplitFace}
                  canPrev={splitStep.pos !== -1 && splitStep.pos > 0}
                  canNext={
                    splitStep.pos !== -1 &&
                    splitStep.pos < splitStep.ids.length - 1
                  }
                  total={splitStep.ids.length}
                  pos={splitStep.pos}
                  stepNoun="face"
                  onRotate={(d) => rotateImg(splitRow.id, d)}
                  close={
                    <button
                      className="ghost"
                      onClick={() =>
                        confirmContext(() => setSplitImageId(null)) // #123
                      }
                      title="close (Esc)"
                    >
                      ✕
                    </button>
                  }
                />
                <div className="focus-image">
                  <FaceOverlay
                    imageId={splitRow.id}
                    width={splitRow.width}
                    height={splitRow.height}
                    faces={focusFaces}
                    sel={sel}
                    onToggle={rectToggle}
                    onFaceContextMenu={faceMenu}
                    onImageContextMenu={(e) => imageAreaMenu(e, splitRow.id)}
                    rotation={splitRow.rotation} // #122
                  />
                </div>
                <div className="film-roll">
                  <FaceGrid
                    sections={splitSections} // #215: memoised per split image
                    sel={sel}
                    inFlight={inFlight} // #234 (rule 45)
                    stageIdx={stagedIdx}
                    faceDropTarget={faceDropTarget}
                    // #225: the film roll windows too — it scrolls in its
                    // own pane (an image with many persons' faces)
                    mountLimit={mountLimit}
                    onNeedMore={growMount}
                    {...gridHandlers}
                    primaryFaceId={displayPerson?.primary_face_id ?? null}
                  />
                </div>
              </div>
            ) : (
              <>
          {mode === "rolls" && imageId == null ? (
            <RollsPane
              images={snap.images}
              faces={snap.faces}
              // #161: Show is active in the Rolls path tree — an image is
              // listed only if it holds a matching face (branch counters
              // stay raw; see RollsPane)
              faceFilter={faceFilter}
              root={rollRoot}
              onRootChange={changeRollRoot}
              // #174 (§4.39): the selected branch — a header click
              // toggles AND selects; its direct images land in the
              // right-pane thumbnails
              selected={rollBranch}
              onSelect={setRollBranch}
              // #265: the open state — session state, survives the
              // grid round-trip that unmounts the pane
              openSet={rollOpenSet}
              onToggle={toggleRollBranch}
              // #142: opening an image from the path filter is a full
              // view-context change and must honour the #123 drop-or-
              // accept dialog when a staged set is live
              onOpenImage={openThumb}
              // #167 (§4.36): a not-yet-imported directory opens the
              // import pane in the right pane — the path-filter route is
              // always a FRESH import (clear any branch-route initial).
              // #282 (N2): hoisted out of the JSX — an inline arrow here
              // re-rendered the whole visible roll tree on every App
              // render (memo(RollsPane) never held)
              onImportDir={onImportDir}
              // v12.4 (#280)/§4.36: header ⇩ / menu Re-import… route
              onReimport={reimportBranch}
              // v12.4 (#280)/§4.39: the per-branch recursive-grid state
              recursiveSet={rollRecursive}
              onToggleRecursive={toggleRollRecursive}
              onBranchMenu={branchMenu}
            />
          ) : mode === "rolls" && imageId != null && imgRow ? (
            <div className="image-detail">
              {/* #275: the ONE full-image bar (Rolls detail surface) —
                  the film-roll image stepper (rule 46); the #123
                  dialog lives in stepImage */}
              <FullImageBar
                img={imgRow}
                rtype={imgRow.rtype}
                step={stepImage}
                canPrev={
                  branchThumbs.images.length > 0 &&
                  imgStepIdx !== -1 &&
                  imgStepIdx > 0
                }
                canNext={
                  branchThumbs.images.length > 0 &&
                  imgStepIdx !== -1 &&
                  imgStepIdx < branchThumbs.images.length - 1
                }
                total={branchThumbs.images.length}
                pos={imgStepIdx}
                stepNoun="image"
                onRotate={(d) => rotateImg(imgRow.id, d)}
                close={
                  <button className="secondary" onClick={() => setImageId(null)}>
                    ← rolls
                  </button>
                }
              />
              <div className="image-preview">
                <FaceOverlay
                  imageId={imgRow.id}
                  width={imgRow.width}
                  height={imgRow.height}
                  faces={detailFaces}
                  sel={sel}
                  onToggle={rectToggle}
                  onFaceContextMenu={faceMenu}
                  onImageContextMenu={(e) => imageAreaMenu(e, imgRow.id)}
                  rotation={imgRow.rotation} // #122
                />
              </div>
              <FaceGrid sections={sections} sel={sel} inFlight={inFlight}
                stageIdx={stagedIdx} faceDropTarget={faceDropTarget}
                // #225: the image-detail grid windows like the rest
                mountLimit={mountLimit} onNeedMore={growMount}
                {...gridHandlers} primaryFaceId={null} />
            </div>
          ) : (
            <FaceGrid
              sections={sections}
              sel={sel}
              inFlight={inFlight} // #234 (rule 45)
              stageIdx={stagedIdx}
              faceDropTarget={faceDropTarget}
              emptyHint={emptyHint} // #194: guidance instead of bare "nothing to show"
              // #214 + #225: incremental mount on every centre surface —
              // the thousands-of-cards surfaces grow toward the viewport
              mountLimit={mountLimit}
              onNeedMore={growMount}
              {...gridHandlers}
              primaryFaceId={mode === "person" ? selectedPerson?.primary_face_id ?? null : null}
            />
          )}
              </>
            )}
          </div>
          </div>
        </main>

        <div
          className="v-divider"
          role="separator"
          aria-orientation="vertical"
          aria-valuetext={`${rollsBrowse ? rollCenterPx : paneSizes.right}px`}
          tabIndex={0}
          data-owns-keys
          onKeyDown={(e) => dividerKey(e, "right")}
          onMouseDown={startDrag("right")}
          onDoubleClick={() => {
            // #174/§4.39: while browsing Rolls the divider owns the
            // CENTRE — double-click returns to the left-following default
            if (rollsBrowse) setRollCenter(null);
            else setPaneSizes((s) => ({ ...s, right: 290 }));
          }}
          title={
            rollsBrowse
              ? "drag to resize the centre (10–70% of the window), double-click to reset, arrow keys to adjust"
              : "drag to resize, double-click to reset, arrow keys to adjust"
          }
        />
        <aside
          className="right"
          // #174/§4.39: browsing Rolls — the right pane takes the rest
          style={rollsBrowse ? { flex: "1" } : { width: paneSizes.right }}
        >
          {importDir != null ? (
            // #167 (§4.36): the import pane takes the right pane while
            // open; a successful run refreshes the snapshot (the new
            // faces show up in the rolls tree)
            <ImportPane
              dir={importDir}
              // v12.4 (#280): the branch routes pre-check Re-import
              // (initial resets with the pane — see onClose)
              initial={importInitial ?? undefined}
              onClose={() => {
                setImportDir(null);
                setImportInitial(null);
              }}
              onImported={onImported}
            />
          ) : mode === "rolls" && imageId == null ? (
            // #174 (§4.39): browsing the hierarchy → the selected
            // branch's direct images (the import pane keeps precedence
            // above; an OPEN image falls through to DetailPane — §4.37
            // person editing while the face work is on screen)
            <RollsThumbs
              branch={rollBranch}
              images={branchThumbs.images}
              hasSubBranches={branchThumbs.deeper}
              // v12.4 (#280)/§4.39: the branch's recursive-grid state
              recursive={rollRecursive.has(rollBranch)}
              sel={imgSel.sel}
              onClickImage={thumbClick}
              onOpenImage={openThumb}
              onContextMenuImage={imageMenu}
            />
          ) : (
          <DetailPane
            person={displayPerson}
            refcrops={refcrops}
            snapshot={snap}
            faceFilter={faceFilter}
            onName={renameOrMerge}
            onNote={paneNote}
            // #172/#173 (§4.38): the pane's ordered commit — pending
            // name (rename-merge + re-anchor), note, staged group ops
            onUpdate={updatePerson}
            onRemovePerson={paneRemovePerson}
            // v13.0 (#287): the anchored Merge Similar route — the
            // §4.28 triage scoped to the pane's person
            onMergeSimilar={openMergeSimilar}
            // #145: the detail-pane avatar opens the primary face's full
            // image in focus mode — the same confirmContext path as the
            // card double-click / "Open full image" menu entries
            onOpenPrimary={paneOpenPrimary}
            // v14.0 (#288): the reference images are interactive — the
            // context menu routes plus the double-click's Select
            onSelectRefcrop={paneSelectRefcrop}
            onOpenRefcropImage={paneOpenRefcropImage}
            onOpenRefcropRoll={paneOpenRefcropRoll}
            onOpenRefcropRollPath={paneOpenRefcropRollPath}
            onRemoveRefcrop={paneRemoveRefcrop}
          />
          )}
        </aside>
      </div>

      <RuleBar
        count={sel.size}
        verdictInFlight={barInFlight} // #234 (rule 45)
        stageLive={pending.length > 0}
        stageText={pending.length > 0 ? stageSummarySet(pending) : undefined}
        onApply={barApply}
        onAccept={() =>
          pending.length > 0
            ? void commitPending(pending, [...selRef.current]) // #166: ops, then the selection
            : acceptAndNext([...selRef.current])
        }
        onUndo={() => setPending([])} // #123: Undo = Cancel — the whole set
        onAssign={() => openEdit("selection")}
        onReject={() => doReject([...sel])}
        onClear={() => changeSel(new Set())}
      />

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
          onSave={async (s) => {
            await api.setSettings(s).catch((e) => setError(String(e)));
            setSettingsOpen(false);
            await refresh().catch((e) => setError(String(e)));
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
    </div>
  );
}
