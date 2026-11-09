// #275 (gui-design v11.3) — the ONE full-image header bar: both
// full-image surfaces render it (path + Copy, the mode-scoped ‹ n/m ›
// cluster, the ⟳/⟲ stored rotation, close/back) instead of their two
// stacked bars. Pure render — the stepping/rotation/close handlers are
// the caller's; this pins the shape, the mode-scoped rules (the person
// surface keeps its #76/#194 off-list fallback, the image surface
// disables off-list — rule 46) and the dim facts in the path tooltip.
// Run: npm test (vitest run; jsdom pragma).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FullImageBar } from "./FullImageBar";
import type { ImageRow } from "../api";

const IMG: ImageRow = {
  id: 42,
  primary_path: "/home/u/rolls/2026-01/sub/IMG_0001.RAW",
  width: 4000,
  height: 6000,
  orientation: "portrait",
  rotation: 90,
  rtype: "raw",
  state: "imported",
  first_import_id: 7,
  last_import_id: 7,
};

const mount = (over: {
  step?: (d: 1 | -1) => void;
  canPrev?: boolean;
  canNext?: boolean;
  total?: number;
  pos?: number;
  stepNoun?: "person" | "image";
  onRotate?: (d: 90 | -90) => void;
  rtype?: string | null;
  img?: ImageRow;
} = {}) => {
  const step = over.step ?? vi.fn();
  const onRotate = over.onRotate ?? vi.fn();
  const utils = render(
    <FullImageBar
      img={over.img ?? IMG}
      rtype={over.rtype ?? null}
      step={step}
      canPrev={over.canPrev ?? true}
      canNext={over.canNext ?? true}
      total={over.total ?? 5}
      pos={over.pos ?? 2}
      stepNoun={over.stepNoun ?? "person"}
      onRotate={onRotate}
      close={<button data-testid="close">×</button>}
    />
  );
  return { step, onRotate, ...utils };
};

const btn = (title: string) =>
  document.querySelector<HTMLButtonElement>(
    `button[title="${title}"]`
  )!;

afterEach(cleanup);

describe("FullImageBar (#275)", () => {
  it("is ONE bar carrying path, copy, the ‹ n/m › cluster, rotation and close", () => {
    const { container } = mount();
    const bar = container.querySelector(".full-image-bar")!;
    expect(bar).toBeTruthy();
    expect(bar.textContent).toContain(IMG.primary_path);
    expect(bar.querySelector(".err-copy")).toBeTruthy();
    expect(bar.querySelector(".nav-pos")!.textContent).toBe("3/5");
    expect(btn("previous person (←)")).toBeTruthy();
    expect(btn("next person (→)")).toBeTruthy();
    expect(btn("Rotate 90° clockwise (stored)")).toBeTruthy();
    expect(btn("Rotate 90° counter-clockwise (stored)")).toBeTruthy();
    expect(bar.querySelector('[data-testid="close"]')).toBeTruthy();
    // nothing above it — the bar is the surface's header
    expect(container.firstElementChild).toBe(bar);
  });

  it("folds the dim facts into the path tooltip (W×H · state · rotated, type on the detail surface)", () => {
    const focus = mount({ stepNoun: "person" });
    expect(
      focus.container
        .querySelector(".full-image-path")!
        .getAttribute("title")
    ).toBe(
      `${IMG.primary_path} · 4000×6000 · imported · rotated 90°`
    );
    const detail = mount({ stepNoun: "image", rtype: "raw" });
    expect(
      detail.container
        .querySelector(".full-image-path")!
        .getAttribute("title")
    ).toBe(
      `${IMG.primary_path} · 4000×6000 · imported · raw · rotated 90°`
    );
  });

  it("steps the mode's list and honours the surface's own arrow rules", () => {
    const { step } = mount();
    fireEvent.click(btn("previous person (←)"));
    fireEvent.click(btn("next person (→)"));
    expect(step).toHaveBeenNthCalledWith(1, -1);
    expect(step).toHaveBeenNthCalledWith(2, 1);
    // person surface: an unanchored item (pos -1) still steps (the
    // #76/#194 cursor/last-position fallback) — the caller says so
    const off = mount({ pos: -1, canPrev: true, canNext: true });
    expect(
      off.container.querySelector<HTMLButtonElement>(
        'button[title="previous person (←)"]'
      )!.disabled
    ).toBe(false);
    expect(off.container.querySelector(".nav-pos")!.textContent).toBe("–/5");
    // image surface: off-list disables both arrows (rule 46)
    const img = mount({ stepNoun: "image", pos: -1, canPrev: false, canNext: false });
    expect(
      img.container.querySelector<HTMLButtonElement>(
        'button[title="previous image (←)"]'
      )!.disabled
    ).toBe(true);
    expect(
      img.container.querySelector<HTMLButtonElement>(
        'button[title="next image (→)"]'
      )!.disabled
    ).toBe(true);
    // empty list: `–`; the callers fold total-0 into their can flags
    const empty = mount({ total: 0, canPrev: false, canNext: false });
    expect(empty.container.querySelector(".nav-pos")!.textContent).toBe("–");
    expect(
      empty.container.querySelector<HTMLButtonElement>(
        'button[title="previous person (←)"]'
      )!.disabled
    ).toBe(true);
  });

  it("rotates the stored display rotation via the caller (±90)", () => {
    const { onRotate } = mount();
    fireEvent.click(btn("Rotate 90° clockwise (stored)"));
    fireEvent.click(btn("Rotate 90° counter-clockwise (stored)"));
    expect(onRotate).toHaveBeenNthCalledWith(1, 90);
    expect(onRotate).toHaveBeenNthCalledWith(2, -90);
  });

  it("renders the surface's close/back control as-is", () => {
    const { getByTestId } = mount();
    expect(getByTestId("close").textContent).toBe("×");
  });
});
