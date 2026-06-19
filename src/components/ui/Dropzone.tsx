"use client";

import { useCallback } from "react";
import { useDropzone, type Accept } from "react-dropzone";
import { Upload } from "lucide-react";

type DropzoneProps = {
  onFiles: (files: File[]) => void;
  accept?: Accept;
  multiple?: boolean;
  label?: string;
  hint?: string;
};

export function Dropzone({
  onFiles,
  accept,
  multiple = false,
  label = "파일을 드래그하거나 클릭하여 업로드",
  hint = "브라우저에서만 처리됩니다. 서버로 전송되지 않습니다.",
}: DropzoneProps) {
  const onDrop = useCallback(
    (accepted: File[]) => {
      if (accepted.length > 0) onFiles(accepted);
    },
    [onFiles],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept,
    multiple,
    noClick: false,
  });

  return (
    <div
      {...getRootProps()}
      className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
        isDragActive
          ? "border-indigo-400 bg-indigo-500/10"
          : "border-[var(--color-border)] bg-[var(--color-surface-elevated)] hover:border-indigo-500/50 hover:bg-[var(--color-surface-card)]"
      }`}
    >
      <input {...getInputProps()} />
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/15 text-indigo-400">
        <Upload className="h-5 w-5" />
      </div>
      <p className="font-medium">{isDragActive ? "여기에 놓으세요" : label}</p>
      <p className="mt-2 text-sm text-[var(--color-muted)]">{hint}</p>
    </div>
  );
}
