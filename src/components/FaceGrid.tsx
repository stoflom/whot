import { memo, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import type { Face, Person } from "../api";
import FaceCard from "./FaceCard";
import { stagedFieldsForSection, type Stage } from "../stage";

export interface Section {
  key: string;
  title: string;
  subtitle?: string;
  faceIds: number[];
  ruleDefaultName?: string;
  ruleDefaultGroup?: string;
  /** #101: the heading's description label (the appearance) — the title
      itself stays derived from the clustering selector (F6) */
  description?: string;
}

/** the grid-level inputs every section shares — App keeps their
    identities stable (one useMemo for the handlers, useMemo'd maps),
    which is what lets memo(SectionView) compare by identity (#109) */
interface GridShared {
  faces: Map<number, Face>;
  persons: Map<number, Person>;
  /** #101: the live stage — its fields preview on the covered labels */
  stage: Stage | null;
  primaryFaceId: number | null;
  onOpen: (id: number) => void;
  /** right-click menu on face tiles (#32) */
  onContextMenu: (id: number, e: ReactMouseEvent) => void;
  onToggle: (id: number) => void;
  /** #69: plain click — select just this card and drop the range anchor */
  onSelectOne: (id: number) => void;
  /** #69: shift-click — select the range anchor…clicked card */
  onRangeSelect: (id: number) => void;
  onToggleMany: (ids: number[], on: boolean) => void;
  onPrimary: (id: number) => void;
  onRefcrop: (id: number) => void;
  onReject: (id: number) => void;
  onAccept: (id: number) => void;
  /** #101 (§4.24): the grid's only editable surface — the Edit dialog */
  onEditCard: (id: number) => void;
  onEditGroup: (ids: number[]) => void;
}

interface GridProps extends GridShared {
  sections: Section[];
  sel: Set<number>;
}

/** #109: a stable identity for "which staged fields preview on this
    section" — "" while no live stage overlaps it, so only the sections
    a stage newly covers (or stops covering) change when it does */
function stagedKeyFor(stage: Stage | null, ids: number[]): string {
  if (!stage) return "";
  const f = stagedFieldsForSection(stage, ids);
  return Object.keys(f).length ? JSON.stringify(f) : "";
}

const SectionView = memo(
  function SectionView({
    section,
    selSig,
    selSize,
    stagedKey,
    faces,
    persons,
    stage,
    primaryFaceId,
    onOpen,
    onContextMenu,
    onToggle,
    onSelectOne,
    onRangeSelect,
    onToggleMany,
    onPrimary,
    onRefcrop,
    onReject,
    onAccept,
    onEditCard,
    onEditGroup,
  }: {
    section: Section;
    /** #109: this section's selected face ids as "a,b,c" — identical
        while its own selection is unchanged, so memo() skips the whole
        section on an O(1) compare */
    selSig: string;
    /** #109: the selection size — passed only to sections holding a
        selection (their selected cards' count labels need it); a
        section without one gets a stable `undefined` */
    selSize?: number;
    /** #109: the staged fields previewing here ("" when none) */
    stagedKey: string;
  } & GridShared) {
    // #109: rebuild this section's selection from its signature — the
    // body runs only when the memo lets the section through
    const sel = useMemo(() => {
      const s = new Set<number>();
      if (selSig) for (const t of selSig.split(",")) s.add(Number(t));
      return s;
    }, [selSig]);
    const allSelected =
      section.faceIds.length > 0 && section.faceIds.every((id) => sel.has(id));
    // #101 (§4.24): labels, not inputs — a staged change previews on them.
    // #109: decoded from the very key the memo compared — the data the
    // comparator saw and the data the body renders are one and the same
    const staged = useMemo(
      () =>
        stagedKey
          ? (JSON.parse(stagedKey) as ReturnType<typeof stagedFieldsForSection>)
          : ({} as ReturnType<typeof stagedFieldsForSection>),
      [stagedKey]
    );
    const nameVal = staged.name ?? section.ruleDefaultName ?? "";
    const groupVal = staged.group ?? section.ruleDefaultGroup ?? "";
    const descVal = staged.desc ?? section.description ?? "";
    // #108: a one-face section renders compact — heading + card, one row
    const single = section.faceIds.length === 1;

    return (
      <section
        className={single ? "face-section single" : "face-section"}
        data-section-key={section.key}
      >
        <div className="face-section-header">
          <label className="select-all" title="Select whole group">
            <input
              type="checkbox"
              title="Select the whole group"
              checked={allSelected}
              onChange={(e) => onToggleMany(section.faceIds, e.target.checked)}
            />
          </label>
          <span className="face-section-title">{section.title}</span>
          <span className="face-section-count">{section.faceIds.length} face(s)</span>
          {section.subtitle && (
            <span className="face-section-sub">{section.subtitle}</span>
          )}
          <span className="rule">
            {/* #101 (§4.24): the heading edits via one dialog — the labels
                show the current values (staged ones underlined) */}
            <span
              className={`rule-label${staged.name != null ? " staged" : ""}${nameVal ? "" : " empty"}`}
              title="Person name"
            >
              {nameVal || "–"}
            </span>
            <span
              className={`rule-label${staged.group != null ? " staged" : ""}${groupVal ? "" : " empty"}`}
              title="Group"
            >
              {groupVal || "–"}
            </span>
            <span
              className={`rule-label${staged.desc != null ? " staged" : ""}${descVal ? "" : " empty"}`}
              title="Description"
            >
              {descVal || "–"}
            </span>
            <button
              className="ghost"
              onClick={() => onEditGroup(section.faceIds)}
              title="Edit name/group/description — dialog, scope Group (#101, §4.24)"
            >
              Edit…
            </button>
          </span>
        </div>
        <div className="face-grid">
          {section.faceIds.map((id) => {
            const face = faces.get(id);
            if (!face) return null;
            const selected = sel.has(id);
            return (
              <FaceCard
                key={id}
                face={face}
                stage={stage}
                selected={selected}
                isPrimary={primaryFaceId === id}
                onOpen={onOpen}
                onContextMenu={onContextMenu}
                // #109: the count matters only to selected cards' titles —
                // unselected cards get a stable `undefined` so their memo
                // holds across toggles elsewhere
                selSize={selected ? selSize : undefined}
                personName={
                  face.person_id != null ? persons.get(face.person_id)?.name : undefined
                }
                personGroup={
                  face.person_id != null
                    ? persons.get(face.person_id)?.groups[0]
                    : undefined
                }
                onEdit={onEditCard}
                onToggle={onToggle}
                onSelectOne={onSelectOne}
                onRangeSelect={onRangeSelect}
                onPrimary={onPrimary}
                onRefcrop={onRefcrop}
                onReject={onReject}
                onAccept={onAccept}
              />
            );
          })}
        </div>
      </section>
    );
  },
  // #109: identity-compare every prop — a card toggle re-renders only the
  // section whose selSig changed (plus the sections holding a selection
  // when the count moves). `stage` deliberately NOT compared: a stage's
  // effect on a section is fully captured by its stagedKey, so sections a
  // stage does not cover keep their (equivalent) previous stage prop
  (a, b) =>
    a.section === b.section &&
    a.selSig === b.selSig &&
    a.stagedKey === b.stagedKey &&
    a.selSize === b.selSize &&
    a.faces === b.faces &&
    a.persons === b.persons &&
    a.primaryFaceId === b.primaryFaceId &&
    a.onOpen === b.onOpen &&
    a.onContextMenu === b.onContextMenu &&
    a.onToggle === b.onToggle &&
    a.onSelectOne === b.onSelectOne &&
    a.onRangeSelect === b.onRangeSelect &&
    a.onToggleMany === b.onToggleMany &&
    a.onPrimary === b.onPrimary &&
    a.onRefcrop === b.onRefcrop &&
    a.onReject === b.onReject &&
    a.onAccept === b.onAccept &&
    a.onEditCard === b.onEditCard &&
    a.onEditGroup === b.onEditGroup,
);

export default function FaceGrid({ sections, sel, ...shared }: GridProps) {
  if (sections.length === 0) {
    return <div className="empty">nothing to show</div>;
  }
  return (
    <div className="face-sections">
      {sections.map((s) => {
        // #109: the per-section selection identity — computed per render
        // (cheap: one `sel.has` per face), consumed only by the comparator
        const selSig = s.faceIds.filter((id) => sel.has(id)).join(",");
        return (
          <SectionView
            key={s.key}
            section={s}
            selSig={selSig}
            selSize={selSig ? sel.size : undefined}
            stagedKey={stagedKeyFor(shared.stage, s.faceIds)}
            {...shared}
          />
        );
      })}
    </div>
  );
}
