// #258 — the global keyboard dispatcher + Q8 Esc stack moved out of
// App.tsx into appKeys.ts (the 15-property keyRef double literal is
// now the ONE `input` object). This mirrors the dialogKeys /
// personFetchGuard patterns: a mounted probe exercises every guard
// bail and every shortcut through the window-level listener.
// Run: npm test (vitest run; jsdom pragma — a mounted component with
// window listeners needs a DOM).
// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, cleanup } from "@testing-library/react";
import { useAppKeys, type AppKeysInput, type AppKeysInternals } from "./appKeys";
import type { Section } from "./components/FaceGrid";
import type { Stage } from "./stage";

const SECTION: Section = { key: "k1", title: "t", faceIds: [1, 2, 3] };

const makeInput = (over: Partial<AppKeysInput> = {}): AppKeysInput => ({
  overlayCount: 0,
  sections: [SECTION],
  sectionsForImage: vi.fn(() => [SECTION]),
  sectionUnderCursor: vi.fn(() => undefined),
  sel: new Set([5]),
  splitImageId: null,
  imageId: null,
  mode: "review",
  toggle: vi.fn(),
  toggleMany: vi.fn(),
  changeSel: vi.fn(),
  commitPending: vi.fn(),
  acceptAndNext: vi.fn(),
  doReject: vi.fn(),
  stepPerson: vi.fn(),
  stepImage: vi.fn(),
  ...over,
});

const makeInternals = (
  over: Partial<AppKeysInternals> = {}
): AppKeysInternals => ({
  contextConfirmRef: { current: null },
  pendingRef: { current: [] as Stage[] },
  hoverRef: { current: null },
  lastSelRef: { current: null },
  clearPending: vi.fn(),
  closeSplit: vi.fn(),
  ...over,
});

function Probe({ input, internals }: { input: AppKeysInput; internals: AppKeysInternals }) {
  useAppKeys(input, internals);
  return <button data-testid="btn">probe</button>;
}

const mount = (over?: { input?: Partial<AppKeysInput>; internals?: Partial<AppKeysInternals> }) => {
  const input = makeInput(over?.input);
  const internals = makeInternals(over?.internals);
  render(<Probe input={input} internals={internals} />);
  return { input: input as MockedInput, internals };
};
type MockedInput = AppKeysInput & Record<string, ReturnType<typeof vi.fn>>;

