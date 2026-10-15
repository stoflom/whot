import { useEffect, useState } from "react";
import { facePreview, imagePreview, imageThumb } from "./api";

function useCached(loader: (id: number) => Promise<string | null>, id: number) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
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

export const useFaceImage = (id: number) => useCached(facePreview, id);
export const useImageThumbImg = (id: number) => useCached(imageThumb, id);
export const useImagePreviewImg = (id: number) => useCached(imagePreview, id);
