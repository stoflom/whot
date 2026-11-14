// #101 (§4.24) + #259 — the commit engine's PURE core, co-tested like
// stage.ts / reviewFlow.ts: what each staged op turns into (the #77
// routing), what a whole commit run does at each step (plan, batch
// grouping, the F5 mid-failure resume), and where an accept leaves the
// context (the rejected-only gate + mode routing + the review advance).
// The IPC execution (awaiting the api calls in plan order), the delta
// flushing/applyDelta and the state transitions stay in App — this
// module only decides; App does.

import type { Delta, Face, Person } from "./api";
import type { Stage } from "./stage";
import type { GroupOp } from "./groupList";
import type { Mode } from "./sections";

/** one IPC action a staged op resolves to, in call order. `info` is
    the #165 defensive "nothing to group" branch — the executor
    surfaces it through the info toast and CONTINUES (the op's other
    fields still commit, exactly like the inline original). */
export type OpAction =
  | { kind: "info"; msg: string }
  | { kind: "assign"; ids: number[]; name: string; group: string }
  | { kind: "setPersonGroup"; personId: number; group: string }
  | { kind: "setDescription"; ids: number[]; desc: string };

/** #307 (v19.0) — one resolved person-note write. The raw staged
    `|` add-mode value is EXPANDED here: the final note is what the
    executor writes through set_person_note. */
export interface NoteOp {
  personId: number;
  note: string;
}

/** #77/#165 — the routing ONE staged op runs through:
    - a NAME stage always leads with assign_person (its group argument
      carries create / UnknownN-rename; an existing target person's
      group is never touched by assign_person, so an explicit group
      lands as its own set_person_group — F2);
    - a GROUP-ONLY stage files each DISTINCT owner once (the batched
      §4.4 re-seq stays inside the command's transaction, in call
      order); faces without a writer hit the #165 defensive info
      branch;
    - a DESCRIPTION stage is one batched command over the whole id set
      (one value per call — expandAddStage's per-value grouping feeds
      it);
    - name wins over group (the original if/elseif), desc always adds. */
export function planStageOps(
  st: Stage,
  facesById: Map<number, Face>,
  personsById: Map<number, Person>,
): OpAction[] {
  const ids = st.faceIds;
  const out: OpAction[] = [];
  if (st.name != null) {
    // #77 routing kept: the name path carries the group (create /
    // UnknownN rename); an explicit group also lands when the target
    // person pre-existed (F2: assign_person never touches its group)
    const name = st.name.trim();
    const target = [...personsById.values()].find((p) => p.name === name);
    out.push({ kind: "assign", ids, name, group: st.group ?? "" });
    if (st.group != null && target)
      out.push({ kind: "setPersonGroup", personId: target.id, group: st.group });
  } else if (st.group != null) {
    // group-only: set_person_group never validates names — filing an
    // UnknownN cluster into a group without naming it stays possible
    const pids = [
      ...new Set(
        ids
          .map((id) => facesById.get(id)?.person_id)
          .filter((p): p is number => p != null)
      ),
    ];
    if (pids.length === 0) {
      // #165: no writer ever leaves a face unowned — defensive only
      out.push({ kind: "info", msg: "nothing to group — these faces have no person" });
    } else {
      for (const pid of pids)
        out.push({ kind: "setPersonGroup", personId: pid, group: st.group });
    }
  }
  if (st.desc != null) {
    // #209: one batched command — the sequential per-face seq
    // re-assignment (§4.4, same reason as the old per-card edits)
    // happens inside its transaction, in call order
    out.push({ kind: "setDescription", ids, desc: st.desc });
  }
  return out;
}

/** #123/#166/#181 — what a WHOLE commit run does: null when there is
    nothing to run at all (no staged ops, no group-LIST edits — the
    #181 list-only Accept still runs: the membership edits commit even
    when every field is untouched). `claimed` says a staged NAME
    assignment already claimed rejected faces (§4.35 — the advance must
    not trip the rejected-only guard on stale state); `acceptScope` is
    the caller's DISPLAYED scope (bar/keys: selection or cursor-as-
    target, dialog: its chosen scope) — the staged set supplies only the
    edits; an empty scope falls back to the staged ids' union. */
export interface CommitPlan {
  opsLive: boolean;
  union: number[];
  claimed: boolean;
  acceptScope: number[];
}

export function planCommit(
  all: Stage[],
  acceptIds: number[] | undefined,
  groupOps: GroupOp[] | undefined,
): CommitPlan | null {
  const opsLive = (groupOps ?? []).length > 0;
  if (all.length === 0 && !opsLive) return null;
  // #139: the whole set stays staged until the commit lands — the old
  // code wiped it before the first write, so a mid-commit failure
  // silently discarded every not-yet-applied op (§4.24 'Accept commits
  // every op'; Q3 text is never dropped silently)
  const union = [...new Set(all.flatMap((o) => o.faceIds))];
  return {
    opsLive,
    union,
    claimed: all.some((o) => (o.name ?? "").trim().length > 0),
    acceptScope: acceptIds && acceptIds.length > 0 ? acceptIds : union,
  };
}

