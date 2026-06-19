const EPSILON = 1e-8;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function interpolateAlphaMap(
  sourceAlpha: Float32Array,
  sourceSize: number,
  targetSize: number,
): Float32Array {
  if (targetSize <= 0) return new Float32Array(0);
  if (sourceSize === targetSize) return new Float32Array(sourceAlpha);

  const out = new Float32Array(targetSize * targetSize);
  const scale = (sourceSize - 1) / Math.max(1, targetSize - 1);

  for (let y = 0; y < targetSize; y++) {
    const sy = y * scale;
    const y0 = Math.floor(sy);
    const y1 = Math.min(sourceSize - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < targetSize; x++) {
      const sx = x * scale;
      const x0 = Math.floor(sx);
      const x1 = Math.min(sourceSize - 1, x0 + 1);
      const fx = sx - x0;

      const p00 = sourceAlpha[y0 * sourceSize + x0];
      const p10 = sourceAlpha[y0 * sourceSize + x1];
      const p01 = sourceAlpha[y1 * sourceSize + x0];
      const p11 = sourceAlpha[y1 * sourceSize + x1];

      const top = p00 + (p10 - p00) * fx;
      const bottom = p01 + (p11 - p01) * fx;
      out[y * targetSize + x] = top + (bottom - top) * fy;
    }
  }

  return out;
}

export function sobelMagnitude(gray: Float32Array, width: number, height: number): Float32Array {
  const grad = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -gray[i - width - 1] -
        2 * gray[i - 1] -
        gray[i + width - 1] +
        gray[i - width + 1] +
        2 * gray[i + 1] +
        gray[i + width + 1];
      const gy =
        -gray[i - width - 1] -
        2 * gray[i - width] -
        gray[i - width + 1] +
        gray[i + width - 1] +
        2 * gray[i + width] +
        gray[i + width + 1];
      grad[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  return grad;
}

function meanAndVariance(values: Float32Array): { mean: number; variance: number } {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  const mean = sum / values.length;

  let sq = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - mean;
    sq += d * d;
  }
  return { mean, variance: sq / values.length };
}

export function normalizedCrossCorrelation(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  const statsA = meanAndVariance(a);
  const statsB = meanAndVariance(b);
  const den = Math.sqrt(statsA.variance * statsB.variance) * a.length;

  if (den < EPSILON) return 0;

  let num = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - statsA.mean) * (b[i] - statsB.mean);
  }
  return num / den;
}

export function toGrayscale(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(width * height);

  for (let i = 0; i < out.length; i++) {
    const j = i * 4;
    out[i] = (0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]) / 255;
  }

  return out;
}

export function getRegion(
  data: Float32Array,
  width: number,
  x: number,
  y: number,
  size: number,
): Float32Array {
  const out = new Float32Array(size * size);
  for (let row = 0; row < size; row++) {
    const srcBase = (y + row) * width + x;
    const dstBase = row * size;
    for (let col = 0; col < size; col++) {
      out[dstBase + col] = data[srcBase + col];
    }
  }
  return out;
}

export function stdDevRegion(
  data: Float32Array,
  width: number,
  x: number,
  y: number,
  size: number,
): number {
  let sum = 0;
  let sq = 0;
  let n = 0;

  for (let row = 0; row < size; row++) {
    const base = (y + row) * width + x;
    for (let col = 0; col < size; col++) {
      const v = data[base + col];
      sum += v;
      sq += v * v;
      n++;
    }
  }

  if (n === 0) return 0;
  const mean = sum / n;
  const variance = Math.max(0, sq / n - mean * mean);
  return Math.sqrt(variance);
}

