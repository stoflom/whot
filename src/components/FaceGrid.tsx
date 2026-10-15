import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Face, Person } from "../api";
import FaceCard from "./FaceCard";

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
  onToggleMany: (ids: number[], on: boolean) => void;
  onDescription: (id: number, d: string) => void;
  onPrimary: (id: number) => void;
  onRefcrop: (id: number) => void;
  onReject: (id: number) => void;
  onAccept: (id: number) => void;
  onAssign: (ids: number[], name: string, group: string) => void;
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

  const apply = () => {
    const picked = section.faceIds.filter((id) => grid.sel.has(id));
    grid.onAssign(picked.length > 0 ? picked : section.faceIds, name, group);
  };

  return (
    <section className="face-section">
      <div className="face-section-header">
        <label className="select-all" title="Select whole group">
          <input
            type="checkbox"
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
            placeholder="person name"
          />
          <input
            className="rule-group"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="group e.g. family|lombards"
          />
          <button onClick={apply} title="Assign name+group to the selected faces of this group (whole group if none selected)">
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
              personName={
                face.person_id != null ? grid.persons.get(face.person_id)?.name : undefined
              }
              onAssignName={grid.onAssignName}
              onToggle={grid.onToggle}
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
