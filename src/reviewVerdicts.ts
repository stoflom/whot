// §4.44 (gui-design rule 44) + round-2 session 4 (#222) — the
// review-verdict callbacks leave App as a hook module. The #98 identity
// rule is preserved by construction: the callbacks read the person
// anchor through refs inside the hook (the pendingRef pattern), never
// through the render value, so the identity chain
// markExhaust → doAccept/doReject → faceMenu → gridHandlers stays stable
// across a person advance / tree select in Review — a verdict advances
// the anchor without re-rendering a single untouched FaceCard. The
// callback bodies are verbatim from App (with their #125/#141/#148/
// #165/#188/#189 narrative comments — every behavioural correction is
// regression-tested in reviewVerdicts.test.tsx).

import {
  useCallback,
  useRef,
  type RefObject,
} from "react";
import * as api from "./api";
import type { Face } from "./api";
import type { Verdict } from "./verdictFlip";
import { dropStagesForFaces, type Stage } from "./stage";
import type { Mode } from "./sections";

/** everything the verdict callbacks read from App — the two refs are
    App-owned (the §4.30 exhaust-advance effect consumes the mark) */
export interface ReviewVerdictInputs {
  mode: Mode;
  /** the anchored person — read via the internal ref, NOT as a dep */
  personId: number | null;
  stepIdx: number;
  facesById: Map<number, Face>;
  /** the App verdict runner (#234/rule 45): optimistic flip + in-flight
      bookkeeping + the #219 delta/refresh, clearSel — true on success */
  verdictMutate: (
    fn: () => Promise<unknown>,
    ids: number[],
    to: Verdict,
    clearSel?: boolean
  ) => Promise<boolean>;
  setInfo: (info: string | null) => void;
  setPending: (update: (p: Stage[]) => Stage[]) => void;
  setPersonId: (id: number | null) => void;
  /** #189 cursor-as-target (§4.25) — read live for the focus anchor */
  lastSelRef: RefObject<number | null>;
  hoverRef: RefObject<number | null>;
  /** #125/#148: the pre-mutation exhaust mark */
  exhaustAtRef: RefObject<number>;
  exhaustPidRef: RefObject<number | null>;
}

