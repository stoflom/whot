// #122 (gui-design rule 32) — display-rotation math, shared by the
// renderer and the #118 import box transform:
//
//   decode space: the stored pixel space of the file (images.width ×
//   images.height — the canonical coordinate space for rectangles).
//   display space: what the user sees after the stored CW rotation
//   (0/90/180/270). For 90/270 the display dimensions are swapped.
//
// A face rectangle stored in decode space maps to display space exactly
// as the #118 importer maps harvested boxes: orientation 6 (90 CW):
// (x, y, w, h) -> (H - y - h, x, h, w); orientation 8 (270 CW):
// (y, W - x - w, h, w).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** display dimensions for a decode space of (W, H) at a CW rotation */
export function displayDims(W: number, H: number, rotation: number): { w: number; h: number } {
  return rotation === 90 || rotation === 270 ? { w: H, h: W } : { w: W, h: H };
}

/** CSS transform for crop/thumbnail displays (no coordinate maths —
    the element just spins in place, §4.24-independent) */
export const rotStyle = (rotation: number): { transform?: string } | undefined =>
  rotation ? { transform: `rotate(${rotation}deg)` } : undefined;

/** decode-space rectangle -> display-space rectangle (pixels) */
export function rotatedRect(
  r: Rect,
  W: number,
  H: number,
  rotation: number,
): Rect {
  switch (rotation) {
    case 90: // CW: decode top-left lands top-right
      return { x: H - r.y - r.h, y: r.x, w: r.h, h: r.w };
    case 180:
      return { x: W - r.x - r.w, y: H - r.y - r.h, w: r.w, h: r.h };
    case 270:
      return { x: r.y, y: W - r.x - r.w, w: r.h, h: r.w };
    default:
      return { x: r.x, y: r.y, w: r.w, h: r.h };
  }
}
