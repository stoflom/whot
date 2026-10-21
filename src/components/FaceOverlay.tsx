import type { MouseEvent as ReactMouseEvent } from "react";
import type { Face } from "../api";
import { useImagePreviewImg } from "../hooks";

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
}: Props) {
  const url = useImagePreviewImg(imageId);
  if (!url) return <span className="dim">no preview</span>;
  return (
    <div className="annotated" onContextMenu={onImageContextMenu}>
      <img src={url} alt="" />
      {width > 0 &&
        height > 0 &&
        faces.map((f) => (
          <button
            key={f.id}
            type="button"
            data-overlay-face={f.id}         // #98: sync-hover target
            className={`face-rect status-${f.link_status}${sel.has(f.id) ? " selected" : ""}`}
            style={{
              left: `${(f.x / width) * 100}%`,
              top: `${(f.y / height) * 100}%`,
              width: `${(f.w / width) * 100}%`,
              height: `${(f.h / height) * 100}%`,
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
        ))}
    </div>
  );
}
