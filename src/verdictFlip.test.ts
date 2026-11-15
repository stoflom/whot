// #234 (gui-design rule 45) — the optimistic verdict flip. The flip is
// the pre-IPC status change that makes the acted-upon cards respond at
// click time; the §219 delta overwrites the flipped rows on arrival and
// restoreLinkStatus rolls a failed verdict back. The #222 identity rule
// is pinned here: untouched rows (and the snapshot itself, on a no-op)
// keep their referential identity.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import type { Face, Snapshot } from "./api";
import { flipLinkStatus, restoreLinkStatus } from "./verdictFlip";

function faceOf(
  id: number,
  status: "provisional" | "confirmed" | "rejected",
  person: number | null = 3,
): Face {
  return {
    id,
    image_id: 9,
    person_id: person,
    x: 0,
    y: 0,
    w: 1,
    h: 1,
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

function snapOf(faces: Face[]): Snapshot {
  return {
    version: 1,
    persons: [],
    faces,
    images: [],
    imports: [],
    settings: {
      cluster_threshold: 0.4,
      refcrop_n: 6,
      face_filter: "all",
      cluster_group: "accuracy",
      merge_name_distance: 2,
      merge_suffix_aliases: [],
    image_viewer: "",
    directory_viewer: "",
    },
  };
}

describe("flipLinkStatus — accept", () => {
  it("flips provisional faces to confirmed", () => {
    const snap = snapOf([faceOf(1, "provisional")]);
    const r = flipLinkStatus(snap, [1], "confirmed");
    expect(r.next.faces[0].link_status).toBe("confirmed");
    expect(r.prior.get(1)).toBe(snap.faces[0]);
  });

  it("never un-rejects (backend parity: accept skips rejected faces)", () => {
    const snap = snapOf([faceOf(1, "rejected")]);
    const r = flipLinkStatus(snap, [1], "confirmed");
    expect(r.next).toBe(snap); // a no-op — same snapshot object
    expect(r.prior.size).toBe(0);
    expect(snap.faces[0].link_status).toBe("rejected");
  });

  it("an already-confirmed face is a no-op (no new identity)", () => {
    const snap = snapOf([faceOf(1, "confirmed")]);
    const r = flipLinkStatus(snap, [1], "confirmed");
    expect(r.next).toBe(snap);
    expect(r.prior.size).toBe(0);
  });
});

describe("flipLinkStatus — reject", () => {
  it("flips provisional AND confirmed faces to rejected", () => {
    const snap = snapOf([faceOf(1, "provisional"), faceOf(2, "confirmed")]);
    const r = flipLinkStatus(snap, [1, 2], "rejected");
    expect(r.next.faces[0].link_status).toBe("rejected");
    expect(r.next.faces[1].link_status).toBe("rejected");
  });

  it("an already-rejected face is a no-op (it is home — backend parity)", () => {
    const snap = snapOf([faceOf(1, "rejected")]);
    const r = flipLinkStatus(snap, [1], "rejected");
    expect(r.next).toBe(snap);
    expect(r.prior.size).toBe(0);
  });
});

describe("flipLinkStatus — the #222 identity rule", () => {
  it("untouched rows keep their identity; only the flipped rows move", () => {
    const snap = snapOf([
      faceOf(1, "provisional"),
      faceOf(2, "confirmed"),
      faceOf(3, "rejected"),
    ]);
    const r = flipLinkStatus(snap, [1], "confirmed");
    expect(r.next).not.toBe(snap);
    expect(r.next.faces[0]).not.toBe(snap.faces[0]); // flipped
    expect(r.next.faces[1]).toBe(snap.faces[1]); // untouched
    expect(r.next.faces[2]).toBe(snap.faces[2]); // untouched
    expect(r.prior.size).toBe(1);
  });

  it("unknown ids are a no-op (same snapshot, empty prior)", () => {
    const snap = snapOf([faceOf(1, "provisional")]);
    const r = flipLinkStatus(snap, [42], "confirmed");
    expect(r.next).toBe(snap);
    expect(r.prior.size).toBe(0);
  });

  it("an empty id list is a no-op", () => {
    const snap = snapOf([faceOf(1, "provisional")]);
    const r = flipLinkStatus(snap, [], "rejected");
    expect(r.next).toBe(snap);
  });
});

describe("restoreLinkStatus — the rollback", () => {
  it("restores the pre-flip rows in place (id order preserved)", () => {
    const snap = snapOf([
      faceOf(1, "provisional"),
      faceOf(2, "confirmed"),
      faceOf(3, "provisional"),
    ]);
    const r = flipLinkStatus(snap, [1, 3], "rejected");
    const back = restoreLinkStatus(r.next, r.prior, "rejected");
    expect(back.faces.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(back.faces[0]).toBe(snap.faces[0]);
    expect(back.faces[1]).toBe(snap.faces[1]);
    expect(back.faces[2]).toBe(snap.faces[2]);
  });

  it("an empty prior returns the snapshot unchanged", () => {
    const snap = snapOf([faceOf(1, "provisional")]);
    expect(restoreLinkStatus(snap, new Map(), "rejected")).toBe(snap);
  });

  it("restores onto a snapshot that moved on (the delta interleaved)", () => {
    // an unrelated face moved on (the delta interleaved); the rollback
    // restores this verdict's row and leaves the interleave alone
    const snap = snapOf([faceOf(1, "provisional"), faceOf(2, "confirmed")]);
    const r = flipLinkStatus(snap, [1], "rejected");
    const moved: Snapshot = {
      ...r.next,
      faces: [r.next.faces[0], { ...r.next.faces[1], name: "x" }],
    };
    const back = restoreLinkStatus(moved, r.prior, "rejected");
    expect(back.faces[0]).toBe(snap.faces[0]); // restored
    expect(back.faces[1].name).toBe("x"); // the interleave survives
  });

  // #325 — the rollback is GUARDED: a prior row is restored only when
  // the current row is still exactly this verdict's optimistic flip
  // (nothing authoritative has since touched the face).
  it("does not clobber an authoritative delta that landed mid-flight", () => {
    const snap = snapOf([faceOf(1, "provisional"), faceOf(2, "confirmed")]);
    const r = flipLinkStatus(snap, [1, 2], "rejected");
    // between the flip and the failure, a concurrent verdict's
    // authoritative delta replaced row 1 (re-homed, name re-derived):
    // the DB owns that row now — the rollback must leave it alone
    const authoritative1: Face = {
      ...r.prior.get(1)!,
      person_id: 7,
      name: "Rejected1",
      link_status: "rejected",
    };
    const mid: Snapshot = {
      ...r.next,
      faces: [authoritative1, r.next.faces[1]],
    };
    const back = restoreLinkStatus(mid, r.prior, "rejected");
    expect(back.faces[0]).toBe(authoritative1); // NOT clobbered
    expect(back.faces[1]).toBe(snap.faces[1]); // the untouched flip rolls back
  });

  it("does not restore when the status matches but the row moved (re-homed by another writer)", () => {
    const snap = snapOf([faceOf(1, "provisional")]);
    const r = flipLinkStatus(snap, [1], "rejected");
    // an external reject of the same face landed: same link_status as
    // the optimistic value, but the row was re-homed (person + name)
    const externalReject: Face = {
      ...r.next.faces[0],
      person_id: 9,
      name: "Rejected3",
    };
    const back = restoreLinkStatus(
      { ...r.next, faces: [externalReject] },
      r.prior,
      "rejected",
    );
    expect(back.faces[0]).toBe(externalReject); // the status match is not enough
  });

  it("overlapping verdicts: a later failed verdict does not revert an earlier verdict's intact flip", () => {
    // A accepts {1,2}; B (overlapping) rejects {2,3} — B's prior for
    // face 2 was captured AFTER A's flip. B fails first: its restore
    // puts face 2 back to A's optimistic flip (the value B saw), and
    // A's still-in-flight flip remains in place — no stale clobber
    const snap = snapOf([
      faceOf(1, "provisional"),
      faceOf(2, "provisional"),
      faceOf(3, "provisional"),
    ]);
    const a = flipLinkStatus(snap, [1, 2], "confirmed");
    const b = flipLinkStatus(a.next, [2, 3], "rejected");
    const afterB = restoreLinkStatus(b.next, b.prior, "rejected");
    expect(afterB.faces[0].link_status).toBe("confirmed"); // A's flip intact
    expect(afterB.faces[0]).toBe(a.next.faces[0]); // identity: still A's row
    expect(afterB.faces[1].link_status).toBe("confirmed"); // back to what B saw
    expect(afterB.faces[2].link_status).toBe("provisional"); // B rolled its own back
  });
});
