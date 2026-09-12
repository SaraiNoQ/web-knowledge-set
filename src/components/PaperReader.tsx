import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { PaperBlock, PaperDocument, PaperPage } from "../../shared/types";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { api } from "../api";
import { runPaperExtraction, type PaperExtractionProgress } from "../paper-extraction";
import { Button } from "./ui/Controls";

import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

function labelForBlock(type: PaperBlock["type"]) {
  return ({ heading: "标题", paragraph: "段落", formula: "公式", table: "表格", figure: "图表", caption: "图注", reference: "参考文献" } as const)[type];
}

function paperFailureMessage(paper: PaperDocument) {
  switch (paper.errorCode) {
    case "PAPER_PAGE_IMAGES_REQUIRED":
      return "当前模型需要逐页图片：请在阅读器里渲染页图后重新提取。";
    case "PAPER_MODEL_NO_VISION":
      return "当前模型既不接受整份 PDF，也不接受图片输入，请在 AI 设置里改用支持视觉的模型（例如 deepseek-flash）。";
    case "PAPER_PAGE_COUNT_REQUIRED":
      return "还没有登记论文页数，请重新提取以渲染页图。";
    case "PAPER_PAGE_OVERFLOW":
      return paper.errorMessage || "有一页的内容超出单次回答上限，无法分页提取。";
    case "PAPER_RESPONSE_TRUNCATED":
      return "模型在单次回答里放不下整篇论文，重新提取会改用逐页图片分批处理。";
    case "PAPER_PDF_UNSUPPORTED":
      return "当前模型或端点不接受整份 PDF，重新提取会改用逐页图片分批处理。";
    case "LLM_PROTOCOL_REJECTED":
    case "LLM_HTTP_ERROR":
      return "当前模型或端点拒绝了 PDF 文件输入，请切换支持 PDF content-part 的模型或端点。";
    default:
      return paper.errorMessage || "模型没有返回可验证的分页结构。";
  }
}

function progressText(progress: PaperExtractionProgress) {
  const total = progress.total ? ` ${progress.done}/${progress.total}` : "";
  switch (progress.stage) {
    case "rendering": return `正在渲染页图${total}，完成后按页发送给模型`;
    case "extracting": return `正在生成分页对照${total}，每批完成后立即保存`;
    default: return "正在确认这篇论文的发送方式";
  }
}


const ZOOM_MIN = 0.6;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.2;
// Both panes share the width the reader can give them, and neither is useful at
// a sliver of it.
const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;
// Mobile Safari silently drops a canvas above roughly this many backing pixels.
const MAX_CANVAS_PIXELS = 16_000_000;

function clampZoom(value: number) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(value * 10) / 10));
}

function PaperZoom({ zoom, onZoom }: { zoom: number; onZoom: (value: number) => void }) {
  return (
    <span className="paper-reader-zoom" role="group" aria-label="原始 PDF 缩放">
      <button type="button" onClick={() => onZoom(clampZoom(zoom - ZOOM_STEP))} disabled={zoom <= ZOOM_MIN} aria-label="缩小原始 PDF">-</button>
      <span aria-live="polite">{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => onZoom(clampZoom(zoom + ZOOM_STEP))} disabled={zoom >= ZOOM_MAX} aria-label="放大原始 PDF">+</button>
      <button type="button" className="paper-reader-zoom-reset" onClick={() => onZoom(1)} disabled={zoom === 1} aria-label="恢复原始 PDF 缩放">重置</button>
    </span>
  );
}

