// §4.44 round 2 stage 2 (#293) — the face-selection layer hook,
// co-located like useFaceDrag: a renderHook probe drives the handler
// family through synthetic calls and pins the state/ref contract (the
// #98 identity rule first: a selection change churns NO callback
// identity) and the anchor/lastSel semantics (#53/#69/#88).
// Run: npm test (vitest run)
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import type { Face } from "./api";
import type { Section } from "./components/FaceGrid";
import { useSelectionState, type SelectionDeps } from "./useSelectionState";

// ----------------------------------------------------------- fixtures

const face = (id: number, personId: number | null): Face =>
  ({
    id,
    image_id: 1,
    person_id: personId,
    x: 0,
    y: 0,
    w: 10,
    h: 12,
    name: `f${id}`,
    seq: id,
    description: null,
    confidence: 1,
    link_status: "provisional",
    state: "ok",
    rotation: 0,
    import_id: null,
  }) as unknown as Face;

const sec = (key: string, faceIds: number[]): Section => ({
  key,
  title: key,
  faceIds,
});

const mkDeps = (
  over: Partial<SelectionDeps> = {}
): { deps: SelectionDeps; spies: Record<string, ReturnType<typeof vi.fn>> } => {
  const spies = {
    closeSplitForFaces: vi.fn(),
    followCrop: vi.fn(),
    setPersonId: vi.fn(),
  };
  const deps: SelectionDeps = {
    ...spies,
    facesByIdRef: {
      current: new Map([
        [1, face(1, 10)],
        [2, face(2, null)], // legacy row: no person
      ]),
    } as RefObject<Map<number, Face>>,
    sectionsRef: {
      current: [sec("a", [1, 2, 3]), sec("b", [4, 5])],
    } as RefObject<Section[]>,
    sectionsForImageRef: {
      current: () => [sec("split", [7, 8])],
    } as RefObject<(imgId: number) => Section[]>,
    splitImageId: null,
    ...over,
  };
  return { deps, spies };
};

beforeEach(() => {
  vi.clearAllMocks();
});

// --------------------------------------------------- the #98 identity rule

describe("identity (#98)", () => {
  it("a selection change churns NO handler identity", () => {
    const { deps } = mkDeps();
    const { result, rerender } = renderHook(() => useSelectionState(deps));
    const before = {
      toggle: result.current.toggle,
      toggleMany: result.current.toggleMany,
      changeSel: result.current.changeSel,
      actionScope: result.current.actionScope,
      selectOnly: result.current.selectOnly,
      rectToggle: result.current.rectToggle,
    };
    act(() => result.current.changeSel(new Set([1, 2])));
    rerender();
    expect(result.current.sel).toEqual(new Set([1, 2]));
    expect(result.current.toggle).toBe(before.toggle);
    expect(result.current.toggleMany).toBe(before.toggleMany);
    expect(result.current.changeSel).toBe(before.changeSel);
    expect(result.current.actionScope).toBe(before.actionScope);
    expect(result.current.selectOnly).toBe(before.selectOnly);
    expect(result.current.rectToggle).toBe(before.rectToggle);
  });
});

// ------------------------------------------------------------- selRef

describe("selRef + changeSel (#123)", () => {
  it("the ref mirrors the state for event-time reads", () => {
    const { deps } = mkDeps();
    const { result } = renderHook(() => useSelectionState(deps));
    act(() => result.current.changeSel(new Set([3])));
    expect(result.current.selRef.current).toEqual(new Set([3]));
  });
});

// -------------------------------------------------------------- toggle

describe("toggle (#69/#53/#52/#201)", () => {
  it("adds: anchor + lastSel + the view-context reactions fire", () => {
    const { deps, spies } = mkDeps();
    const { result } = renderHook(() => useSelectionState(deps));
    act(() => result.current.toggle(1));
    expect(result.current.sel).toEqual(new Set([1]));
    expect(result.current.anchorRef.current).toBe(1);
    expect(result.current.lastSelRef.current).toBe(1);
    expect(spies.closeSplitForFaces).toHaveBeenCalledWith([1]);
    expect(spies.followCrop).toHaveBeenCalledWith(1);
  });

  it("removes: the id drops, lastSel is NOT touched", () => {
    const { deps } = mkDeps();
    const { result } = renderHook(() => useSelectionState(deps));
    act(() => result.current.toggle(1));
    act(() => result.current.toggle(1));
    expect(result.current.sel).toEqual(new Set());
    expect(result.current.lastSelRef.current).toBe(1); // stays from the add
  });
});

// ---------------------------------------------------------- toggleMany

