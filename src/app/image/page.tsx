"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, Sparkles } from "lucide-react";
import { EditorShell } from "@/components/layout/EditorShell";
import { Dropzone } from "@/components/ui/Dropzone";
import {
  createClientFile,
  downloadBlob,
  formatFileSize,
  revokeClientFile,
  type ClientFile,
} from "@/lib/client-file";
import {
  clampRegion,
  type Region,
} from "@/lib/image/region";
import { INITIAL_VIEWER_SCROLL, type ViewerScroll } from "@/lib/image/viewer-scroll";
import { ImageRegionSelector } from "@/components/image/ImageRegionSelector";
import { WatermarkPreviewCanvas } from "@/components/image/WatermarkPreviewCanvas";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import {
  DEFAULT_ZOOM_PERCENT,
  ImageZoomControls,
} from "@/components/ui/ImageZoomControls";
import { hexToRgb } from "@/lib/image/inverse-alpha";
import {
  estimateResizedFileSize,
  getResizeOutputDimensions,
  getResizeScalePercent,
  loadImageFromFile,
  resizeImage,
} from "@/lib/image/processor";
import {
  buildGeminiPreset,
  buildGeminiManualRemoval,
  GEMINI_MANUAL_DESCRIPTION,
  GEMINI_MANUAL_LABEL,
  GEMINI_PRESET_DESCRIPTION,
  GEMINI_PRESET_LABEL,
  getGeminiFallbackRegion,
  imageDataFromImage,
} from "@/lib/image/gemini-preset";
import {
  WATERMARK_METHODS,
  type GeminiNccCache,
  type WatermarkMethod,
} from "@/lib/image/watermark-removal";

type Tab = "resize" | "watermark";

const tabs: { id: Tab; label: string }[] = [
  { id: "resize", label: "이미지 크기 변경" },
  { id: "watermark", label: "워터마크 제거" },
];

