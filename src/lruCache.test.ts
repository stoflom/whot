// #212 — the bounded-cache rule.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { LruCache } from "./lruCache";

describe("LruCache (#212)", () => {
  it("stores and retrieves", () => {
    const c = new LruCache<number, string>(3);
    c.set(1, "a");
    expect(c.get(1)).toBe("a");
    expect(c.get(2)).toBeUndefined();
    expect(c.has(1)).toBe(true);
    expect(c.size).toBe(1);
  });

  it("evicts the least-recently-used past max", () => {
    const c = new LruCache<number, string>(2);
    c.set(1, "a");
    c.set(2, "b");
    c.set(3, "c");
    expect(c.has(1)).toBe(false);
    expect(c.has(2)).toBe(true);
    expect(c.has(3)).toBe(true);
    expect(c.size).toBe(2);
  });

  it("a get refreshes recency", () => {
    const c = new LruCache<number, string>(2);
    c.set(1, "a");
    c.set(2, "b");
    expect(c.get(1)).toBe("a"); // 1 is now the most recent
    c.set(3, "c"); // evicts 2
    expect(c.has(1)).toBe(true);
    expect(c.has(2)).toBe(false);
    expect(c.has(3)).toBe(true);
  });

  it("overwriting a key refreshes recency without growing", () => {
    const c = new LruCache<number, string>(2);
    c.set(1, "a");
    c.set(2, "b");
    c.set(1, "a2");
    c.set(3, "c"); // evicts 2 (1 was refreshed)
    expect(c.get(1)).toBe("a2");
    expect(c.has(2)).toBe(false);
    expect(c.size).toBe(2);
  });

  it("delete drops an entry", () => {
    const c = new LruCache<number, string>(2);
    c.set(1, "a");
    c.delete(1);
    expect(c.has(1)).toBe(false);
    expect(c.size).toBe(0);
  });

  it("refuses a non-positive max", () => {
    expect(() => new LruCache(0)).toThrow();
    expect(() => new LruCache(-1)).toThrow();
  });

  it("calls onEvict for each evicted entry (the #212 revoke hook)", () => {
    const evicted: string[] = [];
    const c = new LruCache<number, string>(2, (k, v) => evicted.push(`${k}:${v}`));
    c.set(1, "a");
    c.set(2, "b");
    c.set(3, "c"); // evicts 1
    c.set(2, "b2");
    c.set(4, "d"); // evicts 3 (2 was refreshed)
    expect(evicted).toEqual(["1:a", "3:c"]);
    c.delete(2);
    expect(evicted, "delete is the caller's own doing, not an eviction").toEqual(["1:a", "3:c"]);
  });
});
