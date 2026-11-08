// #234 (rule 45) — the advance-target prefetch, handed its own bounded
// + typed home (#257). Previously an unbounded `Map<string, { sig:
// string; value: unknown }>` inside App.tsx: entries accumulated for
// the whole session and never evicted (a slow leak), and the values
// entered state via untyped `as` casts.
//
// Now: ONE value type — a discriminated union so the two key
// namespaces (`c|id|threshold` clusters, `r|id` refcrops) are enforced
// by the type and the helpers below, never by convention — over an
// `LruCache` (the #212 engine behind the rotated-image cache): least-
// recently-used eviction at PREFETCH_CAP bounds the session. The
// entries are fetched arrays (no blobs to revoke), so eviction costs
// only one refetch the next time that person advances — the same
// trade the rotated cache makes for its MB-scale blobs.
//
// The `sig` is the #213 person-data signature: the consumer accepts an
// entry only when the signature is unchanged since the prefetch, so
// `get*` folds the match in and the `as` casts disappear.

import type { AppearanceGroup, Refcrop } from "./api";
import { LruCache } from "./lruCache";

/** matches the rotated-image cache cap — both bound long browsing
    sessions at the same rate (hooks.ts ROTATED_CACHE_CAP) */
export const PREFETCH_CAP = 24;

export type PrefetchEntry =
  | { kind: "clusters"; sig: string; value: AppearanceGroup[] }
  | { kind: "refcrops"; sig: string; value: Refcrop[] };

// the two namespaces, keyed ONLY here so they cannot collide
const clustersKey = (id: number, threshold: number) => `c|${id}|${threshold}`;
const refcropsKey = (id: number) => `r|${id}`;

export class PrefetchCache {
  private lru = new LruCache<string, PrefetchEntry>(PREFETCH_CAP);

  /** the person's prefetched clusters when the signature is unchanged
      since the prefetch (§213) — null on a miss or a stale entry */
  getClusters(id: number, threshold: number, sig: string): AppearanceGroup[] | null {
    const hit = this.lru.get(clustersKey(id, threshold));
    return hit && hit.kind === "clusters" && hit.sig === sig ? hit.value : null;
  }

  setClusters(
    id: number,
    threshold: number,
    sig: string,
    value: AppearanceGroup[],
  ): void {
    this.lru.set(clustersKey(id, threshold), { kind: "clusters", sig, value });
  }

  /** the person's prefetched refcrops when the signature is unchanged
      since the prefetch (§213) — null on a miss or a stale entry */
  getRefcrops(id: number, sig: string): Refcrop[] | null {
    const hit = this.lru.get(refcropsKey(id));
    return hit && hit.kind === "refcrops" && hit.sig === sig ? hit.value : null;
  }

  setRefcrops(id: number, sig: string, value: Refcrop[]): void {
    this.lru.set(refcropsKey(id), { kind: "refcrops", sig, value });
  }
}