export function warpAlphaMap(
  alphaMap: Float32Array,
  size: number,
  { dx = 0, dy = 0, scale = 1 }: { dx?: number; dy?: number; scale?: number } = {},
): Float32Array {
  if (size <= 0) return new Float32Array(0);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(scale) || scale <= 0) {
    return new Float32Array(0);
  }
  if (dx === 0 && dy === 0 && scale === 1) return new Float32Array(alphaMap);

  const sample = (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;

    const ix0 = clamp(x0, 0, size - 1);
    const iy0 = clamp(y0, 0, size - 1);
    const ix1 = clamp(x0 + 1, 0, size - 1);
    const iy1 = clamp(y0 + 1, 0, size - 1);

    const p00 = alphaMap[iy0 * size + ix0];
    const p10 = alphaMap[iy0 * size + ix1];
    const p01 = alphaMap[iy1 * size + ix0];
    const p11 = alphaMap[iy1 * size + ix1];

    const top = p00 + (p10 - p00) * fx;
    const bottom = p01 + (p11 - p01) * fx;
    return top + (bottom - top) * fy;
  };

  const out = new Float32Array(size * size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = (x - c) / scale + c + dx;
      const sy = (y - c) / scale + c + dy;
      out[y * size + x] = sample(sx, sy);
    }
  }
  return out;
}

export function toRegionGrayscale(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  region: { x: number; y: number; size: number },
): Float32Array {
  const { x, y, size } = region;
  if (!size || size <= 0) return new Float32Array(0);
  if (x < 0 || y < 0 || x + size > width || y + size > height) {
    return new Float32Array(0);
  }

  const out = new Float32Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const idx = ((y + row) * width + (x + col)) * 4;
      out[row * size + col] =
        (0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]) / 255;
    }
  }
  return out;
}

export function computeRegionSpatialCorrelation(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaMap: Float32Array,
  region: { x: number; y: number; size: number },
): number {
  const patch = toRegionGrayscale(data, width, height, region);
  if (patch.length === 0 || patch.length !== alphaMap.length) return 0;
  return normalizedCrossCorrelation(patch, alphaMap);
}

export function computeRegionGradientCorrelation(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaMap: Float32Array,
  region: { x: number; y: number; size: number },
): number {
  const patch = toRegionGrayscale(data, width, height, region);
  const { size } = region;
  if (patch.length === 0 || patch.length !== alphaMap.length || size <= 2) return 0;

  const patchGrad = sobelMagnitude(patch, size, size);
  const alphaGrad = sobelMagnitude(alphaMap, size, size);
  return normalizedCrossCorrelation(patchGrad, alphaGrad);
}

export function combinedMatchScore(spatial: number, gradient: number): number {
  return Math.max(0, spatial) * 0.5 + Math.max(0, gradient) * 0.3;
}

export function pixelLuminance(data: Uint8ClampedArray, index: number): number {
  return (
    0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]
  );
}

/** 반투명 밝은 워터마크: 알파 마스크 위치에서 배경보다 밝은 정도 */
export function scoreLuminanceContrast(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  size: number,
  alphaMap: Float32Array,
  brightWatermark = true,
): number {
  let bgSum = 0;
  let bgCount = 0;

  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const matte = alphaMap[ty * size + tx];
      if (matte >= 0.04) continue;
      const pi = ((y + ty) * width + (x + tx)) * 4;
      bgSum += pixelLuminance(data, pi);
      bgCount++;
    }
  }

  const bgLum = bgCount > 0 ? bgSum / bgCount : 128;

  let score = 0;
  let weight = 0;
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const matte = alphaMap[ty * size + tx];
      if (matte < 0.04) continue;
      const pi = ((y + ty) * width + (x + tx)) * 4;
      const lum = pixelLuminance(data, pi);
      const delta = brightWatermark ? lum - bgLum : bgLum - lum;
      score += matte * delta;
      weight += matte;
    }
  }

  if (weight < 1) return 0;
  return Math.max(0, score / weight / 255);
}

export function combinedDetectionScore(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  size: number,
  alphaMap: Float32Array,
): {
  luminanceScore: number;
  spatialScore: number;
  gradientScore: number;
  confidence: number;
} {
  const region = { x, y, size };
  const luminanceScore = scoreLuminanceContrast(data, width, x, y, size, alphaMap);
  const spatialScore = computeRegionSpatialCorrelation(data, width, height, alphaMap, region);
  const gradientScore = computeRegionGradientCorrelation(data, width, height, alphaMap, region);
  const confidence =
    luminanceScore * 0.55 +
    Math.max(0, spatialScore) * 0.25 +
    Math.max(0, gradientScore) * 0.2;

  return { luminanceScore, spatialScore, gradientScore, confidence };
}
