import { useEffect, useState } from "react";
import { facePreview, imagePreview, imageThumb } from "./api";
import { LruCache } from "./lruCache";
export { imagePreview, facePreview }; // #122: useRotatedImage callers pass their loader

function useCached(loader: (id: number) => Promise<string | null>, id: number | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (id == null) {
      setUrl(null);
      return;
    }
    let live = true;
    setUrl(null);
    loader(id).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [id, loader]);
  return url;
}

// id may be null (no primary face yet) — the hook is called unconditionally
// to keep the hook count stable between renders (F4)

export const useFaceImage = (id: number | null) => useCached(facePreview, id);
export const useImageThumbImg = (id: number) => useCached(imageThumb, id);
export const useImagePreviewImg = (id: number) => useCached(imagePreview, id);

// #122 — display rotation is server state (faces.rotation /
// images.rotation, 0/90/180/270 CW). The renderer applies it by rotating
// the loaded preview pixels once (canvas), memoised per (id, rotation) —
// switching views never re-encodes.
//
// #221 (F-H1): the cache holds Blob URLs (canvas.toBlob →
// URL.createObjectURL), not base64 data URLs — a rotated full-size photo
// costs its compressed bytes, not ≈4/3 × as a JS string — and the LRU
// cap bounds the session: evicted entries revoke their Blob URL (the
// same contract as the api.ts preview caches). The cap is small because
// a full-size JPEG blob is MB-scale; a re-encode on a cap-evicted
// (id, rotation) pair is the same cost the first view paid.
export const ROTATED_CACHE_CAP = 24;
export const rotatedCache = new LruCache<string, string>(
  ROTATED_CACHE_CAP,
  (_key, url) => URL.revokeObjectURL(url)
);

/** the rotated pixels as a fresh Blob URL, or null when the canvas
    path failed (the caller falls back to the unrotated base — a
    failure is never cached: the fallback IS the base URL, which the
    api.ts cache owns and revokes) */
function rotateCanvas(url: string, rotation: number): Promise<string | null> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      try {
        const swap = rotation === 90 || rotation === 270;
        const c = document.createElement("canvas");
        c.width = swap ? im.naturalHeight : im.naturalWidth;
        c.height = swap ? im.naturalWidth : im.naturalHeight;
        const ctx = c.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.drawImage(im, -im.naturalWidth / 2, -im.naturalHeight / 2);
        c.toBlob((b) => resolve(b ? URL.createObjectURL(b) : null), "image/jpeg", 0.92);
      } catch {
        resolve(null); // fallback: unrotated beats missing
      }
    };
    im.onerror = () => resolve(null);
    im.src = url;
  });
}

export function useRotatedImage(
  loader: (id: number) => Promise<string | null>,
  id: number | null,
  rotation: number,
): string | null {
  const base = useCached(loader, id);
  const [out, setOut] = useState<string | null>(null);
  useEffect(() => {
    if (!base) {
      setOut(null);
      return;
    }
    if (!rotation) {
      setOut(base);
      return;
    }
    const key = `${id}:${rotation}`;
    const hit = rotatedCache.get(key);
    if (hit) {
      setOut(hit);
      return;
    }
    let live = true;
    setOut(null);
    rotateCanvas(base, rotation).then((u) => {
      // a failed encode resolves null — fall back to the unrotated base
      // and cache nothing (the base URL belongs to the api.ts cache)
      if (u) rotatedCache.set(key, u);
      if (live) setOut(u ?? base);
    });
    return () => {
      live = false;
    };
  }, [base, rotation, id]);
  return out;
}
