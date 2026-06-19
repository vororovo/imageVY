import {
  applyGeminiWithCache,
  buildGeminiCache,
  type GeminiNccCache,
} from "@/lib/image/gemini-ncc-removal";
import { applyInverseAlphaBlend, type RgbColor } from "@/lib/image/inverse-alpha";
import { applyBinarization, applyInpainting } from "@/lib/image/inpainting";
import type { Region } from "@/lib/image/region";

export type WatermarkMethod = "inverse-alpha" | "inpainting" | "binarization";

export type WatermarkProcessOptions = {
  method: WatermarkMethod;
  region: Region;
  color: RgbColor;
  alpha: number;
  binarizationThreshold: number;
  binarizationInvert: boolean;
  colorTolerance: number;
  geminiOptimized?: boolean;
  geminiCache?: GeminiNccCache;
};

export type WatermarkProcessResult = {
  image: ImageData;
  detectedRegion?: Region;
  geminiDetected?: boolean;
  geminiCache?: GeminiNccCache;
};

export function createProcessedWatermarkImage(
  source: ImageData,
  options: WatermarkProcessOptions,
): ImageData {
  return createProcessedWatermark(source, options).image;
}

export function createProcessedWatermark(
  source: ImageData,
  options: WatermarkProcessOptions,
): WatermarkProcessResult {
  const copy = new ImageData(
    new Uint8ClampedArray(source.data),
    source.width,
    source.height,
  );

  if (options.geminiOptimized) {
    const cache =
      options.geminiCache ??
      buildGeminiCache(copy, `${copy.width}x${copy.height}`);

    applyGeminiWithCache(copy, cache, {
      globalAlpha: options.alpha,
      logoColor: options.color,
    });

    return {
      image: copy,
      detectedRegion: cache.region,
      geminiDetected: cache.detected,
      geminiCache: cache,
    };
  }

  switch (options.method) {
    case "inverse-alpha":
      applyInverseAlphaBlend(copy, options.region, {
        color: options.color,
        alpha: options.alpha,
      });
      break;
    case "inpainting":
      applyInpainting(copy, options.region);
      break;
    case "binarization":
      applyBinarization(copy, options.region, {
        threshold: options.binarizationThreshold,
        invert: options.binarizationInvert,
        color: options.color,
        colorTolerance: options.colorTolerance,
      });
      break;
  }

  return { image: copy };
}

export const WATERMARK_METHODS: {
  id: WatermarkMethod;
  label: string;
  description: string;
}[] = [
  {
    id: "inverse-alpha",
    label: "역알파 블렌딩",
    description: "워터마크 색상·투명도를 알 때 수학적으로 배경을 복원합니다.",
  },
  {
    id: "inpainting",
    label: "인페인팅",
    description: "마스크 영역을 경계 픽셀에서 안쪽으로 확장하며 채웁니다.",
  },
  {
    id: "binarization",
    label: "이진화",
    description: "밝기·색상 기준으로 워터마크 픽셀을 검출한 뒤 인페인팅합니다.",
  },
];

export type { GeminiNccCache } from "@/lib/image/gemini-ncc-removal";
