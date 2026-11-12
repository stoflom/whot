// #297 (gui-design rule 50, v15.0) — the thin persistence hook: the ONE
// restore effect (ids reconciled against the snapshot; the #176 boot-guard
// key pre-seeded) and the throttled save. Run: npm test (vitest run)
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import {
  persistSessionPatch,
  useSessionInitial,
  useSessionPersistence,
} from "./useSessionState";
import {
  parseSession,
  serializeSession,
  SESSION_STORAGE_KEY,
} from "./sessionState";
import type { Snapshot } from "./api";

const snapWith = (
  persons: number[],
  images: Array<[number, string]>,
): Snapshot =>
  ({
    version: 1,
    persons: persons.map((id) => ({ id, name: `p${id}` })),
    faces: [],
    images: images.map(([id, primary_path]) => ({ id, primary_path })),
    imports: [],
    settings: {
      cluster_threshold: 0.4,
      refcrop_n: 1,
      face_filter: "all",
      cluster_group: "accuracy",
      merge_name_distance: 2,
    },
  }) as unknown as Snapshot;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const readBlob = () => parseSession(localStorage.getItem(SESSION_STORAGE_KEY));

describe("persistSessionPatch (the merge writer)", () => {
  it("writes a fresh blob when storage is empty", () => {
    persistSessionPatch({ mode: "rolls", personId: null });
    expect(readBlob()?.mode).toBe("rolls");
  });
  it("merges a per-mode scroll field into the existing blob", () => {
    persistSessionPatch({ mode: "review", scroll: { review: 5 } });
    persistSessionPatch({ scroll: { rolls: 9 } });
    const b = readBlob();
    expect(b?.mode).toBe("review");
    expect(b?.scroll).toEqual({ review: 5, rolls: 9 });
  });
  it("a corrupt stored blob is replaced, not merged", () => {
    localStorage.setItem(SESSION_STORAGE_KEY, "{nope");
    persistSessionPatch({ mode: "person" });
    expect(readBlob()?.mode).toBe("person");
  });
});

describe("useSessionInitial (the synchronous seed)", () => {
  function Probe() {
    const i = useSessionInitial();
    return (
      <div
        data-testid="seed"
        data-val={JSON.stringify([i.mode, i.personId, i.paneLeft])}
      />
    );
  }
  it("no storage → the pre-#297 defaults", () => {
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("seed").dataset.val).toBe(
      JSON.stringify(["review", null, 250]),
    );
  });
  it("a stored blob seeds the first render", () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      serializeSession({ v: 1, mode: "person", personId: 3, paneLeft: 320 }),
    );
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("seed").dataset.val).toBe(
      JSON.stringify(["person", 3, 320]),
    );
  });
});

describe("useSessionPersistence (restore + save)", () => {
  const calls = {
    person: [] as Array<number | null>,
    image: [] as Array<number | null>,
  };
  // the harness stashes its guard-key ref here (read after `act`)
  let guardKey: { current: string } | null = null;

  // fully controlled: the setters only RECORD — the test drives the ids
  function Harness({
    snap,
    personId,
    imageId,
    branch = "/",
    filter = "all",
  }: {
    snap: Snapshot | null;
    personId: number | null;
    imageId: number | null;
    branch?: string;
    filter?: string;
  }) {
    const snapRef = useRef<Snapshot | null>(null);
    snapRef.current = snap;
    const guardKeyRef = useRef("");
    guardKey = guardKeyRef;
    useSessionPersistence({
      snapRef,
      mode: "person",
      personId,
      imageId,
      splitImageId: null,
      rollRoot: "/",
      rollBranch: branch,
      rollOpen: new Set(["/a"]),
      rollRecursive: new Set(),
      importDir: null,
      treeFilter: "ali",
      treeCollapsed: new Set(["/g"]),
      mountLimit: 24,
      paneLeft: 300,
      paneRight: 410,
      setPersonId: (v) => calls.person.push(v),
      setImageId: (v) => calls.image.push(v),
      setSplitImageId: () => {},
      noFacesKeyRef: guardKeyRef,
      faceFilter: filter,
    });
    return null;
  }

  it("a dangling person id is cleared against the first snapshot", () => {
    calls.person.length = 0;
    act(() => {
      render(
        <Harness
          snap={snapWith([1, 2], [[10, "/r/a/10.jpg"]])}
          personId={99}
          imageId={null}
        />,
      );
    });
    expect(calls.person).toEqual([null]);
  });

  it("a valid id survives, and the #176 guard key is pre-seeded", () => {
    calls.person.length = 0;
    calls.image.length = 0;
    act(() => {
      render(
        <Harness
          snap={snapWith([1, 2], [[10, "/r/a/10.jpg"]])}
          personId={1}
          imageId={10}
        />,
      );
    });
    expect(calls.person).toEqual([]);
    expect(calls.image).toEqual([]);
    // guard key: `${personId}|${faceFilter}` — the boot pair is silent
    expect(guardKey!.current).toBe("1|all");
  });

  it("an image outside the restored branch is cleared (rule 46)", () => {
    calls.image.length = 0;
    act(() => {
      render(
        <Harness
          snap={snapWith([1], [[10, "/r/a/10.jpg"], [11, "/r/b/11.jpg"]])}
          personId={null}
          imageId={11}
          branch="/r/a"
        />,
      );
    });
    expect(calls.image).toEqual([null]);
  });

  it("the throttled save writes the whole persisted set after 300 ms", () => {
    act(() => {
      render(
        <Harness
          snap={snapWith([1], [[10, "/r/a/10.jpg"]])}
          personId={1}
          imageId={10}
        />,
      );
    });
    expect(readBlob()).toBeNull(); // not yet — the debounce has not fired
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const b = readBlob();
    expect(b?.mode).toBe("person");
    expect(b?.personId).toBe(1);
    expect(b?.imageId).toBe(10);
    expect(b?.rollOpen).toEqual(["/a"]);
    expect(b?.treeFilter).toBe("ali");
    expect(b?.treeCollapsed).toEqual(["/g"]);
    expect(b?.mountLimit).toBe(24);
    expect(b?.paneLeft).toBe(300);
    expect(b?.paneRight).toBe(410);
  });

  it("rapid changes coalesce into ONE save (the timer restarts)", () => {
    let h!: ReturnType<typeof render>;
    act(() => {
      h = render(
        <Harness
          snap={snapWith([1, 2], [[10, "/r/a/10.jpg"]])}
          personId={1}
          imageId={null}
        />,
      );
    });
    act(() => {
      h.rerender(
        <Harness
          snap={snapWith([1, 2], [[10, "/r/a/10.jpg"]])}
          personId={2}
          imageId={null}
        />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(readBlob()?.personId).toBe(2);
  });
});

