// #212 — a tiny LRU map for the image caches: entries evict in
// least-recently-used order once `max` is exceeded (Map iteration order
// IS insertion order; a `get`/`set` of a live key refreshes it). PURE —
// the api.ts cache layer is the only consumer.

export class LruCache<K, V> {
  private map = new Map<K, V>();
  private readonly max: number;
  private readonly onEvict?: (key: K, value: V) => void;

  constructor(max: number, onEvict?: (key: K, value: V) => void) {
    if (max < 1) throw new Error("LruCache max must be >= 1");
    this.max = max;
    this.onEvict = onEvict;
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

  /** insert/overwrite (refreshing recency), evicting the oldest past max
      (the eviction hook sees each evicted value exactly once — the #212
      Blob URLs revoke there) */
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const evicted = this.map.get(oldest.value) as V;
      this.map.delete(oldest.value);
      this.onEvict?.(oldest.value, evicted);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
