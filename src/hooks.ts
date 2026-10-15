import { useEffect, useState } from "react";
import { facePreview, imagePreview, imageThumb } from "./api";

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
