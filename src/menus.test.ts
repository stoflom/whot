// §4.44 (#206 stage 4) — the context-menu compositions are pure; this
// suite pins the rules the three menus run on:
//   #49/§4.14  the multi-scope label suffixes + one-face-only entries
//   §4.18      the Rejected-scope rule / the distinct-persons Add group…
//   #51        'Open full image' omitted while the image is in the split
//   #174/§4.39 the thumbnail scope (selection ∩ branch, else the thumb)
//   #182       one-item-only entries disable for a multi-scope
// The wiring itself runs against the WebKitGTK window in gui-mock
// (C39–C43, C52 check the composed menus live).
import { describe, expect, it } from "vitest";
import {
  faceMenuGroups,
  thumbMenuGroups,
  imageAreaMenuGroups,
  type FaceMenuInput,
  type ThumbMenuInput,
  type ImageAreaMenuInput,
} from "./menus";
import type { Face, ImageRow } from "./api";
import type { Section } from "./components/FaceGrid";

let nextId = 300;

function face(o: {
  id?: number;
  image?: number;
  person?: number | null;
  status?: string;
} = {}): Face {
  const id = o.id ?? nextId++;
  return {
    id,
    image_id: o.image ?? 9,
    person_id: o.person === undefined ? 1 : o.person,
    x: 0, y: 0, w: 1, h: 1,
    name: "ignored",
    seq: 0,
    description: null,
    confidence: 0,
    link_status: o.status ?? "provisional",
    state: "live",
    rotation: 0,
    import_id: null,
    created_at: "",
  };
}

function img(id: number): ImageRow {
  return {
    id,
    primary_path: "/x/a.jpg",
  } as unknown as ImageRow; // the composer never reads beyond the ids
}

const section = (faceIds: number[]): Section => ({
  key: "k",
  title: "t",
  faceIds,
});

/** flat label lookup over all groups/entries */
function item(
  groups: { title?: string; items: { label: string; disabled?: boolean; hint?: string; onClick: () => void }[] }[],
  label: string,
) {
  return groups.flatMap((g) => g.items).find((i) => i.label === label);
}

const noOp = () => {};

/** complete callback bag; individual cases override what they pin */
const faceCb = {
  actionScope: (id: number) => [id],
  toggle: noOp,
  toggleMany: noOp,
  doAccept: noOp,
  doReject: noOp,
  doPrimary: noOp,
  doRefcrop: noOp,
  rotateFace: noOp,
  changeSel: noOp,
  openEdit: noOp,
  openFullImage: noOp,
  addFaceGroup: noOp,
  splitImageId: null as number | null,
};

const thumbCb = {
  openImageInView: noOp,
  rotateImages: noOp,
  openInViewer: noOp,
  doAccept: noOp,
  changeSel: noOp,
};

