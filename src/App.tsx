import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import * as api from "./api";
import type { AppearanceGroup, Face, ImageRow, Person, Refcrop, Settings, Snapshot } from "./api";
import AssignDialog from "./components/AssignDialog";
import ConfirmDialog from "./components/ConfirmDialog";
import { ErrorToast, FatalError } from "./components/ErrorNotice";
import MergeSimilarDialog from "./components/MergeSimilarDialog";
import MergeIntoDialog from "./components/MergeIntoDialog";
import { faceIdsOf } from "./nameCluster";
import { acceptAdvancePlan } from "./reviewFlow";
import {
  filterCounts,
  groupByDescription,
  matchesStatusFilter,
  type ClusterGroup,
  type FaceFilter,
} from "./viewFilters";
import { groupPathOptions } from "./components/PathTypeahead";
import FaceAssignDialog from "./components/FaceAssignDialog";
import ContextMenu, { type MenuGroup, type MenuState } from "./components/ContextMenu";
import DetailPane from "./components/DetailPane";
import FaceGrid, { type Section } from "./components/FaceGrid";
import FaceOverlay from "./components/FaceOverlay";
import PersonTree, { orderedVisiblePersonIds } from "./components/PersonTree";
import RollsPane from "./components/RollsPane";
import RuleBar from "./components/RuleBar";
import SettingsPopover from "./components/SettingsPopover";

