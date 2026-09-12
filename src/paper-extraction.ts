import type { PaperExtractionTask } from "../shared/types";
import { api } from "./api";
import { renderPaperPages } from "./paper-render";

export type PaperExtractionStage = "planning" | "rendering" | "extracting";

export interface PaperExtractionProgress {
  stage: PaperExtractionStage;
  done: number;
  total: number;
}

// A PDF attempt the endpoint refused, or a reply that could not hold the whole
// document, is retried once as page images. The second pass re-reads the plan,
// which by then says images, so it renders and drives batches instead.
const IMAGE_FALLBACK_CODES = new Set(["PAPER_PAGE_IMAGES_REQUIRED", "PAPER_PDF_UNSUPPORTED"]);
const PDF_POLL_MS = 1_500;
// The local service answers the start request before its own PDF call has come
// back, so that run is polled. The provider call is capped at a minute; waiting
// far past that means the run is gone rather than slow.
const PDF_RUN_WAIT_MS = 150_000;

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function runPaperExtraction(
  paperId: string,
  options: { signal?: AbortSignal; onProgress?: (progress: PaperExtractionProgress) => void } = {},
): Promise<PaperExtractionTask> {
  const { signal, onProgress } = options;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    onProgress?.({ stage: "planning", done: 0, total: 0 });
    const plan = await api.planPaperExtraction(paperId, signal);
    if (plan.contentMode === "image") {
      onProgress?.({ stage: "rendering", done: plan.rendered.length, total: plan.pageCount ?? 0 });
      await renderPaperPages(paperId, {
        signal,
        onProgress: (done, total) => onProgress?.({ stage: "rendering", done, total }),
      });
    }
    let task = await api.startPaperExtraction(paperId, signal);
    let waited = 0;
    while (task.status === "running") {
      if (task.contentMode === "image") {
        onProgress?.({ stage: "extracting", done: task.completedPages, total: task.pageCount ?? 0 });
        task = await api.advancePaperTask(task.id, signal);
        continue;
      }
      if (waited >= PDF_RUN_WAIT_MS) throw new Error("论文提取长时间没有进展，请重新提取。");
      await delay(PDF_POLL_MS, signal);
      waited += PDF_POLL_MS;
      task = await api.getPaperTask(task.id, signal);
    }
    if (task.status !== "failed") return task;
    const code = task.error?.code ?? "";
    // The second pass re-reads the plan, which by then says images, so it
    // renders the pages and drives batches instead of retrying the PDF.
    if (attempt === 0 && IMAGE_FALLBACK_CODES.has(code)) continue;
    return task;
  }
  throw new Error("论文提取没有产生结果");
}
