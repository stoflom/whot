import { useEffect, useState } from "react";
import { facePreview, imagePreview, imageThumb } from "./api";
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
const rotatedCache = new Map<string, { base: string; out: string }>();

function rotateCanvas(url: string, rotation: number): Promise<string> {
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
          resolve(url);
          return;
        }
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.drawImage(im, -im.naturalWidth / 2, -im.naturalHeight / 2);
        resolve(c.toDataURL("image/jpeg", 0.92));
      } catch {
        resolve(url); // fallback: unrotated beats missing
      }
    };
    im.onerror = () => resolve(url);
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
    if (hit && hit.base === base) {
      setOut(hit.out);
      return;
    }
    let live = true;
    setOut(null);
    rotateCanvas(base, rotation).then((u) => {
      rotatedCache.set(key, { base, out: u });
      if (live) setOut(u);
    });
    return () => {
      live = false;
    };
  }, [base, rotation, id]);
  return out;
}