describe("faceMenuGroups (#49, §4.18, #51)", () => {
  it("labels scope-width actions with '(N selected)' for a multi-scope", () => {
    const f = face({ id: 1 });
    const g = faceMenuGroups({
      ...faceCb,
      id: 1,
      face: f,
      sel: new Set<number>(),
      section: null,
      facesById: new Map<number, Face>([[1, f], [2, f], [3, f]]),
      actionScope: () => [1, 2, 3],
    });
    expect(item(g, "Accept (3 selected)")).toBeTruthy();
    expect(item(g, "Reject (3 selected)")).toBeTruthy();
    expect(item(g, "Rotate crop 90° CW (3 selected)")).toBeTruthy();
    expect(item(g, "Edit… (3 selected)")).toBeTruthy();
    expect(g.some((gr) => gr.title === "Face — 3 selected")).toBe(true);
  });

  it("keeps the plain labels for a single-face scope", () => {
    const g = faceMenuGroups({
      ...faceCb,
      id: 1,
      face: face({ id: 1 }),
      sel: new Set<number>(),
      section: null,
      facesById: new Map<number, Face>(),
    });
    expect(item(g, "Accept")).toBeTruthy();
    expect(item(g, "Accept (1 selected)")).toBeFalsy();
  });

  it("disables Reject only when EVERY face of the scope is rejected", () => {
    const g = faceMenuGroups({
      ...faceCb,
      id: 1,
      face: face({ id: 1 }),
      sel: new Set<number>(),
      section: null,
      actionScope: () => [1, 2],
      facesById: new Map<number, Face>([
        [1, face({ id: 1, status: "rejected" })],
        [2, face({ id: 2, status: "confirmed" })],
      ]),
    });
    expect(item(g, "Reject (2 selected)")!.disabled).toBe(false);
    const g2 = faceMenuGroups({
      ...faceCb,
      id: 1,
      face: face({ id: 1, status: "rejected" }),
      sel: new Set<number>(),
      section: null,
      actionScope: () => [1, 2],
      facesById: new Map<number, Face>([
        [1, face({ id: 1, status: "rejected" })],
        [2, face({ id: 2, status: "rejected" })],
      ]),
    });
    expect(item(g2, "Reject (2 selected)")!.disabled).toBe(true);
  });

  it("greys the one-face-only entries for a multi-scope (#182/§4.14)", () => {
    const f = face({ id: 1, status: "confirmed" });
    const g = faceMenuGroups({
      ...faceCb,
      id: 1,
      face: f,
      sel: new Set<number>(),
      section: null,
      actionScope: () => [1, 2],
      facesById: new Map<number, Face>([[1, f]]),
    });
    expect(item(g, "Set as primary")!.disabled).toBe(true);
    expect(item(g, "Add as reference")!.disabled).toBe(true);
    expect(item(g, "Rotate crop 90° CW (2 selected)")!.disabled).toBe(true);
  });

  it("omits 'Open full image' while the face's image IS the split (#51)", () => {
    const f = face({ id: 1, image: 9 });
    const withIt = faceMenuGroups({
      ...faceCb,
      id: 1, face: f, sel: new Set<number>(), section: null,
      facesById: new Map(), splitImageId: 5,
    });
    expect(item(withIt, "Open full image")).toBeTruthy();
    const without = faceMenuGroups({
      ...faceCb,
      id: 1, face: f, sel: new Set<number>(), section: null,
      facesById: new Map(), splitImageId: 9,
    });
    expect(item(without, "Open full image")).toBeFalsy();
  });

  it("files the distinct OWNED persons of the scope as the Add group target (§4.18)", () => {
    const f1 = face({ id: 1, person: 7 });
    const f2 = face({ id: 2, person: 7 });
    const f3 = face({ id: 3, person: 4 });
    // 7 seen twice → distinct = [7, 4] → the N-person label
    const g = faceMenuGroups({
      ...faceCb,
      id: 1, face: f1, sel: new Set<number>(), section: null,
      facesById: new Map<number, Face>([[1, f1], [2, f2], [3, f3]]),
      actionScope: () => [1, 2, 3],
    });
    expect(item(g, "Add group to 2 persons…")).toBeTruthy();
    const one = faceMenuGroups({
      ...faceCb,
      id: 1, face: f1, sel: new Set<number>(), section: null,
      facesById: new Map<number, Face>([[1, f1]]),
    });
    expect(item(one, "Add group…")).toBeTruthy();
    // unowned faces count nothing — the entry greys out
    const unowned = faceMenuGroups({
      ...faceCb,
      id: 5, face: face({ id: 5, person: null }), sel: new Set<number>(), section: null,
      facesById: new Map<number, Face>(),
    });
    expect(item(unowned, "Add group…")!.disabled).toBe(true);
  });

  it("'Select whole section' is disabled without a section; label flips by membership", () => {
    const f = face({ id: 1 });
    const noSec = faceMenuGroups({
      ...faceCb,
      id: 1, face: f, sel: new Set<number>(),
      section: null as FaceMenuInput["section"], facesById: new Map(),
    });
    expect(item(noSec, "Select whole section")!.disabled).toBe(true);
    const inp: FaceMenuInput = {
      ...faceCb,
      id: 1,
      face: f,
      sel: new Set([1]),
      section: section([1, 2, 3]),
      facesById: new Map(),
    };
    const withSec = faceMenuGroups(inp);
    expect(item(withSec, "Select whole section")!.disabled).toBe(false);
    expect(item(withSec, "Select whole section")!.hint).toBe("Ctrl-G");
    expect(item(withSec, "Deselect")).toBeTruthy();
    const outside = faceMenuGroups({ ...inp, sel: new Set([2]) });
    expect(item(outside, "Select")).toBeTruthy();
  });
});

