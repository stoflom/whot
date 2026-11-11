// #221 (F-H1) — the rotated-image cache is now a Blob-URL LRU (the old
// cache was a plain Map of base64 data URLs that was never evicted — the
// only round-2 finding that could leak into OOM territory over a long
// session). The regression contract: N evictions retain ≤ CAP entries
// and every evicted entry's Blob URL is revoked exactly once (the same
// contract the api.ts caches run under). #283 (N7): the revoke lands
// after a grace delay (an <img> mounted just before the eviction gets
// its load started), so the revoke assertions advance the clock.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REVOKE_GRACE_MS } from "./lruCache";

const revoked: string[] = [];

beforeAll(() => {
  Object.defineProperty(URL, "revokeObjectURL", {
    value: (u: string) => revoked.push(u),
    configurable: true,
    writable: true,
  });
});

// a pristine module per test — the cache is module-level state
let hooks: typeof import("./hooks");
beforeEach(async () => {
  vi.resetModules();
  revoked.length = 0;
  hooks = await import("./hooks");
});

describe("rotatedCache (#221 F-H1)", () => {
  it("the cap is bounded (full-size blobs are MB-scale)", () => {
    expect(hooks.ROTATED_CACHE_CAP).toBeGreaterThanOrEqual(1);
    expect(hooks.ROTATED_CACHE_CAP).toBeLessThanOrEqual(64);
  });

  it("N evictions retain ≤ CAP entries and revoke the stale URLs after the grace (#283 N7)", async () => {
    vi.useFakeTimers();
    const { rotatedCache, ROTATED_CACHE_CAP } = hooks;
    const n = ROTATED_CACHE_CAP + 5;
    for (let i = 0; i < n; i++) rotatedCache.set(`id:${i}:90`, `blob:rot-${i}`);
    expect(rotatedCache.size).toBe(ROTATED_CACHE_CAP);
    // not yet — the grace keeps an <img> mounted right before the
    // eviction from losing its load
    expect(revoked).toEqual([]);
    await vi.advanceTimersByTimeAsync(REVOKE_GRACE_MS);
    // exactly the 5 oldest entries were evicted, each revoked once
    expect(revoked).toEqual([0, 1, 2, 3, 4].map((i) => `blob:rot-${i}`));
    // a survivor still resolves
    expect(rotatedCache.get(`id:${n - 1}:90`)).toBe(`blob:rot-${n - 1}`);
    vi.useRealTimers();
  });

  it("a get refreshes recency — the displayed URL is never the evicted one", async () => {
    vi.useFakeTimers();
    const { rotatedCache, ROTATED_CACHE_CAP } = hooks;
    rotatedCache.set("hot", "blob:hot");
    for (let i = 0; i < ROTATED_CACHE_CAP - 1; i++) rotatedCache.set(`f:${i}`, `blob:f-${i}`);
    rotatedCache.get("hot"); // refresh — hot is now most-recent
    rotatedCache.set("f:new", "blob:f-new"); // over the cap → oldest evicts
    await vi.advanceTimersByTimeAsync(REVOKE_GRACE_MS);
    expect(revoked).toEqual(["blob:f-0"]);
    expect(rotatedCache.get("hot")).toBe("blob:hot");
    vi.useRealTimers();
  });
});
