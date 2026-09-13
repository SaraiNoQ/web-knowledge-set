import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { PaperBlock, PaperExtractionTask } from "../shared/types.js";
import {
  PAPER_BATCH_PAGES,
  PAPER_BATCH_SYSTEM_PROMPT,
  PAPER_MAX_PAGES,
  PAPER_PROMPT_VERSION,
  PaperBatchError,
  paperBatchInstruction,
  paperContentMode,
  runPaperBatches,
} from "../shared/paper.js";
import { KnowledgeDatabase } from "./db.js";
import { LlmError, requestPaperCompletion, requestPaperImagesCompletion, type ResolveLlmTarget } from "./llm.js";

const MAX_PAPER_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PAPER_BLOCK_CHARS = 50_000;
// Codes that mean "this endpoint will not take the document as a PDF". They
// switch the extraction to page images instead of failing the paper.
const PDF_PATH_REJECTED = new Set(["PAPER_PDF_UNSUPPORTED", "PAPER_RESPONSE_TRUNCATED"]);
const PAPER_PROMPT = `You extract an academic paper for a bilingual page reader.
Return JSON only, with this shape:
{"paper":{"title":"","authors":[]},"pages":[{"pageNumber":1,"blocks":[{"id":"p1-b1","type":"paragraph","original":"","translation":"","assetIds":[]}]}]}
Keep one page per PDF page. Do not omit pages. Use only these block types: heading, paragraph, formula, table, figure, caption, reference.
Keep formulas, citations, figure numbers, table numbers, and technical names in original. Translation is simplified Chinese.
Do not invent image bytes. Use assetIds only when the source contains a stable referenced asset.`;

function jsonOutput(value: string) {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try { return JSON.parse(trimmed) as unknown; }
  catch { throw new LlmError(502, "PAPER_INVALID_RESPONSE", "论文模型返回的不是有效 JSON"); }
}

function text(value: unknown, field: string) {
  if (typeof value !== "string" || value.length > MAX_PAPER_BLOCK_CHARS) {
    throw new LlmError(502, "PAPER_INVALID_RESPONSE", `论文模型返回的 ${field} 无效`);
  }
  return value;
}

function blocks(value: unknown, pageNumber: number): PaperBlock[] {
  if (!Array.isArray(value) || value.length > 500) throw new LlmError(502, "PAPER_INVALID_RESPONSE", `第 ${pageNumber} 页的内容块无效`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new LlmError(502, "PAPER_INVALID_RESPONSE", `第 ${pageNumber} 页的内容块无效`);
    const item = entry as Record<string, unknown>;
    const id = text(item.id, `第 ${pageNumber} 页第 ${index + 1} 个块 ID`);
    const type = item.type;
    if (!new Set(["heading", "paragraph", "formula", "table", "figure", "caption", "reference"]).has(String(type))) {
      throw new LlmError(502, "PAPER_INVALID_RESPONSE", `第 ${pageNumber} 页的块类型无效`);
    }
    const assetIds = item.assetIds === undefined ? [] : item.assetIds;
    if (!Array.isArray(assetIds) || assetIds.some((asset) => typeof asset !== "string" || asset.length > 200)) {
      throw new LlmError(502, "PAPER_INVALID_RESPONSE", `第 ${pageNumber} 页的资源引用无效`);
    }
    return {
      id,
      type: type as PaperBlock["type"],
      original: text(item.original, `第 ${pageNumber} 页原文`),
      translation: text(item.translation, `第 ${pageNumber} 页译文`),
      assetIds: [...new Set(assetIds as string[])],
    };
  });
}

