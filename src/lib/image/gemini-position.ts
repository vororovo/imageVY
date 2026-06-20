/** Gemini/나노바나나 워터마크 고정 규격 */

import type { GeminiWatermarkConfig } from "@/lib/image/gemini-size-catalog";
import {
  getWatermarkPositionFromConfig,
  resolveGeminiWatermarkSearchConfigs,
} from "@/lib/image/gemini-size-catalog";
import type { Region } from "@/lib/image/region";
import { clampRegion, padRegionAroundMatch, regionFromMatch } from "@/lib/image/region";

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
  return regionFromMatch(x, y, spec.logoSize, imageWidth, imageHeight);
}

/** 업로드 직후 UI에 표시할 여유 있는 초기 영역 */
export function getGeminiFallbackRegion(
  imageWidth: number,
  imageHeight: number,
  config?: GeminiWatermarkConfig,
): Region {
  const tight = getGeminiExpectedRegion(imageWidth, imageHeight, config);
  return padRegionAroundMatch(tight, imageWidth, imageHeight);
}

export { getRefineSearchForConfig, resolveGeminiWatermarkSearchConfigs } from "@/lib/image/gemini-size-catalog";
