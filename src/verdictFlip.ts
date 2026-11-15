// #234 (gui-design rule 45) — the optimistic verdict flip: the local,
// pre-IPC status change a verdict applies to the snapshot so the
// acted-upon cards respond the moment the click fires. The §219 delta
// overwrites the flipped rows with authoritative state on arrival;
// `restoreLinkStatus` rolls a failed verdict back.
//
// Flip rules mirror the backend (db.rs):
//   accept → faces with link_status != 'rejected' become 'confirmed'
//            (accept never un-rejects)
//   reject → faces with link_status != 'rejected' become 'rejected'
//            (reject re-homes onto a `RejectedN` cluster person, §4.35/
//            #266 — the local flip does NOT
//            re-home: it only marks the status, so the card's badge and
//            buttons respond at once. The authoritative delta moves the
//            rows, re-derives names, reseats and backfills primaries.)
//
// #222 identity rule: only the flipped rows get new identities; every
// other face row (and every person) keeps its referential identity so
// memo(FaceCard) skips untouched cards.

import type { Face, Snapshot } from "./api";

/** the verdict a flip applies — the destination `link_status` */
export type Verdict = "confirmed" | "rejected";

export interface FlipResult {
  /** the snapshot to render; `=== snap` when nothing flipped */
  next: Snapshot;
  /** the pre-flip rows, for rollback (empty when nothing flipped) */
  prior: Map<number, Face>;
}

/** Flip `ids`' `link_status` to `to` in `snap` (see the module header).
    Faces already at `to` (or, for accept, already `rejected`) are
    no-ops — no new identity, no rollback entry. */
export function flipLinkStatus(
  snap: Snapshot,
  ids: number[],
  to: Verdict,
): FlipResult {
  const idSet = new Set(ids);
  const prior = new Map<number, Face>();
  let changed = false;
  const faces = snap.faces.map((f) => {
    if (!idSet.has(f.id) || f.link_status === "rejected") return f;
    if (f.link_status === to) return f; // no-op
    prior.set(f.id, f);
    changed = true;
    return { ...f, link_status: to };
  });
  return changed ? { next: { ...snap, faces }, prior } : { next: snap, prior };
}

/** Field equality over the whole IPC face row — the §219 delta replaces
    rows wholesale, so identity alone can't tell "our optimistic flip is
    still in place" from "an authoritative row landed with the same
    fields". */
function sameRow(a: Face, b: Face): boolean {
  return (
    a.id === b.id &&
    a.image_id === b.image_id &&
    a.person_id === b.person_id &&
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    a.name === b.name &&
    a.seq === b.seq &&
    a.description === b.description &&
    a.confidence === b.confidence &&
    a.link_status === b.link_status &&
    a.state === b.state &&
    a.rotation === b.rotation &&
    a.import_id === b.import_id &&
    a.created_at === b.created_at
  );
}

/** Restore the pre-flip rows into `snap` (rollback of a failed
    verdict). #325 — GUARDED: a prior row is restored only when the
    current row is still exactly the row THIS flip produced (field-equal
    to `{...row, link_status: to}`) — i.e. nothing authoritative (a
    concurrent verdict's applied delta, an import delta, a
    focus/visibility `refreshIfChanged`) has touched the face since.
    An unconditional overwrite would revert those faces' statuses to
    pre-verdict values and the UI would disagree with the DB until the
    next full refresh; it also made overlapping verdicts' restores
    order-dependent. Id order is preserved — the Map is built from
    `snap.faces` and re-setting an existing key does not move it. `snap`
    is returned unchanged when `prior` is empty. */
export function restoreLinkStatus(
  snap: Snapshot,
  prior: Map<number, Face>,
  to: Verdict,
): Snapshot {
  if (prior.size === 0) return snap;
  const cur = new Map<number, Face>();
  for (const f of snap.faces) cur.set(f.id, f);
  const m = new Map<number, Face>();
  for (const f of snap.faces) m.set(f.id, f);
  for (const [id, row] of prior) {
    const c = cur.get(id);
    // skip when the face moved on: an authoritative row (or a different
    // verdict's flip) replaced ours, so rolling this verdict back must
    // not clobber it
    if (!c || !sameRow(c, { ...row, link_status: to })) continue;
    m.set(id, row);
  }
  return { ...snap, faces: [...m.values()] };
}
