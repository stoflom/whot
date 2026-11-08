// #262 (§4.21) — the description type-ahead vocabulary: the distinct
// description TAGS (pipe-separated tokens) of the snapshot's faces,
// most-used first, ties by name, the usage count as the row hint. Pure
// over the snapshot — no backend path (co-tested in descTags.test.ts).
import type { Face } from "./api";
import type { SuggestOption } from "./components/SuggestInput";

export function descTagOptions(faces: Face[]): SuggestOption[] {
  const counts = new Map<string, number>();
  for (const f of faces) {
    for (const t of (f.description ?? "")
      .split("|")
      .map((t) => t.trim())
      .filter(Boolean))
      counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, n]) => ({ value, hint: String(n) }));
}
