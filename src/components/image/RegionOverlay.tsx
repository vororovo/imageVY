"use client";

import { useCallback, useEffect, useState } from "react";
import type { Region } from "@/lib/image/region";

type RegionOverlayProps = {
  targetRef: React.RefObject<HTMLElement | null>;
  naturalWidth: number;
  naturalHeight: number;
  region: Region;
  variant?: "select" | "preview";
};

export function RegionOverlay({
  targetRef,
  naturalWidth,
  naturalHeight,
  region,
  variant = "select",
}: RegionOverlayProps) {
  const [style, setStyle] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  const updateLayout = useCallback(() => {
    const el = targetRef.current;
    if (!el || naturalWidth <= 0 || naturalHeight <= 0) return;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const scaleX = rect.width / naturalWidth;
    const scaleY = rect.height / naturalHeight;

    setStyle({
      left: region.x * scaleX,
      top: region.y * scaleY,
      width: region.width * scaleX,
      height: region.height * scaleY,
    });
  }, [targetRef, naturalWidth, naturalHeight, region.x, region.y, region.width, region.height]);

  useEffect(() => {
    updateLayout();
    const el = targetRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateLayout);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateLayout]);

  if (!style || region.width <= 0 || region.height <= 0) return null;

  const borderClass =
    variant === "preview"
      ? "border-emerald-400/60 bg-emerald-400/10"
      : "border-indigo-400 bg-indigo-400/20";

  return (
    <div
      className={`pointer-events-none absolute border-2 border-dashed ${borderClass}`}
      style={style}
    />
  );
}
