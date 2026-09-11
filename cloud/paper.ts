import type { PaperBlock, PaperDocument, PaperExtractionTask, PaperPage, PaperSummary } from "../shared/types";
import { completePaper, llmRequestKey, settingsRow } from "./ai";
import { CloudHttpError, jsonObject, type D1Database } from "./extension";
import { publicUrl } from "./net";
import type { R2Bucket } from "./backup";

function changes(result: { meta: { changes?: number } }) {
  return result.meta.changes ?? 0;
}

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const PROMPT = `You extract an academic paper for a bilingual page reader. Return JSON only with paper.title, paper.authors, and pages. Keep one page per PDF page. Each page has blocks with id, type, original, translation, assetIds. Allowed types: heading, paragraph, formula, table, figure, caption, reference. Translate to simplified Chinese and never invent binary image data.`;

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
  }
}

export async function getPaper(db: D1Database, id: string): Promise<PaperDocument | null> {
  const value = await row(db, id);
  if (!value) return null;
  const pages = value.extractionId ? await db.prepare(`SELECT paper_id AS paperId, extraction_id AS extractionId, page_number AS pageNumber,
    original_json AS originalJson, translation_json AS translationJson, revision FROM cloud_paper_pages
    WHERE paper_id = ? AND extraction_id = ? ORDER BY page_number`).bind(id, value.extractionId).all<Record<string, unknown>>() : { results: [] };
  return {
    ...summary(value), sourceKind: value.paperSourceUrl ? "url" : "pdf", originalFileName: value.originalFileName ? String(value.originalFileName) : null,
    sourceHash: String(value.sourceHash), extractionId: value.extractionId ? String(value.extractionId) : null,
    pages: pages.results.map((page) => ({ paperId: String(page.paperId), extractionId: String(page.extractionId), pageNumber: Number(page.pageNumber), originalBlocks: JSON.parse(String(page.originalJson)) as PaperBlock[], translationBlocks: JSON.parse(String(page.translationJson)) as PaperBlock[], revision: Number(page.revision) })),
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

async function extraction(db: D1Database, bucket: R2Bucket, request: Request, id: string) {
  const paper = await row(db, id);
  if (!paper) throw new CloudHttpError(404, "PAPER_NOT_FOUND", "Paper not found");
  const settings = await settingsRow(db);
  if (!settings.value.enabled) throw new CloudHttpError(409, "LLM_DISABLED", "Cloud AI is disabled");
  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();
  const endpointId = `endpoint-${(await hash(new TextEncoder().encode(settings.value.remote.endpointUrl))).slice(0, 16)}`;
  if (!db.batch) throw new CloudHttpError(500, "CLOUD_DB_UNAVAILABLE", "D1 batch support is required");
  await db.batch([
    db.prepare("INSERT INTO cloud_paper_extractions(id, paper_id, status, model, endpoint_id, prompt_version, source_hash, created_at) VALUES (?, ?, 'running', ?, ?, 'paper-extraction-v1', ?, ?)").bind(taskId, id, settings.value.remote.model, endpointId, paper.sourceHash, now),
    db.prepare("UPDATE cloud_papers SET status = 'extracting', extraction_id = ?, updated_at = ? WHERE id = ?").bind(taskId, now, id),
  ]);
  try {
    const object = await bucket.get(`paper/${paper.sourceHash}`);
    if (!object) throw new CloudHttpError(404, "PAPER_SOURCE_MISSING", "Paper PDF is missing from R2");
    const output = parsed(await completePaper(settings.value.remote.endpointUrl, settings.value.remote.model, llmRequestKey(request), PROMPT, new Uint8Array(await object.arrayBuffer())));
    const statements = output.pages.map((page) => db.prepare(`INSERT INTO cloud_paper_pages(paper_id, extraction_id, page_number, original_json, translation_json, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).bind(id, taskId, page.pageNumber, JSON.stringify(page.originalBlocks), JSON.stringify(page.translationBlocks), now, now));
    statements.push(db.prepare("UPDATE cloud_paper_extractions SET status = 'succeeded', page_count = ?, completed_pages = ?, finished_at = ? WHERE id = ?").bind(output.pages.length, output.pages.length, now, taskId));
    statements.push(db.prepare("UPDATE cloud_papers SET status = 'ready', page_count = ?, updated_at = ? WHERE id = ?").bind(output.pages.length, now, id));
    statements.push(db.prepare("UPDATE cloud_documents SET title = ?, author = ?, updated_at = ? WHERE id = ?").bind(output.title, output.authors, now, id));
    await db.batch(statements);
  } catch (error) {
    const code = error instanceof CloudHttpError ? error.code : "PAPER_PROCESSING_FAILED";
    const message = error instanceof Error ? error.message : "Paper extraction failed";
    if (!db.batch) throw new CloudHttpError(500, "CLOUD_DB_UNAVAILABLE", "D1 batch support is required");
    await db.batch([
      db.prepare("UPDATE cloud_paper_extractions SET status = 'failed', error_code = ?, error_message = ?, finished_at = ? WHERE id = ?").bind(code, message, now, taskId),
      db.prepare("UPDATE cloud_papers SET status = 'failed', updated_at = ? WHERE id = ?").bind(now, id),
    ]);
  }
  const task = await db.prepare("SELECT id, paper_id AS paperId, status, page_count AS pageCount, completed_pages AS completedPages, error_code AS errorCode, error_message AS errorMessage, created_at AS createdAt, finished_at AS finishedAt FROM cloud_paper_extractions WHERE id = ?").bind(taskId).first<Record<string, unknown>>();
  const status = task?.status === "queued" || task?.status === "running" || task?.status === "succeeded" || task?.status === "failed" || task?.status === "cancelled" ? task.status : "failed";
  const pageCount = typeof task?.pageCount === "number" ? task.pageCount : null;
  const completedPages = typeof task?.completedPages === "number" ? task.completedPages : 0;
  return { id: taskId, paperId: id, status, pageCount, completedPages, error: task?.errorCode ? { code: String(task.errorCode), message: String(task.errorMessage || "Paper extraction failed") } : null, createdAt: String(task?.createdAt || now), finishedAt: task?.finishedAt ? String(task.finishedAt) : null } satisfies PaperExtractionTask;
}

export async function handlePaperApi(request: Request, db: D1Database, bucket: R2Bucket, url: URL) {
  if (url.pathname === "/api/papers" && request.method === "POST") {
    const body = await jsonObject(request, 8_192);
    if (typeof body.url !== "string" || Object.keys(body).length !== 1) throw new CloudHttpError(400, "INVALID_PAPER_REQUEST", "A paper URL is required");
    const sourceUrl = await publicUrl(body.url);
    const pdfUrl = sourceUrl.includes("arxiv.org/abs/") ? sourceUrl.replace("/abs/", "/pdf/") + ".pdf" : sourceUrl;
    const response = await fetch(pdfUrl, { redirect: "error" });
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
  const taskPath = /^\/api\/paper-tasks\/([^/]+)$/u.exec(url.pathname);
  if (taskPath && request.method === "GET") {
    const task = await db.prepare("SELECT id, paper_id AS paperId, status, page_count AS pageCount, completed_pages AS completedPages, error_code AS errorCode, error_message AS errorMessage, created_at AS createdAt, finished_at AS finishedAt FROM cloud_paper_extractions WHERE id = ?").bind(decodeURIComponent(taskPath[1]!)).first<Record<string, unknown>>();
    if (!task) throw new CloudHttpError(404, "PAPER_TASK_NOT_FOUND", "Paper task not found");
    return { body: { id: String(task.id), paperId: String(task.paperId), status: task.status, pageCount: task.pageCount || null, completedPages: task.completedPages || 0, error: task.errorCode ? { code: String(task.errorCode), message: String(task.errorMessage || "Paper extraction failed") } : null, createdAt: String(task.createdAt), finishedAt: task.finishedAt ? String(task.finishedAt) : null } };
  }
  const pagePath = /^\/api\/papers\/([^/]+)\/pages\/([0-9]+)$/u.exec(url.pathname);
  if (pagePath) {
    const id = decodeURIComponent(pagePath[1]!);
    const number = Number(pagePath[2]);
    const paper = await row(db, id);
    if (!paper || !paper.extractionId) throw new CloudHttpError(404, "PAPER_PAGE_NOT_FOUND", "Paper page not found");
    if (request.method === "GET") {
      const page = await db.prepare("SELECT paper_id AS paperId, extraction_id AS extractionId, page_number AS pageNumber, original_json AS originalJson, translation_json AS translationJson, revision FROM cloud_paper_pages WHERE paper_id = ? AND extraction_id = ? AND page_number = ?").bind(id, paper.extractionId, number).first<Record<string, unknown>>();
      if (!page) throw new CloudHttpError(404, "PAPER_PAGE_NOT_FOUND", "Paper page not found");
      return { body: { paperId: id, extractionId: String(page.extractionId), pageNumber: number, originalBlocks: JSON.parse(String(page.originalJson)), translationBlocks: JSON.parse(String(page.translationJson)), revision: Number(page.revision) } satisfies PaperPage };
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
