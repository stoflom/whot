// #283 (N8) — the memo(SectionView) comparator, unit-tested at the
// component level: identical props (same section object, same handler
// identities, same signatures) ⇒ equal (the section re-renders nothing),
// and each field alone — a fresh section object, a churned handler
// identity, a moved signature — forces the re-render. This is the
// #98/#222/#282 rule: a verdict delta keeps every handler identity, so
// an untouched section's compare must hold across it.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { sectionPropsEqual } from "./FaceGrid";
import type { Face, Person } from "../api";
import type { StagedEntry } from "../stage";

const noop = () => {};
/** the comparator's own props type (SectionViewProps & GridShared) */
type SectionProps = Parameters<typeof sectionPropsEqual>[0];
const shared: Omit<SectionProps, keyof SectionViewOnly> = {
  faces: new Map<number, Face>(),
  persons: new Map<number, Person>([[1, { id: 1 } as Person]]),
  stageIdx: new Map<number, StagedEntry>(),
  primaryFaceId: null,
  onOpen: noop,
  onContextMenu: noop,
  onToggle: noop,
  onSelectOne: noop,
  onRangeSelect: noop,
  onToggleMany: noop,
  onPrimary: noop,
  onRefcrop: noop,
  onReject: noop,
  onAccept: noop,
  onAcceptGroup: noop,
  onRejectGroup: noop,
  onEditCard: noop,
  onEditGroup: noop,
  onFaceDragStart: noop,
  onFaceDragEnd: noop,
  onFaceDragOver: noop,
  onFaceDragLeave: noop,
  onFaceDropOnCard: noop,
};
/** SectionViewProps's own (non-shared) keys */
interface SectionViewOnly {
  section: unknown;
  selSig: string;
  selSize?: number;
  inFlightSig: string;
  stagedKey: string;
  descTargetId?: number;
}
const section = {
  key: "rev-1",
  title: "Unknown1",
  faceIds: [1, 2],
} as unknown as SectionProps["section"];
const props = (): SectionProps => ({
  section,
  selSig: "1",
  selSize: 1,
  inFlightSig: "",
  stagedKey: "",
  descTargetId: undefined,
  ...shared,
});

describe("sectionPropsEqual (#283 N8 — the SectionView memo comparator)", () => {
  it("identical props compare equal (an untouched section skips its render)", () => {
    expect(sectionPropsEqual(props(), props())).toBe(true);
  });

  it("a verdict delta that keeps handler identities and this section's data compares equal", () => {
    // #222/#282: the delta rebuilds the id maps (new Map identity) only
    // when their arrays moved — and untouched persons/sections keep
    // their object identities; a fresh equivalent map must NOT be
    // treated as equal, while the section that did not change is.
    const a = props();
    const b = { ...props(), section };
    expect(sectionPropsEqual(a, b)).toBe(true);
  });

  it("each prop alone forces the re-render", () => {
    const churn = (over: Partial<SectionProps>) =>
      sectionPropsEqual(props(), { ...props(), ...over });
    expect(churn({ section: { ...section } as SectionProps["section"] })).toBe(false); // fresh section object
    expect(churn({ selSig: "1,2" })).toBe(false);
    expect(churn({ selSize: 2 })).toBe(false);
    expect(churn({ selSize: undefined })).toBe(false);
    expect(churn({ inFlightSig: "1" })).toBe(false);
    expect(churn({ stagedKey: '{"name":"x"}' })).toBe(false);
    expect(churn({ faces: new Map() })).toBe(false); // the id maps are data too
    expect(churn({ persons: new Map() })).toBe(false);
    expect(churn({ primaryFaceId: 5 })).toBe(false);
    expect(churn({ onOpen: () => {} })).toBe(false); // handler identity churn
    expect(churn({ onContextMenu: () => {} })).toBe(false);
    expect(churn({ onToggle: () => {} })).toBe(false);
    expect(churn({ onSelectOne: () => {} })).toBe(false);
    expect(churn({ onRangeSelect: () => {} })).toBe(false);
    expect(churn({ onToggleMany: () => {} })).toBe(false);
    expect(churn({ onPrimary: () => {} })).toBe(false);
    expect(churn({ onRefcrop: () => {} })).toBe(false);
    expect(churn({ onReject: () => {} })).toBe(false);
    expect(churn({ onAccept: () => {} })).toBe(false);
    expect(churn({ onAcceptGroup: () => {} })).toBe(false);
    expect(churn({ onRejectGroup: () => {} })).toBe(false);
    expect(churn({ onEditCard: () => {} })).toBe(false);
    expect(churn({ onEditGroup: () => {} })).toBe(false);
    expect(churn({ onFaceDragStart: () => {} })).toBe(false);
    expect(churn({ onFaceDragEnd: () => {} })).toBe(false);
    expect(churn({ onFaceDragOver: () => {} })).toBe(false);
    expect(churn({ onFaceDragLeave: () => {} })).toBe(false);
    expect(churn({ onFaceDropOnCard: () => {} })).toBe(false);
    expect(churn({ descTargetId: 3 })).toBe(false);
  });
});