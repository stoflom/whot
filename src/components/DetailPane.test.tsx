// #327 — the DetailPane avatar is a real <button> (role/tabIndex/Enter
// like every other comparable control): focusable, keyboard-activatable
// semantics, and inert when the person has no primary face. The avatar
// was the one click-only div left after the repo-wide button conversion.
// Run: npm test (vitest run; jsdom pragma — a mounted component).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import DetailPane from "./DetailPane";
import type { FaceFilter } from "../viewFilters";
import type { Person } from "../api";

// the face-image loader hits Tauri — the avatar test only needs the
// button semantics, so stub it out
vi.mock("../hooks", () => ({ useFaceImage: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PERSON: Person = {
  id: 3,
  name: "A",
  state: "live",
  note: null,
  primary_face_id: 7,
  primary_pinned: 0,
  created_at: "",
  groups: [],
  counts: { total: 1, provisional: 0, confirmed: 1, rejected: 0 },
};

function renderPane(primary_face_id: number | null, onOpenPrimary: () => void) {
  const person: Person = { ...PERSON, primary_face_id };
  return render(
    <DetailPane
      person={person}
      refcrops={[]}
      snapshot={null}
      faceFilter={"all" as FaceFilter}
      onName={() => {}}
      onNote={() => {}}
      onOpenPrimary={onOpenPrimary}
      onRemoveRefcrop={() => {}}
    />,
  );
}

describe("DetailPane avatar — a real button (#327)", () => {
  it("is a real <button> (role + focusable) that opens the primary face", () => {
    const onOpenPrimary = vi.fn();
    const { container } = renderPane(7, onOpenPrimary);
    // the accessible name is the glyph content; the affordance hint is
    // the title — find it by class
    const av = container.querySelector(
      ".dp-avatar",
    ) as HTMLButtonElement;
    expect(av).toBeInstanceOf(HTMLButtonElement); // role=button, Enter/Space native
    expect(av.tabIndex).toBe(0); // keyboard-reachable
    expect(av.title).toBe(
      "Open the primary face's full image (focus mode)",
    );
    fireEvent.click(av);
    expect(onOpenPrimary).toHaveBeenCalledWith(7);
  });

  it("is disabled and inert when the person has no primary face", () => {
    const onOpenPrimary = vi.fn();
    const { container } = renderPane(null, onOpenPrimary);
    // no title when there is no primary — find it by class
    const av = container.querySelector(
      ".dp-avatar",
    ) as HTMLButtonElement;
    expect(av).toBeInstanceOf(HTMLButtonElement);
    expect(av.disabled).toBe(true);
    fireEvent.click(av); // a disabled button never activates
    expect(onOpenPrimary).not.toHaveBeenCalled();
  });
});
