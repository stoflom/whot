// #260 — the face-drag machine (useFaceDrag.ts), co-tested like
// appKeys.ts: a mounted probe drives the five grid handlers through
// synthetic DragEvents and pins the state/ref contract (the payload +
// drop target live in refs so a drop never depends on a re-render having
// landed mid-drag) and the identity rule (the ref-driven handlers stay
// stable across renders; the snapshot-reading pair churns only when
// facesById does).
// Run: npm test (vitest run; jsdom pragma — DragEvents need a DOM)
// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useFaceDrag, type FaceDrag } from "./useFaceDrag";
import * as api from "./api";
import type { Face } from "./api";
import type { StagedEntry } from "./stage";

vi.mock("./api", async (importOriginal) => {
  const mod = (await importOriginal()) as typeof api;
  return { ...mod, setFaceDescriptions: vi.fn() };
});

const face = (id: number, description: string | null): Face =>
  ({
    id,
    image_id: 1,
    person_id: 1,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    name: null,
    seq: 1,
    description,
    confidence: 1,
    link_status: "provisional",
    state: "ok",
    rotation: 0,
    import_id: null,
  }) as unknown as Face;

const FACES = new Map<number, Face>([
  [1, face(1, "committed desc")],
  [2, face(2, null)],
  [3, face(3, "  ")],
]);

type DragProbe = React.DragEvent & {
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
  dataTransfer: {
    effectAllowed: string;
    dropEffect: string;
    setData: ReturnType<typeof vi.fn>;
  };
};

const makeDragEvent = (): DragProbe => {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  return {
    preventDefault,
    stopPropagation,
    dataTransfer: {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn(),
    },
  } as DragProbe;
};

let live: FaceDrag | null = null;

function Probe({
  selRef,
  stagedIdxRef,
  facesById,
  mutate,
}: {
  selRef: { current: Set<number> };
  stagedIdxRef: { current: Map<number, StagedEntry> };
  facesById: Map<number, Face>;
  mutate: (fn: () => Promise<unknown>, clearSel?: boolean) => Promise<boolean>;
}) {
  live = useFaceDrag(selRef, stagedIdxRef, facesById, mutate);
  return (
    <div
      data-testid="probe"
      data-drag={live.faceDrag ? live.faceDrag.join(",") : ""}
      data-target={live.faceDropTarget ?? ""}
    />
  );
}

const mount = (over?: {
  sel?: number[];
  staged?: Map<number, StagedEntry>;
  facesById?: Map<number, Face>;
}) => {
  const selRef = { current: new Set(over?.sel ?? []) };
  const stagedIdxRef = { current: over?.staged ?? new Map<number, StagedEntry>() };
  const mutate = vi.fn(async (_fn: () => Promise<unknown>, _clearSel?: boolean) => true);
  const utils = render(
    <Probe
      selRef={selRef}
      stagedIdxRef={stagedIdxRef}
      facesById={over?.facesById ?? FACES}
      mutate={mutate}
    />
  );
  return { utils, selRef, stagedIdxRef, mutate, m: () => live! };
};

describe("useFaceDrag (#260) — the payload (rule 34)", () => {
  afterEach(cleanup);

  it("start: a lone card drags itself", () => {
    const { utils, m } = mount();
    act(() => m().onFaceDragStart(1, makeDragEvent()));
    expect(m().faceDragRef.current).toEqual([1]);
    expect(utils.getByTestId("probe").getAttribute("data-drag")).toBe("1");
  });

  it("start: a card inside a multi-selection drags the WHOLE selection", () => {
    const { utils, m } = mount({ sel: [1, 2, 3] });
    const e = makeDragEvent();
    act(() => m().onFaceDragStart(2, e));
    expect(m().faceDragRef.current).toEqual([1, 2, 3]);
    expect(utils.getByTestId("probe").getAttribute("data-drag")).toBe("1,2,3");
    // Firefox needs the data set (the handler always does it)
    expect(e.dataTransfer.setData).toHaveBeenCalledWith("text/plain", "face 2");
    expect(e.dataTransfer.effectAllowed).toBe("move");
  });

  it("end: clears the payload and the target", () => {
    const { utils, m } = mount({ sel: [1, 2] });
    act(() => m().onFaceDragStart(1, makeDragEvent()));
    act(() => m().onFaceDragOver(1, makeDragEvent()));
    act(() => m().onFaceDragEnd());
    expect(m().faceDragRef.current).toBeNull();
    expect(utils.getByTestId("probe").getAttribute("data-drag")).toBe("");
    expect(utils.getByTestId("probe").getAttribute("data-target")).toBe("");
  });
});