function parsedPaper(value: string) {
  const root = jsonOutput(value);
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new LlmError(502, "PAPER_INVALID_RESPONSE", "论文模型返回结构无效");
  const record = root as Record<string, unknown>;
  const rawPages = record.pages;
  if (!Array.isArray(rawPages) || rawPages.length < 1 || rawPages.length > 1000) {
    throw new LlmError(502, "PAPER_INVALID_RESPONSE", "论文模型没有返回有效分页");
  }
  const pages = rawPages.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new LlmError(502, "PAPER_INVALID_RESPONSE", "论文分页结构无效");
    const page = value as Record<string, unknown>;
    if (!Number.isSafeInteger(page.pageNumber) || page.pageNumber !== index + 1) {
      throw new LlmError(502, "PAPER_INVALID_RESPONSE", "论文页码不连续");
    }
    return { pageNumber: page.pageNumber, blocks: blocks(page.blocks, page.pageNumber) };
  });
  const metadata = record.paper && typeof record.paper === "object" && !Array.isArray(record.paper)
    ? record.paper as Record<string, unknown>
    : {};
  const title = typeof metadata.title === "string" ? metadata.title.trim().slice(0, 1000) : "";
  const authors = Array.isArray(metadata.authors) ? metadata.authors.filter((author): author is string => typeof author === "string").slice(0, 100) : [];
  return {
    title,
    author: authors.join(", ").slice(0, 1000) || null,
    pages: pages.map(({ pageNumber, blocks: pageBlocks }) => ({
      pageNumber,
      originalBlocks: pageBlocks,
      translationBlocks: pageBlocks.map((block) => ({ ...block })),
    })),
  };
}

export interface PaperExtractionPlan {
  contentMode: "pdf" | "image";
  pageCount: number | null;
  rendered: number[];
}

