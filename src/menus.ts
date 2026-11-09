// §4.44 (gui-design v3.94, #206 stage 4) — the context-menu compositions
// as PURE functions returning MenuGroup[]: the face card menu (#32,
// §4.14/§4.24), the right-pane thumbnail menu (§4.39) and the
// full-image surface menu. The caller resolves the live values
// (selection/sections at event time through App's refs — the #98
// identity rule) and performs the opening (openMenu); everything below
// only COMPOSES — no state, no DOM access. The disabled/danger rules
// are unit-pinned in menus.test.ts.

import type { Face, ImageRow } from "./api";
import type { MenuGroup } from "./components/ContextMenu";
import type { Section } from "./components/FaceGrid";
import type { ImageSel } from "./imageSelect";
import { imageScope } from "./imageSelect";
import type { StageScope } from "./stage";

// ---------------------------------------------------------------- face

export interface FaceMenuInput {
  /** the right-clicked face's id */
  id: number;
  /** the right-clicked face (resolved; the caller returns early on none) */
  face: Face;
  /** the live selection at event time */
  sel: ReadonlySet<number>;
  /** #49 (§4.14): the effective action scope — the selection when the
      card is part of it, elsewhere just the card (App's resolver) */
  actionScope: (id: number) => number[];
  /** the face's section, or null when none (#68: select-all needs it) */
  section: Section | null;
  facesById: Map<number, Face>;
  toggle: (id: number) => void;
  toggleMany: (ids: number[], on: boolean) => void;
  doAccept: (ids: number[]) => void;
  doReject: (ids: number[]) => void;
  doPrimary: (id: number) => void;
  doRefcrop: (id: number) => void;
  /** #122: crop display rotation — per face, independent of the image */
  rotateFace: (id: number, delta: number) => void;
  changeSel: (next: Set<number>) => void;
  openEdit: (defaultScope: StageScope, target: { card: number }) => void;
  /** #123/#171: the focus-open is a view-context change; the right pane
      follows the opening face's person */
  openFullImage: (face: Face) => void;
  /** #184 (§4.18): 'Add group…' files the distinct OWNED persons */
  addFaceGroup: (ids: number[]) => void;
  /** the image already open in the split, or null (#51) */
  splitImageId: number | null;
}

export function faceMenuGroups(inp: FaceMenuInput): MenuGroup[] {
  const { id, face: f, sel, section, facesById } = inp;
  // #49: actions hit the whole selection when this card is part of it
  const scope = inp.actionScope(id);
  const multi = scope.length > 1;
  const label = (s: string) => (multi ? `${s} (${scope.length} selected)` : s);
  // #184 (§4.18): the distinct OWNED persons of the effective scope —
  // the Add group… entry files them all (unowned faces count nothing)
  const groupIds = [
    ...new Set(
      scope.map((sid) => facesById.get(sid)?.person_id).filter((p): p is number => p != null)
    ),
  ];
  return [
    {
      title: "Selection",
      items: [
        {
          // an empty selection just auto-selected this card (#75)
          label: sel.has(id) || sel.size === 0 ? "Deselect" : "Select",
          hint: "Space",
          onClick: () => inp.toggle(id),
        },
        {
          label: "Select whole section",
          hint: "Ctrl-G", // #68: advertise the existing shortcut (#53)
          onClick: () => section && inp.toggleMany(section.faceIds, true),
          disabled: !section,
        },
        { label: "Clear selection", onClick: () => inp.changeSel(new Set()), disabled: sel.size === 0 },
      ],
    },
    {
      title: multi ? `Face — ${scope.length} selected` : "Face",
      items: [
        {
          label: label("Accept"),
          hint: "A",
          onClick: () => inp.doAccept(scope),
        },
        {
          label: label("Reject"),
          hint: "R",
          onClick: () => inp.doReject(scope),
          // reject stays offered while any face of the scope is not rejected
          disabled: !scope.some((sid) => facesById.get(sid)?.link_status !== "rejected"),
          danger: true,
        },
        {
          label: "Set as primary",
          onClick: () => inp.doPrimary(id),
          // single-face action (#49): greyed out for a multi-scope
          disabled: f.person_id == null || multi,
        },
        {
          label: "Add as reference",
          onClick: () => inp.doRefcrop(id),
          disabled: f.link_status !== "confirmed" || f.person_id == null || multi,
        },
        // #122: crop display rotation — per face, independent of the
        // full-image rotation
        {
          label: label("Rotate crop 90° CW"),
          onClick: () => inp.rotateFace(id, 90),
          disabled: multi,
        },
        {
          label: label("Rotate crop 90° CCW"),
          onClick: () => inp.rotateFace(id, -90),
          disabled: multi,
        },
        // #184 (§4.18/#164): file every DISTINCT person of the scope —
        // the same GroupDialog + add semantics as the tree's rows
        {
          label:
            groupIds.length > 1
              ? `Add group to ${groupIds.length} persons…`
              : "Add group…",
          onClick: () => inp.addFaceGroup(groupIds),
          disabled: groupIds.length === 0,
        },
        // #180/§4.24: ONE label — 'Edit…' — for every dialog opener
        { label: label("Edit…"), onClick: () => inp.openEdit(scope.length > 1 ? "selection" : "card", { card: id }) },
        // #51: pointless while this very image is already open in the split
        ...(f.image_id === inp.splitImageId
          ? []
          : [{
              // #123: opening focus mode is a view-context change;
              // #171/§4.37: the right pane follows the opening face's person
              label: "Open full image",
              // #182/§4.14: focus mode shows one image — disabled for
              // a multi-scope like its primary/reference/crop siblings
              disabled: multi,
              onClick: () => inp.openFullImage(f),
            }]),
      ],
    },
  ];
}

