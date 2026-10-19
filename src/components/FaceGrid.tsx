import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Face, Person } from "../api";
import FaceCard from "./FaceCard";
import { selectAll } from "../autoText";

export interface Section {
  key: string;
  title: string;
  subtitle?: string;
  faceIds: number[];
  ruleDefaultName?: string;
  ruleDefaultGroup?: string;
}

interface GridProps {
  sections: Section[];
  faces: Map<number, Face>;
  sel: Set<number>;
  primaryFaceId: number | null;
  hoverId: number | null;
  onHover: (id: number | null) => void;
  onOpen: (id: number) => void;
  /** right-click menu on face tiles (#32) */
  onContextMenu: (id: number, e: ReactMouseEvent) => void;
  persons: Map<number, Person>;
  onAssignName: (faceId: number, name: string) => void;
  onToggle: (id: number) => void;
  /** #69: plain click — select just this card and drop the range anchor */
  onSelectOne: (id: number) => void;
  /** #69: shift-click — select the range anchor…clicked card */
  onRangeSelect: (id: number) => void;
  onToggleMany: (ids: number[], on: boolean) => void;
  onDescription: (id: number, d: string) => void;
  onPrimary: (id: number) => void;
  onRefcrop: (id: number) => void;
  onReject: (id: number) => void;
  onAccept: (id: number) => void;
  onAssign: (
    ids: number[],
    name: string,
    group: string,
    /** which fields the user actually changed (#77) */
    nameChanged: boolean,
    groupChanged: boolean
  ) => void;
}

function SectionView({ section, ...grid }: { section: Section } & Omit<GridProps, "sections">) {
  const [name, setName] = useState(section.ruleDefaultName ?? "");
  const [group, setGroup] = useState(section.ruleDefaultGroup ?? "");
  useEffect(() => {
    if (section.ruleDefaultName !== undefined) setName(section.ruleDefaultName);
  }, [section.ruleDefaultName]);
  useEffect(() => {
    if (section.ruleDefaultGroup !== undefined) setGroup(section.ruleDefaultGroup);
  }, [section.ruleDefaultGroup]);

  const allSelected =
    section.faceIds.length > 0 && section.faceIds.every((id) => grid.sel.has(id));

  // #72/#73/#77 — header scope: an active selection wins, whatever its
  // scope — a cross-group selection must never be narrowed to this
  // section (that silently dropped the other groups' cards, #73);
  // with no selection the header acts on its own group (#72). The
  // change flags route group-only edits to set_person_group (#77)
  const nameChanged =
    name.trim() !== "" && name !== (section.ruleDefaultName ?? "");
  const groupChanged = group !== (section.ruleDefaultGroup ?? "");
  const apply = () =>
    grid.onAssign(
      grid.sel.size > 0 ? [...grid.sel] : section.faceIds,
      name,
      group,
      nameChanged,
      groupChanged
    );
  // commit on Enter/blur like every other field — changing the header
  // inputs *is* the operation, no apply click required; guarded so an
  // untouched field never re-fires on blur
  const commit = () => {
    if (nameChanged || groupChanged) apply();
  };

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
          <input
            className="rule-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            placeholder="person name"
            title="Name to assign — the whole selection if any (groups included), else every face in this group (Enter or click away to apply)"
          />
          <input
            className="rule-group input-group"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            title="Group — '|' separated, e.g. family|lombards (empty = ungrouped); applied to the whole selection if any, else the whole group (Enter or click away to apply)"
            placeholder="group e.g. family|lombards"
            onFocus={selectAll}
            onClick={selectAll}
          />
          <button onClick={apply} title="Assign name+group — to the whole selection if any (even across groups), else to every face in this group">
            apply
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
              selected={grid.sel.has(id)}
              hovered={grid.hoverId === id}
              isPrimary={grid.primaryFaceId === id}
              onHover={grid.onHover}
              onOpen={grid.onOpen}
              onContextMenu={grid.onContextMenu}
              selSize={grid.sel.size}
              personName={
                face.person_id != null ? grid.persons.get(face.person_id)?.name : undefined
              }
              onAssignName={grid.onAssignName}
              onToggle={grid.onToggle}
              onSelectOne={grid.onSelectOne}
              onRangeSelect={grid.onRangeSelect}
              onDescription={grid.onDescription}
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
