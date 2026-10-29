import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import * as api from "./api";
import type { AppearanceGroup, Face, ImageRow, Person, Refcrop, Settings, Snapshot } from "./api";
import EditDialog from "./components/EditDialog";
import ConfirmDialog from "./components/ConfirmDialog";
import { ErrorToast, FatalError, InfoToast } from "./components/ErrorNotice";
import MergeSimilarDialog from "./components/MergeSimilarDialog";
import MergeIntoDialog from "./components/MergeIntoDialog";
import { faceIdsOf } from "./nameCluster";
import { isSeat, type GroupOp } from "./groupList";
import { acceptAdvancePlan, exhaustAdvanceTarget } from "./reviewFlow";
import { faceDragPayload, faceMergePlan } from "./faceDrop";
import FaceMergeDialog from "./components/FaceMergeDialog";
import {
  groupByDescription,
  listedImages,
  matchesStatusFilter,
  personTreeMembers,
  type ClusterGroup,
  type FaceFilter,
} from "./viewFilters";
import { groupPathOptions } from "./components/PathTypeahead";
import {
  buildStage,
  dropStagesForFaces,
  objectInsideSelection,
  stageSummarySet,
  stagedFieldsForCard,
  upsertStage,
  type Prefill,
  type Stage,
  type StageScope,
} from "./stage";
import ContextMenu, { type MenuGroup, type MenuState } from "./components/ContextMenu";
import DetailPane from "./components/DetailPane";
import { useOverlayCount } from "./overlays";
import FaceGrid, { type Section } from "./components/FaceGrid";
import FaceOverlay from "./components/FaceOverlay";
import PersonTree, { orderedVisiblePersonIds } from "./components/PersonTree";
import RollsPane from "./components/RollsPane";
import RollsThumbs from "./components/RollsThumbs";
import ImportPane from "./components/ImportPane";
import RuleBar from "./components/RuleBar";
import SettingsPopover from "./components/SettingsPopover";
import { byFilename, clickImage, emptyImageSel, imageScope, type ImageSel } from "./imageSelect";

