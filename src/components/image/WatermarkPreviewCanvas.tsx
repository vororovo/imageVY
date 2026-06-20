"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { IMAGE_FULLSCREEN_LABEL } from "@/components/image/image-viewer-ui";
import {
  DEFAULT_ZOOM_PERCENT,
  ImageZoomControls,
  zoomPercentToScale,
} from "@/components/ui/ImageZoomControls";
import { getObjectContainLayout } from "@/lib/image/display-layout";
import {
  buildGeminiCache,
  type GeminiNccCache,
} from "@/lib/image/gemini-ncc-removal";
import { hexToRgb } from "@/lib/image/inverse-alpha";
import type { Region } from "@/lib/image/region";
import type { ViewerScroll } from "@/lib/image/viewer-scroll";
import {
  createProcessedWatermark,
  type WatermarkMethod,
} from "@/lib/image/watermark-removal";

function geminiCacheKeyMatches(cacheImageKey: string, imageKey: string): boolean {
  return cacheImageKey === imageKey || cacheImageKey.startsWith(`${imageKey}#`);
}

type WatermarkPreviewCanvasProps = {
  imageUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  region: Region;
  method: WatermarkMethod;
  watermarkColor: string;
  watermarkAlpha: number;
  binarizationThreshold: number;
  binarizationInvert: boolean;
  colorTolerance: number;
  geminiOptimized?: boolean;
  geminiManualMode?: boolean;
  geminiCache?: GeminiNccCache | null;
  onDetectedRegion?: (region: Region) => void;
  onGeminiDetected?: (detected: boolean) => void;
  onGeminiCacheReady?: (cache: GeminiNccCache) => void;
  onCanvasRef?: (canvas: HTMLCanvasElement | null) => void;
  className?: string;
  zoomPercent?: number;
  onZoomPercentChange?: (percent: number) => void;
  scrollPosition?: ViewerScroll;
  onScrollPositionChange?: (scroll: ViewerScroll) => void;
  expanded?: boolean;
  onExpand?: () => void;
  showToolbar?: boolean;
  viewportMaxHeight?: string;
};

