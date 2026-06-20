"use client";

type GeminiEdgeFeatherControlsProps = {
  enabled: boolean;
  paddingPx: number;
  onEnabledChange: (enabled: boolean) => void;
  onPaddingChange: (paddingPx: number) => void;
  className?: string;
};

export function GeminiEdgeFeatherControls({
  enabled,
  paddingPx,
  onEnabledChange,
  onPaddingChange,
  className = "",
}: GeminiEdgeFeatherControlsProps) {
  return (
    <div
      className={`space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)]/80 px-4 py-3 ${className}`}
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
          className="mt-0.5 rounded"
        />
        <span>
          <span className="block font-medium text-[var(--color-foreground)]">
            외곽선 패딩 보정
          </span>
          <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
            ✦ 윤곽·테두리 잔상을 주변 배경색으로 부드럽게 페더합니다.
          </span>
        </span>
      </label>

      {enabled && (
        <label className="block text-sm">
          <span className="mb-1.5 block text-[var(--color-muted)]">
            외곽 패딩 ({paddingPx}px)
          </span>
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={paddingPx}
            onChange={(e) => onPaddingChange(Number(e.target.value))}
            className="w-full"
          />
          <div className="mt-1 flex justify-between text-xs text-[var(--color-muted)]">
            <span>1px (약함)</span>
            <span>3px (기본)</span>
            <span>8px (강함)</span>
          </div>
        </label>
      )}
    </div>
  );
}
