import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { selectAll, selectAllIfAuto } from "../autoText";

// #97 (§4.21) — one suggestion widget behind every value field: substring
// match over the given options, Arrow/Enter/Esc navigation exactly as the
// original NameTypeahead (#67), plus the blur/selection policies the call
// sites need. Picking uses mousedown (focus never leaves), so a pick is
// never a "leave" and never triggers a blur-commit.

export interface SuggestOption {
  /** text inserted into the field ("" = the ungrouped path entry) */
  value: string;
  /** match/display text when it differs from the inserted value */
  label?: string;
  /** right column (a person's groups, a hint) */
  hint?: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  options: SuggestOption[];
  /** suggestion chosen (mousedown keeps focus — not a leave) */
  onPick?: (o: SuggestOption) => void;
  /** Enter with no suggestion highlighted */
  onSubmit?: () => void;
  /** Escape with the dropdown closed (parent-level cancel) */
  onEscape?: () => void;
  /** focus left the whole widget — the parent's blur-commit hook (#97) */
  onLeave?: () => void;
  className?: string;
  placeholder?: string;
  title?: string;
  autoFocus?: boolean;
  /** #67/#92 selection policy on focus+click: 'auto' selects only while
      the value is auto-generated (UnknownN), 'all' selects the whole
      structural value (group paths), 'none' keeps normal caret care */
  select?: "auto" | "all" | "none";
  /** append prefill (#92): no select-all, caret placed at the end on
      mount — the user types after the '|' */
  caretEnd?: boolean;
}

const MAX_SUGGESTIONS = 8;

export default function SuggestInput({
  value,
  onChange,
  options,
  onPick,
  onSubmit,
  onEscape,
  onLeave,
  className,
  placeholder,
  title,
  autoFocus,
  select = "auto",
  caretEnd = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const ref = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return [];
    return options
      .filter(
        (o) =>
          (o.label ?? o.value).toLowerCase().includes(q) &&
          o.value !== value, // exact match: the dropdown adds nothing
      )
      .slice(0, MAX_SUGGESTIONS);
  }, [value, options]);

  const listOpen = open && matches.length > 0;

  // #92 append mode: caret after the prefill once focus lands
  useEffect(() => {
    if (!caretEnd) return;
    const el = ref.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      if (document.activeElement === el)
        el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(raf);
    // mount-only: re-running per keystroke would force the caret to the end
    // while the user edits inside the path (only caretEnd is read here)
  }, [caretEnd]);

  const pick = (o: SuggestOption) => {
    onChange(o.value);
    onPick?.(o);
    setOpen(false);
    setHi(-1);
  };

  const onFocusOrClick = (e: { currentTarget: HTMLInputElement }) => {
    if (select === "all") selectAll(e);
    else if (select === "auto") selectAllIfAuto(e);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // shortcuts must not fire while typing (#68)
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
        ref.current?.blur();
      }
    } else if (e.key === "Escape") {
      if (listOpen) {
        e.preventDefault();
        setOpen(false);
        setHi(-1);
      } else {
        onEscape?.();
      }
    }
  };

  const onBlur = (e: ReactFocusEvent<HTMLInputElement>) => {
    if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) {
      setOpen(false);
      setHi(-1);
      onLeave?.();
    }
  };

  return (
    // clicks inside the widget never reach a card/row behind it (#97:
    // suggestion picks must not re-select a face card or toggle a tree row)
    <span className="typeahead" onClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        className={className}
        value={value}
        placeholder={placeholder}
        title={title}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHi(-1);
        }}
        onFocus={onFocusOrClick}
        onClick={onFocusOrClick}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      {listOpen && (
        <ul className="typeahead-list" role="listbox">
          {matches.map((o, i) => (
            <li
              key={`${o.label ?? o.value}\u0000${o.hint ?? ""}\u0000${i}`}
              role="option"
              aria-selected={i === hi}
              className={i === hi ? "hi" : undefined}
              // mousedown, not click: fires before the input's blur
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
              onMouseEnter={() => setHi(i)}
            >
              <span className="ta-name">{o.label ?? o.value}</span>
              {o.hint != null && <span className="ta-group">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
