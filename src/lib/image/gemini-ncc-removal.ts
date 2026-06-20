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
  computeRegionGradientCorrelation,
  computeRegionSpatialCorrelation,
  warpAlphaMap,
} from "@/lib/image/alpha-map-utils";
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
const ALPHA_THRESHOLD = 0.0008;
const FRINGE_ALPHA_MIN = 0.0006;
const MAX_ALPHA = 0.99;

const ALPHA_GAIN_CANDIDATES = [
  1, 1.08, 1.12, 1.2, 1.28, 1.36, 1.45, 1.52, 1.6, 1.7, 1.85, 2.0, 2.2,
];
const OUTLINE_GRADIENT_THRESHOLD = 0.38;
const OUTLINE_SPATIAL_MAX = 0.32;
const NEAR_BLACK_THRESHOLD = 8;
const MAX_NEAR_BLACK_RATIO_INCREASE = 0.06;
const SUBPIXEL_SHIFTS = [-0.25, 0, 0.25] as const;
const SUBPIXEL_SCALES = [0.99, 1, 1.01] as const;

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
      let signalAlpha = Math.max(0, alphaMagnitude - ALPHA_NOISE_FLOOR) * alphaGain;

      if (signalAlpha < ALPHA_THRESHOLD) {
        if (alphaMagnitude < FRINGE_ALPHA_MIN) continue;
        signalAlpha = alphaMagnitude * alphaGain * 0.85;
      }

      const alpha = Math.min(alphaMagnitude * alphaGain, MAX_ALPHA);
      const oneMinusAlpha = 1 - alpha;
      if (oneMinusAlpha < 0.01) continue;

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

function cloneImageData(source: ImageData): ImageData {
  return new ImageData(
    new Uint8ClampedArray(source.data),
    source.width,
    source.height,
  );
}

function calculateNearBlackRatio(
  data: Uint8ClampedArray,
  width: number,
  match: WatermarkMatchResult,
  size: number,
): number {
  const { x, y } = match;
  let nearBlack = 0;
  let total = 0;
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const pi = ((y + ty) * width + (x + tx)) * 4;
      total++;
      if (
        data[pi] <= NEAR_BLACK_THRESHOLD &&
        data[pi + 1] <= NEAR_BLACK_THRESHOLD &&
        data[pi + 2] <= NEAR_BLACK_THRESHOLD
      ) {
        nearBlack++;
      }
    }
  }
  return total > 0 ? nearBlack / total : 0;
}

function scoreRemovalQuality(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaMap: Float32Array,
  region: { x: number; y: number; size: number },
): { spatial: number; gradient: number; cost: number } {
  const spatial = computeRegionSpatialCorrelation(data, width, height, alphaMap, region);
  const gradient = computeRegionGradientCorrelation(data, width, height, alphaMap, region);
  return {
    spatial,
    gradient,
    cost: Math.abs(spatial) * 0.65 + Math.max(0, gradient) * 0.35,
  };
}

function applyRemovalWithGain(
  source: ImageData,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  options: GeminiNccOptions,
  brightWatermark: boolean,
  alphaGain: number,
): ImageData {
  const copy = cloneImageData(source);
  applyGeminiTemplateInverseAlpha(
    copy,
    match,
    template,
    { ...options, globalAlpha: alphaGain },
    brightWatermark,
  );
  return copy;
}

function pickBestAlphaGainRemoval(
  source: ImageData,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  options: GeminiNccOptions,
  brightWatermark: boolean,
): ImageData {
  const region = { x: match.x, y: match.y, size: template.size };
  const originalNearBlack = calculateNearBlackRatio(
    source.data,
    source.width,
    match,
    template.size,
  );
  const maxNearBlack = Math.min(1, originalNearBlack + MAX_NEAR_BLACK_RATIO_INCREASE);

  let bestImage = applyRemovalWithGain(source, match, template, options, brightWatermark, 1);
  let bestCost = scoreRemovalQuality(
    bestImage.data,
    source.width,
    source.height,
    template.alpha,
    region,
  ).cost;

  for (const gain of ALPHA_GAIN_CANDIDATES) {
    if (gain === 1) continue;
    const candidate = applyRemovalWithGain(source, match, template, options, brightWatermark, gain);
    const nearBlack = calculateNearBlackRatio(
      candidate.data,
      source.width,
      match,
      template.size,
    );
    if (nearBlack > maxNearBlack) continue;

    const scores = scoreRemovalQuality(
      candidate.data,
      source.width,
      source.height,
      template.alpha,
      region,
    );
    if (scores.cost < bestCost) {
      bestCost = scores.cost;
      bestImage = candidate;
    }
  }

  return bestImage;
}

function refineOutlineResidual(
  source: ImageData,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  options: GeminiNccOptions,
  brightWatermark: boolean,
  baseline: ImageData,
): ImageData {
  const region = { x: match.x, y: match.y, size: template.size };
  const baselineScores = scoreRemovalQuality(
    baseline.data,
    source.width,
    source.height,
    template.alpha,
    region,
  );

  if (
    Math.abs(baselineScores.spatial) > OUTLINE_SPATIAL_MAX ||
    baselineScores.gradient < OUTLINE_GRADIENT_THRESHOLD
  ) {
    return baseline;
  }

  const originalNearBlack = calculateNearBlackRatio(
    source.data,
    source.width,
    match,
    template.size,
  );
  const maxNearBlack = Math.min(1, originalNearBlack + MAX_NEAR_BLACK_RATIO_INCREASE);
  const gainCandidates = [1.12, 1.2, 1.28, 1.36, 1.45, 1.52, 1.6, 1.85, 2.0];

  let best = baseline;
  let bestCost = baselineScores.cost;

  for (const scale of SUBPIXEL_SCALES) {
    for (const dy of SUBPIXEL_SHIFTS) {
      for (const dx of SUBPIXEL_SHIFTS) {
        if (dx === 0 && dy === 0 && scale === 1) continue;
        const warped = warpAlphaMap(template.alpha, template.size, { dx, dy, scale });
        const warpedTemplate: SparkleTemplate = { size: template.size, alpha: warped };

        for (const gain of gainCandidates) {
          const candidate = applyRemovalWithGain(
            source,
            match,
            warpedTemplate,
            options,
            brightWatermark,
            gain,
          );
          const nearBlack = calculateNearBlackRatio(
            candidate.data,
            source.width,
            match,
            template.size,
          );
          if (nearBlack > maxNearBlack) continue;

          const scores = scoreRemovalQuality(
            candidate.data,
            source.width,
            source.height,
            warped,
            region,
          );
          const improvedGradient = scores.gradient <= baselineScores.gradient - 0.03;
          const keptSpatial =
            Math.abs(scores.spatial) <= Math.abs(baselineScores.spatial) + 0.1;
          if (!improvedGradient || !keptSpatial) continue;

          if (scores.cost < bestCost) {
            bestCost = scores.cost;
            best = candidate;
          }
        }
      }
    }
  }

  return best;
}

function applyRefinedGeminiRemoval(
  imageData: ImageData,
  cache: GeminiNccCache,
  options: GeminiNccOptions,
): void {
  const source = cloneImageData(imageData);
  const { match, template, brightWatermark } = cache;

  let result = pickBestAlphaGainRemoval(source, match, template, options, brightWatermark);
  result = refineOutlineResidual(source, match, template, options, brightWatermark, result);

  imageData.data.set(result.data);
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
  applyRefinedGeminiRemoval(imageData, cache, options);
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
