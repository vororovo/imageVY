/**
 * Gemini ✦ 제거 — 질감 인페인팅 방식
 * 알파/역블렌딩 대신 원본 질감 경계에서 마스크 내부를 채웁니다.
 * 나무·텍스처 배경에서 역알파 잔상(어두운 별 자국)을 피합니다.
 */

import { applyInpaintingOnPixelMask } from "@/lib/image/inpainting";
import type { WatermarkMatchResult } from "@/lib/image/ncc-match";
import type { SparkleTemplate } from "@/lib/image/sparkle-template";

export type GeminiRemovalMode = "texture-inpaint" | "alpha-refine";

export const DEFAULT_GEMINI_REMOVAL_MODE: GeminiRemovalMode = "texture-inpaint";

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

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

function estimateLocalBgLum(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  px: number,
  py: number,
  ox: number,
  oy: number,
  templateSize: number,
  templateAlpha: Float32Array,
): number {
  let sum = 0;
  let count = 0;

  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      const nx = px + dx;
      const ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

      const tx = nx - ox;
      const ty = ny - oy;
      if (tx >= 0 && tx < templateSize && ty >= 0 && ty < templateSize) {
        if (templateAlpha[ty * templateSize + tx] >= 0.03) continue;
      }

      const dist = Math.hypot(dx, dy);
      if (dist > 6 || dist < 1) continue;

      const pi = (ny * width + nx) * 4;
      sum += luminance(data[pi], data[pi + 1], data[pi + 2]);
      count++;
    }
  }

  if (count === 0) {
    const pi = (py * width + px) * 4;
    return luminance(data[pi], data[pi + 1], data[pi + 2]);
  }
  return sum / count;
}

function dilateBinaryMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          out[ny * width + nx] = 1;
        }
      }
    }
  }
  return out;
}

/** 밝기 차이 + 템플릿 실루엣으로 인페인팅 마스크 생성 */
export function buildGeminiInpaintMask(
  originalSource: ImageData,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  brightWatermark: boolean,
  paddingPx: number,
): Uint8Array {
  const { data, width, height } = originalSource;
  const { size, alpha } = template;
  const { x: ox, y: oy } = match;
  const dilated = dilateAlphaMap(alpha, size, Math.max(1, paddingPx));
  const mask = new Uint8Array(width * height);
  let signalCount = 0;

  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const tpl = dilated[ty * size + tx];
      if (tpl < 0.012) continue;

      const px = ox + tx;
      const py = oy + ty;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;

      const pi = (py * width + px) * 4;
      const origLum = luminance(data[pi], data[pi + 1], data[pi + 2]);
      const bgLum = estimateLocalBgLum(
        data,
        width,
        height,
        px,
        py,
        ox,
        oy,
        size,
        alpha,
      );
      const delta = brightWatermark ? origLum - bgLum : bgLum - origLum;
      const mi = py * width + px;

      if (delta >= 2.8) {
        mask[mi] = 1;
        signalCount++;
      } else if (tpl >= 0.05 && delta >= 1.2) {
        mask[mi] = 1;
        signalCount++;
      }
    }
  }

  if (signalCount < 6) {
    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        const tpl = dilated[ty * size + tx];
        if (tpl < 0.04) continue;
        const px = ox + tx;
        const py = oy + ty;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        mask[py * width + px] = 1;
      }
    }
  }

  return dilateBinaryMask(mask, width, height, 1);
}

export function applyGeminiMatteInpaint(
  imageData: ImageData,
  originalSource: ImageData,
  match: WatermarkMatchResult,
  template: SparkleTemplate,
  brightWatermark: boolean,
  paddingPx: number,
): void {
  const mask = buildGeminiInpaintMask(
    originalSource,
    match,
    template,
    brightWatermark,
    paddingPx,
  );

  let masked = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) masked++;
  }
  if (masked === 0) return;

  imageData.data.set(originalSource.data);
  applyInpaintingOnPixelMask(imageData, mask, 1600);
}