describe("useFaceDrag (#260) — the drop-target highlight (#136)", () => {
  afterEach(cleanup);

  it("over without a live drag is inert", () => {
    const { utils, m } = mount();
    const e = makeDragEvent();
    act(() => m().onFaceDragOver(1, e));
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(utils.getByTestId("probe").getAttribute("data-target")).toBe("");
  });

  it("over a card with no (staged or committed) description is NOT a target (Q3)", () => {
    const { utils, m } = mount({ sel: [1] });
    act(() => m().onFaceDragStart(1, makeDragEvent()));
    const e = makeDragEvent();
    act(() => m().onFaceDragOver(2, e)); // committed description null
    expect(e.preventDefault).not.toHaveBeenCalled();
    act(() => m().onFaceDragOver(3, makeDragEvent())); // whitespace-only
    expect(utils.getByTestId("probe").getAttribute("data-target")).toBe("");
  });

  it("a staged description is the copy source (what the card SHOWS, #224)", () => {
    const { utils, m, stagedIdxRef } = mount({ sel: [1] });
    stagedIdxRef.current = new Map<number, StagedEntry>([
      [2, { desc: "staged", src: {} }],
    ]);
    act(() => m().onFaceDragStart(1, makeDragEvent()));
    const e = makeDragEvent();
    act(() => m().onFaceDragOver(2, e));
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(e.dataTransfer.dropEffect).toBe("move");
    expect(utils.getByTestId("probe").getAttribute("data-target")).toBe("2");
  });

  it("over the SAME target does not churn state", () => {
    const { utils, m } = mount({ sel: [1] });
    act(() => m().onFaceDragStart(1, makeDragEvent()));
    act(() => m().onFaceDragOver(1, makeDragEvent()));
    const target = utils.getByTestId("probe").getAttribute("data-target");
    act(() => m().onFaceDragOver(1, makeDragEvent()));
    expect(utils.getByTestId("probe").getAttribute("data-target")).toBe("1");
    expect(target).toBe("1"); // set on the first over, unchanged on repeats
  });

  it("leave clears the target ONLY for the card being left", () => {
    const { utils, m } = mount({ sel: [2] });
    act(() => m().onFaceDragStart(2, makeDragEvent()));
    act(() => m().onFaceDragOver(1, makeDragEvent())); // card 1 has a desc
    act(() => m().onFaceDragLeave(2)); // not the target
    expect(utils.getByTestId("probe").getAttribute("data-target")).toBe("1");
    act(() => m().onFaceDragLeave(1));
    expect(utils.getByTestId("probe").getAttribute("data-target")).toBe("");
  });
});

describe("useFaceDrag (#260) — the drop (#136/#209)", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.mocked(api.setFaceDescriptions).mockReset();
  });

  it("drop copies the source description onto the payload MINUS itself (#209: one batched command)", async () => {
    const { utils, m, mutate } = mount({ sel: [1, 2] });
    act(() => m().onFaceDragStart(2, makeDragEvent()));
    const e = makeDragEvent();
    act(() => m().onFaceDropOnCard(1, e)); // card 1 SHOWS "committed desc"
    // the drag is over — cleared on the App side too
    expect(m().faceDragRef.current).toBeNull();
    expect(utils.getByTestId("probe").getAttribute("data-drag")).toBe("");
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    // the mutate thunk fires the batched api call over the movers
    const fn = mutate.mock.calls[0][0] as () => Promise<unknown>;
    await act(async () => {
      await fn();
    });
    expect(api.setFaceDescriptions).toHaveBeenCalledWith([2], "committed desc");
  });

  it("drop with no payload (a foreign drop) is a no-op", () => {
    const { m, mutate } = mount();
    act(() => m().onFaceDropOnCard(1, makeDragEvent()));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("drop onto a card whose own description is the only one (payload minus itself is empty) is a no-op", () => {
    const { m, mutate } = mount({ sel: [2] });
    act(() => m().onFaceDragStart(2, makeDragEvent()));
    act(() => m().onFaceDropOnCard(2, makeDragEvent()));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("drop onto a card with no description is a no-op (the browser would not have dropped) — the payload is still cleared", () => {
    const { m, mutate } = mount({ sel: [1, 2] });
    act(() => m().onFaceDragStart(1, makeDragEvent()));
    act(() => m().onFaceDropOnCard(3, makeDragEvent()));
    expect(mutate).not.toHaveBeenCalled();
    expect(m().faceDragRef.current).toBeNull();
  });
});

describe("useFaceDrag (#260) — the shared clear + identity (#98)", () => {
  afterEach(cleanup);

  it("clearFaceDrag is the ONE clear the grid handlers and App's tree-drop share", () => {
    const { utils, m } = mount({ sel: [1] });
    act(() => m().onFaceDragStart(1, makeDragEvent()));
    act(() => m().onFaceDragOver(1, makeDragEvent()));
    act(() => m().clearFaceDrag());
    expect(m().faceDragRef.current).toBeNull();
    expect(utils.getByTestId("probe").getAttribute("data-drag")).toBe("");
    expect(utils.getByTestId("probe").getAttribute("data-target")).toBe("");
  });

  it("the ref-driven handlers keep their identity across a payload re-render (the grid memo never churns mid-drag)", () => {
    const { selRef, m } = mount();
    const first = {
      start: m().onFaceDragStart,
      end: m().onFaceDragEnd,
      leave: m().onFaceDragLeave,
      clear: m().clearFaceDrag,
      over: m().onFaceDragOver,
      drop: m().onFaceDropOnCard,
    };
    // a payload change re-renders the probe…
    act(() => {
      selRef.current = new Set([1, 2]);
      m().onFaceDragStart(1, makeDragEvent());
    });
    expect(m().onFaceDragStart).toBe(first.start);
    expect(m().onFaceDragEnd).toBe(first.end);
    expect(m().onFaceDragLeave).toBe(first.leave);
    expect(m().clearFaceDrag).toBe(first.clear);
    // …and the snapshot-reading pair stays stable while facesById does not
    // change (it churns only with the snapshot — the old grid memo's rate)
    expect(m().onFaceDragOver).toBe(first.over);
    expect(m().onFaceDropOnCard).toBe(first.drop);
  });
});
