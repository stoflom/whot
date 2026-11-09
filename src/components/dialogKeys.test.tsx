// #248 — the three dialogs that own the keyboard (useOwnsKeyboard) must
// each install their own window-level Escape listener: App's Esc stack
// bails out while ANY overlay owns the keyboard, so a dialog without its
// own listener makes Esc dead the moment focus leaves the inputs.
// ConfirmDialog / FaceMergeDialog / MergeIntoDialog already follow the
// idiom; this pins the three that were missing it, plus the SuggestInput
// combobox ARIA wiring that came with the same sweep.
// Run: npm test (vitest run; jsdom pragma — a mounted component with
// window listeners needs a DOM).
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import GroupDialog from "./GroupDialog";
import SettingsPopover from "./SettingsPopover";
import EditDialog from "./EditDialog";
import SuggestInput from "./SuggestInput";
import type { Prefill } from "../stage";

const esc = () => fireEvent.keyDown(window, { key: "Escape" });

describe("overlay Esc (#248) — the topmost overlay owns the keyboard", () => {
  it("GroupDialog: Esc cancels from the dialog body", () => {
    const onCancel = vi.fn();
    render(
      <GroupDialog
        title="Group"
        body="body"
        defaultPath="family"
        submitLabel="update"
        onSubmit={() => {}}
        onCancel={onCancel}
        options={[]}
      />
    );
    esc();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("SettingsPopover: Esc closes the popover", () => {
    const onClose = vi.fn();
    render(
      <SettingsPopover
        settings={{
          cluster_threshold: 0.4,
          refcrop_n: 5,
          face_filter: "all",
          cluster_group: "accuracy",
          merge_name_distance: 2,
          merge_suffix_aliases: [],
          image_viewer: "",
          directory_viewer: "",
        }}
        onSave={() => {}}
        onClose={onClose}
      />
    );
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("EditDialog: Esc cancels the staged edit", () => {
    const onCancel = vi.fn();
    const empty: Prefill = {};
    render(
      <EditDialog
        defaultScope="card"
        counts={{ card: 1, group: 1, selection: 0 }}
        rejected={{ card: false, group: false, selection: false }}
        prefills={{ card: empty, group: empty, selection: empty }}
        persons={[]}
        pathOptions={[]}
        descOptions={[]}
        onDone={() => {}}
        onReject={() => {}}
        onCancel={onCancel}
      />
    );
    esc();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("SuggestInput combobox ARIA (#248)", () => {
  const options = [
    { value: "family", hint: "New" },
    { value: "family|smiths", hint: "Accepted" },
  ];

  // a stateful wrapper — the input is controlled, so the test must
  // re-render with the new value for the matches to track
  const ControlledSuggest = () => {
    const [v, setV] = useState("");
    return <SuggestInput value={v} onChange={setV} options={options} />;
  };

  it("declares the combobox while closed, the expanded list while open", () => {
    const { container } = render(<ControlledSuggest />);
    const input = container.querySelector("input")!;
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    fireEvent.change(input, { target: { value: "f" } }); // opens the list
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const list = container.querySelector('[role="listbox"]')!;
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(
      Array.from(list.querySelectorAll('[role="option"]')).map((o) => o.id)
    ).toHaveLength(2);
  });

  it("tracks the highlighted option via aria-activedescendant", () => {
    const { container } = render(<ControlledSuggest />);
    const input = container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "f" } });
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const firstOption = container.querySelector('[role="option"]')!;
    expect(input.getAttribute("aria-activedescendant")).toBe(firstOption.id);
    // closing the list (Esc with the dropdown open) clears it
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });
});
