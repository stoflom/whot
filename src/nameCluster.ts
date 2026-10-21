// Merge Similar Persons — pure detection module (#88, gui-design §4.28).
//
// Clusters persons whose names are near-identical: normalized casefold +
// whitespace + seq-suffix comparison, then Damerau-Levenshtein (optimal
// string alignment — a transposition is ONE edit, plain Levenshtein would
// score it 2 and miss the commonest typo class) with single-linkage.
// Every edge carries evidence so chains (A~B, B~C ⇒ {A,B,C} even if
// A⊀C) stay explainable in the review dialog.
//
// Pure functions only — unit-tested with vitest (nameCluster.test.ts).
// A Python mirror is deliberately rejected: two implementations of one
// rule is how they drift.
import type { Person } from "./api";

/** how two names were judged similar */
export type EvidenceKind = "fold" | "seq" | "alias" | "edit";

export interface Evidence {
  /** person id A (lower id first) */
  a: number;
  /** person id B */
  b: number;
  kind: EvidenceKind;
  /** edit distance — 0 for fold/seq/alias, 1..max for edit */
  distance: number;
}

export interface MergeCluster {
  /** normalized name of the first (lowest-id) member — cluster identity */
  key: string;
  /** that member's original spelling, for display */
  label: string;
  /** members sorted by id */
  members: Person[];
  /** all within-cluster links (single-linkage evidence) */
  edges: Evidence[];
}

export interface MergeOptions {
  /** max Damerau-Levenshtein distance, clamped 1..3; default 2 (#88) */
  distance?: number;
  /** generational-suffix alias groups, e.g. [["J","Jr","Junior"]] */
  suffixAliases?: string[][];
}

export function clampDistance(d: number): number {
  if (!Number.isFinite(d)) return 2;
  return Math.min(3, Math.max(1, Math.round(d)));
}

/** casefold + collapse internal whitespace (comparison base) */
export function foldName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** fold + strip a trailing ` N` seq suffix (#82 rule) */
export function normalizeName(name: string): string {
  return foldName(name).replace(/ \d+$/, "");
}

/** strip trailing tokens that belong to a suffix-alias group (repeatedly) */
export function stripSuffixAliases(normalized: string, groups: string[][]): string {
  if (groups.length === 0) return normalized;
  const parts = normalized.split(" ");
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (groups.some((g) => g.some((tok) => tok.toLowerCase() === last))) parts.pop();
    else break;
  }
  return parts.join(" ");
}

/**
 * Damerau-Levenshtein (OSA) with a band cut-off at `max`: cells with
 * |i-j| > max hold max+1 (edit distance is always ≥ |i-j|, so an optimal
 * ≤ max path never leaves the band). Returns max+1 when out of range.
 */
export function damerauLevenshtein(a: string, b: string, max = 3): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  if (m === 0) return Math.min(n, max + 1);
  if (n === 0) return Math.min(m, max + 1);
  let prev2: number[] = [];
  let prev: number[] = [];
  for (let j = 0; j <= n; j++) prev[j] = Math.abs(0 - j) <= max ? j : max + 1;
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [];
    cur[0] = i <= max ? i : max + 1;
    for (let j = 1; j <= n; j++) {
      if (Math.abs(i - j) > max) {
        cur[j] = max + 1;
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        const tr = prev2[j - 2] + 1;
        if (tr < v) v = tr;
      }
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return Math.min(prev[n], max + 1);
}

/** judge one pair; null = not similar enough */
export function classifyNames(
  raw1: string,
  raw2: string,
  distance: number,
  suffixAliases: string[][],
): { kind: EvidenceKind; distance: number } | null {
  const f1 = foldName(raw1);
  const f2 = foldName(raw2);
  if (f1 === f2) return { kind: "fold", distance: 0 };
  const s1 = f1.replace(/ \d+$/, "");
  const s2 = f2.replace(/ \d+$/, "");
  if (s1 === s2) return { kind: "seq", distance: 0 };
  const a1 = stripSuffixAliases(s1, suffixAliases);
  const a2 = stripSuffixAliases(s2, suffixAliases);
  // reaching here means s1 !== s2, so an equal result implies stripping
  // actually changed a side — that is exactly an alias match
  if (a1 === a2) return { kind: "alias", distance: 0 };
  const d = damerauLevenshtein(a1, a2, distance);
  if (d <= distance) return { kind: "edit", distance: d };
  return null;
}

