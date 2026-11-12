// The backend sync layer (gui-design §4.44 round 2 stage 3, #294) —
// ONE hook owns the snapshot state and its transport: the #208 change
// stamp (read before the rows, so the focus reload can skip a no-op
// fetch), the #219 delta transport (touched rows move, no full
// re-fetch; staleness is exact via `deltaStale` — a drifted or
// base-stale delta falls back to ONE full refresh), the #208
// focus/visibility reload (one tiny version probe instead of a
// whole-snapshot fetch) and the cold-load #185 routing to the §4.36
// first-run case. It reads NO view state: the hook is self-contained
// over the `./api` seam and co-tested against a mocked backend.
//
// `mutate` stays App-side (it clears the selection on the clearSel
// path — a view concern) and binds this hook's `applyDeltas`/
// `refresh` as the one IPC seam the other modules bind to; the #234
// advance-target prefetch and the #222 verdict-flight state stay
// App-owned — verdict machinery bound to the view-state refs, not
// snapshot sync.

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import type { Delta, Snapshot } from "./api";
import { applyDeltaToSnapshot, deltaStale } from "./deltas";

export function useSnapshotSync() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // #185 (§4.36): no USABLE database ⇒ the first-run screen (the dialog
  // offers the import pane with --create-db) instead of the raw error
  // (the screen + its local dir state live in components/FirstRun.tsx)
  const [noDb, setNoDb] = useState(false);

  // #208: the snapshot carries the change stamp (read before its data),
  // stored here so the focus reload can skip a no-op fetch
  const snapVersionRef = useRef(0);
  // the #98 mirror: handlers that read the snapshot at event time
  // (the verdict flip, the prefetch signature) read it through this ref
  const snapRef = useRef<Snapshot | null>(null);
  snapRef.current = snap;

  const refresh = useCallback(async () => {
    const s = await api.getSnapshot();
    snapVersionRef.current = s.version;
    setSnap(s);
  }, []);
  // #219: apply a mutation's delta locally — only the touched rows move,
  // no full snapshot re-fetch. #281: the upsert/drop maths is the pure
  // `applyDeltaToSnapshot` (co-tested in deltas.test.ts); staleness is
  // exact via `deltaStale` — `base` (the command's pre-write stamp) must
  // equal the stamp of the state this delta applies onto.
  const applyDelta = useCallback(
    (delta: Delta) => {
      if (deltaStale(delta, snapVersionRef.current)) {
        void refresh().catch(() => {});
        return;
      }
      snapVersionRef.current = delta.version;
      setSnap((s) => (s ? applyDeltaToSnapshot(s, delta) : s));
    },
    [refresh]
  );
  // #281: apply a PLAN's deltas in order — each delta's `base` is the
  // stamp the previous apply left (the backend chains sequential ops
  // exactly this way), so every delta is checked against the live stamp;
  // the first stale/drifted one aborts the plan and falls back to ONE
  // full refresh (applying the rest on top of a known-stale base would
  // just cascade more refreshes).
  const applyDeltas = useCallback(
    async (deltas: Delta[]) => {
      let stale = false;
      for (const d of deltas) {
        if (deltaStale(d, snapVersionRef.current)) {
          stale = true;
          break;
        }
        applyDelta(d);
      }
      if (stale) await refresh();
    },
    [applyDelta, refresh]
  );
  // #208: reload only when the database actually moved since the last
  // snapshot (our own mutations refresh explicitly and record the new
  // stamp) — one tiny probe call instead of a whole-snapshot fetch
  const refreshIfChanged = useCallback(async () => {
    const v = await api.getDataVersion();
    if (v !== snapVersionRef.current) await refresh();
  }, [refresh]);
  // #247: the import pane restarts its poll chain whenever `onImported`'s
  // identity changes — an inline arrow re-created every render would drop
  // the poll's `prevRunning` memory mid-run and miss the clean-exit
  // snapshot refresh, so the callback is stable
  const onImported = useCallback(
    () => void refresh().catch(() => {}),
    [refresh]
  );

  useEffect(() => {
    refresh().catch(async (e) => {
      // #185 (§4.36): a failed load with NO usable database is the
      // first-run case — offer the create+import flow, not the raw error
      const usable = await api
        .getImportInfo()
        .then((i) => i.dbExists)
        .catch(() => true); // probe failed — keep the error screen
      if (usable) setLoadError(String(e));
      else setNoDb(true);
    });
  }, [refresh]);

  // F12: pick up imports/mutations done while the window is in the background
  useEffect(() => {
    const reload = () => {
      if (document.visibilityState !== "hidden") refreshIfChanged().catch(() => {});
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", reload);
    return () => {
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [refreshIfChanged]);

  return {
    snap,
    setSnap,
    snapRef,
    snapVersionRef,
    loadError,
    setLoadError,
    noDb,
    setNoDb,
    refresh,
    applyDelta,
    applyDeltas,
    refreshIfChanged,
    onImported,
  };
}

export type SnapshotSync = ReturnType<typeof useSnapshotSync>;
