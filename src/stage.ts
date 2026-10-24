// #101 (gui-design §4.24) — the stage/commit model behind grid editing:
// Apply stages a change on a scope of faces (screen only), Accept
// commits it. Everything here is pure so the contract is unit-testable.

/** which faces an edit acts on — the dialog's scope selector */
export type StageScope = "card" | "group" | "selection";

/** one pending (staged) change; only the fields that were touched exist */
export interface Stage {
  faceIds: number[];
  name?: string;
  group?: string;
  desc?: string;
}

/** dialog prefill for one scope: uniform values, or '' plus a mixed flag
    when the scope's faces disagree (typing then sets them all) */
export interface Prefill {
  name?: string;
  group?: string;
  desc?: string;
  mixed?: ("name" | "group" | "desc")[];
}

export function scopeFaceIds(
  scope: StageScope,
  sets: { card: number[]; group: number[]; selection: number[] },
): number[] {
  return scope === "card" ? sets.card : scope === "group" ? sets.group : sets.selection;
}

/** #77 routing kept: an empty/untouched name means unchanged; group and
    description may be deliberately cleared (empty string). No field
    touched ⇒ nothing to stage (null). */
export function buildStage(
  faceIds: number[],
  values: { name: string; group: string; desc: string },
  touched: { name: boolean; group: boolean; desc: boolean },
): Stage | null {
  const stage: Stage = { faceIds };
  const name = values.name.trim();
  if (touched.name && name) stage.name = name;
  if (touched.group) stage.group = values.group;
  if (touched.desc) stage.desc = values.desc;
  if (stage.name == null && stage.group == null && stage.desc == null) return null;
  return stage;
}

/** #123 — the pending SET: an ordered list of ops, one per Apply. A
    re-Apply on the same faceIds replaces that op (latest wins); every
    other faceIds extends the set. Nothing here commits — Accept does. */
export function upsertStage(set: Stage[], st: Stage): Stage[] {
  const i = set.findIndex((s) => sameIdSet(new Set(s.faceIds), new Set(st.faceIds)));
  if (i === -1) return [...set, st];
  const n = [...set];
  n[i] = st;
  return n;
}

/** F2: ops touching rejected faces are moot (the commit would skip them
    anyway) — drop them from the set when their faces get rejected */
export function dropStagesForFaces(
  set: Stage[],
  faceIds: Iterable<number>,
): Stage[] {
  const gone = new Set(faceIds);
  return set.filter((s) => !s.faceIds.some((id) => gone.has(id)));
}

/** card label overlay: the staged fields for one face (§4.24 H2, #123 —
    ops later in the set win when two cover the same face) */
export function stagedFieldsForCard(
  set: Stage[],
  faceId: number,
): { name?: string; group?: string; desc?: string } {
  const out: { name?: string; group?: string; desc?: string } = {};
  for (const stage of set) {
    if (!stage.faceIds.includes(faceId)) continue;
    if (stage.name != null) out.name = stage.name;
    if (stage.group != null) out.group = stage.group;
    if (stage.desc != null) out.desc = stage.desc;
  }
  return out;
}

/** header label overlay: any overlap stages the whole heading (§4.24,
    #123 — same later-ops-win merge) */
export function stagedFieldsForSection(
  set: Stage[],
  sectionIds: number[],
): { name?: string; group?: string; desc?: string } {
  const out: { name?: string; group?: string; desc?: string } = {};
  for (const stage of set) {
    if (!sectionIds.some((id) => stage.faceIds.includes(id))) continue;
    if (stage.name != null) out.name = stage.name;
    if (stage.group != null) out.group = stage.group;
    if (stage.desc != null) out.desc = stage.desc;
  }
  return out;
}

/** Q1/G3: is the object part of the current selection? (any member —
    a partially selected cluster still counts as "inside") */
export function objectInsideSelection(
  objectIds: number[],
  selection: ReadonlySet<number>,
): boolean {
  return objectIds.some((id) => selection.has(id));
}

/** same membership, order-insensitive */
export function sameIdSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** human summary of one op */
export function stageSummary(stage: Stage): string {
  const parts: string[] = [];
  if (stage.name != null) parts.push(`name “${stage.name}”`);
  if (stage.group != null) parts.push(stage.group ? `group “${stage.group}”` : "group → ungrouped");
  if (stage.desc != null) parts.push(stage.desc ? `description “${stage.desc}”` : "description → cleared");
  return parts.join(", ") || "no changes";
}

/** #123 — compact summary of the whole pending set for the bottom bar
    and the context-change dialog */
export function stageSummarySet(set: Stage[]): string {
  if (set.length === 0) return "";
  const faces = new Set(set.flatMap((s) => s.faceIds));
  const per = set.map((s) => `${stageSummary(s)} · ${s.faceIds.length} face(s)`);
  return `${per.join("  /  ")} — ${faces.size} face(s) staged`;
}
