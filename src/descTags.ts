// #262/#270 (§4.21) — the description type-ahead: the vocabulary
// (the distinct description TAGS — pipe-separated tokens — of the
// snapshot's faces, most-used first, ties by name, count as the row
// hint) and the current-token value rules (matching + pick). Pure —
// no snapshot IPC, no DOM (co-tested in descTags.test.ts).
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

/** #270 (§4.21): the CURRENT token of a description value — the text
    after its LAST `|` (a value with no `|` is its own single token).
    This is what the typeahead matches. `beard|s` → `s`; `|b` → `b`
    (the add-mode prefix is just a leading last-`|`); `beard` →
    `beard`. */
export function descCurrentToken(value: string): string {
  const t = value.trim();
  const i = t.lastIndexOf("|");
  return i === -1 ? t : t.slice(i + 1);
}

/** #270 (§4.21): apply a typeahead pick to a description value —
    replace ONLY the current token, keeping everything up to and
    including the last `|`. `beard|s` + `side` → `beard|side`;
    `|b` + `beard` → `|beard` (the add-mode prefix survives);
    `b` + `beard` → `beard` (no `|` — the whole value was the token).
    Compounds therefore build incrementally, one pick per token. */
export function descApplyPick(value: string, picked: string): string {
  const t = value.trim();
  const i = t.lastIndexOf("|");
  if (i === -1) return picked;
  return `${t.slice(0, i + 1)}${picked}`;
}
