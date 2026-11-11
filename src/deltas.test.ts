// #281 — the pure delta-protocol helpers (deltas.ts): the exact
// staleness predicate (`base`/drift) and the upsert/drop application.
// Run: npm test (vitest run)

import { describe, expect, it } from "vitest";
import type { Delta, Face, ImageRow, Person, Snapshot } from "./api";
import { applyDeltaToSnapshot, deltaStale } from "./deltas";

const person = (id: number, name: string): Person => ({
  id,
  name,
  state: "created",
  note: null,
  primary_face_id: null,
  primary_pinned: 0,
  created_at: "",
  groups: [],
  counts: { total: 0, provisional: 0, confirmed: 0, rejected: 0 },
});

const face = (id: number): Face => ({
  id,
  image_id: 1,
  person_id: null,
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  name: `f${id}`,
  seq: id,
  description: null,
  confidence: 0.9,
  link_status: "provisional",
  state: "detected",
  rotation: 0,
  import_id: null,
  created_at: "",
});

const image = (id: number): ImageRow => ({
  id,
  primary_path: `/r/i${id}.jpg`,
  width: 100,
  height: 100,
  orientation: "landscape",
  rotation: 0,
  rtype: "processed",
  state: "scanned",
  first_import_id: 1,
  last_import_id: 1,
});

const snap = (): Snapshot => ({
  version: 7,
  persons: [person(1, "Ann"), person(2, "Ben")],
  faces: [face(1), face(2)],
  images: [image(1)],
  imports: [],
  settings: {
    cluster_threshold: 0.4,
    refcrop_n: 5,
    face_filter: "all",
    cluster_group: "accuracy",
    merge_name_distance: 2,
    merge_suffix_aliases: [],
    image_viewer: "",
    directory_viewer: "",
  },
});

const delta = (over: Partial<Delta>): Delta => ({
  version: 8,
  base: 7,
  drifted: false,
  removed: [],
  ...over,
});

describe("deltaStale (#281 — exact staleness)", () => {
  it("a delta whose base matches the applied stamp is fresh", () => {
    expect(deltaStale(delta({}), 7)).toBe(false);
  });

  it("drifted (an external write mid-command) is stale", () => {
    expect(deltaStale(delta({ drifted: true }), 7)).toBe(true);
  });

  it("base ≠ the applied stamp (an external write BEFORE the pre-read) is stale", () => {
    // the count-only check could never see this: the stamp moved by
    // exactly 1, entirely before the command's pre-read — the delta
    // does not cover the external write's rows
    expect(deltaStale(delta({ version: 9, base: 8 }), 7)).toBe(true);
  });

  it("a zero-row write keeps version === base — not stale", () => {
    // the command wrote nothing: applying it is a no-op and the stamp
    // it reports back equals the state's own stamp
    expect(deltaStale(delta({ version: 7, base: 7 }), 7)).toBe(false);
  });
});

describe("applyDeltaToSnapshot (#219/#281 — upsert/drop)", () => {
  it("upserts touched persons by id, keeping list positions", () => {
    const next = applyDeltaToSnapshot(
      snap(),
      delta({ persons: [person(2, "Ben II"), person(3, "Cid")] }),
    );
    expect(next.persons.map((p) => p.name)).toEqual(["Ann", "Ben II", "Cid"]);
  });

  it("drops removed persons by id", () => {
    const next = applyDeltaToSnapshot(snap(), delta({ removed: [1] }));
    expect(next.persons.map((p) => p.id)).toEqual([2]);
  });

  it("upserts touched faces/images by id, appending new ones", () => {
    const s = snap();
    const next = applyDeltaToSnapshot(
      s,
      delta({ faces: [face(2), face(3)], images: [image(1), image(4)] }),
    );
    expect(next.faces.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(next.images.map((i) => i.id)).toEqual([1, 4]);
    // a re-emitted row replaces the old object (the GUI reads fresh fields)
    expect(next.faces.find((f) => f.id === 2)).not.toBe(s.faces[1]);
    expect(next.persons).toBe(s.persons); // persons untouched
    expect(next.settings).toBe(s.settings);
  });

  it("leaves untouched tables referentially identical", () => {
    const s = snap();
    const next = applyDeltaToSnapshot(s, delta({ faces: [face(1)] }));
    expect(next.persons).toBe(s.persons);
    expect(next.images).toBe(s.images);
  });
});