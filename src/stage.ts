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
  /** #307 (v19.0): the person-note value (raw dialog value — a leading
      `|` marks the concat-add; the expansion happens at commit) */
  note?: string;
}

/** dialog prefill for one scope: uniform values, or '' plus a mixed flag
    when the scope's faces disagree (typing then sets them all) */
export interface Prefill {
  name?: string;
  group?: string;
  desc?: string;
  /** #307: the scope's distinct owners' note — uniform, or mixed */
  note?: string;
  mixed?: ("name" | "group" | "desc" | "note")[];
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
  values: { name: string; group: string; desc: string; note: string },
  touched: { name: boolean; group: boolean; desc: boolean; note: boolean },
): Stage | null {
  const stage: Stage = { faceIds };
  const name = values.name.trim();
  if (touched.name && name) stage.name = name;
  if (touched.group) stage.group = values.group;
  if (touched.desc) {
    // #231/#263 (§4.24): a `|` add-mode value with no tokens is a no-op —
    // it never stages (a literal leading `|` must not reach the writer)
    const d = values.desc.trim();
    if (!(d.startsWith("|") && addTokens(values.desc).length === 0))
      stage.desc = values.desc;
  }
  if (touched.note) {
    // #307 (v19.0): the note mirrors the deliberate-clear semantics — an
    // empty touched value clears; a lone `|` (nothing to add) is a no-op
    const n = values.note.trim();
    if (!(n.startsWith("|") && n.slice(1).trim() === "")) stage.note = values.note;
  }
  if (stage.name == null && stage.group == null && stage.desc == null && stage.note == null)
    return null;
  return stage;
}

/** #231/#263 (§4.24): the add-mode tokens of a `|`-prefixed description
    value — the value minus the leading `|`, split on `|`, trimmed,
    empties dropped. A value without a leading `|` yields no tokens
    (plain replace semantics). */
