// #246 — the person fetches in App (personFaceClusters / getRefcrops)
// must not let a LATE fetch land: the cleanup revokes the in-flight
// promise, so person A's clusters can never render in person B's view.
// The effect shape here mirrors App.tsx's two guarded effects verbatim
// (the hooks.ts `let live` useCached idiom, now applied inline there);
// this pins the guard contract the way App's person switching sees it.
// Run: npm test (vitest run; jsdom pragma — an effect with cleanup needs
// a renderer).
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEffect, useState } from "react";

/** deferred per person: the test resolves/rejects in its own order */
const pending: {
  [person: number]: { res: (v: number) => void; rej: (e: Error) => void };
} = {};

const fetchClusters = vi.fn(
  (personId: number) =>
    new Promise<number>((res, rej) => {
      pending[personId] = { res, rej };
    })
);

/** App-shape fixture: the guarded fetch effect (App.tsx #246). */
function usePersonShaped(personId: number | null) {
  const [clusters, setClusters] = useState<number | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    let live = true;                   // #246: the fetch dies with the deps
    if (personId == null) {
      setClusters(null);
      return;
    }
    fetchClusters(personId)
      .then((groups) => {
        if (live) setClusters(groups); // stale fetches never land
      })
      .catch((e) => {
        if (live) setErrors((es) => [...es, String(e)]);
      });
    return () => {
      live = false;              // a person switch revokes any in-flight fetch
    };
  }, [personId]);
  return { clusters, errors };
}

const flush = () => act(async () => {});

describe("person fetch staleness guard (#246)", () => {
  it("an in-flight fetch of the PREVIOUS person never lands after a switch", async () => {
    const h = renderHook((p: number | null) => usePersonShaped(p), {
      initialProps: 7 as number | null,
    });
    await flush();
    expect(h.result.current.clusters).toBeNull();   // A's fetch pending

    h.rerender(8);                       // switch person — A's fetch revoked
    await flush();                       // B's fetch fires, also pending
    expect(fetchClusters).toHaveBeenCalledWith(8);

    await act(async () => pending[7].res(111));     // person A arrives LATE
    expect(h.result.current.clusters).toBeNull();   // …and is revoked: no land

    await act(async () => pending[8].res(222));     // person B arrives
    expect(h.result.current.clusters).toBe(222);    // the live one lands
  });

  it("a rejected fetch surfaces the error while live, not after a revocation", async () => {
    const h = renderHook((p: number | null) => usePersonShaped(p), {
      initialProps: 7 as number | null,
    });
    await flush();

    h.rerender(null);                    // leave the person view — revoked
    await flush();
    await act(async () => pending[7].rej(new Error("boom")));
    expect(h.result.current.errors).toEqual([]);    // stale rejection: silent
                                                 // (nothing renders anyway)

    h.rerender(9);
    await flush();                       // live fetch again
    await act(async () => pending[9].rej(new Error("broken pipe")));
    expect(h.result.current.errors).toEqual(["Error: broken pipe"]);
  });
});
