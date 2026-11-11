// #281 — the pure half of the #219 delta protocol: applying a `Delta` to
// a `Snapshot` (upsert touched rows, drop removed persons) and the
// exact staleness predicate. Extracted from App so both are unit-tested
// (App keeps the state wiring: the stamp bookkeeping and the
// full-refresh fallback).

import type { Delta, Snapshot } from "./api";

/**
 * #281 — is this delta safe to apply onto a state whose change stamp is
 * `since`?
 *
 * - `drifted` (backend): the stamp moved by more than 1 between the
 *   command's pre-read and its commit — an external write (importer)
 *   interleaved mid-command, the touched-row set may be incomplete.
 * - `base !== since`: the command's pre-read stamp differs from the
 *   stamp of the state the GUI has applied — an external write landed
 *   BEFORE the pre-read. The count-only `drifted` check cannot see that
 *   window (and a zero-row write never moves the stamp at all, so the
 *   pre-read stamp, not the post-commit one, is the sound comparison).
 *
 * Either flag ⇒ full refresh instead of applying.
 */
export const deltaStale = (d: Delta, since: number): boolean =>
  d.drifted || d.base !== since;

/**
 * #219/#281 — apply one delta to a snapshot: touched persons/faces/
 * images upsert by id (an upserted id keeps its list position, new ids
 * append), removed person ids drop out. Pure — App wraps this in its
 * snapshot state.
 */
export function applyDeltaToSnapshot(s: Snapshot, d: Delta): Snapshot {
  const next: Snapshot = { ...s };
  if (d.persons != null || d.removed.length > 0) {
    const byId = new Map(next.persons.map((p) => [p.id, p]));
    for (const p of d.persons ?? []) byId.set(p.id, p);
    for (const id of d.removed) byId.delete(id);
    next.persons = [...byId.values()];
  }
  if (d.faces != null) {
    const byId = new Map(next.faces.map((f) => [f.id, f]));
    for (const f of d.faces) byId.set(f.id, f);
    next.faces = [...byId.values()];
  }
  if (d.images != null) {
    const byId = new Map(next.images.map((im) => [im.id, im]));
    for (const im of d.images) byId.set(im.id, im);
    next.images = [...byId.values()];
  }
  return next;
}