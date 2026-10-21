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
