// #99 (gui-design §4.10 / §4.9) — the two persons-mode display switches,
// as pure helpers: the 4-state face-status filter that replaces
// show_rejected, and the Description-mode grouping.

import type { Face } from "./api";

/** whotrc `face_filter` — 'confirmed' is labelled **Accepted** in the UI */
export type FaceFilter = "all" | "provisional" | "confirmed" | "rejected";
/** whotrc `cluster_group` — how the person view forms sections */
export type ClusterGroup = "accuracy" | "description";

/** does a face of this link_status survive the filter? ('all' = everything) */
export function matchesStatusFilter(status: string, filter: FaceFilter): boolean {
  return filter === "all" || status === filter;
}

/** #152 (§4.10): the left-pane tree's person presence. Under 'all' every
    snapshot person is listed (faceless shells stay findable, #127/#128);
    under New/Accepted/Rejected only persons holding ≥ 1 face of that
    status survive — a person with no matching face leaves the tree while
    the badges of those that stay carry raw totals (#129). */
export function personTreeMembers<P extends { id: number }>(
  persons: P[],
  faces: { person_id: number | null; link_status: string }[],
  filter: FaceFilter,
): P[] {
  if (filter === "all") return persons;
  const visible = new Set<number>();
  for (const f of faces)
    if (f.person_id != null && matchesStatusFilter(f.link_status, filter))
      visible.add(f.person_id);
  return persons.filter((p) => visible.has(p.id));
}

/** #154 (§3): the 'Remove Unknowns' top-bar cleanup set — ids of the
    UnknownN persons whose faces are **all decided** (zero provisional/New
    and zero confirmed/Accepted faces left). Filter-independent by design:
    the §4.27 sweep keeps zero-attached-face UnknownN out of the snapshot
    anyway, so these are the Unknowns that still exist but whose review is
    finished — nothing left to show means nothing left to keep. */
export function removableUnknownShellIds(
  persons: { id: number; name: string }[],
  faces: { person_id: number | null; link_status: string }[],
): number[] {
  const undecided = new Set<number>(
    faces
      .filter(
        (f) =>
          f.person_id != null &&
          (f.link_status === "provisional" || f.link_status === "confirmed")
      )
      .map((f) => f.person_id as number)
  );
  return persons
    .filter((p) => /^Unknown/.test(p.name) && !undecided.has(p.id))
    .map((p) => p.id);
}

/** Description mode (#99): one cluster per distinct description over the
    faces given (already visibility-filtered by the caller) — ordered by
    first appearance, the empty description last (Ungrouped convention). */
export function groupByDescription(
  faces: Pick<Face, "id" | "description">[],
): { description: string; faceIds: number[] }[] {
  const order: string[] = [];
  const byDesc = new Map<string, number[]>();
  for (const f of faces) {
    const d = f.description ?? "";
    let ids = byDesc.get(d);
    if (!ids) {
      ids = [];
      byDesc.set(d, ids);
      order.push(d);
    }
    ids.push(f.id);
  }
  const named = order.filter((d) => d !== "");
  const unnamed = order.filter((d) => d === "");
  return [...named, ...unnamed].map((d) => ({
    description: d,
    faceIds: byDesc.get(d)!,
  }));
}
