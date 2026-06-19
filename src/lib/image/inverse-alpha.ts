import type { Region } from "@/lib/image/region";

export type RgbColor = {
  r: number;
  g: number;
  b: number;
};

export type WatermarkBlendOptions = {
  color: RgbColor;
  alpha: number;
};

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function pixelIndex(x: number, y: number, width: number): number {
  return y * width + x;
}

function colorDistSq(
  r: number,
  g: number,
  b: number,
  tr: number,
  tg: number,
  tb: number,
): number {
  return (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2;
}

export function hexToRgb(hex: string): RgbColor {
  const normalized = hex.replace("#", "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((c) => c + c)
          .join("")
      : normalized;
  const value = Number.parseInt(expanded, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

export function estimateRegionBackground(
  data: Uint8ClampedArray,
  imageWidth: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): RgbColor {
  const regionW = x1 - x0;
  const regionH = y1 - y0;
  const border = Math.max(1, Math.min(6, Math.floor(Math.min(regionW, regionH) * 0.2)));

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;

  const sample = (x: number, y: number) => {
    const i = pixelIndex(x, y, imageWidth) * 4;
    rSum += data[i];
    gSum += data[i + 1];
    bSum += data[i + 2];
    count++;
  };

  for (let y = y0; y < y0 + border && y < y1; y++) {
    for (let x = x0; x < x1; x++) sample(x, y);
  }

  for (let x = x0; x < x0 + border && x < x1; x++) {
    for (let y = y0 + border; y < y1; y++) sample(x, y);
  }

  if (count === 0) return { r: 128, g: 128, b: 128 };

  return {
    r: Math.round(rSum / count),
    g: Math.round(gSum / count),
    b: Math.round(bSum / count),
  };
}

export function estimateLocalAlpha(
  r: number,
  g: number,
  b: number,
  bg: RgbColor,
  wm: RgbColor,
): number {
  const dr = wm.r - bg.r;
  const dg = wm.g - bg.g;
  const db = wm.b - bg.b;
  const denom = dr * dr + dg * dg + db * db;
  if (denom < 1) return 0;

  const t =
    ((r - bg.r) * dr + (g - bg.g) * dg + (b - bg.b) * db) / denom;
  return Math.max(0, Math.min(0.99, t));
}

function compositeColor(bg: RgbColor, wm: RgbColor, alpha: number): RgbColor {
  return {
    r: bg.r * (1 - alpha) + wm.r * alpha,
    g: bg.g * (1 - alpha) + wm.g * alpha,
    b: bg.b * (1 - alpha) + wm.b * alpha,
  };
}

function estimateLocalBackground(
  source: Uint8ClampedArray,
  candidateMask: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  x: number,
  y: number,
  fallback: RgbColor,
): RgbColor {
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let weightSum = 0;

  for (let radius = 1; radius <= 20; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;

        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= imageWidth || ny >= imageHeight) continue;

        const ni = pixelIndex(nx, ny, imageWidth);
        if (candidateMask[ni]) continue;

        const pi = ni * 4;
        const w = 1 / (dx * dx + dy * dy + 1);
        rSum += source[pi] * w;
        gSum += source[pi + 1] * w;
        bSum += source[pi + 2] * w;
        weightSum += w;
      }
    }

    if (weightSum >= 4) break;
  }

  if (weightSum < 0.5) return fallback;

  return {
    r: rSum / weightSum,
    g: gSum / weightSum,
    b: bSum / weightSum,
  };
}

function isWatermarkedPixel(
  r: number,
  g: number,
  b: number,
  localBg: RgbColor,
  wm: RgbColor,
  localAlpha: number,
  globalAlpha: number,
): boolean {
  if (localAlpha < 0.028) return false;

  const refAlpha = Math.max(localAlpha, globalAlpha * 0.55);
  const composite = compositeColor(localBg, wm, refAlpha);

  const distComposite = colorDistSq(r, g, b, composite.r, composite.g, composite.b);
  const distBg = colorDistSq(r, g, b, localBg.r, localBg.g, localBg.b);

  return distComposite < distBg * 0.92;
}

function effectiveAlpha(localAlpha: number, globalAlpha: number): number {
  const blended = localAlpha * 0.55 + globalAlpha * 0.45;
  return Math.max(0.03, Math.min(0.97, blended));
}

function restorePixel(
  r: number,
  g: number,
  b: number,
  alpha: number,
  wm: RgbColor,
): RgbColor | null {
  const inv = 1 / (1 - alpha);
  const rr = (r - wm.r * alpha) * inv;
  const rg = (g - wm.g * alpha) * inv;
  const rb = (b - wm.b * alpha) * inv;

  if (
    !Number.isFinite(rr) ||
    !Number.isFinite(rg) ||
    !Number.isFinite(rb) ||
    rr < -40 ||
    rr > 295 ||
    rg < -40 ||
    rg > 295 ||
    rb < -40 ||
    rb > 295
  ) {
    return null;
  }

  return {
    r: clampChannel(rr),
    g: clampChannel(rg),
    b: clampChannel(rb),
  };
}

/**
 * 역알파 블렌딩 — 워터마크 픽셀만 선택적으로 복원
 *
 * 마스크 사각형 전체가 아닌, 워터마크가 실제로 합성된 픽셀만 수정합니다.
 */
export function applyInverseAlphaBlend(
  imageData: ImageData,
  region: Region,
  options: WatermarkBlendOptions,
): void {
  const globalAlpha = Math.max(0.01, Math.min(0.99, options.alpha));
  const wm = options.color;
  const { width: imageWidth, height: imageHeight, data } = imageData;

  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(imageWidth, Math.ceil(region.x + region.width));
  const y1 = Math.min(imageHeight, Math.ceil(region.y + region.height));

  const source = new Uint8ClampedArray(data);
  const candidateMask = new Uint8Array(imageWidth * imageHeight);
  const fallbackBg = estimateRegionBackground(source, imageWidth, x0, y0, x1, y1);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = pixelIndex(x, y, imageWidth);
      const pi = i * 4;
      const roughAlpha = estimateLocalAlpha(
        source[pi],
        source[pi + 1],
        source[pi + 2],
        fallbackBg,
        wm,
      );
      if (roughAlpha >= 0.02) {
        candidateMask[i] = 1;
      }
    }
  }

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = pixelIndex(x, y, imageWidth);
      if (!candidateMask[i]) continue;

      const pi = i * 4;
      const r = source[pi];
      const g = source[pi + 1];
      const b = source[pi + 2];

      const localBg = estimateLocalBackground(
        source,
        candidateMask,
        imageWidth,
        imageHeight,
        x,
        y,
        fallbackBg,
      );

      const localAlpha = estimateLocalAlpha(r, g, b, localBg, wm);
      if (!isWatermarkedPixel(r, g, b, localBg, wm, localAlpha, globalAlpha)) {
        continue;
      }

      const alpha = effectiveAlpha(localAlpha, globalAlpha);
      const restored = restorePixel(r, g, b, alpha, wm);
      if (!restored) continue;

      const distBefore = colorDistSq(r, g, b, localBg.r, localBg.g, localBg.b);
      const distAfter = colorDistSq(
        restored.r,
        restored.g,
        restored.b,
        localBg.r,
        localBg.g,
        localBg.b,
      );

      if (distAfter >= distBefore * 0.98) continue;

      data[pi] = restored.r;
      data[pi + 1] = restored.g;
      data[pi + 2] = restored.b;
    }
  }
}

export function createProcessedImageData(
  source: ImageData,
  region: Region,
  options: WatermarkBlendOptions,
): ImageData {
  const copy = new ImageData(
    new Uint8ClampedArray(source.data),
    source.width,
    source.height,
  );
  applyInverseAlphaBlend(copy, region, options);
  return copy;
}
