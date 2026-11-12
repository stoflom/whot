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
  /** #272: the images of the branch that have a roll (id →
      last_import_id) — the never-imported ones are skipped */
  rollImport: ReadonlyMap<number, number>;
  /** #272 (gui-design v11.1): the image's own directory (parent of
      primary_path — recursive roll imports place it below the roll
      root) in the file manager (#144) */
  openRollPath: (imageId: number) => void;
  doAccept: (ids: number[]) => void;
  changeSel: (next: Set<number>) => void;
}

export function thumbMenuGroups(inp: ThumbMenuInput): MenuGroup[] {
  const { image, imgSel, inBranch } = inp;
  // #174 (§4.39): the right-pane thumbnails own this menu — scope is
  // the selection when the invoked thumb is part of it, else just
  // that thumb (§4.14); stale ids (outside the branch) are dropped
  const scope = imageScope(imgSel, inBranch, image.id);
  // #272: the scope images that actually have a roll, in scope order
  const rollOpen = scope.filter((id) => inp.rollImport.has(id));
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
        {
          // #272 (gui-design v11.1): each image's own directory in the
          // file manager (a recursive roll import puts it in a
          // subdirectory below the roll root) — never-imported images
          // skip, so the (N) suffix counts the images that actually
          // open (zero = greyed out)
          label: rollOpen.length > 1 ? `Open roll path (${rollOpen.length})` : "Open roll path",
          disabled: rollOpen.length === 0,
          onClick: () => {
            for (const id of rollOpen) inp.openRollPath(id);
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
  /** #272: the image's importing roll (last_import_id), or null when
      never imported — the entry stays greyed out */
  rollImportId: number | null;
  /** #274: Rolls mode with the tree opened + the image's branch
      selected (view-context change, #123) */
  openRoll: (imageId: number) => void;
  /** #272 (gui-design v11.1): the image's own directory (parent of
      primary_path) in the file manager (#144) */
  openRollPath: (imageId: number) => void;
  /** #122: the stored display rotation (EXIF key, #118) */
  rotateImage: (imageId: number, delta: number) => void;
  /** #298 (rule 51): the annotated-image export dialog (the image's
      row — the dialog's faces are the §4.10 visible pass) */
  exportAnnotated: (imageId: number) => void;
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
          // #274: Rolls mode with the path tree opened and selected at
          // the image's own branch (the §4.22 dir-of-primary_path rule)
          // — greyed out while the image was never imported
          label: "Open roll",
          disabled: inp.rollImportId == null,
          onClick: () => {
            if (inp.rollImportId != null) inp.openRoll(inp.imageId);
          },
        },
        {
          // #272 (gui-design v11.1): the image's own directory in the
          // file manager (a recursive roll import puts it in a
          // subdirectory below the roll root) — greyed out while the
          // image was never imported
          label: "Open roll path",
          disabled: inp.rollImportId == null,
          onClick: () => {
            if (inp.rollImportId != null) inp.openRollPath(inp.imageId);
          },
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
          // #298 (rule 51): the annotated composite — the same
          // overlay the viewer shows, saved to a chosen path
          label: "Export annotated image…",
          onClick: () => inp.exportAnnotated(inp.imageId),
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

// -------------------------------------------------------- roll branch

// v12.4 (#280): the roll-branch header context menu — the pane's
// branch-scoped actions that are not the header's own toggle+select
// click; v12.5 (#284) adds the branch's open routes (Open roll, Open
// roll path). Pure like every builder here: the caller resolves the
// live per-branch recursive state at event time.
export interface RollBranchMenuInput {
  /** the branch's absolute path (labels only — the actions are closures) */
  path: string;
  /** v12.5 (#284): select the branch (its grid lands in the right
      pane, §4.39) and add it to the open-set when closed — a menu
      entry named *Open* never collapses an open branch the way the
      header's toggle can */
  onOpenRoll: (path: string) => void;
  /** v12.5 (#284): the branch's own directory in the file manager
      (#144) — unconditionally enabled, the action targets the branch
      itself (a visible branch may hold no direct listing image) */
  onOpenRollPath: (path: string) => void;
  /** §4.36 re-import route: open the import pane, Re-import pre-checked */
  onReimport: (path: string) => void;
  /** §4.39: the branch's recursive grid state (☐ unticked / ☑ ticked) */
  recursive: boolean;
  onToggleRecursive: (path: string) => void;
}

export function rollBranchMenuGroups(inp: RollBranchMenuInput): MenuGroup[] {
  return [
    {
      title: inp.path,
      items: [
        {
          // v12.5 (#284): the branch's open route — the same end state
          // as the header click's select, plus the open-set entry when
          // closed (never a collapse)
          label: "Open roll",
          onClick: () => inp.onOpenRoll(inp.path),
        },
        {
          // v12.5 (#284): the branch's own directory in the file
          // manager — always enabled (the branch is its own target)
          label: "Open roll path",
          onClick: () => inp.onOpenRollPath(inp.path),
        },
        {
          // §4.36 branch route — every tree branch holds ≥ 1 imported
          // image, so this is always a genuine RE-import
          label: "Re-import…",
          onClick: () => inp.onReimport(inp.path),
        },
        {
          label: `${inp.recursive ? "☑" : "☐"} Include sub-branch images`,
          onClick: () => inp.onToggleRecursive(inp.path),
        },
      ],
    },
  ];
}

// -------------------------------------------------------- refcrop image

// v14.0 (#288): the person detail pane's reference-image (refcrop)
// context menu — the row's own actions plus the face's image routes.
// Pure like every builder here: the caller resolves the live per-face
// state (image existence, roll import) at event time.
export interface RefcropMenuInput {
  /** the face is still in the snapshot (defensive — a stale row has
      no image routes) */
  faceKnown: boolean;
  /** the face's image has a roll (last_import_id != null) — the open
      routes stay greyed out while it doesn't (the image menu's gating,
      #272/#274) */
  imported: boolean;
  /** dbl-click's action: the face selected in the centre grid
      (filter-switched if hidden) and scrolled into view */
  onSelect: () => void;
  /** the row's ✕ button action (v14.1: × retired) */
  onRemove: () => void;
  /** the face's image in full-image focus mode */
  onOpenImage: () => void;
  /** Rolls mode with the tree opened at the image's branch */
  onOpenRoll: () => void;
  /** the image's own directory in the file manager */
  onOpenRollPath: () => void;
}

export function refcropMenuGroups(inp: RefcropMenuInput): MenuGroup[] {
  return [
    {
      items: [
        {
          // v14.0 (#288): single-select semantics (a card click) + the
          // grow-then-scroll; the double-click runs the same action
          label: "Select in grid",
          onClick: inp.onSelect,
          disabled: !inp.faceKnown,
        },
        {
          label: "Open full image",
          onClick: inp.onOpenImage,
          disabled: !inp.faceKnown,
        },
        {
          label: "Open roll",
          disabled: !inp.faceKnown || !inp.imported,
          onClick: () => {
            if (inp.faceKnown && inp.imported) inp.onOpenRoll();
          },
        },
        {
          label: "Open roll path",
          disabled: !inp.faceKnown || !inp.imported,
          onClick: () => {
            if (inp.faceKnown && inp.imported) inp.onOpenRollPath();
          },
        },
      ],
    },
    {
      items: [
        {
          label: "Remove reference face",
          danger: true,
          onClick: inp.onRemove,
        },
      ],
    },
  ];
}
