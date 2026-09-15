import type { PaperBlock, PaperDocument, PaperExtractionTask, PaperPage, PaperSummary } from "../shared/types";
import {
  PAPER_BATCH_PAGES,
  PAPER_BATCH_SYSTEM_PROMPT,
  PAPER_MAX_PAGES,
  PAPER_PAGE_IMAGE_MAX_BYTES,
  PAPER_PAGE_IMAGE_TYPE,
  PAPER_PROMPT_VERSION,
  PaperBatchError,
  paperBatchInstruction,
  paperContentMode,
  runPaperBatches,
} from "../shared/paper";
import { completePaper, completePaperImages, llmRequestKey, settingsRow } from "./ai";import { CloudHttpError, jsonObject, type D1Database } from "./extension";
import { publicUrl } from "./net";
import type { R2Bucket } from "./backup";

function changes(result: { meta: { changes?: number } }) {
  return result.meta.changes ?? 0;
}

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const PDF_PROMPT = `You extract an academic paper for a bilingual page reader. Return JSON only with paper.title, paper.authors, and pages. Keep one page per PDF page. Each page has blocks with id, type, original, translation, assetIds. Allowed types: heading, paragraph, formula, table, figure, caption, reference. Translate to simplified Chinese and never invent binary image data.`;
// Codes that mean "this endpoint will not take the document as a PDF". They
// switch the extraction to page images instead of failing the paper.
const PDF_PATH_REJECTED = new Set(["PAPER_PDF_UNSUPPORTED", "PAPER_RESPONSE_TRUNCATED"]);

function pageImageKey(sourceHash: string, page: number) {
  return `paper-pages/${sourceHash}/${String(page).padStart(4, "0")}.jpg`;
}

