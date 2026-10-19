// #67: fields pre-filled with *auto-generated* text (the importer's
// UnknownN clusters) should be replaced wholesale on focus — the user
// almost always wants a new value, not an edit of the generated one.
// User-entered values keep normal caret/selection behaviour.

/** true when v is an auto-generated placeholder name (UnknownN) */
export function isAutoName(v: string): boolean {
  return /^Unknown\d*$/.test(v.trim());
}

/** onFocus handler for inputs: select the whole value when auto-generated */
export function selectAllIfAuto(e: { currentTarget: HTMLInputElement }): void {
  const el = e.currentTarget;
  // rAF: let focus/caret placement settle first, then override the selection
  requestAnimationFrame(() => {
    if (document.activeElement === el && isAutoName(el.value)) el.select();
  });
}
