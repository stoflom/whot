// Detail-pane derivations (gui-design §4.44 round 2, #291/#292) — PURE
// data mappings over the snapshot: the open image's row (the §4.24 Rolls
// detail and the #275 focus split), the branch-thumb step index (rule
// 46's `n` of `n/m`), the Show-filtered face list of an image (§4.10/#99),
// the full-image-open rule (one bar above the image, no separate centre
// toolbar) and the focus-bar face step composition (#275 — the
// `‹ 1/4 faces ›` step and the ← → keys share the one rule). App composes
// them but owns none of these rules — every behavioural correction is
// implemented and regression-tested HERE (nothing touches state, DOM or
// IPC).
//
// The #98 identity rule is untouched: App keeps only the useMemo
// bindings, churning at exactly the old rates; `stepSplitFace` (the
// state transition behind a step) stays App-owned.

import type { Face, ImageRow, Snapshot } from "./api";
import { matchesStatusFilter, type FaceFilter } from "./viewFilters";
import { personFaceList, splitStepPos, type Mode } from "./sections";
import type { Section } from "./components/FaceGrid";

/** The image row of the open id in the snapshot (`undefined` = no such
    image, or nothing open). Both full-image surfaces read it: the §4.24
    Rolls image detail (`imageId`) and the card-double-click split
    (#275, `splitImageId`). */
export function imageRowFor(
  snap: Snapshot | null,
  imageId: number | null,
): ImageRow | undefined {
  return imageId != null ? snap?.images.find((i) => i.id === imageId) : undefined;
}

/** The open image's position in a listed image sequence (rule 46 — the
    selected branch's roll list): 0-based index, or -1 = not in the list
    (opened from the path filter in another branch, or the Show filter no
    longer lists it) → `–/m`, both buttons disabled. */
export function stepIndexIn(images: ImageRow[], imageId: number | null): number {
  return imageId != null ? images.findIndex((x) => x.id === imageId) : -1;
}

/** The Show-filter-passing face list of one image (§4.10/#99 — one
    filter drives every view's visibility): snapshot order. `snap` null
    or no image row → the empty list. */
export function facesOfImage(
  snap: Snapshot | null,
  imageId: number | null,
  faceFilter: FaceFilter,
): Face[] {
  if (snap == null || imageId == null) return [];
  return snap.faces.filter(
    (f) => f.image_id === imageId && matchesStatusFilter(f.link_status, faceFilter),
  );
}

/** #275 (gui-design v11.3) — a full image is up on either surface: the
    card-double-click split (focus pane) or the Rolls image detail.
    While it is, the centre's own toolbar does not render: the single
    bar above the image carries the mode's nav cluster instead. */
export function fullImageOpenFor(
  splitRow: ImageRow | null | undefined,
  mode: Mode,
  imageId: number | null,
  imgRow: ImageRow | null | undefined,
): boolean {
  return splitRow != null || (mode === "rolls" && imageId != null && imgRow != null);
}

/** #275 (gui-design v11.4) — the focus bar's FACE step: the right-pane
    person's editable faces in the view's display order (person grid
    sections in Person, the pinned-filter faces in Review) and the open
    image's position in that list — the pure rule is personFaceList/
    splitStepPos (sections.ts, co-tested). A null person (an unassigned
    face opened the view) or no open image has no list. */
export function splitStepFor(
  mode: Mode,
  personId: number | null,
  sections: Section[],
  faces: Face[],
  faceFilter: FaceFilter,
  facesById: Map<number, Face>,
  splitRow: ImageRow | null | undefined,
): { ids: number[]; pos: number } {
  if (splitRow == null || personId == null) return { ids: [], pos: -1 };
  const ids = personFaceList(mode, personId, sections, faces, faceFilter);
  return { ids, pos: splitStepPos(ids, facesById, splitRow.id) };
}
