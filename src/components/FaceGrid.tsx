import {
  memo,
  useEffect,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Face, Person } from "../api";
import FaceCard from "./FaceCard";
import { firstRealGroup } from "../groupList";
import { stagedFieldsForSectionIndex, type StagedEntry } from "../stage";

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
  /** #101/#123 + #224: the live pending set indexed per face — the
      staged fields previewing on cards/labels are map reads, not scans */
  stageIdx: Map<number, StagedEntry>;
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
  /** #177 (§4.42): ✓ — accept a card as-is (bar semantics, §4.14 scope) */
  onAccept: (id: number) => void;
  /** #177 (§4.42): ✓/✗ on the cluster header — the whole group */
  onAcceptGroup: (ids: number[]) => void;
  onRejectGroup: (ids: number[]) => void;
  /** #101 (§4.24): the grid's only editable surface — the Edit dialog */
  onEditCard: (id: number) => void;
  onEditGroup: (ids: number[]) => void;
  /** #135/#136 (rule 34): face drag & drop — stable handler identities, */
  onFaceDragStart: (id: number, e: import("react").DragEvent) => void;
  onFaceDragEnd: () => void;
  onFaceDragOver: (id: number, e: import("react").DragEvent) => void;
  onFaceDragLeave: (id: number) => void;
  onFaceDropOnCard: (id: number, e: import("react").DragEvent) => void;
}

interface GridProps extends GridShared {
  sections: Section[];
  sel: Set<number>;
  /** #234 (rule 45): the faces whose verdict is in flight — the acted
      cards' ✓/✗ and the cluster headers' ✓/✗ dim while their verdict
      is pending. A stable identity (App's INFLIGHT_EMPTY) while no
      verdict is pending, so nothing churns in the idle state */
  inFlight: Set<number>;
  /** #136: the card a face drag currently hovers (null = none) */
  faceDropTarget: number | null;
  /** #194 (§4.41): the empty-state guidance — replaces the bare
      "nothing to show" when provided (App computes it for the person
      context only; grid-level, so it never reaches a section) */
  emptyHint?: string;
  /** #214: incremental mount — when set, only the first `mountLimit`
      sections render and `onNeedMore` grows the prefix from the
      sentinel past its end; unset renders everything (the film roll,
      the image detail, the person view) */
  mountLimit?: number;
  onNeedMore?: () => void;
}

/** #109 + #224: a stable identity for "which staged fields preview on
    this section" — "" while no live pending set overlaps it, so only the
    sections a set newly covers (or stops covering) change when it does.
    The merge runs over the per-face index (one pass over the section's
    ids) instead of scanning every op's face list per section. */
function stagedKeyFor(idx: Map<number, StagedEntry>, ids: number[]): string {
  if (idx.size === 0) return "";
  const f = stagedFieldsForSectionIndex(idx, ids);
  return Object.keys(f).length ? JSON.stringify(f) : "";
}

/** #283 (N8): the comparator's own props type — exported so the
    `sectionPropsEqual` contract is unit-testable at the component level
    (the #98/#222/#282 rules it encodes: a verdict delta that keeps every
    handler identity and this section's data must not re-render it). */
export interface SectionViewProps {
  section: Section;
  /** #109: this section's selected face ids as "a,b,c" — identical
      while its own selection is unchanged, so memo() skips the whole
      section on an O(1) compare */
  selSig: string;
  /** #109: the selection size — passed only to sections holding a
      selection (their selected cards' count labels need it); a
      section without one gets a stable `undefined` */
  selSize?: number;
  /** #234 (rule 45): this section's in-flight face ids as "a,b,c" —
      identical while its own in-flight set is unchanged, so memo()
      skips the whole section on an O(1) compare ("" = none) */
  inFlightSig: string;
  /** #109: the staged fields previewing here ("" when none) */
  stagedKey: string;
  /** #136 (rule 34): this section's hovered description-drop target —
      set only on the one section a drag hovers, stable `undefined`
      elsewhere, so a hover move re-renders one or two sections */
  descTargetId?: number;
}

