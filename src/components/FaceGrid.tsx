import { type MouseEvent as ReactMouseEvent } from "react";
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

interface GridProps {
  sections: Section[];
  faces: Map<number, Face>;
  sel: Set<number>;
  /** #101: the live stage — its fields preview on the covered labels */
  stage: Stage | null;
  primaryFaceId: number | null;
  onOpen: (id: number) => void;
  /** right-click menu on face tiles (#32) */
  onContextMenu: (id: number, e: ReactMouseEvent) => void;
  persons: Map<number, Person>;
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

function SectionView({ section, ...grid }: { section: Section } & Omit<GridProps, "sections">) {
  const allSelected =
    section.faceIds.length > 0 && section.faceIds.every((id) => grid.sel.has(id));
  // #101 (§4.24): labels, not inputs — a staged change previews on them
  const staged = stagedFieldsForSection(grid.stage, section.faceIds);
  const nameVal = staged.name ?? section.ruleDefaultName ?? "";
  const groupVal = staged.group ?? section.ruleDefaultGroup ?? "";
  const descVal = staged.desc ?? section.description ?? "";

  return (
    <section className="face-section" data-section-key={section.key}>
      <div className="face-section-header">
        <label className="select-all" title="Select whole group">
          <input
            type="checkbox"
            title="Select the whole group"
            checked={allSelected}
            onChange={(e) => grid.onToggleMany(section.faceIds, e.target.checked)}
          />
        </label>
        <span className="face-section-title">{section.title}</span>
        <span className="face-section-count">{section.faceIds.length} face(s)</span>
        {section.subtitle && <span className="face-section-sub">{section.subtitle}</span>}
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
            onClick={() => grid.onEditGroup(section.faceIds)}
            title="Edit name/group/description — dialog, scope Group (#101, §4.24)"
          >
            Edit…
          </button>
        </span>
      </div>
      <div className="face-grid">
        {section.faceIds.map((id) => {
          const face = grid.faces.get(id);
          if (!face) return null;
          return (
            <FaceCard
              key={id}
              face={face}
              stage={grid.stage}
              selected={grid.sel.has(id)}
              isPrimary={grid.primaryFaceId === id}
              onOpen={grid.onOpen}
              onContextMenu={grid.onContextMenu}
              selSize={grid.sel.size}
              personName={
                face.person_id != null ? grid.persons.get(face.person_id)?.name : undefined
              }
              personGroup={
                face.person_id != null
                  ? grid.persons.get(face.person_id)?.groups[0]
                  : undefined
              }
              onEdit={grid.onEditCard}
              onToggle={grid.onToggle}
              onSelectOne={grid.onSelectOne}
              onRangeSelect={grid.onRangeSelect}
              onPrimary={grid.onPrimary}
              onRefcrop={grid.onRefcrop}
              onReject={grid.onReject}
              onAccept={grid.onAccept}
            />
          );
        })}
      </div>
    </section>
  );
}

export default function FaceGrid({ sections, ...rest }: GridProps) {
  if (sections.length === 0) {
    return <div className="empty">nothing to show</div>;
  }
  return (
    <div className="face-sections">
      {sections.map((s) => (
        <SectionView key={s.key} section={s} {...rest} />
      ))}
    </div>
  );
}
