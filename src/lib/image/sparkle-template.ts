/**
 * Gemini ✦ 스파클 로고 알파 마스크
 * GargantuaX/gemini-watermark-remover (MIT) 보정 알파 맵 우선 사용
 */

import { getEmbeddedAlphaMap } from "@/lib/image/embedded-alpha-maps";
import { interpolateAlphaMap } from "@/lib/image/alpha-map-utils";

export type SparkleTemplate = {
  size: number;
  /** 0~1, 픽셀별 워터마크 불투명도(안티앨리어싱 포함) */
  alpha: Float32Array;
};

const templateCache = new Map<string, SparkleTemplate>();

function drawSparklePath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outer: number,
  inner: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4 - Math.PI / 2;
    const radius = i % 2 === 0 ? outer : inner;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function buildFallbackTemplate(size: number): SparkleTemplate {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas를 사용할 수 없습니다.");

  const cx = size / 2;
  const cy = size / 2;
  const outer = size * 0.4;
  const inner = size * 0.07;

  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = "white";
  drawSparklePath(ctx, cx, cy, outer, inner);
  ctx.fill();

  const pixels = ctx.getImageData(0, 0, size, size).data;
  const alpha = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    alpha[i] = pixels[i * 4] / 255;
  }

  return { size, alpha };
}

export function getSparkleTemplateAtSize(
  targetSize: number,
  alphaMapKey?: number | string,
): SparkleTemplate {
  const embeddedKey = alphaMapKey ?? (targetSize <= 40 ? "36-v2" : targetSize <= 72 ? 48 : 96);
  const cacheKey = `${embeddedKey}@${targetSize}`;

  const cached = templateCache.get(cacheKey);
  if (cached) return cached;

  const embedded = getEmbeddedAlphaMap(embeddedKey);
  if (embedded) {
    const sourceSize = Math.round(Math.sqrt(embedded.length));
    const alpha =
      sourceSize === targetSize
        ? embedded
        : interpolateAlphaMap(embedded, sourceSize, targetSize);
    const template: SparkleTemplate = { size: targetSize, alpha };
    templateCache.set(cacheKey, template);
    return template;
  }

  const template = buildFallbackTemplate(targetSize);
  templateCache.set(cacheKey, template);
  return template;
}

export function getSparkleTemplate(
  logoSize: number,
  alphaMapKey?: number | string,
): SparkleTemplate {
  const embeddedKey = alphaMapKey ?? (logoSize <= 40 ? "36-v2" : logoSize <= 72 ? 48 : 96);
  const cacheKey = `${embeddedKey}`;

  const cached = templateCache.get(cacheKey);
  if (cached) return cached;

  const embedded = getEmbeddedAlphaMap(embeddedKey);
  if (embedded) {
    const side = Math.round(Math.sqrt(embedded.length));
    const template: SparkleTemplate = { size: side, alpha: embedded };
    templateCache.set(cacheKey, template);
    return template;
  }

  const template = buildFallbackTemplate(logoSize);
  templateCache.set(cacheKey, template);
  return template;
}

export function pickTemplateSize(imageWidth: number, imageHeight: number): number {
  return imageWidth > 1024 && imageHeight > 1024 ? 96 : 48;
}
