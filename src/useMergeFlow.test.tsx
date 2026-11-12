// §4.44 round 2 stage 5 (#296) — the merge engine, co-located like the
// other round-2 modules: a renderHook probe against a mocked `./api`
// pins the §4.28 refusals and no-ops (the UnknownN target, the
// only-selection drop, the no-faces merge), the one-transaction
// assign_person contract (#178: the EMPTY group part), the #133
// post-merge re-anchor (success-only), the #135 face-level plan and
// the #88/#287 triage routes.
// Run: npm test (vitest run)
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMergeFlow, type MergeFlowDeps } from "./useMergeFlow";
import type { Face, Person, Snapshot } from "./api";
import type { Mode } from "./sections";

vi.mock("./api", async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import("./api");
  return {
    ...mod,
    assignPerson: vi.fn(),
    setSettings: vi.fn(),
    movePersonsToGroup: vi.fn(),
  };
});
import * as api from "./api";

const assignPerson = api.assignPerson as ReturnType<typeof vi.fn>;
const setSettings = api.setSettings as ReturnType<typeof vi.fn>;
const movePersonsToGroup = api.movePersonsToGroup as ReturnType<typeof vi.fn>;

// ----------------------------------------------------------- fixtures

const person = (id: number, name: string): Person =>
  ({
    id,
    name,
    state: "ok",
    note: null,
    primary_face_id: null,
    primary_pinned: 0,
    created_at: "",
    groups: [],
    counts: { total: 1, provisional: 1, confirmed: 0, rejected: 0 },
  }) as unknown as Person;

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

const snapWith = (persons: Person[], faces: Face[]): Snapshot => ({
  version: 1,
  persons,
  faces,
  images: [],
  imports: [],
  settings: {
    face_filter: "all",
    cluster_group: "accuracy",
    cluster_threshold: 0.4,
  } as Snapshot["settings"],
});

const P = { a: person(1, "John Smith1"), b: person(2, "John Smith2") };
const UNKNOWN = person(3, "Unknown5");

