// #214 — the incremental-mount reveal rule for the centre grid: the
// review grid mounts a PREFIX of its sections and grows toward the
// viewport edge; a reveal target (a §4.40 re-anchor section, a §4.30
// accept-&-next face) grows the prefix to include it BEFORE the scroll
// runs. PURE: the App layout effects apply the returned limit.

/** first paint mounts this many sections */
export const GRID_MOUNT_INITIAL = 12;
/** growth step (sentinel reached / reveal target) */
export const GRID_MOUNT_STEP = 8;

/** The sentinel growth: the prefix grows geometrically so a deep scroll
    target converges in a few steps (a flat step would take one step per
    handful of sections) while staying O(depth actually reached) —
    nothing mounts that the user did not scroll toward. */
export function growLimit(current: number): number {
  return current + Math.max(GRID_MOUNT_STEP, Math.ceil(current / 2));
}
/** reveal targets land this many sections before the end of the prefix,
    so the scroll is not pinned to the very last mounted row */
export const REVEAL_MARGIN = 4;

/** The mount limit that makes `index` visible: never shrinks the current
    limit, clamps to the section count, and leaves it untouched for a
    missing target (index < 0 — e.g. a tree person without a review
    section). */
export function mountLimitFor(count: number, index: number, current: number): number {
  if (index < 0) return current;
  return Math.min(count, Math.max(current, index + 1 + REVEAL_MARGIN));
}