async function pageImageKeys(bucket: R2Bucket, sourceHash: string) {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({ prefix: `paper-pages/${sourceHash}/`, cursor });
    keys.push(...listing.objects.map((object) => object.key));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function deletePaperPageImages(bucket: R2Bucket, sourceHash: string) {
  const keys = await pageImageKeys(bucket, sourceHash);
  if (keys.length) await bucket.delete(keys);
}

interface ExtractionRow {
  id: string;
  status: string;
  contentMode: string | null;
  completedPages: number;
  pageCount: number | null;
  model: string | null;
  endpointId: string | null;
  promptVersion: string | null;
}

async function latestExtraction(db: D1Database, paperId: string, sourceHash: string) {
  return db.prepare(`SELECT id, status, content_mode AS contentMode, completed_pages AS completedPages, page_count AS pageCount,
    model, endpoint_id AS endpointId, prompt_version AS promptVersion
    FROM cloud_paper_extractions WHERE paper_id = ? AND source_hash = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .bind(paperId, sourceHash).first<ExtractionRow>();
}


async function hash(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function blocks(value: unknown): PaperBlock[] {
  if (!Array.isArray(value) || value.length > 500) throw new CloudHttpError(502, "PAPER_INVALID_RESPONSE", "Paper blocks are invalid");
  const allowed = new Set(["heading", "paragraph", "formula", "table", "figure", "caption", "reference"]);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new CloudHttpError(502, "PAPER_INVALID_RESPONSE", "Paper block is invalid");
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.original !== "string" || typeof item.translation !== "string" || !allowed.has(String(item.type))) {
      throw new CloudHttpError(502, "PAPER_INVALID_RESPONSE", "Paper block is invalid");
    }
    return { id: item.id, type: item.type as PaperBlock["type"], original: item.original, translation: item.translation, assetIds: Array.isArray(item.assetIds) ? item.assetIds.filter((value): value is string => typeof value === "string") : [] };
  });
}

function parsed(value: string) {
  let root: unknown;
  try { root = JSON.parse(value.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "")); }
  catch { throw new CloudHttpError(502, "PAPER_INVALID_RESPONSE", "Paper model response is not JSON"); }
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new CloudHttpError(502, "PAPER_INVALID_RESPONSE", "Paper model response is invalid");
  const pages = (root as Record<string, unknown>).pages;
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 1000) throw new CloudHttpError(502, "PAPER_INVALID_RESPONSE", "Paper model returned no pages");
  const normalized = pages.map((value, index) => {
    const page = value as Record<string, unknown>;
    if (!page || typeof page !== "object" || page.pageNumber !== index + 1) throw new CloudHttpError(502, "PAPER_INVALID_RESPONSE", "Paper pages are not contiguous");
    const original = blocks(page.blocks);
    return { pageNumber: index + 1, originalBlocks: original, translationBlocks: original.map((block) => ({ ...block, assetIds: [...block.assetIds] })) };
  });
  const metadata = (root as Record<string, unknown>).paper as Record<string, unknown> | undefined;
  const title = typeof metadata?.title === "string" ? metadata.title.trim().slice(0, 1000) : "待提取论文";
  const authors = Array.isArray(metadata?.authors) ? metadata.authors.filter((value): value is string => typeof value === "string").join(", ").slice(0, 1000) || null : null;
  return { title, authors, pages: normalized };
}

function summary(row: Record<string, unknown>): PaperSummary {
  return {
    id: String(row.id), kind: "paper", title: String(row.title), sourceUrl: String(row.paperSourceUrl || row.sourceUrl), author: row.author ? String(row.author) : null,
    status: row.paperStatus as PaperSummary["status"], errorCode: row.errorCode ? String(row.errorCode) : null, errorMessage: row.errorMessage ? String(row.errorMessage) : null,
    folderId: row.folderId ? String(row.folderId) : null, favorite: Boolean(row.favorite), archivedAt: row.archivedAt ? String(row.archivedAt) : null,
    revision: Number(row.revision), deletedAt: row.deletedAt ? String(row.deletedAt) : null, pageCount: row.pageCount == null ? null : Number(row.pageCount),
    createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
  };
}

async function row(db: D1Database, id: string) {
  return db.prepare(`SELECT d.id, d.source_url AS sourceUrl, d.title, d.author, d.folder_id AS folderId, d.favorite,
    d.revision, d.deleted_at AS deletedAt, d.created_at AS createdAt, d.updated_at AS updatedAt,
    p.source_url AS paperSourceUrl, p.original_file_name AS originalFileName, p.source_hash AS sourceHash,
    p.page_count AS pageCount, p.status AS paperStatus, p.extraction_id AS extractionId,
    e.error_code AS errorCode, e.error_message AS errorMessage
    FROM cloud_documents d JOIN cloud_papers p ON p.id = d.id
    LEFT JOIN cloud_paper_extractions e ON e.id = p.extraction_id
    WHERE d.id = ? AND d.kind = 'paper'`).bind(id).first<Record<string, unknown>>();
}

export async function paperSourceHash(db: D1Database, id: string) {
  const value = await row(db, id);
  return value ? String(value.sourceHash) : null;
}

export async function deletePaperSource(db: D1Database, bucket: R2Bucket, sourceHash: string) {
  await db.prepare("DELETE FROM cloud_paper_files WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM cloud_papers WHERE source_hash = ?)").bind(sourceHash, sourceHash).run();
  if (!await db.prepare("SELECT 1 AS found FROM cloud_paper_files WHERE hash = ?").bind(sourceHash).first()) {
    await bucket.delete(`paper/${sourceHash}`);
    await deletePaperPageImages(bucket, sourceHash);
  }
}

export async function getPaper(db: D1Database, id: string): Promise<PaperDocument | null> {
  const value = await row(db, id);
  if (!value) return null;
  const pages = value.extractionId ? await db.prepare(`SELECT pp.paper_id AS paperId, pp.extraction_id AS extractionId, pp.page_number AS pageNumber,
    pp.original_json AS originalJson, pp.translation_json AS translationJson, pp.revision, d.revision AS documentRevision
    FROM cloud_paper_pages pp JOIN cloud_documents d ON d.id = pp.paper_id
    WHERE pp.paper_id = ? AND pp.extraction_id = ? ORDER BY pp.page_number`).bind(id, value.extractionId).all<Record<string, unknown>>() : { results: [] };
  return {
    ...summary(value), sourceKind: value.paperSourceUrl ? "url" : "pdf", originalFileName: value.originalFileName ? String(value.originalFileName) : null,
    sourceHash: String(value.sourceHash), extractionId: value.extractionId ? String(value.extractionId) : null,
    pages: pages.results.map((page) => ({ paperId: String(page.paperId), extractionId: String(page.extractionId), pageNumber: Number(page.pageNumber), originalBlocks: JSON.parse(String(page.originalJson)) as PaperBlock[], translationBlocks: JSON.parse(String(page.translationJson)) as PaperBlock[], revision: Number(page.revision), documentRevision: Number(page.documentRevision) })),
  };
}

async function create(db: D1Database, bucket: R2Bucket, sourceKind: "url" | "pdf", sourceUrl: string | null, fileName: string | null, pdf: Uint8Array) {
  if (pdf.byteLength < 5 || pdf.byteLength > MAX_PDF_BYTES || new TextDecoder().decode(pdf.subarray(0, 5)) !== "%PDF-") throw new CloudHttpError(415, "PAPER_PDF_REQUIRED", "A valid PDF under 50 MiB is required");
  if (sourceUrl) {
    const existing = await db.prepare("SELECT id FROM cloud_papers WHERE source_url = ? AND id IN (SELECT id FROM cloud_documents WHERE deleted_at IS NULL)").bind(sourceUrl).first<{ id: string }>();
    if (existing) return { created: false, paper: await getPaper(db, existing.id) };
  }
  const sourceHash = await hash(pdf);
  const existingFile = await db.prepare("SELECT hash FROM cloud_paper_files WHERE hash = ?").bind(sourceHash).first<{ hash: string }>();
  if (!existingFile) {
    await bucket.put(`paper/${sourceHash}`, pdf, { httpMetadata: { contentType: "application/pdf" } });
    await db.prepare("INSERT INTO cloud_paper_files(hash, mime, bytes, r2_key, created_at) VALUES (?, 'application/pdf', ?, ?, ?)").bind(sourceHash, pdf.byteLength, `paper/${sourceHash}`, new Date().toISOString()).run();
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  if (!db.batch) throw new CloudHttpError(500, "CLOUD_DB_UNAVAILABLE", "D1 batch support is required");
  await db.batch([
    db.prepare(`INSERT INTO cloud_documents(id, kind, source_url, title, markdown, status, source_note, revision, created_at, updated_at)
      VALUES (?, 'paper', ?, ?, '', 'ready', '论文 PDF', 1, ?, ?)`).bind(id, `zhiye://paper/${id}`, fileName || "待提取论文", now, now),
    db.prepare(`INSERT INTO cloud_papers(id, source_kind, source_url, original_file_name, source_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`).bind(id, sourceKind, sourceUrl, fileName, sourceHash, now, now),
  ]);
  return { created: true, paper: await getPaper(db, id) };
}