const mkDeps = (snap: Snapshot | null = snapWith([P.a, P.b], [face(10, 1), face(11, 2)])) => {
  const spies = {
    // the real mutate runs the fn inside its own IPC/error handling —
    // the spy mirrors that (the fn IS the api call)
    mutate: vi.fn(async (fn: () => Promise<unknown>) => {
      await fn();
      return true;
    }),
    refresh: vi.fn().mockResolvedValue(undefined),
    setInfo: vi.fn(),
    setError: vi.fn(),
    setPersonId: vi.fn(),
    setImageId: vi.fn(),
    setMode: vi.fn(),
    clearFaceDrag: vi.fn(),
    openEdit: vi.fn(),
  };
  const personsById = new Map(
    snap?.persons.map((p) => [p.id, p]) ?? []
  );
  const deps: MergeFlowDeps = {
    snap,
    personsById,
    mutate: spies.mutate,
    refresh: spies.refresh,
    setInfo: spies.setInfo,
    setError: spies.setError,
    setPersonId: spies.setPersonId,
    setImageId: spies.setImageId,
    setMode: spies.setMode,
    clearFaceDrag: spies.clearFaceDrag,
    openEdit: spies.openEdit,
  };
  return { deps, spies };
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ------------------------------------------------------ triage routes

describe("triage routes (#88/#287)", () => {
  it("the tree route opens with a NULL anchor; the pane route anchors the id", () => {
    const { deps } = mkDeps();
    const { result } = renderHook(() => useMergeFlow(deps));
    act(() => result.current.openMergeDialog());
    expect(result.current.mergeOpen).toBe(true);
    expect(result.current.mergeAnchor).toBeNull();
    act(() => result.current.closeMergeDialog());
    act(() => result.current.openMergeSimilar(2));
    expect(result.current.mergeOpen).toBe(true);
    expect(result.current.mergeAnchor).toBe(2);
    act(() => result.current.closeMergeDialog());
    expect(result.current.mergeOpen).toBe(false);
    expect(result.current.mergeAnchor).toBeNull();
  });
});

// --------------------------------------------------- the §4.28 shared confirmation

describe("openMergeInto (§4.28)", () => {
  it("refuses an UnknownN target up-front (also refused server-side)", () => {
    const { deps, spies } = mkDeps(snapWith([P.a, UNKNOWN], [face(10, 1)]));
    const { result } = renderHook(() => useMergeFlow(deps));
    act(() => result.current.openMergeInto([1], 3));
    expect(result.current.mergeInto).toBeNull();
    expect(spies.setError).toHaveBeenCalledWith(
      "cannot merge into an UnknownN cluster — it is an importer placeholder, not a person"
    );
  });

  it("a drop onto the only selection is the designed no-op", () => {
    const { deps, spies } = mkDeps();
    const { result } = renderHook(() => useMergeFlow(deps));
    act(() => result.current.openMergeInto([2], 2));
    expect(result.current.mergeInto).toBeNull();
    expect(spies.setInfo).toHaveBeenCalledWith(
      "already merged — the drop target is the only selection"
    );
  });

  it("otherwise opens the shared confirmation with the payload", () => {
    const { deps } = mkDeps();
    const { result } = renderHook(() => useMergeFlow(deps));
    act(() => result.current.openMergeInto([1, 2]));
    expect(result.current.mergeInto).toEqual({ sourceIds: [1, 2], targetId: undefined });
  });
});

// -------------------------------------------------------- confirmMerge

describe("confirmMerge (#178/§4.1/#133)", () => {
  it("moves ONLY the sources' faces, with the EMPTY group part", async () => {
    const { deps } = mkDeps();
    const { result } = renderHook(() => useMergeFlow(deps));
    act(() => result.current.openMergeInto([1, 2]));
    await act(async () => void (await result.current.confirmMerge(P.b)));
    // source 1's faces move; the target's own faces stay put (§4.28);
    // the group part is "" — a status seat can never reach validation
    expect(assignPerson).toHaveBeenCalledWith([10], "John Smith2", "");
  });

  it("re-anchors the centre on the target — success only (#133)", async () => {
    const { deps, spies } = mkDeps();
    const { result } = renderHook(() => useMergeFlow(deps));
    act(() => result.current.openMergeInto([1]));
    await act(async () => void (await result.current.confirmMerge(P.b)));
    expect(spies.setPersonId).toHaveBeenCalledWith(2);
    expect(spies.setImageId).toHaveBeenCalledWith(null);
    expect(spies.setMode).toHaveBeenCalledWith("person" as Mode);

    spies.setPersonId.mockClear();
    spies.mutate.mockResolvedValue(false);
    act(() => result.current.openMergeInto([1]));
    await act(async () => void (await result.current.confirmMerge(P.b)));
    expect(spies.setPersonId).not.toHaveBeenCalled(); // a failed merge leaves the view
  });

  it("a merge with no faces says so and closes the dialog", async () => {
    const { deps, spies } = mkDeps(snapWith([P.a, P.b], []));
    const { result } = renderHook(() => useMergeFlow(deps));
    act(() => result.current.openMergeInto([1]));
    await act(async () => void (await result.current.confirmMerge(P.b)));
    expect(assignPerson).not.toHaveBeenCalled();
    expect(result.current.mergeInto).toBeNull();
    expect(spies.setInfo).toHaveBeenCalledWith(
      "nothing to merge — the selected persons have no faces"
    );
  });
});

// -------------------------------------------------- the face-level path

describe("onFacesDropped/confirmFaceMerge (#135/rule 34)", () => {
  it("clears the drag FIRST, then validates (UnknownN refused)", () => {
    const { deps, spies } = mkDeps(snapWith([P.a, UNKNOWN], [face(10, 1)]));
    const { result } = renderHook(() => useMergeFlow(deps));
    act(() => result.current.onFacesDropped([10], 3));
    expect(spies.clearFaceDrag).toHaveBeenCalledTimes(1);
    expect(result.current.faceMerge).toBeNull();
    expect(spies.setError).toHaveBeenCalled();
  });

  it("faces already on the target are the designed no-op, with the count", () => {
    const { deps, spies } = mkDeps(snapWith([P.a, P.b], [face(10, 2)]));
    const { result } = renderHook(() => useMergeFlow(deps));
    act(() => result.current.onFacesDropped([10], 2));
    expect(result.current.faceMerge).toBeNull();
    expect(spies.setInfo).toHaveBeenCalledWith(
      "all 1 face(s) are already on John Smith2 — nothing to move"
    );
  });

  it("otherwise opens the FACE-level dialog with the plan's movers", () => {
    const { deps } = mkDeps(snapWith([P.a, P.b], [face(10, 1), face(11, 1)]));
    const { result } = renderHook(() => useMergeFlow(deps));
    act(() => result.current.onFacesDropped([10, 11], 2));
    expect(result.current.faceMerge).toEqual({ faceIds: [10, 11], targetId: 2 });
  });

  it("confirm closes the dialog, merges with the empty group, re-anchors on success", async () => {
    const { deps, spies } = mkDeps(snapWith([P.a, P.b], [face(10, 1)]));
    const { result } = renderHook(() => useMergeFlow(deps));
    act(() => result.current.onFacesDropped([10], 2));
    await act(async () => void (await result.current.confirmFaceMerge()));
    expect(result.current.faceMerge).toBeNull();
    expect(assignPerson).toHaveBeenCalledWith([10], "John Smith2", "");
    expect(spies.setPersonId).toHaveBeenCalledWith(2);
    expect(spies.setMode).toHaveBeenCalledWith("person");
  });
});

// ------------------------------------------------- the ancillary routes

describe("saveMergeSettings / renamePersons / applyGroupToSelection", () => {
  it("saveMergeSettings patches the current settings, then refreshes", async () => {
    setSettings.mockResolvedValue(undefined);
    const { deps, spies } = mkDeps();
    const { result } = renderHook(() => useMergeFlow(deps));
    await act(async () => void (await result.current.saveMergeSettings({ cluster_threshold: 0.5 })));
    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ cluster_threshold: 0.5 })
    );
    expect(spies.refresh).toHaveBeenCalledTimes(1);
  });

  it("renamePersons opens the shared Edit dialog over ALL the persons' faces", () => {
    const { deps, spies } = mkDeps(snapWith([P.a, P.b], [face(10, 1), face(11, 1), face(12, 2)]));
    const { result } = renderHook(() => useMergeFlow(deps));
    act(() => result.current.renamePersons([1, 2]));
    expect(spies.openEdit).toHaveBeenCalledWith("group", { group: [10, 11, 12] });
  });

  it("a selection with no faces says so instead of opening the dialog", () => {
    const { deps, spies } = mkDeps(snapWith([P.a], []));
    const { result } = renderHook(() => useMergeFlow(deps));
    act(() => result.current.renamePersons([1]));
    expect(spies.openEdit).not.toHaveBeenCalled();
    expect(spies.setInfo).toHaveBeenCalledWith(
      "no faces to rename — the selection has no faces"
    );
  });

  it("applyGroupToSelection ignores the empty call, moves otherwise", () => {
    movePersonsToGroup.mockResolvedValue(undefined);
    const { deps } = mkDeps();
    const { result } = renderHook(() => useMergeFlow(deps));
    act(() => result.current.applyGroupToSelection([], "Family|X"));
    expect(movePersonsToGroup).not.toHaveBeenCalled();
    act(() => result.current.applyGroupToSelection([1, 2], "Family|X"));
    expect(movePersonsToGroup).toHaveBeenCalledWith([1, 2], "Family|X");
  });
});
