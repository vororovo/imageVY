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
import {
  applyGeminiEdgeFeather,
  repairGeminiLuminanceResidual,
  sealGeminiMatteRegion,
  stabilizeGeminiRemovalToBackground,
  type GeminiEdgeFeatherOptions,
} from "@/lib/image/gemini-edge-feather";

export type { GeminiEdgeFeatherOptions };

export type GeminiNccOptions = {
  /** 알파 맵 강도 보정 (1.0 = 보정 없음) */
  globalAlpha: number;
  logoColor: { r: number; g: number; b: number };
  edgeFeather?: GeminiEdgeFeatherOptions;
};

export type GeminiNccCache = {
  match: WatermarkMatchResult;
  template: SparkleTemplate;
  /** UI 표시용 — 탐지 위치보다 여유 있게 잡힌 영역 */
  region: Region;
  detected: boolean;
  imageKey: string;
  brightWatermark: boolean;
  /** build 시 1회 계산 — 미리보기마다 gain sweep/refine 반복 방지 */
  removalPlan?: GeminiRemovalPlan;
};

export type GeminiRemovalPlan = {
  template: SparkleTemplate;
  alphaGain: number;
  /** suppression 기준으로 미세 조정된 픽셀 오프셋 */
  offsetX: number;
  offsetY: number;
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

function sampleLocalBackgroundRgb(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  px: number,
  py: number,
  originX: number,
  originY: number,
  templateSize: number,
  templateAlpha: Float32Array,
): [number, number, number] {
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let weightSum = 0;

  for (let dy = -5; dy <= 5; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      const nx = px + dx;
      const ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

      const tx = nx - originX;
      const ty = ny - originY;
      if (tx >= 0 && tx < templateSize && ty >= 0 && ty < templateSize) {
        if (templateAlpha[ty * templateSize + tx] >= 0.035) continue;
      }

      const dist = Math.hypot(dx, dy);
      if (dist > 5) continue;
      const w = 1 / (1 + dist * 0.4);
      const pi = (ny * width + nx) * 4;
      rSum += data[pi] * w;
      gSum += data[pi + 1] * w;
      bSum += data[pi + 2] * w;
      weightSum += w;
    }
  }

  if (weightSum === 0) {
    const pi = (py * width + px) * 4;
    return [data[pi], data[pi + 1], data[pi + 2]];
  }
  return [rSum / weightSum, gSum / weightSum, bSum / weightSum];
}

/** 픽셀 밝기와 주변 배경으로 실제 블렌드 알파 추정 */
function estimateLuminanceAlpha(
  r: number,
  g: number,
  b: number,
  bgR: number,
  bgG: number,
  bgB: number,
  brightWatermark: boolean,
): number {
  const lum = luminance(r, g, b);
  const bgLum = luminance(bgR, bgG, bgB);
  if (brightWatermark) {
    const span = Math.max(255 - bgLum, 14);
    return Math.max(0, Math.min(0.98, (lum - bgLum) / span));
  }
  const span = Math.max(bgLum, 14);
  return Math.max(0, Math.min(0.98, (bgLum - lum) / span));
}

/**
 * 역알파 블렌딩 (GargantuaX blendModes.js 기반)
 * original = (watermarked - α × logo) / (1 - α)
 * 템플릿 알파 + 픽셀 밝기 추정 알파를 결합해 윤곽 잔광을 줄입니다.
 */
