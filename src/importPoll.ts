// #226 (F-M7) — the ImportPane poll schedule. The pane used to tick
// get_import_status every 300 ms for as long as it was open, running or
// not — an always-on IPC wake-up of the renderer's task queue in
// WebKitGTK. The schedule is a pure function of the run state: a live
// import keeps the responsive 300 ms cadence (the stdout viewport must
// feel live), an idle pane falls back to a slow heartbeat that still
// catches a run started elsewhere (the mock/CLI) and the running →
// finished flip within one beat.

export const POLL_ACTIVE_MS = 300;
export const POLL_IDLE_MS = 2500;

/** delay until the next get_import_status tick, given the last known
    running state (runningRef in ImportPane — read AFTER each tick, so
    the schedule follows the state it just observed) */
export const pollDelayMs = (running: boolean): number =>
  running ? POLL_ACTIVE_MS : POLL_IDLE_MS;
