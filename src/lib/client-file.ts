export type ClientFile = {
  file: File;
  objectUrl: string;
};

export function createClientFile(file: File): ClientFile {
  return {
    file,
    objectUrl: URL.createObjectURL(file),
  };
}

export function revokeClientFile(clientFile: ClientFile): void {
  URL.revokeObjectURL(clientFile.objectUrl);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
