// #331 — the top bar subtree, extracted verbatim from App.tsx's render
// (the header element: the mark, the three mode tabs, the busy roller,
// the global Show filter + padlock, the DB-wide status totals and the
// ↻ / ? / ⚙ buttons). App stays the state owner — the props ARE the
// existing values and callbacks, relocated; no behaviour change. The
// contract suite (C1–C74) pins the surface.
import type { FaceFilter } from "../viewFilters";
import type { Mode } from "../sections";

export interface StatusTotals {
  provisional: number;
  confirmed: number;
  rejected: number;
}

interface Props {
  mode: Mode;
  pendingCount: number;
  busy: boolean;
  faceFilter: FaceFilter;
  statusTotals: StatusTotals;
  personId: number | null;
  /** the #123 drop-or-accept guard wrapping every tab switch */
  confirmContext: (fn: () => void) => Promise<unknown> | void;
  setMode: (m: Mode) => void;
  setImageId: (id: number | null) => void;
  setSplitImageId: (id: number | null) => void;
  /** #176 (§4.41): the Person tab with no anchor opens the picker */
  setPickPersonDialog: (v: boolean) => void;
  changeFaceFilter: (f: FaceFilter) => void;
  refresh: () => Promise<unknown>;
  setError: (e: string | null) => void;
  setHelpOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
}

export default function TopBar({
  mode,
  pendingCount,
  busy,
  faceFilter,
  statusTotals,
  personId,
  confirmContext,
  setMode,
  setImageId,
  setSplitImageId,
  setPickPersonDialog,
  changeFaceFilter,
  refresh,
  setError,
  setHelpOpen,
  setSettingsOpen,
}: Props) {
  return (
    <header className="topbar">
      {/* #198 (§4.9): the whot mark beside the title */}
      <img className="topbar-logo" src="/whot.svg" alt="" />
      <h1>WhoT <span className="dim">Face Manager</span></h1>
      <nav>
        <button
          className={mode === "review" ? "active" : ""}
          onClick={() =>
            // #123: a tab switch is a view-context change
            confirmContext(() => {
              setMode("review");
              setImageId(null);
              setSplitImageId(null); // #55 (§4.19): explicit navigation ends focus mode
            })
          }
        >
          Review <span className="pill">{pendingCount}</span>
        </button>
        <button
          className={mode === "rolls" ? "active" : ""}
          onClick={() =>
            confirmContext(() => {
              setMode("rolls");
              setSplitImageId(null); // #55 (§4.19)
            })
          }
        >
          Rolls
        </button>
        <button
          className={mode === "person" ? "active" : ""}
          onClick={() =>
            confirmContext(() => {
              setMode("person");
              setImageId(null);
              setSplitImageId(null); // #55 (§4.19)
              // #176 (§4.41): no anchor yet — land in Person mode with
              // Show → All (the status branches are listed) and point
              // at the tree
              if (personId == null) {
                changeFaceFilter("all");
                setPickPersonDialog(true);
              }
            })
          }
          title={
            personId == null
              ? "no person anchored yet — pick one in the tree"
              : undefined
          }
        >
          Person
        </button>
      </nav>
      <span className="topbar-right">
        {busy && (
          <>
            {/* #100: an animated roller — a static word is too easy to miss */}
            <span className="busy-roller" title="working…" />
            <span className="dim">working…</span>
          </>
        )}
        {/* #158 (§3, v3.57): the Show filter lives in the top bar — it is
            a global control applied across all panes (#99, §4.10) and not
            something the Person view (or any single pane) owns. #305:
            All includes rejected faces (#165/§4.10);
            #175/§4.40: locked to New while Review runs —
            the titles stay reference-free (§4.43) */}
        <label
          title={
            mode === "review"
              ? "Locked to New while Review is active — leave Review via the Rolls or Person tab"
              : "All = every face, including rejected; switching it drops hidden faces from the selection"
          }
        >
          show
          <select
            value={faceFilter}
            disabled={mode === "review"}
            // #176 (§4.41): the closed value speaks the status colour
            className={`st-${faceFilter}`}
            onChange={(e) => changeFaceFilter(e.target.value as FaceFilter)}
          >
            <option value="all">All</option>
            <option value="provisional">New</option>
            <option value="confirmed">Accepted</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
        {/* #188 (§4.40): the padlock is a pure INDICATOR — 🔒 exactly
            while Review mode is active (Show pinned New + disabled);
            never clickable, no engage/release. #175: its tooltips stay
            reference-free (§4.43) */}
        <span
          className={`lock-btn${mode === "review" ? " locked" : ""}`}
          title={
            mode === "review"
              ? "Show is locked to New while Review is active — leave via the Rolls or Person tab"
              : "Show is unlocked outside Review"
          }
        >
          {mode === "review" ? "🔒" : "🔓"}
        </span>
        {/* #179 (§4.41): the DB-wide status totals — always visible,
            an overview of the database; never scoped to the anchor,
            the mode or the filter */}
        <span className="status-counts" title="totals in the database">
          <span className="c-prov" title="new faces">★ {statusTotals.provisional}</span>
          <span className="c-conf" title="accepted faces">✓ {statusTotals.confirmed}</span>
          <span className="c-rej" title="rejected faces">✗ {statusTotals.rejected}</span>
        </span>
        <button
          className="ghost"
          onClick={() => refresh().catch((e) => setError(String(e)))}
          title="Refresh"
        >
          ↻
        </button>
        {/* v12.2 (#279): ? opens the shortcuts help screen — ? is now
            taken in the top bar, which is why the New totals chip
            became ★ */}
        <button
          className="ghost"
          onClick={() => setHelpOpen(true)}
          title="Keyboard shortcuts"
        >
          ?
        </button>
        <button className="ghost" onClick={() => setSettingsOpen(true)} title="Settings">
          ⚙
        </button>
      </span>
    </header>
  );
}
