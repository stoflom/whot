// ErrorNotice — selectable, copyable error display (design §4.26, #81).
//
// Every error surfaced by the app must be cleanly copyable for filing
// issues: the text is selectable and wraps instead of clipping, a Copy
// button puts the FULL message on the clipboard, and dismissal is an
// explicit ✕ — clicking/selecting the text never dismisses it.
import { useState } from "react";

async function copyText(text: string): Promise<boolean> {
  // secure contexts (tauri://) have the async clipboard API...
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy path */
    }
  }
  // ...everything else gets a hidden textarea + execCommand
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  let ok: boolean;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const title = state === "ok" ? "copied!" : state === "fail" ? "copy failed — select the text and copy manually" : "copy to clipboard";
  return (
    <button
      type="button"
      className="err-copy"
      title={title}
      onClick={() => {
        void copyText(text).then((ok) => {
          setState(ok ? "ok" : "fail");
          window.setTimeout(() => setState("idle"), 1500);
        });
      }}
    >
      {state === "ok" ? "✓ copied" : state === "fail" ? "✗ failed" : label}
    </button>
  );
}

/** Runtime error toast (design §4.26): text + Copy + explicit ✕. */
export function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="toast" role="alert">
      <span className="toast-text">{message}</span>
      <CopyButton text={message} />
      <button type="button" className="err-dismiss" title="dismiss" aria-label="dismiss error" onClick={onDismiss}>
        ✕
      </button>
    </div>
  );
}

/** Fatal load-failure screen (design §4.26): selectable text + Copy. */
export function FatalError({ title, message }: { title: string; message: string }) {
  return (
    <div className="fatal">
      <h2>{title}</h2>
      <p className="fatal-text">{message}</p>
      <CopyButton text={`${title}\n${message}`} label="Copy error" />
    </div>
  );
}