export function createPaperTasks(options: {
  database: () => KnowledgeDatabase;
  apiKey?: string;
  apiKeyEndpoint?: string;
  resolveTarget?: ResolveLlmTarget;
  requestTimeoutMs?: number;
}) {
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let credential = { apiKey: options.apiKey ?? "", endpointUrl: options.apiKeyEndpoint ?? "" };
  let stopped = false;

  const settings = () => options.database().getLlmSettings(false);
  const setApiKey = (apiKey: string, endpointUrl: string) => { credential = { apiKey, endpointUrl }; };
  const deleteApiKey = () => { credential = { apiKey: "", endpointUrl: "" }; };

  // The endpoint coordinates have to be complete before a paper is charged for
  // any request; the same check serves both content modes.
  const target = () => {
    const current = settings();
    if (!current.enabled) throw new LlmError(409, "LLM_DISABLED", "LLM 功能尚未启用");
    const selected = current[current.target];
    if (!selected.endpointUrl || !selected.model || (current.target === "local" && !current.local.trusted)) {
      throw new LlmError(409, "LLM_NOT_CONFIGURED", "当前 LLM 尚未配置完整");
    }
    if (current.target === "remote" && (credential.endpointUrl !== selected.endpointUrl || !credential.apiKey)) {
      throw new LlmError(409, "LLM_KEY_MISSING", "远程 LLM 需要当前端点的 API Key");
    }
    return {
      endpointUrl: selected.endpointUrl,
      model: selected.model,
      apiKey: current.target === "remote" ? credential.apiKey : "",
      endpointId: `endpoint-${createHash("sha256").update(selected.endpointUrl).digest("hex").slice(0, 16)}`,
      kind: current.target,
    };
  };

  // Which content part this paper will be sent as. A paper that already
  // committed to images stays there even if the endpoint would now take a PDF,
  // because the user has already paid to render it.
  const plan = (paperId: string): PaperExtractionPlan | null => {
    const database = options.database();
    const paper = database.getPaper(paperId);
    if (!paper) return null;
    const current = settings();
    const selected = current[current.target];
    const latest = database.latestPaperExtraction(paperId);
    const contentMode: "pdf" | "image" = latest?.contentMode === "image" ? "image" : paperContentMode(selected.endpointUrl);
    return {
      contentMode,
      pageCount: paper.pageCount,
      rendered: contentMode === "image" ? database.paperPageImages(paperId) : [],
    };
  };

  const finishPdfRun = async (taskId: string, controller: AbortController) => {
    const database = options.database();
    try {
      const task = database.getPaperExtraction(taskId);
      if (!task) return;
      const paper = database.getPaper(task.paperId);
      if (!paper) throw new LlmError(404, "PAPER_NOT_FOUND", "论文不存在");
      if (paper.sourceHash.length !== 64) throw new LlmError(422, "PAPER_SOURCE_MISSING", "论文原始 PDF 不完整");
      const selected = target();
      database.setPaperExtractionMeta(taskId, selected.model, selected.endpointId, PAPER_PROMPT_VERSION);
      const path = database.paperFilePath(paper.id);
      if (!path) throw new LlmError(422, "PAPER_SOURCE_MISSING", "论文原始 PDF 不存在");
      const pdf = readFileSync(path);
      if (pdf.byteLength > MAX_PAPER_PDF_BYTES) throw new LlmError(413, "PAPER_TOO_LARGE", "论文 PDF 超过 50 MiB");
      const response = await requestPaperCompletion({
        target: { kind: selected.kind, url: selected.endpointUrl },
        model: selected.model,
        system: PAPER_PROMPT,
        pdf,
        apiKey: selected.apiKey,
        signal: controller.signal,
        resolver: options.resolveTarget,
        timeoutMs: options.requestTimeoutMs,
      });
      if (controller.signal.aborted) throw new LlmError(409, "LLM_CANCELLED", "论文处理已取消");
      if (response.finishReason === "length") {
        throw new LlmError(502, "PAPER_RESPONSE_TRUNCATED", "整篇论文超出单次回答上限");
      }
      const parsed = parsedPaper(response.output);
      database.updatePaperExtractionProgress(taskId, parsed.pages.length, parsed.pages.length);
      database.completePaperExtraction(taskId, parsed.pages, parsed.title, parsed.author);
    } catch (error) {
      const code = error instanceof LlmError ? error.code : "PAPER_PROCESSING_FAILED";
      const message = error instanceof Error ? error.message : "论文处理失败";
      const task = options.database().getPaperExtraction(taskId);
      if (task && PDF_PATH_REJECTED.has(code)) {
        // The endpoint will not take the document whole. Commit the task to page
        // images so the client renders and uploads them, then continues here.
        database.switchPaperExtractionToImages(taskId, "PAPER_PAGE_IMAGES_REQUIRED", message);
        return;
      }
      database.failPaperExtraction(taskId, code, message);
    }
  };

  // Runs exactly one batch of an image extraction. The caller is the HTTP route,
  // so a failure is reported back to the client that is driving the task.
  const advance = async (taskId: string): Promise<PaperExtractionTask> => {
    const database = options.database();
    const task = database.getPaperExtraction(taskId);
    if (!task) throw new LlmError(404, "PAPER_TASK_NOT_FOUND", "论文任务不存在");
    if (task.status !== "running" || task.contentMode !== "image") return task;
    if (stopped) throw new LlmError(503, "LLM_STOPPING", "论文处理暂时不可用");
    const selected = target();
    const pageCount = task.pageCount ?? 0;
    if (pageCount < 1 || pageCount > PAPER_MAX_PAGES) {
      throw new LlmError(409, "PAPER_PAGE_COUNT_REQUIRED", "论文页数尚未登记");
    }
    const controller = new AbortController();
    const from = task.completedPages + 1;
    const to = Math.min(pageCount, from + PAPER_BATCH_PAGES - 1);
    try {
      const pages: Array<{ pageNumber: number; bytes: Buffer }> = [];
      for (let page = from; page <= to; page += 1) {
        const path = database.paperPageImagePath(task.paperId, page);
        if (!path || !existsSync(path)) throw new LlmError(409, "PAPER_PAGE_IMAGES_REQUIRED", `第 ${page} 页的页图尚未上传`);
        pages.push({ pageNumber: page, bytes: readFileSync(path) });
      }
      const output = await runPaperBatches(pages, from === 1, async (batch, first, last, includeMetadata) => {
        try {
          return await requestPaperImagesCompletion({
            target: { kind: selected.kind, url: selected.endpointUrl },
            model: selected.model,
            system: PAPER_BATCH_SYSTEM_PROMPT,
            instruction: paperBatchInstruction(first, last, includeMetadata),
            pages: batch.map((page) => page.bytes),
            apiKey: selected.apiKey,
            signal: controller.signal,
            resolver: options.resolveTarget,
            timeoutMs: options.requestTimeoutMs,
          });
        } catch (error) {
          throw new PaperBatchError(
            error instanceof LlmError ? error.code : "PAPER_PROCESSING_FAILED",
            error instanceof Error ? error.message : "论文处理失败",
          );
        }
      });
      if (!output.ok) throw new LlmError(502, output.code, output.message);
      database.appendPaperPages(
        taskId,
        output.pages.map((page) => ({
          pageNumber: page.pageNumber,
          originalBlocks: page.originalBlocks,
          translationBlocks: page.originalBlocks.map((block) => ({ ...block, assetIds: [...block.assetIds] })),
        })),
        output.title,
        output.authors,
      );
    } catch (error) {
      const code = error instanceof LlmError ? error.code : "PAPER_PROCESSING_FAILED";
      const message = error instanceof Error ? error.message : "论文处理失败";
      database.failPaperExtraction(taskId, code, message);
    }
    return database.getPaperExtraction(taskId)!;
  };

  return {
    setApiKey,
    deleteApiKey,
    plan,
    advance,
    start(paperId: string) {
      if (stopped) throw new LlmError(503, "LLM_STOPPING", "论文处理暂时不可用");
      const database = options.database();
      const paper = database.getPaper(paperId);
      if (!paper) throw new LlmError(404, "PAPER_NOT_FOUND", "论文不存在");
      // Resolve the endpoint before creating anything, so a disabled, untrusted
      // or key-less configuration fails the request instead of leaving a stray
      // task that can only fail later.
      const selected = target();
      const latest = database.latestPaperExtraction(paperId);
      const contentMode: "pdf" | "image" = latest?.contentMode === "image" ? "image" : paperContentMode(selected.endpointUrl);
      if (contentMode === "image") {
        const pageCount = paper.pageCount;
        if (!pageCount || pageCount < 1 || pageCount > PAPER_MAX_PAGES) {
          throw new LlmError(409, "PAPER_PAGE_COUNT_REQUIRED", "请先在阅读器里渲染页图");
        }
        if (database.paperPageImages(paperId).length < pageCount) {
          throw new LlmError(409, "PAPER_PAGE_IMAGES_REQUIRED", "每一页的页图都上传后才能开始图片提取");
        }
        // Continue an interrupted image extraction instead of paying for the
        // pages that already succeeded, as long as nothing that shapes the
        // output changed. A run interrupted before its first batch is resumed
        // too, otherwise its row would stay running forever.
        const resumable = latest?.status === "running" || (latest?.status === "failed" && latest.completedPages > 0);
        const resume = latest && resumable && latest.contentMode === "image"
          && latest.model === selected.model && latest.endpointId === selected.endpointId
          && latest.promptVersion === PAPER_PROMPT_VERSION
          ? latest
          : null;
        if (resume) {
          const resumed = database.resumePaperExtraction(resume.id);
          if (resumed.kind === "missing") throw new LlmError(404, "PAPER_TASK_NOT_FOUND", "论文任务不存在");
          return resumed.task;
        }
        const created = database.createPaperExtraction(paperId, "image", pageCount);
        if (created.kind === "missing") throw new LlmError(404, "PAPER_NOT_FOUND", "论文不存在");
        database.startPaperExtraction(created.task.id);
        return database.getPaperExtraction(created.task.id)!;
      }
      if (active.size) throw new LlmError(409, "LLM_BUSY", "已有论文正在处理");
      const result = options.database().createPaperExtraction(paperId, "pdf", paper.pageCount);
      if (result.kind === "missing") throw new LlmError(404, "PAPER_NOT_FOUND", "论文不存在");
      database.startPaperExtraction(result.task.id);
      const controller = new AbortController();
      const done = finishPdfRun(result.task.id, controller).finally(() => active.delete(result.task.id));
      active.set(result.task.id, { controller, done });
      return database.getPaperExtraction(result.task.id)!;
    },
    get(id: string) { return options.database().getPaperExtraction(id); },
    async pause() {
      stopped = true;
      await Promise.all([...active.values()].map(({ done }) => done));
    },
    resume() { stopped = false; },
  };
}