export function useReviewVerdicts(inp: ReviewVerdictInputs) {
  const {
    mode,
    facesById,
    verdictMutate,
    setInfo,
    setPending,
    setPersonId,
    lastSelRef,
    hoverRef,
    exhaustAtRef,
    exhaustPidRef,
  } = inp;
  // #222 (F-H3): the person anchor and its step index are read live via
  // refs inside the callbacks — render-body assignment, the pendingRef
  // pattern — so no callback in this hook keys on the person: a verdict
  // advance / tree select churns no identities and the App sections
  // memo (keyed on sectionsPersonKey) rebuilds nothing in Review.
  const personIdRef = useRef<number | null>(inp.personId);
  personIdRef.current = inp.personId;
  const stepIdxRef = useRef<number>(inp.stepIdx);
  stepIdxRef.current = inp.stepIdx;

  // #125: a verdict that might empty the current person in Review marks
  // the step index pre-mutation; App's refreshed-snapshot effect
  // consumes it and steps past (exactly what “›” does)
  // #148: the mark also remembers the person it was set for and is
  // consumed unconditionally — a mark that lingers (e.g. the refresh
  // lands after the user left Review) must never fire much later against
  // whatever person the selection holds then
  const markExhaust = useCallback(() => {
    // #188/§4.40: the lock IS the mode — only verdicts made in Review
    // mark (the #175 any-view widening died with the session lock)
    if (mode === "review") {
      const pid = personIdRef.current;
      if (pid != null) {
        exhaustAtRef.current = stepIdxRef.current;
        exhaustPidRef.current = pid;
      }
    }
  }, [mode, exhaustAtRef, exhaustPidRef]);
  // #189/§4.41 — focus follows the verdict: anchor the ACTED-ON person
  // (cursor-as-target §4.25: last selected, else hovered, else the first
  // acted face that has an owner). focusTarget computes the anchor to
  // apply; focusActed applies it. Called only after the mutation
  // succeeds — and after markExhaust captured its pre-mutation mark —
  // so #148's mark comparison and the §4.30 hand-over are untouched;
  // reject reads the PRE-reject owner on purpose (the person the user
  // acted on, never the reject-bin person the delta names)
  const focusTarget = useCallback(
    (ids: number[]): number | null => {
      const first = [lastSelRef.current, hoverRef.current].find(
        (v) => v != null && ids.includes(v)
      );
      const cands = first != null ? [first, ...ids] : ids;
      for (const id of cands) {
        const pid = facesById.get(id)?.person_id;
        if (pid != null) return pid;
      }
      return null;
    },
    [facesById, lastSelRef, hoverRef]
  );
  const focusActed = useCallback(
    (ids: number[]) => {
      const pid = focusTarget(ids);
      if (pid != null) setPersonId(pid);
    },
    [focusTarget, setPersonId]
  );
  // #189/§4.41 + #125/§4.30 interplay: after a verdict, focusActed's
  // setPersonId commits AFTER the exhaust-advance effect (which fires
  // on the refreshed snap). When the focus target IS the acted-upon
  // anchor (the common Review case — the sections are that person's
  // faces) and the verdict drains it, the advance moves the anchor to
  // the next person and focusActed's update would clobber that
  // hand-over (observed on WebKit, where React flushes the focus
  // update as its own commit; Firefox batches it into the refresh
  // commit and the effect wins). So the markExhaust call sites skip
  // focusActed when its target equals the anchor as of the ACTION
  // (the live-ref value when the callback runs). Targets differing from
  // the anchor (a verdict on ANOTHER person's faces — C41 phase B)
  // always apply: the advance is inert then (#148 — the mark belongs to
  // the old anchor).
  const focusActedUnlessNoop = useCallback(
    (ids: number[], anchorAtAction: number | null) => {
      if (focusTarget(ids) !== anchorAtAction) focusActed(ids);
    },
    [focusTarget, focusActed]
  );
  const doAccept = useCallback(
    (ids: number[]) => {
      // #165/§4.35: plain accept never un-rejects — a rejected-only scope
      // is inert with guidance (an assignment is the claim path; the
      // Edit dialog claims by staging a NAME, see commitPending)
      if (
        ids.length > 0 &&
        ids.every((id) => facesById.get(id)?.link_status === "rejected")
      ) {
        setInfo("assign a person to bring it back");
        return;
      }
      markExhaust();
      // #222: the anchor is captured as of the ACTION (the closure
      // value — pre-advance), not re-read after the await: the #189
      // no-op guard compares against the person the verdict acted on
      const anchor = personIdRef.current;
      return verdictMutate(() => api.acceptFaces(ids), ids, "confirmed", true).then(
        (ok) => {
          if (ok) focusActedUnlessNoop(ids, anchor); // #189/§4.41
          return ok;
        }
      );
    },
    [verdictMutate, markExhaust, facesById, focusActedUnlessNoop, setInfo]
  );
  const doReject = useCallback(
    (ids: number[]) => {
      markExhaust();
      // #141 (F2): ops touching the newly-rejected faces are moot (the
      // commit skips rejected faces anyway) — drop them from the staged
      // set, however the rejection was committed (bar ✗, keyboard, card
      // ✗, Edit dialog — the dialog previously handled this itself and
      // the other paths never did)
      setPending((p) => dropStagesForFaces(p, ids));
      // #222: the anchor is captured as of the ACTION (see doAccept)
      const anchor = personIdRef.current;
      return verdictMutate(
        () => api.rejectFaces(ids),
        ids,
        "rejected",
        true
      ).then((ok) => {
        if (ok) focusActedUnlessNoop(ids, anchor); // #189/§4.41
        return ok;
      });
    },
    [verdictMutate, markExhaust, focusActedUnlessNoop, setPending]
  );
  return { markExhaust, doAccept, doReject, focusTarget, focusActed, focusActedUnlessNoop };
}
