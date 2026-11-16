// #326 — the shared Dialog wrapper: a real dialog to assistive tech
// (role="dialog", aria-modal, aria-label from the title), initial focus
// moved inside, Tab trapped inside, focus restored on close, and the
// modeless variant inert (no aria-modal, no trap). Stacked dialogs: the
// topmost (which grabbed focus on open) owns the trap.
// Run: npm test (vitest run; jsdom pragma — focus/keyboard).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { OverlayProvider } from "../overlays";
import Dialog from "./Dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** the app renders inside the provider — the registration needs it */
function wrap(ui: React.ReactNode) {
  return render(<OverlayProvider>{ui}</OverlayProvider>);
}

function twoButtons() {
  return (
    <Dialog label="Test dialog">
      <div className="dialog">
        <button>a</button>
        <button>b</button>
      </div>
    </Dialog>
  );
}

describe("Dialog — the a11y contract (#326)", () => {
  it("is a real dialog: role, aria-modal, aria-label from the title", () => {
    const { container } = wrap(twoButtons());
    const ov = container.querySelector(".overlay") as HTMLElement;
    expect(ov.getAttribute("role")).toBe("dialog");
    expect(ov.getAttribute("aria-modal")).toBe("true");
    expect(ov.getAttribute("aria-label")).toBe("Test dialog");
  });

  it("moves the initial focus inside (first focusable, else the box)", () => {
    const { container } = wrap(twoButtons());
    expect(document.activeElement).toBe(
      (container.querySelector(".overlay") as HTMLElement).querySelector(
        "button",
      ),
    );
    // no focusable children — the box itself (tabIndex=-1) takes it
    const r2 = wrap(
      <Dialog label="Empty">
        <div className="dialog">just text</div>
      </Dialog>,
    );
    expect(document.activeElement).toBe(
      r2.container.querySelector(".overlay"),
    );
  });

  it("keeps an autofocus child's focus (React's autoFocus runs first)", () => {
    const { container } = wrap(
      <Dialog label="Focusy">
        <div className="dialog">
          <button>skip me</button>
          <input autoFocus data-testid="auto" />
        </div>
      </Dialog>,
    );
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="auto"]'),
    );
  });

  it("traps Tab: the last element wraps to the first, Shift+Tab back", () => {
    const { container } = wrap(twoButtons());
    const ov = container.querySelector(".overlay") as HTMLElement;
    const [a, b] = [
      ...ov.querySelectorAll("button"),
    ] as HTMLButtonElement[];
    b.focus();
    act(() => {
      fireEvent.keyDown(window, { key: "Tab" });
    });
    expect(document.activeElement).toBe(a); // wrapped forward
    act(() => {
      fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    });
    expect(document.activeElement).toBe(b); // wrapped backward
  });

  it("restores the previously focused element on close", () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();
    const r = wrap(twoButtons());
    expect(document.activeElement).not.toBe(before);
    cleanup(); // the dialog closes
    expect(document.activeElement).toBe(before);
    before.remove();
    cleanup(); // the wrapper's own tree
    void r;
  });

  it("modeless: no aria-modal, no initial focus move, no trap", () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();
    const { container } = wrap(
      <Dialog label="Floating" modeless>
        <div className="dialog">
          <button>a</button>
          <button>b</button>
        </div>
      </Dialog>,
    );
    const ov = container.querySelector(".overlay") as HTMLElement;
    expect(ov.getAttribute("aria-modal")).toBeNull();
    expect(ov.classList.contains("overlay")).toBe(true);
    expect(document.activeElement).toBe(before); // not stolen
    const b = ov.querySelectorAll("button")[1] as HTMLButtonElement;
    b.focus();
    act(() => {
      fireEvent.keyDown(window, { key: "Tab" });
    });
    // untrapped — jsdom does not move focus on Tab at all
    expect(document.activeElement).toBe(b);
    before.remove();
  });

  it("stacked dialogs: only the topmost (which owns focus) traps", () => {
    const bottom = wrap(twoButtons());
    const top = wrap(
      <Dialog label="Top">
        <div className="dialog">
          <button>top-a</button>
          <button>top-b</button>
        </div>
      </Dialog>,
    );
    const topOv = top.container.querySelector(".overlay") as HTMLElement;
    expect(document.activeElement).toBe(
      topOv.querySelectorAll("button")[0], // grabbed on open
    );
    (topOv.querySelectorAll("button")[1] as HTMLButtonElement).focus();
    act(() => {
      fireEvent.keyDown(window, { key: "Tab" });
    });
    // wraps inside the TOP dialog — the bottom one's trap saw focus
    // outside itself and stood down
    expect(document.activeElement).toBe(
      topOv.querySelectorAll("button")[0],
    );
    cleanup();
    void bottom;
  });
});
