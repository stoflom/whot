import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { scanImportDir, type Face, type ImageRow } from "../api";
import type { FaceFilter } from "../viewFilters";
import { buildTree, faceTotalsOf, rollupIndex, type DirNode, type Totals } from "../rollsTree";

// #161 (gui-design §3): the Rolls pane is a hierarchy mirroring the
// images' actual filesystem paths — each image's primary_path split into
// its path segments, every segment an expandable branch, the image filed
// in its file's directory branch. The import-roll sections (and the
// #146 per-roll counting / #151 zero-image-roll rule) are gone: the pane
// ignores the imports and simply organises the pictures by their paths.
// Show (§4.10) is active here: an image is listed only if it holds a
// face matching the filter and an emptied branch is pruned — the branch
// counters stay filter-independent raw totals (#129 convention).
// #174 (§4.39): the centre renders NO thumbnails any more — a header
// click toggles the branch AND selects it, and the selected branch's
// direct images appear in the right pane (RollsThumbs).

interface Props {
  images: ImageRow[];
  faces: Face[];
  faceFilter: FaceFilter;
  /** #162: the path-filter root ('/' = whole tree) — session-scoped, lives in App */
  root: string;
  onRootChange: (path: string) => void;
  onOpenImage: (id: number) => void;
  /** #174 (§4.39): the selected branch — ABSOLUTE path, session state in App */
  selected: string;
  onSelect: (path: string) => void;
  /** #167 (§4.36): a not-yet-imported directory opens the import pane */
  onImportDir: (path: string) => void;
}

// the hierarchy maths (DirNode/buildTree/Totals/rollupIndex) live in
// ../rollsTree (#226) — extracted pure and co-tested there.

// #226 (F-M5): every recursive computation (roll-up totals, the
// Show-filter pruning, the name sort) is precomputed once per
// tree/faces/filter change in rollupIndex — BranchView reads the maps
// and renders, so an expand/collapse toggle re-renders branches from
// O(1) lookups instead of re-running the O(depth × images) recursion
// per header. (memo(BranchView) was rejected: a descendant's toggle
// must re-render the ancestor chain to hand down new props, so a
// node-identity comparator cannot skip safely.)
interface BranchProps {
  node: DirNode;
  /** '/'-joined segment path — the expand-state key and the header's title */
  path: string;
  /** the branch's ABSOLUTE directory path (#174 selection key) */
  absPath: string;
  openSet: Set<string>;
  /** the selected branch's ABSOLUTE path (#174) */
  selected: string;
  /** rollupIndex output: per-node totals + pruned/sorted sub-branches */
  totals: Map<DirNode, Totals>;
  visible: Map<DirNode, DirNode[]>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  /** #255: the roving-tabindex focus — only this header is tabbable */
  focusedPath: string | null;
  onFocusPath: (path: string) => void;
}

// #255: the APG tree key pattern for a branch header — Enter/Space act
// (the same as the click), Up/Down move focus among the visible headers
// (DOM order == display order), Right expands, Left collapses or climbs.
function branchKey(
  e: React.KeyboardEvent,
  path: string,
  absPath: string,
  open: boolean,
  onToggle: (path: string) => void,
  onSelect: (path: string) => void
) {
  const headers = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"].roll-header'));
  const focusPath = (target: string | null) => {
    if (target == null) return;
    const el = headers().find((h) => h.getAttribute("data-path") === target);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  };
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    onToggle(path);
    onSelect(absPath);
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const list = headers();
    const idx = list.findIndex((h) => h.getAttribute("data-path") === absPath);
    focusPath(list[idx + (e.key === "ArrowDown" ? 1 : -1)]?.getAttribute("data-path") ?? null);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    if (!open) onToggle(path);
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (open) onToggle(path);
    else {
      const parent = absPath.slice(0, absPath.lastIndexOf("/"));
      focusPath(parent === "" ? "/" : parent);
    }
  }
}

