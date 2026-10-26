import { useEffect, useRef } from "react";
import { useOwnsKeyboard } from "../overlays";

// Right-click context menu for tiles (#32): grouped entries, closes on
// click-outside/Esc/resize. Only tile surfaces mount this — full images
// keep the default webview menu (#33). // #138: while mounted it
// registers with the overlay registry (Q8: an open menu owns the
// keyboard)

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** keyboard shortcut shown right-aligned (#68) */
  hint?: string;
}
export interface MenuGroup {
  title?: string;
  items: MenuItem[];
}
export interface MenuState {
  x: number;
  y: number;
  groups: MenuGroup[];
}

interface Props {
  menu: MenuState;
  onClose: () => void;
}

const ITEM_H = 26;

export default function ContextMenu({ menu, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useOwnsKeyboard(); // #138
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const height = menu.groups.reduce((n, g) => n + g.items.length * ITEM_H, 0) + 12;
  const x = Math.max(4, Math.min(menu.x, window.innerWidth - 224));
  const y = Math.max(4, Math.min(menu.y, window.innerHeight - height));
  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {menu.groups.map((g, gi) => (
        <div className="ctx-group" key={gi}>
          {g.title && <div className="ctx-title">{g.title}</div>}
          {g.items.map((it, ii) => (
            <button
              key={ii}
              type="button"
              className={`ctx-item${it.danger ? " danger" : ""}`}
              disabled={it.disabled}
              onClick={() => {
                it.onClick();
                onClose();
              }}
            >
              {it.label}
              {it.hint && <span className="ctx-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