async function readTask(db: D1Database, taskId: string, fallbackNow: string): Promise<PaperExtractionTask> {
  const task = await db.prepare(`SELECT id, paper_id AS paperId, status, content_mode AS contentMode, page_count AS pageCount, completed_pages AS completedPages,
    error_code AS errorCode, error_message AS errorMessage, created_at AS createdAt, finished_at AS finishedAt
    FROM cloud_paper_extractions WHERE id = ?`).bind(taskId).first<Record<string, unknown>>();
  const status = task?.status === "queued" || task?.status === "running" || task?.status === "succeeded" || task?.status === "failed" || task?.status === "cancelled" ? task.status : "failed";
  const contentMode = task?.contentMode === "image" ? "image" : task?.contentMode === "pdf" ? "pdf" : null;
  return {
    id: taskId,
    paperId: String(task?.paperId ?? ""),
    status,
    contentMode,
    pageCount: typeof task?.pageCount === "number" ? task.pageCount : null,
    completedPages: typeof task?.completedPages === "number" ? task.completedPages : 0,
    error: task?.errorCode ? { code: String(task.errorCode), message: String(task.errorMessage || "Paper extraction failed") } : null,
    createdAt: String(task?.createdAt || fallbackNow),
    finishedAt: task?.finishedAt ? String(task.finishedAt) : null,
  } satisfies PaperExtractionTask;
}

async function failTask(db: D1Database, paperId: string, taskId: string, code: string, message: string, now: string) {
  if (!db.batch) throw new CloudHttpError(500, "CLOUD_DB_UNAVAILABLE", "D1 batch support is required");
  await db.batch([
    db.prepare("UPDATE cloud_paper_extractions SET status = 'failed', error_code = ?, error_message = ?, finished_at = ? WHERE id = ?").bind(code, message, now, taskId),
    db.prepare("UPDATE cloud_papers SET status = 'failed', updated_at = ? WHERE id = ?").bind(now, paperId),
  ]);
}

