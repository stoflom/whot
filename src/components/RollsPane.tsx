import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { scanImportDir, type Face, type ImageRow } from "../api";
import { useImageThumbImg } from "../hooks";
import { rotStyle } from "../rotation";
import { matchesStatusFilter, type FaceFilter } from "../viewFilters";

// #161 (gui-design §3): the Rolls pane is a hierarchy mirroring the
// images' actual filesystem paths — each image's primary_path split into
// its path segments, every segment an expandable branch, the image filed
// in its file's directory branch. The import-roll sections (and the
// #146 per-roll counting / #151 zero-image-roll rule) are gone: the pane
// ignores the imports and simply organises the pictures by their paths.
// Show (§4.10) is active here: an image is listed only if it holds a
// face matching the filter and an emptied branch is pruned — the branch
// counters stay filter-independent raw totals (#129 convention).

interface Props {
  images: ImageRow[];
  faces: Face[];
  faceFilter: FaceFilter;
  /** #162: the path-filter root ('/' = whole tree) — session-scoped, lives in App */
  root: string;
  onRootChange: (path: string) => void;
  onOpenImage: (id: number) => void;
  /** right-click menu on image tiles (#32) */
  onContextMenuImage: (image: ImageRow, e: ReactMouseEvent) => void;
  /** #167 (§4.36): a not-yet-imported directory opens the import pane */
  onImportDir: (path: string) => void;
}

/** a directory node — images sit in their own directory, sub-directories branch below */
interface DirNode {
  name: string;
  children: Map<string, DirNode>;
  images: ImageRow[];
}