const SectionView = memo(
  function SectionView({
    section,
    selSig,
    inFlightSig,
    selSize,
    stagedKey,
    faces,
    persons,
    stageIdx,
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
    onAcceptGroup,
    onRejectGroup,
    onEditCard,
    onEditGroup,
    onFaceDragStart,
    onFaceDragEnd,
    onFaceDragOver,
    onFaceDragLeave,
    onFaceDropOnCard,
    descTargetId,
  }: SectionViewProps & GridShared) {
    // #109: rebuild this section's selection from its signature — the
    // body runs only when the memo lets the section through
    const sel = useMemo(() => {
      const s = new Set<number>();
      if (selSig) for (const t of selSig.split(",")) s.add(Number(t));
      return s;
    }, [selSig]);
    const allSelected =
      section.faceIds.length > 0 && section.faceIds.every((id) => sel.has(id));
    // #234 (rule 45): rebuild this section's in-flight set from its
    // signature — the body runs only when the memo lets the section
    // through
    const inFlight = useMemo(() => {
      const s = new Set<number>();
      if (inFlightSig) for (const t of inFlightSig.split(",")) s.add(Number(t));
      return s;
    }, [inFlightSig]);
    const groupInFlight = inFlightSig !== "";
    // #101 (§4.24): labels, not inputs — a staged change previews on them.
    // #109: decoded from the very key the memo compared — the data the
    // comparator saw and the data the body renders are one and the same
    const staged = useMemo(
      () =>
        stagedKey
          ? (JSON.parse(stagedKey) as ReturnType<typeof stagedFieldsForSectionIndex>)
          : ({} as ReturnType<typeof stagedFieldsForSectionIndex>),
      [stagedKey]
    );
    const nameVal = staged.name ?? section.ruleDefaultName ?? "";
    const groupVal = staged.group ?? section.ruleDefaultGroup ?? "";
    const descVal = staged.desc ?? section.description ?? "";
    // #120: the heading always sits on its own row above the card(s) —
    // the #108 compact one-row layout was withdrawn (a heading beside a
    // single card left a tall black column and read as broken).
    return (
      <section className="face-section" data-section-key={section.key}>

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
              className={`rule-label${staged.name != null ? " staged" : ""}${nameVal ? "" : " is-empty"}`}
              title="Person name"
            >
              {nameVal || "–"}
            </span>
            <span
              className={`rule-label${staged.group != null ? " staged" : ""}${groupVal ? "" : " is-empty"}`}
              title="Group — set via Edit… (scope Group)"
            >
              {groupVal || "Friends|School"}
            </span>
            <span
              className={`rule-label${staged.desc != null ? " staged" : ""}${descVal ? "" : " is-empty"}`}
              title="Description — set via Edit… (scope Group)"
            >
              {descVal || "description"}
            </span>
            {/* #177/§4.42: accept/reject the whole group — stages
                commit first on accept; titles stay reference-free
                (§4.43). #101/§4.24: Edit… opens the dialog at scope
                Group */}
            <button
              className={`sec-accept${groupInFlight ? " in-flight" : ""}`}
              disabled={groupInFlight} // #234 (rule 45)
              onClick={() => onAcceptGroup(section.faceIds)}
              title={`Accept all ${section.faceIds.length} face(s) of this group as-is — stages commit first`}
            >
              ✓
            </button>
            <button
              className={`sec-reject${groupInFlight ? " in-flight" : ""}`}
              disabled={groupInFlight} // #234 (rule 45)
              onClick={() => onRejectGroup(section.faceIds)}
              title={`Reject all ${section.faceIds.length} face(s) of this group`}
            >
              ✗
            </button>
            <button
              className="ghost"
              onClick={() => onEditGroup(section.faceIds)}
              title="Edit name/group/description — dialog, scope Group"
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
            // #224: this card's staged fields — one map read; passed as
            // stable primitives so memo(FaceCard) holds for the cards an
            // Apply does not touch
            const staged = stageIdx.get(id);
            // #233 (§4.35 display rule): the card's group label shows the
            // person's REAL groups only — a status seat is never a real
            // group, so a seated person gets the empty hint
            const person =
              face.person_id != null ? persons.get(face.person_id) : undefined;
            const personGroup = person
              ? firstRealGroup(person.groups) || undefined
              : undefined;
            return (
              <FaceCard
                key={id}
                face={face}
                stagedName={staged?.name}
                stagedGroup={staged?.group}
                stagedDesc={staged?.desc}
                selected={selected}
                inFlight={inFlight.has(id)} // #234 (rule 45)
                isPrimary={primaryFaceId === id}
                onOpen={onOpen}
                onContextMenu={onContextMenu}
                // #109: the count matters only to selected cards' titles —
                // unselected cards get a stable `undefined` so their memo
                // holds across toggles elsewhere
                selSize={selected ? selSize : undefined}
                personName={person?.name}
                personGroup={personGroup}
                onEdit={onEditCard}
                onToggle={onToggle}
                onSelectOne={onSelectOne}
                onRangeSelect={onRangeSelect}
                onPrimary={onPrimary}
                onRefcrop={onRefcrop}
                onReject={onReject}
                onAccept={onAccept}
                onFaceDragStart={onFaceDragStart}
                onFaceDragEnd={onFaceDragEnd}
                onFaceDragOver={onFaceDragOver}
                onFaceDragLeave={onFaceDragLeave}
                onFaceDropOnCard={onFaceDropOnCard}
                descTarget={descTargetId === id}
              />
            );
          })}
        </div>
      </section>
    );
  },
  // #109: identity-compare every prop — a card toggle re-renders only the
  // section whose selSig changed (plus the sections holding a selection
  // when the count moves). `stageIdx` deliberately NOT compared: a
  // stage's effect on a section is fully captured by its stagedKey (and
  // the per-card primitives flow through the sections that re-render),
  // so sections a stage does not cover keep their (equivalent) previous
  // index prop
  // #283 (N8): exported for the component-level unit test (the verdict
  // delta rule — #222/#282 keep every handler identity stable, so an
  // untouched section's compare must hold across a delta)
  sectionPropsEqual,
);

