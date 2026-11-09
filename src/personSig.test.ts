// #213 — the person-data signature the refcrop/cluster effects key on.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import type { Face, Person, Settings } from "./api";
import { personDataSig } from "./personSig";

const face = (id: number, personId: number | null, over: Partial<Face> = {}): Face => ({
  id,
  image_id: 1,
  person_id: personId,
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  name: `p${personId}-${id}`,
  seq: id,
  description: null,
  confidence: 0.9,
  link_status: "provisional",
  state: "detected",
  rotation: 0,
  import_id: null,
  created_at: "now",
  ...over,
});

const person = (id: number, over: Partial<Person> = {}): Person => ({
  id,
  name: `Person${id}`,
  state: "created",
  note: null,
  primary_face_id: null,
  primary_pinned: 0,
  created_at: "now",
  groups: ["New"],
  counts: { total: 1, provisional: 1, confirmed: 0, rejected: 0 },
  ...over,
});

const settings = (over: Partial<Settings> = {}): Settings => ({
  cluster_threshold: 0.4,
  refcrop_n: 5,
  face_filter: "all",
  cluster_group: "accuracy",
  merge_name_distance: 2,
  merge_suffix_aliases: [],
  image_viewer: "",
  directory_viewer: "",
  ...over,
});

describe("personDataSig (#213)", () => {
  const p1 = person(1);
  const faces = [face(10, 1), face(11, 1), face(20, 2)];

  it("is empty without an anchored person or settings", () => {
    expect(personDataSig(null, faces, settings())).toBe("");
    expect(personDataSig(p1, faces, null)).toBe("");
  });

  it("is stable across unrelated state", () => {
    const base = personDataSig(p1, faces, settings());
    // another person's face changes
    expect(personDataSig(p1, [face(10, 1), face(11, 1), face(20, 2, { link_status: "confirmed" })], settings())).toBe(base);
    // the Show filter (a display concern — not read by either command)
    expect(personDataSig(p1, faces, settings({ face_filter: "rejected" }))).toBe(base);
    // face rotation (display-only; refcrop crops and vectors are pixels-fixed)
    expect(personDataSig(p1, [face(10, 1, { rotation: 90 }), face(11, 1), face(20, 2)], settings())).toBe(base);
    // group membership (neither command reads person_groups)
    expect(personDataSig(person(1, { groups: ["family|smiths"] }), faces, settings())).toBe(base);
    // array order of unrelated rows
    expect(personDataSig(p1, [face(20, 2), face(11, 1), face(10, 1)], settings())).toBe(base);
  });

  it("moves on any change to the person's clustering/refcrop inputs", () => {
    const base = personDataSig(p1, faces, settings());
    const changed = [
      personDataSig(p1, [face(10, 1)], settings()), // membership (face 11 gone)
      personDataSig(p1, [face(10, 1), face(11, 1, { link_status: "confirmed" }), face(20, 2)], settings()),
      personDataSig(p1, [face(10, 1), face(11, 1, { state: "discarded" }), face(20, 2)], settings()),
      personDataSig(p1, [face(10, 1), face(11, 1, { description: "beard" }), face(20, 2)], settings()),
      personDataSig(p1, [face(10, 1), face(11, 1, { name: "renamed" }), face(20, 2)], settings()),
      personDataSig(p1, [face(10, 1), face(11, 1, { seq: 42 }), face(20, 2)], settings()),
      personDataSig(p1, [face(10, 1), face(11, 1, { confidence: 0.5 }), face(20, 2)], settings()),
      personDataSig(person(1, { name: "Renamed" }), faces, settings()),
      personDataSig(person(1, { primary_face_id: 10 }), faces, settings()),
      personDataSig(person(1, { primary_pinned: 1 }), faces, settings()),
      personDataSig(p1, faces, settings({ refcrop_n: 9 })),
      personDataSig(p1, faces, settings({ cluster_threshold: 0.6 })),
      personDataSig(p1, faces, settings({ cluster_group: "description" })),
    ];
    for (const sig of changed) expect(sig).not.toBe(base);
  });
});
