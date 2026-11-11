// #172 (gui-design §4.38) — the person pane's staged group-list edits.
// Pure logic: one staged op per row gesture, each mirroring one
// `move_persons_between_groups` call (§4.16) — `from=""` adds a
// membership, `to=""` removes one, both non-empty re-homes that one
// membership. The display list is the person's committed memberships
// with the staged ops applied IN ORDER; the commit (App) replays the
// ops in the same order against the surviving person.

import type { Person } from "./api";
import { isRejectedBin } from "./personNames";

export interface GroupOp {
  from: string;
  to: string;
}

// #165/§4.35: five segments are reserved — the three status seats and
// the two retired pseudo-segments; the backend refuses any path
// containing one, so the pane refuses them before staging
const RESERVED = ["Ungrouped", "New", "Accepted", "Rejected", "Unknown"];

/** the status seats (§4.35 system furniture — rows never staged) */
export const SEATS = ["New", "Accepted", "Rejected"];

export const isSeat = (path: string) => SEATS.includes(path);

/** #233 (§4.35 display rule) — the person's REAL memberships: the
    status seats are system furniture, never displayed as actual
    groups — they exist only to organize the left-pane list */
export const realGroups = (groups: string[]): string[] =>
  groups.filter((g) => !isSeat(g));

/** the first real group path ("" = ungrouped) — prefill/label/hint
    displays never surface a status seat (§4.35/#233) */
export const firstRealGroup = (groups: string[]): string =>
  realGroups(groups)[0] ?? "";

/** #153 (+ #165/§4.35, #178/§4.1, #266) — the group argument for every
    rename-style person assign: a filed person keeps their group path,
    a reject-bin person's seat never prefills a group field (the
    `RejectedN` family is writer-owned, §4.35), and a STATUS
    SEAT is never passed either (assign_person validates the path up
    front) — "" derives the seat by state instead. Pure; the section
    derivations (sections.ts) use it for the rule bar defaults. */
export function renameGroupFor(p: Person | undefined): string {
  const g = p && !isRejectedBin(p.name) ? p.groups[0] ?? "" : "";
  return isSeat(g) ? "" : g;
}

/** #256 — the ONE definition of the dialog-submit group-path
    normalization (#42): trim every '|' segment and drop the empties;
    all-empty collapses to "". Pure. */
export function normalizeGroupPath(path: string): string {
  return path
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("|");
}

/** the backend's validate_group_path, client-side (refuse before staging) */
export function validPath(path: string): boolean {
  const p = path.trim();
  if (!p) return false;
  return !p.split("|").some((s) => RESERVED.includes(s));
}

/** the staged result — the committed memberships with the ops applied
    in order (a re-home onto an existing path merges the rows, which is
    exactly the backend's DELETE + INSERT OR IGNORE). #233 (§4.35
    display rule): the result shows REAL memberships only — the status
    seat is never a displayed group, and filing replaces the seat (the
    backend drops it once any real group lands), so the preview can
    never show both */
export function applyGroupOps(groups: string[], ops: GroupOp[]): string[] {
  let out = realGroups(groups);
  for (const op of ops) {
    if (op.from === "") {
      if (op.to && !out.includes(op.to)) out.push(op.to);
    } else if (op.to === "") {
      out = out.filter((g) => g !== op.from);
    } else {
      out = out.map((g) => (g === op.from ? op.to : g));
    }
  }
  return [...new Set(out)];
}

/** ✕ — stage the removal of one membership; a status seat is refused
    (§4.35, the row's ✕ is disabled), and ✕ on a not-yet-committed add
    just forget that add */
export function stageRemove(
  ops: GroupOp[],
  display: string[],
  path: string,
): GroupOp[] | null {
  if (isSeat(path)) return null;
  const ai = ops.findIndex((o) => o.from === "" && o.to === path);
  if (ai >= 0) return ops.filter((_, i) => i !== ai);
  if (!display.includes(path)) return null;
  return [...ops, { from: path, to: "" }];
}

/** Add group — stage a NEW membership; reserved/empty/duplicate paths
    are refused (the input keeps its text — an informed no-op) */
export function stageAdd(
  ops: GroupOp[],
  display: string[],
  path: string,
): GroupOp[] | null {
  const p = path.trim();
  if (!validPath(p) || display.includes(p)) return null;
  return [...ops, { from: "", to: p }];
}

/** inline row edit — re-home THAT one membership (from = old path,
    to = new path — the §4.16 D&D semantics); editing a staged add
    retargets it, so the row stays one add op */
export function stageRehome(
  ops: GroupOp[],
  display: string[],
  from: string,
  to: string,
): GroupOp[] | null {
  const p = to.trim();
  if (isSeat(from) || !display.includes(from)) return null; // seats never re-homed
  if (p === from) return null; // no-op: nothing to stage
  if (!validPath(p)) return null;
  const next = [...ops];
  const ai = next.findIndex((o) => o.from === "" && o.to === from);
  if (ai >= 0) {
    next[ai] = { from: "", to: p };
    return next;
  }
  next.push({ from, to: p });
  return next;
}
