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
});