/** #109/#283: the memo(SectionView) comparator — identical props ⇒ skip
    the section entirely (one O(1) compare per section per render). */
export function sectionPropsEqual(
  a: SectionViewProps & GridShared,
  b: SectionViewProps & GridShared,
): boolean {
  return (
    a.section === b.section &&
    a.selSig === b.selSig &&
    a.inFlightSig === b.inFlightSig &&
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
    a.onAcceptGroup === b.onAcceptGroup &&
    a.onRejectGroup === b.onRejectGroup &&
    a.onEditCard === b.onEditCard &&
    a.onEditGroup === b.onEditGroup &&
    a.onFaceDragStart === b.onFaceDragStart &&
    a.onFaceDragEnd === b.onFaceDragEnd &&
    a.onFaceDragOver === b.onFaceDragOver &&
    a.onFaceDragLeave === b.onFaceDragLeave &&
    a.onFaceDropOnCard === b.onFaceDropOnCard &&
    a.descTargetId === b.descTargetId
  );
}

function FaceGrid({
  sections,
  sel,
  inFlight,
  faceDropTarget,
  emptyHint,
  mountLimit,
  onNeedMore,
  ...shared
}: GridProps) {
  // #214: the mounted prefix (unset = everything)
  const shown = mountLimit == null ? sections : sections.slice(0, mountLimit);
  const more = mountLimit != null && sections.length > mountLimit;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // #214: grow toward the viewport edge — the sentinel sits just past
  // the last mounted section (the App owns the limit so its depth
  // survives grid unmounts; see gridMount.ts for the reveal rule)
  useEffect(() => {
    if (!more) return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onNeedMore?.();
      },
      // grow ahead of the viewport so scrolling never waits on a frame
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [more, onNeedMore]);
  if (sections.length === 0) {
    return <div className="empty">{emptyHint ?? "nothing to show"}</div>;
  }
  return (
    <div className="face-sections">
      {shown.map((s) => {
        // #109: the per-section selection identity — computed per render
        // (cheap: one `sel.has` per face), consumed only by the comparator
        const selSig = s.faceIds.filter((id) => sel.has(id)).join(",");
        // #234 (rule 45): the per-section in-flight identity (same
        // pattern) — "" while no verdict in this section is pending
        const inFlightSig = s.faceIds
          .filter((id) => inFlight.has(id))
          .join(",");
        // #136: only the section holding the hovered card gets a target
        const descTargetId =
          faceDropTarget != null && s.faceIds.includes(faceDropTarget)
            ? faceDropTarget
            : undefined;
        return (
          <SectionView
            key={s.key}
            section={s}
            selSig={selSig}
            inFlightSig={inFlightSig}
            selSize={selSig ? sel.size : undefined}
            stagedKey={stagedKeyFor(shared.stageIdx, s.faceIds)}
            descTargetId={descTargetId}
            {...shared}
          />
        );
      })}
      {more && <div ref={sentinelRef} className="grid-grow-sentinel" />}
    </div>
  );
}

// #215: memoised — with App's handler/grid identities stable, an App
// re-render that changes none of the grid's own props (menu open, info
// toast, drag state) skips the whole section map
export default memo(FaceGrid);
