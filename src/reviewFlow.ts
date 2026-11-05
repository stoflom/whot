import type { Snapshot } from "./api";
import type { FaceFilter } from "./viewFilters";
import type { Verdict } from "./verdictFlip";
import { flipLinkStatus } from "./verdictFlip";

// #96 (§4.30) — where an accept leaves the Review-mode context.
//
// The plan is computed from the **pre-accept** sections and stays valid
// afterwards: accepting faces never changes another section's members
// (sections group provisional faces per importer person), and the acted
// section either keeps exactly the non-accepted faces or disappears.

export interface ReviewTarget {
  sectionKey: string;
  faceIds: number[];
}

/** Accept & next: partial accept stays on the acted-on section (its
    remaining faces), a fully accepted section hands over to the next one
    in rendered order (all of its faces), the last section clears the
    selection (null). `actedKey` null/unknown ⇒ no anchor ⇒ null. */
export function acceptAdvancePlan(
  sections: { key: string; faceIds: number[] }[],
  actedKey: string | null,
  acceptedIds: number[],
): ReviewTarget | null {
  const idx =
    actedKey == null ? -1 : sections.findIndex((s) => s.key === actedKey);
  if (idx === -1) return null;
  const accepted = new Set(acceptedIds);
  const remaining = sections[idx].faceIds.filter((id) => !accepted.has(id));
  if (remaining.length > 0) {
    return { sectionKey: sections[idx].key, faceIds: remaining };
  }
  const next = sections[idx + 1];
  return next ? { sectionKey: next.key, faceIds: [...next.faceIds] } : null;
}

/** #159 (§4.30, v3.58) — the exhaust advance target: the first person in
    the step list AFTER the marked person that still has a face of the
    review status. The marked person's index is re-derived from the
    CURRENT list (the Show filter prunes it out on their last decision —
    §4.10); when it is gone, the index captured at mark time marks the gap
    the pruning left behind and the scan starts there. Returns null when
    no forward candidate remains (the caller reports "no more persons to
    review" and leaves the user where they are). */
export function exhaustAdvanceTarget(
  stepIds: number[],
  markedPid: number | null,
  capturedAt: number,
  hasReviewableFace: (id: number) => boolean,
): number | null {
  if (markedPid == null) return null;
  // The scan starts from the CAPTURED position — the marked person's
  // index at mark time — never from their CURRENT index: between mark
  // and consume the tree can reorder (a verdict re-seats a drained
  // person New→Accepted, §4.35 — the Accepted branch walks earlier, so
  // the person JUMPS UP the list) or prune them (Show → New). One
  // exception: when the person moved UP, their removal let the old
  // PREDECESSOR into the captured gap (the re-insertion above does not
  // reclaim it) — starting at the gap would hand the review one person
  // backward, so the scan skips it. In every other case the gap holds
  // the old successor (pruned / moved down) or the person themselves
  // (unchanged — skipped by the `!== markedPid` guard below).
  const cur = stepIds.indexOf(markedPid);
  const first =
    cur !== -1 && cur < capturedAt
      ? Math.min(capturedAt + 1, stepIds.length)
      : Math.max(0, Math.min(capturedAt, stepIds.length));
  return (
    stepIds
      .slice(first)
      .find((id) => id !== markedPid && hasReviewableFace(id)) ?? null
  );
}

// #234 (gui-design rule 45) — the advance-target prefetch prediction.

/** The review status a Show filter reviews: `all` reviews `provisional`
    (the fresh faces), the other filters review themselves. Mirrors the
    exhaust effect's status derivation. */
export function reviewStatusOf(
  faceFilter: FaceFilter,
): "provisional" | "confirmed" | "rejected" {
  return faceFilter === "confirmed" || faceFilter === "rejected"
    ? faceFilter
    : "provisional";
}

/** If the verdict `to` on `ids` drains the anchored person `pid`
    (every face of the person under the current review status is acted
    upon), the exhaust-advance effect will fire once the authoritative
    delta lands — so the caller can prefetch the advance target's
    clusters/refcrops NOW, in parallel with the verdict IPC. Returns
    the advance target (the `exhaustAdvanceTarget` rule, evaluated on
    the POST-flip face set) or null. Pure — mirrors the optimistic flip
    without touching state. */
export function verdictAdvanceTarget(
  snap: Snapshot,
  stepIds: number[],
  pid: number,
  stepIdx: number,
  ids: number[],
  to: Verdict,
  faceFilter: FaceFilter,
): number | null {
  const status = reviewStatusOf(faceFilter);
  const flipped = flipLinkStatus(snap, ids, to);
  for (const f of flipped.next.faces)
    if (f.person_id === pid && f.link_status === status) return null;
  return exhaustAdvanceTarget(
    stepIds,
    pid,
    stepIdx,
    (id) =>
      flipped.next.faces.some(
        (f) => f.person_id === id && f.link_status === status,
      ),
  );
}
