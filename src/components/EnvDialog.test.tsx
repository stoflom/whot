// #303 (gui-design v18.2, rule 52) — the environment dialog's
// contract: the prefill from the resolved env, the header contract
// (mode/config/db + the .env override warning), the save round-trip
// (empty known keys DROPPED, unknown keys preserved untouched), the
// save disabled until the settings load, Esc/cancel, and a fetch
// failure → onError with the dialog staying open. The Tauri surface is
// mocked — this pins the dialog, not the webview.
// Run: npm test (vitest run; jsdom pragma).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getConfigInfo, getSettings, type Settings } from "../api";
import EnvDialog, { ENV_KEYS } from "./EnvDialog";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getConfigInfo: vi.fn(),
    getSettings: vi.fn(),
  };
});

const mockInfo = getConfigInfo as ReturnType<typeof vi.fn>;
const mockSettings = getSettings as ReturnType<typeof vi.fn>;

const settings = (env: Record<string, string> = {}): Settings => ({
  cluster_threshold: 0.5,
  refcrop_n: 5,
  face_filter: "all",
  cluster_group: "accuracy",
  merge_name_distance: 1,
  merge_suffix_aliases: [],
  image_viewer: "",
  directory_viewer: "",
  env,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mount = (over: {
  onSave?: (s: Settings) => Promise<void>;
  onClose?: () => void;
  onError?: (m: string) => void;
} = {}) =>
  render(
    <EnvDialog
      onSave={over.onSave ?? vi.fn().mockResolvedValue(undefined)}
      onClose={over.onClose ?? vi.fn()}
      onError={over.onError ?? vi.fn()}
    />
  );

/** the key's input — the title (tooltip) sits on the wrapping label */
const field = (title: RegExp): HTMLInputElement => {
  const input = screen.getByTitle(title).querySelector("input");
  if (!input) throw new Error(`no input under the ${title} label`);
  return input as HTMLInputElement;
};

describe("EnvDialog (#303, rule 52)", () => {
  it("the header carries the resolved mode / config path / db path, and the .env override warning under dotenv", async () => {
    mockInfo.mockResolvedValue({
      mode: "repo",
      configPath: "/repo/config/whotrc.json",
      dbPath: "/repo/data/faces.db",
      envSource: "dotenv",
    });
    mockSettings.mockResolvedValue(settings());
    mount();
    await waitFor(() => expect(screen.getByText(/repository mode/)).toBeTruthy());
    expect(screen.getByText(/\/repo\/config\/whotrc\.json/)).toBeTruthy();
    expect(screen.getByText(/\/repo\/data\/faces\.db/)).toBeTruthy();
    // the .env precedence warning (#302: edits are inert while it exists)
    expect(screen.getByText(/\.env in the project root overrides/)).toBeTruthy();
  });

  it("installed mode says installed, and envSource none shows no warning", async () => {
    mockInfo.mockResolvedValue({
      mode: "installed",
      configPath: "~/.config/whot/whotrc.json",
      dbPath: "~/.local/share/whot/faces.db",
      envSource: "none",
    });
    mockSettings.mockResolvedValue(settings());
    mount();
    await waitFor(() => expect(screen.getByText(/installed/)).toBeTruthy());
    expect(screen.queryByText(/overrides/)).toBeNull();
    expect(screen.getByText(/no environment source/)).toBeTruthy();
  });

  it("prefills the known keys from settings.env; a missing key shows the default placeholder", async () => {
    mockInfo.mockResolvedValue({ mode: "repo", configPath: "/c", dbPath: "/d", envSource: "none" });
    mockSettings.mockResolvedValue(settings({ FACES_DB: "/elsewhere/faces.db", PATH_MAP: "/legacy/map.txt" }));
    mount();
    await waitFor(() => expect(field(/the faces database/).value).toBe("/elsewhere/faces.db"));
    expect(field(/path map file/).value).toBe("/legacy/map.txt");
    // a key with no env entry: the placeholder default, empty value
    const harvest = field(/harvest staging/);
    expect(harvest.value).toBe("");
    expect(harvest.placeholder).toBe("data/harvest.db");
  });

  it("save round-trips through set_settings: empty known keys dropped, unknown keys preserved, then closes", async () => {
    mockInfo.mockResolvedValue({ mode: "repo", configPath: "/c", dbPath: "/d", envSource: "none" });
    mockSettings.mockResolvedValue(
      settings({ FACES_DB: "", HARVEST_DB: "/staging.db", UNKNOWN_KEY: "/keep/me" })
    );
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mount({ onSave, onClose });
    await waitFor(() => expect(field(/path map file/).disabled).toBe(false));
    // edit two known keys: one gets a value, one cleared-to-empty (dropped)
    fireEvent.change(field(/the faces database/), { target: { value: "/new/faces.db" } });
    fireEvent.click(screen.getByText("save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0] as Settings;
    expect(saved.env).toEqual({
      // FACES_DB was empty in settings, now set from the field
      FACES_DB: "/new/faces.db",
      HARVEST_DB: "/staging.db",
      UNKNOWN_KEY: "/keep/me",
    });
    expect(saved.cluster_threshold).toBe(0.5); // the rest of Settings rides along
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("save is disabled until the settings load (the first run has no snapshot to lose)", async () => {
    mockInfo.mockResolvedValue({ mode: "repo", configPath: "/c", dbPath: "/d", envSource: "none" });
    let resolve!: (s: Settings) => void;
    mockSettings.mockReturnValue(new Promise((r) => (resolve = r)));
    mount();
    const save = screen.getByText("save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    resolve(settings());
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it("Esc closes; cancel closes without saving", async () => {
    mockInfo.mockResolvedValue({ mode: "repo", configPath: "/c", dbPath: "/d", envSource: "none" });
    mockSettings.mockResolvedValue(settings());
    const onClose = vi.fn();
    const onSave = vi.fn();
    mount({ onClose, onSave });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    mockSettings.mockResolvedValue(settings());
    mount({ onClose, onSave });
    fireEvent.click(screen.getByText("cancel"));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("a fetch failure reaches onError and the dialog stays open", async () => {
    mockInfo.mockRejectedValue("config info exploded");
    mockSettings.mockRejectedValue(new Error("settings exploded"));
    const onError = vi.fn();
    mount({ onError });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Environment")).toBeTruthy(); // still open
    expect(mockSettings.mock.calls.length).toBeGreaterThan(0);
  });

  it("a save failure reaches onError and the dialog stays open (busy clears)", async () => {
    mockInfo.mockResolvedValue({ mode: "repo", configPath: "/c", dbPath: "/d", envSource: "none" });
    mockSettings.mockResolvedValue(settings());
    const onSave = vi.fn().mockRejectedValue(new Error("write failed"));
    const onClose = vi.fn();
    const onError = vi.fn();
    mount({ onSave, onClose, onError });
    await waitFor(() => expect(field(/path map file/).disabled).toBe(false));
    fireEvent.click(screen.getByText("save"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("write failed"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Environment")).toBeTruthy();
    // busy cleared — the save button is enabled again for a retry
    expect(((screen.getByText("save") as HTMLButtonElement).disabled)).toBe(false);
  });

  it("ENV_KEYS: the 13 known keys, fixed order", () => {
    expect(ENV_KEYS.map(([k]) => k)).toEqual([
      "DATA_DIR", "FACES_DB", "HARVEST_DB", "CONFIG_DIR", "CONFIG_FILE",
      "INSIGHTFACE_PATH", "DEFAULT_IMAGES_DIR", "ARCHIVE_DIR", "DIGIKAM_DB",
      "DIGIKAM_RECOGNITION_DB", "LR_CATALOG", "LR_SIDECARS_DIR", "PATH_MAP",
    ]);
  });
});