type View = "review" | "rolls" | "person";

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>("review");
  const [personId, setPersonId] = useState<number | null>(null);
  const [imageId, setImageId] = useState<number | null>(null);
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
  const dragRef = useRef<{ edge: "left" | "right"; startX: number; start: number } | null>(
    null
  );
  const startDrag = (edge: "left" | "right") => (e: ReactMouseEvent) => {
    e.preventDefault();
    dragRef.current = { edge, startX: e.clientX, start: paneSizes[edge] };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      setPaneSizes((s) => {
        if (d.edge === "left") return { ...s, left: Math.min(Math.max(d.start + dx, 160), 480) };
        return { ...s, right: Math.min(Math.max(d.start - dx, 200), 560) };
      });
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
  const [dialogFaceIds, setDialogFaceIds] = useState<number[] | null>(null);
  // #88 (§4.28): Merge Similar Persons triage + shared merge confirmation
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeInto, setMergeInto] = useState<
    { sourceIds: number[]; targetId?: number } | null
  >(null);
  const [faceAssign, setFaceAssign] = useState<{
    faceId: number;
    personId: number | null; // null = unowned face (§4.13)
    name: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
  // a person with no matching face disappears from the tree; the
  // surviving bucket drives its counts (an UnknownN whose only face is
  // filtered out vanishes; #28 clarification)
  const treePersons = useMemo(() => {
    if (!snap) return [];
    if (faceFilter === "all") return snap.persons;
    return snap.persons
      .map((p) => ({ ...p, counts: filterCounts(p.counts, faceFilter) }))
      .filter((p) => p.counts.total > 0);
  }, [snap, faceFilter]);
  const displayPerson = useMemo(
    () => (personId != null ? treePersons.find((p) => p.id === personId) ?? null : null),
    [treePersons, personId]
  );

  // similarity clusters for the person view (Accuracy mode only —
  // Description mode needs no IPC at all, #99)
  useEffect(() => {
    if (
      view === "person" &&
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
  }, [view, personId, snap]);

  // refcrops for the detail pane
  useEffect(() => {
    if (personId == null) {
      setRefcrops([]);
      return;
    }
    api.getRefcrops(personId).then(setRefcrops).catch(() => setRefcrops([]));
  }, [personId, snap]);

  // #25 — Esc closes the double-click image split
  useEffect(() => {
    // #47: overlay layers own the first Esc — the split view must not close
    // while a dialog, the context menu or the settings popover is open
    // (the ones with their own Esc handlers close first, in sequence)
    if (
      splitImageId == null ||
      dialogFaceIds != null ||
      faceAssign != null ||
      confirmRemove != null ||
      menu != null ||
      settingsOpen ||
      mergeOpen ||
      mergeInto != null
    )
      return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSplitImageId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [splitImageId, dialogFaceIds, faceAssign, confirmRemove, menu, settingsOpen, mergeOpen, mergeInto]);

  const mutate = useCallback(
    async (fn: () => Promise<unknown>, clearSel = false) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await refresh();
        if (clearSel) setSel(new Set());
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

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
      setSel((prev) => {
        const n = new Set(prev);
        if (n.has(id)) n.delete(id);
        else {
          n.add(id);
          lastSelRef.current = id;
        }
        return n;
      });
    },
    [closeSplitForFaces]
  );
  const toggleMany = useCallback((ids: number[], on: boolean) => {
    if (on && ids.length > 0) lastSelRef.current = ids[ids.length - 1];
    setSel((prev) => {
      const n = new Set(prev);
      ids.forEach((i) => (on ? n.add(i) : n.delete(i)));
      return n;
    });
  }, []);

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
  const doAccept = useCallback(
    (ids: number[]) => mutate(() => api.acceptFaces(ids), true),
    [mutate]
  );
  const doReject = useCallback(
    (ids: number[]) => mutate(() => api.rejectFaces(ids), true),
    [mutate]
  );
  // #58 (§4.14): per-card inputs honour the same scope — editing the
  // description of a card inside a multi-selection updates the whole
  // selection; applied sequentially because each call re-assigns seq
  // within its new (person, description) group (§4.4) and concurrent
  // transactions could compute the same next seq
  const doDesc = useCallback(
    (id: number, d: string) =>
      mutate(async () => {
        for (const i of actionScope(id)) await api.setFaceDescription(i, d);
      }),
    [actionScope, mutate]
  );
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
      setView("person");
      setImageId(null);
    }
  };
  const doRemovePersons = (ids: number[]) => {
    if (ids.length > 0) setConfirmRemove(ids);
  };

  // group argument for rename-style assigns: an UnknownN must leave the
  // 'Unknown' branch (F7) — the group isn't user-visible in these flows;
  // otherwise the person keeps their current path (pure — stable ref)
  const renameGroup = useCallback(
    (p: Person | undefined) => (p && p.name.startsWith("Unknown") ? "" : (p?.groups[0] ?? "")),
    []
  );

  // rename-merge (v1.9/v1.11): EVERY GUI rename (tree, context menu,
  // detail pane) routes through assign over all the person's faces — a
  // colliding name merges; the 'person already exists' error is
  // unreachable from the GUI
  const renameOrMerge = (id: number, n: string) => {
    if (!snap) return;
    const name = n.trim();
    const p = personsById.get(id);
    if (!name || name === p?.name) return; // empty / no-op: never an error
    const ids = snap.faces.filter((f) => f.person_id === id).map((f) => f.id);
    if (ids.length === 0) {
      // faceless person: rename, or merge-by-deletion when the name is taken
      const taken = snap.persons.some((x) => x.id !== id && x.name === name);
      if (taken) mutate(() => api.removePersons([id]), false);
      else mutate(() => api.setPersonName(id, name));
      return;
    }
    doAssign(ids, name, renameGroup(p));
  };

  // #23/#99 — change the status filter; faces the new filter hides leave
  // the selection so they can never be bulk-acted on invisibly (§4.10)
  const changeFaceFilter = (next: FaceFilter) => {
    if (!snap || next === snap.settings.face_filter) return;
    const visible = new Set(
      snap.faces
        .filter((f) => matchesStatusFilter(f.link_status, next))
        .map((f) => f.id)
    );
    setSel((prev) => {
      let hit = false;
      for (const id of prev)
        if (!visible.has(id)) {
          hit = true;
          break;
        }
      if (!hit) return prev;
      const n = new Set(prev);
      for (const id of [...n]) if (!visible.has(id)) n.delete(id);
      return n;
    });
    mutate(() => api.setSettings({ ...snap.settings, face_filter: next }));
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

  const faceMenu = useCallback((id: number, e: ReactMouseEvent) => {
    const f = facesById.get(id);
    if (!f) return;
    // #75 (cursor-as-target, generalises #74): with an empty selection
    // the right-clicked card selects automatically — the menu then
    // visibly acts on it and the rule bar / A-R / Ctrl-G all agree
    if (selRef.current.size === 0) {
      anchorRef.current = id;
      lastSelRef.current = id;
      setSel(new Set([id]));
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
          { label: "Clear selection", onClick: () => setSel(new Set()), disabled: selRef.current.size === 0 },
        ],
      },
      {
        title: multi ? `Face — ${scope.length} selected` : "Face",
        items: [
          {
            label: label(f.link_status === "rejected" ? "Un-reject (accept)" : "Accept"),
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
          { label: label("Assign to person…"), onClick: () => setDialogFaceIds(scope) },
          // #51: pointless while this very image is already open in the split
          ...(f.image_id === splitImageId
            ? []
            : [{ label: "Open full image", onClick: () => setSplitImageId(f.image_id) }]),
        ],
      },
    ]);
  }, [facesById, actionScope, toggle, toggleMany, doAccept, doReject,
     doPrimary, doRefcrop, splitImageId, openMenu]);

  const imageAreaMenu = (e: ReactMouseEvent, imageId: number) => {
    if (!snap) return;
    const faces = snap.faces.filter(
      (f) => f.image_id === imageId && faceVisible(f)
    );
    openMenu(e, [
      {
        items: [
          { label: "Open in system viewer", onClick: () => api.openImage(imageId) },
          {
            label: "Select all faces",
            onClick: () => setSel(new Set(faces.map((f) => f.id))),
            disabled: faces.length === 0,
          },
        ],
      },
    ]);
  };

  const imageMenu = (image: ImageRow, e: ReactMouseEvent) => {
    if (!snap) return;
    const faces = snap.faces.filter(
      (f) => f.image_id === image.id && faceVisible(f)
    );
    const pending = faces.filter((f) => f.link_status === "provisional").map((f) => f.id);
    openMenu(e, [
      {
        items: [
          {
            label: "Open image",
            onClick: () => {
              setView("rolls");
              setImageId(image.id);
            },
          },
          { label: "Open full image (focused)", onClick: () => setSplitImageId(image.id) },
        ],
      },
      {
        title: "Faces of this image",
        items: [
          {
            label: "Select all",
            onClick: () => setSel(new Set(faces.map((f) => f.id))),
            disabled: faces.length === 0,
          },
          { label: "Clear selection", onClick: () => setSel(new Set()), disabled: sel.size === 0 },
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
      setSel(new Set([id]));
    },
    [closeSplitForFaces]
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
      setSel(new Set(ids.slice(lo, hi + 1)));
    },
    [renderedIds, selectOnly]
  );

  // #97/#98: one suggestion source per snapshot — stable identity
  const personOptions = useMemo(() => snap?.persons ?? [], [snap]);
  const pathOptions = useMemo(() => groupPathOptions(personOptions), [personOptions]);

  // #98 (§4.31): the card handlers are ONE memo — identity changes only
  // when their inputs do (never per hover, never per selection change:
  // sel/hover/sections are read through refs), which is what lets
  // memo(FaceCard) skip untouched cards
  const gridHandlers = useMemo(() => ({
    faces: facesById,
    persons: personsById,
    personOptions,
    pathOptions,
    onContextMenu: faceMenu,
    onAssignName: (faceId: number, name: string) => {
      if (!snap) return;
      const f = facesById.get(faceId);
      if (!f) return;
      // #58/#59 (§4.14): per-card inputs honour the selection scope —
      // an active selection *of any size* is the disambiguation, so the
      // just-this-face/whole-group dialog is skipped and the assign
      // applies to the whole selection (group paths: unowned faces have
      // none, the rest keep their current person's path); the dialog is
      // left to its original role — cards outside any selection
      const scope = actionScope(faceId);
      if (selRef.current.has(faceId)) {
        doAssign(
          scope,
          name,
          f.person_id != null ? renameGroup(personsById.get(f.person_id)) : ""
        );
        return;
      }
      if (f.person_id == null) {
        // unowned face (§4.13): nothing to disambiguate — assign directly
        doAssign([faceId], name, "");
        return;
      }
      const groupCount = snap.faces.filter((x) => x.person_id === f.person_id).length;
      if (groupCount <= 1) {
        // single-face group: whole group == this face — short-circuit the
        // dialog, but keep the person's group path (rename-in-place, §1.10)
        doAssign([faceId], name, renameGroup(personsById.get(f.person_id)));
        return;
      }
      setFaceAssign({ faceId, personId: f.person_id, name });
    },
    onToggle: toggle,
    onSelectOne: selectOnly,
    onRangeSelect: rangeSelect,
    onOpen: (id: number) => {
      const f = facesById.get(id);
      if (f) setSplitImageId(f.image_id);
    },
    onToggleMany: toggleMany,
    onDescription: doDesc,
    onPrimary: doPrimary,
    onRefcrop: doRefcrop,
    // #49 (§4.14): the card's ✗/undo honours the effective scope — the
    // same ids the rule-bar buttons act on
    onReject: (id: number) => doReject(actionScope(id)),
    onAccept: (id: number) => doAccept(actionScope(id)),
    // #77 — the header rule inputs: name changes keep the assign_person
    // path (accept + name, group applied on create/UnknownN-rename);
    // *group-only* edits bypass it entirely — assign_person never
    // touches an existing person's group (F2) and rejects UnknownN
    // names, which is exactly what made the group input a no-op
    onAssign: (
      ids: number[],
      name: string,
      group: string,
      nameChanged: boolean,
      groupChanged: boolean
    ) => {
      if (!nameChanged && !groupChanged) return;
      if (!nameChanged) {
        // regroup the persons owning the scope directly — this also
        // serves 'remember the face, not the name': an UnknownN cluster
        // can be filed into a group as-is (set_person_group never
        // validates names)
        const pids = [
          ...new Set(
            ids
              .map((id) => facesById.get(id)?.person_id)
              .filter((p): p is number => p != null)
          ),
        ];
        if (pids.length === 0) {
          setError("type a name first — unowned faces have no person to group");
          return;
        }
        const unowned = ids.length -
          ids.filter((id) => facesById.get(id)?.person_id != null).length;
        mutate(async () => {
          for (const pid of pids) await api.setPersonGroup(pid, group);
        }, true).then(() => {
          if (unowned > 0)
            setError(`${unowned} unowned face(s) skipped — assign a name to group them`);
        });
        return;
      }
      // name changed: an explicitly typed group must also land when the
      // target person pre-existed (assign_person drops it, F2)
      const target = [...personsById.values()].find(
        (p) => p.name === name.trim()
      );
      mutate(async () => {
        await api.assignPerson(ids, name, group);
        if (groupChanged && target) await api.setPersonGroup(target.id, group);
      }, true);
    },
  }), [snap, facesById, personsById, personOptions, pathOptions, actionScope,
      toggle, toggleMany, selectOnly, rangeSelect, doAssign,
      doAccept, doReject, doDesc, doPrimary, doRefcrop, faceMenu, renameGroup,
      mutate]);

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
          // #38: an UnknownN must leave the Unknown branch on rename
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
    if (view === "person" && personId != null) {
      const out: Section[] = [];
      const pname = selectedPerson?.name ?? "";
      const rg = renameGroup(selectedPerson ?? undefined);
      if (clusterGroup === "description") {
        // #99 Description mode: one section per distinct description over
        // the visible faces — no similarity split, no clusters IPC
        const visible = snap.faces.filter(
          (f) =>
            f.person_id === personId &&
            f.state !== "discarded" &&
            f.link_status !== "rejected" &&
            matchesStatusFilter(f.link_status, faceFilter)
        );
        groupByDescription(visible).forEach((g) => {
          out.push({
            key: `pd-${personId}-${g.description}`,
            title: g.description || "(no description)",
            faceIds: g.faceIds,
            ruleDefaultName: pname,
            // #38: an UnknownN must leave the Unknown branch on rename
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
              // #38: an UnknownN must leave the Unknown branch on rename
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
          out.push({ key: "rejected", title: "Rejected (undo to accept)", faceIds: rej.map((f) => f.id) });
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
        ruleDefaultName: p.name,
        // #38: review sections come from UnknownN importer clusters — a
        // rename must leave the Unknown branch (F7)
        ruleDefaultGroup: renameGroup(p),
      }));
  }, [snap, view, imageId, personId, selectedPerson, clusters,
      sectionsForImage, renameGroup, facesById, faceFilter, clusterGroup]);
  sectionsRef.current = sections;
  sectionsForImageRef.current = sectionsForImage;

  // #96 (§4.30) — Review mode: accept advances the context; person and
  // focus mode route to the plain accept (context only ever moves by the
  // user's own hand there). The plan comes from the pre-accept sections,
  // which stay valid across the refresh — see reviewFlow.ts.
  const acceptAndNext = useCallback(
    async (ids: number[]) => {
      if (!snap) return;
      if (view !== "review" || splitImageId != null) {
        await mutate(() => api.acceptFaces(ids), true);
        return;
      }
      const anchor = lastSelRef.current ?? hoverRef.current ?? ids[0] ?? null;
      const actedKey =
        anchor == null
          ? null
          : sections.find((s) => s.faceIds.includes(anchor))?.key ?? null;
      const plan = acceptAdvancePlan(sections, actedKey, ids);
      await mutate(() => api.acceptFaces(ids), false);
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
    [snap, view, splitImageId, sections, mutate]
  );

  // #31 — person stepping: ‹ › and ← → walk the persons in the tree's
  // current (filtered) display order; the shortcut set is listed in the
  // settings popover
  const [filter, setFilter] = useState("");
  // shared cursor position for the cursor-as-target rules (#74/#75/#76)
  const mouseRef = useRef({ x: -1, y: -1 });
  const stepIds = useMemo(
    () => orderedVisiblePersonIds(treePersons, filter),
    [treePersons, filter]
  );
  const stepIdx = personId != null ? stepIds.indexOf(personId) : -1;
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
      // select; #52's relevance check dropped)
      if (splitImageId != null) setSplitImageId(null);
      setPersonId(id);
      setView("person");
      setImageId(null);
    },
    [stepIdx, stepIds, splitImageId]
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
      if (
        dialogFaceIds != null ||
        faceAssign != null ||
        confirmRemove != null ||
        menu != null ||
        mergeOpen ||
        mergeInto != null
      )
        return;
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
        setSel(new Set(rendered.flatMap((s) => s.faceIds)));
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === " ") {
          const targetId = hoverRef.current ?? lastSelRef.current;
          if (targetId == null) return;
          e.preventDefault();
          toggle(targetId);
        } else if (e.key === "a" || e.key === "A") {
          // #75: cursor-as-target — the hovered card stands in for the
          // selection when there is none
          const ids =
            sel.size > 0 ? [...sel] : hoverRef.current != null ? [hoverRef.current] : [];
          if (ids.length > 0) {
            e.preventDefault();
            acceptAndNext(ids);          // #96: advances in review mode
          }
        } else if (e.key === "Enter" && view === "review") {
          // #96 (§4.30): Enter with no field focused = Accept & next —
          // in-field Enter keeps its commit meaning (the guard above
          // already keeps inputs out of this handler)
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
        } else if (e.key === "ArrowLeft") {
          // #95: plain arrows step persons (§4.22/#31) — they were dead
          // because this block returned before the arrow checks
          e.preventDefault();
          stepPerson(-1);
        } else if (e.key === "ArrowRight") {
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
  }, [stepPerson, acceptAndNext, dialogFaceIds, faceAssign, confirmRemove, lastSelRef, sections, sectionsForImage, sel, splitImageId, view, mergeOpen, mergeInto]);

  const pendingCount = snap?.faces.filter((f) => f.link_status === "provisional").length ?? 0;

  // ------------------------------------------------------------ dialog prefill

  const dialogPrefill = useMemo(() => {
    if (!dialogFaceIds) return { name: "", group: "" };
    const pids = new Set(dialogFaceIds.map((id) => facesById.get(id)?.person_id));
    if (pids.size === 1) {
      const p = personsById.get(pids.values().next().value as number);
      if (p) return { name: p.name, group: p.groups[0] ?? "" };
    }
    return { name: "", group: "" };
  }, [dialogFaceIds, facesById, personsById]);

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
          setError("already merged — the drop target is the only selection");
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
        setError("nothing to merge — the selected persons have no faces");
        return;
      }
      // one assign_person call = one transaction, §4.1 merge semantics
      // (sticky rejected, emptied shells deleted, derived state recomputed)
      await mutate(() => api.assignPerson(faceIds, target.name, target.groups[0] ?? ""));
    },
    [snap, mergeInto, mutate],
  );

  /** bulk rename/merge over a person selection: open the existing
      AssignDialog over all their faces (§4.1 rename-merge) */
  const renamePersons = useCallback(
    (ids: number[]) => {
      if (!snap) return;
      const faceIds = faceIdsOf(snap.faces, new Set(ids));
      if (faceIds.length === 0) {
        setError("no faces to rename — the selection has no faces");
        return;
      }
      setDialogFaceIds(faceIds);
    },
    [snap],
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
            className={view === "review" ? "active" : ""}
            onClick={() => {
              setView("review");
              setImageId(null);
              setSplitImageId(null); // #55 (§4.19): explicit navigation ends focus mode
            }}
          >
            Review <span className="pill">{pendingCount}</span>
          </button>
          <button
            className={view === "rolls" ? "active" : ""}
            onClick={() => {
              setView("rolls");
              setSplitImageId(null); // #55 (§4.19)
            }}
          >
            Rolls
          </button>
          <button
            className={view === "person" ? "active" : ""}
            disabled={personId == null}
            onClick={() => {
              setView("person");
              setImageId(null);
              setSplitImageId(null); // #55 (§4.19)
            }}
            title={personId == null ? "select a person in the tree" : ""}
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
            selectedId={personId}
            reviewCount={pendingCount}
            filter={filter}
            onFilter={setFilter}
            onReview={() => {
              setView("review");
              setImageId(null);
              setSplitImageId(null); // #55 (§4.19)
            }}
            onSelect={handleTreeSelect}
            selectedIds={selPersons}
            onRemovePersons={doRemovePersons}
            onRename={renameOrMerge}
            // #50 (§4.16) — group management: membership only, faces untouched
            onRenameGroup={(oldPath, newPath) => mutate(() => api.renameGroup(oldPath, newPath))}
            onDeleteGroup={(path) => mutate(() => api.deleteGroup(path))}
            onMovePersons={(ids, path) => mutate(() => api.movePersonsToGroup(ids, path))}
            onError={setError}
            onOpenMerge={() => setMergeOpen(true)}
            onMergeInto={openMergeInto}
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

        <main className={splitRow ? "center focus" : "center"}>
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
            {/* #99: cluster group (persons mode) left of the status filter */}
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
            <label title="Status filter — every view shows only faces with this status (#99, §4.10); switching it drops hidden faces from the selection">
              show
              <select
                value={faceFilter}
                onChange={(e) => changeFaceFilter(e.target.value as FaceFilter)}
              >
                <option value="all">All</option>
                <option value="provisional">New</option>
                <option value="confirmed">Accepted</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
          </div>
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
                  </span>
                  <button
                    className="ghost"
                    onClick={() => setSplitImageId(null)}
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
                    onToggle={toggle}
                    onFaceContextMenu={faceMenu}
                    onImageContextMenu={(e) => imageAreaMenu(e, splitRow.id)}
                  />
                </div>
                <div className="film-roll">
                  <FaceGrid
                    sections={sectionsForImage(splitRow.id)}
                    sel={sel}
                    {...gridHandlers}
                    primaryFaceId={displayPerson?.primary_face_id ?? null}
                  />
                </div>
              </div>
            ) : (
              <>
          {view === "rolls" && imageId == null ? (
            <RollsPane
              imports={snap.imports}
              images={snap.images}
              faces={snap.faces}
              onOpenImage={(id) => setImageId(id)}
              onContextMenuImage={imageMenu}
            />
          ) : view === "rolls" && imageId != null && imgRow ? (
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
                  onToggle={toggle}
                  onFaceContextMenu={faceMenu}
                  onImageContextMenu={(e) => imageAreaMenu(e, imgRow.id)}
                />
              </div>
              <FaceGrid sections={sections} sel={sel} {...gridHandlers} primaryFaceId={null} />
            </div>
          ) : (
            <FaceGrid
              sections={sections}
              sel={sel}
              {...gridHandlers}
              primaryFaceId={view === "person" ? selectedPerson?.primary_face_id ?? null : null}
            />
          )}
              </>
            )}
          </div>
        </main>

        <div
          className="v-divider"
          onMouseDown={startDrag("right")}
          onDoubleClick={() => setPaneSizes((s) => ({ ...s, right: 290 }))}
          title="drag to resize, double-click to reset"
        />
        <aside className="right" style={{ width: paneSizes.right }}>
          <DetailPane
            person={displayPerson}
            refcrops={refcrops}
            snapshot={snap}
            faceFilter={faceFilter}
            onName={renameOrMerge}
            onGroup={(id, g) => mutate(() => api.setPersonGroup(id, g))}
            onNote={(id, n) => mutate(() => api.setPersonNote(id, n))}
            onRemovePerson={(id) => doRemovePersons([id])}
            onSetPrimary={(fid) =>
              personId != null && mutate(() => api.setPrimaryFace(personId, fid))
            }
            onRemoveRefcrop={(fid) =>
              personId != null && mutate(() => api.removeRefcrop(personId, fid))
            }
          />
        </aside>
      </div>

      <RuleBar
        count={sel.size}
        onAssign={() => setDialogFaceIds([...sel])}
        onAccept={() => acceptAndNext([...sel])}   // #96: advances in review
        onReject={() => doReject([...sel])}
        onClear={() => setSel(new Set())}
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
          escActive={mergeInto == null && dialogFaceIds == null}
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
      {dialogFaceIds && (
        <AssignDialog
          count={dialogFaceIds.length}
          defaultName={dialogPrefill.name}
          defaultGroup={dialogPrefill.group}
          persons={snap?.persons ?? []}
          onSubmit={(n, g) => {
            const ids = dialogFaceIds;
            setDialogFaceIds(null);
            doAssign(ids, n, g);
          }}
          onCancel={() => setDialogFaceIds(null)}
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
      {faceAssign && (
        <FaceAssignDialog
          name={faceAssign.name}
          groupCount={
            faceAssign.personId != null
              ? snap.faces.filter((f) => f.person_id === faceAssign.personId).length
              : null
          }
          onSingle={() => {
            const a = faceAssign;
            setFaceAssign(null);
            doAssign([a.faceId], a.name, "");
          }}
          onGroup={() => {
            const a = faceAssign;
            setFaceAssign(null);
            const ids = snap.faces
              .filter((f) => f.person_id === a.personId)
              .map((f) => f.id);
            doAssign(
              ids,
              a.name,
              renameGroup(a.personId != null ? personsById.get(a.personId) : undefined)
            );
          }}
          onCancel={() => setFaceAssign(null)}
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
            `become rejected and ${confirmRemove.length > 1 ? "the persons are" : "the person is"} ` +
            "deleted — the faces stay in the database as rejected, unowned records " +
            "and can be claimed again. This cannot be undone."
          }
          confirmLabel="remove"
          danger
          onConfirm={() => {
            const ids = confirmRemove;
            setConfirmRemove(null);
            setSelPersons((prev) => {
              const n = new Set(prev);
              for (const id of ids) n.delete(id);
              return n;
            });
            if (personId != null && ids.includes(personId)) {
              setPersonId(null);
              setView("review");
            }
            mutate(() => api.removePersons(ids), true);
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      {error && <ErrorToast message={error} onDismiss={() => setError(null)} />}
    </div>
  );
}