export function addTokens(desc: string): string[] {
  const v = desc.trim();
  if (!v.startsWith("|")) return [];
  return v
    .slice(1)
    .split("|")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** #231: append the add-mode tokens to a face's existing descriptors —
    the existing order is kept, new tokens come in typed order, and a
    token the face already carries is skipped (no duplicates). */
export function applyAdd(existing: string, tokens: string[]): string {
  const cur = existing
    .split("|")
    .map((t) => t.trim())
    .filter(Boolean);
  for (const t of tokens) if (!cur.includes(t)) cur.push(t);
  return cur.join("|");
}

/** #231 (§4.24): expand a `+`-prefixed description stage into concrete
    per-face stages. Each face resolves the add against its DISPLAYED
    value (the staged overlay over the committed one); faces the add
    leaves unchanged drop out (no-op — no re-seq/refcrop churn); and
    each distinct resolved value carries its own stage (the batched
    writer takes one value per call). A name/group part, if any, rides
    its own stage over the full id set; a uniform result collapses back
    to the original single stage. Null when nothing changes and no
    field part remains (the "nothing to apply" path). */
export function expandAddStage(
  st: Stage,
  displayed: (id: number) => string,
): Stage[] | null {
  const tokens = addTokens(st.desc ?? "");
  if (tokens.length === 0) return [st];
  const groups = new Map<string, number[]>();
  for (const id of st.faceIds) {
    const cur = displayed(id);
    const next = applyAdd(cur, tokens);
    if (next === cur) continue; // already there — or nothing to add onto
    let bucket = groups.get(next);
    if (!bucket) groups.set(next, (bucket = []));
    bucket.push(id);
  }
  const hasField = st.name != null || st.group != null;
  if (groups.size === 1) {
    const [[value, ids]] = groups;
    if (ids.length === st.faceIds.length) {
      // uniform — the original single-stage shape, concrete value
      return hasField
        ? [{ faceIds: st.faceIds, name: st.name, group: st.group, desc: value }]
        : [{ faceIds: ids, desc: value }];
    }
  }
  if (!hasField && groups.size === 0) return null;
  const out: Stage[] = hasField
    ? [{ faceIds: st.faceIds, name: st.name, group: st.group }]
    : [];
  for (const [value, ids] of groups) out.push({ faceIds: ids, desc: value });
  return out;
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

/** #224 (F-M3): the pending set indexed once per set change — ONE pass
    over the ops replaces the per-card/per-section O(ops × opsize) scans
    with O(1) map reads. The per-field winning op position is carried so
    the section-level merge (#224 stagedFieldsForSectionIndex) reproduces
    stagedFieldsForSection's later-ops-win rule EXACTLY. */
export type StagedFields = { name?: string; group?: string; desc?: string };

export interface StagedEntry extends StagedFields {
  /** the op position that last set each field — the section merge keys
      on it to keep the later-op-wins precedence across faces */
  src: { name?: number; group?: number; desc?: number };
}

/** #224: indexStagedSet over the pending set. Later ops win per face
    (the same merge stagedFieldsForCard shows) — upsertStage keeps the op
    order, so a re-Apply replaces in place and the position order held. */
export function indexStagedSet(set: Stage[]): Map<number, StagedEntry> {
  const idx = new Map<number, StagedEntry>();
  set.forEach((stage, si) => {
    for (const id of stage.faceIds) {
      let e = idx.get(id);
      if (!e) {
        e = { src: {} };
        idx.set(id, e);
      }
      if (stage.name != null) {
        e.name = stage.name;
        e.src.name = si;
      }
      if (stage.group != null) {
        e.group = stage.group;
        e.src.group = si;
      }
      if (stage.desc != null) {
        e.desc = stage.desc;
        e.src.desc = si;
      }
    }
  });
  return idx;
}

/** #224: one face's staged fields — an O(1) map read (the identical
    merge the per-op scan produced, later ops win). The internal
    winning-op positions stay in the entry; this returns the plain
    fields. */
export function stagedFieldsForIndex(
  idx: Map<number, StagedEntry>,
  faceId: number,
): StagedFields {
  const e = idx.get(faceId);
  if (!e) return {};
  const out: StagedFields = {};
  if (e.name !== undefined) out.name = e.name;
  if (e.group !== undefined) out.group = e.group;
  if (e.desc !== undefined) out.desc = e.desc;
  return out;
}

/** #224: the section-level merge over the index — equivalent to
    stagedFieldsForSection (any overlap stages the heading, later ops
    win per field) without the scan. A field's winner is the highest
    winning-op position among the covered faces. */
export function stagedFieldsForSectionIndex(
  idx: Map<number, StagedEntry>,
  sectionIds: number[],
): StagedFields {
  const out: StagedFields = {};
  const best: { name?: number; group?: number; desc?: number } = {};
  for (const id of sectionIds) {
    const e = idx.get(id);
    if (!e) continue;
    for (const f of ["name", "group", "desc"] as const) {
      const v = e[f];
      if (v === undefined) continue;
      const b = e.src[f] as number | undefined;
      if (b === undefined) continue;
      if (best[f] === undefined || b > (best[f] as number)) {
        out[f] = v;
        best[f] = b;
      }
    }
  }
  return out;
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
/** #199 (§4.24): the dialog prefill for a set of faces — the staged
    overlay (later ops win, the same merge the labels show) over the
    committed value, per field; a field the faces disagree on is mixed
    (NO value — an empty untouched field stays out of the stage, and
    typing then sets them all) */
export function prefillForFaces(
  ids: number[],
  committed: (id: number) => { name: string; group: string; desc: string; note: string },
  set: Stage[],
): Prefill {
  if (ids.length === 0) return {};
  const names = new Set<string>();
  const groups = new Set<string>();
  const descs = new Set<string>();
  const notes = new Set<string>();
  for (const id of ids) {
    const c = committed(id);
    const staged = stagedFieldsForCard(set, id);
    names.add(staged.name ?? c.name);
    groups.add(staged.group ?? c.group);
    descs.add(staged.desc ?? c.desc);
    // #307: the note is person-level — the caller maps each face to its
    // owner's note (a scope spanning several persons mixes unless uniform)
    notes.add(c.note);
  }
  const mixed: Prefill["mixed"] = [];
  if (names.size > 1) mixed.push("name");
  if (groups.size > 1) mixed.push("group");
  if (descs.size > 1) mixed.push("desc");
  if (notes.size > 1) mixed.push("note");
  return {
    ...(names.size === 1 ? { name: [...names][0] } : {}),
    ...(groups.size === 1 ? { group: [...groups][0] } : {}),
    ...(descs.size === 1 ? { desc: [...descs][0] } : {}),
    ...(notes.size === 1 ? { note: [...notes][0] } : {}),
    ...(mixed.length ? { mixed } : {}),
  };
}

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
  if (stage.note != null) {
    // #307 (v19.0): the raw staged value — the `|` add marker shows as +
    const n = stage.note;
    parts.push(
      n.startsWith("|") && n.trim() !== "|"
        ? `note +“${n.slice(1).trim()}”`
        : n
          ? `note “${n}”`
          : "note → cleared",
    );
  }
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
