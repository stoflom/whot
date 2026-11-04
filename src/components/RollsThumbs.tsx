import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { ImageRow } from "../api";
import { useImageThumbImg } from "../hooks";
import { rotStyle } from "../rotation";
// #225 (F-M4): the branch thumbs window with the same prefix+sentinel
// rule as the centre grids (gridMount.ts) — a flat directory with
// thousands of photos must not coalesce into one multi-MB IPC batch
// and thousands of <img> mounts in a single commit
import { GRID_MOUNT_INITIAL, growLimit } from "../gridMount";

// #174 (gui-design §4.39) — the Rolls mode right pane: the SELECTED
// branch's images, direct children only (the caller filters), filename
// order (the caller sorts), Show-listed (the caller filters). Plain
// click selects (ctrl/⌘ toggle, shift range — §4.23 over images), a
// double-click opens the image detail (#142/#174), the context menu
// (#32) carries the scoped image actions. The centre renders no
// thumbnails any more — this pane is where a twig's images live.

interface Props {
  /** the branch's absolute path (headings/hints) */
  branch: string;
  images: ImageRow[];
  /** does the branch hold deeper LISTED images? (hint wording, §4.39) */
  hasSubBranches: boolean;
  sel: Set<number>;
  onClickImage: (id: number, mods: { ctrl: boolean; shift: boolean }) => void;
  onOpenImage: (id: number) => void;
  onContextMenuImage: (image: ImageRow, e: ReactMouseEvent) => void;
}

function Thumb({ image, selected, onClick, onOpen, onContextMenu }: {
  image: ImageRow;
  selected: boolean;
  onClick: (mods: { ctrl: boolean; shift: boolean }) => void;
  onOpen: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}) {
  const img = useImageThumbImg(image.id);
  return (
    <button
      className={`img-thumb${selected ? " selected" : ""}`}
      aria-pressed={selected}
      title={image.primary_path}
      onClick={(e) => onClick({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
    >
      {img ? <img src={img} alt="" style={rotStyle(image.rotation)} /> : <span className="dim">…</span>}
      {image.state === "no-face" && <span className="no-face">no face</span>}
    </button>
  );
}

function RollsThumbs({ branch, images, hasSubBranches, sel, onClickImage, onOpenImage, onContextMenuImage }: Props) {
  // #225: the mounted prefix — App-owned depth is pointless here (the
  // pane remounts per branch), so the limit lives here and resets when
  // the branch changes (a new listing starts at its prefix)
  const [limit, setLimit] = useState(GRID_MOUNT_INITIAL);
  useEffect(() => setLimit(GRID_MOUNT_INITIAL), [branch]);
  const shown = images.slice(0, limit);
  const more = images.length > limit;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // the same grow-toward-the-viewport rule as FaceGrid's sentinel — the
  // scroll container is the right pane (.right)
  useEffect(() => {
    if (!more) return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((n) => growLimit(n));
      },
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [more]);
  if (images.length > 0) {
    return (
      <div className="rolls-thumbs">
        <div className="rolls-thumbs-head dim" title={branch}>
          {branch}
          {sel.size > 1 ? ` · ${sel.size} selected` : ""}
        </div>
        <div className="img-grid">
          {shown.map((img) => (
            <Thumb
              key={img.id}
              image={img}
              selected={sel.has(img.id)}
              onClick={(mods) => onClickImage(img.id, mods)}
              onOpen={() => onOpenImage(img.id)}
              onContextMenu={(e) => onContextMenuImage(img, e)}
            />
          ))}
          {more && <div ref={sentinelRef} className="grid-grow-sentinel" />}
        </div>
      </div>
    );
  }
  // §4.39 hint chain: deeper listed images → drill hint; otherwise the
  // branch (or the Show filter) simply holds nothing here
  return (
    <div className="rolls-thumbs">
      <div className="rolls-thumbs-empty dim">
        {hasSubBranches
          ? "no images directly at this path — open a sub-branch"
          : "nothing to show"}
      </div>
    </div>
  );
}

// #215: memoised — App keeps the handler identities stable, so a
// re-render that changes none of this pane's own props skips it
export default memo(RollsThumbs);
