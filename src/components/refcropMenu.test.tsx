// v14.0 (#288) — the person detail pane's reference images (refcrops)
// are interactive: the row's context menu (Select in grid, Open full
// image, Open roll, Open roll path, Remove reference face) and the
// double-click's Select. The open routes are gated like the centre
// image's menu (#272/#274): greyed while the image has no roll.
// Run: npm test (vitest run; jsdom pragma).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// the crop loader would hit the Tauri IPC in jsdom — stub it (the
// loading placeholder is enough for the interaction under test)
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, facePreview: async () => null };
});

import DetailPane from "./DetailPane";
import type {
  Face,
  ImageRow,
  Person,
  Refcrop,
  Settings,
  Snapshot,
} from "../api";

afterEach(cleanup);

const PERSON: Person = {
  id: 1,
  name: "jane doe",
  state: "scanned",
  note: null,
  primary_face_id: null,
  primary_pinned: 0,
  created_at: "2026-01-01T00:00:00",
  groups: [],
  counts: { total: 2, provisional: 0, confirmed: 2, rejected: 0 },
};

const face = (id: number, imageId: number): Face => ({
  id,
  image_id: imageId,
  person_id: 1,
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  name: "f",
  seq: 1,
  description: null,
  confidence: 0.9,
  link_status: "confirmed",
  state: "imported",
  rotation: 0,
  import_id: 7,
  created_at: "2026-01-01T00:00:00",
});

const image = (id: number, lastImportId: number | null): ImageRow => ({
  id,
  primary_path: `/p/${id}.jpg`,
  width: 1,
  height: 1,
  orientation: null,
  rotation: 0,
  rtype: null,
  state: "imported",
  first_import_id: lastImportId,
  last_import_id: lastImportId,
});

// face 10 → image 5 (imported), face 11 → image 6 (never imported)
const SNAP: Snapshot = {
  version: 1,
  persons: [PERSON],
  faces: [face(10, 5), face(11, 6)],
  images: [image(5, 7), image(6, null)],
  imports: [],
  settings: {
    cluster_threshold: 0.5,
    refcrop_n: 5,
    face_filter: "all",
    cluster_group: "description",
    merge_name_distance: 2,
    merge_suffix_aliases: [],
    image_viewer: "",
    directory_viewer: "",
  } as Settings,
};

const REFCROPS: Refcrop[] = [
  { face_id: 10, seq: 1, description: "", pinned: false, filename: "jane-1.jpg" },
  { face_id: 11, seq: 1, description: "beard", pinned: false, filename: "jane-beard-1.jpg" },
];

const mount = (handlers: {
  onSelectRefcrop?: (id: number) => void;
  onRemoveRefcrop?: (id: number) => void;
  onOpenRefcropImage?: (id: number) => void;
  onOpenRefcropRoll?: (id: number) => void;
  onOpenRefcropRollPath?: (id: number) => void;
}) =>
  render(
    <DetailPane
      person={PERSON}
      refcrops={REFCROPS}
      snapshot={SNAP}
      faceFilter="all"
      onName={vi.fn()}
      onNote={vi.fn()}
      onOpenPrimary={vi.fn()}
      onRemoveRefcrop={handlers.onRemoveRefcrop ?? vi.fn()}
      onSelectRefcrop={handlers.onSelectRefcrop}
      onOpenRefcropImage={handlers.onOpenRefcropImage}
      onOpenRefcropRoll={handlers.onOpenRefcropRoll}
      onOpenRefcropRollPath={handlers.onOpenRefcropRollPath}
    />
  );

const menuItems = () =>
  [...document.querySelectorAll(".ctx-item")].map(
    (b) => `${b.textContent}::${(b as HTMLButtonElement).disabled}`
  );

describe("refcrop image context menu (v14.0, #288)", () => {
  it("right-click opens the five routes in order; the never-imported row greys the open routes", () => {
    mount({});
    fireEvent.contextMenu(screen.getByTitle("jane-1.jpg"));
    expect(menuItems()).toEqual([
      "Select in grid::false",
      "Open full image::false",
      "Open roll::false",
      "Open roll path::false",
      "Remove reference face::false",
    ]);
    cleanup();
    mount({});
    fireEvent.contextMenu(screen.getByTitle("jane-beard-1.jpg"));
    expect(menuItems()).toEqual([
      "Select in grid::false",
      "Open full image::false",
      "Open roll::true",
      "Open roll path::true",
      "Remove reference face::false",
    ]);
  });

  it("'Select in grid' fires the select route and closes the menu", () => {
    const onSelectRefcrop = vi.fn();
    mount({ onSelectRefcrop });
    fireEvent.contextMenu(screen.getByTitle("jane-1.jpg"));
    const select = [...document.querySelectorAll(".ctx-item")].find(
      (b) => b.textContent === "Select in grid"
    )!;
    fireEvent.click(select);
    expect(onSelectRefcrop).toHaveBeenCalledWith(10);
    expect(document.querySelector(".ctx-menu")).toBeNull();
  });

  it("'Remove reference face' fires the existing × action and closes the menu", () => {
    const onRemoveRefcrop = vi.fn();
    mount({ onRemoveRefcrop });
    fireEvent.contextMenu(screen.getByTitle("jane-beard-1.jpg"));
    const remove = [...document.querySelectorAll(".ctx-item")].find(
      (b) => b.textContent === "Remove reference face"
    )!;
    fireEvent.click(remove);
    expect(onRemoveRefcrop).toHaveBeenCalledWith(11);
    expect(document.querySelector(".ctx-menu")).toBeNull();
  });

  it("the open routes fire for an imported row", () => {
    const onOpenRefcropImage = vi.fn();
    const onOpenRefcropRoll = vi.fn();
    const onOpenRefcropRollPath = vi.fn();
    mount({ onOpenRefcropImage, onOpenRefcropRoll, onOpenRefcropRollPath });
    fireEvent.contextMenu(screen.getByTitle("jane-1.jpg"));
    const click = (label: string) =>
      fireEvent.click(
        [...document.querySelectorAll(".ctx-item")].find(
          (b) => b.textContent === label
        )!
      );
    fireEvent.contextMenu(screen.getByTitle("jane-1.jpg"));
    click("Open full image");
    fireEvent.contextMenu(screen.getByTitle("jane-1.jpg"));
    click("Open roll");
    fireEvent.contextMenu(screen.getByTitle("jane-1.jpg"));
    click("Open roll path");
    expect(onOpenRefcropImage).toHaveBeenCalledWith(10);
    expect(onOpenRefcropRoll).toHaveBeenCalledWith(10);
    expect(onOpenRefcropRollPath).toHaveBeenCalledWith(10);
  });

  it("the double-click runs the same Select", () => {
    const onSelectRefcrop = vi.fn();
    mount({ onSelectRefcrop });
    fireEvent.doubleClick(screen.getByTitle("jane-beard-1.jpg"));
    expect(onSelectRefcrop).toHaveBeenCalledWith(11);
  });
});
