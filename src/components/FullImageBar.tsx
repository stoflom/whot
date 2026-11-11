// #275 (gui-design v11.3) — the ONE full-image header bar. Both
// full-image surfaces (the card-double-click focus split and the Rolls
// image detail) render this component instead of their two stacked
// bars: the original's full path (truncated, dim facts in the hover
// tooltip) + Copy, the MODE-SCOPED ‹ n/m › cluster (the caller passes
// its mode's stepper: persons on the focus surface, the film roll's
// images on the Rolls detail — rule 46), the ⟳/⟲ stored rotation, and
// the surface's close/back control. Pure render — the stepping,
// rotation and close handlers are the caller's (the #123 dialog lives
// in them).
import type { ReactNode } from "react";
import type { ImageRow } from "../api";
import { CopyButton } from "./ErrorNotice";

export interface FullImageBarProps {
  img: ImageRow;
  /** the Rolls detail shows the type (raw/processed); the focus
      surface does not */
  rtype?: string | null;
  /** the mode's stepping (one command per press; #123 guarded by the
      caller) */
  step: (dir: 1 | -1) => void;
  /** the surface's own arrow rules — the person stepper keeps its
      #76/#194 fallback (an unanchored person still steps from the
      cursor/last position), the image stepper disables off-list */
  canPrev: boolean;
  canNext: boolean;
  /** the mode's list length — the `m` of `n/m` (0 → `–`) */
  total: number;
  /** the stepped item's position in the mode's list (-1 = not listed
      → `–/m`) */
  pos: number;
  /** what the arrows step — the button titles' noun and the counter's
      label (`1/4 faces`, `345/560 images`) */
  stepNoun: "face" | "image";
  /** the stored display rotation (#122) — the context-menu twin */
  onRotate: (delta: 90 | -90) => void;
  /** the surface's close/back control (✕/Esc on the split,
      *← rolls* on the detail) */
  close: ReactNode;
}

export function FullImageBar(p: FullImageBarProps) {
  const { img } = p;
  // #268: the ORIGINAL file's full path — never the /tmp viewer
  // fallback copy. The dim facts (W×H · state · type · rotated) ride in
  // the hover tooltip so the bar stays a single line
  const tooltip =
    `${img.primary_path} · ${img.width}×${img.height} · ${img.state}` +
    (p.rtype ? ` · ${p.rtype}` : "") +
    (img.rotation ? ` · rotated ${img.rotation}°` : "");
  return (
    <div className="full-image-bar">
      <span className="full-image-path" title={tooltip}>
        {img.primary_path}
      </span>
      <CopyButton text={img.primary_path} />
      <button
        className="ghost"
        onClick={() => p.step(-1)}
        disabled={!p.canPrev}
        title={`previous ${p.stepNoun} (←)`}
      >
        ‹
      </button>
      {/* #275 (v11.4): the counter is LABELLED — what it counts is part
          of the number, not a guess from the mode */}
      <span className="nav-pos">
        {p.total > 0
          ? `${p.pos === -1 ? "–" : p.pos + 1}/${p.total} ${p.stepNoun}s`
          : "–"}
      </span>
      <button
        className="ghost"
        onClick={() => p.step(1)}
        disabled={!p.canNext}
        title={`next ${p.stepNoun} (→)`}
      >
        ›
      </button>
      <button
        className="ghost"
        onClick={() => p.onRotate(90)}
        title="Rotate 90° clockwise (stored)"
      >
        ⟳
      </button>
      <button
        className="ghost"
        onClick={() => p.onRotate(-90)}
        title="Rotate 90° counter-clockwise (stored)"
      >
        ⟲
      </button>
      {p.close}
    </div>
  );
}
