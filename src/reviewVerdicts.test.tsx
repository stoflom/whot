// #222 (F-H3) — the review-verdict hook keeps a stable callback identity
// across a person advance / tree select in Review: the #98 chain
// markExhaust → doAccept/doReject → faceMenu → gridHandlers must not
// churn per verdict, or memo(SectionView)/memo(FaceCard) re-render every
// mounted card. renderHook keeps the hook instance across rerenders, so
// callback identity is observable here the way App's renders see it.
// Run: npm test (vitest run; jsdom pragma — React hook identities need a
// renderer).
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReviewVerdicts, type ReviewVerdictInputs } from "./reviewVerdicts";
import type { Face } from "./api";
import type { Stage } from "./stage";

function faceOf(
  id: number,
  person: number | null,
  status: "provisional" | "confirmed" | "rejected" = "provisional",
): Face {
  return {
    id,
    image_id: 9,
    person_id: person,
    x: 0, y: 0, w: 1, h: 1,
    name: "",
    seq: 0,
    description: null,
    confidence: 0,
    link_status: status,
    state: "live",
    rotation: 0,
    import_id: null,
    created_at: "",
  } as Face;
}

/** App-equivalent inputs: the refs are created ONCE and shared across
    rerenders (exactly what App's useRef gives the hook) — a new refs
    object per render would churn the identities the test pins. */
function makeInputs(personId: number | null, faces?: Face[]): ReviewVerdictInputs {
  return {
    mode: "review",
    personId,
    stepIdx: personId != null ? 0 : -1,
    facesById: new Map(
      (faces ?? [faceOf(1, personId), faceOf(2, personId)]).map((f) => [f.id, f])
    ),
    verdictMutate: async () => true,
    setInfo: () => {},
    setPending: () => {},
    setPersonId: () => {},
    lastSelRef: { current: null },
    hoverRef: { current: null },
    exhaustAtRef: { current: -1 },
    exhaustPidRef: { current: null },
  };
}

describe("useReviewVerdicts — the identity chain (#222 F-H3)", () => {
  it("the callbacks keep identity across a person advance in review (gridHandlers stays put)", () => {
    const base = makeInputs(3);
    const { result, rerender } = renderHook(
      (p: ReviewVerdictInputs) => useReviewVerdicts(p),
      { initialProps: base }
    );
    const first = result.current;
    // the verdict advance: a new anchor, same snapshot, same refs
    rerender({ ...base, personId: 5, stepIdx: 1 });
    const second = result.current;
    expect(second.markExhaust).toBe(first.markExhaust);
    expect(second.doAccept).toBe(first.doAccept);
    expect(second.doReject).toBe(first.doReject);
    expect(second.focusActed).toBe(first.focusActed);
    expect(second.focusActedUnlessNoop).toBe(first.focusActedUnlessNoop);
  });

  it("a tree select (same snapshot, another anchor) churns nothing either", () => {
    const base = makeInputs(3);
    const { result, rerender } = renderHook(
      (p: ReviewVerdictInputs) => useReviewVerdicts(p),
      { initialProps: base }
    );
    const first = result.current;
    rerender({ ...base, personId: 7, stepIdx: 2 });
    expect(result.current.doAccept).toBe(first.doAccept);
    expect(result.current.doReject).toBe(first.doReject);
    expect(result.current.markExhaust).toBe(first.markExhaust);
  });

  it("the callbacks DO move with their real inputs (the chain is not frozen)", () => {
    const base = makeInputs(3);
    const { result, rerender } = renderHook(
      (p: ReviewVerdictInputs) => useReviewVerdicts(p),
      { initialProps: base }
    );
    const first = result.current;
    // a snapshot lands (facesById identity moves) — the guard-reading
    // callbacks must see the new data, so they re-create (App's
    // gridHandlers recomputes once per snapshot, never per person)
    const nextFaces = [faceOf(1, 3), faceOf(2, 3)];
    rerender({ ...base, facesById: new Map(nextFaces.map((f) => [f.id, f])) });
    expect(result.current.doAccept).not.toBe(first.doAccept);
    // mode is a dep of markExhaust only (#188 — the lock IS the mode)
    rerender({ ...base, mode: "person" });
    expect(result.current.markExhaust).not.toBe(first.markExhaust);
  });
});

describe("useReviewVerdicts — the verdict contracts (verbatim from App)", () => {
  it("the exhaust mark reads the LIVE anchor (#125/#148), not a stale closure", () => {
    const base = makeInputs(3);
    const { result, rerender } = renderHook(
      (p: ReviewVerdictInputs) => useReviewVerdicts(p),
      { initialProps: base }
    );
    rerender({ ...base, personId: 5, stepIdx: 1 });
    result.current.markExhaust();
    expect(base.exhaustPidRef.current).toBe(5);
    expect(base.exhaustAtRef.current).toBe(1);
  });

  it("outside Review the mark is inert (#188 — the lock IS the mode)", () => {
    const base = makeInputs(3);
    const { result, rerender } = renderHook(
      (p: ReviewVerdictInputs) => useReviewVerdicts(p),
      { initialProps: base }
    );
    rerender({ ...base, mode: "person" });
    result.current.markExhaust();
    expect(base.exhaustPidRef.current).toBeNull();
    expect(base.exhaustAtRef.current).toBe(-1);
  });

  it("a rejected-only accept scope is inert with guidance (#165/§4.35)", async () => {
    const base = makeInputs(3, [faceOf(1, 3, "rejected")]);
    const infos: (string | null)[] = [];
    base.setInfo = (s) => infos.push(s);
    const { result } = renderHook(
      (p: ReviewVerdictInputs) => useReviewVerdicts(p),
      { initialProps: base }
    );
    const ok = await result.current.doAccept([1]);
    expect(ok).toBeUndefined();
    expect(infos).toEqual(["assign a person to bring it back"]);
  });

  it("a reject drops the staged ops touching the rejected faces (#141/F2)", async () => {
    const base = makeInputs(3);
    let applied: Stage[] | null = null;
    base.setPending = (up) => {
      applied = up([
        { faceIds: [1], name: "X" },
        { faceIds: [2], desc: "y" },
      ]);
      return applied;
    };
    const { result } = renderHook(
      (p: ReviewVerdictInputs) => useReviewVerdicts(p),
      { initialProps: base }
    );
    await result.current.doReject([1]);
    expect(applied).toEqual([{ faceIds: [2], desc: "y" }]);
  });

  it("the focus anchor is captured as of the action (the #189 no-op guard)", async () => {
    // anchor == the acted-on person's owner → focusActed is skipped (the
    // §4.30 exhaust hand-over must not be clobbered)
    const base = makeInputs(3);
    base.lastSelRef = { current: 1 }; // the acted face belongs to person 3
    let focused: number | null | undefined = undefined;
    base.setPersonId = (id) => {
      focused = id;
    };
    const { result } = renderHook(
      (p: ReviewVerdictInputs) => useReviewVerdicts(p),
      { initialProps: base }
    );
    await result.current.doAccept([1]);
    expect(focused).toBeUndefined();

    // a verdict on ANOTHER person's faces always applies (C41 phase B):
    // the anchor (5) differs from the acted face's owner (3)
    const other = makeInputs(5, [faceOf(1, 3)]);
    other.lastSelRef = { current: 1 };
    let focused2: number | null | undefined = undefined;
    other.setPersonId = (id) => {
      focused2 = id;
    };
    const { result: r2 } = renderHook(
      (p: ReviewVerdictInputs) => useReviewVerdicts(p),
      { initialProps: other }
    );
    await r2.current.doAccept([1]);
    expect(focused2).toBe(3);
  });
});
