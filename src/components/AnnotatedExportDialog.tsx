// #298 (gui-design v16.0, rule 51) — the annotated-image export
// dialog: file type (PNG/JPEG/WebP), size (original or a max
// dimension) and the save path (native save dialog to browse). The
// composite itself is exportAnnotated.renderAnnotatedBlob; the bytes
// land through the `save_image_file` command (a dumb Rust writer).
//
// The host owns opening/closing and the toasts (onSaved = quiet info,
// onError = the error toast, #144) — same reference-free contract as
// the other dialogs.

import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { useOwnsKeyboard } from "../overlays";
import { saveImageFile, type Face, type ImageRow } from "../api";
import {
  defaultExportName,
  FORMAT_EXT,
  FORMAT_LABEL,
  originalDir,
  renderAnnotatedBlob,
  type ExportFormat,
} from "../exportAnnotated";

interface Props {
  image: ImageRow;
  /** already visibility-filtered by the caller (§4.10) */
  faces: Face[];
  /** #299: resolves the PERSON name for a face's person — the label
      baked beneath each exported rectangle (null = the face name)
      */
  personName: (personId: number | null) => string | null;
  onClose: () => void;
  /** the written path — the caller's quiet info toast */
  onSaved: (path: string) => void;
  /** render/IPC failure — the caller's error toast */
  onError: (msg: string) => void;
}

const FORMATS: ExportFormat[] = ["png", "jpeg", "webp"];

export default function AnnotatedExportDialog({
  image,
  faces,
  personName,
  onClose,
  onSaved,
  onError,
}: Props) {
  useOwnsKeyboard(); // #138: an open dialog owns the keyboard
  // #248: Esc works from the dialog body too (the GroupDialog idiom)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const [format, setFormat] = useState<ExportFormat>("png");
  const [maxDim, setMaxDim] = useState("");
  // prefilled: the original's directory + <stem>-annotated.<ext>
  // (a BLOB-only image has no directory — just the name)
  const [path, setPath] = useState(() =>
    originalDir(image)
      ? originalDir(image) + "/" + defaultExportName(image, "png")
      : defaultExportName(image, "png")
  );
  const [busy, setBusy] = useState(false);

  const browse = async () => {
    try {
      const picked = await save({
        defaultPath: path,
        filters: [
          { name: FORMAT_LABEL[format], extensions: [FORMAT_EXT[format]] },
        ],
      });
      if (picked) setPath(picked);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const doExport = async () => {
    if (busy) return;
    const dim = Number(maxDim.trim());
    setBusy(true);
    try {
      const blob = await renderAnnotatedBlob(
        image,
        faces,
        format,
        Number.isFinite(dim) && dim > 0 ? dim : null,
        // #299: the person name — never the face name
        (f) => (f.person_id != null ? personName(f.person_id) ?? f.name : f.name),
      );
      if (!blob) throw new Error("no preview available for this image");
      if (!path.trim()) throw new Error("no save path");
      await saveImageFile(
        path.trim(),
        new Uint8Array(await blob.arrayBuffer()),
      );
      onSaved(path.trim());
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="dialog">
        <h3>Export annotated image</h3>
        <p className="dim">
          Saves the full image with every visible face's rectangle and
          person-name label baked in — the same overlay the viewer
          shows.
        </p>
        <div className="dialog-actions">
          <button className="secondary" onClick={onClose}>
            cancel
          </button>
          <button
            onClick={() => void doExport()}
            disabled={busy || !path.trim()}
          >
            {busy ? "exporting…" : "export"}
          </button>
        </div>
        <label>
          File type
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as ExportFormat)}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABEL[f]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Max dimension (px)
          <input
            value={maxDim}
            onChange={(e) => setMaxDim(e.target.value)}
            placeholder={`original ${image.width}×${image.height}`}
            inputMode="numeric"
          />
        </label>
        <label>
          Save path
          <div className="dialog-path-row">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <button
              className="secondary"
              onClick={() => void browse()}
              disabled={busy}
            >
              browse
            </button>
          </div>
        </label>
      </div>
    </div>
  );
}
