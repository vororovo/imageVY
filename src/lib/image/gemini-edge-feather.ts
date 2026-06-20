/**
 * Gemini ✦ 제거 후 윤곽/테두리 잔상 완화
 * 알파 맵을 바깥으로 dilate(패딩)한 링 영역에서 주변 배경색으로 페더 블렌딩
 */

import type { WatermarkMatchResult } from "@/lib/image/ncc-match";
import type { SparkleTemplate } from "@/lib/image/sparkle-template";

export type GeminiEdgeFeatherOptions = {
  enabled: boolean;
  /** 알파 실루엣 바깥으로 확장할 픽셀 (1~8) */
  paddingPx: number;
};

export const DEFAULT_GEMINI_EDGE_FEATHER: GeminiEdgeFeatherOptions = {
  enabled: true,
  paddingPx: 3,
};

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampPadding(paddingPx: number): number {
  return Math.max(1, Math.min(8, Math.round(paddingPx)));
}

/** morphological dilation on alpha map */
function dilateAlphaMap(
  alpha: Float32Array,
  size: number,
  radius: number,
): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let peak = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > radius * radius + radius * 0.25) continue;
          const sx = x + dx;
          const sy = y + dy;
          if (sx < 0 || sy < 0 || sx >= size || sy >= size) continue;
          peak = Math.max(peak, alpha[sy * size + sx]);
        }
      }
      out[y * size + x] = peak;
    }
  }
  return out;
}

function estimateBackgroundRgb(
  data: Uint8ClampedArray,
  width: number,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
): [number, number, number] {
  const { size, alpha } = template;
  const { x, y } = match;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;

  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      if (alpha[ty * size + tx] >= 0.035) continue;
      const pi = ((y + ty) * width + (x + tx)) * 4;
      rSum += data[pi];
      gSum += data[pi + 1];
      bSum += data[pi + 2];
      count++;
    }
  }

  if (count === 0) return [128, 128, 128];
  return [rSum / count, gSum / count, bSum / count];
}

function sampleRingBackground(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  px: number,
  py: number,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  dilatedAlpha: Float32Array,
  fallback: [number, number, number],
): [number, number, number] {
  const { size, alpha } = template;
  const { x: ox, y: oy } = match;
  const search = 5;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;

  for (let dy = -search; dy <= search; dy++) {
    for (let dx = -search; dx <= search; dx++) {
      const nx = px + dx;
      const ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

      const tx = nx - ox;
      const ty = ny - oy;
      if (tx >= 0 && tx < size && ty >= 0 && ty < size) {
        const core = alpha[ty * size + tx];
        const dil = dilatedAlpha[ty * size + tx];
        if (core >= 0.04 || dil >= 0.06) continue;
      }

      const pi = (ny * width + nx) * 4;
      rSum += data[pi];
      gSum += data[pi + 1];
      bSum += data[pi + 2];
      count++;
    }
  }

  if (count === 0) return fallback;
  return [rSum / count, gSum / count, bSum / count];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 역블렌딩 결과의 윤곽/프린지를 주변 배경색으로 부드럽게 페더
 */
export function applyGeminiEdgeFeather(
  imageData: ImageData,
  originalSource: ImageData,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  options: GeminiEdgeFeatherOptions,
): void {
  if (!options.enabled) return;

  const paddingPx = clampPadding(options.paddingPx);
  const { data, width, height } = imageData;
  const { size, alpha } = template;
  const { x: ox, y: oy } = match;
  const dilated = dilateAlphaMap(alpha, size, paddingPx);
  const fallbackBg = estimateBackgroundRgb(originalSource.data, width, match, template);

  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const idx = ty * size + tx;
      const coreAlpha = alpha[idx];
      const dilAlpha = dilated[idx];
      if (dilAlpha < 0.012) continue;

      const px = ox + tx;
      const py = oy + ty;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;

      const pi = (py * width + px) * 4;
      const origPi = pi;
      const origR = originalSource.data[origPi];
      const origG = originalSource.data[origPi + 1];
      const origB = originalSource.data[origPi + 2];

      const ringBoost = Math.max(0, dilAlpha - coreAlpha * 0.92);
      const fringeBoost = coreAlpha >= 0.012 && coreAlpha < 0.1 ? 1 - coreAlpha / 0.1 : 0;
      const paddingBoost =
        dilAlpha >= 0.04 && coreAlpha < 0.04
          ? smoothstep(0.04, 0.12, dilAlpha)
          : 0;

      let feather = Math.max(ringBoost * 1.4, fringeBoost * 0.75, paddingBoost * 0.9);
      feather = Math.max(0, Math.min(1, feather));

      if (feather <= 0.01) continue;

      const [bgR, bgG, bgB] = sampleRingBackground(
        originalSource.data,
        width,
        height,
        px,
        py,
        match,
        template,
        dilated,
        fallbackBg,
      );

      let r = data[pi];
      let g = data[pi + 1];
      let b = data[pi + 2];

      r = r + (bgR - r) * feather;
      g = g + (bgG - g) * feather;
      b = b + (bgB - b) * feather;

      const maxDev = 18 + (1 - feather) * 10;
      r = Math.max(bgR - maxDev, Math.min(bgR + maxDev, r));
      g = Math.max(bgG - maxDev, Math.min(bgG + maxDev, g));
      b = Math.max(bgB - maxDev, Math.min(bgB + maxDev, b));

      if (feather > 0.35) {
        r = r * 0.65 + origR * 0.35 * (1 - feather);
        g = g * 0.65 + origG * 0.35 * (1 - feather);
        b = b * 0.65 + origB * 0.35 * (1 - feather);
      }

      data[pi] = clampChannel(r);
      data[pi + 1] = clampChannel(g);
      data[pi + 2] = clampChannel(b);
    }
  }
}

/** 역블렌딩 직후 배경 대비 과도한 어두움/밝기를 완화 */
export function stabilizeGeminiRemovalToBackground(
  imageData: ImageData,
  originalSource: ImageData,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  brightWatermark: boolean,
): void {
  const { data, width, height } = imageData;
  const { size, alpha } = template;
  const { x: ox, y: oy } = match;
  const fallbackBg = estimateBackgroundRgb(originalSource.data, width, match, template);
  const dilated = dilateAlphaMap(alpha, size, 2);

  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const matte = alpha[ty * size + tx];
      if (matte < 0.025) continue;

      const px = ox + tx;
      const py = oy + ty;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;

      const pi = (py * width + px) * 4;
      const [bgR, bgG, bgB] = sampleRingBackground(
        originalSource.data,
        width,
        height,
        px,
        py,
        match,
        template,
        dilated,
        fallbackBg,
      );

      let r = data[pi];
      let g = data[pi + 1];
      let b = data[pi + 2];
      const tol = 12 + matte * 18;

      if (brightWatermark) {
        if (r < bgR - tol) r = bgR - tol + (r - (bgR - tol)) * 0.25;
        if (g < bgG - tol) g = bgG - tol + (g - (bgG - tol)) * 0.25;
        if (b < bgB - tol) b = bgB - tol + (b - (bgB - tol)) * 0.25;
      } else {
        if (r > bgR + tol) r = bgR + tol + (r - (bgR + tol)) * 0.25;
        if (g > bgG + tol) g = bgG + tol + (g - (bgG + tol)) * 0.25;
        if (b > bgB + tol) b = bgB + tol + (b - (bgB + tol)) * 0.25;
      }

      data[pi] = clampChannel(r);
      data[pi + 1] = clampChannel(g);
      data[pi + 2] = clampChannel(b);
    }
  }
}
