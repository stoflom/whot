// #257 — the advance-target prefetch cache: bounded (an #212-style
// LruCache — a long browsing session no longer leaks) and typed (a
// discriminated union over the `c|`/`r|` namespaces — no `as` casts).
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { PREFETCH_CAP, PrefetchCache } from "./prefetch";
import type { AppearanceGroup, Refcrop } from "./api";

// the value shapes are opaque to the cache — any array reference goes
const clusters = (n: string) => [{ name: n }] as unknown as AppearanceGroup[];
const crops = (n: string) => [{ name: n }] as unknown as Refcrop[];

describe("PrefetchCache (#257) — sig- guarded hits", () => {
  it("clusters: a hit only when the signature is unchanged (§213)", () => {
    const c = new PrefetchCache();
    c.setClusters(7, 0.4, "sig-a", clusters("G"));
    expect(c.getClusters(7, 0.4, "sig-a")).toEqual(clusters("G"));
    // stale prefetch (the person's data moved) — never consumed
    expect(c.getClusters(7, 0.4, "sig-b")).toBeNull();
  });

  it("clusters: (id, threshold) is part of the key — a miss on another threshold", () => {
    const c = new PrefetchCache();
    c.setClusters(7, 0.4, "sig-a", clusters("G"));
    expect(c.getClusters(7, 0.5, "sig-a")).toBeNull();
  });

  it("refcrops: a hit only when the signature is unchanged (§213)", () => {
    const c = new PrefetchCache();
    c.setRefcrops(7, "sig-a", crops("R"));
    expect(c.getRefcrops(7, "sig-a")).toEqual(crops("R"));
    expect(c.getRefcrops(7, "sig-b")).toBeNull();
    expect(c.getRefcrops(8, "sig-a")).toBeNull();
  });

  it("the two namespaces never collide — a cached refcrop pair is not a clusters hit (typed as union)", () => {
    const c = new PrefetchCache();
    c.setClusters(7, 0.4, "sig-a", clusters("G"));
    c.setRefcrops(7, "sig-a", crops("R"));
    // `r|7` and `c|7|0.4` are distinct keys; the union's kind guard is
    // unreachable because the type forbids a kind/key cross — pin the
    // lookup contract either way
    expect(c.getClusters(7, 0.4, "sig-a")).toEqual(clusters("G"));
    expect(c.getRefcrops(7, "sig-a")).toEqual(crops("R"));
  });
});

describe("PrefetchCache (#257) — the LRU cap", () => {
  it("never grows past PREFETCH_CAP; the hot entry is refreshed by a get", () => {
    const c = new PrefetchCache();
    for (let i = 0; i < PREFETCH_CAP; i++) {
      c.setRefcrops(i, "sig", crops(`p${i}`));
    }
    // refresh the first person to make it hot...
    c.getRefcrops(0, "sig");
    // ...then one more entry evicts the COLDEST, not the hot one
    c.setRefcrops(PREFETCH_CAP, "sig", crops("new"));
    expect(c.getRefcrops(0, "sig")).toEqual(crops("p0"));
    expect(c.getRefcrops(1, "sig")).toBeNull(); // evicted (coldest)
    expect(c.getRefcrops(PREFETCH_CAP, "sig")).toEqual(crops("new"));
  });

  it("mixed namespaces count against ONE cap (the advance prefetch writes 2/person)", () => {
    const c = new PrefetchCache();
    // cap / 2 persons, each costing one `c|` + one `r|` entry...
    const per = PREFETCH_CAP / 2;
    for (let i = 0; i < per; i++) {
      c.setClusters(i, 0.4, "sig", clusters(`c${i}`));
      c.setRefcrops(i, "sig", crops(`r${i}`));
    }
    expect(c.getRefcrops(0, "sig")).toEqual(crops("r0")); // warmed by the get above
    expect(c.getClusters(0, 0.4, "sig")).toEqual(clusters("c0"));
    // ...one more person (2 entries) evicts exactly the two coldest
    c.setClusters(per, 0.4, "sig", clusters("cN"));
    c.setRefcrops(per, "sig", crops("rN"));
    expect(c.getRefcrops(1, "sig")).toBeNull(); // coldest r
    expect(c.getClusters(1, 0.4, "sig")).toBeNull(); // coldest c
    expect(c.getRefcrops(per, "sig")).toEqual(crops("rN")); // the freshest survives
  });
});
