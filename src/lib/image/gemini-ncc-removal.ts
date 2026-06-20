import { getGeminiExpectedPosition } from "@/lib/image/gemini-position";
import {
  getOfficialPrimaryConfig,
  resolveAlphaMapKey,
  resolveGeminiWatermarkSearchConfigs,
} from "@/lib/image/gemini-size-catalog";
import {
  findWatermarkPosition,
  isWatermarkDetected,
  type WatermarkMatchResult,
} from "@/lib/image/ncc-match";
import type { Region } from "@/lib/image/region";
import { clampRegion, padRegionAroundMatch, regionFromMatch } from "@/lib/image/region";
import { detectWatermarkInSelection } from "@/lib/image/watermark-detector";
import {
  getSparkleTemplateAtSize,
  type SparkleTemplate,
} from "@/lib/image/sparkle-template";

export type GeminiNccOptions = {
  /** 알파 맵 강도 보정 (1.0 = 보정 없음) */
  globalAlpha: number;
  logoColor: { r: number; g: number; b: number };
};

export type GeminiNccCache = {
  match: WatermarkMatchResult;
  template: SparkleTemplate;
  /** UI 표시용 — 탐지 위치보다 여유 있게 잡힌 영역 */
  region: Region;
  detected: boolean;
  imageKey: string;
  brightWatermark: boolean;
};

const ALPHA_NOISE_FLOOR = 3 / 255;
const ALPHA_THRESHOLD = 0.002;
const MAX_ALPHA = 0.99;

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function detectBrightWatermark(
  data: Uint8ClampedArray,
  width: number,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
): boolean {
  const { size, alpha } = template;
  const { x: ox, y: oy } = match;
  let wmSum = 0;
  let bgSum = 0;
  let wmCount = 0;
  let bgCount = 0;

  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const matte = alpha[ty * size + tx];
      const pi = ((oy + ty) * width + (ox + tx)) * 4;
      const lum = luminance(data[pi], data[pi + 1], data[pi + 2]);
      if (matte >= 0.12) {
        wmSum += lum;
        wmCount++;
      } else if (matte < 0.02) {
        bgSum += lum;
        bgCount++;
      }
    }
  }

  if (wmCount === 0 || bgCount === 0) return true;
  return wmSum / wmCount > bgSum / bgCount;
}

/**
 * 역알파 블렌딩 (GargantuaX blendModes.js 기반)
 * original = (watermarked - α × logo) / (1 - α)
 */
export function applyGeminiTemplateInverseAlpha(
  imageData: ImageData,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  options: GeminiNccOptions,
  brightWatermark = true,
): void {
  const alphaGain =
    Number.isFinite(options.globalAlpha) && options.globalAlpha > 0
      ? options.globalAlpha
      : 1;
  const { data, width, height } = imageData;
  const { size, alpha: matte } = template;
  const { x: originX, y: originY } = match;

  const logoR = brightWatermark ? 255 : options.logoColor.r;
  const logoG = brightWatermark ? 255 : options.logoColor.g;
  const logoB = brightWatermark ? 255 : options.logoColor.b;

  for (let ty = 0; ty < size; ty++) {
    for (let col = 0; col < size; col++) {
      const matteAlpha = matte[ty * size + col];
      const alphaMagnitude = Math.abs(matteAlpha);
      const signalAlpha = Math.max(0, alphaMagnitude - ALPHA_NOISE_FLOOR) * alphaGain;

      if (signalAlpha < ALPHA_THRESHOLD) continue;

      const alpha = Math.min(alphaMagnitude * alphaGain, MAX_ALPHA);
      const oneMinusAlpha = 1 - alpha;

      const px = originX + col;
      const py = originY + ty;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;

      const pi = (py * width + px) * 4;
      const logo =
        matteAlpha < 0
          ? [0, 0, 0]
          : [logoR, logoG, logoB];

      data[pi] = clampChannel((data[pi] - alpha * logo[0]) / oneMinusAlpha);
      data[pi + 1] = clampChannel((data[pi + 1] - alpha * logo[1]) / oneMinusAlpha);
      data[pi + 2] = clampChannel((data[pi + 2] - alpha * logo[2]) / oneMinusAlpha);
    }
  }
}

