// #247 — the import pane's poll chain survives App re-renders and still
// fires `onImported` on the running → clean-exit flip. App used to pass
// an inline arrow whose identity changed every render; the poll effect
// keyed on `[onImported]` tore down and restarted on each one, resetting
// `prevRunning` and dropping the clean-exit snapshot refresh. Since the
// fix the callback is memoized in App, so the pane's re-renders keep the
// chain alive — pinned here the way App's renders see it.
// Run: npm test (vitest run; jsdom pragma — a mounted component with
// timers needs a DOM).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import ImportPane from "./ImportPane";
import type { ImportStatus } from "../api";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const RUNNING: ImportStatus = {
  running: true, killed: false, exitCode: null,
  elapsed: 2, nextSince: 5, lines: ["importing…"],
};
const DONE: ImportStatus = {
  running: false, killed: false, exitCode: 0,
  elapsed: 9, nextSince: 5, lines: [],
};

beforeEach(() => {
  invoke.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** invoke dispatch: `get_import_info` answers statically, the status
    poll answers from `statuses` in call order, repeating the last one. */
function program(statuses: ImportStatus[]) {
  let i = 0;
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "get_import_status") {
      const s = statuses[Math.min(i++, statuses.length - 1)];
      return Promise.resolve(s);
    }
    return Promise.resolve({ dbPath: "/arc/faces.db", dbExists: true });
  });
}

const pane = (onImported: () => void) => (
  <ImportPane dir="/arc/roll" onClose={() => {}} onImported={onImported} />
);

describe("ImportPane — the onImported poll chain (#247)", () => {
  it("a stable onImported keeps the chain across re-renders: the clean-exit flush still fires", async () => {
    program([RUNNING, DONE]);
    // App-equivalent: a memoized callback keeps its identity across
    // re-renders (the #247 fix)
    const onImported = vi.fn();
    const { rerender } = render(pane(onImported));
    await act(async () => {});           // tick 1 — running (prevRunning remembers)
    expect(onImported).not.toHaveBeenCalled();
    // App re-renders while the pane is open (dialog text, hover churn…)
    for (let i = 0; i < 3; i++) rerender(pane(onImported));
    await act(async () => vi.advanceTimersByTimeAsync(2500)); // next beat: exit 0
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("a churned onImported (the pre-fix inline arrow) loses prevRunning and drops the flush", async () => {
    program([RUNNING, DONE]);
    let n = 0;
    const { rerender } = render(pane(() => { n += 1; }));
    await act(async () => {});           // chain 1, tick 1 — running
                                         // (prevRunning=true lives in chain 1)
    // an App re-render hands the effect a FRESH identity → tear-down +
    // restart (chain 2): its first tick consumes the exit-0 beat with
    // prevRunning still false — the flip is unobservable, no fire
    rerender(pane(() => { n += 1; }));
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(2500)); // idle heartbeats
    expect(n).toBe(0);                   // the snapshot refresh was lost
  });
});