describe("toggleMany (#53/#88)", () => {
  it("on: adds every id, lastSel = the LAST id", () => {
    const { deps } = mkDeps();
    const { result } = renderHook(() => useSelectionState(deps));
    act(() => result.current.toggleMany([2, 5], true));
    expect(result.current.sel).toEqual(new Set([2, 5]));
    expect(result.current.lastSelRef.current).toBe(5);
  });

  it("off: removes every id without touching lastSel", () => {
    const { deps } = mkDeps();
    const { result } = renderHook(() => useSelectionState(deps));
    act(() => result.current.toggle(1));
    act(() => result.current.toggleMany([1, 2], false));
    expect(result.current.sel).toEqual(new Set());
    expect(result.current.lastSelRef.current).toBe(1);
  });
});

// ---------------------------------------------------------- rectToggle

describe("rectToggle (#171/§4.37)", () => {
  it("toggles AND anchors the right pane on the face's person", () => {
    const { deps, spies } = mkDeps();
    const { result } = renderHook(() => useSelectionState(deps));
    act(() => result.current.rectToggle(1)); // person_id 10
    expect(result.current.sel).toEqual(new Set([1]));
    expect(spies.setPersonId).toHaveBeenCalledWith(10);
  });

  it("a NULL person_id (legacy row) leaves the anchor untouched", () => {
    const { deps, spies } = mkDeps();
    const { result } = renderHook(() => useSelectionState(deps));
    act(() => result.current.rectToggle(2)); // person_id null
    expect(result.current.sel).toEqual(new Set([2]));
    expect(spies.setPersonId).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------- actionScope

describe("actionScope (#49/§4.14)", () => {
  it("the card inside a multi-selection acts on the whole selection", () => {
    const { deps } = mkDeps();
    const { result } = renderHook(() => useSelectionState(deps));
    act(() => result.current.changeSel(new Set([1, 2, 3])));
    expect(result.current.actionScope(2)).toEqual([1, 2, 3]);
  });

  it("a lone or unselected card acts on just that card", () => {
    const { deps } = mkDeps();
    const { result } = renderHook(() => useSelectionState(deps));
    act(() => result.current.changeSel(new Set([1])));
    expect(result.current.actionScope(1)).toEqual([1]);
    expect(result.current.actionScope(9)).toEqual([9]);
  });
});

// ------------------------------------------------ selectOnly/rangeSelect

describe("selectOnly + rangeSelect (#69/§4.37)", () => {
  it("plain click: select just this card, re-anchor, reactions fire", () => {
    const { deps, spies } = mkDeps();
    const { result } = renderHook(() => useSelectionState(deps));
    act(() => result.current.selectOnly(4));
    expect(result.current.sel).toEqual(new Set([4]));
    expect(result.current.anchorRef.current).toBe(4);
    expect(result.current.lastSelRef.current).toBe(4);
    expect(spies.closeSplitForFaces).toHaveBeenCalledWith([4]);
    expect(spies.followCrop).toHaveBeenCalledWith(4);
  });

  it("shift-click: the contiguous range anchor…clicked, over rendered order", () => {
    const { deps } = mkDeps();
    const { result } = renderHook(() => useSelectionState(deps));
    act(() => result.current.selectOnly(2)); // anchor
    act(() => result.current.rangeSelect(4)); // 2..4 spans sections a→b
    expect(result.current.sel).toEqual(new Set([2, 3, 4]));
    expect(result.current.anchorRef.current).toBe(2); // anchor stays put
    expect(result.current.lastSelRef.current).toBe(4);
  });

  it("repeated shift-clicks re-anchor the same start", () => {
    const { deps } = mkDeps();
    const { result } = renderHook(() => useSelectionState(deps));
    act(() => result.current.selectOnly(2));
    act(() => result.current.rangeSelect(4));
    act(() => result.current.rangeSelect(1)); // 2..1 backwards
    expect(result.current.sel).toEqual(new Set([1, 2]));
  });

  it("a missing anchor or card falls back to selectOnly", () => {
    const { deps, spies } = mkDeps();
    const { result } = renderHook(() => useSelectionState(deps));
    // anchor 99 is not in the rendered order
    act(() => result.current.selectOnly(99));
    act(() => result.current.rangeSelect(3));
    expect(result.current.sel).toEqual(new Set([3]));
    expect(spies.closeSplitForFaces).toHaveBeenLastCalledWith([3]);
  });

  it("the focus split routes renderedIds to the split's own sections", () => {
    const { deps } = mkDeps({ splitImageId: 42 });
    const { result } = renderHook(() => useSelectionState(deps));
    act(() => result.current.selectOnly(7));
    act(() => result.current.rangeSelect(8));
    expect(result.current.sel).toEqual(new Set([7, 8]));
  });
});

// ----------------------------------------------------------- selPersons

describe("selPersons (the tree's selection state)", () => {
  it("independent of the face selection", () => {
    const { deps } = mkDeps();
    const { result } = renderHook(() => useSelectionState(deps));
    act(() => result.current.setSelPersons(new Set([3, 4])));
    expect(result.current.selPersons).toEqual(new Set([3, 4]));
    expect(result.current.sel).toEqual(new Set());
  });
});
