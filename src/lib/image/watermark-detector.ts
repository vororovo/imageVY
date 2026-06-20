/**
 * 통합 워터마크 탐지 파이프라인
 * 우하단 마진 그리드 + 밝기 대비(반투명 흰색 로고) 기반 탐지
 */

import {
  clamp,
  combinedDetectionScore,
  computeRegionGradientCorrelation,
  computeRegionSpatialCorrelation,
  interpolateAlphaMap,
  normalizedCrossCorrelation,
  pixelLuminance,
  warpAlphaMap,
} from "@/lib/image/alpha-map-utils";
import { getEmbeddedAlphaMap } from "@/lib/image/embedded-alpha-maps";
import {
  getOfficialPrimaryConfig,
  getWatermarkPositionFromConfig,
  resolveAlphaMapKey,
  resolveGeminiWatermarkSearchConfigs,
  type GeminiWatermarkConfig,
} from "@/lib/image/gemini-size-catalog";
import type { Region } from "@/lib/image/region";

export type WatermarkMatchResult = {
  x: number;
  y: number;
  score: number;
  templateSize: number;
  config: GeminiWatermarkConfig;
  alphaMapKey: string;
  spatialScore: number;
  gradientScore: number;
  alignedAlpha?: Float32Array;
  detectionSource?: string;
  suppressionGain?: number;
};

const TEMPLATE_SHIFTS = [-1, -0.5, 0, 0.5, 1] as const;
const TEMPLATE_SCALES = [0.97, 0.99, 1, 1.01, 1.03] as const;
const DETECT_CONFIDENCE_MIN = 0.18;

type DetectionCandidate = {
  x: number;
  y: number;
  size: number;
  alphaMapKey: string;
  alphaMap: Float32Array;
  luminanceScore: number;
  spatialScore: number;
  gradientScore: number;
  confidence: number;
  suppressionGain: number;
  source: string;
  config: GeminiWatermarkConfig;
};

function getAlphaMapAtSize(alphaMapKey: string, size: number): Float32Array | null {
  const embedded = getEmbeddedAlphaMap(alphaMapKey);
  if (!embedded) return null;

  const sourceSize = Math.round(Math.sqrt(embedded.length));
  if (sourceSize === size) return embedded;
  return interpolateAlphaMap(embedded, sourceSize, size);
}

export function measureSuppressionGain(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  size: number,
  alphaMap: Float32Array,
  brightWatermark?: boolean,
): number {
  const region = { x, y, size };
  const before = Math.abs(
    computeRegionSpatialCorrelation(data, width, height, alphaMap, region),
  );

  let wmSum = 0;
  let bgSum = 0;
  let wmCount = 0;
  let bgCount = 0;
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const matte = alphaMap[ty * size + tx];
      const pi = ((y + ty) * width + (x + tx)) * 4;
      const lum = pixelLuminance(data, pi);
      if (matte >= 0.12) {
        wmSum += lum;
        wmCount++;
      } else if (matte < 0.02) {
        bgSum += lum;
        bgCount++;
      }
    }
  }
  const bright =
    brightWatermark ??
    (wmCount === 0 || bgCount === 0 || wmSum / wmCount > bgSum / bgCount);

  const restored = new Float32Array(size * size);
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const matte = Math.abs(alphaMap[ty * size + tx]);
      const pi = ((y + ty) * width + (x + tx)) * 4;
      if (matte < 0.04) {
        restored[ty * size + tx] =
          (0.2126 * data[pi] + 0.7152 * data[pi + 1] + 0.0722 * data[pi + 2]) / 255;
        continue;
      }
      const alpha = Math.min(matte, 0.99);
      const logo = bright ? 255 : 0;
      const r = (data[pi] - alpha * logo) / (1 - alpha);
      const g = (data[pi + 1] - alpha * logo) / (1 - alpha);
      const b = (data[pi + 2] - alpha * logo) / (1 - alpha);
      restored[ty * size + tx] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
  }

  const after = Math.abs(normalizedCrossCorrelation(restored, alphaMap));
  return Math.max(0, before - after);
}

function catalogDistanceBonus(
  candidate: DetectionCandidate,
  width: number,
  height: number,
  config: GeminiWatermarkConfig,
): number {
  const { x: ex, y: ey } = getWatermarkPositionFromConfig(width, height, config);
  const dist = Math.hypot(candidate.x - ex, candidate.y - ey);
  const maxDist = Math.max(config.logoSize * 1.5, 64);
  return Math.max(0, 1 - dist / maxDist) * 0.35;
}

