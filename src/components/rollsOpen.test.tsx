// #265 — the Rolls tree's open state is session state owned by App: the
// pane renders it from props (opening a roll's grid unmounts the pane;
// returning must show the tree the way it was) and a header toggle
// reports the '/'-joined segment path.
// Run: npm test (vitest run; jsdom pragma — a mounted component)
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import RollsPane from "./RollsPane";
import type { Face, ImageRow } from "../api";

afterEach(cleanup);

const image = (id: number, primary_path: string): ImageRow => ({
  id,
  primary_path,
  width: 100,
  height: 100,
  orientation: null,
  rotation: 0,
  rtype: null,
  state: "created",
  first_import_id: null,
  last_import_id: null,
});

const face = (id: number, image_id: number): Face => ({
  id,
  image_id,
  person_id: 1,
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  name: "face",
  seq: 1,
  description: null,
  confidence: 0.9,
  link_status: "provisional",
  state: "imported",
  rotation: 0,
  import_id: null,
  created_at: "2026-01-01T00:00:00Z",
});

const images = [
  image(1, "/a/photo1.jpg"),
  image(2, "/a/sub/photo2.jpg"),
  image(3, "/b/photo3.jpg"),
];
const faces = [face(1, 1), face(2, 2), face(3, 3)];

const renderRolls = (openSet: Set<string>, onToggle: (p: string) => void) =>
  render(
    <RollsPane
      images={images}
      faces={faces}
      faceFilter="all"
      root="/"
      onRootChange={() => {}}
      onOpenImage={() => {}}
      selected=""
      onSelect={() => {}}
      openSet={openSet}
      onToggle={onToggle}
      onImportDir={() => {}}
    />
  );

describe("Rolls tree open state (#265)", () => {
  it("renders the openSet — a remembered branch stays expanded", () => {
    // the keys are '/'-joined RELATIVE segment paths ("a", "a/sub")
    const { container } = renderRolls(new Set(["a"]), () => {});
    const a = container.querySelector<HTMLElement>('[data-path="/a"]')!;
    expect(a.getAttribute("aria-expanded")).toBe("true");
    // the child branch is visible because /a is open
    expect(container.querySelector<HTMLElement>('[data-path="/a/sub"]')).not.toBeNull();
  });

  it("a header toggle reports the segment path (App owns the set)", () => {
    const onToggle = vi.fn();
    const { container } = renderRolls(new Set(), onToggle);
    fireEvent.click(container.querySelector<HTMLElement>('[data-path="/b"]')!);
    expect(onToggle).toHaveBeenCalledWith("b");
  });
});
