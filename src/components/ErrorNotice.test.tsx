// #268 — CopyButton is the shared §4.26 copy affordance (exported so
// the full-image headers can put the original's full path on the
// clipboard). Verifies the render + clipboard contract.
// Run: npm test (vitest run; jsdom pragma — a mounted component).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CopyButton } from "./ErrorNotice";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CopyButton (#268 shared copy affordance)", () => {
  it("renders the label and copies the full text to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const path = "/home/user/Pictures/2021/KNP/100_0330/DSC_0330.jpg";
    render(<CopyButton text={path} />);
    const btn = screen.getByRole("button", { name: "Copy" });
    await fireEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith(path);
    // the transient ok state confirms the copy (microtask after the click)
    expect(await screen.findByRole("button", { name: "✓ copied" })).toBeDefined();
  });

  it("reports a failed copy without throwing", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    // jsdom has no execCommand — the legacy path fails clean
    render(<CopyButton text="x" />);
    const btn = screen.getByRole("button", { name: "Copy" });
    await fireEvent.click(btn);
    expect(await screen.findByRole("button", { name: "✗ failed" })).toBeDefined();
  });

  // #328 — the "✓ copied" reset timer: a second click within the window
  // must keep its ok state (the first click's timer is cleared on
  // re-click), and unmount clears the pending timer
  it("a second click within the window keeps its '✓ copied'", async () => {
    vi.useFakeTimers();
    try {
      // the copy is a promise chain and the re-render is a (faked)
      // microtask — two flushes land both
      const flush = async () => {
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
      };
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      });
      render(<CopyButton text="x" />);
      const btn = screen.getByRole("button", { name: "Copy" });
      await fireEvent.click(btn);
      await flush();
      expect(screen.getByRole("button", { name: "✓ copied" })).toBeDefined();
      // second click at t=800ms — the first timer (t=1500ms) must be
      // cleared, not let to reset this click's ok state
      await vi.advanceTimersByTimeAsync(800);
      await fireEvent.click(screen.getByRole("button", { name: "✓ copied" }));
      await flush();
      // t=1600ms: past the FIRST timer's fire point, 800ms into the
      // second — the unguarded first timer would have idled by now
      await vi.advanceTimersByTimeAsync(800);
      await flush(); // land any pending render (the unguarded clobber)
      expect(screen.getByRole("button", { name: "✓ copied" })).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the pending reset timer on unmount (toasts dismiss mid-window)", async () => {
    vi.useFakeTimers();
    try {
      const flush = async () => {
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
      };
      const clearSpy = vi.spyOn(window, "clearTimeout");
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      });
      const { unmount } = render(<CopyButton text="x" />);
      await fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await flush();
      expect(screen.getByRole("button", { name: "✓ copied" })).toBeDefined();
      unmount(); // mid-window — the timer must be cleared, not fired later
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