function BranchView({
  node,
  path,
  absPath,
  openSet,
  selected,
  totals,
  visible,
  onToggle,
  onSelect,
  focusedPath,
  onFocusPath,
}: BranchProps) {
  const open = openSet.has(path);
  const t = totals.get(node)!;
  const branches = visible.get(node) ?? [];
  return (
    <section className="roll">
      <header
        className={absPath === selected ? "roll-header selected" : "roll-header"}
        role="treeitem"
        aria-expanded={open}
        tabIndex={focusedPath === absPath ? 0 : -1}
        data-path={absPath}
        data-owns-keys
        onClick={() => {
          // #174/§4.39: one click toggles AND selects — the selected
          // branch's direct images land in the right pane
          onToggle(path);
          onSelect(absPath);
        }}
        onFocus={() => onFocusPath(absPath)}
        onKeyDown={(e) => branchKey(e, path, absPath, open, onToggle, onSelect)}
      >
        <span className="roll-arrow">{open ? "▾" : "▸"}</span>
        <span className="roll-path" title={path}>
          {node.name}
        </span>
        <span className="roll-counts">
          {t.img} img · {t.pending} new · {t.done} ✓ · {t.rejected} ✗
        </span>
      </header>
      {open && (
        <div className="roll-children">
          {branches.map((c) => (
            <BranchView
              key={c.name}
              node={c}
              path={`${path}/${c.name}`}
              absPath={absPath === "/" ? `/${c.name}` : `${absPath}/${c.name}`}
              openSet={openSet}
              selected={selected}
              totals={totals}
              visible={visible}
              onToggle={onToggle}
              onSelect={onSelect}
              focusedPath={focusedPath}
              onFocusPath={onFocusPath}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RollsPane({ images, faces, faceFilter, root, onRootChange, onOpenImage, selected, onSelect, onImportDir }: Props) {
  const tree = useMemo(() => buildTree(images, root), [images, root]);

  // per-image raw face counters + the Show-filter presence set (§4.10,
  // shared with the right-pane thumbnails, #174)
  const { faceTotals, listed } = useMemo(
    () => faceTotalsOf(faces, images, faceFilter),
    [images, faces, faceFilter]
  );

  // #226 (F-M5): the roll-ups, the pruning and the sort — one pass per
  // tree/faces/filter change, never per render (the old code re-ran
  // rollup + hasListed recursively for every rendered header on every
  // expand/collapse)
  const { totals, visible } = useMemo(
    () => rollupIndex(tree, faceTotals, listed),
    [tree, faceTotals, listed]
  );

  // branches start collapsed — the user drills in (#161); open state is
  // display-only, keyed on the '/'-joined segment path
  const [openSet, setOpenSet] = useState<Set<string>>(new Set());
  // #255: the roving-tabindex focus for the branch headers — the first
  // visible branch is tabbable, arrows move it (branchKey)
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const toggle = useCallback((path: string) => {
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // #255: keep exactly one visible header tabbable — seed the first on
  // mount, and if an expand/collapse / re-render leaves `focusedPath`
  // pointing at a header that no longer renders, fall back to the first
  // visible one. (The selector is scoped to `.roll-header`, so the
  // PersonTree's items never leak in even with both panes mounted.)
  useEffect(() => {
    const headers = Array.from(document.querySelectorAll<HTMLElement>(".roll-header"));
    if (headers.length === 0) return;
    const alive =
      focusedPath != null &&
      headers.some((h) => h.getAttribute("data-path") === focusedPath);
    if (!alive) setFocusedPath(headers[0].getAttribute("data-path"));
  }, [focusedPath, openSet, totals, visible]);

  // #162: the pinned path-filter row — committed on Enter or by the
  // folder picker, validated against the snapshot (no fs IPC for a
  // snapshot match): a path containing ≥ 1 image becomes the root the
  // hierarchy branches from, a path equal to an image's primary_path
  // opens that image in full-image mode (#142 view-context change).
  // #167 (§4.36): anything else is probed on the filesystem once
  // (scan_import_dir) — a real, not-yet-imported directory opens the
  // import pane in the right pane; anything else keeps the dim hint.
  const [text, setText] = useState(root);
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => setText(root), [root]);

  const commitPath = async (raw: string) => {
    const trimmed = raw.trim();
    const noSlash = trimmed.replace(/\/+$/, "");
    const path = noSlash === "" ? "/" : noSlash;
    const exact = images.find((x) => x.primary_path === path);
    if (exact) {
      setHint(null);
      onOpenImage(exact.id); // file → full-image mode, root untouched
      return;
    }
    const prefix = path === "/" ? "/" : `${path}/`;
    if (images.some((x) => x.primary_path.startsWith(prefix))) {
      setHint(null);
      onRootChange(path);
      setText(path);
      return;
    }
    // #167: the one fs probe of the filter — a real directory holding
    // images anywhere beneath it (#169, recursive) nothing has imported
    // yet opens the import pane
    try {
      if (path !== "/" && (await scanImportDir(path))) {
        setHint(null);
        onImportDir(path);
        return;
      }
    } catch {
      // probe unavailable — fall through to the #162 hint
    }
    setHint(`no images under ${trimmed}`);
  };

  const browse = async () => {
    try {
      const picked = await openFolderDialog({ directory: true, multiple: false });
      if (typeof picked === "string") void commitPath(picked);
    } catch (e) {
      setHint(String(e));
    }
  };

  const roots = visible.get(tree) ?? [];

  return (
    <div className="rolls-pane">
      <div className="roll-filter">
        {/* #162 (root commit) + #167 (import-pane route) — the title
            stays reference-free (§4.43) */}
        <label
          title="Root the path tree at this path — Enter commits: a folder with images under it becomes the root, an image file opens full-image, a not-yet-imported directory opens the import pane, anything else is refused"
        >
          path
        </label>
        <input
          value={text}
          placeholder="/path/to/folder (or an image file)"
          onChange={(e) => {
            setText(e.target.value);
            setHint(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitPath(text);
          }}
          title="Enter: root the tree at this folder, or open this image file; a fresh directory opens the import pane; empty = the whole tree"
        />
        <button className="secondary" onClick={browse} title="pick a root folder from the filesystem">
          browse…
        </button>
        {hint && <span className="roll-filter-hint dim">{hint}</span>}
      </div>
      {images.length === 0 ? (
        <div className="empty">no images yet</div>
      ) : roots.length === 0 && tree.images.length === 0 ? (
        // #174: a root without sub-branches is not empty — its images
        // are in the right pane (the root is the default selection)
        <div className="empty">nothing to show</div>
      ) : (
        <div className="rolls" role="tree" aria-label="image folders">
          {roots.map((c) => (
            <BranchView
              key={c.name}
              node={c}
              path={c.name}
              absPath={root === "/" ? `/${c.name}` : `${root}/${c.name}`}
              openSet={openSet}
              selected={selected}
              totals={totals}
              visible={visible}
              onToggle={toggle}
              onSelect={onSelect}
              focusedPath={focusedPath}
              onFocusPath={setFocusedPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// #215: memoised — App keeps the handler identities stable, so a
// re-render that changes none of this pane's own props skips it
export default memo(RollsPane);