const UNKNOWN_RE = /^unknown/i;

/** settings text field <-> merge_suffix_aliases: "J,Jr,Junior; S,Sr,Senior" */
export function aliasesToText(groups: string[][]): string {
  return groups.map((g) => g.join(",")).join("; ");
}

export function textToAliases(text: string): string[][] {
  return text
    .split(";")
    .map((g) => g.split(",").map((t) => t.trim()).filter(Boolean))
    .filter((g) => g.length > 0);
}

/**
 * Cluster persons by normalized-name proximity (§4.28).
 * Excludes `Unknown*` persons (importer clusters: Unknown7 vs Unknown8 is
 * distance 1) — they are never merge material nor valid targets.
 * Zero-face persons are kept (listed, contribute no faces to a merge).
 */
export function clusterPersons(
  persons: Person[],
  options: MergeOptions = {},
): MergeCluster[] {
  const distance = clampDistance(options.distance ?? 2);
  const suffixAliases = (options.suffixAliases ?? [])
    .map((g) => g.map((t) => t.trim().toLowerCase()).filter(Boolean))
    .filter((g) => g.length > 0);

  const eligible = persons
    .filter((p) => p.name.trim() !== "" && !UNKNOWN_RE.test(p.name.trim()))
    .slice()
    .sort((x, y) => x.id - y.id);

  // comparison form (after seq strip + aliases) and length buckets —
  // distance ≤ N requires |Δlen| ≤ N, and equal forms share a bucket,
  // so every possible edge is found inside the window
  const cmp = eligible.map((p) =>
    stripSuffixAliases(normalizeName(p.name), suffixAliases),
  );
  const buckets = new Map<number, number[]>();
  cmp.forEach((s, i) => {
    const list = buckets.get(s.length);
    if (list) list.push(i);
    else buckets.set(s.length, [i]);
  });

  const parent = eligible.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const idxById = new Map<number, number>();
  eligible.forEach((p, i) => idxById.set(p.id, i));
  const edges: Evidence[] = [];
  const seenEdges = new Set<string>();
  const consider = (i: number, j: number) => {
    const key = `${i}:${j}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    const verdict = classifyNames(eligible[i].name, eligible[j].name, distance, suffixAliases);
    if (!verdict) return;
    edges.push({ a: eligible[i].id, b: eligible[j].id, kind: verdict.kind, distance: verdict.distance });
    parent[find(i)] = find(j);
  };

  eligible.forEach((_, i) => {
    const len = cmp[i].length;
    for (let l = len - distance; l <= len + distance; l++) {
      const list = buckets.get(l);
      if (!list) continue;
      for (const j of list) if (j > i) consider(i, j);
    }
  });

  const byRoot = new Map<number, MergeCluster>();
  eligible.forEach((p, i) => {
    const root = find(i);
    let cluster = byRoot.get(root);
    if (!cluster) {
      cluster = { key: cmp[i], label: p.name, members: [], edges: [] };
      byRoot.set(root, cluster);
    }
    cluster.members.push(p);
  });
  for (const e of edges) {
    const cluster = byRoot.get(find(idxById.get(e.a)!));
    if (cluster) cluster.edges.push(e);
  }
  return [...byRoot.values()]
    .filter((c) => c.members.length >= 2)
    .map((c) => ({ ...c, edges: c.edges.sort((x, y) => x.a - y.a || x.b - y.b) }))
    .sort((x, y) => x.key.localeCompare(y.key));
}

/** all face ids of a person set, given the snapshot's faces */
export function faceIdsOf(faces: { person_id: number | null; id: number }[], personIds: Set<number>): number[] {
  const out: number[] = [];
  for (const f of faces) if (f.person_id != null && personIds.has(f.person_id)) out.push(f.id);
  return out;
}