function PaperCanvas({ paperId, pageNumber, zoom, onZoom }: { paperId: string; pageNumber: number; zoom: number; onZoom: (value: number) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderChain = useRef<Promise<void>>(Promise.resolve());
  const renderTask = useRef<{ cancel: () => void } | null>(null);
  const [document_, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [error, setError] = useState("");

  // Load the file once per paper. Parsing it inside the render effect would
  // re-fetch and re-parse a document that can be tens of megabytes on every
  // zoom step and every page change.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: { destroy?: () => Promise<void> } | null = null;
    void (async () => {
      setError("");
      setDocument(null);
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const task = pdfjs.getDocument({ url: api.paperSourceUrl(paperId), withCredentials: true });
        loadingTask = task;
        const loaded = await task.promise;
        if (!cancelled) setDocument(loaded);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message || "无法显示原始 PDF");
      }
    })();
    return () => {
      cancelled = true;
      void loadingTask?.destroy?.();
    };
  }, [paperId]);

  // The reader drags the split, which changes this pane's width; the page is
  // re-fitted to whatever the pane currently has rather than staying at the
  // size it was first drawn with.
  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane) return;
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]!.contentRect.width);
      setPaneWidth((current) => (Math.abs(current - width) > 2 ? width : current));
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document_) return;
    let cancelled = false;
    // Renders are chained rather than started in parallel: pdf.js refuses a
    // second render on a canvas that is still drawing, and the pane's width
    // observer can fire while the previous page is still being rasterised.
    const run = renderChain.current
      .then(async () => {
        if (cancelled) return;
        const page = await document_.getPage(pageNumber);
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        setError("");
        const width = paneWidth || scrollRef.current?.clientWidth || 700;
        const base = page.getViewport({ scale: 1 });
        const fit = Math.max(.5, Math.min(2, (width - 2) / base.width));
        const viewport = page.getViewport({ scale: fit * zoom });
        // Keep the backing store inside the canvas budget browsers enforce; past
        // it the render silently produces a blank page.
        const requested = window.devicePixelRatio || 1;
        const backing = Math.max(1, Math.min(requested, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height))));
        canvas.width = Math.ceil(viewport.width * backing);
        canvas.height = Math.ceil(viewport.height * backing);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const task = page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport, transform: backing === 1 ? undefined : [backing, 0, 0, backing, 0, 0] });
        renderTask.current = task;
        await task.promise;
      })
      .catch((cause: unknown) => {
        // A render cancelled by the next zoom, page, or resize is expected.
        if (cancelled || (cause as { name?: string } | null)?.name === "RenderingCancelledException") return;
        setError(cause instanceof Error ? cause.message : "无法显示原始 PDF");
      });
    renderChain.current = run;
    return () => {
      cancelled = true;
      renderTask.current?.cancel();
    };
  }, [document_, pageNumber, zoom, paneWidth]);

  return (
    <div className="paper-reader-pdf-page">
      <div className="paper-reader-page-label"><span>ORIGINAL PDF · p.{pageNumber}</span><PaperZoom zoom={zoom} onZoom={onZoom} /></div>
      <div className="paper-reader-pdf-scroll" ref={scrollRef}>
        {error && <div className="paper-reader-pdf-error" role="alert">{error}</div>}
        <canvas ref={canvasRef} aria-label={`原始 PDF 第 ${pageNumber} 页`} />
      </div>
    </div>
  );
}

