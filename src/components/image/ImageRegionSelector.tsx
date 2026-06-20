"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { RegionOverlay } from "@/components/image/RegionOverlay";
import {
  CROSSHAIR_CURSOR,
  IMAGE_FULLSCREEN_LABEL,
} from "@/components/image/image-viewer-ui";
import {
  ImageZoomControls,
  DEFAULT_ZOOM_PERCENT,
  zoomPercentToScale,
} from "@/components/ui/ImageZoomControls";
import { getObjectContainLayout } from "@/lib/image/display-layout";
import type { Region } from "@/lib/image/region";
import { clampRegion } from "@/lib/image/region";
import type { ViewerScroll } from "@/lib/image/viewer-scroll";

export type { Region };

type ImageRegionSelectorProps = {
  imageUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  region: Region;
  onRegionChange: (region: Region) => void;
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

function regionFromDrag(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  naturalW: number,
  naturalH: number,
): Region {
  return clampRegion(
    {
      x: startX,
      y: startY,
      width: endX - startX,
      height: endY - startY,
    },
    naturalW,
    naturalH,
  );
}

export function ImageRegionSelector({
  imageUrl,
  naturalWidth,
  naturalHeight,
  region,
  onRegionChange,
  className = "",
  zoomPercent: zoomPercentProp = DEFAULT_ZOOM_PERCENT,
  onZoomPercentChange,
  scrollPosition,
  onScrollPositionChange,
  expanded = false,
  onExpand,
  showToolbar = true,
  viewportMaxHeight,
}: ImageRegionSelectorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [dragging, setDragging] = useState(false);
  const [panning, setPanning] = useState(false);
  const [internalZoomPercent, setInternalZoomPercent] = useState(DEFAULT_ZOOM_PERCENT);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const dragStart = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });
  const skipScrollEmitRef = useRef(false);

  const zoomPercent = zoomPercentProp ?? internalZoomPercent;
  const setZoomPercent = onZoomPercentChange ?? setInternalZoomPercent;
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

  const toNaturalPoint = useCallback(
    (clientX: number, clientY: number) => {
      const img = imgRef.current;
      if (!img || naturalWidth <= 0 || naturalHeight <= 0) return null;

      const rect = img.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;

      const scale = rect.width / naturalWidth;
      const naturalX = (clientX - rect.left) / scale;
      const naturalY = (clientY - rect.top) / scale;

      if (
        naturalX < 0 ||
        naturalY < 0 ||
        naturalX > naturalWidth ||
        naturalY > naturalHeight
      ) {
        return null;
      }

      return {
        x: Math.round(Math.max(0, Math.min(naturalX, naturalWidth))),
        y: Math.round(Math.max(0, Math.min(naturalY, naturalHeight))),
      };
    },
    [naturalWidth, naturalHeight],
  );

  const handleContainerScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el || !onScrollPositionChange) return;
    if (skipScrollEmitRef.current) {
      skipScrollEmitRef.current = false;
      return;
    }
    onScrollPositionChange({ left: el.scrollLeft, top: el.scrollTop });
  }, [onScrollPositionChange]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      panStart.current = {
        x: e.clientX,
        y: e.clientY,
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
      };
      setPanning(true);
      return;
    }

    if (e.button !== 0) return;
    const point = toNaturalPoint(e.clientX, e.clientY);
    if (!point) return;

    const container = containerRef.current;
    const scrollTop = container?.scrollTop ?? 0;
    const scrollLeft = container?.scrollLeft ?? 0;

    e.preventDefault();
    e.stopPropagation();
    dragStart.current = point;
    setDragging(true);
    onRegionChange(
      regionFromDrag(
        point.x,
        point.y,
        point.x,
        point.y,
        naturalWidth,
        naturalHeight,
      ),
    );

    if (container) {
      requestAnimationFrame(() => {
        container.scrollTop = scrollTop;
        container.scrollLeft = scrollLeft;
      });
    }
  };

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const point = toNaturalPoint(e.clientX, e.clientY);
      if (!point) return;
      onRegionChange(
        regionFromDrag(
          dragStart.current.x,
          dragStart.current.y,
          point.x,
          point.y,
          naturalWidth,
          naturalHeight,
        ),
      );
    };

    const handleMouseUp = () => setDragging(false);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, naturalWidth, naturalHeight, onRegionChange, toNaturalPoint]);

  useEffect(() => {
    if (!panning) return;

    const handleMouseMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      container.scrollLeft = panStart.current.scrollLeft - dx;
      container.scrollTop = panStart.current.scrollTop - dy;
      handleContainerScroll();
    };

    const handleMouseUp = () => setPanning(false);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [panning, handleContainerScroll]);

  const surfaceCursor = panning ? "grabbing" : dragging ? "crosshair" : CROSSHAIR_CURSOR;

  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`}>
      {showToolbar && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <ImageZoomControls
            zoomPercent={zoomPercent}
            onZoomPercentChange={setZoomPercent}
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
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="flex min-h-64 min-w-full justify-center p-4">
          <div
            className="relative shrink-0 select-none"
            style={{
              width: displayWidth,
              height: displayHeight,
              cursor: surfaceCursor,
            }}
            onMouseDown={handleMouseDown}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={imageUrl}
              alt="영역 선택"
              draggable={false}
              className="pointer-events-none block"
              style={{ width: displayWidth, height: displayHeight }}
            />
            <RegionOverlay
              targetRef={imgRef}
              naturalWidth={naturalWidth}
              naturalHeight={naturalHeight}
              region={region}
              variant="select"
            />
          </div>
        </div>

        <p
          className={`pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-md bg-black/60 px-2 py-1 text-xs text-white/80 transition-opacity ${
            dragging || panning ? "opacity-0" : "opacity-100"
          }`}
        >
          드래그로 영역 선택 · 우클릭 드래그로 이동 · 스크롤로 이동
        </p>
      </div>
    </div>
  );
}
