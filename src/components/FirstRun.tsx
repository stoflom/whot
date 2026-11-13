import { useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import ImportPane from "./ImportPane";

// §4.44 (gui-design v3.94, #206 stage 3) — the first-run screen as a
// component: everything below is that screen's own surface, and the
// dialog → import-pane switch is screen-local state. Outcome routing is
// App-owned via the callbacks — the screen itself decides nothing about
// what a refresh result MEANS for the app.
//
// #185 (§4.36): no usable database — build it and import the first roll
// in ONE flow instead of dead-ending on the raw error. A successful
// import is exit 0 — the app appears; through the dialog's Retry a
// broken (exists-but-unreadable) database falls to the raw error screen.

export default function FirstRun({
  refresh,
  onUsable,
  onBroken,
  onError,
  onEnv,
}: {
  /** App's snapshot refresh — the screen's decisions are its RESULTS */
  refresh: () => Promise<unknown>;
  /** the refreshed snapshot resolved: leave the first-run screen */
  onUsable: () => void;
  /** the refresh rejected (exists-but-broken) — App shows the raw error
      screen (the fall-through always passes onUsable first, as before) */
  onBroken: (message: string) => void;
  /** a post-import refresh failure surfaces as the toast; screen stays */
  onError: (message: string) => void;
  /** #303 (rule 52): opens the environment dialog (App owns it) */
  onEnv: () => void;
}) {
  // #185: firstRunDir null = the dialog, a string = the standalone pane
  const [firstRunDir, setFirstRunDir] = useState<string | null>(null);
  return (
    <div className="first-run">
      {firstRunDir == null ? (
        <div className="overlay">
          <div className="dialog">
            <h3>No database yet</h3>
            <p className="dim">
              No usable database exists at the configured path — build it from{" "}
              <b>database/schema.sql</b> and import your first roll.
            </p>
            <div className="dialog-actions">
              <button
                onClick={() =>
                  refresh()
                    .then(() => onUsable())
                    .catch((e) => {
                      onUsable();
                      onBroken(String(e)); // exists-but-broken: the raw screen
                    })
                }
              >
                Retry
              </button>
              {/* #185: the folder picker pre-checks --create-db in the
                  import pane — the title stays reference-free (§4.43) */}
              <button
                className="ok"
                title="pick a roll folder — the import pane opens with --create-db pre-checked"
                onClick={() =>
                  void openFolderDialog({ directory: true }).then((d) => {
                    if (typeof d === "string" && d) setFirstRunDir(d);
                  })
                }
              >
                Open import pane
              </button>
              {/* #303 (rule 52): the machine's paths may need fixing
                  before the first import — the SAME dialog as the
                  settings popover's entry */}
              <button
                className="secondary"
                title="the machine's paths (whotrc.json's env object)"
                onClick={onEnv}
              >
                environment…
              </button>
            </div>
          </div>
        </div>
      ) : (
        <ImportPane
          dir={firstRunDir}
          // #185: one flow — creation is on, so dry-run is refused by
          // the pane's existing combo rule
          initial={{ createDb: true }}
          onClose={() => setFirstRunDir(null)} // ✕ back to the dialog
          onImported={() =>
            refresh()
              .then(() => {
                onUsable();
                setFirstRunDir(null); // exit 0 — the app appears
              })
              .catch((e) => onError(String(e)))
          }
        />
      )}
    </div>
  );
}