const key = (target: Element | Document, k: string, over: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(target, { key: k, ...over } as KeyboardEventInit);

describe("useAppKeys (#258) — the guard bails", () => {
  afterEach(cleanup);

  it("bails when focus is in an INPUT (fields own their keys)", () => {
    const { input } = mount();
    const field = document.createElement("input");
    document.body.appendChild(field);
    key(field, "a");
    key(field, "Enter");
    key(field, "ArrowRight");
    expect(input.acceptAndNext).not.toHaveBeenCalled();
    expect(input.stepPerson).not.toHaveBeenCalled();
  });

  it("bails when focus is on a BUTTON (#96: Enter/Space stay native)", () => {
    const { input } = mount();
    key(document.querySelector("[data-testid=btn]")!, "r");
    expect(input.doReject).not.toHaveBeenCalled();
  });

  it("bails behind data-owns-keys (#255: the focused a11y control owns its keys)", () => {
    const { input } = mount();
    const node = document.createElement("div");
    node.setAttribute("data-owns-keys", "");
    document.body.appendChild(node);
    key(node, "ArrowRight");
    key(node, "a");
    expect(input.stepPerson).not.toHaveBeenCalled();
    expect(input.acceptAndNext).not.toHaveBeenCalled();
  });

  it("bails behind ANY overlay (the #138 registry count — the Q8 stack)", () => {
    const { input } = mount({ input: { overlayCount: 1 } });
    key(document.body, "a");
    key(document.body, " ");
    key(document.body, "ArrowRight");
    expect(input.acceptAndNext).not.toHaveBeenCalled();
    expect(input.toggle).not.toHaveBeenCalled();
    expect(input.stepPerson).not.toHaveBeenCalled();
  });

  it("bails behind a queued/open Q4 dialog (#187 — the stale-count window)", () => {
    const { input } = mount({
      internals: {
        contextConfirmRef: { current: { fn: () => {} } },
        pendingRef: { current: [{ stage: true } as unknown as Stage] },
      },
    });
    key(document.body, "a");
    key(document.body, "r");
    key(document.body, "ArrowRight");
    expect(input.acceptAndNext).not.toHaveBeenCalled();
    expect(input.doReject).not.toHaveBeenCalled();
    expect(input.stepPerson).not.toHaveBeenCalled();
  });
});

describe("useAppKeys (#258) — the shortcuts (#68/#53/#96/#95/#235)", () => {
  afterEach(cleanup);

  it("Ctrl-G toggles the section under the cursor (#74)", () => {
    const { input } = mount({
      input: { sectionUnderCursor: vi.fn((s) => s[0]) },
    });
    key(document.body, "g", { ctrlKey: true });
    expect(input.toggleMany).toHaveBeenCalledWith([1, 2, 3], true);
  });

  it("Ctrl-G falls back to the hovered card's section (#75 cursor-as-target)", () => {
    const { input, internals } = mount({
      internals: { hoverRef: { current: 2 } },
    });
    key(document.body, "g", { ctrlKey: true });
    expect(input.toggleMany).toHaveBeenCalledWith([1, 2, 3], true);
    expect(internals.hoverRef.current).toBe(2);
  });

  it("Ctrl-G in focus mode renders the film roll's sections (#55)", () => {
    const { input, internals } = mount({
      input: {
        splitImageId: 3,
        sectionUnderCursor: vi.fn((s) => s[0]),
      },
    });
    key(document.body, "g", { ctrlKey: true });
    expect(input.sectionsForImage).toHaveBeenCalledWith(3);
    expect(input.toggleMany).toHaveBeenCalledWith([1, 2, 3], true);
    expect(internals.hoverRef.current).toBeNull();
  });

  it("Ctrl-A selects all rendered faces", () => {
    const { input } = mount();
    key(document.body, "a", { ctrlKey: true });
    expect(input.changeSel).toHaveBeenCalledWith(new Set([1, 2, 3]));
  });

  it("Space toggles the hovered/last card (#75 cursor-as-target)", () => {
    const { input, internals } = mount({
      internals: { hoverRef: { current: 7 } },
    });
    key(document.body, " ");
    expect(input.toggle).toHaveBeenCalledWith(7);
    expect(internals.hoverRef.current).toBe(7);
  });

  it("'a' accepts the selection through acceptAndNext (no pending set)", () => {
    const { input } = mount();
    key(document.body, "a");
    expect(input.acceptAndNext).toHaveBeenCalledWith([5]);
    expect(input.commitPending).not.toHaveBeenCalled();
  });

  it("'a' with a live pending set commits the stage, then accepts the scope (#166)", () => {
    const { input } = mount({
      internals: { pendingRef: { current: [{ stage: true } as unknown as Stage] } },
    });
    key(document.body, "a");
    expect(input.commitPending).toHaveBeenCalledTimes(1);
    expect(input.acceptAndNext).not.toHaveBeenCalled();
  });

  it("Enter in review mode accepts & next (#96); outside review it is inert", () => {
    const { input } = mount();
    key(document.body, "Enter");
    expect(input.acceptAndNext).toHaveBeenCalledWith([5]);
    cleanup();
    const second = mount({ input: { mode: "person" } });
    key(document.body, "Enter");
    expect(second.input.acceptAndNext).not.toHaveBeenCalled();
  });

  it("'r' rejects the selection", () => {
    const { input } = mount();
    key(document.body, "r");
    expect(input.doReject).toHaveBeenCalledWith([5]);
  });

  it("arrows step persons (non-Rolls) — both directions (#95)", () => {
    const { input } = mount();
    key(document.body, "ArrowRight");
    expect(input.stepPerson).toHaveBeenCalledWith(1);
    key(document.body, "ArrowLeft");
    expect(input.stepPerson).toHaveBeenCalledWith(-1);
    expect(input.stepImage).not.toHaveBeenCalled();
  });

  it("arrows step the OPEN film-roll image in Rolls; inert while browsing (#235/#163)", () => {
    const { input } = mount({ input: { mode: "rolls", imageId: 9 } });
    key(document.body, "ArrowRight");
    expect(input.stepImage).toHaveBeenCalledWith(1);
    cleanup();
    const browse = mount({ input: { mode: "rolls", imageId: null } });
    key(document.body, "ArrowRight");
    expect(browse.input.stepImage).not.toHaveBeenCalled(); // native scroll llives
    expect(browse.input.stepPerson).not.toHaveBeenCalled();
  });
});

describe("useAppKeys (#258) — the Esc stack (Q8)", () => {
  afterEach(cleanup);

  it("a live pending stage undoes (the whole set drops, #123) — not while typing", () => {
    const clearPending = vi.fn();
    const { internals } = mount({
      internals: {
        pendingRef: { current: [{ stage: true } as unknown as Stage] },
        clearPending,
      },
    });
    key(document.body, "Escape");
    expect(clearPending).toHaveBeenCalledTimes(1);
    clearPending.mockClear();
    const field = document.createElement("input");
    document.body.appendChild(field);
    key(field, "Escape");
    expect(clearPending).not.toHaveBeenCalled(); // Esc cancels the field itself
    expect(internals.contextConfirmRef.current).toBeNull();
  });

  it("a queued Q4 dialog owns Esc first (#187)", () => {
    const clearPending = vi.fn();
    mount({
      internals: {
        pendingRef: { current: [{ stage: true } as unknown as Stage] },
        contextConfirmRef: { current: { fn: () => {} } },
        clearPending,
      },
    });
    key(document.body, "Escape");
    expect(clearPending).not.toHaveBeenCalled();
  });

  it("with no pending stage, Esc closes the image split (#25)", () => {
    const closeSplit = vi.fn();
    mount({
      input: { splitImageId: 3 },
      internals: { closeSplit },
    });
    key(document.body, "Escape");
    expect(closeSplit).toHaveBeenCalledTimes(1);
  });

  it("behind an overlay the Esc stack resigns (the dialog owns Esc)", () => {
    const closeSplit = vi.fn();
    mount({
      input: { overlayCount: 1, splitImageId: 3 },
      internals: { closeSplit },
    });
    key(document.body, "Escape");
    expect(closeSplit).not.toHaveBeenCalled();
  });
});
