// #255 — keyboard accessibility for the three mouse-only controls: the
// PersonTree branch nodes + person rows and the RollsPane branch headers
// each now speak the APG tree pattern (role / aria / roving tabindex) and
// mark themselves `data-owns-keys` so App's global arrow-step guard bails
// out while one is focused. The App pane dividers ride on the same
// `data-owns-keys` attribute + the same APG keys, so they are covered by
// the same contract. This pins the DOM-level wiring on the two
// self-contained panes (the full App is Tauri-dependent and not mounted
// in tests).
// Run: npm test (vitest run; jsdom pragma — a mounted component with key
// handlers needs a DOM).
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import PersonTree from "./PersonTree";
import RollsPane from "./RollsPane";
import type { Face, ImageRow, Person } from "../api";
import type { TreeNode } from "../treeIndex";

// jsdom does not implement scrollIntoView — the APG handlers call it to
// keep the focused item in view, so stub it out for the whole suite.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------- fixtures

const person = (id: number, name: string, groups: string[] = []): Person => ({
  id,
  name,
  state: "created",
  note: null,
  primary_face_id: null,
  primary_pinned: 0,
  created_at: "2026-01-01T00:00:00Z",
  groups,
  counts: { total: 1, provisional: 0, confirmed: 1, rejected: 0 },
});

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
  name: "p",
  seq: 1,
  description: null,
  confidence: 0.9,
  link_status: "confirmed",
  state: "created",
  rotation: 0,
  import_id: null,
  created_at: "2026-01-01T00:00:00Z",
});

const treeItems = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>("[data-tree-key]"));
const rollHeaders = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>("[role=\"treeitem\"].roll-header"));

// ----------------------------------------------------------------- PersonTree

describe("PersonTree APG tree (#255)", () => {
  const tree: TreeNode = {
    name: "",
    personIds: [],
    children: [
      {
        name: "Family",
        personIds: [1],
        children: [{ name: "Kids", personIds: [2], children: [] }],
      },
    ],
  };
  const persons = [person(1, "Alice", ["Family"]), person(2, "Bob", ["Family|Kids"])];

  const renderTree = () =>
    render(
      <PersonTree
        tree={tree}
        persons={persons}
        selectedId={1}
        reviewCount={0}
        filter=""
        onFilter={() => {}}
        onReview={() => {}}
        onSelect={() => {}}
        selectedIds={new Set()}
        onRename={() => {}}
        onRemovePersons={() => {}}
        onRenameGroup={() => {}}
        onDeleteGroup={() => {}}
        onMovePersons={() => {}}
        onAddGroup={() => {}}
        onOpenMerge={() => {}}
        onMergeInto={() => {}}
        primaryRot={new Map()}
      />
    );

  it("declares the tree, treeitems and exactly one tabbable item", () => {
    const { container } = renderTree();
    expect(container.querySelector('[role="tree"]')).not.toBeNull();

    const items = treeItems(container);
    // DOM order == display order: branch, its person, the nested branch, its person
    expect(items.map((el) => el.getAttribute("data-tree-key"))).toEqual([
      "b:Family",
      "p:1",
      "b:Family/Kids",
      "p:2",
    ]);
    // every item is a treeitem that owns its keys
    for (const el of items) {
      expect(el.getAttribute("role")).toBe("treeitem");
      expect(el.hasAttribute("data-owns-keys")).toBe(true);
    }
    // roving tabindex: exactly one tabbable, seeded on the first item
    const tabbable = items.filter((el) => el.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].getAttribute("data-tree-key")).toBe("b:Family");
  });

  it("exposes aria-expanded on branches and aria-selected on the selected row", () => {
    const { container } = renderTree();
    const fam = container.querySelector<HTMLElement>('[data-tree-key="b:Family"]')!;
    const alice = container.querySelector<HTMLElement>('[data-tree-key="p:1"]')!;
    const bob = container.querySelector<HTMLElement>('[data-tree-key="p:2"]')!;
    expect(fam.getAttribute("aria-expanded")).toBe("true"); // open by default
    expect(alice.getAttribute("aria-selected")).toBe("true"); // selectedId=1
    expect(bob.getAttribute("aria-selected")).toBe("false");
  });

  it("Enter on a focused branch toggles it; ArrowDown moves focus to the next item", () => {
    const { container } = renderTree();
    const fam = container.querySelector<HTMLElement>('[data-tree-key="b:Family"]')!;
    fam.focus();
    // Enter collapses the branch (aria-expanded flips)
    fireEvent.keyDown(fam, { key: "Enter" });
    expect(fam.getAttribute("aria-expanded")).toBe("false");
    // ArrowDown from the branch lands on its first person row
    fam.focus();
    fireEvent.keyDown(fam, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).getAttribute("data-tree-key")).toBe(
      "p:1"
    );
  });
});

// ------------------------------------------------------------------- RollsPane

describe("RollsPane APG tree (#255)", () => {
  const images = [
    image(1, "/a/photo1.jpg"),
    image(2, "/a/sub/photo2.jpg"),
    image(3, "/b/photo3.jpg"),
  ];
  const faces = [face(1, 1), face(2, 2), face(3, 3)];

  const renderRolls = (onSelect: (path: string) => void) =>
    render(
      <RollsPane
        images={images}
        faces={faces}
        faceFilter="all"
        root="/"
        onRootChange={() => {}}
        onOpenImage={() => {}}
        selected=""
        onSelect={onSelect}
        onImportDir={() => {}}
      />
    );

  it("declares the tree, treeitem headers and exactly one tabbable header", () => {
    const { container } = renderRolls(() => {});
    expect(container.querySelector('[role="tree"]')).not.toBeNull();

    const headers = rollHeaders(container);
    // collapsed by default: only the two top-level branches render
    expect(headers.map((el) => el.getAttribute("data-path"))).toEqual(["/a", "/b"]);
    for (const el of headers) {
      expect(el.getAttribute("role")).toBe("treeitem");
      expect(el.hasAttribute("data-owns-keys")).toBe(true);
      expect(el.getAttribute("aria-expanded")).toBe("false");
    }
    const tabbable = headers.filter((el) => el.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].getAttribute("data-path")).toBe("/a");
  });

  it("Enter on a focused header selects it; ArrowDown moves focus to the next header", () => {
    const onSelect = vi.fn();
    const { container } = renderRolls(onSelect);
    const a = container.querySelector<HTMLElement>('[data-path="/a"]')!;
    a.focus();
    fireEvent.keyDown(a, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("/a");
    // ArrowDown from /a lands on /b
    a.focus();
    fireEvent.keyDown(a, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).getAttribute("data-path")).toBe("/b");
  });
});