function rankCandidate(
  c: DetectionCandidate,
  width: number,
  height: number,
  config: GeminiWatermarkConfig,
): number {
  const referenceSize = Math.min(width, height) >= 1400 ? 96 : 48;
  const sizeWeight = Math.min(1, Math.cbrt(c.size / referenceSize));
  const distBonus = catalogDistanceBonus(c, width, height, config);
  const smallPenalty = c.size < 48 && Math.min(width, height) >= 1024 ? 0.5 : 0;

  return (
    (c.luminanceScore * 2.2 +
      c.suppressionGain * 2 +
      c.confidence * 1.2 +
      distBonus) *
      sizeWeight -
    smallPenalty
  );
}

function makeCandidate(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  size: number,
  alphaMapKey: string,
  alphaMap: Float32Array,
  config: GeminiWatermarkConfig,
  source: string,
): DetectionCandidate {
  const scores = combinedDetectionScore(data, width, height, x, y, size, alphaMap);
  return {
    x,
    y,
    size,
    alphaMapKey,
    alphaMap,
    ...scores,
    suppressionGain: measureSuppressionGain(data, width, height, x, y, size, alphaMap),
    source,
    config: {
      ...config,
      logoSize: size,
      marginRight: width - x - size,
      marginBottom: height - y - size,
    },
  };
}

function pushTop(
  list: DetectionCandidate[],
  candidate: DetectionCandidate,
  width: number,
  height: number,
  config: GeminiWatermarkConfig,
  limit = 10,
): void {
  list.push(candidate);
  list.sort(
    (a, b) => rankCandidate(b, width, height, config) - rankCandidate(a, width, height, config),
  );
  if (list.length > limit) list.length = limit;
}

/** 선택 영역 내 탐지 — NCC·역블렌딩 검증 우선, 카탈로그 크기 일치 보너스 */
function rankSelectionCandidate(c: DetectionCandidate, expectedSize: number): number {
  const sizeBonus = Math.abs(c.size - expectedSize) <= 1 ? 1.15 : 1;
  return (
    (c.suppressionGain * 3.5 +
      Math.max(0, c.spatialScore) * 2.5 +
      c.luminanceScore * 1.5 +
      c.confidence * 0.8) *
    sizeBonus
  );
}

function pushTopSelection(
  list: DetectionCandidate[],
  candidate: DetectionCandidate,
  expectedSize: number,
  limit = 16,
): void {
  list.push(candidate);
  list.sort(
    (a, b) => rankSelectionCandidate(b, expectedSize) - rankSelectionCandidate(a, expectedSize),
  );
  if (list.length > limit) list.length = limit;
}

function selectionContainsTemplate(
  selection: Region,
  x: number,
  y: number,
  size: number,
): boolean {
  return (
    x >= selection.x &&
    y >= selection.y &&
    x + size <= selection.x + selection.width &&
    y + size <= selection.y + selection.height
  );
}

function collectSelectionAnchors(
  selection: Region,
  width: number,
  height: number,
  config: GeminiWatermarkConfig,
): { x: number; y: number }[] {
  const size = config.logoSize;
  const anchors: { x: number; y: number }[] = [];
  const seen = new Set<string>();

  const push = (x: number, y: number) => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix + size > width || iy + size > height) return;
    if (!selectionContainsTemplate(selection, ix, iy, size)) return;
    const key = `${ix},${iy}`;
    if (seen.has(key)) return;
    seen.add(key);
    anchors.push({ x: ix, y: iy });
  };

  const { x: ex, y: ey } = getWatermarkPositionFromConfig(width, height, config);
  push(ex, ey);
  push(selection.x + (selection.width - size) / 2, selection.y + (selection.height - size) / 2);
  push(selection.x + selection.width - size, selection.y + selection.height - size);
  push(selection.x, selection.y);

  return anchors;
}

