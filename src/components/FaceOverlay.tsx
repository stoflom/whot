import type { Face } from "../api";
import { useImagePreviewImg } from "../hooks";

// Full-size image with one active, name-labelled rectangle per visible face
// (design §4.11): percentage-scaled from the canonical images.width/height
// space, status-coloured, hover highlights rect + card (shared hover state),
// click toggles selection.

interface Props {
  imageId: number;
  /** canonical coordinate space (images.width / images.height, schema #18) */
  width: number;
  height: number;
  /** already visibility-filtered by the caller (§4.10 — hidden faces excluded) */
  faces: Face[];
  sel: Set<number>;
  hoverId: number | null;
  onHover: (id: number | null) => void;
  onToggle: (id: number) => void;
}

export default function FaceOverlay({
  imageId,
  width,
  height,
  faces,
  sel,
  hoverId,
  onHover,
  onToggle,
}: Props) {
  const url = useImagePreviewImg(imageId);
  if (!url) return <span className="dim">no preview</span>;
  return (
    <div className="annotated">
      <img src={url} alt="" />
      {width > 0 &&
        height > 0 &&
        faces.map((f) => (
          <button
            key={f.id}
            type="button"
            className={
              `face-rect status-${f.link_status}` +
              (sel.has(f.id) ? " selected" : "") +
              (hoverId === f.id ? " hover" : "")
            }
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
            onMouseEnter={() => onHover(f.id)}
            onMouseLeave={() => onHover(null)}
          >
            <span className="face-rect-label">{f.name}</span>
          </button>
        ))}
    </div>
  );
}
