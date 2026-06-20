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
import { detectWatermarkInSelection, measureSuppressionGain } from "@/lib/image/watermark-detector";
import {
  computeRegionGradientCorrelation,
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
const ALPHA_THRESHOLD = 0.0015;
const MAX_ALPHA = 0.98;

/** 과도한 gain은 어두운 별 잔상(과보정)을 만듭니다 */
const ALPHA_GAIN_CANDIDATES = [1, 1.04, 1.08, 1.12, 1.16, 1.2, 1.24, 1.28, 1.32];
const MIN_SUPPRESSION_IMPROVEMENT = 0.025;
const MAX_DARK_ARTIFACT_RATIO = 0.04;
const OUTLINE_GRADIENT_THRESHOLD = 0.42;
const MIN_SUPPRESSION_FOR_REFINE = 0.06;
const SUBPIXEL_SHIFTS = [-0.25, 0, 0.25] as const;
const SUBPIXEL_SCALES = [0.99, 1, 1.01] as const;
const REFINE_GAIN_CANDIDATES = [1, 1.04, 1.08, 1.12, 1.16];

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
      if (oneMinusAlpha < 0.02) continue;

      const px = originX + col;
      const py = originY + ty;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;

      const pi = (py * width + px) * 4;
      const logo =
        matteAlpha < 0
          ? [0, 0, 0]
          : [logoR, logoG, logoB];

      let r = (data[pi] - alpha * logo[0]) / oneMinusAlpha;
      let g = (data[pi + 1] - alpha * logo[1]) / oneMinusAlpha;
      let b = (data[pi + 2] - alpha * logo[2]) / oneMinusAlpha;

      if (brightWatermark) {
        const maxDrop = 35 + alpha * 40;
        r = Math.max(r, data[pi] - maxDrop);
        g = Math.max(g, data[pi + 1] - maxDrop);
        b = Math.max(b, data[pi + 2] - maxDrop);
      } else {
        const maxRise = 35 + alpha * 40;
        r = Math.min(r, data[pi] + maxRise);
        g = Math.min(g, data[pi + 1] + maxRise);
        b = Math.min(b, data[pi + 2] + maxRise);
      }

      data[pi] = clampChannel(r);
      data[pi + 1] = clampChannel(g);
      data[pi + 2] = clampChannel(b);
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

function estimateBackgroundLuminance(
  data: Uint8ClampedArray,
  width: number,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
): number {
  const { size, alpha } = template;
  const { x, y } = match;
  let sum = 0;
  let count = 0;
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      if (alpha[ty * size + tx] >= 0.04) continue;
      const pi = ((y + ty) * width + (x + tx)) * 4;
      sum += luminance(data[pi], data[pi + 1], data[pi + 2]);
      count++;
    }
  }
  return count > 0 ? sum / count : 128;
}

function calculateDarkArtifactRatio(
  source: Uint8ClampedArray,
  result: Uint8ClampedArray,
  width: number,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  brightWatermark: boolean,
): number {
  const { size, alpha } = template;
  const { x, y } = match;
  const bgLum = estimateBackgroundLuminance(source, width, match, template);
  let bad = 0;
  let wmPixels = 0;

  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const matte = alpha[ty * size + tx];
      if (matte < 0.08) continue;
      wmPixels++;
      const pi = ((y + ty) * width + (x + tx)) * 4;
      const resultLum = luminance(result[pi], result[pi + 1], result[pi + 2]);
      const sourceLum = luminance(source[pi], source[pi + 1], source[pi + 2]);
      if (brightWatermark) {
        if (resultLum < bgLum - 14 || resultLum < sourceLum - 28) bad++;
      } else if (resultLum > bgLum + 14 || resultLum > sourceLum + 28) {
        bad++;
      }
    }
  }

  return wmPixels > 0 ? bad / wmPixels : 0;
}

type RemovalEvaluation = {
  image: ImageData;
  suppression: number;
  darkArtifactRatio: number;
  gain: number;
};

function evaluateRemoval(
  source: ImageData,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  options: GeminiNccOptions,
  brightWatermark: boolean,
  gain: number,
): RemovalEvaluation {
  const image = applyRemovalWithGain(source, match, template, options, brightWatermark, gain);
  return {
    image,
    suppression: measureSuppressionGain(
      image.data,
      source.width,
      source.height,
      match.x,
      match.y,
      template.size,
      template.alpha,
      brightWatermark,
    ),
    darkArtifactRatio: calculateDarkArtifactRatio(
      source.data,
      image.data,
      source.width,
      match,
      template,
      brightWatermark,
    ),
    gain,
  };
}

function isAcceptableRemoval(evaluation: RemovalEvaluation): boolean {
  return evaluation.darkArtifactRatio <= MAX_DARK_ARTIFACT_RATIO;
}

function isBetterRemoval(candidate: RemovalEvaluation, best: RemovalEvaluation): boolean {
  if (!isAcceptableRemoval(candidate)) return false;
  if (!isAcceptableRemoval(best)) return true;
  if (candidate.suppression >= best.suppression + MIN_SUPPRESSION_IMPROVEMENT) return true;
  if (
    best.suppression - candidate.suppression <= 0.01 &&
    candidate.darkArtifactRatio < best.darkArtifactRatio - 0.008
  ) {
    return true;
  }
  return false;
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
): RemovalEvaluation {
  let best = evaluateRemoval(source, match, template, options, brightWatermark, 1);

  if (best.suppression >= 0.08 && isAcceptableRemoval(best)) {
    return best;
  }

  for (const gain of ALPHA_GAIN_CANDIDATES) {
    if (gain <= 1) continue;
    const candidate = evaluateRemoval(source, match, template, options, brightWatermark, gain);
    if (isBetterRemoval(candidate, best)) {
      best = candidate;
    }
  }

  return best;
}

function refineOutlineResidual(
  source: ImageData,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  options: GeminiNccOptions,
  brightWatermark: boolean,
  baseline: RemovalEvaluation,
): RemovalEvaluation {
  const region = { x: match.x, y: match.y, size: template.size };
  const baselineGradient = computeRegionGradientCorrelation(
    baseline.image.data,
    source.width,
    source.height,
    template.alpha,
    region,
  );

  if (
    baseline.suppression >= MIN_SUPPRESSION_FOR_REFINE ||
    baselineGradient < OUTLINE_GRADIENT_THRESHOLD ||
    !isAcceptableRemoval(baseline)
  ) {
    return baseline;
  }

  let best = baseline;

  for (const scale of SUBPIXEL_SCALES) {
    for (const dy of SUBPIXEL_SHIFTS) {
      for (const dx of SUBPIXEL_SHIFTS) {
        if (dx === 0 && dy === 0 && scale === 1) continue;
        const warped = warpAlphaMap(template.alpha, template.size, { dx, dy, scale });
        const warpedTemplate: SparkleTemplate = { size: template.size, alpha: warped };

        for (const gain of REFINE_GAIN_CANDIDATES) {
          const candidate = evaluateRemoval(
            source,
            match,
            warpedTemplate,
            options,
            brightWatermark,
            gain,
          );
          if (isBetterRemoval(candidate, best)) {
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

  imageData.data.set(result.image.data);
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