describe("thumbMenuGroups (#174/§4.39, #182)", () => {
  const branch = new Set([1]);
  const single: ThumbMenuInput = {
    image: img(1),
    imgSel: { sel: new Set<number>(), anchor: null },
    inBranch: branch,
    faces: [],
    sel: new Set<number>(),
    ...thumbCb,
  };

  it("the single-thumb scope keeps the plain labels", () => {
    const g = thumbMenuGroups(single);
    expect(item(g, "Open image")!.disabled).toBe(false);
    expect(item(g, "Rotate 90° CW")).toBeTruthy();
    expect(item(g, "Open in system viewer")).toBeTruthy();
  });

  it("the multi-scope disables the one-image entries and suffixes the rest (#182)", () => {
    const g = thumbMenuGroups({
      ...single,
      imgSel: { sel: new Set([1, 2, 3]), anchor: 1 },
      inBranch: new Set([1, 2, 3]),
    });
    expect(item(g, "Open image")!.disabled).toBe(true);
    expect(item(g, "Rotate 90° CW (3)")).toBeTruthy();
    expect(item(g, "Open in system viewer (3)")).toBeTruthy();
  });

  it("drops stale ids outside the branch from the scope (§4.39)", () => {
    const g = thumbMenuGroups({
      ...single,
      imgSel: { sel: new Set([1, 2, 3]), anchor: 1 },
      inBranch: new Set([1, 2]), // 3 is stale
    });
    expect(item(g, "Rotate 90° CW (2)")).toBeTruthy();
  });

  it("'Accept all pending' collects the pending faces and greys on none", () => {
    let accepted: number[] | null = null;
    const g = thumbMenuGroups({
      ...single,
      faces: [
        face({ status: "provisional" }),
        face({ status: "confirmed" }),
        face({ status: "provisional" }),
      ],
      doAccept: (ids) => { accepted = ids; },
    });
    const entry = item(g, "Accept all pending")!;
    expect(entry.disabled).toBe(false);
    entry.onClick();
    expect(accepted!.length).toBe(2);
    const empty = thumbMenuGroups({
      ...single,
      faces: [face({ status: "confirmed" })],
    });
    expect(item(empty, "Accept all pending")!.disabled).toBe(true);
  });

  it("'Select all' greys on an empty image, 'Clear' on an empty selection", () => {
    const g = thumbMenuGroups(single);
    expect(item(g, "Select all")!.disabled).toBe(true);
    const withFaces = thumbMenuGroups({
      ...single,
      faces: [face()],
      sel: new Set<number>(),
    });
    expect(item(withFaces, "Select all")!.disabled).toBe(false);
    expect(item(withFaces, "Clear selection")!.disabled).toBe(true);
  });
});

describe("imageAreaMenuGroups", () => {
  it("greys 'Select all faces' on an image without faces; wires the image id", () => {
    let rotated: [number, number] | null = null;
    const inp: ImageAreaMenuInput = {
      imageId: 42,
      faces: [],
      openInViewer: noOp,
      rotateImage: (id, delta) => { rotated = [id, delta]; },
      changeSel: noOp,
    };
    const g = imageAreaMenuGroups(inp);
    expect(item(g, "Select all faces")!.disabled).toBe(true);
    item(g, "Rotate 90° CCW")!.onClick();
    expect(rotated).toEqual([42, -90]);
    const withFaces = imageAreaMenuGroups({ ...inp, faces: [face()] });
    expect(item(withFaces, "Select all faces")!.disabled).toBe(false);
  });
});
