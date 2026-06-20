import {
  getGeminiFallbackRegion as getPaddedGeminiFallbackRegion,
} from "@/lib/image/gemini-position";
import {
  buildGeminiCache,
  buildGeminiManualCache,
  type GeminiNccCache,
} from "@/lib/image/gemini-ncc-removal";
import type { Region } from "@/lib/image/region";
import type { WatermarkMethod } from "@/lib/image/watermark-removal";

/** 알파 맵 강도 보정 — 1.0이 정확한 역산값 */
const DEFAULT_ALPHA_GAIN = 1;
const LOGO_WHITE = "#FFFFFF";

export type GeminiPresetSettings = {
  method: WatermarkMethod;
  region: Region;
  color: string;
  alpha: number;
  cache: GeminiNccCache;
};

export const GEMINI_PRESET_LABEL = "Gemini ✦ (나노바나나)";
export const GEMINI_MANUAL_LABEL = "나노바나나 워터마크 제거";

export const GEMINI_PRESET_DESCRIPTION =
  "이미지 픽셀에서 ✦ 로고를 자동 탐지합니다. (실험적)";

export const GEMINI_MANUAL_DESCRIPTION =
  "마스크로 ✦ 로고 영역을 직접 지정한 뒤, 보정된 알파 맵으로 역블렌딩합니다.";

export function imageDataFromImage(img: HTMLImageElement): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas를 사용할 수 없습니다.");
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function buildGeminiPreset(
  imageData: ImageData,
  imageKey: string,
): GeminiPresetSettings {
  const cache = buildGeminiCache(imageData, imageKey);
  return {
    method: "inverse-alpha",
    region: cache.region,
    color: LOGO_WHITE,
    alpha: DEFAULT_ALPHA_GAIN,
    cache,
  };
}

export function buildGeminiManualRemoval(
  imageData: ImageData,
  imageKey: string,
  region: Region,
): GeminiPresetSettings {
  const cache = buildGeminiManualCache(imageData, imageKey, region);
  return {
    method: "inverse-alpha",
    region: cache.region,
    color: LOGO_WHITE,
    alpha: DEFAULT_ALPHA_GAIN,
    cache,
  };
}

export function getGeminiFallbackRegion(
  imageWidth: number,
  imageHeight: number,
): Region {
  return getPaddedGeminiFallbackRegion(imageWidth, imageHeight);
}
