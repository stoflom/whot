// v13.0 (#287) — the anchored Merge Similar route (the person detail
// panel): the same §4.28 triage dialog scoped to ONE person (only its
// cluster is listed, titled `Similar to "name"`, the empty state names
// the person) and the pane's trigger button (always rendered; disabled
// — not hidden — for RejectedN/UnknownN system persons, v13.1/#289,
// with a why-tooltip; v13.1/#289 also pins the pane's action buttons
// to icon + text: ✓ Update person, ✗ Remove person, ⧉ Merge similar).
// Run: npm test (vitest run; jsdom pragma).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DetailPane from "./DetailPane";
import MergeSimilarDialog from "./MergeSimilarDialog";
import type { Person, PersonCounts, Settings } from "../api";

afterEach(cleanup);

const P = (id: number, name: string, counts?: Partial<PersonCounts>): Person => ({
  id,
  name,
  state: "scanned",
  note: null,
  primary_face_id: null,
  primary_pinned: 0,
  created_at: "2026-01-01T00:00:00",
  groups: [],
  counts: { total: 3, provisional: 1, confirmed: 2, rejected: 0, ...counts },
});

const SETTINGS: Settings = {
  cluster_threshold: 0.5,
  refcrop_n: 5,
  face_filter: "all",
  cluster_group: "description",
  merge_name_distance: 2,
  merge_suffix_aliases: [],
  image_viewer: "",
  directory_viewer: "",
};

// two clusters: the seq-suffix pair (jane doe / jane doe 2) and the
// edit-distance pair (john smith / john smite); "smith" is a singleton
// (never listed)
const PERSONS: Person[] = [
  P(1, "jane doe"),
  P(2, "jane doe 2"),
  P(3, "smith"),
  P(4, "john smith"),
  P(5, "john smite"),
];

const memberNames = (c: ParentNode) =>
  [...c.querySelectorAll(".merge-name")].map((n) => n.textContent);

describe("MergeSimilarDialog anchored route (#287)", () => {
  it("anchorId lists ONLY the anchor's cluster and titles the dialog after the person", () => {
    const { container } = render(
      <MergeSimilarDialog
        persons={PERSONS}
        settings={SETTINGS}
        anchorId={1}
        onSaveSettings={vi.fn()}
        onMergeInto={vi.fn()}
        onApplyGroup={vi.fn()}
        onRename={vi.fn()}
        onClose={vi.fn()}
        escActive
      />
    );
    expect(screen.getByText("Similar to “jane doe”")).toBeDefined();
    // the seq-suffix neighbour is in; the edit-distance cluster is out
    expect(memberNames(container).sort()).toEqual(["jane doe", "jane doe 2"]);
  });

  it("no anchorId keeps the tree route: every cluster, the original title", () => {
    const { container } = render(
      <MergeSimilarDialog
        persons={PERSONS}
        settings={SETTINGS}
        onSaveSettings={vi.fn()}
        onMergeInto={vi.fn()}
        onApplyGroup={vi.fn()}
        onRename={vi.fn()}
        onClose={vi.fn()}
        escActive
      />
    );
    expect(screen.getByText("Merge Similar Persons")).toBeDefined();
    expect(memberNames(container).sort()).toEqual([
      "jane doe",
      "jane doe 2",
      "john smite",
      "john smith",
    ]);
  });

  it("an anchor with no similar names gets the named empty state", () => {
    render(
      <MergeSimilarDialog
        persons={PERSONS}
        settings={SETTINGS}
        anchorId={3}
        onSaveSettings={vi.fn()}
        onMergeInto={vi.fn()}
        onApplyGroup={vi.fn()}
        onRename={vi.fn()}
        onClose={vi.fn()}
        escActive
      />
    );
    expect(screen.getByText("No names similar to “smith” under the current rule.")).toBeDefined();
  });
});

describe("DetailPane trigger (#287 / v13.1 #289)", () => {
  const mount = (person: Person, onMergeSimilar: (id: number) => void) =>
    render(
      <DetailPane
        person={person}
        refcrops={[]}
        snapshot={null}
        faceFilter="all"
        onName={vi.fn()}
        onNote={vi.fn()}
        onOpenPrimary={vi.fn()}
        onRemoveRefcrop={vi.fn()}
        onMergeSimilar={onMergeSimilar}
      />
    );

  it("a named person gets the button; it fires with the person's id", () => {
    const onMergeSimilar = vi.fn();
    mount(P(1, "jane doe"), onMergeSimilar);
    const btn = screen.getByRole("button", { name: /merge similar/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onMergeSimilar).toHaveBeenCalledWith(1);
  });

  it("system persons (UnknownN / RejectedN) get the button DISABLED, with a why-tooltip (v13.1/#289)", () => {
    for (const [name, tooltip] of [
      ["Unknown7", "An unknown cluster person can't be a merge target"],
      ["Rejected2", "A rejected cluster person can't be a merge target"],
    ]) {
      const { unmount } = mount(P(9, name), vi.fn());
      const btn = screen.getByRole("button", { name: /merge similar/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute("title")).toBe(tooltip);
      unmount();
    }
  });

  it("the action buttons render icon + text: ✓ Update person, ✗ Remove person, ⧉ Merge similar (v13.1/#289)", () => {
    mount(P(1, "jane doe"), vi.fn());
    expect(screen.getByRole("button", { name: /update person/i }).textContent).toBe("✓ Update person");
    expect(screen.getByRole("button", { name: /remove person/i }).textContent).toBe("✗ Remove person");
    expect(screen.getByRole("button", { name: /merge similar/i }).textContent).toBe("⧉ Merge similar");
  });
});
