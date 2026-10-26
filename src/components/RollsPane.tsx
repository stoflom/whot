import { useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Face, ImportRow, ImageRow } from "../api";
import { useImageThumbImg } from "../hooks";
import { rotStyle } from "../rotation";

interface Props {
  imports: ImportRow[];
  images: ImageRow[];
  faces: Face[];
  onOpenImage: (id: number) => void;
  /** right-click menu on image tiles (#32) */
  onContextMenuImage: (image: ImageRow, e: ReactMouseEvent) => void;
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

function RollSection({ imp, images, faces, initialOpen, onOpenImage, onContextMenuImage }: {
  imp: ImportRow;
  images: ImageRow[];
  faces: Face[];
  initialOpen: boolean;
  onOpenImage: (id: number) => void;
  onContextMenuImage: (image: ImageRow, e: ReactMouseEvent) => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  // #146: count the faces of the images the section actually displays
  // (first_import_id set). Faces carry the import_id of the roll that
  // produced them, so on a re-import of the same file the later roll's
  // faces said import_id = later roll while the image stays in the first
  // roll's section — the later roll showed "0 img, N new" for images it
  // does not display and the first roll had inflated counts. Face counts
  // are per-roll image set, so the header summarises what is shown.
  const imgIds = new Set(images.map((x) => x.id));
  const inRoll = (f: Face) => imgIds.has(f.image_id);
  const pending = faces.filter((f) => inRoll(f) && f.link_status === "provisional").length;
  const done = faces.filter((f) => inRoll(f) && f.link_status === "confirmed").length;
  const rejected = faces.filter((f) => inRoll(f) && f.link_status === "rejected").length;
  return (
    <section className={`roll${open ? " open" : ""}`}>
      <header className="roll-header" onClick={() => setOpen(!open)}>
        <span className="roll-arrow">{open ? "▾" : "▸"}</span>
        <span className="roll-path" title={imp.path}>
          {imp.path.replace(/^.*\//, "") || imp.path}
        </span>
        <span className="roll-date">{imp.started_at.slice(0, 16).replace("T", " ")}</span>
        <span className="roll-counts">
          {images.length} img · {pending} new · {done} ✓ · {rejected} ✗
        </span>
      </header>
      {open && (
        <div className="img-grid">
          {images.map((img) => (
            <ImageThumb
              key={img.id}
              image={img}
              onOpen={() => onOpenImage(img.id)}
              onContextMenu={(e) => onContextMenuImage(img, e)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default function RollsPane({ imports, images, faces, onOpenImage, onContextMenuImage }: Props) {
  // #151: a roll with zero images is never listed — a re-import of only
  // already-known files leaves an import row with no images of its own
  // (§3 keys the section set on first_import_id); the shell offers
  // nothing to open, so it is irrelevant
  const listed = imports.filter((imp) => images.some((x) => x.first_import_id === imp.id));
  if (listed.length === 0) return <div className="empty">no rolls imported yet</div>;
  return (
    <div className="rolls">
      {listed.map((imp, i) => (
        <RollSection
          key={imp.id}
          imp={imp}
          initialOpen={i === 0}
          images={images.filter((x) => x.first_import_id === imp.id)}
          faces={faces}
          onOpenImage={onOpenImage}
          onContextMenuImage={onContextMenuImage}
        />
      ))}
    </div>
  );
}
