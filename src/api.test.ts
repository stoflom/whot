// #227 — the api.ts image-batch re-request loop: a byte-capped backend
// response defers ids instead of losing them, a single-id miss is cached
// as "no blob", and an all-missing batch costs exactly one IPC call.
// Run: npm test (vitest run)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { facePreview, splitImageBatch } from "./api";
import { encodeImageBatch } from "./imageBatch";

// the Tauri invoke is mocked at the module boundary; append any promises
// BELOW with `await` so both flush rounds have settled before the asserts
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const blobBytes = (k: number, len: number) => Uint8Array.from({ length: len }, () => k);

beforeEach(() => {
  invoke.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("splitImageBatch (#227 truncation contract)", () => {
  it("a truncatable batch defers its unserved ids for a re-request", () => {
    const r = splitImageBatch([1, 2, 3], [1]);
    expect(r.missing).toEqual([]);
    expect(r.deferred).toEqual([2, 3]);
  });

  it("an empty served set is all-genuine misses: nothing is re-requested", () => {
    const r = splitImageBatch([9, 99], []);
    expect(r.missing).toEqual([9, 99]);
    expect(r.deferred).toEqual([]);
  });

  it("a single-id response is never truncatable — its miss is genuine", () => {
    const r = splitImageBatch([4], []);
    expect(r.missing).toEqual([4]);
    expect(r.deferred).toEqual([]);
  });

  it("a full response defers nothing", () => {
    const r = splitImageBatch([1, 2], [1, 2]);
    expect(r).toEqual({ missing: [], deferred: [] });
  });
});

describe("facePreview re-request loop (#227)", () => {
  it("a byte-capped multi-id response re-requests the deferred ids", async () => {
    // call 1: id 3 requested alongside 1/2 but deferred by the cap
    invoke.mockResolvedValueOnce(encodeImageBatch([
      { id: 1, bytes: blobBytes(0x11, 8) },
      { id: 2, bytes: blobBytes(0x22, 8) },
    ]));
    // call 2: the deferred round — only the deferred ids
    invoke.mockResolvedValueOnce(encodeImageBatch([
      { id: 3, bytes: blobBytes(0x33, 8) },
    ]));
    const urls = await Promise.all([facePreview(1), facePreview(2), facePreview(3)]);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0][1]).toMatchObject({ kind: "face", ids: [1, 2, 3] });
    expect(invoke.mock.calls[1][1]).toMatchObject({ kind: "face", ids: [3] });
    expect(urls.every(Boolean)).toBe(true);
  });

  it("a single-id miss is cached as null and never re-requested", async () => {
    invoke.mockResolvedValueOnce(encodeImageBatch([]));
    expect(await facePreview(999)).toBeNull();
    expect(await facePreview(999)).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][1]).toMatchObject({ kind: "face", ids: [999] });
  });

  it("an all-missing batch does not re-request anything (zero served ⇒ no cap)", async () => {
    invoke.mockResolvedValue(encodeImageBatch([]));
    const [a, b] = await Promise.all([facePreview(990), facePreview(991)]);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][1]).toMatchObject({ kind: "face", ids: [990, 991] });
  });
});