/** #307 (v19.0) — the note ops of a commit run: the staged `note`
    values resolved to per-person writes. Runs AFTER the field writes
    (the same point the §4.38 group-list edits resolve their owners):
    the staged deltas carry the fresh face→owner mapping, so a name
    assignment in the same run lands the note on the surviving/created
    person. Later stages win per person (the labels' later-ops-wins
    merge); the add-mode expansion is per person:
    - plain text → the note becomes the text (a replace);
    - `|rest` → appended to the person's EXISTING note with a single
      space (a person without a note gets the text);
    - "" → the note is cleared.
    The existing note comes from the applied deltas' person rows first
    (fresh), falling back to the snapshot. Pure — App binds the IPC. */
export function planNoteOps(
  all: Stage[],
  deltas: Delta[],
  facesById: Map<number, Face>,
  personsById: Map<number, Person>,
): NoteOp[] {
  const ownerOf = (faceId: number): number | null => {
    for (let i = deltas.length - 1; i >= 0; i--) {
      const f = deltas[i].faces?.find((x) => x.id === faceId);
      if (f) return f.person_id ?? null;
    }
    return facesById.get(faceId)?.person_id ?? null;
  };
  // later stages win per person
  const raw = new Map<number, string>();
  for (const st of all) {
    if (st.note == null) continue;
    for (const id of st.faceIds) {
      const pid = ownerOf(id);
      if (pid != null) raw.set(pid, st.note);
    }
  }
  const noteOf = (pid: number): string => {
    for (let i = deltas.length - 1; i >= 0; i--) {
      const p = deltas[i].persons?.find((x) => x.id === pid);
      if (p) return p.note ?? "";
    }
    return personsById.get(pid)?.note ?? "";
  };
  return [...raw].map(([personId, v]) => {
    const t = v.trim();
    const note = t.startsWith("|")
      ? (() => {
          const rest = t.slice(1).trim();
          const base = noteOf(personId);
          return base ? `${base} ${rest}` : rest;
        })()
      : t;
    return { personId, note };
  });
}

/** F5 — the gap-proof mid-set failure: the applied prefix (ops
    1..done−1) is in; the failed op AND everything after it stays
    staged and retryable (Accept again re-runs the idempotent field
    writes and continues from here). Pure so the exact resume list is
    pinned by a test. */
export function remainingAfterFailure(all: Stage[], done: number): Stage[] {
  return all.slice(done);
}

/** #181 — the owners for the dialog's group-LIST edits: from the
    staged deltas FIRST (fresh, the #219 face→owner mapping carried
    through the claim/merge moves), falling back to the pre-existing
    snapshot for untouched faces. One owner per DISTINCT person; the
    per-person-independent commands then run once per op over them all
    (#209), surviving owners deleted by a merge. */
export function ownersForGroupOps(
  faceIds: number[],
  deltas: Delta[],
  facesById: Map<number, Face>,
): number[] {
  const ownerOf = (faceId: number): number | null => {
    for (let i = deltas.length - 1; i >= 0; i--) {
      const f = deltas[i].faces?.find((x) => x.id === faceId);
      if (f) return f.person_id ?? null;
    }
    return facesById.get(faceId)?.person_id ?? null;
  };
  return [
    ...new Set(
      faceIds.map((id) => ownerOf(id)).filter((p): p is number => p != null)
    ),
  ];
}

/** #96/§4.30 + #165/§4.35 + #188/§4.40 — where an ACCEPT leaves the
    context. `inert`: a plain (unclaimed) rejected-only scope never
    un-rejects — guidance instead of momentum; `plain`: outside Review
    there is no any-view widening — the verdict applies with focus
    following (#189) and no advance; `review`: the acted key derives
    from the anchor (last-selected, hovered, first accepted id —
    yesterday's cursor-as-target ordering §4.25) and feeds
    reviewFlow's acceptAdvancePlan. */
export type AcceptRoute =
  | { kind: "inert" }
  | { kind: "plain" }
  | { kind: "review"; actedKey: string | null };

export function routeAccept(
  mode: Mode,
  ids: number[],
  facesById: Map<number, Face>,
  claimed: boolean,
  lastSel: number | null,
  hover: number | null,
  sections: { key: string; faceIds: number[] }[],
): AcceptRoute {
  if (
    !claimed &&
    ids.length > 0 &&
    ids.every((id) => facesById.get(id)?.link_status === "rejected")
  ) {
    return { kind: "inert" };
  }
  if (mode !== "review") {
    return { kind: "plain" };
  }
  // a split open IN Review is a zoom of the review: the verdict keeps
  // the review path (mark + advance plan, §4.30)
  const anchor = lastSel ?? hover ?? ids[0] ?? null;
  return {
    kind: "review",
    actedKey:
      anchor == null
        ? null
        : sections.find((s) => s.faceIds.includes(anchor))?.key ?? null,
  };
}

/** the accept SUCCESS effects as data: the selection rewrite and the
    §4.30 reveal (the first face to scroll to) come straight from the
    plan — everything else (the mark, the verdict mutate, the focus
    follow) happens in App in the same order. */
export function reviewScope(plan: { faceIds: number[] } | null): {
  selection: number[];
  reveal: number | null;
} {
  return {
    selection: plan?.faceIds ?? [],
    reveal: plan?.faceIds[0] ?? null,
  };
}
