export type ResizeOptions = {
  width: number;
  height: number;
  maintainAspectRatio: boolean;
  format: "image/png" | "image/jpeg" | "image/webp";
  quality: number;
};

export function getResizeOutputDimensions(
  naturalWidth: number,
  naturalHeight: number,
  options: Pick<ResizeOptions, "width" | "height" | "maintainAspectRatio">,
): { width: number; height: number } {
  let targetWidth = Math.max(1, Math.round(options.width));
  let targetHeight = Math.max(1, Math.round(options.height));

  if (options.maintainAspectRatio && naturalWidth > 0 && naturalHeight > 0) {
    const ratio = Math.min(
      targetWidth / naturalWidth,
      targetHeight / naturalHeight,
    );
    targetWidth = Math.max(1, Math.round(naturalWidth * ratio));
    targetHeight = Math.max(1, Math.round(naturalHeight * ratio));
  }

  return { width: targetWidth, height: targetHeight };
}

function formatSizeMultiplier(
  format: ResizeOptions["format"],
  quality: number,
  sourceMime: string,
): number {
  const fromLossy =
    sourceMime === "image/jpeg" ||
    sourceMime === "image/webp" ||
    sourceMime === "image/jpg";
  const fromPng = sourceMime === "image/png";

  if (format === "image/png") {
    if (fromLossy) return 2.2;
    return 1.05;
  }

  const q = Math.max(0.1, Math.min(1, quality));
  const qualityCurve = 0.2 + 0.8 * q * q;

  if (format === "image/jpeg") {
    if (fromPng) return 0.28 * qualityCurve;
    if (fromLossy) return 0.85 * qualityCurve;
    return 0.35 * qualityCurve;
  }

  if (format === "image/webp") {
    if (fromPng) return 0.22 * qualityCurve;
    if (fromLossy) return 0.75 * qualityCurve;
    return 0.3 * qualityCurve;
  }

  return 1;
}

/** 픽셀 수·포맷·품질을 반영한 예상 출력 용량 */
export function estimateResizedFileSize(
  originalBytes: number,
  naturalWidth: number,
  naturalHeight: number,
  sourceMime: string,
  options: ResizeOptions,
): number {
  if (originalBytes <= 0 || naturalWidth <= 0 || naturalHeight <= 0) {
    return 0;
  }

  const output = getResizeOutputDimensions(naturalWidth, naturalHeight, options);
  const pixelRatio =
    (output.width * output.height) / (naturalWidth * naturalHeight);
  const formatMul = formatSizeMultiplier(
    options.format,
    options.quality,
    sourceMime,
  );

  return Math.max(512, Math.round(originalBytes * pixelRatio * formatMul));
}

export function getResizeScalePercent(
  naturalWidth: number,
  currentWidth: number,
): number {
  if (naturalWidth <= 0) return 100;
  return Math.round((currentWidth / naturalWidth) * 100);
}

export async function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("이미지를 불러올 수 없습니다."));
      img.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function resizeImage(
  file: File,
  options: ResizeOptions,
): Promise<Blob> {
  const image = await loadImageFromFile(file);

  const { width: targetWidth, height: targetHeight } = getResizeOutputDimensions(
    image.naturalWidth,
    image.naturalHeight,
    options,
  );

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas를 사용할 수 없습니다.");

  ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("이미지 변환에 실패했습니다."));
      },
      options.format,
      options.quality,
    );
  });
}

export type WatermarkRemoveOptions = {
  region: { x: number; y: number; width: number; height: number };
  color: { r: number; g: number; b: number };
  alpha: number;
  method?: import("@/lib/image/watermark-removal").WatermarkMethod;
  binarizationThreshold?: number;
  binarizationInvert?: boolean;
  colorTolerance?: number;
};

export async function removeWatermark(
  file: File,
  options: WatermarkRemoveOptions,
): Promise<Blob> {
  const { createProcessedWatermarkImage } = await import("@/lib/image/watermark-removal");
  const image = await loadImageFromFile(file);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas를 사용할 수 없습니다.");

  ctx.drawImage(image, 0, 0);
  const source = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const processed = createProcessedWatermarkImage(source, {
    method: options.method ?? "inverse-alpha",
    region: options.region,
    color: options.color,
    alpha: options.alpha,
    binarizationThreshold: options.binarizationThreshold ?? 180,
    binarizationInvert: options.binarizationInvert ?? false,
    colorTolerance: options.colorTolerance ?? 40,
  });
  ctx.putImageData(processed, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("워터마크 제거에 실패했습니다."));
      },
      "image/png",
    );
  });
}
