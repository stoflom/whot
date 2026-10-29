import type { MouseEvent as ReactMouseEvent } from "react";
import type { ImageRow } from "../api";
import { useImageThumbImg } from "../hooks";
import { rotStyle } from "../rotation";

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

export default function RollsThumbs({ branch, images, hasSubBranches, sel, onClickImage, onOpenImage, onContextMenuImage }: Props) {
  if (images.length > 0) {
    return (
      <div className="rolls-thumbs">
        <div className="rolls-thumbs-head dim" title={branch}>
          {branch}
          {sel.size > 1 ? ` · ${sel.size} selected` : ""}
        </div>
        <div className="img-grid">
          {images.map((img) => (
            <Thumb
              key={img.id}
              image={img}
              selected={sel.has(img.id)}
              onClick={(mods) => onClickImage(img.id, mods)}
              onOpen={() => onOpenImage(img.id)}
              onContextMenu={(e) => onContextMenuImage(img, e)}
            />
          ))}
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
