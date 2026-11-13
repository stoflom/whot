// §4.44 round 2 (#291/#292) — the detail derivations, extracted from
// App for testability (pure: no state, no DOM, no IPC). The wiring
// itself runs against the WebKitGTK window in gui-mock (the C-suite
// pins the rendered surfaces).
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import type { Face, ImageRow, Snapshot } from "./api";
import type { Section } from "./components/FaceGrid";
import {
  facesOfImage,
  fullImageOpenFor,
  imageRowFor,
  splitStepFor,
  stepIndexIn,
} from "./detailView";

// ----------------------------------------------------------- fixtures

const img = (id: number): ImageRow => ({
  id,
  primary_path: `/roll/img${id}.jpg`,
  width: 100,
  height: 80,
  orientation: null,
  rotation: 0,
  rtype: null,
  state: "ok",
  first_import_id: null,
  last_import_id: null,
});

const face = (id: number, imageId: number, status: string, personId = 1): Face => ({
  id,
  image_id: imageId,
  person_id: personId,
  x: 0,
  y: 0,
  w: 10,
  h: 12,
  name: `face${id}`,
  seq: id,
  description: null,
  confidence: 0.9,
  link_status: status,
  state: "ok",
  rotation: 0,
  import_id: null,
  created_at: "",
});

const snapWith = (images: ImageRow[], faces: Face[]): Snapshot => ({
  version: 1,
  persons: [],
  faces,
  images,
  imports: [],
  settings: {
    face_filter: "all",
    cluster_group: "accuracy",
    cluster_threshold: 0.4,
  } as Snapshot["settings"],
});

// ------------------------------------------------------- imageRowFor

describe("imageRowFor (§4.24 / #275)", () => {
  const snap = snapWith([img(3), img(7)], []);

  it("finds the open image's row", () => {
    expect(imageRowFor(snap, 7)).toBe(snap.images[1]);
  });

  it("undefined when nothing is open (null id)", () => {
    expect(imageRowFor(snap, null)).toBeUndefined();
  });

  it("undefined for an absent id", () => {
    expect(imageRowFor(snap, 99)).toBeUndefined();
  });

  it("undefined with no snapshot at all", () => {
    expect(imageRowFor(null, 7)).toBeUndefined();
  });
});

// ------------------------------------------------------- stepIndexIn

describe("stepIndexIn (rule 46 / #235)", () => {
  const list = [img(5), img(9), img(2)];

  it("returns the 0-based position in the branch's listed roll", () => {
    expect(stepIndexIn(list, 9)).toBe(1);
    expect(stepIndexIn(list, 5)).toBe(0);
  });

  it("-1 = not in the list → `–/m`, both buttons disabled", () => {
    // opened from the path filter in another branch, or the Show filter
    // no longer lists it
    expect(stepIndexIn(list, 99)).toBe(-1);
  });

  it("-1 with nothing open", () => {
    expect(stepIndexIn(list, null)).toBe(-1);
  });
});

// ------------------------------------------------------- facesOfImage

describe("facesOfImage (§4.10/#99 — one Show filter drives every view)", () => {
  const snap = snapWith(
    [img(1)],
    [
      face(10, 1, "provisional"),
      face(11, 1, "confirmed"),
      face(12, 1, "rejected"),
      face(13, 2, "provisional"), // another image — never listed
    ],
  );

  it("all = every face of the image, incl. rejected (#305), snapshot order", () => {
    expect(facesOfImage(snap, 1, "all").map((f) => f.id)).toEqual([10, 11, 12]);
  });

  it("provisional/confirmed/rejected list only that status", () => {
    expect(facesOfImage(snap, 1, "confirmed").map((f) => f.id)).toEqual([11]);
    expect(facesOfImage(snap, 1, "rejected").map((f) => f.id)).toEqual([12]);
  });

  it("only the named image's faces (never a neighbour's)", () => {
    expect(facesOfImage(snap, 2, "all").map((f) => f.id)).toEqual([13]);
    expect(facesOfImage(snap, 3, "all")).toEqual([]); // no face on image 3
  });

  it("the empty list with no snapshot or nothing open", () => {
    expect(facesOfImage(null, 1, "all")).toEqual([]);
    expect(facesOfImage(snap, null, "all")).toEqual([]);
  });
});

// --------------------------------------------------- fullImageOpenFor

describe("fullImageOpenFor (rule 46/#275 — one bar above the image)", () => {
  const row = img(1);

  it("the card-double-click split is a full-image surface (any mode)", () => {
    expect(fullImageOpenFor(row, "person", null, undefined)).toBe(true);
    expect(fullImageOpenFor(row, "review", null, undefined)).toBe(true);
  });

  it("the Rolls image detail is a full-image surface", () => {
    expect(fullImageOpenFor(null, "rolls", 1, row)).toBe(true);
  });

  it("Rolls browsing (no image open) is not", () => {
    expect(fullImageOpenFor(null, "rolls", null, null)).toBe(false);
    // an imageId with no row (mid-refresh) is not an open image either
    expect(fullImageOpenFor(null, "rolls", 1, undefined)).toBe(false);
  });

  it("a full image is not open outside Rolls without a split", () => {
    expect(fullImageOpenFor(null, "person", 1, undefined)).toBe(false);
  });
});

// ------------------------------------------------------- splitStepFor

describe("splitStepFor (#275 — the focus bar's `‹ n/m faces ›` step)", () => {
  const mkFace = (id: number, imageId: number): Face => face(id, imageId, "provisional");
  const faces = [mkFace(10, 1), mkFace(11, 2), mkFace(12, 3), mkFace(13, 2)];
  const facesById = new Map(faces.map((f) => [f.id, f]));
  // Person mode: the display order IS the person grid's section order
  const sections = [
    { key: "s0", faceIds: [10, 11] },
    { key: "s1", faceIds: [12, 13] },
  ] as unknown as Section[];
  const split2 = img(2);

  it("Person mode steps in the section display order; pos = the open image's FIRST face", () => {
    expect(
      splitStepFor("person", 1, sections, faces, "all", facesById, split2)
    ).toEqual({ ids: [10, 11, 12, 13], pos: 1 });
  });

  it("Review mode takes the person's faces under the pinned filter in snapshot order", () => {
    // review's personFaceList filters by the pinned status ("provisional"
    // under the all-like fallback) — every fixture face is provisional
    const step = splitStepFor("review", 1, sections, faces, "all", facesById, split2);
    expect(step.ids).toEqual([10, 11, 12, 13]);
    expect(step.pos).toBe(1);
  });

  it("no list for a NULL person (an unassigned face opened the view)", () => {
    expect(
      splitStepFor("person", null, sections, faces, "all", facesById, split2)
    ).toEqual({ ids: [], pos: -1 });
  });

  it("no list with nothing open", () => {
    expect(
      splitStepFor("person", 1, sections, faces, "all", facesById, null)
    ).toEqual({ ids: [], pos: -1 });
  });

  it("pos -1 = the person holds no face on the open image (both arrows inactive)", () => {
    expect(
      splitStepFor("person", 1, sections, faces, "all", facesById, img(99))
    ).toEqual({ ids: [10, 11, 12, 13], pos: -1 });
  });
});
