"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, RotateCw } from "lucide-react";
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
  getPdfPageCount,
  mergePdfs,
  rotatePdfPages,
  splitPdf,
} from "@/lib/pdf/processor";

type Tab = "merge" | "split" | "rotate";

const tabs: { id: Tab; label: string }[] = [
  { id: "merge", label: "PDF 병합" },
  { id: "split", label: "PDF 분할" },
  { id: "rotate", label: "페이지 회전" },
];

export default function PdfEditorPage() {
  const [activeTab, setActiveTab] = useState<Tab>("merge");
  const [files, setFiles] = useState<ClientFile[]>([]);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [rotation, setRotation] = useState<90 | 180 | 270>(90);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [splitResults, setSplitResults] = useState<Uint8Array[]>([]);

  const handleFiles = useCallback(
    async (incoming: File[]) => {
      const pdfs = incoming.filter((f) => f.type === "application/pdf");
      if (pdfs.length === 0) {
        setError("PDF 파일만 업로드할 수 있습니다.");
        return;
      }

      setError(null);
      setResultBlob(null);
      setSplitResults([]);

      setFiles((prev) => {
        prev.forEach(revokeClientFile);
        const newFiles =
          activeTab === "merge"
            ? [...prev, ...pdfs.map(createClientFile)]
            : [createClientFile(pdfs[0])];
        return newFiles;
      });

      if (activeTab !== "merge") {
        try {
          const count = await getPdfPageCount(pdfs[0]);
          setPageCount(count);
        } catch {
          setPageCount(null);
        }
      }
    },
    [activeTab],
  );

  useEffect(() => {
    return () => files.forEach(revokeClientFile);
  }, [files]);

  const resetFiles = () => {
    files.forEach(revokeClientFile);
    setFiles([]);
    setPageCount(null);
    setResultBlob(null);
    setSplitResults([]);
    setError(null);
  };

  const handleMerge = async () => {
    if (files.length < 2) {
      setError("병합하려면 PDF 파일 2개 이상이 필요합니다.");
      return;
    }
    setProcessing(true);
    setError(null);
    try {
      const bytes = await mergePdfs(files.map((f) => f.file));
      // bytes.buffer를 사용하거나, 확실하게 호환되는 타입으로 명시합니다.
      setResultBlob(new Blob([bytes.buffer], { type: "application/pdf" }));
    } catch {
      setError("PDF 병합에 실패했습니다.");
    } finally {
      setProcessing(false);
    }
  };

  const handleSplit = async () => {
    if (files.length === 0) return;
    setProcessing(true);
    setError(null);
    try {
      const results = await splitPdf(files[0].file);
      setSplitResults(results);
    } catch {
      setError("PDF 분할에 실패했습니다.");
    } finally {
      setProcessing(false);
    }
  };

  const handleRotate = async () => {
    if (files.length === 0) return;
    setProcessing(true);
    setError(null);
    try {
      const bytes = await rotatePdfPages(files[0].file, rotation);
      setResultBlob(new Blob([bytes], { type: "application/pdf" }));
    } catch {
      setError("페이지 회전에 실패했습니다.");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <EditorShell
      title="PDF 편집기"
      description="pdf-lib를 사용해 브라우저에서 PDF를 처리합니다."
    >
      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="lg:w-56">
          <nav className="flex gap-2 lg:flex-col">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id);
                  resetFiles();
                }}
                className={`rounded-lg px-4 py-2.5 text-left text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "text-[var(--color-muted)] hover:bg-white/5 hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 flex-1 space-y-6">
          {files.length === 0 ? (
            <Dropzone
              onFiles={handleFiles}
              accept={{ "application/pdf": [".pdf"] }}
              multiple={activeTab === "merge"}
              label="PDF를 드래그하거나 클릭하여 업로드"
            />
          ) : (
            <>
              <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-card)] p-4">
                {files.map((f, i) => (
                  <div key={f.objectUrl} className="flex items-center justify-between text-sm">
                    <span>
                      {activeTab === "merge" && `${i + 1}. `}
                      {f.file.name}
                    </span>
                    <span className="text-[var(--color-muted)]">
                      {formatFileSize(f.file.size)}
                      {pageCount !== null && activeTab !== "merge" && ` · ${pageCount}페이지`}
                    </span>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={resetFiles}
                  className="text-sm text-[var(--color-muted)] hover:text-white"
                >
                  파일 초기화
                </button>
              </div>

              {activeTab === "merge" && (
                <div className="space-y-4">
                  <Dropzone
                    onFiles={handleFiles}
                    accept={{ "application/pdf": [".pdf"] }}
                    multiple
                    label="추가 PDF 업로드"
                    hint="여러 파일을 순서대로 병합합니다."
                  />
                  <button
                    type="button"
                    onClick={handleMerge}
                    disabled={processing || files.length < 2}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {processing && <Loader2 className="h-4 w-4 animate-spin" />}
                    PDF 병합
                  </button>
                </div>
              )}

              {activeTab === "split" && (
                <button
                  type="button"
                  onClick={handleSplit}
                  disabled={processing}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                >
                  {processing && <Loader2 className="h-4 w-4 animate-spin" />}
                  페이지별로 분할
                </button>
              )}

              {activeTab === "rotate" && (
                <div className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-card)] p-5">
                  <label className="block text-sm">
                    <span className="mb-1.5 block text-[var(--color-muted)]">회전 각도</span>
                    <select
                      value={rotation}
                      onChange={(e) => setRotation(Number(e.target.value) as 90 | 180 | 270)}
                      className="w-full max-w-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-3 py-2"
                    >
                      <option value={90}>90°</option>
                      <option value={180}>180°</option>
                      <option value={270}>270°</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={handleRotate}
                    disabled={processing}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {processing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCw className="h-4 w-4" />
                    )}
                    전체 페이지 회전
                  </button>
                </div>
              )}

              {resultBlob && (
                <button
                  type="button"
                  onClick={() => downloadBlob(resultBlob, "edited.pdf")}
                  className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-4 py-2.5 text-sm font-medium transition-colors hover:bg-white/5"
                >
                  <Download className="h-4 w-4" />
                  결과 다운로드
                </button>
              )}

              {splitResults.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm text-[var(--color-muted)]">
                    {splitResults.length}개 파일로 분할되었습니다.
                  </p>
                  {splitResults.map((bytes, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() =>
                        downloadBlob(
                          new Blob([bytes], { type: "application/pdf" }),
                          `page-${i + 1}.pdf`,
                        )
                      }
                      className="mr-2 inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-3 py-2 text-sm transition-colors hover:bg-white/5"
                    >
                      <Download className="h-3.5 w-3.5" />
                      page-{i + 1}.pdf
                    </button>
                  ))}
                </div>
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
    </EditorShell>
  );
}
