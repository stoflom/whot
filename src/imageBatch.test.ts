// #212 — the image-batch wire format.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { decodeImageBatch, encodeImageBatch } from "./imageBatch";

const b = (...xs: number[]) => Uint8Array.from(xs);

describe("image batch framing (#212)", () => {
  it("round-trips entries with their bytes", () => {
    const enc = encodeImageBatch([
      { id: 7, bytes: b(1, 2, 3) },
      { id: 123456789, bytes: b(9) },
      { id: 3, bytes: b() },
    ]);
    const dec = decodeImageBatch(enc);
    expect([...dec.keys()].sort((x, y) => x - y)).toEqual([3, 7, 123456789]);
    expect([...dec.get(7)!]).toEqual([1, 2, 3]);
    expect([...dec.get(123456789)!]).toEqual([9]);
    expect([...dec.get(3)!]).toEqual([]);
  });

  it("round-trips an empty batch", () => {
    const dec = decodeImageBatch(encodeImageBatch([]));
    expect(dec.size).toBe(0);
  });

  it("accepts the ArrayBuffer form (what Tauri invoke delivers)", () => {
    const enc = encodeImageBatch([{ id: 1, bytes: b(4, 5) }]);
    const copy = enc.slice().buffer;
    const dec = decodeImageBatch(copy);
    expect([...dec.get(1)!]).toEqual([4, 5]);
  });

  it("ignores foreign or truncated payloads", () => {
    expect(decodeImageBatch(b()).size).toBe(0);
    expect(decodeImageBatch(b(1, 2, 3, 4, 5, 6, 7, 8, 9)).size).toBe(0);
    const enc = encodeImageBatch([{ id: 1, bytes: b(4, 5) }]);
    expect(decodeImageBatch(enc.subarray(0, enc.length - 1)).size).toBe(0);
    expect(decodeImageBatch(enc.subarray(0, 10)).size).toBe(0);
  });
});
