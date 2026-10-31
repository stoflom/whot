// #194 (gui-design §4.25) — where a ‹ › step starts when the anchored
// person is NOT in the current step list (stepIdx === -1: a verdict
// drained them and the Show filter pruned them out, §4.30/§4.10).

/** The step's base index, in precedence order:
 *   1. the anchored person's position in the current list (stepIdx);
 *   2. the person under the mouse cursor (#76 cursor-as-target, -1 =
 *      the cursor is over no person row — e.g. over the ‹ › buttons);
 *   3. the LAST anchored person's position (#194), clamped to the
 *      current list — the anchor may have just been pruned, so the
 *      remembered index can outrun a shrunken list;
 *   4. -1 — no person was ever anchored; the caller keeps the historical
 *      start/end fallback (dir 1 ⇒ 0, dir -1 ⇒ last). */
export function stepBase(
  stepIdx: number,
  cursorIdx: number,
  lastPos: number,
  listLen: number,
): number {
  if (stepIdx !== -1) return stepIdx;
  if (cursorIdx !== -1) return cursorIdx;
  if (lastPos >= 0 && listLen > 0) return Math.min(lastPos, listLen - 1);
  return -1;
}