/** raw counters over a set of images */
interface Totals {
  img: number;
  pending: number;
  done: number;
  rejected: number;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** split every primary_path into segments relative to the #162 root and
    file the image under its directory */
function buildTree(images: ImageRow[], root: string): DirNode {
  const rootPrefix = root === "/" ? "/" : `${root}/`;
  const inRoot = images.filter((x) => x.primary_path.startsWith(rootPrefix));
  const rel = (p: string) => (root === "/" ? p : p.slice(root.length + 1));
  const tree: DirNode = { name: "", children: new Map(), images: [] };
  for (const img of inRoot) {
    let node = tree;
    for (const seg of rel(img.primary_path).split("/").filter(Boolean)) {
      let next = node.children.get(seg);
      if (!next) {
        next = { name: seg, children: new Map(), images: [] };
        node.children.set(seg, next);
      }
      node = next;
    }
    node.images.push(img);
  }
  return tree;
}

/** branch totals over every image beneath the branch — raw, filter-independent (#129) */
function rollup(node: DirNode, faceTotals: Map<number, Totals>): Totals {
  const t: Totals = { img: node.images.length, pending: 0, done: 0, rejected: 0 };
  for (const img of node.images) {
    const f = faceTotals.get(img.id);
    if (f) {
      t.pending += f.pending;
      t.done += f.done;
      t.rejected += f.rejected;
    }
  }
  for (const child of node.children.values()) {
    const c = rollup(child, faceTotals);
    t.img += c.img;
    t.pending += c.pending;
    t.done += c.done;
    t.rejected += c.rejected;
  }
  return t;
}

/** does the branch hold a listing image somewhere beneath it? — a branch
    the Show filter empties is pruned from the tree entirely */
function hasListed(node: DirNode, listed: Set<number>): boolean {
  if (node.images.some((x) => listed.has(x.id))) return true;
  for (const child of node.children.values()) if (hasListed(child, listed)) return true;
  return false;
}

function ImageThumb({ image, onOpen, onContextMenu }: {
  image: ImageRow;
  onOpen: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}) {
  const img = useImageThumbImg(image.id);
  return (
    <button className="img-thumb" onClick={onOpen} onContextMenu={onContextMenu} title={image.primary_path}>
      {img ? <img src={img} alt="" style={rotStyle(image.rotation)} /> : <span className="dim">…</span>}
      {image.state === "no-face" && <span className="no-face">no face</span>}
    </button>
  );
}

function BranchView({ node, path, openSet, onToggle, listed, faceTotals, onOpenImage, onContextMenuImage }: {
  node: DirNode;
  /** '/'-joined segment path — the expand-state key and the header's title */
  path: string;
  openSet: Set<string>;
  onToggle: (path: string) => void;
  listed: Set<number>;
  faceTotals: Map<number, Totals>;
  onOpenImage: (id: number) => void;
  onContextMenuImage: (image: ImageRow, e: ReactMouseEvent) => void;
}) {
  const open = openSet.has(path);
  const t = rollup(node, faceTotals);
  const thumbs = node.images.filter((x) => listed.has(x.id))
    .sort((a, b) => basename(a.primary_path).localeCompare(basename(b.primary_path)));
  const branches = [...node.children.values()]
    .filter((c) => hasListed(c, listed))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section className="roll">
      <header className="roll-header" onClick={() => onToggle(path)}>
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
          {thumbs.length > 0 && (
            <div className="img-grid">
              {thumbs.map((img) => (
                <ImageThumb
                  key={img.id}
                  image={img}
                  onOpen={() => onOpenImage(img.id)}
                  onContextMenu={(e) => onContextMenuImage(img, e)}
                />
              ))}
            </div>
          )}
          {branches.map((c) => (
            <BranchView
              key={c.name}
              node={c}
              path={`${path}/${c.name}`}
              openSet={openSet}
              onToggle={onToggle}
              listed={listed}
              faceTotals={faceTotals}
              onOpenImage={onOpenImage}
              onContextMenuImage={onContextMenuImage}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default function RollsPane({ images, faces, faceFilter, root, onRootChange, onOpenImage, onContextMenuImage, onImportDir }: Props) {
  const tree = useMemo(() => buildTree(images, root), [images, root]);

  // per-image raw face counters + the Show-filter presence set: an image
  // is listed iff it holds ≥ 1 face matching the filter; under 'all'
  // every image is listed (faceless shells included)
  const { faceTotals, listed } = useMemo(() => {
    const faceTotals = new Map<number, Totals>();
    const listed = new Set<number>();
    for (const f of faces) {
      let t = faceTotals.get(f.image_id);
      if (!t) {
        t = { img: 1, pending: 0, done: 0, rejected: 0 };
        faceTotals.set(f.image_id, t);
      }
      if (f.link_status === "provisional") t.pending++;
      else if (f.link_status === "confirmed") t.done++;
      else if (f.link_status === "rejected") t.rejected++;
      if (matchesStatusFilter(f.link_status, faceFilter)) listed.add(f.image_id);
    }
    if (faceFilter === "all") for (const img of images) listed.add(img.id);
    return { faceTotals, listed };
  }, [images, faces, faceFilter]);

  // branches start collapsed — the user drills in (#161); open state is
  // display-only, keyed on the '/'-joined segment path
  const [openSet, setOpenSet] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

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

  const roots =
    images.length === 0
      ? []
      : [...tree.children.values()]
          .filter((c) => hasListed(c, listed))
          .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="rolls-pane">
      <div className="roll-filter">
        <label
          title="Root the path tree at this path (#162) — Enter commits: a folder with images under it becomes the root, an image file opens full-image, a not-yet-imported directory opens the import pane (#167), anything else is refused"
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
      ) : roots.length === 0 ? (
        <div className="empty">nothing to show</div>
      ) : (
        <div className="rolls">
          {roots.map((c) => (
            <BranchView
              key={c.name}
              node={c}
              path={c.name}
              openSet={openSet}
              onToggle={toggle}
              listed={listed}
              faceTotals={faceTotals}
              onOpenImage={onOpenImage}
              onContextMenuImage={onContextMenuImage}
            />
          ))}
        </div>
      )}
    </div>
  );
}