type Mode = "review" | "rolls" | "person";

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("review");
  // #175 (§4.40): the Review lock — session-only; engaged pins Show to
  // New (the select is disabled) and widens the exhaust advance to any
  // view; releasing lands in Person mode with Show → All
  const [reviewLock, setReviewLock] = useState(false);
  // #176 (§4.41): the Person-mode guard dialogs — the no-anchor picker
  // pointer (modeless — the tree under it stays clickable) and the
  // sticky-person guard (once per person+filter pair)
  const [pickPersonDialog, setPickPersonDialog] = useState(false);
  const [noFacesDialog, setNoFacesDialog] = useState(false);
  const noFacesKeyRef = useRef("");
  const [personId, setPersonId] = useState<number | null>(null);
  // the pointer dialog follows its purpose: it closes as soon as a
  // person is anchored or the user leaves Person mode
  useEffect(() => {
    if (pickPersonDialog && (personId != null || mode !== "person"))
      setPickPersonDialog(false);
  }, [pickPersonDialog, personId, mode]);
  const [imageId, setImageId] = useState<number | null>(null);
  // #162: the Rolls path-filter root — session state so it survives tab
  // switches (RollsPane unmounts when the view changes); '/' = whole tree
  const [rollRoot, setRollRoot] = useState("/");
  // #174 (§4.39): the selected branch of the Rolls path hierarchy —
  // session state like the root (survives mode switches): absolute
  // path, defaults to the root itself, re-validated when the root
  // changes (a selection outside the new root falls back to it)
  const [rollBranch, setRollBranch] = useState("/");
  // #174 (§4.39): the right-pane thumbnail selection — the §4.23
  // anchor pattern over images; clears when the branch selection
  // changes (a different thumb set)
  const [imgSel, setImgSel] = useState<ImageSel>(emptyImageSel());
  useEffect(() => setImgSel(emptyImageSel()), [rollBranch]);
  const changeRollRoot = (p: string) => {
    setRollRoot(p);
    setRollBranch((prev) =>
      p === "/" || prev === p || prev.startsWith(`${p}/`) ? prev : p
    );
    setImgSel(emptyImageSel());
  };
  // #167 (§4.36): the import pane's directory — session state in the
  // DetailPane's right-pane slot (survives tab switches); null = closed
  const [importDir, setImportDir] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [selPersons, setSelPersons] = useState<Set<number>>(new Set());
  const [confirmRemove, setConfirmRemove] = useState<number[] | null>(null);
  // #98 (§4.31) — hover and "latest selection" are refs: the pointer
  // crossing cards must never re-render the app. The highlight is synced
  // imperatively (data-sync-hover on card + overlay rect) by the
  // mousemove/scroll listener below.
  const hoverRef = useRef<number | null>(null);
  const selRef = useRef<Set<number>>(new Set());
  selRef.current = sel;
  // #98: sections handed to callbacks defined *before* them (the memoised
  // grid handlers) — same latest-value pattern as selRef/hoverRef
  const sectionsRef = useRef<Section[]>([]);
  const sectionsForImageRef = useRef<(imgId: number) => Section[]>(() => []);
  const [splitImageId, setSplitImageId] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // #34 — pane sizes (session state); defaults match the stylesheet
  // (#55: the image-split size is gone — the focus mode takes the pane)
  const [paneSizes, setPaneSizes] = useState({ left: 250, right: 290 });
  // #174 follow-up (§4.39): Rolls mode's CENTRE width while browsing —
  // null = follow the left pane's width (the default: most of the
  // window goes to the right pane's thumbnails, which flex to fill);
  // an explicit px persists for the session. While it applies, the
  // centre|right divider drags the CENTRE instead of the right pane.
  const [rollCenter, setRollCenter] = useState<number | null>(null);
  // the centre shows the HIERARCHY (no image open, no focus split) —
  // the detail views need the full width again (§4.39)
  const rollsBrowse = mode === "rolls" && imageId == null && splitImageId == null;
  // clamp 10%..70% of the window, never past `window − left − 200px`
  // (the right pane keeps a usable floor)
  const clampRollCenter = (px: number) => {
    const w = window.innerWidth;
    const lo = Math.round(w * 0.1);
    const hi = Math.max(Math.min(Math.round(w * 0.7), w - paneSizes.left - 200), lo);
    return Math.min(Math.max(px, lo), hi);
  };
  const rollCenterPx = clampRollCenter(rollCenter ?? paneSizes.left);
  const dragRef = useRef<{ edge: "left" | "right"; startX: number; start: number } | null>(
    null
  );
  const startDrag = (edge: "left" | "right") => (e: ReactMouseEvent) => {
    e.preventDefault();
    // read once at drag start — the layout class must not flip mid-drag
    const browse = rollsBrowse;
    dragRef.current = {
      edge,
      startX: e.clientX,
      start: edge === "right" && browse ? rollCenterPx : paneSizes[edge],
    };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      if (d.edge === "left") {
        setPaneSizes((s) => ({ ...s, left: Math.min(Math.max(d.start + dx, 160), 480) }));
        return;
      }
      if (browse) {
        // #174/§4.39: divider right = centre wider (right pane flexes)
        setRollCenter(clampRollCenter(d.start + dx));
        return;
      }
      setPaneSizes((s) => ({ ...s, right: Math.min(Math.max(d.start - dx, 200), 560) }));
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const [clusters, setClusters] = useState<AppearanceGroup[] | null>(null);
  const [refcrops, setRefcrops] = useState<Refcrop[]>([]);
  // #53 (§4.17): most recently selected card — Ctrl-G's fallback target
  // when nothing is hovered
  const lastSelRef = useRef<number | null>(null);
  // #88 (§4.28): Merge Similar Persons triage + shared merge confirmation
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeInto, setMergeInto] = useState<
    { sourceIds: number[]; targetId?: number } | null
  >(null);
  // #135/#136 (rule 34): face drag & drop — the payload is App-owned
  // (the drag starts in the centre pane and may land in the left pane).
  // Refs mirror the state so the (identity-stable) grid handlers read
  // the live values without taking state into their dependency lists:
  // a drag must not churn the grid memo while it is in flight.
  const [faceDrag, setFaceDrag] = useState<number[] | null>(null);
  const faceDragRef = useRef<number[] | null>(null);
  const [faceDropTarget, setFaceDropTarget] = useState<number | null>(null);
  const faceDropTargetRef = useRef<number | null>(null);
  // #135: a face drag dropped on a person row — face-level merge
  // confirmation (the §4.28 person-level dialog moves whole persons)
  const [faceMerge, setFaceMerge] = useState<
    { faceIds: number[]; targetId: number } | null
  >(null);
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
  const [filter, setFilter] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const refresh = useCallback(async () => {
    setSnap(await api.getSnapshot());
  }, []);

  useEffect(() => {
    refresh().catch((e) => setLoadError(String(e)));
  }, [refresh]);

  // F12: pick up imports/mutations done while the window is in the background
  useEffect(() => {
    const reload = () => {
      if (document.visibilityState !== "hidden") refresh().catch(() => {});
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", reload);
    return () => {
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [refresh]);

  const facesById = useMemo(
    () => new Map((snap?.faces ?? []).map((f) => [f.id, f])),
    [snap]
  );
  const personsById = useMemo(
    () => new Map((snap?.persons ?? []).map((p) => [p.id, p])),
    [snap]
  );
  const selectedPerson = personId != null ? personsById.get(personId) ?? null : null;
  // #99 (§4.10): the status filter — one value drives every view's
  // visibility, tree presence/counts (#28 generalised) and the review set
  const faceFilter = (snap?.settings.face_filter ?? "all") as FaceFilter;
  const clusterGroup = snap?.settings.cluster_group ?? "accuracy";
  const faceVisible = (f: Face) => matchesStatusFilter(f.link_status, faceFilter);
  // #127/#128 → #152, #165 (§4.10): the face-status filter decides the
  // tree's person presence — All now means everything EXCEPT rejected:
  // persons holding ≥ 1 non-rejected face stay (plus the faceless
  // shells, #127/#128), the system person `Rejected` never shows outside
  // Show → Rejected (§4.35); New/Accepted/Rejected list only persons
  // holding ≥ 1 face of that status; the listed badges stay raw totals
  // (#129's badge rule — unchanged, only presence moved)
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
  // doAccept/doReject need the index before their point of use
  const stepIds = useMemo(
    () => orderedVisiblePersonIds(treePersons, filter),
    [treePersons, filter]
  );
  const stepIdx = personId != null ? stepIds.indexOf(personId) : -1;

  // similarity clusters for the person view (Accuracy mode only —
  // Description mode needs no IPC at all, #99)
  useEffect(() => {
    if (
      mode === "person" &&
      personId != null &&
      snap &&
      snap.settings.cluster_group === "accuracy"
    ) {
      api
        .personFaceClusters(personId, snap.settings.cluster_threshold)
        .then(setClusters)
        .catch((e) => setError(String(e)));
    } else {
      setClusters(null);
    }
  }, [mode, personId, snap]);

  // refcrops for the detail pane
  useEffect(() => {
    if (personId == null) {
      setRefcrops([]);
      return;
    }
    api.getRefcrops(personId).then(setRefcrops).catch(() => setRefcrops([]));
  }, [personId, snap]);

  // #25 — Esc closes the double-click image split
  // #138: which overlays are open is ONE registry count, not a list of
  // states — the ladder state list has drifted before (face-merge, tree
  // menus, group dialog were invisible to it)
  const overlayCount = useOverlayCount();
  useEffect(() => {
    // #47/#101 (§4.19 + the Q8 stack): dialogs/menus/popovers own Esc
    // first, then a live stage's preview-undo (F1), then the split —
    // while typing, Esc always cancels the field itself. The #123
    // context-change dialog is one of those dialogs: dropping the set
    // under it both violates the stack and unmounts the dialog
    // mid-dispatch
    if (overlayCount > 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tgt = e.target as HTMLElement | null;
      const typing =
        !!tgt &&
        (tgt.tagName === "INPUT" ||
          tgt.tagName === "TEXTAREA" ||
          tgt.tagName === "SELECT" ||
          tgt.isContentEditable);
      // #187: a queued/open Q4 dialog owns Esc even before the
      // overlayCount chain catches up — preview-undo here would drop the
      // set behind it and unmount the dialog mid-dispatch
      if (contextConfirmRef.current != null && pendingRef.current.length > 0) return;
      if (pendingRef.current.length > 0) {
        if (!typing) {
          setPending([]); // #123: Undo = Cancel — the whole set drops
          e.preventDefault();
        }
        return;
      }
      if (splitImageId != null) setSplitImageId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlayCount, splitImageId]);

  // #133: resolves to whether the operation AND the refresh succeeded —
  // callers may act only on success (errors are still surfaced as the
  // error toast, never thrown)
  const mutate = useCallback(
    async (fn: () => Promise<unknown>, clearSel = false): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await refresh();
        if (clearSel) setSel(new Set());
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  // #122: rotations are server state — command, then refresh
  const rotateImg = useCallback(
    (imageId: number, delta: number) => mutate(() => api.rotateImage(imageId, delta)),
    [mutate]
  );
  // #174 (§4.39): rotate a whole thumbnail scope — one command per
  // image in order, batched into ONE refresh
  const rotateImages = (ids: number[], delta: number) =>
    mutate(async () => {
      for (const id of ids) await api.rotateImage(id, delta);
    });
  const rotateFace = useCallback(
    (faceId: number, delta: number) => mutate(() => api.rotateFace(faceId, delta)),
    [mutate]
  );

  // #123: a selection change INSIDE the context never asks — the
  // Apply → change → Apply loop is dialog-free by design
  const changeSel = useCallback((next: Set<number>) => {
    setSel(next);
  }, []);

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

  // ------------------------------------------------------------ selection

  // #52 (§4.15): the split follows the selection — it closes itself when
  // the selection moves to a different image and stays open while the new
  // selection is on the image it already shows; manual opens always win
  const closeSplitForFaces = useCallback(
    (ids: number[]) => {
      if (splitImageId == null) return;
      if (!ids.some((id) => facesById.get(id)?.image_id === splitImageId))
        setSplitImageId(null);
    },
    [splitImageId, facesById]
  );

  const toggle = useCallback(
    (id: number) => {
      anchorRef.current = id; // #69: the toggled card becomes the range anchor
      closeSplitForFaces([id]);
      const n = new Set(selRef.current);
      if (n.has(id)) n.delete(id);
      else {
        n.add(id);
        lastSelRef.current = id;
      }
      changeSel(n);
    },
    [closeSplitForFaces, changeSel]
  );
  const toggleMany = useCallback(
    (ids: number[], on: boolean) => {
      if (on && ids.length > 0) lastSelRef.current = ids[ids.length - 1];
      const n = new Set(selRef.current);
      ids.forEach((i) => (on ? n.add(i) : n.delete(i)));
      changeSel(n);
    },
    [changeSel]
  );
  // #171 (§4.37) — a rect click in a full-image view toggles the
  // selection as before AND moves the right pane to that face's person:
  // a plain anchor (no context change, no view switch — deliberately
  // not handleTreeSelect's §4.15 yank); a NULL person_id (legacy rows)
  // leaves the anchor untouched. FaceOverlay renders only in the focus
  // split and the rolls detail, so this is scoped to the full-image
  // surfaces by construction.
  const rectToggle = useCallback(
    (id: number) => {
      toggle(id);
      const f = facesById.get(id);
      if (f && f.person_id != null) setPersonId(f.person_id);
    },
    [toggle, facesById]
  );

  // #49 (§4.14) — effective action scope: the active selection when the
  // invoked card is part of it, otherwise just that card. Reads selRef so
  // the callback identity never changes with the selection (#98).
  const actionScope = useCallback((id: number): number[] => {
    const s = selRef.current;
    return s.has(id) && s.size > 1 ? [...s] : [id];
  }, []);

  // ------------------------------------------------------------ mutations

  const doAssign = useCallback(
    (ids: number[], name: string, group: string) =>
      mutate(() => api.assignPerson(ids, name, group), true),
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
  const markExhaust = useCallback(() => {
    // #175/§4.40: under the lock EVERY view's verdicts mark — the
    // workflow drills into a person and their full image before deciding
    if ((mode === "review" || reviewLock) && personId != null) {
      exhaustAtRef.current = stepIdx;
      exhaustPidRef.current = personId;
    }
  }, [mode, personId, stepIdx, reviewLock]);
  // #189/§4.41 — focus follows the verdict: anchor the ACTED-ON person
  // (cursor-as-target §4.25: last selected, else hovered, else the first
  // acted face that has an owner). Called only after the mutation
  // succeeds — and after markExhaust captured its pre-mutation mark —
  // so #148's mark comparison and the §4.30 hand-over are untouched;
  // reject reads the PRE-reject owner on purpose (the person the user
  // acted on, never the system person)
  const focusActed = useCallback(
    (ids: number[]) => {
      const first = [lastSelRef.current, hoverRef.current].find(
        (v) => v != null && ids.includes(v)
      );
      const cands = first != null ? [first, ...ids] : ids;
      for (const id of cands) {
        const pid = facesById.get(id)?.person_id;
        if (pid != null) {
          setPersonId(pid);
          return;
        }
      }
    },
    [facesById]
  );
  const doAccept = useCallback(
    (ids: number[]) => {
      // #165/§4.35: plain accept never un-rejects — a rejected-only scope
      // is inert with guidance (an assignment is the claim path; the
      // Edit dialog claims by staging a NAME, see commitPending)
      if (
        ids.length > 0 &&
        ids.every((id) => facesById.get(id)?.link_status === "rejected")
      ) {
        setInfo("assign a person to bring it back");
        return;
      }
      markExhaust();
      return mutate(() => api.acceptFaces(ids), true).then((ok) => {
        if (ok) focusActed(ids); // #189/§4.41: focus follows the verdict
        return ok;
      });
    },
    [mutate, markExhaust, facesById, focusActed]
  );
  const doReject = useCallback(
    (ids: number[]) => {
      markExhaust();
      // #141 (F2): ops touching the newly-rejected faces are moot (the
      // commit skips rejected faces anyway) — drop them from the staged
      // set, however the rejection was committed (bar ✗, keyboard, card
      // ✗, Edit dialog — the dialog previously handled this itself and
      // the other paths never did)
      setPending((p) => dropStagesForFaces(p, ids));
      return mutate(() => api.rejectFaces(ids), true).then((ok) => {
        if (ok) focusActed(ids); // #189/§4.41
        return ok;
      });
    },
    [mutate, markExhaust, focusActed]
  );
  // #58 (§4.14): per-card inputs honour the same scope — editing the
  // description of a card inside a multi-selection updates the whole
  // selection; applied sequentially because each call re-assigns seq
  // within its new (person, description) group (§4.4) and concurrent
  // transactions could compute the same next seq
  const doPrimary = useCallback(
    (id: number) => {
      const f = facesById.get(id);
      if (f && f.person_id != null) mutate(() => api.setPrimaryFace(f.person_id!, id));
    },
    [facesById, mutate]
  );
  const doRefcrop = useCallback(
    (id: number) => {
      const f = facesById.get(id);
      if (f && f.person_id != null) mutate(() => api.addRefcrop(f.person_id!, id));
    },
    [facesById, mutate]
  );

  // #35 — tree selection: click selects, ctrl/cmd toggles, shift extends
  // over the tree's visible order; the anchor row stays the person shown.
  // #62 — a tree select shifts the attention to that person, so the full
  // image closes whether the person appears in it or not (§4.15); #52's
  // person-relevance check is gone on purpose
  const handleTreeSelect = (id: number, e?: ReactMouseEvent) => {
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
        setMode("person");
        setImageId(null);
      }
    });
  };
  const doRemovePersons = (ids: number[]) => {
    if (ids.length > 0) setConfirmRemove(ids);
  };

  // group argument for rename-style assigns: keep the person's current
  // path (#153) — the old UnknownN force-to-empty (#38/F7) is obsolete
  // now that the importer seeds no 'Unknown' row; a grouped UnknownN
  // keeps their group through a rename, an ungrouped one stays Ungrouped
  // (pure — stable ref)
  const renameGroup = useCallback(
    // #165/§4.35: the system person's seat never prefills a group field;
    // #178 (§4.1 — #153 revised): a STATUS SEAT is never passed either —
    // assign_person validates the path up front (#165), so a seated
    // person's `New` tripped 'reserved group name' before the branch
    // that would have ignored it. "" derives the seat by state instead
    // (the claim confirms the faces ⇒ Accepted), while a REAL group
    // path keeps flowing (#153 — a filed person keeps their path)
    (p: Person | undefined) => {
      const g = p && p.name !== "Rejected" ? p.groups[0] ?? "" : "";
      return isSeat(g) ? "" : g;
    },
    []
  );

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
    [snap, personsById, mutate, doAssign, renameGroup]
  );
  const renameOrMerge = (id: number, n: string) => {
    // §4.38/#172: a rename-merge re-anchors the pane on the surviving
    // person (the merge target) — the origin shell is deleted
    void renameMerge(id, n).then((t) => t != null && setPersonId(t));
  };

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
        if (note.trim() !== (personsById.get(id)?.note ?? "").trim()) {
          const ok = await mutate(() => api.setPersonNote(id, note));
          if (!ok) return false;
        }
        if (ops.length > 0) {
          const ok = await mutate(async () => {
            for (const op of ops)
              await api.movePersonsBetweenGroups([target], op.from, op.to);
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
  const changeFaceFilter = (next: FaceFilter) => {
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
  };
  // #175 (§4.40) — engage the Review lock: pin Show → New through the
  // ordinary filter path, then guard the position — an anchored person
  // without a new face advances to the next person in the step list
  // that has one (forward, else the first; none ⇒ stay + toast)
  const engageLock = () => {
    if (reviewLock) return;
    setReviewLock(true);
    changeFaceFilter("provisional");
    if (personId != null && snap) {
      const has = (id: number) =>
        snap.faces.some((f) => f.person_id === id && f.link_status === "provisional");
      if (!has(personId)) {
        const nextId = exhaustAdvanceTarget(stepIds, personId, stepIdx, has);
        if (nextId != null) setPersonId(nextId);
        else setInfo("no more persons to review");
      }
    }
  };
  // release: Person mode + Show → All, the full image closes, the
  // person anchor stays (the pane shows where the user left off) — a
  // mode switch behind the #123 staged-set confirm (§4.40)
  const releaseLock = () => {
    if (!reviewLock) return;
    setReviewLock(false);
    confirmContext(() => {
      setMode("person");
      setImageId(null);
      if (splitImageId != null) setSplitImageId(null);
      changeFaceFilter("all");
    });
  };
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
  const prefillFor = useCallback(
    (ids: number[]): Prefill => {
      if (ids.length === 0) return {};
      const names = new Set<string>();
      const groups = new Set<string>();
      const descs = new Set<string>();
      for (const id of ids) {
        const f = facesById.get(id);
        const p = f?.person_id != null ? personsById.get(f.person_id) : undefined;
        // #165/§4.35: the system person's reserved name/seat never
        // prefills — a claim needs a typed name (untouched = no stage)
        const system = p?.name === "Rejected";
        names.add(system ? "" : p?.name ?? "");
        groups.add(system ? "" : p?.groups[0] ?? "");
        descs.add(f?.description ?? "");
      }
      const mixed: Prefill["mixed"] = [];
      if (names.size > 1) mixed.push("name");
      if (groups.size > 1) mixed.push("group");
      if (descs.size > 1) mixed.push("desc");
      return {
        ...(names.size === 1 ? { name: [...names][0] } : {}),
        ...(groups.size === 1 ? { group: [...groups][0] } : {}),
        ...(descs.size === 1 ? { desc: [...descs][0] } : {}),
        ...(mixed.length ? { mixed } : {}),
      };
    },
    [facesById, personsById]
  );

  /** Q1/G3 + invocation-site defaults (§4.24): Edit on a card → Card,
      header → Group, bottom bar → Selection */
  const openEdit = useCallback(
    (
      defaultScope: StageScope,
      target?: { card?: number; group?: number[] },
      selectionOverride?: number[]
    ) => {
      if (!snap) return;
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
    [snap, changeSel, prefillFor]
  );

  const faceMenu = useCallback((id: number, e: ReactMouseEvent) => {
    const f = facesById.get(id);
    if (!f) return;
    // #75 (cursor-as-target, generalises #74): with an empty selection
    // the right-clicked card selects automatically — the menu then
    // visibly acts on it and the rule bar / A-R / Ctrl-G all agree
    if (selRef.current.size === 0) {
      anchorRef.current = id;
      lastSelRef.current = id;
      changeSel(new Set([id]));
    }
    const section = sectionsRef.current.find((s) => s.faceIds.includes(id));
    // #49: actions hit the whole selection when this card is part of it
    const scope = actionScope(id);
    const multi = scope.length > 1;
    const label = (s: string) => (multi ? `${s} (${scope.length} selected)` : s);
    openMenu(e, [
      {
        title: "Selection",
        items: [
          {
            // an empty selection just auto-selected this card (#75)
            label: selRef.current.has(id) || selRef.current.size === 0 ? "Deselect" : "Select",
            hint: "Space",
            onClick: () => toggle(id),
          },
          {
            label: "Select whole section",
            hint: "Ctrl-G", // #68: advertise the existing shortcut (#53)
            onClick: () => section && toggleMany(section.faceIds, true),
            disabled: !section,
          },
          { label: "Clear selection", onClick: () => changeSel(new Set()), disabled: selRef.current.size === 0 },
        ],
      },
      {
        title: multi ? `Face — ${scope.length} selected` : "Face",
        items: [
          {
            label: label("Accept"),
            hint: "A",
            onClick: () => doAccept(scope),
          },
          {
            label: label("Reject"),
            hint: "R",
            onClick: () => doReject(scope),
            // reject stays offered while any face of the scope is not rejected
            disabled: !scope.some((sid) => facesById.get(sid)?.link_status !== "rejected"),
            danger: true,
          },
          {
            label: "Set as primary",
            onClick: () => doPrimary(id),
            // single-face action (#49): greyed out for a multi-scope
            disabled: f.person_id == null || multi,
          },
          {
            label: "Add as reference",
            onClick: () => doRefcrop(id),
            disabled: f.link_status !== "confirmed" || f.person_id == null || multi,
          },
          // #122: crop display rotation — per face, independent of the
          // full-image rotation
          {
            label: label("Rotate crop 90° CW"),
            onClick: () => rotateFace(id, 90),
            disabled: multi,
          },
          {
            label: label("Rotate crop 90° CCW"),
            onClick: () => rotateFace(id, -90),
            disabled: multi,
          },
          { label: label("Assign to person…"), onClick: () => openEdit(scope.length > 1 ? "selection" : "card", { card: id }) },
          // #51: pointless while this very image is already open in the split
          ...(f.image_id === splitImageId
            ? []
            : [{
                // #123: opening focus mode is a view-context change;
                // #171/§4.37: the right pane follows the opening face's person
                label: "Open full image",
                onClick: () =>
                  confirmContext(() => {
                    setSplitImageId(f.image_id);
                    if (f.person_id != null) setPersonId(f.person_id);
                  }),
              }]),
        ],
      },
    ]);
  }, [facesById, actionScope, toggle, toggleMany, doAccept, doReject,
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
    const direct = snap.images.filter((x) => dirOf(x.primary_path) === rollBranch);
    const deeper = snap.images.some(
      (x) =>
        listed.has(x.id) &&
        dirOf(x.primary_path) !== rollBranch &&
        x.primary_path.startsWith(under)
    );
    return {
      images: direct.filter((x) => listed.has(x.id)).sort((a, b) => byFilename(a, b)),
      deeper,
    };
  }, [snap, rollBranch, faceFilter]);
  // thumb clicks — §4.23's anchor pattern over the branch's display
  // order (face selection untouched); the pane drops stale ids itself
  const thumbClick = (id: number, mods: { ctrl: boolean; shift: boolean }) =>
    setImgSel((s) => clickImage(s, branchThumbs.images.map((x) => x.id), id, mods));
  // the thumbnail double-click / path-filter file entry: the #142 view-
  // context change behind the #123 drop-or-accept dialog
  const openThumb = (id: number) =>
    confirmContext(() => {
      setMode("rolls");
      setImageId(id);
    });

  const imageAreaMenu = (e: ReactMouseEvent, imageId: number) => {
    if (!snap) return;
    const faces = snap.faces.filter(
      (f) => f.image_id === imageId && faceVisible(f)
    );
    openMenu(e, [
      {
        items: [
          // #144: the promise used to be fire-and-forget — a rejection
          // (no preview blob, viewer not found) never reached the user;
          // errors surface through the standard error toast (#132)
          { label: "Open in system viewer", onClick: () => api.openImage(imageId).catch((e) => setError(String(e))) },
          {
            // #122: stored display rotation (EXIF key, #118)
            label: "Rotate 90° CW",
            onClick: () => rotateImg(imageId, 90),
          },
          {
            label: "Rotate 90° CCW",
            onClick: () => rotateImg(imageId, -90),
          },
          {
            label: "Select all faces",
            onClick: () => changeSel(new Set(faces.map((f) => f.id))),
            disabled: faces.length === 0,
          },
        ],
      },
    ]);
  };

  const imageMenu = (image: ImageRow, e: ReactMouseEvent) => {
    if (!snap) return;
    // #174 (§4.39): the right-pane thumbnails own this menu — scope is
    // the selection when the invoked thumb is part of it, else just
    // that thumb (§4.14); stale ids (outside the branch) are dropped
    const inBranch = new Set(branchThumbs.images.map((x) => x.id));
    const scope = imageScope(imgSel, inBranch, image.id);
    const many = scope.length > 1;
    const faces = snap.faces.filter(
      (f) => f.image_id === image.id && faceVisible(f)
    );
    const pending = faces.filter((f) => f.link_status === "provisional").map((f) => f.id);
    openMenu(e, [
      {
        items: [
          {
            // #123 + #142: opening an image is a full view-context change
            // (the centre pane rebinds to that image's faces) and honours
            // the drop-or-accept dialog exactly like the focused-open
            // entry just below — it never silently carries a staged set
            label: "Open image",
            onClick: () =>
              confirmContext(() => {
                setMode("rolls");
                setImageId(image.id);
              }),
          },
          {
            // #123: opening focus mode is a view-context change
            label: "Open full image (focused)",
            onClick: () => confirmContext(() => setSplitImageId(image.id)),
          },
          // #122: stored display rotation (EXIF key, #118) — over the
          // whole scope (#174/§4.39), one command each in order
          {
            label: many ? `Rotate 90° CW (${scope.length})` : "Rotate 90° CW",
            onClick: () => rotateImages(scope, 90),
          },
          {
            label: many ? `Rotate 90° CCW (${scope.length})` : "Rotate 90° CCW",
            onClick: () => rotateImages(scope, -90),
          },
          {
            // #144: rejections (no preview blob, viewer not found) reach
            // the error toast; one temp file per image of the scope
            label: many ? `Open in system viewer (${scope.length})` : "Open in system viewer",
            onClick: () => {
              for (const id of scope)
                api.openImage(id).catch((err) => setError(String(err)));
            },
          },
        ],
      },
      {
        title: "Faces of this image",
        items: [
          {
            label: "Select all",
            onClick: () => changeSel(new Set(faces.map((f) => f.id))),
            disabled: faces.length === 0,
          },
          { label: "Clear selection", onClick: () => changeSel(new Set()), disabled: sel.size === 0 },
          {
            label: "Accept all pending",
            onClick: () => doAccept(pending),
            disabled: pending.length === 0,
          },
        ],
      },
    ]);
  };

  // ------------------------------------------------------------ sections

  // #69 — anchor + shift-click range selection over the rendered card
  // order (sections render back-to-back, so ranges may span sections)
  const anchorRef = useRef<number | null>(null);
  const renderedIds = useCallback(
    () =>
      (splitImageId != null
        ? sectionsForImageRef.current(splitImageId)
        : sectionsRef.current
      ).flatMap((s) => s.faceIds),
    [splitImageId]
  );
  // plain click: select just this card, drop the anchor
  const selectOnly = useCallback(
    (id: number) => {
      anchorRef.current = id;
      closeSplitForFaces([id]);
      lastSelRef.current = id;
      changeSel(new Set([id]));
    },
    [closeSplitForFaces, changeSel]
  );
  // shift-click: the contiguous range anchor…clicked card; the anchor
  // stays put so repeated shift-clicks re-anchor the same start, the
  // clicked card becomes the new last-selected
  const rangeSelect = useCallback(
    (id: number) => {
      const ids = renderedIds();
      const ai = anchorRef.current == null ? -1 : ids.indexOf(anchorRef.current);
      const ci = ids.indexOf(id);
      if (ai === -1 || ci === -1) {
        // anchor gone (filtered/removed) or card not in this view
        selectOnly(id);
        return;
      }
      const [lo, hi] = ai <= ci ? [ai, ci] : [ci, ai];
      lastSelRef.current = id;
      changeSel(new Set(ids.slice(lo, hi + 1)));
    },
    [renderedIds, selectOnly, changeSel]
  );

  // #97/#98: one suggestion source per snapshot — stable identity
  const personOptions = useMemo(() => snap?.persons ?? [], [snap]);
  const pathOptions = useMemo(() => groupPathOptions(personOptions), [personOptions]);

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
    // #101: the grid's only editable surface — one dialog
    onEditCard: (id: number) => openEdit("card", { card: id }),
    onEditGroup: (ids: number[]) => openEdit("group", { group: ids }),
    // #135/#136 (rule 34): face drag & drop — the live payload is read
    // from refs so these identities (and thus the grid memo) never churn
    // while a drag is in flight
    onFaceDragStart: (id: number, e: ReactDragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", `face ${id}`); // Firefox needs data
      // rule 34: the whole selection when the card is part of one
      const payload = faceDragPayload(selRef.current, id);
      faceDragRef.current = payload;
      setFaceDrag(payload);
    },
    onFaceDragEnd: () => {
      faceDragRef.current = null;
      faceDropTargetRef.current = null;
      setFaceDrag(null);
      setFaceDropTarget(null);
    },
    onFaceDragOver: (id: number, e: ReactDragEvent) => {
      if (!faceDragRef.current) return;
      // #136: the copy source is what the card SHOWS — a live staged
      // value when one is staged on it, else the committed one
      const staged = stagedFieldsForCard(pendingRef.current, id);
      const desc = (staged?.desc ?? facesById.get(id)?.description ?? "").trim();
      if (!desc) return; // nothing to copy — not a target (Q3)
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (faceDropTargetRef.current !== id) {
        faceDropTargetRef.current = id;
        setFaceDropTarget(id);
      }
    },
    onFaceDragLeave: (id: number) => {
      if (faceDropTargetRef.current === id) {
        faceDropTargetRef.current = null;
        setFaceDropTarget(null);
      }
    },
    onFaceDropOnCard: (id: number, e: ReactDragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const payload = faceDragRef.current;
      faceDragRef.current = null;
      faceDropTargetRef.current = null;
      setFaceDrag(null);
      setFaceDropTarget(null);
      if (!payload) return;
      const staged = stagedFieldsForCard(pendingRef.current, id);
      const desc = (staged?.desc ?? facesById.get(id)?.description ?? "").trim();
      if (!desc) return; // double guard — the browser would not have dropped
      const ids = payload.filter((x) => x !== id); // its own desc is a no-op
      if (ids.length === 0) return;
      // one mutate = one refresh; link_status is untouched (a text edit)
      void mutate(async () => {
        for (const x of ids) await api.setFaceDescription(x, desc);
      });
    },
  }), [facesById, personsById, faceMenu, toggle, selectOnly, rangeSelect,
      toggleMany, doPrimary, doRefcrop, doReject, actionScope, openEdit,
      confirmContext, mutate]);

  // one section per person over an image's faces — the Rolls image
  // detail and the #55 focus-mode film roll share it
  const sectionsForImage = useCallback(
    (imgId: number): Section[] => {
      if (!snap) return [];
      const byPerson = new Map<number | null, Face[]>();
      for (const f of snap.faces.filter(
        (x) => x.image_id === imgId && matchesStatusFilter(x.link_status, faceFilter)
      )) {
        const arr = byPerson.get(f.person_id) ?? [];
        arr.push(f);
        byPerson.set(f.person_id, arr);
      }
      return [...byPerson.entries()].map(([pid, fl]) => {
        const p = pid != null ? personsById.get(pid) : undefined;
        return {
          key: `img-${pid}`,
          title: p?.name ?? "unassigned",
          faceIds: fl.map((f) => f.id),
          ruleDefaultName: p?.name,
          // #153: the rename keeps the person's current group path
          ruleDefaultGroup: renameGroup(p),
        };
      });
    },
    [snap, personsById, renameGroup, faceFilter]
  );

  // #98 (§4.31): memoised — computed once per snapshot/view/person/focus
  // change (sectionsForImage is a stable useCallback, so the memo holds),
  // never per render
  const sections: Section[] = useMemo(() => {
    if (!snap) return [];
    if (imageId != null) {
      return sectionsForImage(imageId);
    }
    if (mode === "person" && personId != null) {
      const out: Section[] = [];
      const pname = selectedPerson?.name ?? "";
      const rg = renameGroup(selectedPerson ?? undefined);
      if (clusterGroup === "description") {
        // #99 Description mode: one section per distinct description over
        // the visible faces — no similarity split, no clusters IPC.
        // #155: the §4.24 staged preview drives the grouping too — a face
        // with a staged description is grouped under the description it
        // will land in on Accept (Apply = screen preview), instead of
        // showing the staged label under the old committed section.
        const visible = snap.faces.filter(
          (f) =>
            f.person_id === personId &&
            f.state !== "discarded" &&
            f.link_status !== "rejected" &&
            matchesStatusFilter(f.link_status, faceFilter)
        );
        groupByDescription(
          visible.map((f) => ({
            id: f.id,
            // F2 keeps rejected-touching ops out of the pending set, and
            // rejected faces never reach this branch
            description:
              stagedFieldsForCard(pending, f.id).desc ??
              f.description ??
              ""
          }))
        ).forEach((g) => {
          out.push({
            key: `pd-${personId}-${g.description}`,
            title: g.description || "(no description)",
            description: g.description || undefined,
            faceIds: g.faceIds,
            ruleDefaultName: pname,
            // #153: the rename keeps the person's current group path
            ruleDefaultGroup: rg,
          });
        });
      } else {
        const groups = clusters ?? [];
        const multi = groups.length > 1;
        let n = 0;
        groups.forEach((g, gi) => {
          g.clusters.forEach((cl, ci) => {
            // #99: the filter may empty a cluster — drop it and recompute
            // the similarity claim over the faces that survive
            const ids = cl
              .map((c) => c.face_id)
              .filter((id) => {
                const f = facesById.get(id);
                return f != null && matchesStatusFilter(f.link_status, faceFilter);
              });
            if (ids.length === 0) return;
            n += 1;
            const kept = new Set(ids);
            const minSim = Math.min(
              ...cl.filter((c) => kept.has(c.face_id)).map((c) => c.sim)
            );
            // appearance prefix only when the person has more than one (§4.9)
            const prefix = multi && g.description ? `${g.description} — ` : "";
            out.push({
              key: `cl-${gi}-${ci}`,
              title:
                n === 1
                  ? `${prefix}Group 1 — closest to primary`
                  : `${prefix}Group ${n}`,
              subtitle: `≥ ${Math.round(minSim * 100)}% similar to primary`,
              faceIds: ids,
              ruleDefaultName: pname,
              // #101: the heading's description label shows the
              // appearance (display only — the title stays cluster-derived,
              // F6)
              description: g.description || undefined,
              // #153: the rename keeps the person's current group path
              ruleDefaultGroup: rg,
            });
          });
        });
      }
      if (matchesStatusFilter("rejected", faceFilter)) {
        const rej = snap.faces.filter(
          (f) => f.person_id === personId && f.link_status === "rejected"
        );
        if (rej.length > 0)
          out.push({ key: "rejected", title: "Rejected", faceIds: rej.map((f) => f.id) });
      }
      return out;
    }
    // review: the pending set under All/Provisional (#99), or the status
    // picked in the filter — grouped by importer person, UnknownN first
    const reviewStatus =
      faceFilter === "confirmed" || faceFilter === "rejected" ? faceFilter : "provisional";
    const byPerson = new Map<number | null, Face[]>();
    for (const f of snap.faces.filter((x) => x.link_status === reviewStatus)) {
      const arr = byPerson.get(f.person_id) ?? [];
      arr.push(f);
      byPerson.set(f.person_id, arr);
    }
    const order = [...snap.persons].sort((a, b) => {
      const au = a.name.startsWith("Unknown");
      const bu = b.name.startsWith("Unknown");
      if (au !== bu) return au ? -1 : 1;
      return a.id - b.id;
    });
    return order
      .filter((p) => byPerson.has(p.id))
      .map((p) => ({
        key: `rev-${p.id}`,
        title: p.name,
        subtitle: p.counts.total > byPerson.get(p.id)!.length ? `${p.counts.total} faces total` : undefined,
        faceIds: byPerson.get(p.id)!.map((f) => f.id),
        // #165/§4.35: the system person's reserved name never prefills —
        // committing a claim needs a typed name
        ruleDefaultName: p.name === "Rejected" ? "" : p.name,
        // #153: the rename keeps the person's current group path
        ruleDefaultGroup: renameGroup(p),
      }));
  }, [snap, mode, imageId, personId, selectedPerson, clusters,
      sectionsForImage, renameGroup, facesById, faceFilter, clusterGroup,
      pending]); // #155: staged (§4.24) descriptions drive the regroup
  sectionsRef.current = sections;
  sectionsForImageRef.current = sectionsForImage;

  // #96 (§4.30) — Review mode: accept advances the context; person and
  // focus mode route to the plain accept (context only ever moves by the
  // user's own hand there). The plan comes from the pre-accept sections,
  // which stay valid across the refresh — see reviewFlow.ts.
  const acceptAndNext = useCallback(
    async (ids: number[], claimed = false) => {
      if (!snap) return;
      // #165/§4.35: plain accept never un-rejects — a rejected-only scope
      // is inert with guidance (commitPending passes claimed=true after a
      // staged NAME assignment has already done the claiming)
      if (
        !claimed &&
        ids.length > 0 &&
        ids.every((id) => facesById.get(id)?.link_status === "rejected")
      ) {
        setInfo("assign a person to bring it back");
        return;
      }
      // #175/§4.40: under the Review lock EVERY view takes the marking
      // path — the workflow decides in Person view and full images too
      if ((mode !== "review" || splitImageId != null) && !reviewLock) {
        const ok = await mutate(() => api.acceptFaces(ids), true);
        if (ok) focusActed(ids); // #189/§4.41: focus follows the verdict
        return;
      }
      markExhaust(); // #125: accepting may empty the current person
      const anchor = lastSelRef.current ?? hoverRef.current ?? ids[0] ?? null;
      const actedKey =
        anchor == null
          ? null
          : sections.find((s) => s.faceIds.includes(anchor))?.key ?? null;
      const plan = acceptAdvancePlan(sections, actedKey, ids);
      // #140: the selection rewrite / scroll-to-next used to run
      // unconditionally — a failed accept (error toast from mutate) wiped
      // the selection and pointed the cursor at a plan built from
      // pre-failure state. Everything below runs only on success.
      // (#139: commitPending runs the staged ops before calling this —
      // each op its own mutate so a mid-set failure can be re-staged.)
      const ok = await mutate(() => api.acceptFaces(ids), false);
      if (!ok) return;
      focusActed(ids); // #189/§4.41: post-success, after the pre-mutation mark
      setSel(new Set(plan?.faceIds ?? []));
      const first = plan?.faceIds[0];
      if (first != null) {
        // double-rAF: the refreshed snapshot must have painted first
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            document
              .querySelector(`[data-face-id="${first}"]`)
              ?.scrollIntoView({ block: "nearest" });
          })
        );
      }
    },
    [snap, mode, splitImageId, sections, mutate, markExhaust, facesById, reviewLock, focusActed]
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
    setMode("person");
    setImageId(null);
    // §4.15/#175: the advance ends an open full image/focus — the
    // person on screen is no longer the one shown (stepping closes it too)
    if (splitImageId != null) setSplitImageId(null);
  }, [snap, mode, personId, faceFilter, stepIds, splitImageId]);

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
  const stageOps = useCallback(
    async (st: Stage): Promise<void> => {
      const ids = st.faceIds;
      if (st.name != null) {
        // #77 routing kept: the name path carries the group (create /
        // UnknownN rename); an explicit group also lands when the target
        // person pre-existed (F2: assign_person never touches its group)
        const name = st.name.trim();
        const target = [...personsById.values()].find((p) => p.name === name);
        await api.assignPerson(ids, name, st.group ?? "");
        if (st.group != null && target) await api.setPersonGroup(target.id, st.group);
      } else if (st.group != null) {
        // group-only: set_person_group never validates names — filing an
        // UnknownN cluster into a group without naming it stays possible
        const pids = [
          ...new Set(
            ids
              .map((id) => facesById.get(id)?.person_id)
              .filter((p): p is number => p != null)
          ),
        ];
        if (pids.length === 0) {
          // #165: no writer ever leaves a face unowned — defensive only
          setInfo("nothing to group — these faces have no person");
        } else {
          for (const pid of pids) await api.setPersonGroup(pid, st.group);
        }
      }
      if (st.desc != null) {
        // sequential: each call re-assigns seq in its (person, desc)
        // group (§4.4) — same reason as the old per-card edits
        for (const id of ids) await api.setFaceDescription(id, st.desc);
      }
    },
    [facesById, personsById]
  );

  /** #123/#166 — commit the WHOLE pending set: the ops in order through
      the #77 routing, then accept over the caller's DISPLAYED scope (bar/
      keys: selection or cursor-as-target, dialog: its chosen scope) — the
      staged set supplies the edits only; an empty scope falls back to the
      staged ids. The review advance anchors as before — last-selected,
      hovered, first id) */
  const commitPending = useCallback(
    async (all: Stage[], acceptIds?: number[]) => {
      if (all.length === 0) return;
      // #139: the whole set stays staged until the commit lands — the
      // old code wiped it before the first write, so a mid-commit
      // failure silently discarded every not-yet-applied op (§4.24
      // 'Accept commits every op'; Q3 text is never dropped silently)
      const union = [...new Set(all.flatMap((o) => o.faceIds))];
      let done = 0;
      try {
        for (; done < all.length; done++) {
          await stageOps(all[done]);
        }
      } catch (e) {
        // the applied prefix (ops 1..done−1) is in; the failed op and
        // everything after it stays staged and retryable — Accept again
        // re-runs the idempotent field writes and continues from here
        setError(`Accept stopped at op ${done + 1}/${all.length}: ${e}`);
        setPending(all.slice(done));
        return;
      }
      // a staged NAME assignment already claimed rejected faces (#165) —
      // the advance must not trip the rejected-only guard on stale state
      const claimed = all.some((o) => (o.name ?? "").trim().length > 0);
      // #166: acceptance runs over the caller's displayed scope — the
      // staged set only staged the edits (empty scope ⇒ the staged ids)
      const ids = acceptIds && acceptIds.length > 0 ? acceptIds : union;
      await acceptAndNext(ids, claimed);
      setPending([]);
    },
    [acceptAndNext, stageOps]
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

  // #31 — person stepping: ‹ › and ← → walk the persons in the tree's
  // current (filtered) display order (stepIds/stepIdx declared early —
  // #125); the shortcut set is listed in the settings popover
  // shared cursor position for the cursor-as-target rules (#74/#75/#76)
  const mouseRef = useRef({ x: -1, y: -1 });
  const stepPerson = useCallback(
    (dir: 1 | -1) => {
      // #76 — cursor-as-target (§4.25): with no selected person the
      // person under the mouse cursor anchors the step (mouseRef is the
      // same ref object every render, so this closure never goes stale)
      let base = stepIdx;
      if (base === -1) {
        const el = document.elementFromPoint(
          mouseRef.current.x,
          mouseRef.current.y
        );
        const v = el
          ?.closest("[data-person-id]")
          ?.getAttribute("data-person-id");
        const i = v == null ? -1 : stepIds.indexOf(parseInt(v, 10));
        if (i !== -1) base = i;
      }
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
        setMode("person");
        setImageId(null);
      });
    },
    [stepIdx, stepIds, splitImageId, confirmContext]
  );
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
    const move = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
      recompute();
    };
    window.addEventListener("mousemove", move);
    // scrolling moves cards under a stationary pointer (mouseenter-equivalent)
    window.addEventListener("scroll", recompute, { capture: true, passive: true });
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("scroll", recompute, { capture: true } as EventListenerOptions);
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" ||
          tgt.tagName === "SELECT" || tgt.isContentEditable ||
          // #96: Enter/Space activate a focused button natively — never
          // double them with the shortcuts below
          tgt.tagName === "BUTTON")
      )
        return;
      // an open modal dialog owns the keyboard (Q8 stack): never act
      // behind it — the #138 registry count covers EVERY overlay layer,
      // App-owned or child-owned (the old state list let the face-merge
      // dialog, tree menus/group dialog and the settings popover slip
      // through)
      if (overlayCount > 0) return;
      // #187: same stale-count window as the Esc stack — never act
      // (select-all, Accept, reject, step …) behind a queued/open Q4 dialog
      if (contextConfirmRef.current != null && pendingRef.current.length > 0) return;
      // #53 (§4.17): Ctrl-G toggles the whole section — the one under
      // the mouse cursor first (#74), else the hovered card's, else the
      // most recently selected card's; preventDefault so webkit cannot
      // steal the chord
      if ((e.ctrlKey || e.metaKey) && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        // in focus mode the rendered sections are the film roll's (#55)
        const rendered =
          splitImageId != null ? sectionsForImage(splitImageId) : sections;
        let section = sectionUnderCursor(rendered);
        if (!section) {
          const targetId = hoverRef.current ?? lastSelRef.current;
          if (targetId == null) return;
          section = rendered.find((s) => s.faceIds.includes(targetId));
        }
        if (!section || section.faceIds.length === 0) return;
        const all = section.faceIds.every((id) => sel.has(id));
        toggleMany(section.faceIds, !all);
        return;
      }
      // #68 — core shortcut set: scope follows the hovered/last-selected
      // card (like Ctrl-G); plain letters only, dialogs/menus/inputs above
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        const rendered =
          splitImageId != null ? sectionsForImage(splitImageId) : sections;
        changeSel(new Set(rendered.flatMap((s) => s.faceIds)));
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === " ") {
          const targetId = hoverRef.current ?? lastSelRef.current;
          if (targetId == null) return;
          e.preventDefault();
          toggle(targetId);
        } else if (e.key === "a" || e.key === "A") {
          // §4.30/#166: Accept is stage-then-commit — with a live pending
          // set the keys do what the bottom-bar Accept does: commit the
          // staged ops, then accept the DISPLAYED scope (selection, else
          // the hovered card — cursor-as-target §4.25) with the review
          // advance
          if (pendingRef.current.length > 0) {
            e.preventDefault();
            const ids =
              sel.size > 0 ? [...sel] : hoverRef.current != null ? [hoverRef.current] : [];
            void commitPending(pendingRef.current, ids);
            return;
          }
          // #75: cursor-as-target — the hovered card stands in for the
          // selection when there is none
          const ids =
            sel.size > 0 ? [...sel] : hoverRef.current != null ? [hoverRef.current] : [];
          if (ids.length > 0) {
            e.preventDefault();
            acceptAndNext(ids);          // #96: advances in review mode
          }
        } else if (e.key === "Enter" && mode === "review") {
          // #96 (§4.30): Enter with no field focused = Accept & next —
          // in-field Enter keeps its commit meaning (the guard above
          // already keeps inputs out of this handler) — #166: a live
          // pending set commits its ops, then accepts the displayed scope
          if (pendingRef.current.length > 0) {
            e.preventDefault();
            const ids =
              sel.size > 0 ? [...sel] : hoverRef.current != null ? [hoverRef.current] : [];
            void commitPending(pendingRef.current, ids);
            return;
          }
          const ids =
            sel.size > 0 ? [...sel] : hoverRef.current != null ? [hoverRef.current] : [];
          if (ids.length > 0) {
            e.preventDefault();
            acceptAndNext(ids);
          }
        } else if (e.key === "r" || e.key === "R") {
          const ids =
            sel.size > 0 ? [...sel] : hoverRef.current != null ? [hoverRef.current] : [];
          if (ids.length > 0) {
            e.preventDefault();
            doReject(ids);
          }
        } else if (e.key === "ArrowLeft" && mode !== "rolls") {
          // #95: plain arrows step persons (§4.22/#31) — they were dead
          // because this block returned before the arrow checks;
          // #163 (v3.64): inert in Rolls — stepping always lands in the
          // person view and must not yank a rolls browser away (there
          // the arrows keep their native scroll behaviour)
          e.preventDefault();
          stepPerson(-1);
        } else if (e.key === "ArrowRight" && mode !== "rolls") {
          e.preventDefault();
          stepPerson(1);
        }
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // toggle/toggleMany/doAccept/doReject follow this file's pattern:
    // recreated per render, the handler re-captures them whenever any
    // listed dep changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepPerson, acceptAndNext, commitPending, overlayCount, changeSel, lastSelRef, sections, sectionsForImage, sel, splitImageId, mode, mergeOpen, mergeInto, contextConfirm]);

  const pendingCount = snap?.faces.filter((f) => f.link_status === "provisional").length ?? 0;

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
            "cannot merge into an UnknownN cluster — it is an importer placeholder, not a person (§4.28)",
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
      // the drag is over — clear the payload and highlights (App side)
      faceDragRef.current = null;
      faceDropTargetRef.current = null;
      setFaceDrag(null);
      setFaceDropTarget(null);
      if (!snap) return;
      const target = personsById.get(targetId);
      if (!target) return;
      if (/^unknown/i.test(target.name)) {
        setError(
          "cannot merge into an UnknownN cluster — it is an importer placeholder, not a person (§4.28)",
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
    [snap, personsById],
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

  if (loadError) {
    return <FatalError title="Could not load database" message={loadError} />;
  }
  if (!snap) {
    return <div className="dim center-msg">loading…</div>;
  }

  const imgRow: ImageRow | undefined = imageId != null ? snap.images.find((i) => i.id === imageId) : undefined;
  const splitRow: ImageRow | undefined =
    splitImageId != null ? snap.images.find((i) => i.id === splitImageId) : undefined;

  return (
    <div className="app">
      <header className="topbar">
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
                ? "no person anchored yet — pick one in the tree (#176)"
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
              something the Person view (or any single pane) owns. */}
          <label
            title={
              reviewLock
                ? "Locked to New by the Review lock (#175, §4.40) — release the padlock to change it"
                : "All = everything except rejected; rejected faces appear only under Show → Rejected (#165, §4.10); switching it drops hidden faces from the selection"
            }
          >
            show
            <select
              value={faceFilter}
              disabled={reviewLock}
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
          {/* #175 (§4.40): the Review lock — beside Show; engaged pins
              Show to New and auto-advances past drained persons from any
              view; releasing lands in Person mode with Show → All */}
          <button
            className={`lock-btn${reviewLock ? " locked" : ""}`}
            aria-pressed={reviewLock}
            onClick={reviewLock ? releaseLock : engageLock}
            title={
              reviewLock
                ? "Release the Review lock — Person mode, Show → All (#175, §4.40)"
                : "Engage the Review lock — Show pinned to New; verdicts auto-advance to the next person with new faces (#175, §4.40)"
            }
          >
            {reviewLock ? "🔒" : "🔓"}
          </button>
          {/* #179 (§4.41): the DB-wide status totals — always visible,
              an overview of the database; never scoped to the anchor,
              the mode or the filter */}
          <span className="status-counts" title="totals in the database">
            <span className="c-prov" title="new faces">? {statusTotals.provisional}</span>
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
          <button className="ghost" onClick={() => setSettingsOpen(true)} title="Settings">
            ⚙
          </button>
        </span>
      </header>

      <div className="main">
        <aside className="left" style={{ width: paneSizes.left }}>
          <PersonTree
            persons={treePersons}
            primaryRot={primaryRot}
            selectedId={personId}
            reviewCount={pendingCount}
            filter={filter}
            onFilter={setFilter}
            onReview={() =>
              confirmContext(() => {
                setMode("review");
                setImageId(null);
                setSplitImageId(null); // #55 (§4.19)
              })
            }
            onSelect={handleTreeSelect}
            selectedIds={selPersons}
            onRemovePersons={doRemovePersons}
            onRename={renameOrMerge}
            // #50 (§4.16) — group management: membership only, faces untouched
            onRenameGroup={(oldPath, newPath) => mutate(() => api.renameGroup(oldPath, newPath))}
            onDeleteGroup={(path) => mutate(() => api.deleteGroup(path))}
            onMovePersons={(ids, path, src) => {
              // #157 (v3.59): a tree D&D drop carries the dragged
              // placement's branch path — re-home THAT membership (remove
              // the dragged-from row when the person has it, file into
              // the target; other memberships kept). Same branch → no-op:
              // the person already renders under the target. Without src
              // (dialog paths) the §4.16 replace-all keeps its meaning.
              if (src != null) {
                if (src === path) return;
                void mutate(() => api.movePersonsBetweenGroups(ids, src, path));
                return;
              }
              void mutate(() => api.movePersonsToGroup(ids, path));
            }}
            // #164 (§4.18): 'Add group…' on person rows — ADD a membership
            // (from='' deletes nothing, INSERT OR IGNORE files them; every
            // current group is kept)
            onAddGroup={(ids, path) =>
              void mutate(() => api.movePersonsBetweenGroups(ids, "", path))
            }
            onError={setError}
            onOpenMerge={() => setMergeOpen(true)}
            onMergeInto={openMergeInto}
            // #135 (rule 34): face drags from the centre pane — merge
            // into the dropped person (validation + dialog in App)
            faceDragIds={faceDrag}
            // v3.33: acceptance in the tree reads this ref at event time
            faceDragRef={faceDragRef}
            onDropFaces={onFacesDropped}
            onRenameSelection={renamePersons}
            onSelectPending={(id) => {
              const ids = snap.faces
                .filter((f) => f.person_id === id && f.link_status === "provisional")
                .map((f) => f.id);
              toggleMany(ids, true);
            }}
          />
        </aside>
        <div
          className="v-divider"
          onMouseDown={startDrag("left")}
          onDoubleClick={() => setPaneSizes((s) => ({ ...s, left: 250 }))}
          title="drag to resize, double-click to reset"
        />

        <main
          className={splitRow ? "center focus" : "center"}
          // #174/§4.39: browsing Rolls — the centre holds its explicit
          // width (default = the left pane's); the right pane flexes
          style={rollsBrowse ? { width: rollCenterPx, flex: "none" } : undefined}
        >
          {/* #163 (v3.64): Rolls renders no centre toolbar at all — no
              nav cluster (person stepping always lands in Person — it
              used to yank a rolls browser away), no seg (§4.9); the
              grid gets the pane's full height */}
          {mode !== "rolls" && (
          <div className="center-toolbar">
            <span className="toolbar-left">
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
            </span>
            {/* #99/#100: the cluster-group seg hugs the right side of the
                person view — the Show filter is a global control and lives
                in the top bar (#158, v3.57); #163: person view ONLY —
                cluster_group shapes that view's sections alone, so Review
                and Rolls must not show it */}
            {mode === "person" && (
            <span className="toolbar-right">
            <span
              className="seg"
              title="Person view: how faces form sections — Accuracy = similarity clusters within each description (§4.9); Description = one section per description (threshold ignored)"
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
          )}
          {/* #100: the bar is the pane's real header — only the area below
              it scrolls, so no section content can ever pass above it */}
          <div className="center-scroll">
          <div className={splitRow ? "center-focus" : undefined}>
            {splitRow ? (
              // #55 (§4.19) — full-image focus mode: the annotated image
              // takes the pane's full width, a film roll below shows only
              // this image's faces; the regular grid returns when the mode
              // ends (×/Esc, §4.15 selection move, explicit navigation)
              <div className="focus-pane">
                <div className="focus-top">
                  <span title={splitRow.primary_path}>
                    {splitRow.primary_path.replace(/^.*\//, "") || splitRow.primary_path}
                  </span>
                  <span className="dim">
                    {splitRow.width}×{splitRow.height} · {splitRow.state}
                    {splitRow.rotation ? ` · rotated ${splitRow.rotation}°` : ""}
                  </span>
                  {/* #122: the stored display rotation — button twin of the
                      context-menu entries (rotate once, it sticks) */}
                  <button
                    className="ghost"
                    onClick={() => rotateImg(splitRow.id, 90)}
                    title="Rotate 90° clockwise (stored)"
                  >
                    ⟳
                  </button>
                  <button
                    className="ghost"
                    onClick={() => rotateImg(splitRow.id, -90)}
                    title="Rotate 90° counter-clockwise (stored)"
                  >
                    ⟲
                  </button>
                  <button
                    className="ghost"
                    onClick={() =>
                      confirmContext(() => setSplitImageId(null)) // #123
                    }
                    title="close (Esc)"
                  >
                    ×
                  </button>
                </div>
                <div className="focus-image">
                  <FaceOverlay
                    imageId={splitRow.id}
                    width={splitRow.width}
                    height={splitRow.height}
                    faces={snap.faces.filter((f) => f.image_id === splitRow.id && faceVisible(f))}
                    sel={sel}
                    onToggle={rectToggle}
                    onFaceContextMenu={faceMenu}
                    onImageContextMenu={(e) => imageAreaMenu(e, splitRow.id)}
                    rotation={splitRow.rotation} // #122
                  />
                </div>
                <div className="film-roll">
                  <FaceGrid
                    sections={sectionsForImage(splitRow.id)}
                    sel={sel}
                    stage={pending}
                    faceDropTarget={faceDropTarget}
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
              // #142: opening an image from the path filter is a full
              // view-context change and must honour the #123 drop-or-
              // accept dialog when a staged set is live
              onOpenImage={openThumb}
              // #167 (§4.36): a not-yet-imported directory opens the
              // import pane in the right pane
              onImportDir={(p) => setImportDir(p)}
            />
          ) : mode === "rolls" && imageId != null && imgRow ? (
            <div className="image-detail">
              <div className="image-detail-top">
                <button className="secondary" onClick={() => setImageId(null)}>
                  ← rolls
                </button>
                <div className="image-meta">
                  <div>{imgRow.primary_path}</div>
                  <div className="dim">
                    {imgRow.width}×{imgRow.height} · {imgRow.state}
                    {imgRow.rtype ? ` · ${imgRow.rtype}` : ""}
                  </div>
                </div>
              </div>
              <div className="image-preview">
                <FaceOverlay
                  imageId={imgRow.id}
                  width={imgRow.width}
                  height={imgRow.height}
                  faces={snap.faces.filter((f) => f.image_id === imgRow.id && faceVisible(f))}
                  sel={sel}
                  onToggle={rectToggle}
                  onFaceContextMenu={faceMenu}
                  onImageContextMenu={(e) => imageAreaMenu(e, imgRow.id)}
                  rotation={imgRow.rotation} // #122
                />
              </div>
              <FaceGrid sections={sections} sel={sel} stage={pending} faceDropTarget={faceDropTarget} {...gridHandlers} primaryFaceId={null} />
            </div>
          ) : (
            <FaceGrid
              sections={sections}
              sel={sel}
              stage={pending}
              faceDropTarget={faceDropTarget}
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
          onMouseDown={startDrag("right")}
          onDoubleClick={() => {
            // #174/§4.39: while browsing Rolls the divider owns the
            // CENTRE — double-click returns to the left-following default
            if (rollsBrowse) setRollCenter(null);
            else setPaneSizes((s) => ({ ...s, right: 290 }));
          }}
          title={
            rollsBrowse
              ? "drag to resize the centre (10–70% of the window), double-click to reset"
              : "drag to resize, double-click to reset"
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
              onClose={() => setImportDir(null)}
              onImported={() => void refresh().catch(() => {})}
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
            onNote={(id, n) => mutate(() => api.setPersonNote(id, n))}
            // #172/#173 (§4.38): the pane's ordered commit — pending
            // name (rename-merge + re-anchor), note, staged group ops
            onUpdate={updatePerson}
            onRemovePerson={(id) => doRemovePersons([id])}
            // #145: the detail-pane avatar opens the primary face's full
            // image in focus mode — the same confirmContext path as the
            // card double-click / "Open full image" menu entries
            onOpenPrimary={(fid) => {
              const f = facesById.get(fid);
              if (f) confirmContext(() => setSplitImageId(f.image_id));
            }}
            onRemoveRefcrop={(fid) =>
              personId != null && mutate(() => api.removeRefcrop(personId, fid))
            }
          />
          )}
        </aside>
      </div>

      <RuleBar
        count={sel.size}
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
          onSaveSettings={saveMergeSettings}
          onMergeInto={(ids) => openMergeInto(ids)}
          onApplyGroup={applyGroupToSelection}
          onRename={renamePersons}
          onClose={() => setMergeOpen(false)}
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
          onDone={(r) => {
            const ids =
              r.scope === "card"
                ? edit.card
                : r.scope === "group"
                  ? edit.group
                  : [...selRef.current];
            setEdit(null);
            const st = buildStage(ids, r.values, r.touched);
            if (!st) {
              if (r.kind === "accept") {
                // nothing staged — Accept still accepts the scope (§4.30)
                if (ids.length > 0) void acceptAndNext([...ids]);
                return;
              }
              setInfo("nothing to apply — change a field first (#103)");
              return;
            }
            if (r.kind === "apply") {
              setPending((p) => upsertStage(p, st)); // #123: extend the set
              return;
            }
            // #166: the staged ops commit first, then this dialog's
            // chosen scope is accepted (the set edits, never the scope)
            void commitPending(upsertStage(pendingRef.current, st), ids);
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
        <ConfirmDialog
          title="Unapplied changes"
          body={
            `Staged: ${stageSummarySet(pending)} — accept writes it to the ` +
            "database, discard drops it; the context switches either way (#123)"
          }
          confirmLabel="accept"
          cancelLabel="discard"
          onCancel={() => {
            const act = contextConfirm.fn;
            setContextConfirm(null);
            setPending([]);
            act();
          }}
          onConfirm={() => {
            const all = pending;
            const act = contextConfirm.fn;
            setContextConfirm(null);
            void commitPending(all).then(act);
          }}
        />
      )}
      {/* #176 (§4.41): the Person-mode guard dialogs — the no-anchor
          pointer (single Close) and the sticky-person guard */}
      {pickPersonDialog && (
        <ConfirmDialog
          title="Please select a person in the tree on the left"
          body={
            "Person mode works on the person anchored in the tree — under Show → All " +
            "the status branches New and Accepted are listed (Rejected under Show → Rejected)."
          }
          confirmLabel="Close"
          onlyConfirm
          modeless
          onConfirm={() => setPickPersonDialog(false)}
          onCancel={() => setPickPersonDialog(false)}
        />
      )}
      {noFacesDialog && (
        <ConfirmDialog
          title={
            faceFilter === "all"
              ? "No faces to show"
              : `No ${faceFilter === "provisional" ? "new" : faceFilter === "confirmed" ? "accepted" : "rejected"} faces`
          }
          body={
            `This person holds no face under Show → ${faceFilter === "all" ? "All" : faceFilter === "provisional" ? "New" : faceFilter === "confirmed" ? "Accepted" : "Rejected"}. ` +
            "Show All brings every non-rejected face back."
          }
          cancelLabel="Close"
          confirmLabel="Show All"
          modeless
          onConfirm={() => {
            setNoFacesDialog(false);
            changeFaceFilter("all");
          }}
          onCancel={() => setNoFacesDialog(false)}
        />
      )}
      {confirmRemove && (
        <ConfirmDialog
          title={
            confirmRemove.length > 1
              ? `Remove ${confirmRemove.length} persons`
              : "Remove person"
          }
          body={
            `All faces of ${confirmRemove.length > 1 ? "these persons" : "this person"} ` +
            `become rejected and join the system person Rejected; ` +
            `${confirmRemove.length > 1 ? "the persons are" : "the person is"} deleted — ` +
            "the faces stay in the database and can be claimed again by " +
            "assigning them a person (#165, §4.13). This cannot be undone."
          }
          confirmLabel="remove"
          danger
          onConfirm={() => {
            const ids = confirmRemove;
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
