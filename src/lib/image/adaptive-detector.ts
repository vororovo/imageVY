/**
 * 적응형 워터마크 탐지기
 * GargantuaX/gemini-watermark-remover adaptiveDetector.js 기반 (MIT)
 * 고정 좌표가 아닌 이미지 픽셀에서 NCC로 위치·크기를 자동 탐지합니다.
 */

import {
  clamp,
  getRegion,
  interpolateAlphaMap,
  normalizedCrossCorrelation,
  sobelMagnitude,
  stdDevRegion,
  toGrayscale,
} from "@/lib/image/alpha-map-utils";
import {
  getWatermarkPositionFromConfig,
  resolveAlphaMapKey,
  resolveGeminiWatermarkSearchConfigs,
  type GeminiWatermarkConfig,
} from "@/lib/image/gemini-size-catalog";

const DEFAULT_THRESHOLD = 0.35;
const REFERENCE_WATERMARK_SIZE = 96;
const MIN_COARSE_ADJUSTED_SCORE = 0.08;

export type AdaptiveDetectionResult = {
  found: boolean;
  confidence: number;
  spatialScore: number;
  gradientScore: number;
  varianceScore: number;
  region: { x: number; y: number; size: number };
  alphaMapKey: string;
};

type GrayContext = {
  gray: Float32Array;
  grad: Float32Array;
  width: number;
  height: number;
};

type TemplatePair = {
  alpha: Float32Array;
  grad: Float32Array;
};

type ScoredCandidate = {
  x: number;
  y: number;
  size: number;
  confidence: number;
  spatialScore: number;
  gradientScore: number;
  varianceScore: number;
};

function computeSizeAdjustedConfidence(
  confidence: number,
  size: number,
  referenceSize = REFERENCE_WATERMARK_SIZE,
): number {
  if (
    !Number.isFinite(confidence) ||
    !Number.isFinite(size) ||
    !Number.isFinite(referenceSize) ||
    size <= 0 ||
    referenceSize <= 0
  ) {
    return 0;
  }

  const sizeWeight = Math.min(1, Math.cbrt(size / referenceSize));
  return confidence * sizeWeight;
}

function createScaleList(minSize: number, maxSize: number): number[] {
  const set = new Set<number>();
  for (let s = minSize; s <= maxSize; s += 8) set.add(s);
  if (48 >= minSize && 48 <= maxSize) set.add(48);
  if (96 >= minSize && 96 <= maxSize) set.add(96);
  return [...set].sort((a, b) => a - b);
}

function getTemplate(
  cache: Map<number, TemplatePair>,
  baseAlpha: Float32Array,
  baseSize: number,
  size: number,
): TemplatePair {
  if (cache.has(size)) return cache.get(size)!;

  const alpha =
    size === baseSize ? baseAlpha : interpolateAlphaMap(baseAlpha, baseSize, size);
  const grad = sobelMagnitude(alpha, size, size);
  const tpl = { alpha, grad };
  cache.set(size, tpl);
  return tpl;
}

function scoreCandidate(
  context: GrayContext,
  alphaMap: Float32Array,
  templateGrad: Float32Array,
  candidate: { x: number; y: number; size: number },
): Omit<ScoredCandidate, "x" | "y" | "size"> | null {
  const { x, y, size } = candidate;
  const { gray, grad, width, height } = context;

  if (x < 0 || y < 0 || x + size > width || y + size > height) {
    return null;
  }

  const grayRegion = getRegion(gray, width, x, y, size);
  const gradRegion = getRegion(grad, width, x, y, size);

  const spatial = normalizedCrossCorrelation(grayRegion, alphaMap);
  const gradient = normalizedCrossCorrelation(gradRegion, templateGrad);

  let varianceScore = 0;
  if (y > 8) {
    const refY = Math.max(0, y - size);
    const refH = Math.min(size, y - refY);
    if (refH > 8) {
      const wmStd = stdDevRegion(gray, width, x, y, size);
      const refStd = stdDevRegion(gray, width, x, refY, refH);
      if (refStd > 1e-8) {
        varianceScore = clamp(1 - wmStd / refStd, 0, 1);
      }
    }
  }

  const confidence =
    Math.max(0, spatial) * 0.5 +
    Math.max(0, gradient) * 0.3 +
    varianceScore * 0.2;

  return {
    confidence: clamp(confidence, 0, 1),
    spatialScore: spatial,
    gradientScore: gradient,
    varianceScore,
  };
}

export type AdaptiveDetectOptions = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  baseAlpha: Float32Array;
  baseSize: number;
  alphaMapKey: string;
  defaultConfig?: GeminiWatermarkConfig;
  seedConfigs?: GeminiWatermarkConfig[];
  threshold?: number;
};

