import { useMemo } from "react";
import type { Person } from "../api";
import SuggestInput, { type SuggestOption } from "./SuggestInput";

// #67/#97 (§4.21) — name input with a suggestion dropdown over the
// existing persons. Picking a suggestion fills the field with that name —
// an existing person is *merged into* (assign-not-rename, v1.7 §3), so
// parents use onPick to make the merge destination explicit (e.g. pre-
// fill the group). UnknownN names are never suggested: the point is to
// reach a real name. Thin wrapper over SuggestInput — all value fields
// share one widget (#97).

interface Props {
  value: string;
  onChange: (v: string) => void;
  persons: Person[];
  /** suggestion chosen — parents pre-fill related fields here */
  onPick?: (p: Person) => void;
  /** Enter with no suggestion highlighted (e.g. dialog submit) */
  onSubmit?: () => void;
  /** Escape with the dropdown closed (e.g. tree rename cancel) */
  onEscape?: () => void;
  /** focus left the widget — the parent's blur-commit (#97) */
  onLeave?: () => void;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
  title?: string;
  select?: "auto" | "all" | "none";
}

export default function NameTypeahead({
  value,
  onChange,
  persons,
  onPick,
  onSubmit,
  onEscape,
  onLeave,
  className,
  placeholder,
  autoFocus,
  title,
  select = "auto",
}: Props) {
  const options = useMemo<SuggestOption[]>(
    () =>
      persons
        .filter((p) => !p.name.startsWith("Unknown")) // generated names are noise
        .map((p) => ({ value: p.name, hint: p.groups.join(", ") || "ungrouped" })),
    [persons],
  );
  return (
    <SuggestInput
      value={value}
      onChange={onChange}
      options={options}
      onPick={(o) => {
        const p = persons.find((x) => x.name === o.value);
        if (p) onPick?.(p);
      }}
      onSubmit={onSubmit}
      onEscape={onEscape}
      onLeave={onLeave}
      className={className}
      placeholder={placeholder}
      title={title}
      autoFocus={autoFocus}
      select={select}
    />
  );
}
