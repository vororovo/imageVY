"use client";

import type { GeminiRemovalMode } from "@/lib/image/gemini-matte-inpaint";

type GeminiEdgeFeatherControlsProps = {
  enabled: boolean;
  paddingPx: number;
  removalMode: GeminiRemovalMode;
  onEnabledChange: (enabled: boolean) => void;
  onPaddingChange: (paddingPx: number) => void;
  onRemovalModeChange: (mode: GeminiRemovalMode) => void;
  className?: string;
};

export function GeminiEdgeFeatherControls({
  enabled,
  paddingPx,
  removalMode,
  onEnabledChange,
  onPaddingChange,
  onRemovalModeChange,
  className = "",
}: GeminiEdgeFeatherControlsProps) {
  return (
    <div
      className={`space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)]/80 px-4 py-3 ${className}`}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-[var(--color-foreground)]">
          제거 방식
        </legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="gemini-removal-mode"
            checked={removalMode === "texture-inpaint"}
            onChange={() => onRemovalModeChange("texture-inpaint")}
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium text-[var(--color-foreground)]">
              질감 인페인팅 (권장)
            </span>
            <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
              나무·텍스처 배경에서 ✦ 주변 질감을 복사해 채웁니다. 역알파 잔상을 피합니다.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="gemini-removal-mode"
            checked={removalMode === "alpha-refine"}
            onChange={() => onRemovalModeChange("alpha-refine")}
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium text-[var(--color-foreground)]">
              역알파 정밀
            </span>
            <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
              템플릿 알파로 역블렌딩합니다. 단색·그라데이션 배경에 적합합니다.
            </span>
          </span>
        </label>
      </fieldset>

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
            {removalMode === "texture-inpaint"
              ? "✦ 윤곽 밖 1~2px까지 마스크를 넓혀 테두리 잔상을 줄입니다."
              : "✦ 윤곽·테두리 잔상을 주변 배경색으로 부드럽게 페더합니다."}
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
