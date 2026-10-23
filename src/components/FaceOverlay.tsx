import type { MouseEvent as ReactMouseEvent } from "react";
import type { Face } from "../api";
import { useRotatedImage, imagePreview } from "../hooks";
import { displayDims, rotatedRect } from "../rotation";

// Full-size image with one active, name-labelled rectangle per visible face
// (design §4.11): percentage-scaled from the canonical images.width/height
// space, status-coloured, click toggles selection. The card ↔ rect hover
// highlight is synced imperatively via data-sync-hover (App's delegated
// mousemove listener, #98) — no hover props, no re-render.

interface Props {
  imageId: number;
  /** canonical coordinate space (images.width / images.height, schema #18) */
  width: number;
  height: number;
  /** already visibility-filtered by the caller (§4.10 — hidden faces excluded) */
  faces: Face[];
  sel: Set<number>;
  onToggle: (id: number) => void;
  /** right-click menu on the face rectangles; the image area gets its own
      functional menu (open in system viewer) because the webkit default
      menu entries don't work in Tauri (#32/#33) */
  onFaceContextMenu?: (id: number, e: ReactMouseEvent) => void;
  onImageContextMenu?: (e: ReactMouseEvent) => void;
  /** #122: the image's stored display rotation (CW) — the preview is
      rotated and every rectangle is mapped into display space */
  rotation?: number;
}

export default function FaceOverlay({
  imageId,
  width,
  height,
  faces,
  sel,
  onToggle,
  onFaceContextMenu,
  onImageContextMenu,
  rotation = 0,
}: Props) {
  // #122: the pixels are rotated once (memoised hook); the rectangles
  // are positioned in DISPLAY space (the rotated frame) — same math the
  // #118 importer uses for harvested boxes
  const url = useRotatedImage(imagePreview, imageId, rotation);
  if (!url) return <span className="dim">no preview</span>;
  const { w: dw, h: dh } = displayDims(width, height, rotation);
  return (
    <div className="annotated" onContextMenu={onImageContextMenu}>
      <img src={url} alt="" />
      {width > 0 &&
        height > 0 &&
        faces.map((f) => {
          const r = rotatedRect(f, width, height, rotation);
          return (
          <button
            key={f.id}
            type="button"
            data-overlay-face={f.id}         // #98: sync-hover target
            className={`face-rect status-${f.link_status}${sel.has(f.id) ? " selected" : ""}`}
            style={{
              left: `${(r.x / dw) * 100}%`,
              top: `${(r.y / dh) * 100}%`,
              width: `${(r.w / dw) * 100}%`,
              height: `${(r.h / dh) * 100}%`,
            }}
            title={`${f.name} — ${Math.round(f.confidence * 100)}% (click to select)`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(f.id);
            }}
            onContextMenu={(e) => onFaceContextMenu?.(f.id, e)}
          >
            <span className="face-rect-label">{f.name}</span>
          </button>
          );
        })}
    </div>
  );
}
