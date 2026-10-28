import { useCallback, useEffect, useRef, useState } from "react";
import {
  getImportInfo,
  getImportStatus,
  startImport,
  stopImport,
  type ImportOptions,
  type ImportStatus,
} from "../api";

// #167 (gui-design §4.36) — the Rolls import pane: a per-roll option
// panel + stdout monitoring viewport driving scripts/import_roll.py as
// an independent child process (the backend owns the process; this pane
// only starts/stops it and polls get_import_status).

interface Props {
  /** the not-yet-imported directory the path filter handed us */
  dir: string;
  onClose: () => void;
  /** exit 0 ⇒ the caller refreshes the snapshot (new faces appear) */
  onImported: () => void;
}

/** the pane's default options — the script's own defaults, except
    #169: --recursive starts ON — the probe that opened the pane found
    its images below the top level, a default-off import would skip the
    very sub-folders that triggered it */
const DEFAULTS: Omit<ImportOptions, "rollDir"> = {
  dryRun: false,
  all: false,
  gpu: false,
  threshold: 0.4,
  recursive: true,
  createDb: false,
};

export default function ImportPane({ dir, onClose, onImported }: Props) {
  const [opts, setOpts] = useState<Omit<ImportOptions, "rollDir">>(DEFAULTS);
  const [dbPath, setDbPath] = useState<string | null>(null);
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // stdout viewport: auto-follow the tail unless the user scrolled up
  // (scroll-lock), re-engaged at the bottom; the buffer lives in the
  // backend, the pane appends the [since..] slices
  const logRef = useRef<HTMLPreElement | null>(null);
  const followRef = useRef(true);
  const sinceRef = useRef(0);
  const linesRef = useRef<string[]>([]);
  const runningRef = useRef(false);

  useEffect(() => {
    getImportInfo().then(setDbPath).catch((e) => setError(String(e)));
  }, []);

  // poll while the pane is open — cheap (300 ms) and keeps the viewport
  // live across tab switches; a finished run is detected by the flip
  // running → !running and a clean exit refreshes the snapshot
  useEffect(() => {
    let stop = false;
    let prevRunning = false;
    const tick = async () => {
      if (stop) return;
      try {
        const s = await getImportStatus(sinceRef.current);
        if (stop) return;
        sinceRef.current = s.nextSince;
        runningRef.current = s.running;
        if (s.lines.length > 0) {
          linesRef.current = [...linesRef.current, ...s.lines];
          setStatus({ ...s, lines: linesRef.current });
        } else if (s.running !== prevRunning || s.exitCode !== null) {
          setStatus({ ...s, lines: linesRef.current });
        }
        if (prevRunning && !s.running && s.exitCode === 0 && !s.killed) {
          onImported(); // successful run — the faces are in the DB now
        }
        prevRunning = s.running;
      } catch (e) {
        if (!stop) setError(String(e));
      }
    };
    const id = window.setInterval(() => void tick(), 300);
    void tick();
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [onImported]);

  // auto-follow: pin to the bottom while following; a manual scroll-up
  // disengages, scrolling back to the bottom re-engages
  useEffect(() => {
    const el = logRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [status]);
  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const running = status?.running ?? false;
  const finished = status != null && !status.running && (status.exitCode !== null || status.killed);

  const start = useCallback(async () => {
    setError(null);
    try {
      sinceRef.current = 0;
      linesRef.current = [];
      followRef.current = true;
      const s = await startImport({ ...opts, rollDir: dir });
      runningRef.current = s.running;
      setStatus({ ...s, lines: linesRef.current });
    } catch (e) {
      setError(String(e));
    }
  }, [dir, opts]);

  const stop = useCallback(async () => {
    try {
      await stopImport();
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const toggle = (key: keyof typeof DEFAULTS) =>
    setOpts((o) => ({ ...o, [key]: !o[key] }));

  const badCombo = opts.createDb && opts.dryRun;

  return (
    <div className="import-pane">
      <header className="import-head">
        <h3>import roll</h3>
        <button className="ghost" onClick={onClose} title="close the import pane (a running import keeps going)">
          ✕
        </button>
      </header>

      <div className="import-meta dim">
        <div title="the directory the import will read (picked in the Rolls path filter)">
          dir <span className="import-path">{dir}</span>
        </div>
        <div title="the database the script writes (FACES_DB from .env)">
          db <span className="import-path">{dbPath ?? "…"}</span>
        </div>
      </div>

      <fieldset className="import-opts" disabled={running}>
        <legend className="dim">options</legend>
        <label title="scan + detect, report what would be imported — no writes">
          <input type="checkbox" checked={opts.dryRun} onChange={() => toggle("dryRun")} /> --dry-run
        </label>
        <label title="import every image, faceless ones with state no-face">
          <input type="checkbox" checked={opts.all} onChange={() => toggle("all")} /> --all
        </label>
        <label title="opt in to the MIGraphX GPU provider (CPU is the default)">
          <input type="checkbox" checked={opts.gpu} onChange={() => toggle("gpu")} /> --gpu
        </label>
        <label title="walk sub-directories too">
          <input type="checkbox" checked={opts.recursive} onChange={() => toggle("recursive")} /> --recursive
        </label>
        <label title="create the database from database/schema.sql — refuses an existing non-empty one">
          <input type="checkbox" checked={opts.createDb} onChange={() => toggle("createDb")} /> --create-db
        </label>
        <label title="same-person similarity threshold (the script's default 0.40)">
          --threshold
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={opts.threshold}
            onChange={(e) =>
              setOpts((o) => ({ ...o, threshold: Number(e.target.value) || 0 }))
            }
          />
        </label>
      </fieldset>
      {badCombo && (
        <div className="import-error">
          --create-db cannot be combined with --dry-run (creation is a write)
        </div>
      )}

      <div className="import-actions">
        <button className="ok" onClick={() => void start()} disabled={running || badCombo}>
          start
        </button>
        <button className="bad" onClick={() => void stop()} disabled={!running}>
          stop
        </button>
        <span className="dim">
          {status == null
            ? "idle"
            : running
              ? `running${status.elapsed != null ? ` · ${status.elapsed}s` : ""}`
              : status.killed
                ? "killed"
                : `exit ${status.exitCode ?? "?"}`}
        </span>
      </div>

      {error && <div className="import-error">{error}</div>}

      <pre className="import-log" ref={logRef} onScroll={onScroll}>
        {linesRef.current.length === 0 && !running && !finished
          ? "… output of scripts/import_roll.py appears here"
          : linesRef.current.join("\n")}
      </pre>
    </div>
  );
}
