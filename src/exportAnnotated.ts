// #298 (gui-design v16.0, rule 51) — the annotated-image export:
// the full image with every visible face's rectangle + person-name
// label baked into the pixels. The render is a canvas composite over
// the SAME `images.preview` BLOB the viewer displays, with the stored
// CW rotation applied to the pixels (the #122/§4.32 math) and the
// rectangles in DISPLAY space (the shared rotatedRect/displayDims
// math, so export and display can never diverge). The selection state
// is NOT exported — selection is UI state, not annotation.
//
// The pure parts (dimension math, default name, status palette) are
// unit-pinned in exportAnnotated.test.ts; the canvas pipeline itself
// runs in the webview (jsdom has no canvas).

import { imagePreview } from "./api";
import type { Face, ImageRow } from "./api";
import { displayDims, rotatedRect } from "./rotation";

export type ExportFormat = "png" | "jpeg" | "webp";

export const FORMAT_EXT: Record<ExportFormat, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
};

export const FORMAT_LABEL: Record<ExportFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
  webp: "WebP",
};

/** the `canvas.toBlob` MIME for a format */
export const formatMime = (format: ExportFormat): string =>
  ({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" })[format];

/** the §4.11 status palette (the CSS custom properties, resolved) —
    the export must match the viewer, not invent its own */
export const STATUS_COLOR: Record<string, string> = {
  provisional: "#d9a53a",
  confirmed: "#3fb950",
  rejected: "#f0605a",
};
/** the §4.11 rejected opacity (the rest render opaque) */
export const REJECTED_ALPHA = 0.6;
/** the label background: 80 % of the theme bg (#10141a) */
const LABEL_BG = "rgba(16, 20, 26, 0.8)";
const LABEL_TEXT = "#dce4ee";

/** the exported canvas size for a decode space of (W, H) at a CW
    rotation, capped at `maxDim` display px (0/null = original) */
export function exportDims(
  W: number,
  H: number,
  rotation: number,
  maxDim: number | null,
): { w: number; h: number; scale: number } {
  const { w: dw, h: dh } = displayDims(W, H, rotation);
  const largest = Math.max(dw, dh);
  const scale =
    maxDim && maxDim > 0 && largest > maxDim ? maxDim / largest : 1;
  return {
    w: Math.max(1, Math.round(dw * scale)),
    h: Math.max(1, Math.round(dh * scale)),
    scale,
  };
}

/** the label height scales with the exported width (~0.7 % — the
    viewer's look at a typical pane width), floored at 12 px */
export function labelFontPx(widthPx: number): number {
  return Math.max(12, Math.round(widthPx * 0.0072));
}

/** `<stem>-annotated.<ext>` next to the original file (a BLOB-only
    image — no recorded path — falls back to `image-<id>`) */
export function defaultExportName(image: ImageRow, format: ExportFormat): string {
  const base =
    image.primary_path.split("/").pop()?.trim() || `image-${image.id}`;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}-annotated.${FORMAT_EXT[format]}`;
}

/** the directory part of `primary_path` ("" when none / BLOB-only) */
export function originalDir(image: ImageRow): string {
  const i = image.primary_path.lastIndexOf("/");
  return i > 0 ? image.primary_path.slice(0, i) : "";
}

interface RectSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  alpha: number;
  label: string;
}

/** the display-space overlay specs — the shared rotatedRect math
    (display dims from the canonical W/H), scaled to the export size.
    #299: the label beneath each rectangle is the PERSON name — the
    caller resolves it (persons map), never the face name */
export function overlaySpecs(
  image: ImageRow,
  faces: Face[],
  outW: number,
  labelFor: (face: Face) => string,
): RectSpec[] {
  const rotation = image.rotation;
  const { w: dw, h: dh } = displayDims(image.width, image.height, rotation);
  if (dw <= 0 || dh <= 0) return [];
  // the aspect is preserved, so the width ratio IS the height ratio
  const s = outW / dw;
  return faces.map((f) => {
    const r = rotatedRect(f, image.width, image.height, rotation);
    return {
      x: r.x * s,
      y: r.y * s,
      w: r.w * s,
      h: r.h * s,
      color: STATUS_COLOR[f.link_status] ?? "#8593a6",
      alpha: f.link_status === "rejected" ? REJECTED_ALPHA : 1,
      label: labelFor(f),
    };
  });
}

/** truncate to ~18ch (the CSS label's max-width) with an ellipsis */
function fitLabel(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (ctx.measureText(text).width <= maxPx) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

function roundedPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  bottom: boolean,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (bottom) {
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.closePath();
  } else {
    ctx.rect(x, y, w, h);
  }
}

/** draw the status rectangle + the name label beneath it (the CSS
    .face-rect / .face-rect-label shapes). Exported for the rule-51
    label regression test (a stub 2D context). */
export function drawRect(ctx: CanvasRenderingContext2D, spec: RectSpec, fontPx: number): void {
  const { x, y, w, h, color, alpha, label } = spec;
  ctx.save();
  ctx.globalAlpha = alpha;
  // border 2px at the viewer's label scale (fontPx 12), scaled with
  // the export — the label font is the export's size reference
  ctx.lineWidth = Math.max(1, 2 * (fontPx / 12));
  ctx.strokeStyle = color;
  ctx.strokeRect(x, y, Math.max(1, w), Math.max(1, h));
  // #304: the label font must be set BEFORE any measurement —
  // measureText reads the CURRENT font, and the canvas default
  // (10px sans-serif) is far narrower than the scaled label font,
  // which left the background chip ~1 character short of the text
  ctx.font = `${fontPx}px "Inter", "Segoe UI", system-ui, sans-serif`;
  // label: beneath the rectangle, left-aligned, bg 80 % theme
  const maxPx = 18 * 0.62 * fontPx;
  const text = fitLabel(ctx, label, maxPx);
  const padX = 3 * (fontPx / 12);
  const padY = 0.15 * fontPx;
  const tw = Math.ceil(ctx.measureText(text).width);
  const lw = tw + 2 * padX;
  const lh = fontPx * 1.3 + 2 * padY;
  const lx = x;
  const ly = y + h;
  ctx.fillStyle = LABEL_BG;
  roundedPath(ctx, lx, ly, lw, lh, 3 * (fontPx / 12), true);
  ctx.fill();
  ctx.fillStyle = LABEL_TEXT;
  ctx.textBaseline = "top";
  ctx.fillText(text, lx + padX, ly + padY);
  ctx.restore();
}

/** the annotated composite as a Blob (null when the preview BLOB is
    missing or the canvas path is unavailable — the caller toasts) */
export function renderAnnotatedBlob(
  image: ImageRow,
  faces: Face[],
  format: ExportFormat,
  maxDim: number | null,
  labelFor: (face: Face) => string,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    void (async () => {
      const url = await imagePreview(image.id);
      if (!url) return resolve(null);
      const im = new Image();
      await new Promise<void>((res, rej) => {
        im.onload = () => res();
        im.onerror = () => rej(new Error("cannot decode the image preview"));
        im.src = url;
      }).catch(() => resolve(null));
      if (im.naturalWidth === 0) return resolve(null);
      try {
        const rotation = image.rotation;
        const { w: dw, h: dh } = displayDims(
          image.width || im.naturalWidth,
          image.height || im.naturalHeight,
          rotation,
        );
        const { w: W, h: H } = exportDims(
          image.width || im.naturalWidth,
          image.height || im.naturalHeight,
          rotation,
          maxDim,
        );
        // stage 1: the display-space pixels (the rotation applied to
        // the image itself — the #122 rotateCanvas math)
        const base = document.createElement("canvas");
        base.width = dw;
        base.height = dh;
        const bctx = base.getContext("2d");
        if (!bctx) return resolve(null);
        bctx.translate(dw / 2, dh / 2);
        bctx.rotate((rotation * Math.PI) / 180);
        bctx.drawImage(im, -im.naturalWidth / 2, -im.naturalHeight / 2);
        // stage 2: the export size + the overlay
        const c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        const ctx = c.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(base, 0, 0, W, H);
        const fontPx = labelFontPx(W);
        for (const spec of overlaySpecs(image, faces, W, labelFor)) {
          drawRect(ctx, spec, fontPx);
        }
        c.toBlob(
          (b) => resolve(b),
          formatMime(format),
          0.92, // the #122 re-encode's quality
        );
      } catch {
        resolve(null);
      }
    })();
  });
}
