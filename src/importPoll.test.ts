// #226 (F-M7) — the ImportPane poll schedule. The pane used to tick
// get_import_status every 300 ms for its whole open lifetime, running or
// not; the schedule is now a pure function of the last observed run
// state (ImportPane reads it after each tick via runningRef).

import { describe, expect, it } from "vitest";
import { POLL_ACTIVE_MS, POLL_IDLE_MS, pollDelayMs } from "./importPoll";

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
});
