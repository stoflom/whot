// #99 (gui-design §4.10 / §4.9) / #165 — the persons-mode display
// switches, as pure helpers: the 4-state face-status filter that replaces
// show_rejected (`all` = everything except rejected), the tree presence
// rule, and the Description-mode grouping.

import type { Face } from "./api";

/** whotrc `face_filter` — 'confirmed' is labelled **Accepted** in the UI */
export type FaceFilter = "all" | "provisional" | "confirmed" | "rejected";
/** whotrc `cluster_group` — how the person view forms sections */
export type ClusterGroup = "accuracy" | "description";

/** does a face of this link_status survive the filter? — `all` means
    every face EXCEPT `rejected` (#165/§4.10: rejected faces are visible
    only under Show → Rejected). */
export function matchesStatusFilter(status: string, filter: FaceFilter): boolean {
  return filter === "all" ? status !== "rejected" : status === filter;
}

/** #152 (§4.10, rewritten by #165): the left-pane tree's person
    presence. Under 'all' — everything except rejected — a person is
    listed when it holds ≥ 1 non-rejected face, and faceless shells stay
    findable (#127/#128); a person whose faces are ALL rejected drops
    out, which singles out the system person `Rejected` (§4.35: listed
    only under Show → Rejected, and only while it holds faces).
    Under New/Accepted/Rejected only persons holding ≥ 1 face of that
    status survive — a person with no matching face leaves the tree while
    the badges of those that stay carry raw totals (#129). */
export function personTreeMembers<P extends { id: number; name?: string }>(
  persons: P[],
  faces: { person_id: number | null; link_status: string }[],
  filter: FaceFilter,
): P[] {
  if (filter === "all") {
    const withVisible = new Set<number>();
    const withAny = new Set<number>();
    for (const f of faces) {
      if (f.person_id == null) continue;
      withAny.add(f.person_id);
      if (f.link_status !== "rejected") withVisible.add(f.person_id);
    }
    return persons.filter((p) =>
      p.name === "Rejected"
        ? false // §4.35: never under All — Show → Rejected only
        : !withAny.has(p.id) || withVisible.has(p.id)
    );
  }
  const visible = new Set<number>();
  for (const f of faces)
    if (f.person_id != null && matchesStatusFilter(f.link_status, filter))
      visible.add(f.person_id);
  return persons.filter((p) => visible.has(p.id));
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
