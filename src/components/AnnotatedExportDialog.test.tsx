// #298 (gui-design v16.0, rule 51) — the annotated-image export
// dialog: the prefilled save path (the original's directory +
// <stem>-annotated.<ext>), the file-type / max-dimension fields, the
// native-save-dialog browse, and the export flow (the canvas encode →
// saveImageFile → onSaved + close; a failure reaches onError and the
// dialog stays open). The Tauri surface and the canvas pipeline are
// mocked — this pins the dialog's contract, not the webview.
// Run: npm test (vitest run; jsdom pragma).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { save } from "@tauri-apps/plugin-dialog";
import { saveImageFile, type Face, type ImageRow } from "../api";
import AnnotatedExportDialog from "./AnnotatedExportDialog";
import { renderAnnotatedBlob } from "../exportAnnotated";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, saveImageFile: vi.fn() };
});
vi.mock("../exportAnnotated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../exportAnnotated")>();
  return { ...actual, renderAnnotatedBlob: vi.fn() };
});

const IMG: ImageRow = {
  id: 42,
  primary_path: "/home/u/rolls/2026-01/sub/IMG_0001.RAW",
  width: 4000,
  height: 6000,
  orientation: "portrait",
  rotation: 0,
  rtype: "raw",
  state: "imported",
  first_import_id: 7,
  last_import_id: 7,
};

const face = (id: number): Face => ({
  id,
  image_id: 42,
  person_id: 1,
  x: 100,
  y: 200,
  w: 300,
  h: 400,
  name: "alice",
  seq: 0,
  description: null,
  confidence: 0.9,
  link_status: "provisional",
  state: "live",
  rotation: 0,
  import_id: null,
  created_at: "",
});

const mount = (
  over: {
    onClose?: () => void;
    onSaved?: (p: string) => void;
    onError?: (m: string) => void;
  } = {}
) =>
  render(
    <AnnotatedExportDialog
      image={IMG}
      faces={[face(1)]}
      personName={(pid) => (pid === 1 ? "Alice" : null)}
      onClose={over.onClose ?? vi.fn()}
      onSaved={over.onSaved ?? vi.fn()}
      onError={over.onError ?? vi.fn()}
    />
  );

const pathInput = (c: HTMLElement) =>
  c.querySelector<HTMLInputElement>(".dialog-path-row input")!;

afterEach(() => {
  cleanup();
  vi.mocked(save).mockReset();
  vi.mocked(saveImageFile).mockReset();
  vi.mocked(renderAnnotatedBlob).mockReset();
});

describe("AnnotatedExportDialog (#298, rule 51)", () => {
  it("opens prefilled: PNG, the original's directory + <stem>-annotated.png, the original dims as the size hint", () => {
    const { container } = mount();
    expect(screen.getByRole("heading").textContent).toBe(
      "Export annotated image"
    );
    expect(pathInput(container).value).toBe(
      "/home/u/rolls/2026-01/sub/IMG_0001-annotated.png"
    );
    const sel = container.querySelector<HTMLSelectElement>("select")!;
    expect(sel.value).toBe("png");
    const maxDim =
      container.querySelector<HTMLInputElement>("input[inputmode='numeric']")!;
    expect(maxDim.placeholder).toBe("original 4000×6000");
  });

  it("a BLOB-only image (no recorded path) is prefilled with just the name", () => {
    const { container } = render(
      <AnnotatedExportDialog
        image={{ ...IMG, primary_path: "" }}
        faces={[]}
        personName={(pid) => (pid === 1 ? "Alice" : null)}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onError={vi.fn()}
      />
    );
    expect(pathInput(container).value).toBe("image-42-annotated.png");
  });

  it("export: the canvas encode lands through saveImageFile, then onSaved + close", async () => {
    vi.mocked(renderAnnotatedBlob).mockResolvedValueOnce(
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
    );
    const onSaved = vi.fn();
    const onClose = vi.fn();
    mount({ onSaved, onClose });
    fireEvent.click(screen.getByText("export"));
    await waitFor(() =>
      expect(saveImageFile).toHaveBeenCalledWith(
        "/home/u/rolls/2026-01/sub/IMG_0001-annotated.png",
        expect.any(Uint8Array)
      )
    );
    expect(renderAnnotatedBlob).toHaveBeenCalledWith(
      IMG,
      [face(1)],
      "png",
      null, // blank max dimension = original
      expect.any(Function)
    );
    // #299: the baked-in label is the PERSON name, not the face name
    const labelFor = vi.mocked(renderAnnotatedBlob).mock
      .calls[0]![4] as (f: Face) => string;
    expect(labelFor(face(1))).toBe("Alice");
    // an unresolvable person falls back to the face name
    expect(labelFor({ ...face(1), person_id: 99 })).toBe("alice");
    expect(labelFor({ ...face(1), person_id: null })).toBe("alice");
    expect(onSaved).toHaveBeenCalledWith(
      "/home/u/rolls/2026-01/sub/IMG_0001-annotated.png"
    );
    // the host unmounts on onClose (App's state) — the dialog itself
    // stays mounted here (a bare vi.fn() never closes it)
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a typed max dimension is parsed and passed through", async () => {
    vi.mocked(renderAnnotatedBlob).mockResolvedValueOnce(
      new Blob([new Uint8Array([1])], { type: "image/jpeg" })
    );
    const { container } = mount();
    const sel = container.querySelector<HTMLSelectElement>("select")!;
    fireEvent.change(sel, { target: { value: "jpeg" } });
    const maxDim =
      container.querySelector<HTMLInputElement>("input[inputmode='numeric']")!;
    fireEvent.change(maxDim, { target: { value: "1500" } });
    fireEvent.click(screen.getByText("export"));
    await waitFor(() =>
      expect(renderAnnotatedBlob).toHaveBeenCalledWith(
        IMG,
        [face(1)],
        "jpeg",
        1500,
        expect.any(Function)
      )
    );
  });

  it("a failed encode reaches onError and the dialog stays open", async () => {
    vi.mocked(renderAnnotatedBlob).mockResolvedValueOnce(null);
    const onError = vi.fn();
    const onClose = vi.fn();
    const { container } = mount({ onError, onClose });
    fireEvent.click(screen.getByText("export"));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "no preview available for this image"
      )
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector(".overlay")).toBeTruthy();
  });

  it("browse: the native save dialog's pick replaces the path (filtered to the format)", async () => {
    vi.mocked(save).mockResolvedValueOnce("/tmp/out/IMG_0001-annotated.jpg");
    const { container } = mount();
    const sel = container.querySelector<HTMLSelectElement>("select")!;
    fireEvent.change(sel, { target: { value: "jpeg" } });
    fireEvent.click(screen.getByText("browse"));
    await waitFor(() =>
      expect(pathInput(container).value).toBe(
        "/tmp/out/IMG_0001-annotated.jpg"
      )
    );
    expect(save).toHaveBeenCalledWith({
      defaultPath: "/home/u/rolls/2026-01/sub/IMG_0001-annotated.png",
      filters: [{ name: "JPEG", extensions: ["jpg"] }],
    });
  });

  it("Esc closes (the dialog owns the keyboard, #138)", () => {
    const onClose = vi.fn();
    mount({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
