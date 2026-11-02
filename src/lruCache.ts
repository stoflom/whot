// #212 — a tiny LRU map for the image caches: entries evict in
// least-recently-used order once `max` is exceeded (Map iteration order
// IS insertion order; a `get`/`set` of a live key refreshes it). PURE —
// the api.ts cache layer is the only consumer.

export class LruCache<K, V> {
  private map = new Map<K, V>();
  private readonly max: number;

  constructor(max: number) {
    if (max < 1) throw new Error("LruCache max must be >= 1");
    this.max = max;
  }

  /** the value, refreshed as most-recently-used */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** insert/overwrite (refreshing recency), evicting the oldest past max */
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
