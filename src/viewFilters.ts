// #99 (gui-design §4.10 / §4.9) / #165, #305 — the persons-mode display
// switches, as pure helpers: the 4-state face-status filter that replaces
// show_rejected (`all` = every face, including rejected), the tree
// presence rule, and the Description-mode grouping.

import type { Face } from "./api";

/** whotrc `face_filter` — 'confirmed' is labelled **Accepted** in the UI */
export type FaceFilter = "all" | "provisional" | "confirmed" | "rejected";
/** whotrc `cluster_group` — how the person view forms sections */
export type ClusterGroup = "accuracy" | "description";

/** does a face of this link_status survive the filter? — `all` means
    EVERY face, including `rejected` (#305/§4.10: `Show → Rejected` is
    the narrowed view of the rejected faces). */
export function matchesStatusFilter(status: string, filter: FaceFilter): boolean {
  return filter === "all" || status === filter;
}

/** #194 (§4.41) — the empty-state guidance: the anchored person holds no
    face under the current Show filter, so the bare "nothing to show"
    becomes a line that names the active filter and points at ‹ ›. A
    faceless shell (total 0 — the state the §4.41 guard never triggers)
    gets its own variant. The filtered variants deliberately do NOT
    suggest "set Show to All": the §4.41 guard dialog already offers
    Show All, and the two must not contradict. `totalFaces` is the
    person's RAW face count (the §4.10 badge number), not the filtered
    one — the filtered count is 0 by construction here. */
export function emptyStateHint(totalFaces: number, filter: FaceFilter): string {
  if (totalFaces === 0)
    return "This person has no faces — pick another person in the list, or click › to step to the next person.";
  const label =
    filter === "provisional"
      ? "New "
      : filter === "confirmed"
        ? "Accepted "
        : filter === "rejected"
          ? "Rejected "
          : "";
  return `No ${label}faces to show — pick another person in the list, or click › to step to the next person.`;
}

/** #152 (§4.10, rewritten by #165, #305): the left-pane tree's person
    presence. Under 'all' — every face, including rejected — a person is
    listed when it holds ≥ 1 face (any status), and faceless shells stay
    findable (#127/#128); the reject-bin persons `RejectedN` list under
    All like any other person while they hold faces (§4.35/#266).
    Under New/Accepted/Rejected only persons holding ≥ 1 face of that
    status survive — a person with no matching face leaves the tree while
    the badges of those that stay carry raw totals (#129). */
export function personTreeMembers<P extends { id: number; name?: string }>(
  persons: P[],
  faces: { person_id: number | null; link_status: string }[],
  filter: FaceFilter,
): P[] {
  if (filter === "all") {
    const withAny = new Set<number>();
    for (const f of faces) if (f.person_id != null) withAny.add(f.person_id);
    return persons.filter((p) => !withAny.has(p.id));
  }
  const visible = new Set<number>();
  for (const f of faces)
    if (f.person_id != null && matchesStatusFilter(f.link_status, filter))
      visible.add(f.person_id);
  return persons.filter((p) => visible.has(p.id));
}

/** #174 (§4.39) — which images the Show filter lists (§4.10): an
    image lists iff it holds ≥ 1 face passing the filter; under `all`
    every image lists (no-face images included). Shared by the Rolls
    path tree (#161) and the right-pane branch thumbnails. */
export function listedImages(
  images: { id: number }[],
  faces: { image_id: number; link_status: string }[],
  filter: FaceFilter,
): Set<number> {
  const listed = new Set<number>();
  for (const f of faces) if (matchesStatusFilter(f.link_status, filter)) listed.add(f.image_id);
  if (filter === "all") for (const i of images) listed.add(i.id);
  return listed;
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