// One model call for one ordered range of rendered pages, narrowed by the shared
// driver whenever a reply is truncated or unusable.
function extractPageRange(endpointUrl: string, model: string, apiKey: string, pages: Array<{ pageNumber: number; bytes: Uint8Array }>, includeMetadata: boolean) {
  return runPaperBatches(pages, includeMetadata, async (batch, first, last, withMetadata) => {
    try {
      return await completePaperImages(
        endpointUrl, model, apiKey, PAPER_BATCH_SYSTEM_PROMPT, batch,
        paperBatchInstruction(first, last, withMetadata),
      );
    } catch (error) {
      throw new PaperBatchError(
        error instanceof CloudHttpError ? error.code : "PAPER_PROCESSING_FAILED",
        error instanceof Error ? error.message : "Paper extraction failed",
      );
    }
  });
}

async function extraction(db: D1Database, bucket: R2Bucket, request: Request, id: string) {
  const paper = await row(db, id);
  if (!paper) throw new CloudHttpError(404, "PAPER_NOT_FOUND", "Paper not found");
  const settings = await settingsRow(db);
  if (!settings.value.enabled) throw new CloudHttpError(409, "LLM_DISABLED", "Cloud AI is disabled");
  const endpointUrl = settings.value.remote.endpointUrl;
  const model = settings.value.remote.model;
  // Resolving the key before any write means a missing or unusable key fails
  // the request instead of leaving a task that can only fail later.
  const apiKey = llmRequestKey(request);
  const sourceHash = String(paper.sourceHash);
  const endpointId = `endpoint-${(await hash(new TextEncoder().encode(endpointUrl))).slice(0, 16)}`;
  const now = new Date().toISOString();
  if (!db.batch) throw new CloudHttpError(500, "CLOUD_DB_UNAVAILABLE", "D1 batch support is required");

  const latest = await latestExtraction(db, id, sourceHash);
  const contentMode: "pdf" | "image" = latest?.contentMode === "image" ? "image" : paperContentMode(endpointUrl);
  const pageCount = paper.pageCount == null ? null : Number(paper.pageCount);
  if (contentMode === "image") {
    const rendered = await pageImageKeys(bucket, sourceHash);
    if (!pageCount || pageCount < 1 || pageCount > PAPER_MAX_PAGES) {
      throw new CloudHttpError(409, "PAPER_PAGE_COUNT_REQUIRED", "Render the paper pages before extracting them as images");
    }
    if (rendered.length < pageCount) {
      throw new CloudHttpError(409, "PAPER_PAGE_IMAGES_REQUIRED", "Every page image must be uploaded before image extraction starts");
    }
  }

  // Continue an interrupted image extraction instead of paying for the pages
  // that already succeeded, as long as nothing that shapes the output changed.
  // A run interrupted before its first batch is resumed too, otherwise its row
  // would stay running forever and a second driver would pay for it again.
  const resumable = latest?.status === "running" || (latest?.status === "failed" && latest.completedPages > 0);
  const resume = contentMode === "image" && latest && resumable && latest.contentMode === "image"
    && latest.model === model && latest.endpointId === endpointId && latest.promptVersion === PAPER_PROMPT_VERSION
    ? latest
    : null;
  const taskId = resume?.id ?? crypto.randomUUID();
  if (resume) {
    await db.batch([
      db.prepare("UPDATE cloud_paper_extractions SET status = 'running', error_code = NULL, error_message = NULL, finished_at = NULL WHERE id = ? AND status IN ('running', 'failed')").bind(taskId),
      db.prepare("UPDATE cloud_papers SET status = 'extracting', extraction_id = ?, updated_at = ? WHERE id = ?").bind(taskId, now, id),
      db.prepare("DELETE FROM cloud_semantic_indexes WHERE document_id = ?").bind(id),
    ]);
  } else {
    await db.batch([
      db.prepare(`INSERT INTO cloud_paper_extractions(id, paper_id, status, content_mode, model, endpoint_id, prompt_version, source_hash, page_count, created_at)
        VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`).bind(taskId, id, contentMode, model, endpointId, PAPER_PROMPT_VERSION, sourceHash, pageCount, now),
      db.prepare("UPDATE cloud_papers SET status = 'extracting', extraction_id = ?, updated_at = ? WHERE id = ?").bind(taskId, now, id),
      db.prepare("DELETE FROM cloud_semantic_indexes WHERE document_id = ?").bind(id),
    ]);
  }

  if (contentMode === "pdf") {
    try {
      const object = await bucket.get(`paper/${sourceHash}`);
      if (!object) throw new CloudHttpError(404, "PAPER_SOURCE_MISSING", "Paper PDF is missing from R2");
      const answer = await completePaper(endpointUrl, model, apiKey, PDF_PROMPT, new Uint8Array(await object.arrayBuffer()));
      if (answer.finishReason === "length") throw new CloudHttpError(502, "PAPER_RESPONSE_TRUNCATED", "整篇论文超出单次回答上限");
      const output = parsed(answer.output);
      const statements = output.pages.map((page) => db.prepare(`INSERT INTO cloud_paper_pages(paper_id, extraction_id, page_number, original_json, translation_json, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).bind(id, taskId, page.pageNumber, JSON.stringify(page.originalBlocks), JSON.stringify(page.translationBlocks), now, now));
      statements.push(db.prepare("DELETE FROM cloud_semantic_indexes WHERE document_id = ?").bind(id));
      statements.push(db.prepare("UPDATE cloud_paper_extractions SET status = 'succeeded', page_count = ?, completed_pages = ?, finished_at = ? WHERE id = ?").bind(output.pages.length, output.pages.length, now, taskId));
      statements.push(db.prepare("UPDATE cloud_papers SET status = 'ready', page_count = ?, updated_at = ? WHERE id = ?").bind(output.pages.length, now, id));
      statements.push(db.prepare("UPDATE cloud_documents SET title = ?, author = ?, updated_at = ? WHERE id = ?").bind(output.title, output.authors, now, id));
      await db.batch(statements);
    } catch (error) {
      const code = error instanceof CloudHttpError ? error.code : "PAPER_PROCESSING_FAILED";
      const message = error instanceof Error ? error.message : "Paper extraction failed";
      if (PDF_PATH_REJECTED.has(code)) {
        // The endpoint will not take the document whole. Commit the task to page
        // images so the client renders and uploads them, then continues here.
        await db.batch([
          db.prepare("UPDATE cloud_paper_extractions SET status = 'failed', content_mode = 'image', error_code = 'PAPER_PAGE_IMAGES_REQUIRED', error_message = ?, finished_at = ? WHERE id = ?").bind(message, now, taskId),
          db.prepare("UPDATE cloud_papers SET status = 'failed', updated_at = ? WHERE id = ?").bind(now, id),
        ]);
      } else {
        await failTask(db, id, taskId, code, message, now);
      }
    }
    return await readTask(db, taskId, now);
  }

  // Image mode: the key is page-scoped and travels per request, so the client
  // drives one batch at a time instead of a queue consumer holding it.
  return await readTask(db, taskId, now);
}

// Advances one running image extraction by exactly one batch. The page-scoped
// key arrives on this request, which is the only reason the batches are not run
// by a queue consumer.
async function extractionStep(db: D1Database, bucket: R2Bucket, request: Request, taskId: string) {
  const now = new Date().toISOString();
  const current = await db.prepare(`SELECT id, paper_id AS paperId, status, content_mode AS contentMode, completed_pages AS completedPages,
    page_count AS pageCount, source_hash AS sourceHash FROM cloud_paper_extractions WHERE id = ?`)
    .bind(taskId).first<{ id: string; paperId: string; status: string; contentMode: string | null; completedPages: number; pageCount: number | null; sourceHash: string }>();
  if (!current) throw new CloudHttpError(404, "PAPER_TASK_NOT_FOUND", "Paper task not found");
  if (current.status !== "running" || current.contentMode !== "image") return await readTask(db, taskId, now);
  const settings = await settingsRow(db);
  if (!settings.value.enabled) throw new CloudHttpError(409, "LLM_DISABLED", "Cloud AI is disabled");
  const apiKey = llmRequestKey(request);
  const pageCount = current.pageCount ?? 0;
  if (pageCount < 1 || pageCount > PAPER_MAX_PAGES) {
    throw new CloudHttpError(409, "PAPER_PAGE_COUNT_REQUIRED", "The paper page count is unknown");
  }
  const from = current.completedPages + 1;
  const to = Math.min(pageCount, from + PAPER_BATCH_PAGES - 1);
  try {
    const pages: Array<{ pageNumber: number; bytes: Uint8Array }> = [];
    for (let page = from; page <= to; page += 1) {
      const object = await bucket.get(pageImageKey(current.sourceHash, page));
      if (!object) throw new CloudHttpError(409, "PAPER_PAGE_IMAGES_REQUIRED", `第 ${page} 页的页图尚未上传`);
      pages.push({ pageNumber: page, bytes: new Uint8Array(await object.arrayBuffer()) });
    }
    const output = await extractPageRange(settings.value.remote.endpointUrl, settings.value.remote.model, apiKey, pages, from === 1);
    if (!output.ok) throw new CloudHttpError(502, output.code, output.message);
    if (!db.batch) throw new CloudHttpError(500, "CLOUD_DB_UNAVAILABLE", "D1 batch support is required");
    // A batch response carries one block list per page; both reader columns hold
    // it, exactly as the whole-PDF path does, because the model returns the
    // source text and its translation together.
    const statements = output.pages.map((page) => {
      const blocks = JSON.stringify(page.originalBlocks);
      return db.prepare(`INSERT INTO cloud_paper_pages(paper_id, extraction_id, page_number, original_json, translation_json, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(extraction_id, page_number) DO UPDATE SET original_json = excluded.original_json,
        translation_json = excluded.translation_json, revision = revision + 1, updated_at = excluded.updated_at`)
        .bind(current.paperId, taskId, page.pageNumber, blocks, blocks, now, now);
    });
    statements.push(db.prepare("DELETE FROM cloud_semantic_indexes WHERE document_id = ?").bind(current.paperId));
    // Compare-and-swap: a second tab advancing the same task must not double-count.
    statements.push(db.prepare(`UPDATE cloud_paper_extractions SET completed_pages = ?, page_count = COALESCE(page_count, ?)
      WHERE id = ? AND status = 'running' AND completed_pages = ?`).bind(to, pageCount, taskId, current.completedPages));
    if (output.title) statements.push(db.prepare("UPDATE cloud_documents SET title = ?, author = COALESCE(?, author), updated_at = ? WHERE id = ?").bind(output.title, output.authors, now, current.paperId));
    if (to >= pageCount) {
      statements.push(db.prepare("UPDATE cloud_paper_extractions SET status = 'succeeded', completed_pages = ?, page_count = ?, finished_at = ? WHERE id = ? AND status = 'running'").bind(pageCount, pageCount, now, taskId));
      statements.push(db.prepare("UPDATE cloud_papers SET status = 'ready', page_count = ?, updated_at = ? WHERE id = ?").bind(pageCount, now, current.paperId));
    }
    await db.batch(statements);
  } catch (error) {
    const code = error instanceof CloudHttpError ? error.code : "PAPER_PROCESSING_FAILED";
    const message = error instanceof Error ? error.message : "Paper extraction failed";
    await failTask(db, current.paperId, taskId, code, message, now);
  }
  return await readTask(db, taskId, now);
}


export async function handlePaperApi(request: Request, db: D1Database, bucket: R2Bucket, url: URL) {
  if (url.pathname === "/api/papers" && request.method === "POST") {
    const body = await jsonObject(request, 8_192);
    if (typeof body.url !== "string" || Object.keys(body).length !== 1) throw new CloudHttpError(400, "INVALID_PAPER_REQUEST", "A paper URL is required");
    const sourceUrl = await publicUrl(body.url);
    const pdfUrl = sourceUrl.includes("arxiv.org/abs/") ? sourceUrl.replace("/abs/", "/pdf/") + ".pdf" : sourceUrl;
    // Cloudflare's runtime rejects redirect:"error" before the request is sent, so
    // the !response.ok guard below refuses a redirect instead of the runtime.
    const response = await fetch(pdfUrl, { redirect: "manual" });
    if (!response.ok) throw new CloudHttpError(502, "PAPER_FETCH_FAILED", "Paper PDF could not be fetched");
    return { status: 201, body: await create(db, bucket, "url", sourceUrl, "paper.pdf", new Uint8Array(await response.arrayBuffer())) };
  }
  if (url.pathname === "/api/papers/upload" && request.method === "POST") {
    const length = Number(request.headers.get("content-length") || 0);
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_PDF_BYTES) throw new CloudHttpError(413, "PAPER_TOO_LARGE", "Paper PDF exceeds 50 MiB");
    return { status: 201, body: await create(db, bucket, "pdf", null, request.headers.get("x-filename") || "paper.pdf", new Uint8Array(await request.arrayBuffer())) };
  }
  const paperPath = /^\/api\/papers\/([^/]+)$/u.exec(url.pathname);
  if (paperPath && request.method === "GET") {
    const paper = await getPaper(db, decodeURIComponent(paperPath[1]!));
    if (!paper) throw new CloudHttpError(404, "PAPER_NOT_FOUND", "Paper not found");
    return { body: paper };
  }
  const extractionPath = /^\/api\/papers\/([^/]+)\/extractions$/u.exec(url.pathname);
  if (extractionPath && request.method === "POST") return { status: 202, body: await extraction(db, bucket, request, decodeURIComponent(extractionPath[1]!)) };
  const planPath = /^\/api\/papers\/([^/]+)\/extraction-plan$/u.exec(url.pathname);
  if (planPath && request.method === "GET") {
    const id = decodeURIComponent(planPath[1]!);
    const paper = await row(db, id);
    if (!paper) throw new CloudHttpError(404, "PAPER_NOT_FOUND", "Paper not found");
    const settings = await settingsRow(db);
    const sourceHash = String(paper.sourceHash);
    const latest = await latestExtraction(db, id, sourceHash);
    const contentMode: "pdf" | "image" = latest?.contentMode === "image" ? "image" : paperContentMode(settings.value.remote.endpointUrl);
    const rendered = (await pageImageKeys(bucket, sourceHash))
      .map((key) => Number(key.slice(key.lastIndexOf("/") + 1, -4)))
      .filter((page) => Number.isSafeInteger(page) && page >= 1)
      .sort((left, right) => left - right);
    return { body: { contentMode, pageCount: paper.pageCount == null ? null : Number(paper.pageCount), rendered } };
  }
  const renderPath = /^\/api\/papers\/([^/]+)\/page-renders$/u.exec(url.pathname);
  if (renderPath && request.method === "POST") {
    const id = decodeURIComponent(renderPath[1]!);
    const body = await jsonObject(request, 4_096);
    if (Object.keys(body).length !== 1 || !Number.isSafeInteger(body.pageCount) || (body.pageCount as number) < 1 || (body.pageCount as number) > PAPER_MAX_PAGES) {
      throw new CloudHttpError(400, "INVALID_PAPER_REQUEST", `pageCount must be an integer between 1 and ${PAPER_MAX_PAGES}`);
    }
    const paper = await row(db, id);
    if (!paper) throw new CloudHttpError(404, "PAPER_NOT_FOUND", "Paper not found");
    const pageCount = body.pageCount as number;
    const now = new Date().toISOString();
    await db.prepare("UPDATE cloud_papers SET page_count = ?, updated_at = ? WHERE id = ?").bind(pageCount, now, id).run();
    return { body: { pageCount, rendered: await pageImageKeys(bucket, String(paper.sourceHash)) } };
  }
  const pageImagePath = /^\/api\/papers\/([^/]+)\/pages\/([0-9]+)\/image$/u.exec(url.pathname);
  if (pageImagePath && request.method === "PUT") {
    const id = decodeURIComponent(pageImagePath[1]!);
    const page = Number(pageImagePath[2]);
    if (!Number.isSafeInteger(page) || page < 1 || page > PAPER_MAX_PAGES) {
      throw new CloudHttpError(400, "INVALID_PAPER_REQUEST", `Page number must be between 1 and ${PAPER_MAX_PAGES}`);
    }
    const paper = await row(db, id);
    if (!paper) throw new CloudHttpError(404, "PAPER_NOT_FOUND", "Paper not found");
    const declared = Number(request.headers.get("content-length") || 0);
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > PAPER_PAGE_IMAGE_MAX_BYTES) {
      throw new CloudHttpError(413, "PAPER_PAGE_IMAGE_TOO_LARGE", `A page image must be a JPEG under ${PAPER_PAGE_IMAGE_MAX_BYTES} bytes`);
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength < 3 || bytes.byteLength > PAPER_PAGE_IMAGE_MAX_BYTES) throw new CloudHttpError(413, "PAPER_PAGE_IMAGE_TOO_LARGE", "A page image must be a JPEG under the size limit");
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new CloudHttpError(415, "PAPER_PAGE_IMAGE_INVALID", "A JPEG page image is required");
    await bucket.put(pageImageKey(String(paper.sourceHash), page), bytes, { httpMetadata: { contentType: PAPER_PAGE_IMAGE_TYPE } });
    return { body: { pageNumber: page, bytes: bytes.byteLength } };
  }
  const taskPath = /^\/api\/paper-tasks\/([^/]+)$/u.exec(url.pathname);
  if (taskPath && request.method === "GET") {
    const taskId = decodeURIComponent(taskPath[1]!);
    const exists = await db.prepare("SELECT 1 AS found FROM cloud_paper_extractions WHERE id = ?").bind(taskId).first();
    if (!exists) throw new CloudHttpError(404, "PAPER_TASK_NOT_FOUND", "Paper task not found");
    return { body: await readTask(db, taskId, new Date().toISOString()) };
  }
  const taskStepPath = /^\/api\/paper-tasks\/([^/]+)\/pages$/u.exec(url.pathname);
  if (taskStepPath && request.method === "POST") {
    const body = await jsonObject(request, 4_096);
    if (Object.keys(body).length) throw new CloudHttpError(400, "INVALID_PAPER_REQUEST", "Advancing a paper task accepts no fields");
    return { status: 202, body: await extractionStep(db, bucket, request, decodeURIComponent(taskStepPath[1]!)) };
  }
  const pagePath = /^\/api\/papers\/([^/]+)\/pages\/([0-9]+)$/u.exec(url.pathname);
  if (pagePath) {
    const id = decodeURIComponent(pagePath[1]!);
    const number = Number(pagePath[2]);
    const paper = await row(db, id);
    if (!paper || !paper.extractionId) throw new CloudHttpError(404, "PAPER_PAGE_NOT_FOUND", "Paper page not found");
    if (request.method === "GET") {
      const page = await db.prepare("SELECT pp.paper_id AS paperId, pp.extraction_id AS extractionId, pp.page_number AS pageNumber, pp.original_json AS originalJson, pp.translation_json AS translationJson, pp.revision, d.revision AS documentRevision FROM cloud_paper_pages pp JOIN cloud_documents d ON d.id = pp.paper_id WHERE pp.paper_id = ? AND pp.extraction_id = ? AND pp.page_number = ?").bind(id, paper.extractionId, number).first<Record<string, unknown>>();
      if (!page) throw new CloudHttpError(404, "PAPER_PAGE_NOT_FOUND", "Paper page not found");
      return { body: { paperId: id, extractionId: String(page.extractionId), pageNumber: number, originalBlocks: JSON.parse(String(page.originalJson)), translationBlocks: JSON.parse(String(page.translationJson)), revision: Number(page.revision), documentRevision: Number(page.documentRevision) } satisfies PaperPage };
    }
    if (request.method === "PATCH") {
      const body = await jsonObject(request, 256 * 1024);
      if (typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || !Array.isArray(body.translationBlocks)) throw new CloudHttpError(400, "INVALID_PAPER_PAGE", "revision and translationBlocks are required");
      const updated = await db.prepare("UPDATE cloud_paper_pages SET translation_json = ?, revision = revision + 1, updated_at = ? WHERE paper_id = ? AND extraction_id = ? AND page_number = ? AND revision = ?").bind(JSON.stringify(body.translationBlocks), new Date().toISOString(), id, paper.extractionId, number, body.revision).run();
      if (changes(updated) !== 1) throw new CloudHttpError(409, "PAPER_PAGE_CONFLICT", "Paper page changed since it was loaded");
      return handlePaperApi(new Request(new URL(`/api/papers/${encodeURIComponent(id)}/pages/${number}`, request.url), { method: "GET", headers: request.headers }), db, bucket, new URL(`/api/papers/${encodeURIComponent(id)}/pages/${number}`, request.url));
    }
  }
  return null;
}

export async function paperSource(bucket: R2Bucket, db: D1Database, id: string) {
  const value = await row(db, id);
  if (!value) throw new CloudHttpError(404, "PAPER_NOT_FOUND", "Paper not found");
  const object = await bucket.get(`paper/${value.sourceHash}`);
  if (!object) throw new CloudHttpError(404, "PAPER_SOURCE_MISSING", "Paper PDF is missing");
  return object;
}
