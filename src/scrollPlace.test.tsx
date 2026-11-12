// #203/#264 (gui-design §4.40) — the centre grid keeps its scroll place:
// saved while the grid is on screen (active), never overwritten while the
// full image is open (inactive — the focus view's own scroll), restored
// whenever the grid returns (active flips on, or the mode key changes).
// Run: npm test (vitest run; jsdom pragma — a mounted hook)
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useScrollPlace } from "./scrollPlace";
import {
  parseSession,
  serializeSession,
  SESSION_STORAGE_KEY,
} from "./sessionState";
import type { Mode } from "./sections";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// the mode is prop `k` — `key` is reserved by React
function Harness({
  active,
  k,
  persist,
}: {
  active: boolean;
  k: number;
  persist?: Mode;
}) {
  const sp = useScrollPlace(k, active, persist);
  return (
    <div
      className="scroller"
      ref={sp.ref}
      onScroll={sp.onScroll}
      style={{ height: 100, overflow: "auto" }}
    >
      <div style={{ height: 1000 }} />
    </div>
  );
}

const scroller = () => document.querySelector<HTMLElement>(".scroller")!;

describe("useScrollPlace (#203/#264, §4.40)", () => {
  it("saves the place while the grid is on screen", () => {
    render(<Harness active k={1} />);
    act(() => {
      scroller().scrollTop = 120;
      fireEvent.scroll(scroller());
    });
    expect(scroller().scrollTop).toBe(120);
  });

  it("the full image's scroll (inactive) never overwrites the saved place", () => {
    const { rerender } = render(<Harness active k={1} />);
    act(() => {
      scroller().scrollTop = 120;
      fireEvent.scroll(scroller());
    });
    rerender(<Harness active={false} k={1} />);
    // while the focus view is open the container scrolls freely…
    act(() => {
      scroller().scrollTop = 500;
      fireEvent.scroll(scroller());
    });
    // …and closing the full view restores the GRID's place
    rerender(<Harness active k={1} />);
    expect(scroller().scrollTop).toBe(120);
  });

  it("a mode change (key) with the grid on screen re-restores the place", () => {
    const { rerender } = render(<Harness active k={1} />);
    act(() => {
      scroller().scrollTop = 300;
      fireEvent.scroll(scroller());
    });
    // the mode switch remounts the grid fresh at the top…
    scroller().scrollTop = 0;
    // …and the restore effect puts the saved place back
    rerender(<Harness active k={2} />);
    expect(scroller().scrollTop).toBe(300);
  });
});

// #297 (rule 50) — the optional persistence: the place also survives an
// app restart, under the ONE session blob (per-mode field)
describe("useScrollPlace persistence (#297, rule 50)", () => {
  it("writes the active place into the session blob (throttled)", () => {
    vi.useFakeTimers();
    localStorage.clear();
    render(<Harness active k={1} persist="review" />);
    act(() => {
      scroller().scrollTop = 120;
      fireEvent.scroll(scroller());
    });
    expect(parseSession(localStorage.getItem(SESSION_STORAGE_KEY))?.scroll)
      .toBeUndefined(); // not yet — the debounce has not fired
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const b = parseSession(localStorage.getItem(SESSION_STORAGE_KEY));
    expect(b?.scroll).toEqual({ review: 120 });
  });

  it("restores the persisted place on the first activation", () => {
    localStorage.clear();
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      serializeSession({ v: 1, scroll: { person: 250 } }),
    );
    render(<Harness active k={1} persist="person" />);
    expect(scroller().scrollTop).toBe(250);
  });

  it("no persisted place → the top (0), as before", () => {
    localStorage.clear();
    render(<Harness active k={1} persist="rolls" />);
    expect(scroller().scrollTop).toBe(0);
  });
});
