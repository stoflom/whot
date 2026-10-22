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

/** card label overlay: the staged fields for one face (§4.24 H2) */
export function stagedFieldsForCard(
  stage: Stage | null,
  faceId: number,
): { name?: string; group?: string; desc?: string } {
  if (!stage || !stage.faceIds.includes(faceId)) return {};
  const out: { name?: string; group?: string; desc?: string } = {};
  if (stage.name != null) out.name = stage.name;
  if (stage.group != null) out.group = stage.group;
  if (stage.desc != null) out.desc = stage.desc;
  return out;
}

/** header label overlay: any overlap stages the whole heading (§4.24) */
export function stagedFieldsForSection(
  stage: Stage | null,
  sectionIds: number[],
): { name?: string; group?: string; desc?: string } {
  if (!stage || !sectionIds.some((id) => stage.faceIds.includes(id))) return {};
  const out: { name?: string; group?: string; desc?: string } = {};
  if (stage.name != null) out.name = stage.name;
  if (stage.group != null) out.group = stage.group;
  if (stage.desc != null) out.desc = stage.desc;
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

/** human summary of a stage for the escape-or-accept dialog (Q4) */
export function stageSummary(stage: Stage): string {
  const parts: string[] = [];
  if (stage.name != null) parts.push(`name “${stage.name}”`);
  if (stage.group != null) parts.push(stage.group ? `group “${stage.group}”` : "group → ungrouped");
  if (stage.desc != null) parts.push(stage.desc ? `description “${stage.desc}”` : "description → cleared");
  return parts.join(", ") || "no changes";
}
