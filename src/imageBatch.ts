// #212 — the image-batch wire format: ONE binary IPC response carries
// many images as raw JPEG bytes (no base64, ~33% smaller transfers).
// Pure encode/decode, mirrored on the Rust side by
// `db::encode_image_batch` — the tests round-trip both directions here
// and the gui-mock's encoder reuses the same layout.
//
// Layout (little-endian):
//   8 bytes  magic "WHOTIMG\x01"
//   u32      count
//   count ×  { i64 id, u32 offset, u32 length }  (offsets into the blob area)
//   blob area: the concatenated image bytes

const MAGIC = "WHOTIMG\x01";

export interface BatchEntry {
  id: number;
  bytes: Uint8Array;
}

export function encodeImageBatch(entries: BatchEntry[]): Uint8Array {
  const headerLen = MAGIC.length + 4 + entries.length * 16;
  let blobLen = 0;
  for (const e of entries) blobLen += e.bytes.length;
  const out = new Uint8Array(headerLen + blobLen);
  for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC.charCodeAt(i);
  const head = new DataView(out.buffer);
  head.setUint32(MAGIC.length, entries.length, true);
  let off = 0;
  entries.forEach((e, i) => {
    const at = MAGIC.length + 4 + i * 16;
    head.setBigInt64(at, BigInt(e.id), true);
    head.setUint32(at + 8, off, true);
    head.setUint32(at + 12, e.bytes.length, true);
    out.set(e.bytes, headerLen + off);
    off += e.bytes.length;
  });
  return out;
}

export function decodeImageBatch(buf: ArrayBuffer | Uint8Array): Map<number, Uint8Array> {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const out = new Map<number, Uint8Array>();
  if (bytes.length < MAGIC.length + 4) return out;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) return out; // not our frame — nothing to give
  }
  const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = head.getUint32(MAGIC.length, true);
  const headerLen = MAGIC.length + 4 + count * 16;
  if (bytes.length < headerLen) return out;
  for (let i = 0; i < count; i++) {
    const at = MAGIC.length + 4 + i * 16;
    const id = Number(head.getBigInt64(at, true));
    const off = head.getUint32(at + 8, true);
    const len = head.getUint32(at + 12, true);
    if (headerLen + off + len > bytes.length) continue; // truncated entry — skip
    out.set(id, bytes.subarray(headerLen + off, headerLen + off + len));
  }
  return out;
}
