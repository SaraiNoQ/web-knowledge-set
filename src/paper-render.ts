import { PAPER_MAX_PAGES, PAPER_PAGE_IMAGE_MAX_SIDE, PAPER_PAGE_IMAGE_TYPE } from "../shared/paper";
import { api } from "./api";

import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Neither runtime can rasterize a PDF: the Worker has no canvas and the local
// Node service only hands the file to the model. The browser already renders
// every page through PDF.js for the reader, so the page images come from here
// and are uploaded once, keyed by the PDF's own hash.
export async function renderPaperPages(
  paperId: string,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
) {
  const { signal, onProgress } = options;
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument({ url: api.paperSourceUrl(paperId), withCredentials: true });
  try {
    const loaded = await loadingTask.promise;
    const total = loaded.numPages;
    if (!Number.isSafeInteger(total) || total < 1) throw new Error("无法读取论文页数");
    if (total > PAPER_MAX_PAGES) throw new Error(`论文共 ${total} 页，超过 ${PAPER_MAX_PAGES} 页的提取上限`);
    const plan = await api.registerPaperPageCount(paperId, total, signal);
    const rendered = new Set(plan.rendered);
    let done = rendered.size;
    onProgress?.(done, total);
    if (done >= total) return total;
    const canvas = document.createElement("canvas");
    for (let page = 1; page <= total; page += 1) {
      if (rendered.has(page)) continue;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const pdfPage = await loaded.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(3, PAPER_PAGE_IMAGE_MAX_SIDE / Math.max(base.width, base.height));
      const viewport = pdfPage.getViewport({ scale });
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器无法创建画布");
      // PDF pages are transparent; fill white so the model does not read dark
      // text on an unpredictable background.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
      pdfPage.cleanup();
      const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, PAPER_PAGE_IMAGE_TYPE, 0.85));
      if (!image) throw new Error(`第 ${page} 页渲染失败`);
      await api.uploadPaperPageImage(paperId, page, image, signal);
      done += 1;
      onProgress?.(done, total);
    }
    return total;
  } finally {
    await loadingTask.destroy?.();
  }
}
