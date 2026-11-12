// §4.44 round 2 stage 4 (#295) — the guard/confirm dialog surfaces'
// copy + button contracts, co-located per component. Pins the rule 43
// string rule (product language — no §-sections, no #issues in the
// user-visible copy) and the button semantics (accept vs discard,
// Show All vs Close, singular vs plural removal).
// Run: npm test (vitest run; jsdom pragma — mounted components)
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ContextConfirmDialog from "./ContextConfirmDialog";
import { PickPersonDialog, NoFacesDialog } from "./guards";
import ConfirmRemoveDialog from "./ConfirmRemoveDialog";
import type { Stage } from "../stage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const stage = (id: number): Stage => ({ faceIds: [id], desc: "d" });

const NO_REFS = /[§#]|C\d\d/;

describe("ContextConfirmDialog (#123 guard surface)", () => {
  it("offers accept and discard, in that order, with the staged summary", () => {
    render(
      <ContextConfirmDialog
        pending={[stage(1), stage(2)]}
        onAccept={vi.fn()}
        onDiscard={vi.fn()}
      />
    );
    expect(screen.getByText("Unapplied changes")).toBeDefined();
    expect(screen.getByText(/Staged: 2 · 2 face\(s\) staged|Staged: .*2 face/)).toBeDefined();
    const buttons = screen.getAllByRole("button");
    // the dialog renders cancel-then-confirm (ConfirmDialog's action row)
    expect(buttons.map((b) => b.textContent)).toEqual(["discard", "accept"]);
    expect(NO_REFS.test(document.querySelector(".dialog")!.textContent ?? "")).toBe(false);
  });

  it("accept and discard route to the App actions", () => {
    const onAccept = vi.fn();
    const onDiscard = vi.fn();
    render(
      <ContextConfirmDialog pending={[stage(1)]} onAccept={onAccept} onDiscard={onDiscard} />
    );
    fireEvent.click(screen.getByRole("button", { name: "accept" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "discard" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});

describe("PickPersonDialog (#176 no-anchor pointer)", () => {
  it("single modeless Close — no secondary button, no reference strings", () => {
    const onClose = vi.fn();
    render(<PickPersonDialog onClose={onClose} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Close"]);
    expect(NO_REFS.test(document.querySelector(".dialog")!.textContent ?? "")).toBe(false);
    fireEvent.click(buttons[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("NoFacesDialog (#176 sticky-person guard)", () => {
  it("names the current Show filter; Show All routes to the filter switch", () => {
    const onShowAll = vi.fn();
    const onClose = vi.fn();
    render(
      <NoFacesDialog faceFilter="confirmed" onShowAll={onShowAll} onClose={onClose} />
    );
    expect(screen.getByText("No accepted faces")).toBeDefined();
    expect(screen.getByText(/Show → Accepted/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Show All" }));
    expect(onShowAll).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(NO_REFS.test(document.querySelector(".dialog")!.textContent ?? "")).toBe(false);
  });

  it("Show → All keeps the bare 'no faces' title", () => {
    render(<NoFacesDialog faceFilter="all" onShowAll={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("No faces to show")).toBeDefined();
  });
});

describe("ConfirmRemoveDialog (#165/§4.13 copy, #266 wording)", () => {
  it("singular: one person, danger remove", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmRemoveDialog ids={[7]} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByText("Remove person")).toBeDefined();
    expect(screen.getByText(/All faces of this person/)).toBeDefined();
    const remove = screen.getByRole("button", { name: "remove" });
    expect(remove.className).toContain("bad"); // the danger styling
    fireEvent.click(remove);
    expect(onConfirm).toHaveBeenCalledWith([7]);
    expect(NO_REFS.test(document.querySelector(".dialog")!.textContent ?? "")).toBe(false);
  });

  it("plural: the count in title and body", () => {
    render(
      <ConfirmRemoveDialog ids={[7, 8, 9]} onConfirm={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByText("Remove 3 persons")).toBeDefined();
    expect(screen.getByText(/All faces of these persons/)).toBeDefined();
  });
});
