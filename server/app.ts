import { createReadStream, existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import type { CaptureErrorCode, CaptureMode, CaptureStatus, KnowledgeDocument } from "../shared/types.js";
import { createAuth } from "./auth.js";
import { KnowledgeDatabase, openDatabase, type CaptureResult, type DocumentPatch } from "./db.js";

const gzipAsync = promisify(gzip);
const captureErrorCodes = new Set<CaptureErrorCode>([
  "INVALID_URL",
  "BLOCKED_ADDRESS",
  "FETCH_TIMEOUT",
  "RESPONSE_TOO_LARGE",
  "UNSUPPORTED_CONTENT_TYPE",
  "HTTP_ERROR",
  "EXTRACTION_EMPTY",
  "BROWSER_FAILED",
  "INTERNAL_ERROR",
]);
const statuses = new Set<CaptureStatus>(["queued", "fetching", "extracting", "ready", "failed"]);
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};
const contentSecurityPolicy = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: http: https:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "script-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

function securityHeaders() {
  return {
    "Content-Security-Policy": contentSecurityPolicy,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

export interface CapturedPage {
  title: string;
  author: string | null;
  publishedAt: string | null;
  finalUrl: string;
  canonicalUrl: string | null;
  markdown: string;
  mode: CaptureMode;
  warning: string | null;
  rawHtml: string;
  httpStatus: number | null;
}

export type CaptureFunction = (url: string) => Promise<CapturedPage>;

export interface AppOptions {
  dataDir: string;
  staticDir?: string;
  bootstrapToken?: string;
  sessionToken?: string;
  dev?: boolean;
  capture?: CaptureFunction;
  startWorker?: boolean;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders(),
  });
  response.end(JSON.stringify(value));
}

function sendError(response: ServerResponse, status: number, code: string, message: string, document?: unknown) {
  sendJson(response, status, { error: { code, message, ...(document ? { document } : {}) } });
}

function localHost(header: string | undefined) {
  if (!header) return false;
  try {
    const hostname = new URL(`http://${header}`).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}

function sameOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const expected = new URL(`http://${request.headers.host}`);
    return parsed.protocol === "http:" && parsed.origin === expected.origin;
  } catch {
    return false;
  }
}

function guardMutation(request: IncomingMessage) {
  if (!sameOrigin(request)) throw new HttpError(403, "ORIGIN_REJECTED", "Cross-origin mutations are not allowed");
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "JSON_REQUIRED", "Content-Type must be application/json");
  }
}

async function readJson(request: IncomingMessage) {
  const limit = 10 * 1024 * 1024;
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, "REQUEST_TOO_LARGE", "JSON body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, "REQUEST_TOO_LARGE", "JSON body is too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be a JSON object");
  }
}

function normalizeUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 8192) {
    throw new HttpError(400, "INVALID_URL", "A valid HTTP or HTTPS URL is required");
  }
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new Error("unsupported URL");
    }
    url.hash = "";
    return url.toString();
  } catch {
    throw new HttpError(400, "INVALID_URL", "A valid HTTP or HTTPS URL is required");
  }
}

function decodeId(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "INVALID_PATH", "Invalid document identifier");
  }
}

function documentPatch(body: Record<string, unknown>) {
  const revision = bodyRevision(body);
  const patch: DocumentPatch = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 1000) {
      throw new HttpError(400, "INVALID_TITLE", "title must be a non-empty string under 1000 characters");
    }
    patch.title = body.title.trim();
  }
  if (body.markdown !== undefined) {
    if (typeof body.markdown !== "string") {
      throw new HttpError(400, "INVALID_MARKDOWN", "markdown must be a string");
    }
    patch.markdown = body.markdown;
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 50) {
      throw new HttpError(400, "INVALID_TAGS", "tags must be an array with at most 50 items");
    }
    const unique = new Map<string, string>();
    for (const value of body.tags) {
      if (typeof value !== "string" || !value.trim() || value.trim().length > 100) {
        throw new HttpError(400, "INVALID_TAGS", "each tag must contain 1 to 100 characters");
      }
      const name = value.trim();
      unique.set(name.toLocaleLowerCase(), name);
    }
    patch.tags = [...unique.values()];
  }
  if (!Object.keys(patch).length) {
    throw new HttpError(400, "EMPTY_PATCH", "At least one editable field is required");
  }
  return { revision, patch };
}

function bodyRevision(body: Record<string, unknown>) {
  if (typeof body.revision !== "number" || !Number.isInteger(body.revision) || body.revision < 1) {
    throw new HttpError(400, "INVALID_REVISION", "revision must be a positive integer");
  }
  return body.revision;
}

