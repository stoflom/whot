// #307 (v19.0) follow-up — the blur-proof commit buttons (dialog Accept,
// pane "Update person") never blur the focused field, so the group list's
// pending drafts (the add row, an inline re-home) must be FLUSHED into
// the staged ops before the commit — clicking Accept acts as if Enter
// had been pressed in the focused field first (§4.38's Enter-in-add).
// The flush reads each draft's LIVE DOM value (an engine-lost input
// event must not drop the typed path — the same rule the four value
// fields follow).
// Run: npm test (vitest run; jsdom pragma — a mounted component)
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import EditDialog, { type EditResult } from "./EditDialog";
import DetailPane from "./DetailPane";
import type { Prefill } from "../stage";
import type { Person, Refcrop, Snapshot } from "../api";

afterEach(cleanup);

const person = (id: number, name: string, groups: string[]): Person => ({
  id,
  name,
  state: "ok",
  note: null,
  primary_face_id: null,
  primary_pinned: 0,
  created_at: "2026-01-01T00:00:00",
  groups,
  counts: { total: 1, provisional: 1, confirmed: 0, rejected: 0 },
});

const ALICE = person(7, "Alice", ["family"]);

const renderDialog = (onDone: (r: EditResult) => void) =>
  render(
    <EditDialog
      defaultScope="selection"
      counts={{ card: 0, group: 0, selection: 1 }}
      rejected={{ card: false, group: false, selection: false }}
      prefills={
        { selection: { name: "Alice" }, card: {}, group: {} } as Record<
          string,
          Prefill
        >
      }
      persons={[ALICE]}
      pathOptions={[]}
      descOptions={[]}
      onDone={onDone}
      onReject={() => {}}
      onCancel={() => {}}
    />
  );

const actionBtn = (label: string): HTMLElement => {
  const b = [...document.querySelectorAll(".edit-dialog .dialog-actions button")].find(
    (x) => x.textContent === label
  );
  if (!b) throw new Error(`no ${label} button`);
  return b as HTMLElement;
};

const addInput = (): HTMLInputElement =>
  document.querySelector(".dp-add-group input") as HTMLInputElement;

describe("Edit dialog: Accept flushes the group list's pending drafts (#307)", () => {
  it("a typed-but-unstaged add-row entry stages and commits with Accept", () => {
    const onDone = vi.fn();
    renderDialog(onDone);
    expect(addInput()).toBeTruthy(); // the known name fronts the group list
    fireEvent.change(addInput(), { target: { value: "family|smiths" } });
    fireEvent.click(actionBtn("Accept"));
    expect(onDone).toHaveBeenCalledTimes(1);
    const r = onDone.mock.calls[0][0] as EditResult;
    expect(r.groupOps).toEqual([{ from: "", to: "family|smiths" }]);
  });

  it("an engine-lost input event still commits: the flush reads the add row's LIVE DOM value", () => {
    const onDone = vi.fn();
    renderDialog(onDone);
    // set the DOM value WITHOUT firing a change event — React's state
    // never saw it, the flush must take the DOM's word
    const el = addInput();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    setter.call(el, "family|smiths");
    fireEvent.click(actionBtn("Accept"));
    const r = onDone.mock.calls[0][0] as EditResult;
    expect(r.groupOps).toEqual([{ from: "", to: "family|smiths" }]);
  });

  it("a pending inline re-home draft stages with Accept too", () => {
    const onDone = vi.fn();
    renderDialog(onDone);
    fireEvent.click(
      document.querySelector(".dp-group-path") as HTMLElement // the "family" row
    );
    const editInput = document.querySelector(
      "input.dp-group-edit"
    ) as HTMLInputElement;
    expect(editInput).toBeTruthy();
    fireEvent.change(editInput, { target: { value: "kin" } });
    fireEvent.click(actionBtn("Accept"));
    const r = onDone.mock.calls[0][0] as EditResult;
    expect(r.groupOps).toEqual([{ from: "family", to: "kin" }]);
  });

  it("nothing pending → the flush changes nothing (groupOps pass through)", () => {
    const onDone = vi.fn();
    renderDialog(onDone);
    fireEvent.click(actionBtn("Accept"));
    const r = onDone.mock.calls[0][0] as EditResult;
    expect(r.groupOps).toEqual([]);
  });

  it("an invalid add path stays out of the commit (the informed no-op)", () => {
    const onDone = vi.fn();
    renderDialog(onDone);
    fireEvent.change(addInput(), { target: { value: "family|New" } }); // reserved segment
    fireEvent.click(actionBtn("Accept"));
    const r = onDone.mock.calls[0][0] as EditResult;
    expect(r.groupOps).toEqual([]);
  });
});

describe("the disambiguated field labels (#309, v19.1)", () => {
  it("the fields read 'Person group' and 'Face description' (the scope seg keeps 'Group')", () => {
    render(
      <EditDialog
        defaultScope="selection"
        counts={{ card: 0, group: 0, selection: 1 }}
        rejected={{ card: false, group: false, selection: false }}
        prefills={{ card: {}, group: {}, selection: {} }}
        persons={[]}
        pathOptions={[]}
        descOptions={[]}
        onDone={() => {}}
        onReject={() => {}}
        onCancel={() => {}}
      />
    );
    const labels = [...document.querySelectorAll(".edit-dialog label")].map(
      (l) => l.firstChild?.textContent
    );
    expect(labels).toContain("Person group");
    expect(labels).toContain("Face description");
    expect(labels).not.toContain("Group");
    expect(labels).not.toContain("Description");
    // the scope selector keeps its plain wording (the live count rides it)
    const seg = [...document.querySelectorAll(".edit-dialog .scope-seg button")].map(
      (b) => b.textContent
    );
    expect(seg.some((s) => s?.startsWith("Group"))).toBe(true);
  });
});

describe("the pane's Update person flushes the group drafts too (#307)", () => {
  const SNAP: Snapshot = {
    version: 1,
    persons: [ALICE],
    faces: [],
    images: [],
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
    },
  } as unknown as Snapshot;

  it("a typed-but-unstaged add-row entry lands in the Update person commit", () => {
    const onUpdate = vi.fn().mockResolvedValue(true);
    render(
      <DetailPane
        person={ALICE}
        refcrops={[] as Refcrop[]}
        snapshot={SNAP}
        faceFilter="all"
        onName={vi.fn()}
        onNote={vi.fn()}
        onOpenPrimary={vi.fn()}
        onRemoveRefcrop={vi.fn()}
        onUpdate={onUpdate}
      />
    );
    fireEvent.change(addInput(), { target: { value: "family|smiths" } });
    fireEvent.click(document.querySelector(".dp-update") as HTMLElement);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const [, , , ops] = onUpdate.mock.calls[0];
    expect(ops).toEqual([{ from: "", to: "family|smiths" }]);
  });
});