export default function ImageEditorPage() {
  const [activeTab, setActiveTab] = useState<Tab>("resize");
  const [source, setSource] = useState<ClientFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [width, setWidth] = useState(800);
  const [height, setHeight] = useState(600);
  const [maintainRatio, setMaintainRatio] = useState(true);
  const [format, setFormat] = useState<"image/png" | "image/jpeg" | "image/webp">(
    "image/png",
  );
  const [quality, setQuality] = useState(0.92);
  const [region, setRegion] = useState<Region>({ x: 0, y: 0, width: 100, height: 50 });
  const [watermarkColor, setWatermarkColor] = useState("#ffffff");
  const [watermarkAlpha, setWatermarkAlpha] = useState(0.5);
  const [watermarkMethod, setWatermarkMethod] =
    useState<WatermarkMethod>("inverse-alpha");
  const [binarizationThreshold, setBinarizationThreshold] = useState(180);
  const [binarizationInvert, setBinarizationInvert] = useState(false);
  const [colorTolerance, setColorTolerance] = useState(40);
  const [geminiPresetActive, setGeminiPresetActive] = useState(false);
  const [geminiManualActive, setGeminiManualActive] = useState(false);
  const [autoApplyGeminiPreset, setAutoApplyGeminiPreset] = useState(false);
  const [geminiDetected, setGeminiDetected] = useState<boolean | null>(null);
  const [geminiCache, setGeminiCache] = useState<GeminiNccCache | null>(null);
  const [maskLightboxOpen, setMaskLightboxOpen] = useState(false);
  const [previewLightboxOpen, setPreviewLightboxOpen] = useState(false);
  const [watermarkZoomPercent, setWatermarkZoomPercent] = useState(DEFAULT_ZOOM_PERCENT);
  const [watermarkScroll, setWatermarkScroll] = useState<ViewerScroll>(INITIAL_VIEWER_SCROLL);
  const watermarkCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resizeOptions = useMemo(
    () => ({
      width,
      height,
      maintainAspectRatio: maintainRatio,
      format,
      quality,
    }),
    [width, height, maintainRatio, format, quality],
  );

  const outputDimensions = useMemo(() => {
    if (naturalSize.width <= 0 || naturalSize.height <= 0) {
      return { width, height };
    }
    return getResizeOutputDimensions(
      naturalSize.width,
      naturalSize.height,
      resizeOptions,
    );
  }, [naturalSize.width, naturalSize.height, resizeOptions, width, height]);

  const scalePercent = useMemo(
    () => getResizeScalePercent(naturalSize.width, width),
    [naturalSize.width, width],
  );

  const estimatedFileSize = useMemo(() => {
    if (!source) return null;
    return estimateResizedFileSize(
      source.file.size,
      naturalSize.width,
      naturalSize.height,
      source.file.type,
      resizeOptions,
    );
  }, [source, naturalSize.width, naturalSize.height, resizeOptions]);

  const fileSizeDelta = useMemo(() => {
    if (!source || estimatedFileSize === null) return null;
    const diff = estimatedFileSize - source.file.size;
    const ratio = source.file.size > 0 ? (diff / source.file.size) * 100 : 0;
    return { diff, ratio };
  }, [source, estimatedFileSize]);

  const handleWidthChange = useCallback(
    (nextWidth: number) => {
      const w = Math.max(1, Math.round(nextWidth));
      setWidth(w);
      if (maintainRatio && naturalSize.width > 0) {
        setHeight(Math.max(1, Math.round((w / naturalSize.width) * naturalSize.height)));
      }
    },
    [maintainRatio, naturalSize.width, naturalSize.height],
  );

  const handleHeightChange = useCallback(
    (nextHeight: number) => {
      const h = Math.max(1, Math.round(nextHeight));
      setHeight(h);
      if (maintainRatio && naturalSize.height > 0) {
        setWidth(Math.max(1, Math.round((h / naturalSize.height) * naturalSize.width)));
      }
    },
    [maintainRatio, naturalSize.width, naturalSize.height],
  );

  const handleScaleChange = useCallback(
    (percent: number) => {
      if (naturalSize.width <= 0 || naturalSize.height <= 0) return;
      const ratio = percent / 100;
      setWidth(Math.max(1, Math.round(naturalSize.width * ratio)));
      setHeight(Math.max(1, Math.round(naturalSize.height * ratio)));
    },
    [naturalSize.width, naturalSize.height],
  );

  useEffect(() => {
    if (!source) return;
    setWatermarkZoomPercent(DEFAULT_ZOOM_PERCENT);
    setWatermarkScroll(INITIAL_VIEWER_SCROLL);
  }, [source?.objectUrl]);

  const handleWatermarkScroll = useCallback((scroll: ViewerScroll) => {
    setWatermarkScroll((prev) =>
      prev.left === scroll.left && prev.top === scroll.top ? prev : scroll,
    );
  }, []);

  const handleDetectedRegion = useCallback((detected: Region) => {
    setRegion((prev) =>
      prev.x === detected.x &&
      prev.y === detected.y &&
      prev.width === detected.width &&
      prev.height === detected.height
        ? prev
        : detected,
    );
  }, []);

  const handleRegionChange = useCallback((next: Region) => {
    setRegion(next);
    setGeminiPresetActive(false);
    setGeminiManualActive(false);
    setGeminiCache(null);
  }, []);

  const handleGeminiDetected = useCallback((detected: boolean) => {
    setGeminiDetected(detected);
  }, []);

  const applyGeminiPresetToImage = useCallback(
    (img: HTMLImageElement, objectUrl: string) => {
      const imageData = imageDataFromImage(img);
      const preset = buildGeminiPreset(imageData, objectUrl);
      setWatermarkMethod(preset.method);
      setRegion(preset.region);
      setWatermarkColor(preset.color);
      setWatermarkAlpha(preset.alpha);
      setGeminiCache(preset.cache);
      setGeminiPresetActive(true);
      setGeminiManualActive(false);
      setGeminiDetected(preset.cache.detected);
    },
    [],
  );

  const handleApplyGeminiManual = useCallback(async () => {
    if (!source) return;
    if (region.width < 12 || region.height < 12) {
      setError("왼쪽 이미지에서 ✦ 로고를 드래그하여 영역을 지정해 주세요.");
      return;
    }

    setError(null);
    setProcessing(true);
    try {
      const img = await loadImageFromFile(source.file);
      const imageData = imageDataFromImage(img);
      const preset = buildGeminiManualRemoval(imageData, source.objectUrl, region);
      setWatermarkMethod(preset.method);
      setRegion(preset.region);
      setWatermarkColor(preset.color);
      setWatermarkAlpha(preset.alpha);
      setGeminiCache(preset.cache);
      setGeminiPresetActive(true);
      setGeminiManualActive(true);
      setGeminiDetected(true);
    } catch {
      setError("나노바나나 워터마크 제거 적용에 실패했습니다.");
    } finally {
      setProcessing(false);
    }
  }, [source, region]);

  const handleFiles = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file?.type.startsWith("image/")) {
      setError("이미지 파일만 업로드할 수 있습니다.");
      return;
    }

    setError(null);
    const clientFile = createClientFile(file);
    setSource((prev) => {
      if (prev) revokeClientFile(prev);
      return clientFile;
    });

    try {
      const img = await loadImageFromFile(file);
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
      setWidth(img.naturalWidth);
      setHeight(img.naturalHeight);
      setWatermarkZoomPercent(DEFAULT_ZOOM_PERCENT);
      setWatermarkScroll(INITIAL_VIEWER_SCROLL);

      if (autoApplyGeminiPreset) {
        applyGeminiPresetToImage(img, clientFile.objectUrl);
      } else {
        setGeminiPresetActive(false);
        setGeminiCache(null);
        setGeminiDetected(null);
        setRegion(
          clampRegion(
            getGeminiFallbackRegion(img.naturalWidth, img.naturalHeight),
            img.naturalWidth,
            img.naturalHeight,
          ),
        );
      }
      setPreviewUrl(null);
    } catch {
      setError("이미지를 불러오는 데 실패했습니다.");
    }
  }, [autoApplyGeminiPreset, applyGeminiPresetToImage]);

  useEffect(() => {
    return () => {
      if (source) revokeClientFile(source);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [source, previewUrl]);

  const handleResize = async () => {
    if (!source) return;
    setProcessing(true);
    setError(null);
    try {
      const blob = await resizeImage(source.file, {
        width,
        height,
        maintainAspectRatio: maintainRatio,
        format,
        quality,
      });
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch {
      setError("크기 변경에 실패했습니다.");
    } finally {
      setProcessing(false);
    }
  };

  const handleApplyGeminiPreset = async () => {
    if (!source) return;
    setError(null);
    try {
      const img = await loadImageFromFile(source.file);
      applyGeminiPresetToImage(img, source.objectUrl);
    } catch {
      setError("Gemini 프리셋 적용에 실패했습니다.");
    }
  };

  const handleWatermarkMethodChange = (method: WatermarkMethod) => {
    setWatermarkMethod(method);
    setGeminiPresetActive(false);
    setGeminiManualActive(false);
    setGeminiCache(null);
  };

  const handleWatermarkCanvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    watermarkCanvasRef.current = canvas;
  }, []);

  const handleDownloadWatermark = () => {
    const canvas = watermarkCanvasRef.current;
    if (!canvas || !source) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const baseName = source.file.name.replace(/\.[^.]+$/, "");
      downloadBlob(blob, `${baseName}-watermark-removed.png`);
    }, "image/png");
  };

  const handleDownload = () => {
    if (!previewUrl || !source) return;
    fetch(previewUrl)
      .then((r) => r.blob())
      .then((blob) => {
        const ext = format === "image/jpeg" ? "jpg" : format.split("/")[1];
        const baseName = source.file.name.replace(/\.[^.]+$/, "");
        downloadBlob(blob, `${baseName}-edited.${ext}`);
      });
  };

  return (
    <EditorShell
      title="이미지 편집기"
      description="Canvas API를 사용해 브라우저에서 이미지를 처리합니다."
    >
      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="lg:w-56">
          <nav className="flex gap-2 lg:flex-col">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`rounded-lg px-4 py-2.5 text-left text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? "bg-indigo-500/20 text-indigo-300"
                    : "text-[var(--color-muted)] hover:bg-white/5 hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 flex-1 space-y-6">
          {!source ? (
            <Dropzone
              onFiles={handleFiles}
              accept={{ "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif"] }}
              label="이미지를 드래그하거나 클릭하여 업로드"
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-card)] p-4">
                <div>
                  <p className="font-medium">{source.file.name}</p>
                  <p className="text-sm text-[var(--color-muted)]">
                    {naturalSize.width} × {naturalSize.height}px ·{" "}
                    {formatFileSize(source.file.size)}
                    {activeTab === "resize" && estimatedFileSize !== null && (
                      <>
                        {" "}
                        → 예상 {formatFileSize(estimatedFileSize)}
                        {fileSizeDelta && fileSizeDelta.diff !== 0 && (
                          <span
                            className={
                              fileSizeDelta.diff < 0
                                ? "text-emerald-400"
                                : "text-amber-300"
                            }
                          >
                            {" "}
                            ({fileSizeDelta.diff > 0 ? "+" : ""}
                            {fileSizeDelta.ratio.toFixed(0)}%)
                          </span>
                        )}
                      </>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (source) revokeClientFile(source);
                    if (previewUrl) URL.revokeObjectURL(previewUrl);
                    setSource(null);
                    setPreviewUrl(null);
                  }}
                  className="text-sm text-[var(--color-muted)] hover:text-white"
                >
                  다른 파일 선택
                </button>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)]">
                  <p className="border-b border-[var(--color-border)] px-4 py-2 text-xs font-medium text-[var(--color-muted)]">
                    {activeTab === "watermark" ? "마스크 영역 선택" : "원본"}
                  </p>
                  {activeTab === "watermark" ? (
                    <div className="p-4 pt-3">
                      <ImageRegionSelector
                        imageUrl={source.objectUrl}
                        naturalWidth={naturalSize.width}
                        naturalHeight={naturalSize.height}
                        region={region}
                        onRegionChange={handleRegionChange}
                        zoomPercent={watermarkZoomPercent}
                        onZoomPercentChange={setWatermarkZoomPercent}
                        scrollPosition={watermarkScroll}
                        onScrollPositionChange={handleWatermarkScroll}
                        onExpand={() => setMaskLightboxOpen(true)}
                      />
                    </div>
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={source.objectUrl}
                      alt="원본"
                      className="max-h-80 w-full object-contain p-4"
                    />
                  )}
                </div>

                {activeTab === "watermark" ? (
                  <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)]">
                    <p className="border-b border-[var(--color-border)] px-4 py-2 text-xs font-medium text-[var(--color-muted)]">
                      실시간 미리보기
                    </p>
                    <div className="p-4 pt-3">
                      <WatermarkPreviewCanvas
                        imageUrl={source.objectUrl}
                        naturalWidth={naturalSize.width}
                        naturalHeight={naturalSize.height}
                        region={region}
                        method={watermarkMethod}
                        watermarkColor={watermarkColor}
                        watermarkAlpha={watermarkAlpha}
                        binarizationThreshold={binarizationThreshold}
                        binarizationInvert={binarizationInvert}
                        colorTolerance={colorTolerance}
                        geminiOptimized={geminiPresetActive}
                        geminiManualMode={geminiManualActive}
                        geminiCache={geminiCache}
                        onDetectedRegion={geminiManualActive ? undefined : handleDetectedRegion}
                        onGeminiDetected={handleGeminiDetected}
                        onGeminiCacheReady={setGeminiCache}
                        onCanvasRef={handleWatermarkCanvasRef}
                        zoomPercent={watermarkZoomPercent}
                        onZoomPercentChange={setWatermarkZoomPercent}
                        scrollPosition={watermarkScroll}
                        onScrollPositionChange={handleWatermarkScroll}
                        onExpand={() => setPreviewLightboxOpen(true)}
                      />
                    </div>
                  </div>
                ) : (
                  previewUrl && (
                    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)]">
                      <p className="border-b border-[var(--color-border)] px-4 py-2 text-xs font-medium text-[var(--color-muted)]">
                        결과 미리보기
                      </p>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={previewUrl}
                        alt="결과"
                        className="max-h-80 w-full object-contain p-4"
                      />
                    </div>
                  )
                )}
              </div>

              {activeTab === "resize" && (
                <div className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-card)] p-5">
                  <label className="block text-sm">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[var(--color-muted)]">크기 조절</span>
                      <span className="font-medium text-indigo-300">{scalePercent}%</span>
                    </div>
                    <input
                      type="range"
                      min={Math.min(10, scalePercent)}
                      max={Math.max(200, scalePercent)}
                      step={1}
                      value={scalePercent}
                      onChange={(e) => handleScaleChange(Number(e.target.value))}
                      className="w-full"
                    />
                    <div className="mt-1 flex justify-between text-xs text-[var(--color-muted)]">
                      <span>10%</span>
                      <button
                        type="button"
                        onClick={() => handleScaleChange(100)}
                        className="rounded px-1.5 py-0.5 transition-colors hover:bg-white/10 hover:text-indigo-300"
                        title="원본 크기로 맞추기"
                      >
                        100% (원본)
                      </button>
                      <span>200%</span>
                    </div>
                    <p className="mt-2 text-xs text-[var(--color-muted)]">
                      출력 크기: {outputDimensions.width} × {outputDimensions.height}px
                      {estimatedFileSize !== null && (
                        <>
                          {" "}
                          · 예상 용량 {formatFileSize(estimatedFileSize)}
                        </>
                      )}
                    </p>
                  </label>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block text-sm">
                      <span className="mb-1.5 block text-[var(--color-muted)]">너비 (px)</span>
                      <input
                        type="number"
                        min={1}
                        value={width}
                        onChange={(e) => handleWidthChange(Number(e.target.value))}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-3 py-2"
                      />
                    </label>
                    <label className="block text-sm">
                      <span className="mb-1.5 block text-[var(--color-muted)]">높이 (px)</span>
                      <input
                        type="number"
                        min={1}
                        value={height}
                        onChange={(e) => handleHeightChange(Number(e.target.value))}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-3 py-2"
                      />
                    </label>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={maintainRatio}
                      onChange={(e) => setMaintainRatio(e.target.checked)}
                      className="rounded"
                    />
                    비율 유지
                  </label>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block text-sm">
                      <span className="mb-1.5 block text-[var(--color-muted)]">포맷</span>
                      <select
                        value={format}
                        onChange={(e) =>
                          setFormat(e.target.value as typeof format)
                        }
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-3 py-2"
                      >
                        <option value="image/png">PNG</option>
                        <option value="image/jpeg">JPEG</option>
                        <option value="image/webp">WebP</option>
                      </select>
                    </label>
                    {format !== "image/png" && (
                      <label className="block text-sm">
                        <span className="mb-1.5 block text-[var(--color-muted)]">
                          품질 ({Math.round(quality * 100)}%)
                        </span>
                        <input
                          type="range"
                          min={0.1}
                          max={1}
                          step={0.01}
                          value={quality}
                          onChange={(e) => setQuality(Number(e.target.value))}
                          className="w-full"
                        />
                      </label>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={handleResize}
                    disabled={processing}
                    className="inline-flex items-center gap-2 rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-400 disabled:opacity-50"
                  >
                    {processing && <Loader2 className="h-4 w-4 animate-spin" />}
                    크기 변경 적용
                  </button>
                </div>
              )}

              {activeTab === "watermark" && (
                <div className="space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-card)] p-5">
                  <div className="rounded-xl border border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 to-teal-500/5 p-4">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-300">
                          <Sparkles className="h-5 w-5" />
                        </div>
                        <div>
                          <p className="font-medium">{GEMINI_MANUAL_LABEL}</p>
                          <p className="mt-1 text-sm text-[var(--color-muted)]">
                            {GEMINI_MANUAL_DESCRIPTION}
                          </p>
                          <ol className="mt-2 list-inside list-decimal space-y-1 text-xs text-[var(--color-muted)]">
                            <li>왼쪽 「마스크 영역 선택」에서 ✦ 로고를 드래그</li>
                            <li>아래 버튼을 눌러 제거 적용</li>
                            <li>오른쪽 미리보기 확인 후 다운로드</li>
                          </ol>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={handleApplyGeminiManual}
                        disabled={!source || processing}
                        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                      >
                        {processing ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="h-4 w-4" />
                        )}
                        {geminiManualActive ? "다시 적용" : GEMINI_MANUAL_LABEL}
                      </button>
                    </div>
                    {geminiManualActive && (
                      <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                        수동 영역 기준 역알파 제거 적용됨 — 영역을 바꾸면 다시 버튼을 눌러 주세요.
                      </p>
                    )}
                  </div>

                  <details className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4">
                    <summary className="cursor-pointer text-sm font-medium text-violet-200">
                      자동 프리셋 (실험적)
                    </summary>
                    <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm text-[var(--color-muted)]">
                          {GEMINI_PRESET_DESCRIPTION}
                        </p>
                      </div>
                      <div className="flex flex-col gap-2 sm:items-end">
                        <button
                          type="button"
                          onClick={handleApplyGeminiPreset}
                          disabled={!source}
                          className="inline-flex items-center justify-center gap-2 rounded-lg border border-violet-500/40 bg-violet-600/80 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
                        >
                          <Sparkles className="h-4 w-4" />
                          {geminiPresetActive && !geminiManualActive
                            ? "프리셋 다시 적용"
                            : "프리셋 적용"}
                        </button>
                        <label className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                          <input
                            type="checkbox"
                            checked={autoApplyGeminiPreset}
                            onChange={(e) => setAutoApplyGeminiPreset(e.target.checked)}
                            className="rounded"
                          />
                          업로드 시 자동 적용
                        </label>
                      </div>
                    </div>
                    {geminiPresetActive && !geminiManualActive && (
                      <p
                        className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
                          geminiDetected === false
                            ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                            : "border-violet-500/20 bg-violet-500/10 text-violet-200"
                        }`}
                      >
                        {geminiDetected === false
                          ? "자동 탐지에 실패했습니다. 위 「나노바나나 워터마크 제거」 수동 방식을 사용해 주세요."
                          : "자동 프리셋 활성화"}
                      </p>
                    )}
                  </details>

                  <p className="text-sm text-[var(--color-muted)]">
                    일반 워터마크는 아래 제거 방식과 마스크를 사용하세요.
                  </p>

                  <div className="space-y-2">
                    <span className="text-sm text-[var(--color-muted)]">제거 방식</span>
                    <div className="grid gap-2 sm:grid-cols-3">
                      {WATERMARK_METHODS.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => handleWatermarkMethodChange(m.id)}
                          className={`rounded-lg border px-3 py-3 text-left text-sm transition-colors ${
                            watermarkMethod === m.id
                              ? "border-indigo-500/60 bg-indigo-500/15 text-indigo-200"
                              : "border-[var(--color-border)] bg-[var(--color-surface-elevated)] text-[var(--color-muted)] hover:border-indigo-500/30 hover:text-white"
                          }`}
                        >
                          <span className="block font-medium">{m.label}</span>
                          <span className="mt-1 block text-xs leading-relaxed opacity-80">
                            {m.description}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {(watermarkMethod === "inverse-alpha" ||
                    watermarkMethod === "binarization") && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="block text-sm">
                        <span className="mb-1.5 block text-[var(--color-muted)]">
                          워터마크 색상
                          {watermarkMethod === "binarization" && " (검출 참조)"}
                        </span>
                        <div className="flex items-center gap-3">
                          <input
                            type="color"
                            value={watermarkColor}
                            onChange={(e) => {
                              setWatermarkColor(e.target.value);
                              if (!geminiPresetActive) setGeminiCache(null);
                            }}
                            className="h-10 w-14 cursor-pointer rounded-lg border border-[var(--color-border)] bg-transparent"
                          />
                          <input
                            type="text"
                            value={watermarkColor}
                            onChange={(e) => {
                              setWatermarkColor(e.target.value);
                              if (!geminiPresetActive) setGeminiCache(null);
                            }}
                            className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-3 py-2 font-mono text-sm uppercase"
                          />
                          <span
                            className="h-10 w-10 shrink-0 rounded-lg border border-[var(--color-border)]"
                            style={{ backgroundColor: watermarkColor }}
                            title={`RGB ${Object.values(hexToRgb(watermarkColor)).join(", ")}`}
                          />
                        </div>
                      </label>

                      {watermarkMethod === "inverse-alpha" && (
                        <label className="block text-sm">
                          <span className="mb-1.5 block text-[var(--color-muted)]">
                            {geminiPresetActive
                              ? `알파 강도 보정 (${watermarkAlpha.toFixed(2)})`
                              : `투명도 Alpha (${watermarkAlpha.toFixed(2)})`}
                          </span>
                          <input
                            type="range"
                            min={geminiPresetActive ? 0.7 : 0.01}
                            max={geminiPresetActive ? 1.3 : 0.99}
                            step={0.01}
                            value={watermarkAlpha}
                            onChange={(e) =>
                              setWatermarkAlpha(Number(e.target.value))
                            }
                            className="w-full"
                          />
                          <div className="mt-1 flex justify-between text-xs text-[var(--color-muted)]">
                            {geminiPresetActive ? (
                              <>
                                <span>약함</span>
                                <span>1.0 (기본)</span>
                                <span>강함</span>
                              </>
                            ) : (
                              <>
                                <span>0 (투명)</span>
                                <span>1 (불투명)</span>
                              </>
                            )}
                          </div>
                        </label>
                      )}
                    </div>
                  )}

                  {watermarkMethod === "binarization" && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="block text-sm">
                        <span className="mb-1.5 block text-[var(--color-muted)]">
                          밝기 임계값 ({binarizationThreshold})
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={255}
                          step={1}
                          value={binarizationThreshold}
                          onChange={(e) =>
                            setBinarizationThreshold(Number(e.target.value))
                          }
                          className="w-full"
                        />
                        <label className="mt-2 flex items-center gap-2 text-xs text-[var(--color-muted)]">
                          <input
                            type="checkbox"
                            checked={binarizationInvert}
                            onChange={(e) => setBinarizationInvert(e.target.checked)}
                            className="rounded"
                          />
                          어두운 워터마크 (임계값 미만 검출)
                        </label>
                      </label>

                      <label className="block text-sm">
                        <span className="mb-1.5 block text-[var(--color-muted)]">
                          색상 허용 오차 ({colorTolerance})
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={150}
                          step={1}
                          value={colorTolerance}
                          onChange={(e) => setColorTolerance(Number(e.target.value))}
                          className="w-full"
                        />
                        <p className="mt-1 text-xs text-[var(--color-muted)]">
                          워터마크 색상과 유사한 픽셀도 함께 검출합니다.
                        </p>
                      </label>
                    </div>
                  )}

                  {watermarkMethod === "inpainting" && (
                    <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-4 py-3 text-sm text-[var(--color-muted)]">
                      마스크 경계의 주변 픽셀을 안쪽으로 확장하며 영역을 채웁니다.
                      단색·그라데이션 배경에 적합합니다.
                    </p>
                  )}

                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {(
                      [
                        { key: "x" as const, label: "X" },
                        { key: "y" as const, label: "Y" },
                        { key: "width" as const, label: "너비" },
                        { key: "height" as const, label: "높이" },
                      ] as const
                    ).map(({ key, label }) => (
                      <label key={key} className="block text-sm">
                        <span className="mb-1.5 block text-[var(--color-muted)]">
                          {label}
                        </span>
                        <input
                          type="number"
                          min={0}
                          value={region[key]}
                          onChange={(e) =>
                            handleRegionChange(
                              clampRegion(
                                { ...region, [key]: Number(e.target.value) },
                                naturalSize.width,
                                naturalSize.height,
                              ),
                            )
                          }
                          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-3 py-2"
                        />
                      </label>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={handleDownloadWatermark}
                    className="inline-flex items-center gap-2 rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-400"
                  >
                    <Download className="h-4 w-4" />
                    결과 다운로드 (PNG)
                  </button>
                </div>
              )}

              {activeTab === "resize" && previewUrl && (
                <button
                  type="button"
                  onClick={handleDownload}
                  className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-4 py-2.5 text-sm font-medium transition-colors hover:bg-white/5"
                >
                  <Download className="h-4 w-4" />
                  결과 다운로드
                </button>
              )}
            </>
          )}

          {error && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </p>
          )}
        </div>
      </div>

      {source && (
        <>
          <ImageLightbox
            open={maskLightboxOpen}
            onClose={() => setMaskLightboxOpen(false)}
            title="마스크 영역 선택"
            toolbar={
              <ImageZoomControls
                zoomPercent={watermarkZoomPercent}
                onZoomPercentChange={setWatermarkZoomPercent}
                compact
              />
            }
          >
            <ImageRegionSelector
              imageUrl={source.objectUrl}
              naturalWidth={naturalSize.width}
              naturalHeight={naturalSize.height}
              region={region}
              onRegionChange={handleRegionChange}
              zoomPercent={watermarkZoomPercent}
              onZoomPercentChange={setWatermarkZoomPercent}
              scrollPosition={watermarkScroll}
              onScrollPositionChange={handleWatermarkScroll}
              expanded
              showToolbar={false}
              viewportMaxHeight="100%"
            />
          </ImageLightbox>

          <ImageLightbox
            open={previewLightboxOpen}
            onClose={() => setPreviewLightboxOpen(false)}
            title="실시간 미리보기"
            toolbar={
              <ImageZoomControls
                zoomPercent={watermarkZoomPercent}
                onZoomPercentChange={setWatermarkZoomPercent}
                compact
              />
            }
          >
            <WatermarkPreviewCanvas
              imageUrl={source.objectUrl}
              naturalWidth={naturalSize.width}
              naturalHeight={naturalSize.height}
              region={region}
              method={watermarkMethod}
              watermarkColor={watermarkColor}
              watermarkAlpha={watermarkAlpha}
              binarizationThreshold={binarizationThreshold}
              binarizationInvert={binarizationInvert}
              colorTolerance={colorTolerance}
              geminiOptimized={geminiPresetActive}
              geminiManualMode={geminiManualActive}
              geminiCache={geminiCache}
              zoomPercent={watermarkZoomPercent}
              onZoomPercentChange={setWatermarkZoomPercent}
              scrollPosition={watermarkScroll}
              onScrollPositionChange={handleWatermarkScroll}
              expanded
              showToolbar={false}
              viewportMaxHeight="100%"
            />
          </ImageLightbox>
        </>
      )}
    </EditorShell>
  );
}
