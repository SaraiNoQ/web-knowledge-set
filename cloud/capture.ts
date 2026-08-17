import ipaddr from "ipaddr.js";

import { CloudHttpError, getDocument, jsonObject, MAX_CLOUD_ROW_TEXT_BYTES, type D1Database } from "./extension";

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

function jobDocument(row: { id: string; url: string; status: "queued" | "fetching" | "failed"; errorCode: string | null; createdAt: string; updatedAt: string }) {
  return {
    id: row.id, title: row.url, sourceUrl: row.url, finalUrl: null, canonicalUrl: row.url, author: null,
    status: row.status, warning: null, errorCode: row.errorCode, errorMessage: null, tags: [], collections: [], favorite: false,
    archivedAt: null, revision: 1, deletedAt: null, createdAt: row.createdAt, updatedAt: row.updatedAt,
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

export async function createCapture(request: Request, env: CaptureEnv) {
  const body = await jsonObject(request, 8_192);
  if (Object.keys(body).some((name) => name !== "url" && name !== "force") || (body.force !== undefined && body.force !== true)) {
    throw new CloudHttpError(400, "INVALID_CAPTURE_REQUEST", "Capture accepts url and optional force=true");
  }
  const url = await publicUrl(body.url);
  if (body.force !== true) {
    const existing = await env.DB.prepare("SELECT id FROM cloud_documents WHERE source_url = ? OR canonical_url = ? LIMIT 1").bind(url, url).first<{ id: string }>();
    if (existing) return { document: await getDocument(env.DB, existing.id), created: false, duplicateKind: "source" };
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO cloud_capture_jobs(id, url, status, error_code, created_at, updated_at) VALUES (?, ?, 'queued', NULL, ?, ?)")
    .bind(id, url, now, now).run();
  const epoch = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").first<{ value: string }>();
  if (!epoch) throw new CloudHttpError(503, "CLOUD_NOT_INITIALIZED", "Cloud data epoch is missing");
  try { await env.CAPTURE_QUEUE.send({ id, url, epoch: epoch.value } satisfies CaptureMessage); }
  catch {
    await env.DB.prepare("UPDATE cloud_capture_jobs SET status = 'failed', error_code = 'QUEUE_FAILED', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
    throw new CloudHttpError(502, "QUEUE_FAILED", "Capture could not be queued");
  }
  return { document: jobDocument({ id, url, status: "queued", errorCode: null, createdAt: now, updatedAt: now }), created: true, duplicateKind: null };
}

export async function getCaptureJob(db: D1Database, id: string) {
  const row = await db.prepare(`SELECT id, url, status, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt
    FROM cloud_capture_jobs WHERE id = ?`).bind(id).first<{ id: string; url: string; status: "queued" | "fetching" | "failed"; errorCode: string | null; createdAt: string; updatedAt: string }>();
  return row ? jobDocument(row) : null;
}

export async function listCaptureJobs(db: D1Database) {
  const rows = await db.prepare(`SELECT id, url, status, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt
    FROM cloud_capture_jobs ORDER BY updated_at DESC LIMIT 30`).all<{ id: string; url: string; status: "queued" | "fetching" | "failed"; errorCode: string | null; createdAt: string; updatedAt: string }>();
  return rows.results.map(jobDocument);
}

export async function captureQueueStatus(db: D1Database) {
  const row = await db.prepare(`SELECT
    SUM(CASE WHEN status = 'fetching' THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued
    FROM cloud_capture_jobs`).first<{ active: number | null; queued: number | null }>();
  return { paused: false, active: row?.active ?? 0, queued: row?.queued ?? 0 };
}

export async function retryCapture(id: string, env: CaptureEnv) {
  const job = await getCaptureJob(env.DB, id);
  if (!job) throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Capture job not found");
  const url = await publicUrl(job.sourceUrl);
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE cloud_capture_jobs SET status = 'queued', error_code = NULL, updated_at = ? WHERE id = ?").bind(now, id).run();
  const epoch = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").first<{ value: string }>();
  if (!epoch) throw new CloudHttpError(503, "CLOUD_NOT_INITIALIZED", "Cloud data epoch is missing");
  try { await env.CAPTURE_QUEUE.send({ id, url, epoch: epoch.value } satisfies CaptureMessage); }
  catch {
    await env.DB.prepare("UPDATE cloud_capture_jobs SET status = 'failed', error_code = 'QUEUE_FAILED', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
    throw new CloudHttpError(502, "QUEUE_FAILED", "Capture could not be queued");
  }
  return { ...job, status: "queued" as const, errorCode: null, updatedAt: now };
}

async function consume(message: CaptureMessage, env: CaptureEnv) {
  const epoch = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").first<{ value: string }>();
  if (!epoch || epoch.value !== message.epoch) return;
  const existing = await getDocument(env.DB, message.id);
  if (existing) {
    await env.DB.prepare("DELETE FROM cloud_capture_jobs WHERE id = ?").bind(message.id).run();
    return;
  }
  let url = await publicUrl(message.url);
  await env.DB.prepare("UPDATE cloud_capture_jobs SET status = 'fetching', error_code = NULL, updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), message.id).run();
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
  const inserted = await env.DB.prepare(`INSERT INTO cloud_documents(
    id, source_url, final_url, canonical_url, title, author, published_at, markdown, status, source_note, revision, created_at, updated_at
  ) SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, 'ready', 'Cloudflare Browser Run', 1, ?, ?
    WHERE EXISTS (SELECT 1 FROM cloud_capture_jobs WHERE id = ?)
      AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'data_epoch' AND value = ?)`).bind(
    message.id, url, url, url, title.slice(0, 1_000), markdown, now, now, message.id, message.epoch,
  ).run();
  if (changes(inserted) === 1) await env.DB.prepare("DELETE FROM cloud_capture_jobs WHERE id = ?").bind(message.id).run();
}

export async function handleCaptureQueue(batch: QueueBatch<CaptureMessage>, env: CaptureEnv) {
  for (const message of batch.messages) {
    try {
      await consume(message.body, env);
      message.ack();
    } catch (error) {
      const code = error instanceof CloudHttpError ? error.code : "BROWSER_FAILED";
      await env.DB.prepare("UPDATE cloud_capture_jobs SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ?")
        .bind(code, new Date().toISOString(), message.body.id).run();
      message.ack();
    }
  }
}
