// #256 — the ONE shared "Add group" dialog (App's face menu + the
// tree's person rows): title/body/normalization live in one place. This
// pins both hosts' rendering contract — the title for 1 vs N persons,
// and the submit that normalizes (#42) before the host dispatches
// `addPersonsToGroup` / `onAddGroup`.
// Run: npm test (vitest run; jsdom pragma — a mounted dialog needs a DOM).
// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, cleanup } from "@testing-library/react";
import type { Person } from "../api";
import AddGroupDialog from "./AddGroupDialog";

const person = (id: number, name: string): Person => ({
  id,
  name,
  state: "ok",
  note: null,
  primary_face_id: null,
  primary_pinned: 0,
  created_at: "",
  groups: [],
  counts: { total: 0, provisional: 0, confirmed: 0, rejected: 0 },
});

const renderDialog = (props: {
  ids: number[];
  persons: Person[];
  onSubmit: (ids: number[], path: string) => void;
  onCancel: () => void;
}) =>
  render(
    <AddGroupDialog
      {...props}
      options={[{ value: "family|smiths" }, { value: "", label: "ungrouped" }]}
    />
  );

describe("AddGroupDialog (#256) — the shared add-group flow", () => {
  afterEach(cleanup);

  it("single person: the title names the person", () => {
    const onSubmit = vi.fn();
    const { getByRole } = renderDialog({
      ids: [7],
      persons: [person(7, "Smith")],
      onSubmit,
      onCancel: vi.fn(),
    });
    expect(getByRole("heading").textContent).toBe("Add a group to 'Smith'");
  });

  it("several persons: the title counts them", () => {
    const onSubmit = vi.fn();
    const { getByRole } = renderDialog({
      ids: [7, 8, 9],
      persons: [person(7, "Smith"), person(8, "A"), person(9, "B")],
      onSubmit,
      onCancel: vi.fn(),
    });
    expect(getByRole("heading").textContent).toBe("Add a group to 3 persons");
  });

  it("submit normalizes the typed path before the host dispatches (#42)", () => {
    const onSubmit = vi.fn();
    const { getByRole } = renderDialog({
      ids: [7],
      persons: [person(7, "Smith")],
      onSubmit,
      onCancel: vi.fn(),
    });
    const input = getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: " family | smiths  " } });
    fireEvent.click(getByRole("button", { name: "add group" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith([7], "family|smiths");
  });

  it("a whitespace-only path submits \"\" — the host closes silently (no IPC)", () => {
    const onSubmit = vi.fn();
    const { getByRole } = renderDialog({
      ids: [7],
      persons: [person(7, "Smith")],
      onSubmit,
      onCancel: vi.fn(),
    });
    const input = getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.click(getByRole("button", { name: "add group" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith([7], "");
  });

  it("cancel closes without submitting", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { getByRole } = renderDialog({
      ids: [7],
      persons: [person(7, "Smith")],
      onSubmit,
      onCancel,
    });
    fireEvent.click(getByRole("button", { name: "cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
