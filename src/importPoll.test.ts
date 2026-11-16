// #226 (F-M7) — the ImportPane poll schedule. The pane used to tick
// get_import_status every 300 ms for its whole open lifetime, running or
// not; the schedule is now a pure function of the last observed run
// state (ImportPane reads it after each tick via runningRef).

import { describe, expect, it } from "vitest";
import { POLL_ACTIVE_MS, POLL_BACKOFF_CAP_MS, POLL_IDLE_MS, pollDelayMs } from "./importPoll";

describe("pollDelayMs (#226 F-M7)", () => {
  it("a live import keeps the responsive 300 ms cadence", () => {
    expect(pollDelayMs(true)).toBe(POLL_ACTIVE_MS);
    expect(POLL_ACTIVE_MS).toBe(300);
  });

  it("an idle pane falls back to the slow heartbeat", () => {
    expect(pollDelayMs(false)).toBe(POLL_IDLE_MS);
    expect(POLL_IDLE_MS).toBe(2500);
    expect(POLL_IDLE_MS).toBeGreaterThan(POLL_ACTIVE_MS);
  });

  // #330 — a failing getImportStatus backs off: the delay doubles per
  // consecutive failure and caps, instead of re-polling every 2.5 s
  // forever
  it("doubles per consecutive failure (idle pane)", () => {
    expect(pollDelayMs(false, 0)).toBe(2500);
    expect(pollDelayMs(false, 1)).toBe(5000);
    expect(pollDelayMs(false, 2)).toBe(10_000);
    expect(pollDelayMs(false, 3)).toBe(20_000);
  });

  it("caps at the backoff cap, for any state", () => {
    expect(pollDelayMs(false, 4)).toBe(POLL_BACKOFF_CAP_MS); // 40 s → capped
    expect(pollDelayMs(false, 100)).toBe(POLL_BACKOFF_CAP_MS);
    expect(POLL_BACKOFF_CAP_MS).toBe(30_000);
    expect(pollDelayMs(true, 7)).toBe(POLL_BACKOFF_CAP_MS); // 300 ms * 128
    expect(pollDelayMs(true, 1)).toBe(600);
  });
});