function searchSelectionAtSize(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  selection: Region,
  config: GeminiWatermarkConfig,
  size: number,
  alphaMapKey: string,
  alphaMap: Float32Array,
  results: DetectionCandidate[],
  expectedSize: number,
  step: number,
  source: string,
): void {
  const xEnd = selection.x + selection.width - size;
  const yEnd = selection.y + selection.height - size;
  if (xEnd < selection.x || yEnd < selection.y) return;

  for (let y = selection.y; y <= yEnd; y += step) {
    for (let x = selection.x; x <= xEnd; x += step) {
      const candidate = makeCandidate(
        data,
        width,
        height,
        x,
        y,
        size,
        alphaMapKey,
        alphaMap,
        config,
        source,
      );
      if (candidate.suppressionGain < 0.015 && candidate.spatialScore < 0.08) continue;
      pushTopSelection(results, candidate, expectedSize);
    }
  }
}

function searchNearCandidate(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  selection: Region,
  config: GeminiWatermarkConfig,
  seed: DetectionCandidate,
  results: DetectionCandidate[],
  expectedSize: number,
  radius = 16,
): void {
  const alphaMap = getAlphaMapAtSize(seed.alphaMapKey, seed.size);
  if (!alphaMap) return;

  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = seed.x + dx;
      const y = seed.y + dy;
      if (!selectionContainsTemplate(selection, x, y, seed.size)) continue;
      const candidate = makeCandidate(
        data,
        width,
        height,
        x,
        y,
        seed.size,
        seed.alphaMapKey,
        alphaMap,
        config,
        "selection-local",
      );
      pushTopSelection(results, candidate, expectedSize);
    }
  }
}

function searchAroundAnchors(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  selection: Region,
  config: GeminiWatermarkConfig,
  size: number,
  alphaMapKey: string,
  alphaMap: Float32Array,
  anchors: { x: number; y: number }[],
  results: DetectionCandidate[],
  expectedSize: number,
): void {
  const radius = Math.max(14, Math.round(size * 0.18));
  for (const anchor of anchors) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = anchor.x + dx;
        const y = anchor.y + dy;
        if (!selectionContainsTemplate(selection, x, y, size)) continue;
        const candidate = makeCandidate(
          data,
          width,
          height,
          x,
          y,
          size,
          alphaMapKey,
          alphaMap,
          config,
          "selection-anchor",
        );
        pushTopSelection(results, candidate, expectedSize);
      }
    }
  }
}

/** 카탈로그 마진 주변 그리드 + 크기 스윕 (핵심 탐지) */
function searchMarginGrid(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  config: GeminiWatermarkConfig,
): DetectionCandidate[] {
  const results: DetectionCandidate[] = [];
  const alphaMapKey = String(resolveAlphaMapKey(config));
  const marginSlack = Math.max(40, Math.round(config.logoSize * 0.85));
  const minMR = Math.max(8, config.marginRight - marginSlack);
  const maxMR = config.marginRight + marginSlack;
  const minMB = Math.max(8, config.marginBottom - marginSlack);
  const maxMB = config.marginBottom + marginSlack;
  const marginStep = config.logoSize >= 72 ? 4 : 6;
  const sizeLo = Math.max(24, config.logoSize - 12);
  const sizeHi = config.logoSize + 12;
  const sizeStep = 2;

  for (let size = sizeLo; size <= sizeHi; size += sizeStep) {
    const alphaMap = getAlphaMapAtSize(alphaMapKey, size);
    if (!alphaMap) continue;

    for (let mr = minMR; mr <= maxMR; mr += marginStep) {
      const x = width - mr - size;
      if (x < 0 || x + size > width) continue;

      for (let mb = minMB; mb <= maxMB; mb += marginStep) {
        const y = height - mb - size;
        if (y < 0 || y + size > height) continue;

        const candidate = makeCandidate(
          data,
          width,
          height,
          x,
          y,
          size,
          alphaMapKey,
          alphaMap,
          config,
          "margin-grid",
        );

        if (candidate.luminanceScore < 0.04 && candidate.confidence < 0.1) continue;
        pushTop(results, candidate, width, height, config);
      }
    }
  }

  return results;
}

