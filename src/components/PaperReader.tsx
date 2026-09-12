import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaperBlock, PaperDocument, PaperPage } from "../../shared/types";
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


function PaperCanvas({ paperId, pageNumber }: { paperId: string; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let loadingTask: { destroy?: () => Promise<void> } | null = null;
    const render = async () => {
      setError("");
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const task = pdfjs.getDocument({ url: api.paperSourceUrl(paperId), withCredentials: true });
        loadingTask = task;
        const loaded = await task.promise;
        const page = await loaded.getPage(pageNumber);
        if (cancelled || !canvasRef.current) return;
        const containerWidth = canvasRef.current.parentElement?.clientWidth || 700;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.max(.5, Math.min(2, (containerWidth - 28) / base.width)) });
        const canvas = canvasRef.current;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message || "无法显示原始 PDF");
      }
    };
    void render();
    return () => {
      cancelled = true;
      void loadingTask?.destroy?.();
    };
  }, [paperId, pageNumber]);

  return <div className="paper-reader-pdf-page"><span className="paper-reader-page-label">ORIGINAL PDF · p.{pageNumber}</span>{error ? <div className="paper-reader-pdf-error" role="alert">{error}</div> : <canvas ref={canvasRef} aria-label={`原始 PDF 第 ${pageNumber} 页`} />}</div>;
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
  const loadSequence = useRef(0);
  const driving = useRef(false);
  const resumed = useRef<string | null>(null);

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

  if (error && !paper) return <section className="paper-reader paper-reader-state" aria-label="论文阅读器"><button type="button" className="paper-reader-back" onClick={onClose}>← 返回资料库</button><div role="alert"><strong>无法打开论文</strong><p>{error}</p></div></section>;
  if (!paper) return <section className="paper-reader paper-reader-state" aria-label="论文阅读器"><span className="eyebrow">PAPER READER</span><strong>正在打开论文…</strong></section>;

  const pages = paper.pageCount || paper.pages.length || 1;
  const processing = paper.status === "queued" || paper.status === "extracting";
  const readOnly = Boolean(paper.deletedAt);
  return (
    <section className="paper-reader" aria-label="论文对照阅读器">
      <header className="paper-reader-header">
        <button type="button" className="paper-reader-back" onClick={onClose}>← 返回资料库</button>
        <div><span className="eyebrow">PAPER READER · {paper.status.toUpperCase()}</span><h1>{paper.title || "未命名论文"}</h1><p>{paper.author || "作者待提取"} · {paper.sourceUrl}</p></div>
        <div className="paper-reader-actions"><span className="paper-reader-type">PAPER</span>{readOnly && <span className="paper-reader-type">只读</span>}{editing ? <><Button density="compact" onClick={() => { setEditing(false); if (page) setDraftBlocks(page.translationBlocks); }}>取消</Button><Button density="compact" variant="primary" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存本页"}</Button></> : <Button density="compact" variant="primary" onClick={() => setEditing(true)} disabled={!page || processing || readOnly}>编辑译文</Button>}</div>
      </header>

      {error && <div className="paper-reader-notice is-error" role="alert">{error}</div>}
      {notice && <div className="paper-reader-notice" role="status">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>}

      {processing ? <div className="paper-reader-processing"><span className="eyebrow">LLM EXTRACTION</span><h2>{paper.status === "queued" && !progress ? "等待开始分页提取" : "正在生成分页对照"}</h2><p>{progress ? progressText(progress) : "原始 PDF 已保存；模型会按页生成原文块、中文译文和图表说明。"}</p>{progress && progress.total > 0 && <div className="paper-reader-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}><span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} /></div>}{paper.status === "queued" && !progress && <Button variant="primary" onClick={() => void drive()}>开始提取</Button>}</div> : paper.status === "failed" ? <div className="paper-reader-processing is-error"><span className="eyebrow">EXTRACTION FAILED</span><h2>论文提取失败</h2><p>{paperFailureMessage(paper)}</p><Button onClick={() => void drive()}>重新提取</Button></div> : (
        <div className="paper-reader-body">
          <aside className="paper-reader-pages" aria-label="论文页码"><span className="eyebrow">PAGES · {pages}</span>{Array.from({ length: pages }, (_, index) => { const number = index + 1; return <button key={number} type="button" className={number === pageNumber ? "is-active" : ""} aria-current={number === pageNumber ? "page" : undefined} onClick={() => { if (!editing) setPageNumber(number); }}>{String(number).padStart(2, "0")}</button>; })}</aside>
          <div className="paper-reader-stage">
            <div className="paper-reader-page-toolbar"><strong>第 {pageNumber} 页 / {pages}</strong><span>{page ? `${page.originalBlocks.length} 个原文块 · ${page.translationBlocks.length} 个译文块` : "本页译文尚未生成"}</span><div><button type="button" onClick={() => setPageNumber((value) => Math.max(1, value - 1))} disabled={pageNumber === 1 || editing}>上一页</button><button type="button" onClick={() => setPageNumber((value) => Math.min(pages, value + 1))} disabled={pageNumber === pages || editing}>下一页</button></div></div>
            <div className="paper-reader-columns">
              <PaperCanvas paperId={paper.id} pageNumber={pageNumber} />
              <article className="paper-reader-translation"><span className="paper-reader-page-label">中文对照 · 第 {pageNumber} 页</span>{page ? <div className="paper-reader-blocks">{draftBlocks.map((block, index) => editing ? <label key={block.id} className="paper-reader-block paper-reader-block--edit"><span>{labelForBlock(block.type)} · {index + 1}</span><textarea value={block.translation} onChange={(event) => setDraftBlocks((current) => current.map((value) => value.id === block.id ? { ...value, translation: event.target.value } : value))} rows={Math.max(2, Math.min(8, Math.ceil(block.translation.length / 36)))} /></label> : <section key={block.id} className="paper-reader-block"><span>{labelForBlock(block.type)}</span><p>{block.translation || "（此块暂无译文）"}</p></section>)}</div> : <p className="paper-reader-empty">本页尚未生成译文。</p>}</article>
            </div>
          </div>
          <aside className="paper-reader-inspector"><span className="eyebrow">SOURCE / PROVENANCE</span><h2>论文信息</h2><dl><div><dt>页数</dt><dd>{pages}</dd></div><div><dt>来源</dt><dd>{paper.sourceKind === "url" ? "公开链接" : "上传 PDF"}</dd></div><div><dt>原始文件</dt><dd>{paper.originalFileName || "PDF"}</dd></div><div><dt>资源策略</dt><dd>原文 PDF 只读</dd></div></dl><a href={api.paperSourceUrl(paper.id)} target="_blank" rel="noreferrer noopener">打开原始 PDF ↗</a></aside>
        </div>
      )}
    </section>
  );
}
