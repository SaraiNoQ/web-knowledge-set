import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PaperBlock, PaperExtractionTask } from "../shared/types.js";
import { KnowledgeDatabase } from "./db.js";
import { LlmError, requestPaperCompletion, type ResolveLlmTarget } from "./llm.js";

const MAX_PAPER_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PAPER_BLOCK_CHARS = 50_000;
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

  const run = async (taskId: string, controller: AbortController) => {
    const database = options.database();
    const task = database.getPaperExtraction(taskId);
    if (!task) return;
    if (!database.startPaperExtraction(taskId)) return;
    try {
      const paper = database.getPaper(task.paperId);
      if (!paper) throw new LlmError(404, "PAPER_NOT_FOUND", "论文不存在");
      if (paper.sourceHash.length !== 64) throw new LlmError(422, "PAPER_SOURCE_MISSING", "论文原始 PDF 不完整");
      const current = settings();
      if (!current.enabled) throw new LlmError(409, "LLM_DISABLED", "LLM 功能尚未启用");
      const selected = current[current.target];
      if (!selected.endpointUrl || !selected.model || (current.target === "local" && !current.local.trusted)) {
        throw new LlmError(409, "LLM_NOT_CONFIGURED", "当前 LLM 尚未配置完整");
      }
      if (current.target === "remote" && (credential.endpointUrl !== selected.endpointUrl || !credential.apiKey)) {
        throw new LlmError(409, "LLM_KEY_MISSING", "远程 LLM 需要当前端点的 API Key");
      }
      database.setPaperExtractionMeta(taskId, selected.model, `endpoint-${createHash("sha256").update(selected.endpointUrl).digest("hex").slice(0, 16)}`, "paper-extraction-v1");
      const path = database.paperFilePath(paper.id);
      if (!path) throw new LlmError(422, "PAPER_SOURCE_MISSING", "论文原始 PDF 不存在");
      const pdf = readFileSync(path);
      if (pdf.byteLength > MAX_PAPER_PDF_BYTES) throw new LlmError(413, "PAPER_TOO_LARGE", "论文 PDF 超过 50 MiB");
      const response = await requestPaperCompletion({
        target: { kind: current.target, url: selected.endpointUrl },
        model: selected.model,
        system: PAPER_PROMPT,
        pdf,
        apiKey: current.target === "remote" ? credential.apiKey : "",
        signal: controller.signal,
        resolver: options.resolveTarget,
        timeoutMs: options.requestTimeoutMs,
      });
      if (controller.signal.aborted) throw new LlmError(409, "LLM_CANCELLED", "论文处理已取消");
      const parsed = parsedPaper(response.output);
      database.updatePaperExtractionProgress(taskId, parsed.pages.length, parsed.pages.length);
      database.completePaperExtraction(taskId, parsed.pages, parsed.title, parsed.author);
    } catch (error) {
      const code = error instanceof LlmError ? error.code : "PAPER_PROCESSING_FAILED";
      const message = error instanceof Error ? error.message : "论文处理失败";
      database.failPaperExtraction(taskId, code, message);
    }
  };

  return {
    setApiKey,
    deleteApiKey,
    start(paperId: string) {
      if (stopped) throw new LlmError(503, "LLM_STOPPING", "论文处理暂时不可用");
      if (active.size) throw new LlmError(409, "LLM_BUSY", "已有论文正在处理");
      const result = options.database().createPaperExtraction(paperId);
      if (result.kind === "missing") throw new LlmError(404, "PAPER_NOT_FOUND", "论文不存在");
      const controller = new AbortController();
      const done = run(result.task.id, controller).finally(() => active.delete(result.task.id));
      active.set(result.task.id, { controller, done });
      return result.task;
    },
    get(id: string) { return options.database().getPaperExtraction(id); },
    async pause() {
      stopped = true;
      await Promise.all([...active.values()].map(({ done }) => done));
    },
    resume() { stopped = false; },
  };
}