function refineCandidate(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seed: DetectionCandidate,
): DetectionCandidate {
  let best = seed;

  for (let size = seed.size - 6; size <= seed.size + 6; size += 2) {
    if (size < 20) continue;
    const alphaMap = getAlphaMapAtSize(seed.alphaMapKey, size);
    if (!alphaMap) continue;

    for (let dx = -8; dx <= 8; dx += 2) {
      for (let dy = -8; dy <= 8; dy += 2) {
        const x = seed.x + dx;
        const y = seed.y + dy;
        if (x < 0 || y < 0 || x + size > width || y + size > height) continue;

        const candidate = makeCandidate(
          data,
          width,
          height,
          x,
          y,
          size,
          seed.alphaMapKey,
          alphaMap,
          seed.config,
          "refine",
        );
        if (
          rankCandidate(candidate, width, height, seed.config) >
          rankCandidate(best, width, height, seed.config)
        ) {
          best = candidate;
        }
      }
    }
  }

  return best;
}

function refineSelectionCandidate(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seed: DetectionCandidate,
  expectedSize: number,
): DetectionCandidate {
  let best = seed;

  for (let size = seed.size - 4; size <= seed.size + 4; size += 2) {
    if (size < 20) continue;
    const alphaMap = getAlphaMapAtSize(seed.alphaMapKey, size);
    if (!alphaMap) continue;

    for (let dx = -10; dx <= 10; dx += 1) {
      for (let dy = -10; dy <= 10; dy += 1) {
        const x = seed.x + dx;
        const y = seed.y + dy;
        if (x < 0 || y < 0 || x + size > width || y + size > height) continue;

        const candidate = makeCandidate(
          data,
          width,
          height,
          x,
          y,
          size,
          seed.alphaMapKey,
          alphaMap,
          seed.config,
          "selection-refine",
        );
        if (rankSelectionCandidate(candidate, expectedSize) > rankSelectionCandidate(best, expectedSize)) {
          best = candidate;
        }
      }
    }
  }

  return best;
}

/** suppressionGain 기준 ±3px 위치 미세 정렬 (알파 warp만으로는 보정 안 되는 정수 픽셀 오차) */
function refineSelectionBySuppression(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seed: DetectionCandidate,
): DetectionCandidate {
  let best = seed;
  const radius = 3;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = seed.x + dx;
      const y = seed.y + dy;
      if (x < 0 || y < 0 || x + seed.size > width || y + seed.size > height) continue;

      const candidate = makeCandidate(
        data,
        width,
        height,
        x,
        y,
        seed.size,
        seed.alphaMapKey,
        seed.alphaMap,
        seed.config,
        "selection-suppression",
      );
      if (candidate.suppressionGain > best.suppressionGain + 0.003) {
        best = candidate;
      }
    }
  }

  return best;
}

function refineTemplateWarp(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seed: DetectionCandidate,
): DetectionCandidate {
  let bestAlpha = seed.alphaMap;
  let bestLum = seed.luminanceScore;
  let bestSpatial = seed.spatialScore;
  let bestGradient = seed.gradientScore;

  for (const scale of TEMPLATE_SCALES) {
    for (const dy of TEMPLATE_SHIFTS) {
      for (const dx of TEMPLATE_SHIFTS) {
        if (dx === 0 && dy === 0 && scale === 1) continue;
        const warped = warpAlphaMap(seed.alphaMap, seed.size, { dx, dy, scale });
        const region = { x: seed.x, y: seed.y, size: seed.size };
        const lum = combinedDetectionScore(
          data,
          width,
          height,
          seed.x,
          seed.y,
          seed.size,
          warped,
        ).luminanceScore;
        const spatial = computeRegionSpatialCorrelation(
          data,
          width,
          height,
          warped,
          region,
        );
        const gradient = computeRegionGradientCorrelation(
          data,
          width,
          height,
          warped,
          region,
        );
        const score = lum * 0.55 + Math.max(0, spatial) * 0.25 + Math.max(0, gradient) * 0.2;
        const bestScore =
          bestLum * 0.55 + Math.max(0, bestSpatial) * 0.25 + Math.max(0, bestGradient) * 0.2;

        if (score > bestScore + 0.008) {
          bestAlpha = warped;
          bestLum = lum;
          bestSpatial = spatial;
          bestGradient = gradient;
        }
      }
    }
  }

  if (bestAlpha === seed.alphaMap) return seed;

  return {
    ...seed,
    alphaMap: bestAlpha,
    luminanceScore: bestLum,
    spatialScore: bestSpatial,
    gradientScore: bestGradient,
    confidence: bestLum * 0.55 + Math.max(0, bestSpatial) * 0.25 + Math.max(0, bestGradient) * 0.2,
    suppressionGain: measureSuppressionGain(
      data,
      width,
      height,
      seed.x,
      seed.y,
      seed.size,
      bestAlpha,
    ),
    source: `${seed.source}+warp`,
  };
}