export function applyGeminiTemplateInverseAlpha(
  imageData: ImageData,
  originalSource: ImageData,
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
  const origData = originalSource.data;
  const { size, alpha: matte } = template;
  const { x: originX, y: originY } = match;

  const logoR = brightWatermark ? 255 : options.logoColor.r;
  const logoG = brightWatermark ? 255 : options.logoColor.g;
  const logoB = brightWatermark ? 255 : options.logoColor.b;

  for (let ty = 0; ty < size; ty++) {
    for (let col = 0; col < size; col++) {
      const matteAlpha = matte[ty * size + col];
      const alphaMagnitude = Math.abs(matteAlpha);
      const templateAlpha = Math.min(alphaMagnitude * alphaGain, MAX_ALPHA);

      const px = originX + col;
      const py = originY + ty;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;

      const pi = (py * width + px) * 4;
      const origR = origData[pi];
      const origG = origData[pi + 1];
      const origB = origData[pi + 2];

      const [bgR, bgG, bgB] = sampleLocalBackgroundRgb(
        origData,
        width,
        height,
        px,
        py,
        originX,
        originY,
        size,
        matte,
      );
      const lumAlpha = estimateLuminanceAlpha(
        origR,
        origG,
        origB,
        bgR,
        bgG,
        bgB,
        brightWatermark,
      );

      let alpha = Math.min(
        Math.max(templateAlpha, lumAlpha * alphaGain * 0.96),
        MAX_ALPHA,
      );

      if (alphaMagnitude >= ALPHA_NOISE_FLOOR) {
        const signalAlpha = Math.max(0, alphaMagnitude - ALPHA_NOISE_FLOOR) * alphaGain;
        if (signalAlpha >= ALPHA_THRESHOLD) {
          alpha = Math.min(Math.max(templateAlpha, lumAlpha * alphaGain), MAX_ALPHA);
        }
      }

      if (alpha < 0.008 && lumAlpha < 0.015) continue;

      if (alpha < 0.02 && lumAlpha >= 0.015) {
        alpha = Math.min(lumAlpha * alphaGain * 0.95, MAX_ALPHA);
      }

      let r: number;
      let g: number;
      let b: number;

      if (brightWatermark) {
        // pixel = bg + α×(255−bg) — 나눗셈 없이 안정적 (별 꼭짓점 고알파 포함)
        r = origR - alpha * (255 - bgR);
        g = origG - alpha * (255 - bgG);
        b = origB - alpha * (255 - bgB);
      } else {
        const oneMinusAlpha = 1 - alpha;
        const logo =
          matteAlpha < 0 ? [0, 0, 0] : [logoR, logoG, logoB];
        if (oneMinusAlpha < 0.03) {
          r = origR + alpha * (bgR - origR);
          g = origG + alpha * (bgG - origG);
          b = origB + alpha * (bgB - origB);
        } else {
          r = (origR - alpha * logo[0]) / oneMinusAlpha;
          g = (origG - alpha * logo[1]) / oneMinusAlpha;
          b = (origB - alpha * logo[2]) / oneMinusAlpha;
        }
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
  template: SparkleTemplate;
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
    template,
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
    source,
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

const DEFAULT_REMOVAL_OPTIONS: GeminiNccOptions = {
  globalAlpha: 1,
  logoColor: { r: 255, g: 255, b: 255 },
};

/** 역블렌딩 suppression 기준으로 템플릿 위치를 ±N px 미세 정렬 */
function refineRemovalPosition(
  source: ImageData,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  options: GeminiNccOptions,
  brightWatermark: boolean,
  gain: number,
  searchRadius = 4,
): { offsetX: number; offsetY: number } {
  let bestDx = 0;
  let bestDy = 0;
  let bestSuppression = -1;
  let bestArtifact = 1;

  for (let dy = -searchRadius; dy <= searchRadius; dy++) {
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      const shifted: WatermarkMatchResult = {
        ...match,
        x: match.x + dx,
        y: match.y + dy,
      };
      if (
        shifted.x < 0 ||
        shifted.y < 0 ||
        shifted.x + template.size > source.width ||
        shifted.y + template.size > source.height
      ) {
        continue;
      }

      const image = applyRemovalWithGain(
        source,
        shifted,
        template,
        options,
        brightWatermark,
        gain,
      );
      const suppression = measureSuppressionGain(
        image.data,
        source.width,
        source.height,
        shifted.x,
        shifted.y,
        template.size,
        template.alpha,
        brightWatermark,
      );
      const artifact = calculateDarkArtifactRatio(
        source.data,
        image.data,
        source.width,
        shifted,
        template,
        brightWatermark,
      );
      if (artifact > MAX_DARK_ARTIFACT_RATIO) continue;

      const score = suppression - artifact * 0.35;
      const bestScore = bestSuppression - bestArtifact * 0.35;
      if (score > bestScore + 0.002) {
        bestSuppression = suppression;
        bestArtifact = artifact;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  return { offsetX: bestDx, offsetY: bestDy };
}

/** 탐지 직후 1회 실행 — 최적 gain·템플릿·위치를 캐시에 저장 */
export function computeGeminiRemovalPlan(
  source: ImageData,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  brightWatermark: boolean,
  options: GeminiNccOptions = DEFAULT_REMOVAL_OPTIONS,
): GeminiRemovalPlan {
  let result = pickBestAlphaGainRemoval(source, match, template, options, brightWatermark);
  result = refineOutlineResidual(source, match, template, options, brightWatermark, result);
  const { offsetX, offsetY } = refineRemovalPosition(
    source,
    match,
    result.template,
    options,
    brightWatermark,
    result.gain,
  );
  return {
    template: result.template,
    alphaGain: result.gain,
    offsetX,
    offsetY,
  };
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
  const { match, brightWatermark, removalPlan } = cache;
  const template = removalPlan?.template ?? cache.template;
  const baseGain = removalPlan?.alphaGain ?? 1;
  const userGain =
    Number.isFinite(options.globalAlpha) && options.globalAlpha > 0
      ? options.globalAlpha
      : 1;
  const effectiveGain = baseGain * userGain;
  const offsetX = removalPlan?.offsetX ?? 0;
  const offsetY = removalPlan?.offsetY ?? 0;
  const effectiveMatch: WatermarkMatchResult =
    offsetX === 0 && offsetY === 0
      ? match
      : { ...match, x: match.x + offsetX, y: match.y + offsetY };

  const copy = cloneImageData(imageData);
  applyGeminiTemplateInverseAlpha(
    copy,
    source,
    effectiveMatch,
    template,
    { ...options, globalAlpha: effectiveGain },
    brightWatermark,
  );

  stabilizeGeminiRemovalToBackground(
    copy,
    source,
    effectiveMatch,
    template,
    brightWatermark,
  );

  repairGeminiLuminanceResidual(
    copy,
    source,
    effectiveMatch,
    template,
    brightWatermark,
  );

  sealGeminiMatteRegion(
    copy,
    source,
    effectiveMatch,
    template,
    brightWatermark,
  );

  if (options.edgeFeather?.enabled) {
    applyGeminiEdgeFeather(copy, source, effectiveMatch, template, options.edgeFeather);
  }

  imageData.data.set(copy.data);
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
  const removalPlan = computeGeminiRemovalPlan(
    imageData,
    match,
    template,
    brightWatermark,
  );
  const refinedMatch: WatermarkMatchResult = {
    ...match,
    x: match.x + removalPlan.offsetX,
    y: match.y + removalPlan.offsetY,
  };

  return {
    match: refinedMatch,
    template: removalPlan.template,
    region,
    detected,
    imageKey,
    brightWatermark,
    removalPlan: { ...removalPlan, offsetX: 0, offsetY: 0 },
  };
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
  const removalPlan = computeGeminiRemovalPlan(
    imageData,
    alignedMatch,
    template,
    brightWatermark,
  );

  const refinedMatch: WatermarkMatchResult = {
    ...alignedMatch,
    x: clamped.x + removalPlan.offsetX,
    y: clamped.y + removalPlan.offsetY,
  };

  const region = padRegionAroundMatch(
    clampRegion(
      {
        x: refinedMatch.x,
        y: refinedMatch.y,
        width: refinedMatch.templateSize,
        height: refinedMatch.templateSize,
      },
      width,
      height,
    ),
    width,
    height,
  );

  return {
    match: refinedMatch,
    template: removalPlan.template,
    region,
    detected: true,
    imageKey: `${imageKey}#manual`,
    brightWatermark,
    removalPlan: { ...removalPlan, offsetX: 0, offsetY: 0 },
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
