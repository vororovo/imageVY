import type { Region } from "@/lib/image/region";
import type { RgbColor } from "@/lib/image/inverse-alpha";

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function getRegionBounds(region: Region, imageWidth: number, imageHeight: number) {
  return {
    x0: Math.max(0, Math.floor(region.x)),
    y0: Math.max(0, Math.floor(region.y)),
    x1: Math.min(imageWidth, Math.ceil(region.x + region.width)),
    y1: Math.min(imageHeight, Math.ceil(region.y + region.height)),
  };
}

function idx(x: number, y: number, width: number): number {
  return y * width + x;
}

const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * 마스크 영역을 경계에서 안쪽으로 확장하며 주변 픽셀 평균으로 채웁니다.
 */
export function applyInpainting(
  imageData: ImageData,
  region: Region,
  maxIterations = 800,
): void {
  const { width, height, data } = imageData;
  const { x0, y0, x1, y1 } = getRegionBounds(region, width, height);
  const mask = new Uint8Array(width * height);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      mask[idx(x, y, width)] = 1;
    }
  }

  const filled = new Uint8Array(width * height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = idx(x, y, width);
      if (!mask[i]) filled[i] = 1;
    }
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    let progressed = false;

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = idx(x, y, width);
        if (!mask[i] || filled[i]) continue;

        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let count = 0;

        for (const [dx, dy] of NEIGHBORS) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = idx(nx, ny, width);
          if (filled[ni]) {
            const pi = ni * 4;
            rSum += data[pi];
            gSum += data[pi + 1];
            bSum += data[pi + 2];
            count++;
          }
        }

        if (count > 0) {
          const pi = i * 4;
          data[pi] = clampChannel(rSum / count);
          data[pi + 1] = clampChannel(gSum / count);
          data[pi + 2] = clampChannel(bSum / count);
          filled[i] = 1;
          progressed = true;
        }
      }
    }

    if (!progressed) break;
  }
}

/**
 * 마스크 내 워터마크 픽셀만 검출한 뒤, 주변 픽셀로 채웁니다.
 */
export function applyInpaintingOnPixelMask(
  imageData: ImageData,
  pixelMask: Uint8Array,
  maxIterations = 800,
): void {
  const { width, height, data } = imageData;
  const filled = new Uint8Array(width * height);

  for (let i = 0; i < pixelMask.length; i++) {
    if (!pixelMask[i]) filled[i] = 1;
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    let progressed = false;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y, width);
        if (!pixelMask[i] || filled[i]) continue;

        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let count = 0;

        for (const [dx, dy] of NEIGHBORS) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = idx(nx, ny, width);
          if (filled[ni]) {
            const pi = ni * 4;
            rSum += data[pi];
            gSum += data[pi + 1];
            bSum += data[pi + 2];
            count++;
          }
        }

        if (count > 0) {
          const pi = i * 4;
          data[pi] = clampChannel(rSum / count);
          data[pi + 1] = clampChannel(gSum / count);
          data[pi + 2] = clampChannel(bSum / count);
          filled[i] = 1;
          progressed = true;
        }
      }
    }

    if (!progressed) break;
  }
}

export type BinarizationOptions = {
  threshold: number;
  invert: boolean;
  color: RgbColor;
  colorTolerance: number;
};

function isWatermarkPixel(
  r: number,
  g: number,
  b: number,
  options: BinarizationOptions,
): boolean {
  const lum = luminance(r, g, b);
  const byBrightness = options.invert ? lum < options.threshold : lum > options.threshold;

  const { r: wr, g: wg, b: wb } = options.color;
  const colorDist = Math.sqrt((r - wr) ** 2 + (g - wg) ** 2 + (b - wb) ** 2);

  return byBrightness || colorDist <= options.colorTolerance;
}

/**
 * 이진화로 워터마크 픽셀을 검출한 뒤 인페인팅으로 복원합니다.
 */
export function applyBinarization(
  imageData: ImageData,
  region: Region,
  options: BinarizationOptions,
): void {
  const { width, height, data } = imageData;
  const { x0, y0, x1, y1 } = getRegionBounds(region, width, height);
  const pixelMask = new Uint8Array(width * height);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const pi = idx(x, y, width) * 4;
      if (
        isWatermarkPixel(data[pi], data[pi + 1], data[pi + 2], options)
      ) {
        pixelMask[idx(x, y, width)] = 1;
      }
    }
  }

  applyInpaintingOnPixelMask(imageData, pixelMask);
}

export function luminanceOfColor(color: RgbColor): number {
  return luminance(color.r, color.g, color.b);
}
