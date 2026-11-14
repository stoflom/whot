// #307 (v19.0, §4.24) — the Edit dialog's Note field and the blur-proof
// commit: the note stages raw (Apply) / commits (Accept) like every
// field, the mixed placeholder applies, a touched note survives a scope
// switch (#197), and the buttons never lose typed text — the commit
// reads each field's LIVE DOM value (an engine-lost input event counts
// as touched), and the action buttons' mousedown keeps the focus.
// Run: npm test (vitest run; jsdom pragma — a mounted component)
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import EditDialog, { type EditResult } from "./EditDialog";
import type { Prefill } from "../stage";

afterEach(cleanup);

const renderDialog = (
  over: {
    prefills?: Record<string, Prefill>;
    counts?: { card: number; group: number; selection: number };
    onDone?: (r: EditResult) => void;
  } = {}
) =>
  render(
    <EditDialog
      defaultScope="selection"
      counts={over.counts ?? { card: 0, group: 0, selection: 2 }}
      rejected={{ card: false, group: false, selection: false }}
      prefills={over.prefills ?? { card: {}, group: {}, selection: {} }}
      persons={[]}
      pathOptions={[]}
      descOptions={[]}
      onDone={over.onDone ?? (() => {})}
      onReject={() => {}}
      onCancel={() => {}}
    />
  );

const noteBox = (): HTMLTextAreaElement =>
  document.querySelector(".edit-dialog .input-note") as HTMLTextAreaElement;

/** the dialog's action buttons — getByText('Accept') also hits the
    subtitle's bold copy */
const actionBtn = (label: string): HTMLElement => {
  const b = [...document.querySelectorAll(".edit-dialog .dialog-actions button")].find(
    (x) => x.textContent === label
  );
  if (!b) throw new Error(`no ${label} button`);
  return b as HTMLElement;
};

/** the scope-seg buttons */
const scopeBtn = (label: string): HTMLElement => {
  const b = [...document.querySelectorAll(".edit-dialog .scope-seg button")].find(
    (x) => x.textContent === label
  );
  if (!b) throw new Error(`no ${label} scope button`);
  return b as HTMLElement;
};

describe("Edit dialog Note field (#307, §4.24)", () => {
  it("the Note field exists below Description and stages its value raw — Apply/Accept carry values.note + touched.note", () => {
    const onDone = vi.fn();
    renderDialog({ onDone });
    fireEvent.change(noteBox(), { target: { value: "intro" } });
    fireEvent.click(actionBtn("Accept"));
    expect(onDone).toHaveBeenCalledTimes(1);
    const r = onDone.mock.calls[0][0] as EditResult;
    expect(r.values.note).toBe("intro");
    expect(r.touched.note).toBe(true);
    // the add marker rides the stage raw — the expansion happens at commit
    fireEvent.change(noteBox(), { target: { value: "|extra" } });
    fireEvent.click(actionBtn("Apply"));
    const r2 = onDone.mock.calls[1][0] as EditResult;
    expect(r2.values.note).toBe("|extra");
    expect(r2.touched.note).toBe(true);
  });

  it("an untouched note stays out of the stage (touched.note false)", () => {
    const onDone = vi.fn();
    renderDialog({ onDone });
    fireEvent.click(actionBtn("Accept"));
    const r = onDone.mock.calls[0][0] as EditResult;
    expect(r.touched.note).toBe(false);
  });

  it("a mixed scope opens the note field empty with the various placeholder", () => {
    renderDialog({
      prefills: {
        selection: { note: undefined, mixed: ["note"] },
        card: {},
        group: {},
      },
    });
    expect(noteBox().value).toBe("");
    expect((noteBox() as HTMLTextAreaElement).placeholder).toBe(
      "various — type to set all"
    );
  });

  it("a uniform note prefills the field", () => {
    renderDialog({
      prefills: { selection: { note: "kept" }, card: {}, group: {} },
    });
    expect(noteBox().value).toBe("kept");
  });

  it("a scope switch keeps the touched note, re-bases an untouched one (#197)", () => {
    renderDialog({
      counts: { card: 1, group: 0, selection: 2 },
      prefills: {
        selection: { note: "sel-note" },
        card: { note: "card-note" },
        group: {},
      },
    });
    expect(noteBox().value).toBe("sel-note");
    // untouched → the scope switch re-bases
    fireEvent.click(scopeBtn("Card (1)"));
    expect(noteBox().value).toBe("card-note");
    // touched → the switch keeps the user's text
    fireEvent.change(noteBox(), { target: { value: "mine" } });
    fireEvent.click(scopeBtn("Selection (2)"));
    expect(noteBox().value).toBe("mine");
  });

  it("Enter in the note field inserts a newline (multiline) — never a submit", () => {
    const onDone = vi.fn();
    renderDialog({ onDone });
    fireEvent.change(noteBox(), { target: { value: "a" } });
    fireEvent.keyDown(noteBox(), { key: "Enter" });
    expect(onDone).not.toHaveBeenCalled();
    expect(noteBox().value).toBe("a"); // the newline is the browser's business
  });
});

describe("the blur-proof commit (#307 — clicking Accept acts as Enter first)", () => {
  it("the commit reads the LIVE DOM value: an input event lost at the engine level still commits", () => {
    const onDone = vi.fn();
    renderDialog({ onDone });
    // type normally, then simulate the engine swallowing the LAST change
    // event: the DOM holds the value, React's state never saw it
    const el = noteBox();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )!.set!;
    setter.call(el, "swallowed"); // NO change event fired
    fireEvent.click(actionBtn("Accept"));
    const r = onDone.mock.calls[0][0] as EditResult;
    expect(r.values.note).toBe("swallowed");
    expect(r.touched.note).toBe(true); // the divergence counts as a touch
  });

  it("the Apply/Accept buttons' mousedown never takes the focus from a field (preventDefault)", () => {
    renderDialog({});
    const buttons = [...document.querySelectorAll(".edit-dialog .dialog-actions button")];
    const apply = buttons.find((b) => b.textContent === "Apply")!;
    const accept = buttons.find((b) => b.textContent === "Accept")!;
    const warn = buttons.find((b) => b.textContent === "Reject")!;
    // fireEvent returns the event's defaultPrevented
    expect(fireEvent.mouseDown(apply)).toBe(false);
    expect(fireEvent.mouseDown(accept)).toBe(false);
    expect(fireEvent.mouseDown(warn)).toBe(false);
  });
});
