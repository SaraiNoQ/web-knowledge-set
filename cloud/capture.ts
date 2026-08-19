import ipaddr from "ipaddr.js";

import {
  CloudHttpError,
  documentFolderFilter,
  documentTrashFilter,
  epochGuardedDatabase,
  folderIdValue,
  getDocument,
  jsonObject,
  MAX_CLOUD_ROW_TEXT_BYTES,
  permanentlyDeleteDocument,
  restoreDocument,
  trashDocument,
  updateDocument,
  type D1Database,
} from "./extension";

interface QueueBinding { send(body: unknown): Promise<void> }
interface BrowserRun { quickAction(action: string, options: Record<string, unknown>): Promise<Response> }
export interface CaptureEnv { DB: D1Database; CAPTURE_QUEUE: QueueBinding; BROWSER: BrowserRun }
export interface QueueMessage<T> { body: T; ack(): void; retry(): void }
export interface QueueBatch<T> { messages: QueueMessage<T>[] }

interface CaptureMessage { id: string; url: string; epoch: string }
const MAX_HTML_BYTES = 5 * 1024 * 1024;
interface RewriterElement {
  tagName: string;
  attributes: Iterable<[string, string]>;
  remove(): void;
  removeAttribute(name: string): void;
}
interface Rewriter {
  on(selector: string, handlers: { element(element: RewriterElement): void }): Rewriter;
  transform(response: Response): Response;
}
declare const HTMLRewriter: new () => Rewriter;

function changes(result: { meta: { changes?: number } }) { return result.meta.changes ?? 0; }

