import { PDFDocument, degrees } from "pdf-lib";

export async function mergePdfs(files: File[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create();

  for (const file of files) {
    const bytes = await file.arrayBuffer();
    const pdf = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(pdf, pdf.getPageIndices());
    pages.forEach((page) => merged.addPage(page));
  }

  return merged.save();
}

export async function splitPdf(file: File): Promise<Uint8Array[]> {
  const bytes = await file.arrayBuffer();
  const source = await PDFDocument.load(bytes);
  const results: Uint8Array[] = [];

  for (let i = 0; i < source.getPageCount(); i++) {
    const newDoc = await PDFDocument.create();
    const [page] = await newDoc.copyPages(source, [i]);
    newDoc.addPage(page);
    results.push(await newDoc.save());
  }

  return results;
}

export async function rotatePdfPages(
  file: File,
  rotation: 90 | 180 | 270,
): Promise<Uint8Array> {
  const bytes = await file.arrayBuffer();
  const pdf = await PDFDocument.load(bytes);

  pdf.getPages().forEach((page) => {
    page.setRotation(degrees(rotation));
  });

  return pdf.save();
}

export async function getPdfPageCount(file: File): Promise<number> {
  const bytes = await file.arrayBuffer();
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPageCount();
}