export function detectAdaptiveWatermarkRegion(
  options: AdaptiveDetectOptions,
): AdaptiveDetectionResult {
  const {
    data,
    width,
    height,
    baseAlpha,
    baseSize,
    alphaMapKey,
    defaultConfig = { logoSize: 48, marginRight: 32, marginBottom: 32 },
    seedConfigs = resolveGeminiWatermarkSearchConfigs(width, height),
    threshold = DEFAULT_THRESHOLD,
  } = options;

  const gray = toGrayscale(data, width, height);
  const grad = sobelMagnitude(gray, width, height);
  const context: GrayContext = { gray, grad, width, height };
  const templateCache = new Map<number, TemplatePair>();

  const seedCandidates: ScoredCandidate[] = seedConfigs
    .map((config) => {
      const size = config.logoSize;
      const { x, y } = getWatermarkPositionFromConfig(width, height, config);
      if (x < 0 || y < 0 || x + size > width || y + size > height) return null;

      const template = getTemplate(templateCache, baseAlpha, baseSize, size);
      const score = scoreCandidate(context, template.alpha, template.grad, { x, y, size });
      if (!score) return null;

      return { x, y, size, ...score };
    })
    .filter((c): c is ScoredCandidate => c !== null);

  const bestSeed = seedCandidates.reduce<ScoredCandidate | null>((best, candidate) => {
    if (!best || candidate.confidence > best.confidence) return candidate;
    return best;
  }, null);

  if (bestSeed && bestSeed.confidence >= threshold + 0.08) {
    return {
      found: true,
      confidence: bestSeed.confidence,
      spatialScore: bestSeed.spatialScore,
      gradientScore: bestSeed.gradientScore,
      varianceScore: bestSeed.varianceScore,
      region: { x: bestSeed.x, y: bestSeed.y, size: bestSeed.size },
      alphaMapKey,
    };
  }

  const baseSizeHint = bestSeed?.size ?? defaultConfig.logoSize;
  const minSize = clamp(Math.round(baseSizeHint * 0.65), 24, 144);
  const maxSize = clamp(
    Math.min(Math.round(baseSizeHint * 2.8), Math.floor(Math.min(width, height) * 0.4)),
    minSize,
    192,
  );
  const scaleList = createScaleList(minSize, maxSize);

  const marginRange = Math.max(32, Math.round(baseSizeHint * 0.75));
  const minMarginRight = clamp(
    defaultConfig.marginRight - marginRange,
    8,
    width - minSize - 1,
  );
  const maxMarginRight = clamp(
    defaultConfig.marginRight + marginRange,
    minMarginRight,
    width - minSize - 1,
  );
  const minMarginBottom = clamp(
    defaultConfig.marginBottom - marginRange,
    8,
    height - minSize - 1,
  );
  const maxMarginBottom = clamp(
    defaultConfig.marginBottom + marginRange,
    minMarginBottom,
    height - minSize - 1,
  );

  const topK: { size: number; x: number; y: number; adjustedScore: number }[] = [];
  const pushTopK = (candidate: { size: number; x: number; y: number; adjustedScore: number }) => {
    topK.push(candidate);
    topK.sort((a, b) => b.adjustedScore - a.adjustedScore);
    if (topK.length > 5) topK.length = 5;
  };

  for (const seedCandidate of seedCandidates) {
    pushTopK({
      size: seedCandidate.size,
      x: seedCandidate.x,
      y: seedCandidate.y,
      adjustedScore: computeSizeAdjustedConfidence(
        seedCandidate.confidence,
        seedCandidate.size,
      ),
    });
  }

  for (const size of scaleList) {
    const tpl = getTemplate(templateCache, baseAlpha, baseSize, size);
    for (let mr = minMarginRight; mr <= maxMarginRight; mr += 8) {
      const x = width - mr - size;
      if (x < 0) continue;
      for (let mb = minMarginBottom; mb <= maxMarginBottom; mb += 8) {
        const y = height - mb - size;
        if (y < 0) continue;

        const score = scoreCandidate(context, tpl.alpha, tpl.grad, { x, y, size });
        if (!score) continue;

        const adjustedScore = computeSizeAdjustedConfidence(score.confidence, size);
        if (adjustedScore < MIN_COARSE_ADJUSTED_SCORE) continue;

        pushTopK({ size, x, y, adjustedScore });
      }
    }
  }

  let best: ScoredCandidate =
    bestSeed ??
    ({
      x: width - defaultConfig.marginRight - defaultConfig.logoSize,
      y: height - defaultConfig.marginBottom - defaultConfig.logoSize,
      size: defaultConfig.logoSize,
      confidence: 0,
      spatialScore: 0,
      gradientScore: 0,
      varianceScore: 0,
    } satisfies ScoredCandidate);

  for (const coarse of topK) {
    const scaleLo = clamp(coarse.size - 10, minSize, maxSize);
    const scaleHi = clamp(coarse.size + 10, minSize, maxSize);

    for (let size = scaleLo; size <= scaleHi; size += 2) {
      const tpl = getTemplate(templateCache, baseAlpha, baseSize, size);
      for (let x = coarse.x - 8; x <= coarse.x + 8; x += 2) {
        if (x < 0 || x + size > width) continue;
        for (let y = coarse.y - 8; y <= coarse.y + 8; y += 2) {
          if (y < 0 || y + size > height) continue;
          const score = scoreCandidate(context, tpl.alpha, tpl.grad, { x, y, size });
          if (!score) continue;

          if (score.confidence > best.confidence) {
            best = { x, y, size, ...score };
          }
        }
      }
    }
  }

  return {
    found: best.confidence >= threshold,
    confidence: best.confidence,
    spatialScore: best.spatialScore,
    gradientScore: best.gradientScore,
    varianceScore: best.varianceScore,
    region: { x: best.x, y: best.y, size: best.size },
    alphaMapKey,
  };
}

export function collectAlphaMapKeys(configs: GeminiWatermarkConfig[]): string[] {
  const keys = new Set<string>(["48", "96", "36-v2"]);
  for (const config of configs) {
    keys.add(String(resolveAlphaMapKey(config)));
  }
  return [...keys];
}