export function PaperReader({ paperId, autoStart, onClose, onRevisionChange }: { paperId: string; autoStart?: boolean; onClose: () => void; onRevisionChange: (paperId: string, revision: number) => void }) {
  const [paper, setPaper] = useState<PaperDocument | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [draftBlocks, setDraftBlocks] = useState<PaperBlock[]>([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState<PaperExtractionProgress | null>(null);
  const [zoom, setZoom] = useState(1);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [dragging, setDragging] = useState(false);
  const loadSequence = useRef(0);
  const driving = useRef(false);
  const resumed = useRef<string | null>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ startX: number; startRatio: number; usable: number } | null>(null);

  // The chrome above the reader (masthead, capture band) changes height with the
  // window width, so the space left for the reader has to be measured rather
  // than assumed: a fixed offset leaves a gap at some widths and overflows at
  // others. The measured value is also what bounds the workspace, so the page
  // stops scrolling behind the reader.
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const root = document.documentElement;
    const apply = () => {
      if (!window.matchMedia("(min-width: 761px)").matches) {
        // Stacked panes are taller than the viewport; the page scrolls instead.
        root.style.removeProperty("--paper-reader-height");
        return;
      }
      const top = element.getBoundingClientRect().top + window.scrollY;
      const height = `${Math.max(320, Math.round(window.innerHeight - top))}px`;
      if (root.style.getPropertyValue("--paper-reader-height") !== height) {
        root.style.setProperty("--paper-reader-height", height);
      }
    };
    apply();
    window.addEventListener("resize", apply);
    // A notice, an import dialog, or any other change to the chrome above moves
    // the reader, so the measurement follows the body's size.
    const observer = new ResizeObserver(apply);
    observer.observe(document.body);
    return () => {
      window.removeEventListener("resize", apply);
      observer.disconnect();
      root.style.removeProperty("--paper-reader-height");
    };
  }, [paperId]);

  const clampSplit = (value: number) => Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, value));

  // The move and release listeners live on the window for the duration of the
  // drag. Listening on the divider itself would lose the pointer as soon as it
  // moved faster than the divider, and pointer capture is not reliable across
  // every input source.
  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // A pointerup the page never saw — a context menu, another window taking
      // focus — would otherwise leave the divider following a button-less mouse.
      if (event.buttons === 0) {
        release();
        return;
      }
      setSplitRatio(clampSplit(drag.startRatio + (event.clientX - drag.startX) / drag.usable));
    };
    const release = () => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
  }, [dragging]);

  const startSplitDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = columnsRef.current;
    // Below 760px the panes stack and there is nothing to divide. A second
    // pointer during a drag is ignored rather than fighting the first.
    if (!container || dragRef.current || !window.matchMedia("(min-width: 761px)").matches) return;
    const styles = window.getComputedStyle(container);
    // The split percentage resolves against the container's content box, so the
    // divider stays under the pointer without discounting its own width.
    const usable = container.clientWidth - Number.parseFloat(styles.paddingLeft) - Number.parseFloat(styles.paddingRight);
    if (usable <= 0) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startRatio: splitRatio, usable };
    setDragging(true);
  };

  const resizeSplit = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setSplitRatio((value) => clampSplit(value + (event.key === "ArrowLeft" ? -0.03 : 0.03)));
  };

  const load = async (signal?: AbortSignal) => {
    const sequence = ++loadSequence.current;
    try {
      const next = await api.getPaper(paperId, signal);
      if (signal?.aborted || sequence !== loadSequence.current) return;
      setPaper(next);
      onRevisionChange(paperId, next.revision);
      if (next.pages.length && pageNumber > next.pages.length) setPageNumber(next.pages.length);
      setError("");
    } catch (cause) {
      if ((cause as Error).name !== "AbortError") setError((cause as Error).message);
    }
  };

  // Everything the extraction needs beyond the saved PDF — the page images —
  // only exists in this browser, so this component drives the run and the
  // batches rather than waiting on a server-side worker.
  const drive = useCallback(async () => {
    if (driving.current) return;
    driving.current = true;
    setError("");
    try {
      await runPaperExtraction(paperId, { onProgress: setProgress });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "论文处理失败");
    } finally {
      driving.current = false;
      setProgress(null);
      await load();
    }
  }, [paperId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [paperId]);

  useEffect(() => {
    if (!paper || (paper.status !== "queued" && paper.status !== "extracting")) return;
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [paper?.status, paperId]);

  useEffect(() => {
    if (autoStart && paper && paper.status === "queued") void drive();
  }, [autoStart, paper?.status, drive]);

  // An image extraction left mid-flight by a closed tab has no driver. Only
  // resume when the plan says images: a PDF run in flight is already working.
  useEffect(() => {
    if (!paper || paper.status !== "extracting" || driving.current || resumed.current === paper.id) return;
    resumed.current = paper.id;
    void (async () => {
      try {
        const plan = await api.planPaperExtraction(paper.id);
        if (plan.contentMode === "image") await drive();
      } catch {
        // The poller keeps showing the paper state; the user can retry.
      }
    })();
  }, [paper?.status, paper?.id, drive]);

  const page = useMemo<PaperPage | null>(() => paper?.pages.find((item) => item.pageNumber === pageNumber) ?? null, [paper, pageNumber]);

  useEffect(() => {
    if (!page || editing) return;
    setDraftBlocks(page.translationBlocks.map((block) => ({ ...block, assetIds: [...block.assetIds] })));
  }, [page?.paperId, page?.pageNumber, page?.revision, editing]);

  const save = async () => {
    if (!page) return;
    setSaving(true);
    setError("");
    try {
      const updated = await api.updatePaperPage(paperId, page.pageNumber, page.revision, draftBlocks);
      const nextPaper = paper ? { ...paper, pages: paper.pages.map((value) => value.pageNumber === updated.pageNumber ? updated : value), revision: updated.documentRevision, updatedAt: new Date().toISOString() } : null;
      setPaper(nextPaper);
      if (nextPaper) onRevisionChange(paperId, nextPaper.revision);
      setEditing(false);
      setNotice("本页译文已保存。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setSaving(false); }
  };

  if (error && !paper) return <section ref={rootRef} className="paper-reader paper-reader-state" aria-label="论文阅读器"><button type="button" className="paper-reader-back" onClick={onClose}>← 返回资料库</button><div role="alert"><strong>无法打开论文</strong><p>{error}</p></div></section>;
  if (!paper) return <section ref={rootRef} className="paper-reader paper-reader-state" aria-label="论文阅读器"><span className="eyebrow">PAPER READER</span><strong>正在打开论文…</strong></section>;

  const pages = paper.pageCount || paper.pages.length || 1;
  const processing = paper.status === "queued" || paper.status === "extracting";
  const readOnly = Boolean(paper.deletedAt);
  return (
    <section ref={rootRef} className="paper-reader" aria-label="论文对照阅读器">
      <header className="paper-reader-header">
        <button type="button" className="paper-reader-back" onClick={onClose}>← 返回资料库</button>
        <div><span className="eyebrow">PAPER READER · {paper.status.toUpperCase()}</span><h1>{paper.title || "未命名论文"}</h1><p>{paper.author || "作者待提取"} · {paper.sourceUrl}</p></div>
        <div className="paper-reader-actions"><span className="paper-reader-type">PAPER</span>{readOnly && <span className="paper-reader-type">只读</span>}{editing ? <><Button density="compact" onClick={() => { setEditing(false); if (page) setDraftBlocks(page.translationBlocks); }}>取消</Button><Button density="compact" variant="primary" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存本页"}</Button></> : <Button density="compact" variant="primary" onClick={() => setEditing(true)} disabled={!page || processing || readOnly}>编辑译文</Button>}</div>
      </header>

      {error && <div className="paper-reader-notice is-error" role="alert">{error}</div>}
      {notice && <div className="paper-reader-notice" role="status">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>}

      {processing ? <div className="paper-reader-processing"><span className="eyebrow">LLM EXTRACTION</span><h2>{paper.status === "queued" && !progress ? "等待开始分页提取" : "正在生成分页对照"}</h2><p>{progress ? progressText(progress) : "原始 PDF 已保存；模型会按页生成原文块、中文译文和图表说明。"}</p>{progress && progress.total > 0 && <div className="paper-reader-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}><span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} /></div>}{paper.status === "queued" && !progress && <Button variant="primary" onClick={() => void drive()}>开始提取</Button>}</div> : paper.status === "failed" ? <div className="paper-reader-processing is-error"><span className="eyebrow">EXTRACTION FAILED</span><h2>论文提取失败</h2><p>{paperFailureMessage(paper)}</p><Button onClick={() => void drive()}>重新提取</Button></div> : (
        <div className="paper-reader-body">
          <aside className="paper-reader-pages" aria-label="论文页码">{Array.from({ length: pages }, (_, index) => { const number = index + 1; return <button key={number} type="button" className={number === pageNumber ? "is-active" : ""} aria-current={number === pageNumber ? "page" : undefined} onClick={() => { if (!editing) setPageNumber(number); }}>{String(number).padStart(2, "0")}</button>; })}</aside>
          <div className="paper-reader-stage">
            <div className="paper-reader-page-toolbar"><strong>第 {pageNumber} 页 / {pages}</strong><span>{page ? `${page.originalBlocks.length} 个原文块 · ${page.translationBlocks.length} 个译文块` : "本页译文尚未生成"}</span><div><button type="button" onClick={() => setPageNumber((value) => Math.max(1, value - 1))} disabled={pageNumber === 1 || editing}>上一页</button><button type="button" onClick={() => setPageNumber((value) => Math.min(pages, value + 1))} disabled={pageNumber === pages || editing}>下一页</button></div></div>
            <div
              className={`paper-reader-columns${dragging ? " is-dragging" : ""}`}
              ref={columnsRef}
              style={{ "--paper-split": `${Math.round(splitRatio * 100)}%` } as CSSProperties}
            >
              <PaperCanvas paperId={paper.id} pageNumber={pageNumber} zoom={zoom} onZoom={setZoom} />
              <div
                className="paper-reader-split"
                role="separator"
                aria-orientation="vertical"
                aria-label="调整原文与译文的宽度"
                aria-valuenow={Math.round(splitRatio * 100)}
                aria-valuemin={Math.round(SPLIT_MIN * 100)}
                aria-valuemax={Math.round(SPLIT_MAX * 100)}
                tabIndex={0}
                onPointerDown={startSplitDrag}
                onKeyDown={resizeSplit}
              />
              <article className="paper-reader-translation">
                <div className="paper-reader-page-label"><span>中文对照 · 第 {pageNumber} 页</span></div>
                <div className="paper-reader-translation-scroll">{page ? <div className="paper-reader-blocks">{draftBlocks.map((block, index) => editing ? <label key={block.id} className="paper-reader-block paper-reader-block--edit"><span>{labelForBlock(block.type)} · {index + 1}</span><textarea value={block.translation} onChange={(event) => setDraftBlocks((current) => current.map((value) => value.id === block.id ? { ...value, translation: event.target.value } : value))} rows={Math.max(2, Math.min(8, Math.ceil(block.translation.length / 36)))} /></label> : <section key={block.id} className="paper-reader-block"><span>{labelForBlock(block.type)}</span><p>{block.translation || "（此块暂无译文）"}</p></section>)}</div> : <p className="paper-reader-empty">本页尚未生成译文。</p>}</div>
              </article>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