async function sanitizeHtml(html: string) {
  const blocked = new Set(["script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "link", "style", "video", "audio", "source", "svg", "base"]);
  const rewritten = new HTMLRewriter().on("*", {
    element(element) {
      if (blocked.has(element.tagName) || (element.tagName === "meta" && [...element.attributes].some(([name, value]) => name === "http-equiv" && value.toLowerCase() === "refresh"))) {
        element.remove();
        return;
      }
      for (const [name] of element.attributes) {
        if (name.toLowerCase().startsWith("on") || ["src", "srcset", "poster", "background", "style", "action", "formaction"].includes(name.toLowerCase())) element.removeAttribute(name);
      }
    },
  }).transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  return await rewritten.text();
}

interface CaptureJobRow {
  id: string;
  url: string;
  status: "queued" | "fetching" | "failed";
  errorCode: string | null;
  folderId: string | null;
  revision: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function jobDocument(row: CaptureJobRow) {
  return {
    id: row.id, title: row.url, sourceUrl: row.url, finalUrl: null, canonicalUrl: row.url, author: null,
    status: row.status, warning: null, errorCode: row.errorCode, errorMessage: null, tags: [], collections: [], favorite: false,
    folderId: row.folderId, archivedAt: null, revision: row.revision, deletedAt: row.deletedAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
    publishedAt: null, markdown: "", captureMode: "browser", sourceNote: "Cloudflare Browser Run",
  };
}

async function publicUrl(input: unknown) {
  let url: URL;
  try { url = new URL(typeof input === "string" ? input.trim() : ""); }
  catch { throw new CloudHttpError(400, "INVALID_URL", "A valid HTTP or HTTPS URL is required"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.port === "0") {
    throw new CloudHttpError(400, "INVALID_URL", "A public HTTP or HTTPS URL is required");
  }
  url.hash = "";
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local") || ipaddr.isValid(hostname)) {
    throw new CloudHttpError(400, "BLOCKED_ADDRESS", "IP literals and local hostnames are blocked");
  }
  const answers = await Promise.all(["A", "AAAA"].map(async (type) => {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, { headers: { "Accept": "application/dns-json" }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new CloudHttpError(502, "DNS_FAILED", "Hostname resolution failed");
    const body = await response.json() as { Answer?: Array<{ type: number; data: string }> };
    return (body.Answer || []).filter((answer) => answer.type === 1 || answer.type === 28).map((answer) => answer.data);
  }));
  const addresses = answers.flat();
  if (!addresses.length || addresses.some((address) => !ipaddr.isValid(address) || ipaddr.process(address).range() !== "unicast")) {
    throw new CloudHttpError(400, "BLOCKED_ADDRESS", "Hostname resolved to a blocked network range");
  }
  return url.href;
}

export async function createCapture(request: Request, env: CaptureEnv, expectedEpoch: string) {
  const body = await jsonObject(request, 8_192);
  if (Object.keys(body).some((name) => name !== "url" && name !== "force") || (body.force !== undefined && body.force !== true)) {
    throw new CloudHttpError(400, "INVALID_CAPTURE_REQUEST", "Capture accepts url and optional force=true");
  }
  const url = await publicUrl(body.url);
  if (body.force !== true) {
    const existing = await env.DB.prepare("SELECT id FROM cloud_documents WHERE deleted_at IS NULL AND (source_url = ? OR canonical_url = ?) LIMIT 1").bind(url, url).first<{ id: string }>();
    if (existing) return { document: await getDocument(env.DB, existing.id), created: false, duplicateKind: "source" };
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO cloud_capture_jobs(id, url, status, error_code, folder_id, revision, created_at, updated_at) VALUES (?, ?, 'queued', NULL, NULL, 1, ?, ?)")
    .bind(id, url, now, now).run();
  try { await env.CAPTURE_QUEUE.send({ id, url, epoch: expectedEpoch } satisfies CaptureMessage); }
  catch {
    await env.DB.prepare("UPDATE cloud_capture_jobs SET status = 'failed', error_code = 'QUEUE_FAILED', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
    throw new CloudHttpError(502, "QUEUE_FAILED", "Capture could not be queued");
  }
  return {
    document: jobDocument({ id, url, status: "queued", errorCode: null, folderId: null, revision: 1, deletedAt: null, createdAt: now, updatedAt: now }),
    created: true,
    duplicateKind: null,
  };
}

export async function getCaptureJob(db: D1Database, id: string) {
  const row = await db.prepare(`SELECT id, url, status, error_code AS errorCode, folder_id AS folderId, revision,
    deleted_at AS deletedAt, created_at AS createdAt, updated_at AS updatedAt FROM cloud_capture_jobs WHERE id = ?`).bind(id).first<CaptureJobRow>();
  return row ? jobDocument(row) : null;
}

export async function listCaptureJobs(db: D1Database, url: URL, window = { limit: 30, offset: 0 }) {
  const folder = documentFolderFilter(url);
  const conditions = [documentTrashFilter(url) ? "j.deleted_at IS NOT NULL" : "j.deleted_at IS NULL",
    "NOT EXISTS (SELECT 1 FROM cloud_documents d WHERE d.id = j.id)"];
  if (folder.folderId) conditions.push("j.folder_id = ?");
  else if (folder.unfiled === true) conditions.push("j.folder_id IS NULL");
  else if (folder.unfiled === false) conditions.push("j.folder_id IS NOT NULL");
  const captureMode = url.searchParams.get("captureMode");
  if (url.searchParams.get("favorite") === "true" || url.searchParams.get("archived") === "true" ||
    url.searchParams.get("tag") || url.searchParams.get("collectionId") || (captureMode && captureMode !== "browser")) conditions.push("0");
  const dateValues: string[] = [];
  for (const [parameter, operator, suffix] of [["from", ">=", "T00:00:00.000Z"], ["to", "<=", "T23:59:59.999Z"]] as const) {
    const date = url.searchParams.get(parameter);
    if (!date) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
      throw new CloudHttpError(400, "INVALID_DATE", `${parameter} must be a real YYYY-MM-DD date`);
    }
    conditions.push(`j.created_at ${operator} ?`);
    dateValues.push(`${date}${suffix}`);
  }
  if (url.searchParams.get("from") && url.searchParams.get("to") && url.searchParams.get("from")! > url.searchParams.get("to")!) {
    throw new CloudHttpError(400, "INVALID_DATE_RANGE", "from must not be after to");
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  const values = [...(folder.folderId ? [folder.folderId] : []), ...dateValues];
  const count = await db.prepare(`SELECT COUNT(*) AS count FROM cloud_capture_jobs j ${where}`)
    .bind(...values).first<{ count: number }>();
  const sort = url.searchParams.get("sort") === "title" ? "lower(j.url) COLLATE BINARY ASC, j.id" :
    url.searchParams.get("sort") === "created" ? "j.created_at DESC, j.id" : "j.updated_at DESC, j.id";
  const rows = await db.prepare(`SELECT j.id, j.url, j.status, j.error_code AS errorCode, j.folder_id AS folderId, j.revision,
    j.deleted_at AS deletedAt, j.created_at AS createdAt, j.updated_at AS updatedAt FROM cloud_capture_jobs j ${where}
    ORDER BY ${sort} LIMIT ? OFFSET ?`)
    .bind(...values, window.limit, window.offset).all<CaptureJobRow>();
  return { items: rows.results.map(jobDocument), total: count?.count ?? 0 };
}

export async function updateCaptureJob(db: D1Database, id: string, body: Record<string, unknown>) {
  if (Object.keys(body).length !== 2 || !Object.hasOwn(body, "folderId") ||
    typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 1) {
    throw new CloudHttpError(400, "INVALID_DOCUMENT_UPDATE", "Capture jobs only accept a folderId and positive revision");
  }
  const folderId = folderIdValue(body.folderId);
  const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE cloud_capture_jobs
    SET folder_id = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL${folderId ? " AND EXISTS (SELECT 1 FROM cloud_folders WHERE id = ?)" : ""}`)
    .bind(folderId, now, id, body.revision, ...(folderId ? [folderId] : [])).run();
  if (changes(result) !== 1) {
    const current = await getCaptureJob(db, id);
    if (!current) {
      if (await getDocument(db, id)) return await updateDocument(db, id, body);
      throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    }
    if (current.revision !== body.revision) {
      throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", current);
    }
    if (current.deletedAt) throw new CloudHttpError(409, "DOCUMENT_DELETED", "Restore the document before changing it", current);
    if (folderId && !await db.prepare("SELECT id FROM cloud_folders WHERE id = ?").bind(folderId).first()) {
      throw new CloudHttpError(400, "INVALID_FOLDER_ID", "folderId does not reference an existing folder");
    }
    throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", current);
  }
  return await getCaptureJob(db, id) ?? await getDocument(db, id);
}

function captureRevision(body: Record<string, unknown>, permanent = false) {
  const allowed = permanent ? ["revision", "draftRevision"] : ["revision"];
  if (Object.keys(body).some((key) => !allowed.includes(key)) ||
    typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 1 ||
    (permanent && body.draftRevision !== null && body.draftRevision !== undefined)) {
    throw new CloudHttpError(400, "INVALID_DOCUMENT_UPDATE", "A positive revision is required");
  }
  return body.revision;
}

export async function trashCaptureJob(db: D1Database, id: string, body: Record<string, unknown>) {
  const revision = captureRevision(body);
  const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE cloud_capture_jobs SET deleted_at = ?, status = 'failed', error_code = 'TRASHED',
    revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL`)
    .bind(now, now, id, revision).run();
  if (changes(result) === 1) return await getCaptureJob(db, id);
  const current = await getCaptureJob(db, id);
  if (!current) {
    if (await getDocument(db, id)) return await trashDocument(db, id, body);
    throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Capture job not found");
  }
  if (current.revision !== revision) throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", current);
  throw new CloudHttpError(409, "DOCUMENT_DELETED", "Document is already in the trash", current);
}

export async function restoreCaptureJob(db: D1Database, id: string, body: Record<string, unknown>) {
  const revision = captureRevision(body);
  const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE cloud_capture_jobs SET deleted_at = NULL, error_code = 'RESTORED_NEEDS_RETRY',
    revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL`)
    .bind(now, id, revision).run();
  if (changes(result) === 1) return await getCaptureJob(db, id);
  const current = await getCaptureJob(db, id);
  if (!current) {
    if (await getDocument(db, id)) return await restoreDocument(db, id, body);
    throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Capture job not found");
  }
  if (current.revision !== revision) throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", current);
  throw new CloudHttpError(409, "NOT_IN_TRASH", "Document is not in the trash", current);
}

export async function permanentlyDeleteCaptureJob(db: D1Database, id: string, body: Record<string, unknown>) {
  const revision = captureRevision(body, true);
  const result = await db.prepare("DELETE FROM cloud_capture_jobs WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL")
    .bind(id, revision).run();
  if (changes(result) === 1) return;
  const current = await getCaptureJob(db, id);
  if (!current) {
    if (await getDocument(db, id)) return await permanentlyDeleteDocument(db, id, body);
    throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Capture job not found");
  }
  if (current.revision !== revision) throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", current);
  throw new CloudHttpError(409, "NOT_IN_TRASH", "Document must be in the trash before permanent deletion", current);
}

export async function captureQueueStatus(db: D1Database) {
  const row = await db.prepare(`SELECT
    SUM(CASE WHEN status = 'fetching' THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued
    FROM cloud_capture_jobs WHERE deleted_at IS NULL`).first<{ active: number | null; queued: number | null }>();
  return { paused: false, active: row?.active ?? 0, queued: row?.queued ?? 0 };
}

export async function retryCapture(id: string, env: CaptureEnv, expectedEpoch: string) {
  const job = await getCaptureJob(env.DB, id);
  if (!job) throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Capture job not found");
  if (job.deletedAt) throw new CloudHttpError(409, "DOCUMENT_DELETED", "Restore the document before retrying", job);
  const url = await publicUrl(job.sourceUrl);
  const now = new Date().toISOString();
  const queued = await env.DB.prepare(`UPDATE cloud_capture_jobs SET status = 'queued', error_code = NULL,
    revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL`)
    .bind(now, id, job.revision).run();
  if (changes(queued) !== 1) {
    const current = await getCaptureJob(env.DB, id) ?? await getDocument(env.DB, id);
    if (!current) throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Capture job not found");
    if (current.deletedAt) throw new CloudHttpError(409, "DOCUMENT_DELETED", "Restore the document before retrying", current);
    throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", current);
  }
  try { await env.CAPTURE_QUEUE.send({ id, url, epoch: expectedEpoch } satisfies CaptureMessage); }
  catch {
    const failed = await env.DB.prepare(`UPDATE cloud_capture_jobs SET status = 'failed', error_code = 'QUEUE_FAILED',
      revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL`)
      .bind(new Date().toISOString(), id, job.revision + 1).run();
    if (changes(failed) !== 1) {
      const current = await getCaptureJob(env.DB, id) ?? await getDocument(env.DB, id);
      if (current?.deletedAt) throw new CloudHttpError(409, "DOCUMENT_DELETED", "Restore the document before retrying", current);
      if (current) throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", current);
    }
    throw new CloudHttpError(502, "QUEUE_FAILED", "Capture could not be queued");
  }
  return await getCaptureJob(env.DB, id) ?? await getDocument(env.DB, id);
}

async function consume(message: CaptureMessage, env: CaptureEnv) {
  const epoch = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").first<{ value: string }>();
  if (!epoch || epoch.value.startsWith("restore:") || epoch.value !== message.epoch) {
    throw new CloudHttpError(409, "STALE_DATA_EPOCH", "Cloud data changed before capture completion");
  }
  const job = await getCaptureJob(env.DB, message.id);
  if (!job || job.deletedAt) return;
  const existing = await getDocument(env.DB, message.id);
  if (existing) {
    await env.DB.prepare("DELETE FROM cloud_capture_jobs WHERE id = ?").bind(message.id).run();
    return;
  }
  let url = await publicUrl(message.url);
  const fetching = await env.DB.prepare("UPDATE cloud_capture_jobs SET status = 'fetching', error_code = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(new Date().toISOString(), message.id).run();
  if (changes(fetching) !== 1) return;
  let html = "";
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    url = await publicUrl(url);
    const page = await fetch(url, { redirect: "manual", headers: { "Accept": "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(15_000) });
    if (page.status >= 300 && page.status < 400) {
      const location = page.headers.get("Location");
      if (!location || redirects === 5) throw new CloudHttpError(502, "HTTP_ERROR", "Capture redirect is invalid or excessive");
      url = new URL(location, url).href;
      continue;
    }
    if (!page.ok || !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(page.headers.get("Content-Type") || "")) throw new CloudHttpError(502, "HTTP_ERROR", "Capture target did not return HTML");
    const declared = Number(page.headers.get("Content-Length") || 0);
    if (declared > MAX_HTML_BYTES) throw new CloudHttpError(413, "RESPONSE_TOO_LARGE", "Capture HTML exceeds 5 MiB");
    const reader = page.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_HTML_BYTES) { await reader.cancel(); throw new CloudHttpError(413, "RESPONSE_TOO_LARGE", "Capture HTML exceeds 5 MiB"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    html = new TextDecoder().decode(bytes);
    break;
  }
  if (!html) throw new CloudHttpError(502, "EXTRACTION_EMPTY", "Capture target returned no HTML");
  const response = await env.BROWSER.quickAction("markdown", { html: await sanitizeHtml(html) });
  if (!response.ok) throw new CloudHttpError(502, "BROWSER_FAILED", "Browser Run failed to capture the page");
  const payload = await response.json() as { success?: boolean; result?: unknown };
  if (payload.success !== true || typeof payload.result !== "string" || !payload.result.trim()) {
    throw new CloudHttpError(502, "EXTRACTION_EMPTY", "Browser Run returned no Markdown");
  }
  const markdown = payload.result.trim();
  if (new TextEncoder().encode(markdown).byteLength > MAX_CLOUD_ROW_TEXT_BYTES) throw new CloudHttpError(413, "RESPONSE_TOO_LARGE", "Captured Markdown exceeds the D1 row budget");
  const title = /^#\s+(.+)$/mu.exec(markdown)?.[1]?.trim() || new URL(url).hostname;
  const now = new Date().toISOString();
  if (!env.DB.batch) throw new CloudHttpError(503, "CLOUD_BATCH_UNAVAILABLE", "D1 batch API is unavailable");
  await env.DB.batch([env.DB.prepare(`INSERT INTO cloud_documents(
    id, source_url, final_url, canonical_url, title, author, published_at, markdown, status, source_note, folder_id, revision, created_at, updated_at
  ) SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, 'ready', 'Cloudflare Browser Run', job.folder_id, job.revision + 1, ?, ?
    FROM cloud_capture_jobs job WHERE job.id = ? AND job.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'data_epoch' AND value = ?)`).bind(
    message.id, url, url, url, title.slice(0, 1_000), markdown, now, now, message.id, message.epoch,
  ), env.DB.prepare(`DELETE FROM cloud_capture_jobs WHERE id = ?
    AND EXISTS (SELECT 1 FROM cloud_documents WHERE id = ?)`).bind(message.id, message.id)]);
}

export async function handleCaptureQueue(batch: QueueBatch<CaptureMessage>, env: CaptureEnv) {
  for (const message of batch.messages) {
    const guardedEnv = { ...env, DB: epochGuardedDatabase(env.DB, message.body.epoch) };
    try {
      await consume(message.body, guardedEnv);
      message.ack();
    } catch (error) {
      if (error instanceof CloudHttpError && error.code === "STALE_DATA_EPOCH") {
        const current = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'")
          .first<{ value: string }>();
        if (current?.value.startsWith("restore:") || current?.value === message.body.epoch) message.retry();
        else message.ack();
        continue;
      }
      const code = error instanceof CloudHttpError ? error.code : "BROWSER_FAILED";
      await guardedEnv.DB.prepare("UPDATE cloud_capture_jobs SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .bind(code, new Date().toISOString(), message.body.id).run();
      message.ack();
    }
  }
}