export function buildGeminiCache(
  imageData: ImageData,
  imageKey: string,
): GeminiNccCache {
  const { width, height, data } = imageData;
  const match = findWatermarkPosition(data, width, height);
  const template: SparkleTemplate = match.alignedAlpha
    ? { size: match.templateSize, alpha: match.alignedAlpha }
    : getSparkleTemplateAtSize(match.templateSize, match.alphaMapKey);
  const detected = isWatermarkDetected(match);
  const brightWatermark = detectBrightWatermark(data, width, match, template);

  const tightRegion = regionFromMatch(
    match.x,
    match.y,
    match.templateSize,
    width,
    height,
  );
  const region = padRegionAroundMatch(tightRegion, width, height);

  return { match, template, region, detected, imageKey, brightWatermark };
}

export function resolveGeminiAlphaMapKeyForImage(
  imageWidth: number,
  imageHeight: number,
): string {
  const primary = getOfficialPrimaryConfig(imageWidth, imageHeight);
  if (primary) return String(resolveAlphaMapKey(primary));
  const [config] = resolveGeminiWatermarkSearchConfigs(imageWidth, imageHeight);
  return String(
    resolveAlphaMapKey(config ?? { logoSize: 48, marginRight: 32, marginBottom: 32 }),
  );
}

/** 사용자 선택 영역 안에서 ✦ 로고를 탐지한 뒤 알파 맵 역블렌딩 */
export function buildGeminiManualCache(
  imageData: ImageData,
  imageKey: string,
  selection: Region,
): GeminiNccCache {
  const { width, height, data } = imageData;
  const match = detectWatermarkInSelection(data, width, height, selection);
  const template: SparkleTemplate = match.alignedAlpha
    ? { size: match.templateSize, alpha: match.alignedAlpha }
    : getSparkleTemplateAtSize(match.templateSize, match.alphaMapKey);
  const clamped = clampRegion(
    {
      x: Math.round(match.x),
      y: Math.round(match.y),
      width: match.templateSize,
      height: match.templateSize,
    },
    width,
    height,
  );

  const alignedMatch: WatermarkMatchResult = {
    ...match,
    x: clamped.x,
    y: clamped.y,
    templateSize: clamped.width,
  };

  const brightWatermark = detectBrightWatermark(data, width, alignedMatch, template);
  const region = padRegionAroundMatch(clamped, width, height);

  return {
    match: alignedMatch,
    template,
    region,
    detected: true,
    imageKey: `${imageKey}#manual`,
    brightWatermark,
  };
}

export function applyGeminiWithCache(
  imageData: ImageData,
  cache: GeminiNccCache,
  options: GeminiNccOptions,
): void {
  applyGeminiTemplateInverseAlpha(
    imageData,
    cache.match,
    cache.template,
    options,
    cache.brightWatermark,
  );
}

export function getFallbackMatch(
  imageWidth: number,
  imageHeight: number,
): WatermarkMatchResult {
  const { x, y, spec } = getGeminiExpectedPosition(imageWidth, imageHeight);
  const config = {
    logoSize: spec.logoSize,
    marginRight: spec.marginRight,
    marginBottom: spec.marginBottom,
    alphaVariant: spec.alphaVariant,
  };
  return {
    x,
    y,
    score: 0,
    templateSize: spec.logoSize,
    config,
    alphaMapKey:
      spec.alphaVariant ?? (spec.logoSize <= 40 ? "36-v2" : spec.logoSize <= 72 ? "48" : "96"),
    spatialScore: 0,
    gradientScore: 0,
    detectionSource: "fallback",
    suppressionGain: 0,
  };
}
