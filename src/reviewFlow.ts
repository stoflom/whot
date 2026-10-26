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
  let first = stepIds.indexOf(markedPid) + 1;
  if (first <= 0) {
    // pruned between mark and consume: continue from the captured gap
    first = Math.max(0, Math.min(capturedAt, stepIds.length));
  }
  return (
    stepIds
      .slice(first)
      .find((id) => id !== markedPid && hasReviewableFace(id)) ?? null
  );
}
