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
  paddingPx: 4,
};

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampPadding(paddingPx: number): number {
  return Math.max(1, Math.min(8, Math.round(paddingPx)));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
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
      if (alpha[ty * size + tx] >= 0.03) continue;
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
  const search = 8;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let weightSum = 0;

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
        if (core >= 0.035 || dil >= 0.05) continue;
      }

      const dist = Math.hypot(dx, dy);
      const weight = 1 / (1 + dist * 0.35);
      const pi = (ny * width + nx) * 4;
      rSum += data[pi] * weight;
      gSum += data[pi + 1] * weight;
      bSum += data[pi + 2] * weight;
      weightSum += weight;
    }
  }

  if (weightSum === 0) return fallback;
  return [rSum / weightSum, gSum / weightSum, bSum / weightSum];
}

/** 저알파 윤곽 프린지 — 역블렌딩 잔상을 배경색으로 강하게 평탄화 */
function flattenOutlineFringe(
  data: Uint8ClampedArray,
  originalSource: Uint8ClampedArray,
  width: number,
  height: number,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  dilatedAlpha: Float32Array,
  fallbackBg: [number, number, number],
): void {
  const { size, alpha } = template;
  const { x: ox, y: oy } = match;

  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const idx = ty * size + tx;
      const matte = alpha[idx];
      if (matte < 0.012 || matte > 0.22) continue;

      const px = ox + tx;
      const py = oy + ty;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;

      const fringe =
        matte < 0.06
          ? smoothstep(0.012, 0.055, matte)
          : 1 - smoothstep(0.1, 0.22, matte);
      if (fringe <= 0.02) continue;

      const pi = (py * width + px) * 4;
      const [bgR, bgG, bgB] = sampleRingBackground(
        originalSource,
        width,
        height,
        px,
        py,
        match,
        template,
        dilatedAlpha,
        fallbackBg,
      );

      const strength = 0.55 + fringe * 0.4;
      let r = data[pi] + (bgR - data[pi]) * strength;
      let g = data[pi + 1] + (bgG - data[pi + 1]) * strength;
      let b = data[pi + 2] + (bgB - data[pi + 2]) * strength;

      data[pi] = clampChannel(r);
      data[pi + 1] = clampChannel(g);
      data[pi + 2] = clampChannel(b);
    }
  }
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

  flattenOutlineFringe(
    data,
    originalSource.data,
    width,
    height,
    match,
    template,
    dilated,
    fallbackBg,
  );

  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const idx = ty * size + tx;
      const coreAlpha = alpha[idx];
      const dilAlpha = dilated[idx];
      if (dilAlpha < 0.01) continue;

      const px = ox + tx;
      const py = oy + ty;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;

      const pi = (py * width + px) * 4;

      const ringBoost = Math.max(0, dilAlpha - coreAlpha * 0.88);
      const outerRing =
        dilAlpha >= 0.03 && coreAlpha < 0.03
          ? smoothstep(0.03, 0.14, dilAlpha)
          : 0;

      let feather = Math.max(ringBoost * 1.55, outerRing * 0.95);
      feather = Math.max(0, Math.min(1, feather));

      if (feather <= 0.008) continue;

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

      let r = data[pi] + (bgR - data[pi]) * feather;
      let g = data[pi + 1] + (bgG - data[pi + 1]) * feather;
      let b = data[pi + 2] + (bgB - data[pi + 2]) * feather;

      const maxDev = 14 + (1 - feather) * 8;
      r = Math.max(bgR - maxDev, Math.min(bgR + maxDev, r));
      g = Math.max(bgG - maxDev, Math.min(bgG + maxDev, g));
      b = Math.max(bgB - maxDev, Math.min(bgB + maxDev, b));

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
  const dilated = dilateAlphaMap(alpha, size, 3);

  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const matte = alpha[ty * size + tx];
      if (matte < 0.018) continue;

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
      const tol = 8 + matte * 14;
      const pull = matte < 0.08 ? 0.55 : 0.35;

      if (brightWatermark) {
        if (r > bgR + tol) r = bgR + tol + (r - (bgR + tol)) * pull;
        if (g > bgG + tol) g = bgG + tol + (g - (bgG + tol)) * pull;
        if (b > bgB + tol) b = bgB + tol + (b - (bgB + tol)) * pull;
        if (r < bgR - tol) r = bgR - tol + (r - (bgR - tol)) * pull;
        if (g < bgG - tol) g = bgG - tol + (g - (bgG - tol)) * pull;
        if (b < bgB - tol) b = bgB - tol + (b - (bgB - tol)) * pull;
      } else {
        if (r > bgR + tol) r = bgR + tol + (r - (bgR + tol)) * pull;
        if (g > bgG + tol) g = bgG + tol + (g - (bgG + tol)) * pull;
        if (b > bgB + tol) b = bgB + tol + (b - (bgB + tol)) * pull;
      }

      data[pi] = clampChannel(r);
      data[pi + 1] = clampChannel(g);
      data[pi + 2] = clampChannel(b);
    }
  }
}

function pixelLuminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * 역블렌딩 후 남는 밝/어두 잔광(별 윤곽 등)을 배경 밝기에 맞춰 제거
 */
export function repairGeminiLuminanceResidual(
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
  const dilated = dilateAlphaMap(alpha, size, 5);

  for (let pass = 0; pass < 2; pass++) {
    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        const idx = ty * size + tx;
        const core = alpha[idx];
        const dil = dilated[idx];
        if (core < 0.006 && dil < 0.02) continue;

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
        const resultLum = pixelLuminance(r, g, b);
        const bgLum = pixelLuminance(bgR, bgG, bgB);
        const origLum = pixelLuminance(
          originalSource.data[pi],
          originalSource.data[pi + 1],
          originalSource.data[pi + 2],
        );

        const fringe = core < 0.04 ? 1 : core < 0.12 ? 0.75 : 0.45;
        const lumDiff = brightWatermark ? resultLum - bgLum : bgLum - resultLum;
        const origDiff = brightWatermark ? origLum - bgLum : bgLum - origLum;

        if (lumDiff <= 3.5 || origDiff <= 4) continue;

        const strength = Math.min(0.92, fringe * (0.35 + lumDiff / 28));
        r = r + (bgR - r) * strength;
        g = g + (bgG - g) * strength;
        b = b + (bgB - b) * strength;

        data[pi] = clampChannel(r);
        data[pi + 1] = clampChannel(g);
        data[pi + 2] = clampChannel(b);
      }
    }
  }
}
