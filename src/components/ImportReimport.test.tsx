// v12.1 (#278) — the import pane's Re-import toggle: present and
// default-off while a usable database exists (the pane's --would-rework
// subject only exists there), hidden beside --create-db while none does,
// and rendered into the startImport options on start. Run: npm test.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import ImportPane from "./ImportPane";
import type { ImportStatus } from "../api";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const IDLE: ImportStatus = {
  running: false, killed: false, exitCode: null,
  elapsed: null, nextSince: 0, lines: [],
};

beforeEach(() => {
  invoke.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function program(dbExists: boolean) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "start_import") return Promise.resolve(IDLE);
    // get_import_status heartbeat + get_import_info
    if (cmd === "get_import_status") return Promise.resolve(IDLE);
    return Promise.resolve({ dbPath: "/arc/faces.db", dbExists });
  });
}

const pane = <ImportPane dir="/arc/roll" onClose={() => {}} onImported={() => {}} />;

async function open(dbExists: boolean) {
  program(dbExists);
  const utils = render(pane);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return utils;
}

describe("ImportPane — the Re-import toggle (#278)", () => {
  it("renders present + unchecked while a usable database exists", async () => {
    const { container } = await open(true);
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    ));
    const reimport = boxes.find(
      (b) => b.parentElement?.textContent?.includes("--reimport"),
    );
    expect(reimport).toBeTruthy();
    expect(reimport!.checked).toBe(false);
    // --create-db is the mirror image (only where no useful DB exists)
    expect(boxes.some((b) => b.parentElement?.textContent?.includes("--create-db"))).toBe(false);
  });

  it("is hidden while no usable database exists (--create-db takes the slot)", async () => {
    const { container } = await open(false);
    const labels = Array.from(container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    )).map((b) => b.parentElement?.textContent ?? "");
    expect(labels.some((t) => t.includes("--reimport"))).toBe(false);
    expect(labels.some((t) => t.includes("--create-db"))).toBe(true);
  });

  it("toggling it renders --reimport:true into the startImport options", async () => {
    const { container } = await open(true);
    const label = Array.from(container.querySelectorAll("label")).find((l) =>
      l.textContent?.includes("--reimport"),
    )!;
    fireEvent.click(label.querySelector('input[type="checkbox"]')!);
    fireEvent.click(Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "start",
    )!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const start = invoke.mock.calls.find((c) => c[0] === "start_import")!;
    expect(start[1].options.reimport).toBe(true);
    expect(start[1].options.createDb).toBe(false);
  });
});
