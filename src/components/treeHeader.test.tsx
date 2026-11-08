// #261 (gui-design 6.1) — the left-pane top bar re-org: the header is
// two rows — row 1 the person filter (search) input filling the row's
// width with a Clear (✕) button at its right end; row 2 the ⌃/⌄ roll
// controls and the *Merge Similar* button. The old *Review — N pending*
// button is gone (the top bar's status totals beside the lock, §4.41,
// show the pending count). Clearing the filter is available as the ✕
// button *and* as a *Clear* entry in the input's context menu.
// Run: npm test (vitest run; jsdom pragma — a mounted component)
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// no vitest globals here — unmount between tests explicitly
afterEach(cleanup);
import PersonTree from "./PersonTree";
import type { Person } from "../api";
import type { TreeNode } from "../treeIndex";

// jsdom does not implement scrollIntoView — stub it for the whole suite.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

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

const tree: TreeNode = { name: "", personIds: [1], children: [] };

const renderTree = (filter = "", onFilter: (v: string) => void = vi.fn()) =>
  render(
    <PersonTree
      tree={tree}
      persons={[person(1, "Alice")]}
      selectedId={1}
      filter={filter}
      onFilter={onFilter}
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

describe("left-pane top bar (#261, gui-design 6.0)", () => {
  it("renders two rows: search + ✕ on top, roll controls + Merge below", () => {
    renderTree();
    const tools = document.querySelector(".tree-tools")!;
    const rows = Array.from(tools.children) as HTMLElement[];
    expect(rows.map((r) => r.className)).toEqual(["tree-filter-row", "tree-actions-row"]);
    const row1 = Array.from(rows[0].children) as HTMLElement[];
    const row2 = Array.from(rows[1].children) as HTMLElement[];
    expect(row1.map((k) => k.tagName)).toEqual(["INPUT", "BUTTON"]);
    expect((row1[0] as HTMLInputElement).placeholder).toBe("search persons…");
    expect(row1[1].textContent).toBe("✕");
    expect(row2.map((k) => k.textContent)).toEqual(["⌃", "⌄", "⧉ merge similar"]);
  });

  it("no longer renders the *Review — N pending* button", () => {
    renderTree();
    expect(screen.queryByText(/Review — /)).toBeNull();
  });

  it("the ✕ is disabled while the filter is empty", () => {
    renderTree("");
    const clear = screen.getByTitle("Clear the search filter") as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
  });

  it("the ✕ clears a non-empty filter", () => {
    const onFilter = vi.fn();
    renderTree("al", onFilter);
    const clear = screen.getByTitle("Clear the search filter") as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);
    expect(onFilter).toHaveBeenCalledWith("");
  });

  it("the filter input's context menu offers *Clear* (disabled when empty)", () => {
    // empty filter → Clear entry is disabled
    renderTree("");
    fireEvent.contextMenu(screen.getByPlaceholderText("search persons…"));
    const clear = screen.getByText("Clear") as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
  });

  it("context-menu *Clear* clears a non-empty filter", () => {
    const onFilter = vi.fn();
    renderTree("al", onFilter);
    fireEvent.contextMenu(screen.getByPlaceholderText("search persons…"));
    const clear = screen.getByText("Clear") as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);
    expect(onFilter).toHaveBeenCalledWith("");
  });

  it("the ⌃ roll-up button stays disabled while a filter is active", () => {
    renderTree("al");
    const rollUp = document.querySelector(".tree-actions-row")!.children[0] as HTMLButtonElement;
    expect(rollUp.disabled).toBe(true);
  });
});
