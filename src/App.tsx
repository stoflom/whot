import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import * as api from "./api";
import type { AppearanceGroup, Face, ImageRow, Refcrop, Snapshot } from "./api";
import AssignDialog from "./components/AssignDialog";
import ContextMenu, { type MenuGroup, type MenuState } from "./components/ContextMenu";
import DetailPane from "./components/DetailPane";
import FaceGrid, { type Section } from "./components/FaceGrid";
import FaceOverlay from "./components/FaceOverlay";
import PersonTree from "./components/PersonTree";
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
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [splitImageId, setSplitImageId] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // #34 — pane sizes (session state); defaults match the stylesheet
  const [paneSizes, setPaneSizes] = useState({ left: 250, right: 290, split: 45 });
  const dragRef = useRef<{ edge: "left" | "right" | "split"; startX: number; start: number } | null>(
    null
  );
  const startDrag = (edge: "left" | "right" | "split") => (e: ReactMouseEvent) => {
    e.preventDefault();
    dragRef.current = { edge, startX: e.clientX, start: paneSizes[edge] };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      setPaneSizes((s) => {
        if (d.edge === "left") return { ...s, left: Math.min(Math.max(d.start + dx, 160), 480) };
        if (d.edge === "right") return { ...s, right: Math.min(Math.max(d.start - dx, 200), 560) };
        return {
          ...s,
          split: Math.min(Math.max(d.start + (dx / window.innerWidth) * 100, 20), 80),
        };
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
  const [dialogFaceIds, setDialogFaceIds] = useState<number[] | null>(null);
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
  // #28: with show_rejected off, the left-pane counts (and the detail-pane
  // counts derived from them) exclude rejected faces
  const treePersons = useMemo(() => {
    if (!snap) return [];
    if (snap.settings.show_rejected) return snap.persons;
    return snap.persons.map((p) => ({
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
    if (splitImageId == null || dialogFaceIds != null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSplitImageId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [splitImageId, dialogFaceIds]);

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

  const toggle = (id: number) =>
    setSel((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleMany = (ids: number[], on: boolean) =>
    setSel((prev) => {
      const n = new Set(prev);
      ids.forEach((i) => (on ? n.add(i) : n.delete(i)));
      return n;
    });

  // ------------------------------------------------------------ mutations

  const doAssign = (ids: number[], name: string, group: string) =>
    mutate(() => api.assignPerson(ids, name, group), true);
  const doAccept = (ids: number[]) => mutate(() => api.acceptFaces(ids), true);
  const doReject = (ids: number[]) => mutate(() => api.rejectFaces(ids), true);
  const doDesc = (id: number, d: string) => mutate(() => api.setFaceDescription(id, d));
  const doPrimary = (id: number) => {
    const f = facesById.get(id);
    if (f) mutate(() => api.setPrimaryFace(f.person_id, id));
  };
  const doRefcrop = (id: number) => {
    const f = facesById.get(id);
    if (f) mutate(() => api.addRefcrop(f.person_id, id));
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
        title: "Face",
        items: [
          {
            label: f.link_status === "rejected" ? "Un-reject (accept)" : "Accept",
            onClick: () => doAccept([id]),
          },
          {
            label: "Reject",
            onClick: () => doReject([id]),
            disabled: f.link_status === "rejected",
            danger: true,
          },
          { label: "Set as primary", onClick: () => doPrimary(id) },
          {
            label: "Add as reference",
            onClick: () => doRefcrop(id),
            disabled: f.link_status !== "confirmed",
          },
          { label: "Assign to person…", onClick: () => setDialogFaceIds([id]) },
          { label: "Open full image", onClick: () => setSplitImageId(f.image_id) },
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
          { label: "Open beside (split)", onClick: () => setSplitImageId(image.id) },
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
    sel,
    hoverId,
    onHover: setHoverId,
    onContextMenu: faceMenu,
    onToggle: toggle,
    onOpen: (id: number) => {
      const f = facesById.get(id);
      if (f) setSplitImageId(f.image_id);
    },
    onToggleMany: toggleMany,
    onDescription: doDesc,
    onPrimary: doPrimary,
    onRefcrop: doRefcrop,
    onReject: (id: number) => doReject([id]),
    onAccept: (id: number) => doAccept([id]),
    onAssign: (ids: number[], name: string, group: string) => doAssign(ids, name, group),
  };

  const sections = useMemo<Section[]>(() => {
    if (!snap) return [];
    if (imageId != null) {
      const byPerson = new Map<number, Face[]>();
      for (const f of snap.faces.filter(
        (x) =>
          x.image_id === imageId &&
          (snap.settings.show_rejected || x.link_status !== "rejected")
      )) {
        const arr = byPerson.get(f.person_id) ?? [];
        arr.push(f);
        byPerson.set(f.person_id, arr);
      }
      return [...byPerson.entries()].map(([pid, fl]) => {
        const p = personsById.get(pid);
        return {
          key: `img-${pid}`,
          title: p?.name ?? `person ${pid}`,
          faceIds: fl.map((f) => f.id),
          ruleDefaultName: p?.name,
          ruleDefaultGroup: p?.groups[0] ?? "",
        };
      });
    }
    if (view === "person" && personId != null) {
      const out: Section[] = [];
      const pname = selectedPerson?.name ?? "";
      const pgroup = selectedPerson?.groups[0] ?? "";
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
            ruleDefaultGroup: pgroup,
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
    const byPerson = new Map<number, Face[]>();
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
        ruleDefaultGroup: p.groups[0] ?? "",
      }));
  }, [snap, view, personId, imageId, clusters, personsById, selectedPerson]);

  // #31 — section stepping (‹ › / arrow keys): scroll-only, idx resets with
  // the section list; the token guards against scrolling on plain refetches
  const [nav, setNav] = useState({ idx: 0, token: 0 });
  useEffect(() => setNav((n) => ({ idx: 0, token: n.token })), [sections]);
  const stepSection = useCallback(
    (dir: 1 | -1) =>
      setNav((n) => ({
        idx: Math.min(Math.max(n.idx + dir, 0), Math.max(sections.length - 1, 0)),
        token: n.token + 1,
      })),
    [sections.length]
  );
  useEffect(() => {
    if (nav.token === 0) return;
    const key = sections[nav.idx]?.key;
    if (key == null) return;
    document
      .querySelector(`[data-skey="${key}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [nav, sections]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" ||
          tgt.tagName === "SELECT" || tgt.isContentEditable)
      )
        return;
      if (dialogFaceIds != null) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepSection(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepSection(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepSection, dialogFaceIds]);

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
            }}
          >
            Review <span className="pill">{pendingCount}</span>
          </button>
          <button
            className={view === "rolls" ? "active" : ""}
            onClick={() => setView("rolls")}
          >
            Rolls
          </button>
          <button
            className={view === "person" ? "active" : ""}
            disabled={personId == null}
            onClick={() => {
              setView("person");
              setImageId(null);
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
            onReview={() => {
              setView("review");
              setImageId(null);
            }}
            onSelect={(id) => {
              setPersonId(id);
              setView("person");
              setImageId(null);
            }}
            onRename={(id, n) => mutate(() => api.setPersonName(id, n))}
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

        <main className="center">
          <div className="center-toolbar">
            <span className="toolbar-left">
              <button
                className="ghost"
                onClick={() => stepSection(-1)}
                disabled={sections.length === 0 || nav.idx <= 0}
                title="previous section (←)"
              >
                ‹
              </button>
              <span className="nav-pos">
                {sections.length > 0 ? `${Math.min(nav.idx, sections.length - 1) + 1}/${sections.length}` : "–"}
              </span>
              <button
                className="ghost"
                onClick={() => stepSection(1)}
                disabled={sections.length === 0 || nav.idx >= sections.length - 1}
                title="next section (→)"
              >
                ›
              </button>
            </span>
            <label title="Show/hide rejected faces in every view (#23)">
              <input type="checkbox" checked={showRejected} onChange={toggleShowRejected} />
              show rejected
            </label>
          </div>
          <div className={splitRow ? "center-split" : undefined}>
            <div className="split-main">
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
            </div>
            {splitRow && (
              <>
                <div
                  className="v-divider"
                  onMouseDown={startDrag("split")}
                  onDoubleClick={() => setPaneSizes((s) => ({ ...s, split: 45 }))}
                  title="drag to resize, double-click to reset"
                />
                <aside className="split-side" style={{ flex: `0 0 ${paneSizes.split}%` }}>
                <div className="split-side-top">
                  <span title={splitRow.primary_path}>
                    {splitRow.primary_path.replace(/^.*\//, "") || splitRow.primary_path}
                  </span>
                  <button
                    className="ghost"
                    onClick={() => setSplitImageId(null)}
                    title="close (Esc)"
                  >
                    ×
                  </button>
                </div>
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
                />
              </aside>
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
            onName={(id, n) => mutate(() => api.setPersonName(id, n))}
            onGroup={(id, g) => mutate(() => api.setPersonGroup(id, g))}
            onNote={(id, n) => mutate(() => api.setPersonNote(id, n))}
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
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      {error && (
        <div className="toast" onClick={() => setError(null)} title="click to dismiss">
          {error}
        </div>
      )}
    </div>
  );
}
