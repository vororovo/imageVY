/** Gemini/나노바나나 워터마크 고정 규격 */

import type { GeminiWatermarkConfig } from "@/lib/image/gemini-size-catalog";
import {
  getWatermarkPositionFromConfig,
  resolveGeminiWatermarkSearchConfigs,
} from "@/lib/image/gemini-size-catalog";
import type { Region } from "@/lib/image/region";
import { clampRegion } from "@/lib/image/region";

export type { GeminiWatermarkConfig } from "@/lib/image/gemini-size-catalog";

export type GeminiLogoSpec = {
  logoSize: number;
  margin: number;
  marginRight: number;
  marginBottom: number;
  alphaVariant?: string;
};

function configToSpec(config: GeminiWatermarkConfig): GeminiLogoSpec {
  return {
    logoSize: config.logoSize,
    margin: config.marginRight,
    marginRight: config.marginRight,
    marginBottom: config.marginBottom,
    alphaVariant: config.alphaVariant,
  };
}

export function getGeminiLogoSpec(imageWidth: number, imageHeight: number): GeminiLogoSpec {
  const [primary] = resolveGeminiWatermarkSearchConfigs(imageWidth, imageHeight);
  return configToSpec(primary ?? { logoSize: 48, marginRight: 32, marginBottom: 32 });
}

export function getGeminiExpectedPosition(
  imageWidth: number,
  imageHeight: number,
  config?: GeminiWatermarkConfig,
): { x: number; y: number; spec: GeminiLogoSpec } {
  const resolved =
    config ?? resolveGeminiWatermarkSearchConfigs(imageWidth, imageHeight)[0];
  const spec = configToSpec(
    resolved ?? { logoSize: 48, marginRight: 32, marginBottom: 32 },
  );
  const { x, y } = getWatermarkPositionFromConfig(imageWidth, imageHeight, resolved!);

  return { x, y, spec };
}

export function getGeminiExpectedRegion(
  imageWidth: number,
  imageHeight: number,
  config?: GeminiWatermarkConfig,
): Region {
  const { x, y, spec } = getGeminiExpectedPosition(imageWidth, imageHeight, config);
  return clampRegion(
    { x, y, width: spec.logoSize, height: spec.logoSize },
    imageWidth,
    imageHeight,
  );
}

export { getRefineSearchForConfig, resolveGeminiWatermarkSearchConfigs } from "@/lib/image/gemini-size-catalog";