function candidateToMatch(candidate: DetectionCandidate): WatermarkMatchResult {
  return {
    x: candidate.x,
    y: candidate.y,
    score: candidate.confidence,
    templateSize: candidate.size,
    config: candidate.config,
    alphaMapKey: candidate.alphaMapKey,
    spatialScore: candidate.spatialScore,
    gradientScore: candidate.gradientScore,
    alignedAlpha: candidate.alphaMap,
    detectionSource: candidate.source,
    suppressionGain: candidate.suppressionGain,
  };
}

function configKey(config: GeminiWatermarkConfig): string {
  return `${config.logoSize}:${config.marginRight}:${config.marginBottom}:${config.alphaVariant ?? ""}`;
}

/** 사용자가 지정한 ROI 안에서 ✦ 로고 위치·크기·알파 맵을 탐지 */
export function detectWatermarkInSelection(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  selection: Region,
): WatermarkMatchResult {
  const primaryConfig = getOfficialPrimaryConfig(width, height);
  const fallbackConfig = resolveGeminiWatermarkSearchConfigs(width, height)[0];
  const config = primaryConfig ??
    fallbackConfig ?? { logoSize: 48, marginRight: 32, marginBottom: 32 };

  const expectedSize = config.logoSize;
  const alphaMapKey = String(resolveAlphaMapKey(config));
  const maxFit = Math.min(selection.width, selection.height);
  const results: DetectionCandidate[] = [];

  const primarySize = Math.min(expectedSize, maxFit);
  const primaryAlpha = getAlphaMapAtSize(alphaMapKey, primarySize);
  if (primaryAlpha) {
    const anchors = collectSelectionAnchors(selection, width, height, {
      ...config,
      logoSize: primarySize,
    });
    searchAroundAnchors(
      data,
      width,
      height,
      selection,
      config,
      primarySize,
      alphaMapKey,
      primaryAlpha,
      anchors,
      results,
      expectedSize,
    );
  }

  if (maxFit >= expectedSize) {
    const sizeLo = expectedSize;
    const sizeHi = expectedSize;
    for (let size = sizeLo; size <= sizeHi; size += 2) {
      const alphaMap = getAlphaMapAtSize(alphaMapKey, size);
      if (!alphaMap) continue;
      searchSelectionAtSize(
        data,
        width,
        height,
        selection,
        config,
        size,
        alphaMapKey,
        alphaMap,
        results,
        expectedSize,
        1,
        "selection",
      );
    }
  } else {
    const sizeLo = Math.max(20, maxFit);
    const sizeHi = Math.max(20, maxFit);
    for (let size = sizeLo; size <= sizeHi; size += 2) {
      const alphaMap = getAlphaMapAtSize(alphaMapKey, size);
      if (!alphaMap) continue;
      searchSelectionAtSize(
        data,
        width,
        height,
        selection,
        config,
        size,
        alphaMapKey,
        alphaMap,
        results,
        expectedSize,
        2,
        "selection-small",
      );
    }
  }

  let best = results[0] ?? null;

  if (best) {
    searchNearCandidate(
      data,
      width,
      height,
      selection,
      config,
      best,
      results,
      expectedSize,
    );
    best = results[0] ?? best;
  }

  if (!best) {
    const size = primarySize;
    const { x: ex, y: ey } = getWatermarkPositionFromConfig(width, height, config);
    const fallbackX = selectionContainsTemplate(selection, ex, ey, size)
      ? ex
      : clamp(selection.x + selection.width - size, 0, width - size);
    const fallbackY = selectionContainsTemplate(selection, ex, ey, size)
      ? ey
      : clamp(selection.y + selection.height - size, 0, height - size);
    const alphaMap = getAlphaMapAtSize(alphaMapKey, size);
    if (alphaMap) {
      best = makeCandidate(
        data,
        width,
        height,
        fallbackX,
        fallbackY,
        size,
        alphaMapKey,
        alphaMap,
        config,
        "selection-fallback",
      );
    }
  }

  if (!best) {
    const { x, y } = getWatermarkPositionFromConfig(width, height, config);
    const alphaMap = getAlphaMapAtSize(alphaMapKey, config.logoSize);
    return {
      x: Math.max(0, x),
      y: Math.max(0, y),
      score: 0,
      templateSize: config.logoSize,
      config,
      alphaMapKey,
      spatialScore: 0,
      gradientScore: 0,
      alignedAlpha: alphaMap ?? undefined,
      detectionSource: "manual-fallback",
      suppressionGain: 0,
    };
  }

  let refined = refineSelectionCandidate(data, width, height, best, expectedSize);

  const selectionCenterX = selection.x + selection.width / 2;
  const selectionCenterY = selection.y + selection.height / 2;
  const { x: catalogX, y: catalogY } = getWatermarkPositionFromConfig(width, height, config);
  const catalogNearSelection =
    Math.hypot(
      selectionCenterX - (catalogX + expectedSize / 2),
      selectionCenterY - (catalogY + expectedSize / 2),
    ) <= expectedSize * 1.25;

  if (catalogNearSelection && selectionContainsTemplate(selection, catalogX, catalogY, expectedSize)) {
    const catalogAlpha = getAlphaMapAtSize(alphaMapKey, expectedSize);
    if (catalogAlpha) {
      const catalogCandidate = makeCandidate(
        data,
        width,
        height,
        catalogX,
        catalogY,
        expectedSize,
        alphaMapKey,
        catalogAlpha,
        config,
        "selection-catalog",
      );
      const refinedRank = rankSelectionCandidate(refined, expectedSize);
      const catalogRank = rankSelectionCandidate(catalogCandidate, expectedSize);
      if (
        refined.suppressionGain < 0.05 &&
        (catalogRank >= refinedRank * 0.85 || catalogCandidate.suppressionGain > refined.suppressionGain)
      ) {
        refined = refineSelectionCandidate(
          data,
          width,
          height,
          catalogCandidate,
          expectedSize,
        );
      }
    }
  }

  const warped = refineTemplateWarp(data, width, height, refined);
  if (warped.suppressionGain > refined.suppressionGain + 0.025) {
    refined = warped;
  }

  refined = refineSelectionBySuppression(data, width, height, refined);

  const match = candidateToMatch(refined);
  return { ...match, detectionSource: "manual" };
}

