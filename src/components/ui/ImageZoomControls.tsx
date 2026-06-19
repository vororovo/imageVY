"use client";

import { ZoomIn, ZoomOut } from "lucide-react";

export const DEFAULT_ZOOM_PERCENT = 100;
export const MIN_ZOOM_PERCENT = 100;
export const MAX_ZOOM_PERCENT = 400;

type ImageZoomControlsProps = {
  zoomPercent: number;
  onZoomPercentChange: (percent: number) => void;
  min?: number;
  max?: number;
  compact?: boolean;
};

export function ImageZoomControls({
  zoomPercent,
  onZoomPercentChange,
  min = MIN_ZOOM_PERCENT,
  max = MAX_ZOOM_PERCENT,
  compact = false,
}: ImageZoomControlsProps) {
  const clamped = Math.min(max, Math.max(min, zoomPercent));

  const stepDown = () =>
    onZoomPercentChange(Math.max(min, clamped - 25));
  const stepUp = () =>
    onZoomPercentChange(Math.min(max, clamped + 25));

  if (compact) {
    return (
      <div className="flex items-center gap-1 rounded-lg border border-white/15 bg-black/40 px-1 py-1">
        <button
          type="button"
          onClick={stepDown}
          disabled={clamped <= min}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-white/80 hover:bg-white/10 disabled:opacity-40"
          aria-label="축소"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onZoomPercentChange(DEFAULT_ZOOM_PERCENT)}
          className="min-w-[3.5rem] px-1 text-center text-xs text-white/80 hover:text-white"
          title="100%로 초기화"
        >
          {clamped}%
        </button>
        <button
          type="button"
          onClick={stepUp}
          disabled={clamped >= max}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-white/80 hover:bg-white/10 disabled:opacity-40"
          aria-label="확대"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-3 py-2">
        <button
          type="button"
          onClick={stepDown}
          disabled={clamped <= min}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--color-muted)] hover:bg-white/5 hover:text-white disabled:opacity-40"
          aria-label="축소"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <input
          type="range"
          min={min}
          max={max}
          step={25}
          value={clamped}
          onChange={(e) => onZoomPercentChange(Number(e.target.value))}
          className="w-24 sm:w-32"
          aria-label="확대 배율"
        />
        <button
          type="button"
          onClick={() => onZoomPercentChange(DEFAULT_ZOOM_PERCENT)}
          className="min-w-[3.25rem] shrink-0 text-center text-xs text-[var(--color-muted)] hover:text-indigo-300"
          title="100%로 초기화"
        >
          {clamped}%
        </button>
        <button
          type="button"
          onClick={stepUp}
          disabled={clamped >= max}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--color-muted)] hover:bg-white/5 hover:text-white disabled:opacity-40"
          aria-label="확대"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
      </div>
      <div className="flex justify-between px-1 text-[10px] text-[var(--color-muted)]">
        <span>100%</span>
        <span>200%</span>
        <span>300%</span>
        <span>400%</span>
      </div>
    </div>
  );
}

export function zoomPercentToScale(percent: number): number {
  return Math.max(0.01, percent / DEFAULT_ZOOM_PERCENT);
}
