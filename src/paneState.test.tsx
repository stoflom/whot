// #226 (F-M6) + #283 (N8) — the pane-drag throttle: raw `mousemove`
// events coalesce into at most ONE state update per animation frame (the
// old listener ran setPaneSizes/setRollCenter per event — one whole-App
// render per mousemove), and `mouseup` cancels the armed frame and
// commits the pending position, so the committed size is the pointer's
// last word. The throttle is observed at the source: how many rAF
// callbacks arm per burst (each armed frame applies at most once), and
// what the committed state ends up as (the burst's LAST position).
// Run: npm test (vitest run; jsdom pragma — window listeners + rAF)
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { usePaneSizes, type PaneSizesApi } from "./paneState";

let api: PaneSizesApi | null = null;

function Probe() {
  api = usePaneSizes(false);
  return <div data-testid="probe" />;
}

const fire = (type: string, x: number) => {
  window.dispatchEvent(new MouseEvent(type, { clientX: x, bubbles: true }));
};

describe("usePaneSizes — the drag rAF throttle (#226 F-M6 / #283 N8)", () => {
  let raf: ReturnType<typeof vi.fn>;
  let frame: (cb: () => void) => number;

  const mdown = (edge: "left" | "right", x: number) =>
    act(() => {
      (api as PaneSizesApi).startDrag(edge)(
        new MouseEvent("mousedown", { clientX: x }) as never,
      );
    });

  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom's rAF is a real async hop; fake-timer rAF runs under
    // advanceTimersByTime — route it through a spy to count arms
    frame = window.requestAnimationFrame;
    raf = vi.fn(frame);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(raf as never);
    render(<Probe />);
  });
  afterEach(() => {
    fire("mouseup", 0); // end any live drag (its listeners detach)
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a burst of mousemoves inside one frame arms ONE rAF and commits the last x", () => {
    mdown("right", 300);
    act(() => {
      fire("mousemove", 310);
      fire("mousemove", 320);
      fire("mousemove", 330);
      fire("mousemove", 340);
      expect(raf).toHaveBeenCalledTimes(1); // armed on the FIRST move only
      vi.advanceTimersByTime(16);
    });
    // one frame ran → the whole burst applied ONCE, the last position:
    // right = start(290) − dx(340 − 300) = 250
    expect(api?.paneSizes.right).toBe(250);
    expect(raf).toHaveBeenCalledTimes(1);
  });

  it("after a frame ran, a new burst arms a fresh frame (one arm per frame)", () => {
    mdown("left", 100);
    act(() => {
      fire("mousemove", 110);
      vi.advanceTimersByTime(16); // frame 1 commits 110
      fire("mousemove", 130);
      fire("mousemove", 150);
      vi.advanceTimersByTime(16); // frame 2 commits 150
    });
    expect(raf).toHaveBeenCalledTimes(2);
    // left = start(250) + dx(150 − 100) = 300 — the burst's LAST word
    expect(api?.paneSizes.left).toBe(300);
  });

  it("mouseup cancels the armed frame, commits the pending position once, and detaches", () => {
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    mdown("left", 0);
    act(() => {
      fire("mousemove", 40);
      fire("mouseup", 40); // the frame never runs — the flush commits
    });
    expect(cancel).toHaveBeenCalledTimes(1); // the armed frame was cancelled
    expect(api?.paneSizes.left).toBe(250 + 40);
    const armed = raf.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(64);
      fire("mousemove", 60); // drag over: the listener is detached
    });
    expect(raf).toHaveBeenCalledTimes(armed); // nothing re-armed after up
    expect(api?.paneSizes.left).toBe(290);
  });

  it("clamps while dragging (the 200..560 right-pane floor)", () => {
    mdown("right", 300);
    act(() => {
      fire("mousemove", 500); // would be 290 − 200 = 90 → clamped 200
      vi.advanceTimersByTime(16);
    });
    expect(api?.paneSizes.right).toBe(200);
  });
});

// #329 — an interrupted drag (pointercancel, window blur, unmount) must
// end it the way mouseup does: commit the last word, detach EVERY
// listener. Before #329 only mouseup removed the listeners — an
// interrupted drag left them attached and dragRef set, so every later
// mousemove kept resizing the panes.
describe("usePaneSizes — the drag end cleanup (#329)", () => {
  let raf: ReturnType<typeof vi.fn>;

  const mdown = (edge: "left" | "right", x: number) =>
    act(() => {
      (api as PaneSizesApi).startDrag(edge)(
        new MouseEvent("mousedown", { clientX: x }) as never,
      );
    });

  beforeEach(() => {
    vi.useFakeTimers();
    raf = vi.fn(window.requestAnimationFrame);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(raf as never);
    render(<Probe />);
  });
  afterEach(() => {
    fire("mouseup", 0); // end any live drag (its listeners detach)
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pointercancel ends the drag — later moves are ignored", () => {
    mdown("left", 100);
    act(() => {
      fire("mousemove", 140);
      vi.advanceTimersByTime(16); // frame commits left = 290
    });
    expect(api?.paneSizes.left).toBe(290);
    const armed = raf.mock.calls.length;
    act(() => {
      fire("pointercancel", 0); // the webview lost the pointer
      vi.advanceTimersByTime(64);
      fire("mousemove", 300); // an interrupted drag must not resize
    });
    expect(raf).toHaveBeenCalledTimes(armed); // the listeners are gone
    expect(api?.paneSizes.left).toBe(290);
  });

  it("window blur ends the drag (focus loss — mouseup may never arrive)", () => {
    mdown("right", 300);
    act(() => {
      fire("mousemove", 320);
      vi.advanceTimersByTime(16); // right = 290 − 20 = 270
    });
    expect(api?.paneSizes.right).toBe(270);
    const armed = raf.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event("blur"));
      vi.advanceTimersByTime(64);
      fire("mousemove", 400); // must not resize after the focus loss
    });
    expect(raf).toHaveBeenCalledTimes(armed);
    expect(api?.paneSizes.right).toBe(270);
  });

  it("unmount ends a live drag — no listener survives to arm frames", () => {
    mdown("left", 100);
    act(() => {
      fire("mousemove", 140);
      vi.advanceTimersByTime(16); // commit 290; the drag is still live
    });
    cleanup(); // the probe unmounts mid-drag
    const armed = raf.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(64);
      fire("mousemove", 300); // would re-arm if the listeners survived
    });
    expect(raf).toHaveBeenCalledTimes(armed);
  });

  it("a second mousedown mid-drag does not double-bind the listeners", () => {
    mdown("left", 100);
    mdown("right", 200); // a drag is live — must be a no-op
    act(() => {
      fire("mousemove", 140);
      vi.advanceTimersByTime(16); // left = 290
      fire("mouseup", 140); // the ONE end — it must detach everything
    });
    expect(api?.paneSizes.left).toBe(290);
    const armed = raf.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(64);
      fire("mousemove", 300); // a second bound pair would re-arm here
    });
    expect(raf).toHaveBeenCalledTimes(armed);
    expect(api?.paneSizes.left).toBe(290);
  });
});