// #303 (gui-design v18.2, rule 52) — the environment dialog: the
// machine's configuration in one place. The environment keys that
// #302 merged into whotrc.json's `env` object (backend-design §2) as
// fixed editable rows — keys are the vocabulary, only values change.
//
// The dialog fetches its own `get_config_info` + settings prefill:
// the first-run surface has no snapshot yet, so it must not depend on
// one (§4.44 — App keeps only the open/close and save bindings).
// Saving goes through the EXISTING set_settings (the env object rides
// Settings since #302) — a failure reaches the error toast and the
// dialog stays open.

import { useEffect, useState } from "react";
import {
  getConfigInfo,
  getSettings,
  type ConfigInfo,
  type Settings,
} from "../api";
import { useOwnsKeyboard } from "../overlays";

/** the KNOWN env keys (backend-design §2) — one row each, with the
    placeholder default and a tooltip description. Fixed order. */
export const ENV_KEYS: ReadonlyArray<readonly [string, string, string]> = [
  ["DATA_DIR", "data", "data directory (relative paths resolve against the project root)"],
  ["FACES_DB", "data/faces.db", "the faces database (sqlite)"],
  ["HARVEST_DB", "data/harvest.db", "the harvest staging database (legacy recovery)"],
  ["CONFIG_DIR", "config", "config directory"],
  ["CONFIG_FILE", "config/whotrc.json", "the GUI settings file (whotrc.json)"],
  ["INSIGHTFACE_PATH", "../insightface", "python venv providing insightface"],
  ["DEFAULT_IMAGES_DIR", "${HOME}/Pictures", "default input folder for the harvest"],
  ["ARCHIVE_DIR", "", "read-only archive of the pictures"],
  ["DIGIKAM_DB", "", "digikam database (digikam4.db)"],
  ["DIGIKAM_RECOGNITION_DB", "", "digikam recognition database"],
  ["LR_CATALOG", "", "lightroom catalog (.lrcat)"],
  ["LR_SIDECARS_DIR", "", "lightroom sidecar directory"],
  ["PATH_MAP", "", "path map file (legacy roots → local archive)"],
];

interface Props {
  /** App's save — set_settings (+ refresh, + the info toast naming
      the restart hint). Rejects on failure: the dialog stays open. */
  onSave: (s: Settings) => Promise<void>;
  onClose: () => void;
  /** a fetch/save failure — the caller's error toast */
  onError: (msg: string) => void;
}

export default function EnvDialog({ onSave, onClose, onError }: Props) {
  useOwnsKeyboard(); // #138: an open dialog owns the keyboard
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const [info, setInfo] = useState<ConfigInfo | null>(null);
  const [settings, setSettingsResolved] = useState<Settings | null>(null);
  // prefill: the resolved env (a missing key = the default placeholder)
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getConfigInfo()
      .then(setInfo)
      .catch((e) => onError(e instanceof Error ? e.message : String(e)));
    getSettings()
      .then((s) => {
        setSettingsResolved(s);
        const v: Record<string, string> = {};
        for (const [k] of ENV_KEYS) v[k] = s.env?.[k] ?? "";
        setValues(v);
      })
      .catch((e) => onError(e instanceof Error ? e.message : String(e)));
  }, [onError]);

  const edit = (k: string, v: string) => setValues((prev) => ({ ...prev, [k]: v }));

  /** the known keys' non-empty values (empty = the default applies —
      the key is dropped), over the untouched unknown keys */
  const build = (): Settings => {
    const env: Record<string, string> = {};
    for (const [k, val] of Object.entries(settings?.env ?? {})) {
      if (!ENV_KEYS.some(([known]) => known === k)) env[k] = val;
    }
    for (const [k] of ENV_KEYS) {
      const val = (values[k] ?? "").trim();
      if (val) env[k] = val;
    }
    return { ...settings!, env };
  };

  const save = async () => {
    if (busy || !settings) return;
    setBusy(true);
    try {
      await onSave(build());
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog env">
        <h3>Environment</h3>
        {info ? (
          <p className="dim">
            {info.mode === "repo" ? "repository mode" : "installed"} · settings file:{" "}
            <b>{info.configPath}</b> · database: <b>{info.dbPath}</b>
          </p>
        ) : (
          <p className="dim">resolving the configuration…</p>
        )}
        {info?.envSource === "dotenv" && (
          <p className="env-note">
            a .env in the project root overrides these values
          </p>
        )}
        {info?.envSource === "none" && (
          <p className="dim">no environment source — the defaults apply until values are saved</p>
        )}
        {ENV_KEYS.map(([k, def, desc]) => (
          <label key={k} title={desc}>
            {k}
            <input
              value={values[k] ?? ""}
              placeholder={def || "no default — required"}
              disabled={busy || !settings}
              onChange={(e) => edit(k, e.target.value)}
            />
          </label>
        ))}
        <p className="dim">
          {"${VAR} references are saved literally and expanded on read. Path changes take effect after a restart."}
        </p>
        <div className="dialog-actions">
          <button className="secondary" onClick={onClose}>
            cancel
          </button>
          <button onClick={() => void save()} disabled={busy || !settings}>
            save
          </button>
        </div>
      </div>
    </div>
  );
}
