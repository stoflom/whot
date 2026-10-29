// #67: fields pre-filled with *auto-generated* text (the importer's
// UnknownN clusters) should be replaced wholesale — on focus and on
// click, for as long as the value is still auto-generated. The user
// almost always wants a new value, not an edit of the generated one.
// User-entered values keep normal caret/selection behaviour.

/** true when v is an auto-generated placeholder name (UnknownN) */
export function isAutoName(v: string): boolean {
  return /^Unknown\d*$/.test(v.trim());
}

/** onFocus/onClick handler for inputs: select the whole value when
    auto-generated — bound to both, so a click inside the already-focused
    field re-selects too (the Edit-dialog complaint, #67 — the dialog
    was labelled 'Assign to person…' then; #180 unified every opener
    on 'Edit…') */
export function selectAllIfAuto(e: { currentTarget: HTMLInputElement }): void {
  const el = e.currentTarget;
  // rAF: let focus/caret placement settle first, then override the selection
  requestAnimationFrame(() => {
    if (document.activeElement === el && isAutoName(el.value)) el.select();
  });
}

/** onFocus/onClick handler for group-path inputs in *replace* mode:
    select the whole value — a group path is a structural value that is
    normally replaced wholesale, never edited in place (#67 follow-up).
    Every group dialog opens in replace mode (#164 retired #92's append
    mode with its producer). */
export function selectAll(e: { currentTarget: HTMLInputElement }): void {
  const el = e.currentTarget;
  requestAnimationFrame(() => {
    if (document.activeElement === el) el.select();
  });
}