export function WatermarkPreviewCanvas({
  imageUrl,
  naturalWidth,
  naturalHeight,
  region,
  method,
  watermarkColor,
  watermarkAlpha,
  binarizationThreshold,
  binarizationInvert,
  colorTolerance,
  geminiOptimized = false,
  geminiManualMode = false,
  geminiCache: externalCache = null,
  onDetectedRegion,
  onGeminiDetected,
  onGeminiCacheReady,
  onCanvasRef,
  className = "",
  zoomPercent: zoomPercentProp = DEFAULT_ZOOM_PERCENT,
  onZoomPercentChange,
  scrollPosition,
  onScrollPositionChange,
  expanded = false,
  onExpand,
  showToolbar = true,
  viewportMaxHeight,
}: WatermarkPreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceDataRef = useRef<ImageData | null>(null);
  const geminiCacheRef = useRef<GeminiNccCache | null>(null);
  const rafRef = useRef<number | null>(null);
  const imageKeyRef = useRef<string>("");
  const skipScrollEmitRef = useRef(false);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(
    null,
  );

  const onDetectedRegionRef = useRef(onDetectedRegion);
  const onGeminiDetectedRef = useRef(onGeminiDetected);
  const onGeminiCacheReadyRef = useRef(onGeminiCacheReady);

  const zoomPercent = zoomPercentProp;
  const zoom = zoomPercentToScale(zoomPercent);

  const maxHeight = viewportMaxHeight ?? (expanded ? "calc(100vh - 7rem)" : "20rem");

  const measureContainer = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const width = el.clientWidth;
    const height = el.clientHeight;

    setContainerSize((prev) => {
      const nextWidth = width > 0 ? width : (prev?.width ?? 0);
      const nextHeight = height > 0 ? height : (prev?.height ?? 0);
      if (nextWidth <= 0 && nextHeight <= 0) return prev;
      return { width: Math.max(nextWidth, 1), height: Math.max(nextHeight, 1) };
    });
  }, []);

  useLayoutEffect(() => {
    measureContainer();
    const raf = requestAnimationFrame(measureContainer);
    return () => cancelAnimationFrame(raf);
  }, [measureContainer, expanded, maxHeight, imageUrl]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => measureContainer());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureContainer]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !scrollPosition) return;
    if (el.scrollLeft === scrollPosition.left && el.scrollTop === scrollPosition.top) return;

    skipScrollEmitRef.current = true;
    el.scrollLeft = scrollPosition.left;
    el.scrollTop = scrollPosition.top;
  }, [scrollPosition?.left, scrollPosition?.top]);

  const handleContainerScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el || !onScrollPositionChange) return;
    if (skipScrollEmitRef.current) {
      skipScrollEmitRef.current = false;
      return;
    }
    onScrollPositionChange({ left: el.scrollLeft, top: el.scrollTop });
  }, [onScrollPositionChange]);

  const layoutWidth = Math.max((containerSize?.width ?? 320) - 32, 1);
  const layoutHeight = Math.max((containerSize?.height ?? 256) - 32, 1);

  const fitLayout = getObjectContainLayout(
    layoutWidth,
    layoutHeight,
    naturalWidth,
    naturalHeight,
  );

  const displayWidth = Math.max(1, Math.round(fitLayout.displayW * zoom));
  const displayHeight = Math.max(1, Math.round(fitLayout.displayH * zoom));

  useEffect(() => {
    onDetectedRegionRef.current = onDetectedRegion;
    onGeminiDetectedRef.current = onGeminiDetected;
    onGeminiCacheReadyRef.current = onGeminiCacheReady;
  });

  useEffect(() => {
    onCanvasRef?.(canvasRef.current);
  }, [onCanvasRef]);

  const ensureGeminiCache = useCallback(
    (source: ImageData, imageKey: string): GeminiNccCache | null => {
      if (!geminiOptimized) return null;

      if (externalCache) {
        geminiCacheRef.current = externalCache;
        return externalCache;
      }

      if (geminiManualMode) return null;

      const cached = geminiCacheRef.current;
      if (cached && cached.imageKey === imageKey) {
        return cached;
      }

      const built = buildGeminiCache(source, imageKey);
      geminiCacheRef.current = built;

      onDetectedRegionRef.current?.(built.region);
      onGeminiDetectedRef.current?.(built.detected);
      onGeminiCacheReadyRef.current?.(built);

      return built;
    },
    [geminiOptimized, geminiManualMode, externalCache],
  );

  useEffect(() => {
    let cancelled = false;
    sourceDataRef.current = null;
    geminiCacheRef.current = null;
    imageKeyRef.current = imageUrl;

    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const offscreen = document.createElement("canvas");
      offscreen.width = img.naturalWidth;
      offscreen.height = img.naturalHeight;
      const ctx = offscreen.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
      sourceDataRef.current = imageData;

      if (geminiOptimized) {
        ensureGeminiCache(imageData, imageUrl);
      }

      renderPreview();
    };
    img.src = imageUrl;

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  useEffect(() => {
    if (!geminiOptimized) {
      geminiCacheRef.current = null;
      return;
    }

    const source = sourceDataRef.current;
    if (!source) return;

    if (externalCache && geminiCacheKeyMatches(externalCache.imageKey, imageKeyRef.current)) {
      geminiCacheRef.current = externalCache;
      return;
    }

    ensureGeminiCache(source, imageKeyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geminiOptimized, externalCache]);

  const renderPreview = useCallback(() => {
    const canvas = canvasRef.current;
    const source = sourceDataRef.current;
    if (!canvas || !source) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cache = geminiOptimized
      ? ensureGeminiCache(source, imageKeyRef.current)
      : null;

    if (geminiOptimized && geminiManualMode && !cache) {
      canvas.width = naturalWidth;
      canvas.height = naturalHeight;
      ctx.putImageData(source, 0, 0);
      return;
    }

    const { image: processed } = createProcessedWatermark(source, {
      method,
      region,
      color: hexToRgb(watermarkColor),
      alpha: watermarkAlpha,
      binarizationThreshold,
      binarizationInvert,
      colorTolerance,
      geminiOptimized,
      geminiCache: cache ?? undefined,
    });

    canvas.width = naturalWidth;
    canvas.height = naturalHeight;
    ctx.putImageData(processed, 0, 0);
  }, [
    naturalWidth,
    naturalHeight,
    region,
    method,
    watermarkColor,
    watermarkAlpha,
    binarizationThreshold,
    binarizationInvert,
    colorTolerance,
    geminiOptimized,
    geminiManualMode,
    ensureGeminiCache,
  ]);

  useEffect(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      renderPreview();
      rafRef.current = null;
    });
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [renderPreview]);

  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`}>
      {showToolbar && onZoomPercentChange && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <ImageZoomControls
            zoomPercent={zoomPercent}
            onZoomPercentChange={onZoomPercentChange}
            compact={expanded}
          />
          {onExpand && !expanded && (
            <button
              type="button"
              onClick={onExpand}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-3 py-1.5 text-xs text-[var(--color-muted)] transition-colors hover:text-white"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              {IMAGE_FULLSCREEN_LABEL}
            </button>
          )}
        </div>
      )}

      <div
        ref={containerRef}
        className="relative min-h-64 min-w-0 flex-1 overflow-auto rounded-lg border border-[var(--color-border)]/50 bg-black/20"
        style={{ maxHeight }}
        onScroll={handleContainerScroll}
      >
        <div className="flex min-h-64 min-w-full justify-center p-4">
          <div
            className="relative shrink-0"
            style={{ width: displayWidth, height: displayHeight }}
          >
            <canvas
              ref={canvasRef}
              className="block"
              style={{
                imageRendering: "auto",
                width: displayWidth,
                height: displayHeight,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
