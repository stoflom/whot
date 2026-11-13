// #298 (gui-design v16.0, rule 51) — the annotated-image export's
// PURE parts: the dimension math (rotation + max-dimension cap), the
// default name, the status palette and the display-space overlay
// specs (the shared rotatedRect/displayDims math — export and display
// can never diverge). The canvas pipeline itself runs in the webview
// (jsdom has no canvas).
// Run: npm test (vitest run; node — no DOM needed).
import { describe, expect, it } from "vitest";
import type { Face, ImageRow } from "./api";
import {
  defaultExportName,
  drawRect,
  exportDims,
  FORMAT_EXT,
  formatMime,
  labelFontPx,
  originalDir,
  overlaySpecs,
  REJECTED_ALPHA,
  STATUS_COLOR,
} from "./exportAnnotated";

const IMG: ImageRow = {
  id: 42,
  primary_path: "/home/u/rolls/2026-01/sub/IMG_0001.RAW",
  width: 4000,
  height: 6000,
  orientation: "portrait",
  rotation: 0,
  rtype: "raw",
  state: "imported",
  first_import_id: 7,
  last_import_id: 7,
};

function face(o: { id?: number; status?: string; x?: number; y?: number } = {}): Face {
  return {
    id: o.id ?? 1,
    image_id: 42,
    person_id: 1,
    x: o.x ?? 100,
    y: o.y ?? 200,
    w: 300,
    h: 400,
    name: "alice",
    seq: 0,
    description: null,
    confidence: 0.9,
    link_status: o.status ?? "provisional",
    state: "live",
    rotation: 0,
    import_id: null,
    created_at: "",
  };
}

describe("exportDims", () => {
  it("keeps the display size at rotation 0 (no cap)", () => {
    expect(exportDims(4000, 6000, 0, null)).toEqual({ w: 4000, h: 6000, scale: 1 });
  });

  it("swaps the display dims at 90/270 and keeps them at 180", () => {
    expect(exportDims(4000, 6000, 90, null)).toEqual({ w: 6000, h: 4000, scale: 1 });
    expect(exportDims(4000, 6000, 180, null)).toEqual({ w: 4000, h: 6000, scale: 1 });
    expect(exportDims(4000, 6000, 270, null)).toEqual({ w: 6000, h: 4000, scale: 1 });
  });

  it("caps the LARGEST display dimension and preserves the ratio", () => {
    // 6000×4000 display (rotated) capped at 1500 → 1500×1000
    expect(exportDims(4000, 6000, 90, 1500)).toEqual({
      w: 1500,
      h: 1000,
      scale: 0.25,
    });
    // a cap above the largest dim is a no-op
    expect(exportDims(4000, 6000, 0, 8000)).toEqual({ w: 4000, h: 6000, scale: 1 });
  });

  it("0/blank maxDim means original", () => {
    expect(exportDims(4000, 6000, 0, 0)).toEqual({ w: 4000, h: 6000, scale: 1 });
  });
});

describe("labelFontPx", () => {
  it("scales with the exported width, floored at 12 px", () => {
    expect(labelFontPx(1000)).toBe(12); // 7.2 → floor
    expect(labelFontPx(1200)).toBe(12); // exactly 8.64 → 12 floor
    expect(labelFontPx(4000)).toBe(29);
  });
});

describe("defaultExportName / originalDir", () => {
  it("appends -annotated.<ext> to the stem, keeps the extension kind", () => {
    expect(defaultExportName(IMG, "png")).toBe("IMG_0001-annotated.png");
    expect(defaultExportName(IMG, "jpeg")).toBe("IMG_0001-annotated.jpg");
    expect(defaultExportName(IMG, "webp")).toBe("IMG_0001-annotated.webp");
  });

  it("a BLOB-only image (no recorded path) falls back to image-<id>", () => {
    const blobOnly = { ...IMG, primary_path: "" };
    expect(defaultExportName(blobOnly, "png")).toBe("image-42-annotated.png");
    expect(originalDir(blobOnly)).toBe("");
  });

  it("originalDir is the parent directory (root paths give none)", () => {
    expect(originalDir(IMG)).toBe("/home/u/rolls/2026-01/sub");
    expect(originalDir({ ...IMG, primary_path: "/IMG_0001.RAW" })).toBe("");
  });
});

describe("the status palette", () => {
  it("matches the §4.11 CSS colours, rejected at 0.6", () => {
    expect(STATUS_COLOR.provisional).toBe("#d9a53a");
    expect(STATUS_COLOR.confirmed).toBe("#3fb950");
    expect(STATUS_COLOR.rejected).toBe("#f0605a");
    expect(REJECTED_ALPHA).toBe(0.6);
  });

  it("format helpers", () => {
    expect(FORMAT_EXT).toEqual({ png: "png", jpeg: "jpg", webp: "webp" });
    expect(formatMime("png")).toBe("image/png");
    expect(formatMime("jpeg")).toBe("image/jpeg");
    expect(formatMime("webp")).toBe("image/webp");
  });
});

