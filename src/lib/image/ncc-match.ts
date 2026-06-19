import {
  detectWatermarkMatch,
  isWatermarkDetected,
  type WatermarkMatchResult,
} from "@/lib/image/watermark-detector";
import {
  resolveAlphaMapKey,
  resolveGeminiWatermarkSearchConfigs,
} from "@/lib/image/gemini-size-catalog";

export type { WatermarkMatchResult };

export function findWatermarkPosition(
  data: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
): WatermarkMatchResult {
  return detectWatermarkMatch(data, imageWidth, imageHeight);
}

export { isWatermarkDetected };

export type NccMatchResult = WatermarkMatchResult;

export function getFallbackMatch(
  imageWidth: number,
  imageHeight: number,
): WatermarkMatchResult {
  const configs = resolveGeminiWatermarkSearchConfigs(imageWidth, imageHeight);
  const config = configs[0] ?? { logoSize: 48, marginRight: 32, marginBottom: 32 };
  const x = imageWidth - config.marginRight - config.logoSize;
  const y = imageHeight - config.marginBottom - config.logoSize;

  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    score: 0,
    templateSize: config.logoSize,
    config,
    alphaMapKey: String(resolveAlphaMapKey(config)),
    spatialScore: 0,
    gradientScore: 0,
    detectionSource: "fallback",
    suppressionGain: 0,
  };
}
