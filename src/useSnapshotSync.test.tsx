// §4.44 round 2 stage 3 (#294) — the backend sync hook, co-located like
// appKeys.ts: a renderHook probe against a MOCKED `./api` seam pins the
// cold-load #185 routing (error vs the §4.36 first-run case), the #219
// delta transport (apply in plan order, exact staleness via the #208
// change stamp), the focus probe and the #247 stable `onImported`
// identity.
// Run: npm test (vitest run)
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useSnapshotSync } from "./useSnapshotSync";
import type { Face, Snapshot } from "./api";

vi.mock("./api", async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import("./api");
  return {
    ...mod,
    getSnapshot: vi.fn(),
    getDataVersion: vi.fn(),
    getImportInfo: vi.fn(),
  };
});
import * as api from "./api";

const getSnapshot = api.getSnapshot as ReturnType<typeof vi.fn>;
const getDataVersion = api.getDataVersion as ReturnType<typeof vi.fn>;
const getImportInfo = api.getImportInfo as ReturnType<typeof vi.fn>;

// ----------------------------------------------------------- fixtures

const face = (id: number, name: string): Face =>
  ({
    id,
    image_id: 1,
    person_id: 1,
    x: 0,
    y: 0,
    w: 10,
    h: 12,
    name,
    seq: id,
    description: null,
    confidence: 1,
    link_status: "provisional",
    state: "ok",
    rotation: 0,
    import_id: null,
  }) as unknown as Face;

const snapshot = (version: number, faces: Face[] = []): Snapshot => ({
  version,
  persons: [],
  faces,
  images: [],
  imports: [],
  settings: {
    face_filter: "all",
    cluster_group: "accuracy",
    cluster_threshold: 0.4,
  } as Snapshot["settings"],
});

const delta = (version: number, base: number, faces?: Face[]) => ({
  version,
  base,
  drifted: false,
  faces,
  removed: [],
});

const flush = () => act(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------- cold load

describe("cold load (#185/§4.36)", () => {
  it("a good load lands in state + the stamp ref", async () => {
    getSnapshot.mockResolvedValue(snapshot(7));
    const { result } = renderHook(() => useSnapshotSync());
    await waitFor(() => expect(result.current.snap?.version).toBe(7));
    expect(result.current.snapVersionRef.current).toBe(7);
    expect(result.current.snapRef.current?.version).toBe(7);
    expect(result.current.loadError).toBeNull();
    expect(result.current.noDb).toBe(false);
  });

  it("a failed load WITH a usable database is the raw error screen", async () => {
    getSnapshot.mockRejectedValue(new Error("boom"));
    getImportInfo.mockResolvedValue({ dbExists: true });
    const { result } = renderHook(() => useSnapshotSync());
    await waitFor(() => expect(result.current.loadError).toContain("boom"));
    expect(result.current.noDb).toBe(false);
  });

  it("a failed load with NO usable database routes to the first-run screen", async () => {
    getSnapshot.mockRejectedValue(new Error("no db"));
    getImportInfo.mockResolvedValue({ dbExists: false });
    const { result } = renderHook(() => useSnapshotSync());
    await waitFor(() => expect(result.current.noDb).toBe(true));
    expect(result.current.loadError).toBeNull();
  });

  it("a failed PROBE (not a missing db) keeps the error screen", async () => {
    getSnapshot.mockRejectedValue(new Error("boom"));
    getImportInfo.mockRejectedValue(new Error("probe down"));
    const { result } = renderHook(() => useSnapshotSync());
    await waitFor(() => expect(result.current.loadError).toContain("boom"));
    expect(result.current.noDb).toBe(false);
  });
});

// --------------------------------------------------- the delta transport

describe("applyDelta/applyDeltas (#219/#281)", () => {
  it("a fresh delta applies locally — no snapshot re-fetch", async () => {
    getSnapshot.mockResolvedValue(snapshot(1, [face(1, "old")]));
    const { result } = renderHook(() => useSnapshotSync());
    await flush();
    getSnapshot.mockClear();
    act(() => result.current.applyDelta(delta(2, 1, [face(1, "new")])));
    expect(result.current.snap?.faces[0].name).toBe("new");
    expect(result.current.snapVersionRef.current).toBe(2);
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("a stale or drifted delta falls back to ONE full refresh", async () => {
    getSnapshot.mockResolvedValue(snapshot(1));
    const { result } = renderHook(() => useSnapshotSync());
    await flush();
    getSnapshot.mockClear();
    getSnapshot.mockResolvedValue(snapshot(9));
    act(() => result.current.applyDelta(delta(3, 5, [face(1, "x")])));
    await waitFor(() => expect(result.current.snap?.version).toBe(9));
    // the drifted flag routes the same way
    act(() =>
      result.current.applyDelta({ ...delta(4, 9), drifted: true })
    );
    await flush();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("a plan applies in order — each base is the previous apply's stamp", async () => {
    getSnapshot.mockResolvedValue(snapshot(1, [face(1, "a")]));
    const { result } = renderHook(() => useSnapshotSync());
    await flush();
    getSnapshot.mockClear();
    await act(async () => {
      await result.current.applyDeltas([
        delta(2, 1, [face(1, "b")]),
        delta(3, 2, [face(1, "c")]),
      ]);
    });
    expect(result.current.snap?.faces[0].name).toBe("c");
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("the first stale delta aborts the plan into ONE refresh", async () => {
    getSnapshot.mockResolvedValue(snapshot(1));
    const { result } = renderHook(() => useSnapshotSync());
    await flush();
    getSnapshot.mockClear();
    getSnapshot.mockResolvedValue(snapshot(9));
    await act(async () => {
      await result.current.applyDeltas([
        delta(5, 42, [face(1, "skipped")]), // base 42 ≠ live stamp 1
        delta(6, 5, [face(1, "never")]),
      ]);
    });
    // the known-stale plan is not half-applied: the refresh won
    expect(result.current.snap?.version).toBe(9);
    expect(result.current.snap?.faces).toEqual([]);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------- the probes

describe("refreshIfChanged + onImported (#208/#247)", () => {
  it("an equal version probe skips the fetch; a moved one refreshes", async () => {
    getSnapshot.mockResolvedValue(snapshot(1));
    const { result } = renderHook(() => useSnapshotSync());
    await flush();
    getSnapshot.mockClear();

    getDataVersion.mockResolvedValue(1);
    await act(async () => void (await result.current.refreshIfChanged()));
    expect(getSnapshot).not.toHaveBeenCalled();

    getDataVersion.mockResolvedValue(2);
    getSnapshot.mockResolvedValue(snapshot(2));
    await act(async () => void (await result.current.refreshIfChanged()));
    expect(result.current.snap?.version).toBe(2);
  });

  it("onImported refreshes and keeps a STABLE identity (#247 — the poll chain's prevRunning memory)", async () => {
    getSnapshot.mockResolvedValue(snapshot(1));
    const { result, rerender } = renderHook(() => useSnapshotSync());
    await flush();
    const first = result.current.onImported;
    rerender();
    expect(result.current.onImported).toBe(first);
    getSnapshot.mockClear();
    getSnapshot.mockResolvedValue(snapshot(3));
    await act(async () => result.current.onImported());
    await waitFor(() => expect(result.current.snap?.version).toBe(3));
  });

  it("the focus/visibility reload probes only when visible (F12)", async () => {
    getSnapshot.mockResolvedValue(snapshot(1));
    renderHook(() => useSnapshotSync());
    await flush();
    getSnapshot.mockClear();
    getDataVersion.mockResolvedValue(1);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(getDataVersion).toHaveBeenCalled(); // visible → probe runs
  });
});