function pathRevision(value: string) {
  const revision = Number(decodeId(value));
  if (!Number.isInteger(revision) || revision < 1) {
    throw new HttpError(400, "INVALID_REVISION", "revision must be a positive integer");
  }
  return revision;
}

function trashFilter(requestUrl: URL) {
  const trash = requestUrl.searchParams.get("trash") ?? undefined;
  if (trash && trash !== "only") throw new HttpError(400, "INVALID_TRASH_FILTER", "trash must be 'only'");
  return trash === "only" ? trash : undefined;
}

function captureFailure(error: unknown): { code: CaptureErrorCode; message: string } {
  const candidate = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const code = captureErrorCodes.has(candidate as CaptureErrorCode)
    ? (candidate as CaptureErrorCode)
    : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : "Capture failed";
  return { code, message: message.slice(0, 2000) || "Capture failed" };
}

function exportedMarkdown(document: KnowledgeDocument) {
  const frontMatter = [
    "---",
    `title: ${JSON.stringify(document.title)}`,
    `source: ${JSON.stringify(document.sourceUrl)}`,
    ...(document.finalUrl && document.finalUrl !== document.sourceUrl
      ? [`final_url: ${JSON.stringify(document.finalUrl)}`]
      : []),
    ...(document.canonicalUrl ? [`canonical_url: ${JSON.stringify(document.canonicalUrl)}`] : []),
    ...(document.author ? [`author: ${JSON.stringify(document.author)}`] : []),
    ...(document.publishedAt ? [`published_at: ${JSON.stringify(document.publishedAt)}`] : []),
    `captured_at: ${JSON.stringify(document.createdAt)}`,
    `tags: ${JSON.stringify(document.tags)}`,
    "---",
    "",
  ];
  return `${frontMatter.join("\n")}\n${document.markdown.trimEnd()}\n`;
}

function createWorker(db: KnowledgeDatabase, capture: CaptureFunction, enabled: boolean) {
  let stopped = !enabled;
  let current: Promise<void> | null = null;

  const run = async () => {
    while (!stopped) {
      const job = db.claimNextCapture();
      if (!job) return;
      try {
        const page = await capture(job.url);
        db.markExtracting(job, page.mode, page.httpStatus);
        let snapshotPath: string | null = null;
        if (page.rawHtml) {
          const filename = `${job.captureId}.html.gz`;
          snapshotPath = join("snapshots", filename);
          db.planCaptureSnapshot(job, snapshotPath);
          await writeFile(join(db.snapshotsDir, filename), await gzipAsync(page.rawHtml), { mode: 0o600 });
        }
        const previous = db.getDocument(job.documentId)!;
        const result: CaptureResult = {
          title: page.title.trim() || previous.title,
          author: page.author || null,
          publishedAt: page.publishedAt || null,
          finalUrl: page.finalUrl,
          canonicalUrl: page.canonicalUrl || null,
          markdown: page.markdown,
          mode: page.mode,
          warning: page.warning || null,
          httpStatus: page.httpStatus ?? null,
        };
        db.completeCapture(job, result, snapshotPath);
      } catch (error) {
        const failure = captureFailure(error);
        db.failCapture(job, failure.code, failure.message);
      }
    }
  };

  const wake = () => {
    if (stopped || current) return;
    current = run().finally(() => {
      current = null;
      if (!stopped && db.hasPendingCaptures()) queueMicrotask(wake);
    });
  };

  if (enabled) queueMicrotask(wake);
  return {
    wake,
    async stop() {
      stopped = true;
      await current;
    },
  };
}

