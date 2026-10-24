// #122 — display-rotation math. The 90/270 cases must match the #118
// importer box transform exactly (orientation 6/8).
import { describe, expect, it } from "vitest";
import { displayDims, rotatedRect } from "./rotation";

describe("displayDims", () => {
  it("0/180 keep the decode dims; 90/270 swap them", () => {
    expect(displayDims(10, 6, 0)).toEqual({ w: 10, h: 6 });
    expect(displayDims(10, 6, 180)).toEqual({ w: 10, h: 6 });
    expect(displayDims(10, 6, 90)).toEqual({ w: 6, h: 10 });
    expect(displayDims(10, 6, 270)).toEqual({ w: 6, h: 10 });
  });
});

describe("rotatedRect", () => {
  // decode space 10 (W) x 6 (H); box (2,1) size 3x2
  const r = { x: 2, y: 1, w: 3, h: 2 };
  it("0 is the identity", () => {
    expect(rotatedRect(r, 10, 6, 0)).toEqual(r);
  });
  it("90 CW — orientation 6: (x,y,w,h) -> (H-y-h, x, h, w)", () => {
    expect(rotatedRect(r, 10, 6, 90)).toEqual({ x: 3, y: 2, w: 2, h: 3 });
  });
  it("180 — (x,y,w,h) -> (W-x-w, H-y-h, w, h)", () => {
    expect(rotatedRect(r, 10, 6, 180)).toEqual({ x: 5, y: 3, w: 3, h: 2 });
  });
  it("270 CW — orientation 8: (x,y,w,h) -> (y, W-x-w, h, w)", () => {
    expect(rotatedRect(r, 10, 6, 270)).toEqual({ x: 1, y: 5, w: 2, h: 3 });
  });
  it("corners map to the expected display corners (90 CW)", () => {
    const W = 10, H = 6;
    // decode top-left (0,0) -> display top-right (H, 0)
    expect(rotatedRect({ x: 0, y: 0, w: 0, h: 0 }, W, H, 90)).toEqual({ x: H, y: 0, w: 0, h: 0 });
    // decode bottom-right (W,H) -> display bottom-left (0, W)
    expect(rotatedRect({ x: W, y: H, w: 0, h: 0 }, W, H, 90)).toEqual({ x: 0, y: W, w: 0, h: 0 });
  });
  it("the full frame maps to the full display frame", () => {
    expect(rotatedRect({ x: 0, y: 0, w: 10, h: 6 }, 10, 6, 90)).toEqual({ x: 0, y: 0, w: 6, h: 10 });
    expect(rotatedRect({ x: 0, y: 0, w: 10, h: 6 }, 10, 6, 270)).toEqual({ x: 0, y: 0, w: 6, h: 10 });
    expect(rotatedRect({ x: 0, y: 0, w: 10, h: 6 }, 10, 6, 180)).toEqual({ x: 0, y: 0, w: 10, h: 6 });
  });
});
