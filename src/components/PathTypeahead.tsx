import { useMemo } from "react";
import type { Person } from "../api";
import { isSeat } from "../groupList";
import SuggestInput, { type SuggestOption } from "./SuggestInput";

export type { SuggestOption };

// #97 (§4.21) — group-path inputs suggest the existing group paths, same
// dropdown UX as the name typeahead. The `ungrouped` entry is display-only
// (label) and inserts "" — which the backend turns into the person's
// status seat (§4.35); the five reserved segments are rejected by the
// backend.

/** distinct non-empty group paths over the persons (+ the ungrouped
    entry), sorted — one option list per parent render of its persons.
    #233 (§4.35 display rule): status seats are never suggested — they
    are not actual groups (the backend refuses them anyway) */
export function groupPathOptions(
  persons: Pick<Person, "groups">[],
): SuggestOption[] {
  const set = new Set<string>();
  for (const p of persons)
    for (const g of p.groups) if (g && !isSeat(g)) set.add(g);
  return [
    ...[...set].sort().map((v) => ({ value: v })),
    { value: "", label: "ungrouped" },
  ];
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  options: SuggestOption[];
  onPick?: (o: SuggestOption) => void;
  /** Enter with no highlight (e.g. dialog submit / field commit) */
  onSubmit?: () => void;
  /** Escape with the dropdown closed (e.g. GroupDialog cancel) */
  onEscape?: () => void;
  /** focus left the widget — the parent's blur-commit (#97) */
  onLeave?: () => void;
  /** #307: the inner <input> element (the dialog's live-DOM commit) */
  inputRef?: (el: HTMLInputElement | null) => void;
  className?: string;
  placeholder?: string;
  title?: string;
  autoFocus?: boolean;
  /** #67: group paths are structural — the default selects them whole;
      #92 append prefills (`<path>|`) pass select="none" + caretEnd */
  select?: "auto" | "all" | "none";
  caretEnd?: boolean;
}

export default function PathTypeahead({
  value,
  onChange,
  options,
  onPick,
  onSubmit,
  onEscape,
  onLeave,
  inputRef,
  className,
  placeholder,
  title,
  autoFocus,
  select = "all",
  caretEnd = false,
}: Props) {
  return (
    <SuggestInput
      value={value}
      onChange={onChange}
      options={options}
      onPick={onPick}
      onSubmit={onSubmit}
      onEscape={onEscape}
      onLeave={onLeave}
      inputRef={inputRef}
      className={className}
      placeholder={placeholder}
      title={title}
      autoFocus={autoFocus}
      select={select}
      caretEnd={caretEnd}
    />
  );
}

/** memoised convenience for parents that already hold the persons */
export function useGroupPathOptions(persons: Pick<Person, "groups">[]): SuggestOption[] {
  return useMemo(() => groupPathOptions(persons), [persons]);
}