function serveStatic(request: IncomingMessage, response: ServerResponse, pathname: string, staticDir?: string) {
  if (!staticDir || (request.method !== "GET" && request.method !== "HEAD")) return false;
  const root = resolve(staticDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "INVALID_PATH", "Invalid path");
  }
  const requested = resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
  const safe = requested === root || requested.startsWith(`${root}${sep}`);
  let file = safe && existsSync(requested) && statSync(requested).isFile() ? requested : join(root, "index.html");
  if (!file.startsWith(`${root}${sep}`) || !existsSync(file) || !statSync(file).isFile()) return false;
  response.writeHead(200, {
    "Content-Type": contentTypes[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-store",
    ...securityHeaders(),
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(file).on("error", (error) => response.destroy(error)).pipe(response);
  return true;
}

export function createApp(options: AppOptions) {
  const db = openDatabase(options.dataDir);
  const auth = createAuth({
    bootstrapToken: options.bootstrapToken ?? process.env.KB_BOOTSTRAP_TOKEN,
    sessionToken: options.sessionToken,
    dev: options.dev,
  });
  const capture: CaptureFunction =
    options.capture ?? (async (url) => (await import("./capture.js")).captureUrl(url));
  const worker = createWorker(db, capture, options.startWorker !== false);

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (!localHost(request.headers.host)) {
        sendError(response, 400, "INVALID_HOST", "Only localhost requests are accepted");
        return;
      }
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const { pathname } = requestUrl;

      if (request.method === "GET" && pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && pathname === "/launch") {
        auth.launch(requestUrl, response);
        return;
      }
      if (pathname.startsWith("/api/") && !auth.isAuthenticated(request)) {
        sendError(response, 401, "UNAUTHORIZED", "Authentication required");
        return;
      }

      if (pathname === "/api/documents" && request.method === "POST") {
        guardMutation(request);
        const body = await readJson(request);
        const result = db.createOrGetDocument(normalizeUrl(body.url));
        if (result.created) worker.wake();
        sendJson(response, result.created ? 202 : 200, result.document);
        return;
      }

      if (pathname === "/api/documents" && request.method === "GET") {
        const statusValue = requestUrl.searchParams.get("status") ?? undefined;
        if (statusValue && !statuses.has(statusValue as CaptureStatus)) {
          throw new HttpError(400, "INVALID_STATUS", "Unknown capture status");
        }
        const q = requestUrl.searchParams.get("q") ?? undefined;
        if (q && q.length > 500) throw new HttpError(400, "INVALID_QUERY", "Search query is too long");
        const requestedPage = Number(requestUrl.searchParams.get("page") ?? 1);
        sendJson(
          response,
          200,
          db.listDocuments({
            q,
            tag: requestUrl.searchParams.get("tag") ?? undefined,
            status: statusValue as CaptureStatus | undefined,
            page: Number.isFinite(requestedPage) ? requestedPage : 1,
            trash: trashFilter(requestUrl),
          }),
        );
        return;
      }

      if (pathname === "/api/tags" && request.method === "GET") {
        sendJson(response, 200, db.listTags(trashFilter(requestUrl)));
        return;
      }

      const revisionRestoreMatch = pathname.match(
        /^\/api\/documents\/([^/]+)\/revisions\/([^/]+)\/restore$/u,
      );
      if (request.method === "POST" && revisionRestoreMatch) {
        guardMutation(request);
        const currentRevision = bodyRevision(await readJson(request));
        const result = db.restoreDocumentRevision(
          decodeId(revisionRestoreMatch[1]),
          pathRevision(revisionRestoreMatch[2]),
          currentRevision,
        );
        if (result.kind === "missing") throw new HttpError(404, "NOT_FOUND", "Document not found");
        if (result.kind === "revision_missing") {
          throw new HttpError(404, "REVISION_NOT_FOUND", "Document revision not found");
        }
        if (result.kind === "deleted") {
          sendError(response, 409, "DOCUMENT_DELETED", "Restore the document before changing it", result.document);
          return;
        }
        if (result.kind === "conflict") {
          sendError(response, 409, "REVISION_CONFLICT", "Document changed since it was loaded", result.document);
          return;
        }
        sendJson(response, 200, result.document);
        return;
      }

      const revisionsMatch = pathname.match(/^\/api\/documents\/([^/]+)\/revisions$/u);
      if (request.method === "GET" && revisionsMatch) {
        const revisions = db.listDocumentRevisions(decodeId(revisionsMatch[1]));
        if (!revisions) throw new HttpError(404, "NOT_FOUND", "Document not found");
        sendJson(response, 200, revisions);
        return;
      }

      const restoreMatch = pathname.match(/^\/api\/documents\/([^/]+)\/restore$/u);
      if (request.method === "POST" && restoreMatch) {
        guardMutation(request);
        await readJson(request);
        const result = db.restoreDocument(decodeId(restoreMatch[1]));
        if (result.kind === "missing") throw new HttpError(404, "NOT_FOUND", "Document not found");
        if (result.kind === "not_deleted") {
          sendError(response, 409, "NOT_IN_TRASH", "Document is not in the trash", result.document);
          return;
        }
        worker.wake();
        sendJson(response, 200, result.document);
        return;
      }

      const permanentMatch = pathname.match(/^\/api\/documents\/([^/]+)\/permanent$/u);
      if (request.method === "DELETE" && permanentMatch) {
        guardMutation(request);
        const revision = bodyRevision(await readJson(request));
        const result = db.permanentlyDeleteDocument(decodeId(permanentMatch[1]), revision);
        if (result.kind === "missing") throw new HttpError(404, "NOT_FOUND", "Document not found");
        if (result.kind === "not_deleted") {
          sendError(response, 409, "NOT_IN_TRASH", "Document must be in the trash before permanent deletion", result.document);
          return;
        }
        if (result.kind === "capture_running") {
          sendError(response, 409, "CAPTURE_IN_PROGRESS", "Wait for the active capture to finish", result.document);
          return;
        }
        if (result.kind === "conflict") {
          sendError(response, 409, "REVISION_CONFLICT", "Document changed since it was loaded", result.document);
          return;
        }
        if (result.kind === "snapshot_failed") {
          throw new HttpError(500, "SNAPSHOT_DELETE_FAILED", "Snapshot files could not be deleted");
        }
        response.writeHead(204, { "Cache-Control": "no-store", ...securityHeaders() });
        response.end();
        return;
      }

      const exportMatch = pathname.match(/^\/api\/documents\/([^/]+)\/export\.md$/u);
      if (request.method === "GET" && exportMatch) {
        const document = db.getDocument(decodeId(exportMatch[1]));
        if (!document) throw new HttpError(404, "NOT_FOUND", "Document not found");
        const filename = encodeURIComponent(Buffer.from((document.title || document.id).slice(0, 150)).toString("utf8"));
        response.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${filename}.md`,
          "Cache-Control": "no-store",
          ...securityHeaders(),
        });
        response.end(exportedMarkdown(document));
        return;
      }

      const retryMatch = pathname.match(/^\/api\/documents\/([^/]+)\/retry$/u);
      if (request.method === "POST" && retryMatch) {
        guardMutation(request);
        await readJson(request);
        const result = db.retryDocument(decodeId(retryMatch[1]));
        if (result.kind === "missing") throw new HttpError(404, "NOT_FOUND", "Document not found");
        if (result.kind === "deleted") {
          sendError(response, 409, "DOCUMENT_DELETED", "Restore the document before retrying", result.document);
          return;
        }
        if (result.kind === "not_failed") {
          sendError(response, 409, "NOT_FAILED", "Only failed captures can be retried", result.document);
          return;
        }
        worker.wake();
        sendJson(response, 202, result.document);
        return;
      }

      const documentMatch = pathname.match(/^\/api\/documents\/([^/]+)$/u);
      if (documentMatch && request.method === "GET") {
        const document = db.getDocument(decodeId(documentMatch[1]));
        if (!document) throw new HttpError(404, "NOT_FOUND", "Document not found");
        sendJson(response, 200, document);
        return;
      }
      if (documentMatch && request.method === "PATCH") {
        guardMutation(request);
        const { revision, patch } = documentPatch(await readJson(request));
        const result = db.updateDocument(decodeId(documentMatch[1]), revision, patch);
        if (result.kind === "missing") throw new HttpError(404, "NOT_FOUND", "Document not found");
        if (result.kind === "deleted") {
          sendError(response, 409, "DOCUMENT_DELETED", "Restore the document before changing it", result.document);
          return;
        }
        if (result.kind === "conflict") {
          sendError(response, 409, "REVISION_CONFLICT", "Document changed since it was loaded", result.document);
          return;
        }
        sendJson(response, 200, result.document);
        return;
      }
      if (documentMatch && request.method === "DELETE") {
        guardMutation(request);
        await readJson(request);
        const result = db.softDeleteDocument(decodeId(documentMatch[1]));
        if (result.kind === "missing") throw new HttpError(404, "NOT_FOUND", "Document not found");
        if (result.kind === "already_deleted") {
          sendError(response, 409, "ALREADY_IN_TRASH", "Document is already in the trash", result.document);
          return;
        }
        sendJson(response, 200, result.document);
        return;
      }

      if (pathname.startsWith("/api/")) {
        throw new HttpError(404, "NOT_FOUND", "API endpoint not found");
      }
      if (serveStatic(request, response, pathname, options.staticDir)) return;
      throw new HttpError(404, "NOT_FOUND", "Not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (error instanceof HttpError) sendError(response, error.status, error.code, error.message);
      else {
        console.error(error);
        sendError(response, 500, "INTERNAL_ERROR", "Internal server error");
      }
    }
  };

  let closed = false;
  return {
    handler,
    db,
    bootstrapToken: auth.bootstrapToken,
    async close() {
      if (closed) return;
      closed = true;
      await worker.stop();
      db.close();
    },
  };
}
