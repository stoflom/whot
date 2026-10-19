import { useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, FocusEvent as ReactFocusEvent } from "react";
import type { Person } from "../api";
import { selectAllIfAuto } from "../autoText";

// #67: name input with a suggestion dropdown over the existing persons.
// Picking a suggestion fills the field with that name — an existing
// person is *merged into* (assign-not-rename, v1.7 §3), so parents use
// onPick to make the merge destination explicit (e.g. pre-fill the group).
// UnknownN names are never suggested: the point is to reach a real name.

interface Props {
  value: string;
  onChange: (v: string) => void;
  persons: Person[];
  /** suggestion chosen — parents pre-fill related fields here */
  onPick?: (p: Person) => void;
  /** Enter with no suggestion highlighted (e.g. dialog submit) */
  onSubmit?: () => void;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
  title?: string;
}

const MAX_SUGGESTIONS = 8;

export default function NameTypeahead({
  value,
  onChange,
  persons,
  onPick,
  onSubmit,
  className,
  placeholder,
  autoFocus,
  title,
}: Props) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return [];
    return persons
      .filter(
        (p) =>
          !p.name.startsWith("Unknown") && // generated names are noise here
          p.name.toLowerCase().includes(q) &&
          p.name !== value, // exact match: the dropdown has nothing to add
      )
      .slice(0, MAX_SUGGESTIONS);
  }, [value, persons]);

  const listOpen = open && matches.length > 0;

  const pick = (p: Person) => {
    onChange(p.name);
    onPick?.(p);
    setOpen(false);
    setHi(-1);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // tree/dialog shortcuts must not fire while typing
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (matches.length === 0) return;
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setHi(e.key === "ArrowDown" ? 0 : matches.length - 1);
        return;
      }
      const d = e.key === "ArrowDown" ? 1 : -1;
      setHi((h) => (h + d + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      if (listOpen && hi >= 0) {
        e.preventDefault();
        pick(matches[hi]);
      } else if (onSubmit) {
        e.preventDefault();
        onSubmit();
      } else {
        e.preventDefault();
        (e.target as HTMLInputElement).blur();
      }
    } else if (e.key === "Escape" && listOpen) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setHi(-1);
    }
  };

  const onBlur = (e: ReactFocusEvent<HTMLInputElement>) => {
    if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) {
      setOpen(false);
      setHi(-1);
    }
  };

  return (
    <span className="typeahead">
      <input
        className={className}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        title={title}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHi(-1);
        }}
        onFocus={selectAllIfAuto}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      {listOpen && (
        <ul className="typeahead-list" role="listbox">
          {matches.map((p, i) => (
            <li
              key={p.id}
              role="option"
              aria-selected={i === hi}
              className={i === hi ? "hi" : undefined}
              // mousedown, not click: fires before the input's blur
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
              onMouseEnter={() => setHi(i)}
            >
              <span className="ta-name">{p.name}</span>
              <span className="ta-group">{p.groups.join(", ") || "ungrouped"}</span>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