// ------------------------------------------------------------ thumbnails

export interface ThumbMenuInput {
  /** the invoked thumb — one thumb out of a multi-scope is refused */
  image: ImageRow;
  /** the right-pane selection (§4.23) */
  imgSel: ImageSel;
  /** the thumbs present in the branch — stale ids drop (§4.39) */
  inBranch: ReadonlySet<number>;
  /** the invoked image's visible faces (§4.10 pass done by the caller) */
  faces: Face[];
  sel: ReadonlySet<number>;
  /** the #142 full view-context open (confirmContext-wrapped) */
  openImageInView: (imageId: number) => void;
  /** #122/§4.39: one command per image of the scope, in order */
  rotateImages: (ids: number[], delta: number) => void;
  /** the system viewer — rejections reach the error toast (#144) */
  openInViewer: (imageId: number) => void;
  doAccept: (ids: number[]) => void;
  changeSel: (next: Set<number>) => void;
}

export function thumbMenuGroups(inp: ThumbMenuInput): MenuGroup[] {
  const { image, imgSel, inBranch } = inp;
  // #174 (§4.39): the right-pane thumbnails own this menu — scope is
  // the selection when the invoked thumb is part of it, else just
  // that thumb (§4.14); stale ids (outside the branch) are dropped
  const scope = imageScope(imgSel, inBranch, image.id);
  const many = scope.length > 1;
  const faces = inp.faces;
  const pending = faces.filter((f) => f.link_status === "provisional").map((f) => f.id);
  return [
    {
      items: [
        {
          // #123 + #142: opening an image is a full view-context change
          // (the centre pane rebinds to that image's faces) and honours
          // the drop-or-accept dialog exactly like the focused-open
          // entry just below — it never silently carries a staged set
          label: "Open image",
          // #182/§4.14: one-image-only — never silently the invoked
          // thumb out of a multi-scope
          disabled: many,
          onClick: () => inp.openImageInView(image.id),
        },
        // #122: stored display rotation (EXIF key, #118) — over the
        // whole scope (#174/§4.39), one command each in order
        {
          label: many ? `Rotate 90° CW (${scope.length})` : "Rotate 90° CW",
          onClick: () => inp.rotateImages(scope, 90),
        },
        {
          label: many ? `Rotate 90° CCW (${scope.length})` : "Rotate 90° CCW",
          onClick: () => inp.rotateImages(scope, -90),
        },
        {
          // #144: rejections (no preview blob, viewer not found) reach
          // the error toast; one temp file per image of the scope
          label: many ? `Open in system viewer (${scope.length})` : "Open in system viewer",
          onClick: () => {
            for (const id of scope) inp.openInViewer(id);
          },
        },
      ],
    },
    {
      title: "Faces of this image",
      items: [
        {
          label: "Select all",
          onClick: () => inp.changeSel(new Set(faces.map((f) => f.id))),
          disabled: faces.length === 0,
        },
        { label: "Clear selection", onClick: () => inp.changeSel(new Set()), disabled: inp.sel.size === 0 },
        {
          label: "Accept all pending",
          onClick: () => inp.doAccept(pending),
          disabled: pending.length === 0,
        },
      ],
    },
  ];
}

// ------------------------------------------------------- image surface

export interface ImageAreaMenuInput {
  /** the invoked image (one row; a selection-free surface menu) */
  imageId: number;
  /** the image's visible faces (§4.10 pass done by the caller) */
  faces: Face[];
  /** the system viewer (#144) */
  openInViewer: (imageId: number) => void;
  /** #122: the stored display rotation (EXIF key, #118) */
  rotateImage: (imageId: number, delta: number) => void;
  changeSel: (next: Set<number>) => void;
}

export function imageAreaMenuGroups(inp: ImageAreaMenuInput): MenuGroup[] {
  const faces = inp.faces;
  return [
    {
      items: [
        {
          // #144: a rejection (no preview blob, viewer not found) never
          // dangers silently — errors reach the error toast (#132)
          label: "Open in system viewer",
          onClick: () => inp.openInViewer(inp.imageId),
        },
        {
          // #122: stored display rotation (EXIF key, #118)
          label: "Rotate 90° CW",
          onClick: () => inp.rotateImage(inp.imageId, 90),
        },
        {
          label: "Rotate 90° CCW",
          onClick: () => inp.rotateImage(inp.imageId, -90),
        },
        {
          label: "Select all faces",
          onClick: () => inp.changeSel(new Set(faces.map((f) => f.id))),
          disabled: faces.length === 0,
        },
      ],
    },
  ];
}