describe("overlaySpecs", () => {
  // #299: the label comes from the caller's resolver — these tests
  // pin the geometry, so they resolve to the face name
  const nameOf = (f: Face) => f.name;

  it("maps decode-space rectangles to display space at rotation 0 (identity)", () => {
    const specs = overlaySpecs(IMG, [face()], 4000, nameOf);
    expect(specs).toEqual([
      { x: 100, y: 200, w: 300, h: 400, color: "#d9a53a", alpha: 1, label: "alice" },
    ]);
  });

  it("maps through the 90° CW rotation (the shared rotatedRect math)", () => {
    const rotated = { ...IMG, rotation: 90 }; // display 6000×4000
    const specs = overlaySpecs(rotated, [face()], 6000, nameOf);
    // (100, 200, 300, 400) @ 90° CW in a 4000×6000 decode space:
    // x' = H - y - h = 6000 - 200 - 400 = 5400, y' = x = 100, w' = h = 400, h' = w = 300
    expect(specs).toEqual([
      { x: 5400, y: 100, w: 400, h: 300, color: "#d9a53a", alpha: 1, label: "alice" },
    ]);
  });

  it("scales with the export size (a capped 1500-wide export of the rotated image)", () => {
    const rotated = { ...IMG, rotation: 90 };
    const specs = overlaySpecs(rotated, [face()], 1500, nameOf); // scale 0.25
    expect(specs[0]).toEqual({
      x: 1350,
      y: 25,
      w: 100,
      h: 75,
      color: "#d9a53a",
      alpha: 1,
      label: "alice",
    });
  });

  it("colours by status; rejected renders at the 0.6 opacity", () => {
    const specs = overlaySpecs(
      IMG,
      [face({ id: 1, status: "confirmed" }), face({ id: 2, status: "rejected" })],
      4000,
      nameOf,
    );
    expect(specs[0].color).toBe("#3fb950");
    expect(specs[0].alpha).toBe(1);
    expect(specs[1].color).toBe("#f0605a");
    expect(specs[1].alpha).toBe(REJECTED_ALPHA);
  });

  it("an image without dimensions has no specs (defensive)", () => {
    expect(
      overlaySpecs({ ...IMG, width: 0, height: 0 }, [face()], 4000, nameOf),
    ).toEqual([]);
  });

  it("#299: the label is the resolver's PERSON name, not the face name", () => {
    const f: Face = {
      ...face(),
      name: "Charles Crosby-baard|sonbril-3",
      person_id: 7,
    };
    const personName = (pid: number | null) => (pid === 7 ? "Charles Crosby" : null);
    const specs = overlaySpecs(IMG, [f], 4000, (x) =>
      x.person_id != null ? personName(x.person_id) ?? x.name : x.name,
    );
    expect(specs[0].label).toBe("Charles Crosby");
  });
});

// #304 — the label chip regression: drawRect's measurements must run
// in the LABEL font. A stub 2D context records the call order and the
// chip geometry (jsdom has no canvas — drawRect is pure w.r.t. ctx).
describe("drawRect label chip (#304)", () => {
  const FONT = '24px "Inter", "Segoe UI", system-ui, sans-serif';
  const SPEC = { x: 10, y: 20, w: 30, h: 40, color: "#f0605a", alpha: 0.9, label: "bob" };

  function fakeCtx() {
    const calls: { op: string; args: unknown[] }[] = [];
    let font = "";
    const ctx: CanvasRenderingContext2D = {
      set font(v: string) { font = v; calls.push({ op: "font", args: [v] }); },
      get font() { return font; },
      measureText(t: string) {
        calls.push({ op: "measureText", args: [t] });
        return { width: 40 } as TextMetrics;
      },
      save: () => calls.push({ op: "save", args: [] }),
      restore: () => calls.push({ op: "restore", args: [] }),
      strokeRect: (...a: unknown[]) => calls.push({ op: "strokeRect", args: a }),
      fillText: (...a: unknown[]) => calls.push({ op: "fillText", args: a }),
      fill: () => calls.push({ op: "fill", args: [] }),
      beginPath: () => calls.push({ op: "beginPath", args: [] }),
      moveTo: (a: number, b: number) => calls.push({ op: "moveTo", args: [a, b] }),
      lineTo: (a: number, b: number) => calls.push({ op: "lineTo", args: [a, b] }),
      arcTo: () => calls.push({ op: "arcTo", args: [] }),
      closePath: () => calls.push({ op: "closePath", args: [] }),
      set globalAlpha(_: number) { calls.push({ op: "globalAlpha", args: [] }); },
      set lineWidth(_: number) { calls.push({ op: "lineWidth", args: [] }); },
      set strokeStyle(_: string) { calls.push({ op: "strokeStyle", args: [] }); },
      set fillStyle(_: string) { calls.push({ op: "fillStyle", args: [] }); },
      set textBaseline(_: string) { calls.push({ op: "textBaseline", args: [] }); },
    } as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
  }

  it("the label font is set BEFORE the first measurement", () => {
    const { ctx, calls } = fakeCtx();
    drawRect(ctx, SPEC, 24);
    const fontSet = calls.findIndex((c) => c.op === "font");
    const firstMeasure = calls.findIndex((c) => c.op === "measureText");
    expect(fontSet).toBeGreaterThanOrEqual(0);
    expect(fontSet).toBeLessThan(firstMeasure);
    expect(calls[fontSet].args[0]).toBe(FONT);
  });

  it("the chip width is the measured advance + 2*padX, beneath the rectangle", () => {
    const { ctx, calls } = fakeCtx();
    drawRect(ctx, SPEC, 24);
    // fitLabel measures "bob" (fits — 40 <= maxPx), then the chip measures it again
    const measures = calls.filter((c) => c.op === "measureText");
    expect(measures.map((c) => c.args[0])).toEqual(["bob", "bob"]);
    // roundedPath(bottom): moveTo(x, ly) then lineTo(x + lw, ly)
    const moveTo = calls.find((c) => c.op === "moveTo")!.args as number[];
    const lineTo = calls.find((c) => c.op === "lineTo")!.args as number[];
    const padX = 3 * (24 / 12);
    expect(lineTo[0] - moveTo[0]).toBe(Math.ceil(40) + 2 * padX);
    expect(moveTo[0]).toBe(SPEC.x);          // left-aligned to the rectangle
    expect(moveTo[1]).toBe(SPEC.y + SPEC.h); // beneath it
  });
});
