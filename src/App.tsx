import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import * as api from "./api";
import type { AppearanceGroup, Face, ImageRow, Person, Refcrop, Snapshot } from "./api";
import AssignDialog from "./components/AssignDialog";
import ConfirmDialog from "./components/ConfirmDialog";
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
  const [hoverId, setHoverId] = useState<number | null>(null);
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
  // #28: with show_rejected off, a rejected face is not up for review —
  // persons whose faces are ALL rejected disappear from the tree entirely
  // (an UnknownN with a single rejected face vanishes; #28 clarification)
  const treePersons = useMemo(() => {
    if (!snap) return [];
    if (snap.settings.show_rejected) return snap.persons;
    return snap.persons
      .filter((p) => p.counts.total - p.counts.rejected > 0)
      .map((p) => ({
        ...p,
        counts: { ...p.counts, total: p.counts.total - p.counts.rejected, rejected: 0 },
      }));
  }, [snap]);
  const displayPerson = useMemo(
    () => (personId != null ? treePersons.find((p) => p.id === personId) ?? null : null),
    [treePersons, personId]
  );
  const showRejected = snap?.settings.show_rejected ?? true;
  const faceVisible = (f: Face) => showRejected || f.link_status !== "rejected";

  // similarity clusters for the person view (recomputed on threshold/snap change)
  useEffect(() => {
    if (view === "person" && personId != null && snap) {
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
      settingsOpen
    )
      return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSplitImageId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [splitImageId, dialogFaceIds, faceAssign, confirmRemove, menu, settingsOpen]);

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
  const closeSplitForFaces = (ids: number[]) => {
    if (splitImageId == null) return;
    if (!ids.some((id) => facesById.get(id)?.image_id === splitImageId))
      setSplitImageId(null);
  };
  const closeSplitForPerson = (pid: number) => {
    if (splitImageId == null) return;
    const relevant =
      snap?.faces.some((f) => f.person_id === pid && f.image_id === splitImageId) ?? false;
    if (!relevant) setSplitImageId(null);
  };

  const toggle = (id: number) => {
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
  };
  const toggleMany = (ids: number[], on: boolean) => {
    if (on && ids.length > 0) lastSelRef.current = ids[ids.length - 1];
    setSel((prev) => {
      const n = new Set(prev);
      ids.forEach((i) => (on ? n.add(i) : n.delete(i)));
      return n;
    });
  };

  // #49 (§4.14) — effective action scope: the active selection when the
  // invoked card is part of it, otherwise just that card
  const actionScope = (id: number): number[] =>
    sel.has(id) && sel.size > 1 ? [...sel] : [id];

  // ------------------------------------------------------------ mutations

  const doAssign = (ids: number[], name: string, group: string) =>
    mutate(() => api.assignPerson(ids, name, group), true);
  const doAccept = (ids: number[]) => mutate(() => api.acceptFaces(ids), true);
  const doReject = (ids: number[]) => mutate(() => api.rejectFaces(ids), true);
  // #58 (§4.14): per-card inputs honour the same scope — editing the
  // description of a card inside a multi-selection updates the whole
  // selection; applied sequentially because each call re-assigns seq
  // within its new (person, description) group (§4.4) and concurrent
  // transactions could compute the same next seq
  const doDesc = (id: number, d: string) =>
    mutate(async () => {
      for (const i of actionScope(id)) await api.setFaceDescription(i, d);
    });
  const doPrimary = (id: number) => {
    const f = facesById.get(id);
    if (f && f.person_id != null) mutate(() => api.setPrimaryFace(f.person_id!, id));
  };
  const doRefcrop = (id: number) => {
    const f = facesById.get(id);
    if (f && f.person_id != null) mutate(() => api.addRefcrop(f.person_id!, id));
  };

  // #35 — tree selection: click selects, ctrl/cmd toggles, shift extends
  // over the tree's visible order; the anchor row stays the person shown
  const handleTreeSelect = (id: number, e?: ReactMouseEvent) => {
    closeSplitForPerson(id); // #52
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

  // #23 — show/hide rejected faces; faces hidden this way leave the
  // selection so they can never be bulk-acted on invisibly (§4.10)
  const toggleShowRejected = () => {
    if (!snap) return;
    const next = !snap.settings.show_rejected;
    if (!next) {
      const hidden = new Set(
        snap.faces.filter((f) => f.link_status === "rejected").map((f) => f.id)
      );
      setSel((prev) => {
        let hit = false;
        for (const id of prev)
          if (hidden.has(id)) {
            hit = true;
            break;
          }
        if (!hit) return prev;
        const n = new Set(prev);
        for (const id of hidden) n.delete(id);
        return n;
      });
    }
    mutate(() => api.setSettings({ ...snap.settings, show_rejected: next }));
  };

  // #32 — tile context menus; full images keep the default webview menu (#33)
  const openMenu = useCallback((e: ReactMouseEvent, groups: MenuGroup[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, groups });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const faceMenu = (id: number, e: ReactMouseEvent) => {
    const f = facesById.get(id);
    if (!f) return;
    const section = sections.find((s) => s.faceIds.includes(id));
    // #49: actions hit the whole selection when this card is part of it
    const scope = actionScope(id);
    const multi = scope.length > 1;
    const label = (s: string) => (multi ? `${s} (${scope.length} selected)` : s);
    openMenu(e, [
      {
        title: "Selection",
        items: [
          { label: sel.has(id) ? "Deselect" : "Select", onClick: () => toggle(id) },
          {
            label: "Select whole section",
            onClick: () => section && toggleMany(section.faceIds, true),
            disabled: !section,
          },
          { label: "Clear selection", onClick: () => setSel(new Set()), disabled: sel.size === 0 },
        ],
      },
      {
        title: multi ? `Face — ${scope.length} selected` : "Face",
        items: [
          {
            label: label(f.link_status === "rejected" ? "Un-reject (accept)" : "Accept"),
            onClick: () => doAccept(scope),
          },
          {
            label: label("Reject"),
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
  };

  const imageAreaMenu = (e: ReactMouseEvent, imageId: number) => {
    if (!snap) return;
    const faces = snap.faces.filter(
      (f) =>
        f.image_id === imageId &&
        (snap.settings.show_rejected || f.link_status !== "rejected")
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
      (f) =>
        f.image_id === image.id &&
        (snap.settings.show_rejected || f.link_status !== "rejected")
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

  const gridHandlers = {
    faces: facesById,
    persons: personsById,
    sel,
    hoverId,
    onHover: setHoverId,
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
      if (sel.has(faceId)) {
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
    onAssign: (ids: number[], name: string, group: string) => doAssign(ids, name, group),
  };

  // one section per person over an image's faces — the Rolls image
  // detail and the #55 focus-mode film roll share it
  const sectionsForImage = useCallback(
    (imgId: number): Section[] => {
      if (!snap) return [];
      const byPerson = new Map<number | null, Face[]>();
      for (const f of snap.faces.filter(
        (x) =>
          x.image_id === imgId &&
          (snap.settings.show_rejected || x.link_status !== "rejected")
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
    [snap, personsById, renameGroup]
  );

  // plain (unmemoised) on purpose: sectionsForImage is recreated per
  // render and the #55 film roll needs it too — one pass over faces
  const sections: Section[] = (() => {
    if (!snap) return [];
    if (imageId != null) {
      return sectionsForImage(imageId);
    }
    if (view === "person" && personId != null) {
      const out: Section[] = [];
      const pname = selectedPerson?.name ?? "";
      const groups = clusters ?? [];
      const multi = groups.length > 1;
      let n = 0;
      groups.forEach((g, gi) => {
        g.clusters.forEach((cl, ci) => {
          if (cl.length === 0) return;
          n += 1;
          const minSim = Math.min(...cl.map((c) => c.sim));
          // appearance prefix only when the person has more than one (§4.9)
          const prefix = multi && g.description ? `${g.description} — ` : "";
          out.push({
            key: `cl-${gi}-${ci}`,
            title:
              n === 1
                ? `${prefix}Group 1 — closest to primary`
                : `${prefix}Group ${n}`,
            subtitle: `≥ ${Math.round(minSim * 100)}% similar to primary`,
            faceIds: cl.map((c) => c.face_id),
            ruleDefaultName: pname,
            // #38: an UnknownN must leave the Unknown branch on rename
            ruleDefaultGroup: renameGroup(selectedPerson ?? undefined),
          });
        });
      });
      if (snap.settings.show_rejected) {
        const rej = snap.faces.filter(
          (f) => f.person_id === personId && f.link_status === "rejected"
        );
        if (rej.length > 0)
          out.push({ key: "rejected", title: "Rejected (undo to accept)", faceIds: rej.map((f) => f.id) });
      }
      return out;
    }
    // review: all provisional faces, grouped by importer person, UnknownN first
    const byPerson = new Map<number | null, Face[]>();
    for (const f of snap.faces.filter((x) => x.link_status === "provisional")) {
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
  })();

  // #31 — person stepping: ‹ › and ← → walk the persons in the tree's
  // current (filtered) display order; the shortcut set is listed in the
  // settings popover
  const [filter, setFilter] = useState("");
  const stepIds = useMemo(
    () => orderedVisiblePersonIds(treePersons, filter),
    [treePersons, filter]
  );
  const stepIdx = personId != null ? stepIds.indexOf(personId) : -1;
  const stepPerson = useCallback(
    (dir: 1 | -1) => {
      const next =
        stepIdx === -1
          ? dir === 1
            ? 0
            : Math.max(stepIds.length - 1, 0)
          : Math.min(Math.max(stepIdx + dir, 0), stepIds.length - 1);
      const id = stepIds[next];
      if (id == null) return;
      // #52 (§4.15): stepping selects another person — keep the split only
      // while that person still has a face on the open image
      if (
        splitImageId != null &&
        !(snap?.faces.some((f) => f.person_id === id && f.image_id === splitImageId) ?? false)
      )
        setSplitImageId(null);
      setPersonId(id);
      setView("person");
      setImageId(null);
    },
    [stepIdx, stepIds, splitImageId, snap]
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" ||
          tgt.tagName === "SELECT" || tgt.isContentEditable)
      )
        return;
      if (dialogFaceIds != null || faceAssign != null || confirmRemove != null) return;
      // #53 (§4.17): Ctrl-G toggles the whole section — the hovered
      // card's, else the most recently selected card's; preventDefault
      // so webkit cannot steal the chord
      if ((e.ctrlKey || e.metaKey) && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        const targetId = hoverId ?? lastSelRef.current;
        if (targetId == null) return;
        // in focus mode the rendered sections are the film roll's (#55)
        const rendered =
          splitImageId != null ? sectionsForImage(splitImageId) : sections;
        const section = rendered.find((s) => s.faceIds.includes(targetId));
        if (!section || section.faceIds.length === 0) return;
        const all = section.faceIds.every((id) => sel.has(id));
        toggleMany(section.faceIds, !all);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepPerson(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepPerson(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepPerson, dialogFaceIds, faceAssign, confirmRemove, hoverId, lastSelRef, sections, sectionsForImage, sel, splitImageId]);

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

  if (loadError) {
    return (
      <div className="fatal">
        <h2>Could not load database</h2>
        <p>{loadError}</p>
      </div>
    );
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
          {busy && <span className="dim">working…</span>}
          <button
            className="ghost"
            onClick={() => refresh().catch((e) => setError(String(e)))}
            title="refresh"
          >
            ↻
          </button>
          <button className="ghost" onClick={() => setSettingsOpen(true)} title="settings">
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
            <label title="Show/hide rejected faces in every view (#23)">
              <input type="checkbox" checked={showRejected} onChange={toggleShowRejected} />
              show rejected
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
                    hoverId={hoverId}
                    onHover={setHoverId}
                    onToggle={toggle}
                    onFaceContextMenu={faceMenu}
                    onImageContextMenu={(e) => imageAreaMenu(e, splitRow.id)}
                  />
                </div>
                <div className="film-roll">
                  <FaceGrid
                    sections={sectionsForImage(splitRow.id)}
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
                  hoverId={hoverId}
                  onHover={setHoverId}
                  onToggle={toggle}
                  onFaceContextMenu={faceMenu}
                  onImageContextMenu={(e) => imageAreaMenu(e, imgRow.id)}
                />
              </div>
              <FaceGrid sections={sections} {...gridHandlers} primaryFaceId={null} />
            </div>
          ) : (
            <FaceGrid
              sections={sections}
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
            showRejected={showRejected}
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
        onAccept={() => doAccept([...sel])}
        onReject={() => doReject([...sel])}
        onClear={() => setSel(new Set())}
      />

      {dialogFaceIds && (
        <AssignDialog
          count={dialogFaceIds.length}
          defaultName={dialogPrefill.name}
          defaultGroup={dialogPrefill.group}
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
      {error && (
        <div className="toast" onClick={() => setError(null)} title="click to dismiss">
          {error}
        </div>
      )}
    </div>
  );
}