export function detectWatermarkMatch(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): WatermarkMatchResult {
  const configs = resolveGeminiWatermarkSearchConfigs(width, height);
  const primaryConfig = getOfficialPrimaryConfig(width, height);

  const seen = new Set<string>();
  const orderedConfigs: GeminiWatermarkConfig[] = [];
  if (primaryConfig) {
    orderedConfigs.push(primaryConfig);
    seen.add(configKey(primaryConfig));
  }
  for (const config of configs) {
    const key = configKey(config);
    if (seen.has(key)) continue;
    seen.add(key);
    orderedConfigs.push(config);
  }

  let best: DetectionCandidate | null = null;
  let bestConfig = orderedConfigs[0] ?? {
    logoSize: 48,
    marginRight: 32,
    marginBottom: 32,
  };

  for (const config of orderedConfigs) {
    const candidates = searchMarginGrid(data, width, height, config);
    for (const candidate of candidates) {
      if (
        !best ||
        rankCandidate(candidate, width, height, config) >
          rankCandidate(best, width, height, bestConfig)
      ) {
        best = candidate;
        bestConfig = config;
      }
    }
  }

  if (!best) {
    const fallback = orderedConfigs[0] ?? bestConfig;
    const alphaMapKey = String(resolveAlphaMapKey(fallback));
    const size = fallback.logoSize;
    const { x, y } = getWatermarkPositionFromConfig(width, height, fallback);
    const alphaMap = getAlphaMapAtSize(alphaMapKey, size);
    return {
      x: Math.max(0, x),
      y: Math.max(0, y),
      score: 0,
      templateSize: size,
      config: fallback,
      alphaMapKey,
      spatialScore: 0,
      gradientScore: 0,
      alignedAlpha: alphaMap ?? undefined,
      detectionSource: "fallback",
      suppressionGain: 0,
    };
  }

  best = refineTemplateWarp(data, width, height, refineCandidate(data, width, height, best));
  return candidateToMatch(best);
}

export function isWatermarkDetected(match: WatermarkMatchResult): boolean {
  if ((match.suppressionGain ?? 0) >= 0.05) return true;
  return Number.isFinite(match.score) && match.score >= DETECT_CONFIDENCE_MIN;
}
