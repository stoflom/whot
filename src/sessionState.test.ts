// #297 (gui-design rule 50, v15.0) — the session-persistence pure module:
// the versioned blob (de)serialiser, the safe per-field read (the
// first-render seed) and the id validator (snapshot reconciliation).
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import {
  parseSession,
  serializeSession,
  sessionInitial,
  validateIdsFor,
  SESSION_SCHEMA,
} from "./sessionState";

const snapWith = (
  persons: Array<{ id: number }>,
  images: Array<{ id: number; primary_path: string }>,
) => ({
  version: 1,
  persons,
  faces: [],
  images,
  imports: [],
  settings: {
    cluster_threshold: 0.4,
    refcrop_n: 1,
    face_filter: "all",
    cluster_group: "accuracy",
    merge_name_distance: 2,
  },
});

const snap = snapWith(
  [{ id: 1 }, { id: 2 }],
  [
    { id: 10, primary_path: "/r/a/10.jpg" },
    { id: 11, primary_path: "/r/b/11.jpg" },
  ],
);

describe("parseSession (the schema gate)", () => {
  it("absent storage → null (the defaults win)", () => {
    expect(parseSession(null)).toBeNull();
    expect(parseSession(undefined)).toBeNull();
  });
  it("corrupt / non-object storage → null (an affordance, never a fault)", () => {
    expect(parseSession("{nope")).toBeNull();
    expect(parseSession("[]")).toBeNull();
    expect(parseSession('"str"')).toBeNull();
    expect(parseSession("42")).toBeNull();
  });
  it("a mismatched schema stamp → null (ignored, never half-applied)", () => {
    expect(
      parseSession(serializeSession({ v: SESSION_SCHEMA + 1, mode: "rolls" })),
    ).toBeNull();
  });
  it("a valid blob round-trips", () => {
    const b = { v: SESSION_SCHEMA, mode: "rolls" as const, personId: 1, scroll: { rolls: 40 } };
    expect(parseSession(serializeSession(b))).toEqual(b);
  });
});

describe("sessionInitial (the safe per-field read)", () => {
  it("null blob → exactly the pre-#297 boot defaults", () => {
    expect(sessionInitial(null)).toEqual({
      mode: "review",
      personId: null,
      imageId: null,
      splitImageId: null,
      rollRoot: "/",
      rollBranch: "/",
      rollOpen: [],
      rollRecursive: [],
      importDir: null,
      treeFilter: "",
      treeCollapsed: [],
      mountLimit: 12,
      scroll: {},
      paneLeft: 250,
      paneRight: 290,
    });
  });
  it("reads every well-formed field", () => {
    const i = sessionInitial(
      parseSession(
        serializeSession({
          v: SESSION_SCHEMA,
          mode: "person",
          personId: 2,
          imageId: 10,
          splitImageId: 11,
          rollRoot: "/r",
          rollBranch: "/r/a",
          rollOpen: ["/r/a"],
          rollRecursive: ["/r/b"],
          importDir: "/data",
          treeFilter: "ali",
          treeCollapsed: ["/g/1"],
          mountLimit: 24,
          scroll: { person: 7, review: 0 },
          paneLeft: 300,
          paneRight: 400,
        }),
      ),
    );
    expect(i.mode).toBe("person");
    expect(i.personId).toBe(2);
    expect(i.imageId).toBe(10);
    expect(i.splitImageId).toBe(11);
    expect(i.rollRoot).toBe("/r");
    expect(i.rollBranch).toBe("/r/a");
    expect(i.rollOpen).toEqual(["/r/a"]);
    expect(i.rollRecursive).toEqual(["/r/b"]);
    expect(i.importDir).toBe("/data");
    expect(i.treeFilter).toBe("ali");
    expect(i.treeCollapsed).toEqual(["/g/1"]);
    expect(i.mountLimit).toBe(24);
    expect(i.scroll).toEqual({ person: 7, review: 0 });
    expect(i.paneLeft).toBe(300);
    expect(i.paneRight).toBe(400);
  });
  it("rejects wrong-shaped fields, keeps the rest", () => {
    const i = sessionInitial(
      parseSession(
        JSON.stringify({
          v: SESSION_SCHEMA,
          mode: "not-a-mode",
          personId: -1,
          rollRoot: "",
          rollOpen: "not-a-list",
          mountLimit: 4,
          scroll: { person: -5, rolls: 3 },
          paneLeft: 10,
        }),
      ),
    );
    expect(i.mode).toBe("review");
    expect(i.personId).toBeNull();
    expect(i.rollRoot).toBe("/");
    expect(i.rollOpen).toEqual([]);
    expect(i.mountLimit).toBe(12);
    expect(i.scroll).toEqual({ rolls: 3 });
    expect(i.paneLeft).toBe(250);
  });
});

describe("validateIdsFor (the snapshot reconciliation)", () => {
  it("keeps ids that exist in the snapshot", () => {
    expect(
      validateIdsFor(snap, { personId: 1, imageId: 10, splitImageId: 11, rollBranch: "/" }),
    ).toEqual({ personId: 1, imageId: 10, splitImageId: 11 });
  });
  it("clears ids that no longer exist (an external deletion)", () => {
    expect(
      validateIdsFor(snap, { personId: 99, imageId: 99, splitImageId: 99, rollBranch: "/" }),
    ).toEqual({ personId: null, imageId: null, splitImageId: null });
  });
  it("clears imageId whose path is not under the restored branch (rule 46)", () => {
    expect(
      validateIdsFor(snap, { personId: 1, imageId: 11, splitImageId: null, rollBranch: "/r/a" }),
    ).toEqual({ personId: 1, imageId: null, splitImageId: null });
  });
  it("keeps imageId under the branch (exact or prefixed)", () => {
    expect(
      validateIdsFor(snap, { personId: 1, imageId: 10, splitImageId: null, rollBranch: "/r/a" }),
    ).toEqual({ personId: 1, imageId: 10, splitImageId: null });
  });
  it("branch '/' keeps every image", () => {
    expect(
      validateIdsFor(snap, { personId: null, imageId: 11, splitImageId: null, rollBranch: "/" }),
    ).toEqual({ personId: null, imageId: 11, splitImageId: null });
  });
  it("null ids stay null", () => {
    expect(
      validateIdsFor(snap, { personId: null, imageId: null, splitImageId: null, rollBranch: "/" }),
    ).toEqual({ personId: null, imageId: null, splitImageId: null });
  });
});
