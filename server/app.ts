import { randomUUID } from "node:crypto";
import { closeSync, constants, createReadStream, existsSync, fsyncSync, openSync, statSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import type {
  BatchDocumentAction,
  BatchDocumentsRequest,
  CaptureErrorCode,
  CaptureMode,
  CaptureStatus,
  DataSafetyStatus,
  DocumentFilters,
  DocumentSearchScope,
  DocumentSort,
  KnowledgeDocument,
  ImportKind,
  ImportStrategy,
  RecentFilter,
} from "../shared/types.js";
import { cacheDocumentAssets, type AssetFetchFunction } from "./assets.js";
import { createAuth } from "./auth.js";
import { BackupError, recoverInterruptedRestore, restoreBackup } from "./backup.js";
import {
  cleanupOrphanSnapshots,
  createRecordedBackup,
  DataSafetyError,
  dataSafetyHealth,
  defaultBackupRoot,
  errorDetails,
  listRecoveryBackups,
  pruneAutomaticBackups,
  reconcileBackupRecords,
  resolveBackupRecord,
  verifyBackupRecord,
} from "./data-safety.js";
import {
  CURRENT_SCHEMA_VERSION,
  KnowledgeDatabase,
  migrateDatabase,
  openDatabase,
  type CaptureResult,
  type DocumentPatch,
} from "./db.js";
import { extractHtml } from "./extract.js";
import { ImportParseError, parseImportRequest } from "./import.js";
import {
  createPortableBundle,
  PortableError,
  promotePortableAssets,
  stagePortableBundle,
} from "./portable.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_COMPRESSED_SNAPSHOT_BYTES = 6 * 1024 * 1024;
const DATA_EPOCH_HEADER = "X-Zhiye-Data-Epoch";
const JSON_MUTATION_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const captureErrorCodes = new Set<CaptureErrorCode>([
  "INVALID_URL",
  "BLOCKED_ADDRESS",
  "FETCH_TIMEOUT",
  "RESPONSE_TOO_LARGE",
  "UNSUPPORTED_CONTENT_TYPE",
  "HTTP_ERROR",
  "EXTRACTION_EMPTY",
  "BROWSER_FAILED",
  "CAPTURE_CANCELLED",
  "INTERNAL_ERROR",
]);
const statuses = new Set<CaptureStatus>(["queued", "fetching", "extracting", "ready", "failed"]);
const captureModes = new Set<CaptureMode>(["http", "browser"]);
const searchScopes = new Set<DocumentSearchScope>(["all", "title", "body", "source"]);
const documentSorts = new Set<DocumentSort>(["updated", "created", "title"]);
const importKinds = new Set<ImportKind>(["urls", "bookmarks", "markdown"]);
const importStrategies = new Set<ImportStrategy>(["skip", "copy", "update"]);
const documentFilterKeys = new Set([
  "q", "scope", "tag", "collectionId", "status", "favorite", "archived", "unorganized",
  "from", "to", "captureMode", "sort", "page", "trash",
]);
const batchActions = new Set<BatchDocumentAction>([
  "add-tag",
  "remove-tag",
  "add-collection",
  "remove-collection",
  "archive",
  "unarchive",
  "trash",
  "restore",
]);
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
  "img-src 'self' data:",
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
  extractorVersion?: string;
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
  database: KnowledgeDatabase | null;
  recoveryError?: unknown;
  backupRoot?: string;
  staticDir?: string;
  bootstrapToken?: string;
  sessionToken?: string;
  dev?: boolean;
  capture?: CaptureFunction;
  fetchAsset?: AssetFetchFunction;
  startWorker?: boolean;
  onDesktopCloseReady?: (attemptId: string) => void;
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

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  document?: unknown,
  draft?: unknown,
) {
  sendJson(response, status, {
    error: {
      code,
      message,
      ...(document !== undefined ? { document } : {}),
      ...(draft !== undefined ? { draft } : {}),
    },
  });
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

async function readBinary(request: IncomingMessage, limit: number) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, "REQUEST_TOO_LARGE", "Request body is too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, "REQUEST_TOO_LARGE", "Request body is too large");
    chunks.push(buffer);
  }
  if (!size) throw new HttpError(400, "EMPTY_ZIP", "ZIP request body is empty");
  return Buffer.concat(chunks);
}

function operationAbort(request: IncomingMessage, response: ServerResponse) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const close = () => { if (!response.writableEnded) cancel(); };
  if (request.aborted || response.destroyed) cancel();
  request.once("aborted", cancel);
  response.once("close", close);
  return {
    signal: controller.signal,
    dispose() {
      request.off("aborted", cancel);
      response.off("close", close);
    },
  };
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
  const allowed = new Set([
    "revision",
    "title",
    "markdown",
    "tags",
    "author",
    "publishedAt",
    "sourceNote",
    "favorite",
    "archived",
    "collectionIds",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new HttpError(400, "INVALID_DOCUMENT_PATCH", "Document patch contains an unknown field");
  }
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
    patch.tags = tagsValue(body.tags);
  }
  if (body.author !== undefined) {
    patch.author = nullableText(body.author, "author", 1000);
  }
  if (body.publishedAt !== undefined) {
    patch.publishedAt = publishedDate(body.publishedAt);
  }
  if (body.sourceNote !== undefined) {
    if (typeof body.sourceNote !== "string" || body.sourceNote.length > 50_000) {
      throw new HttpError(400, "INVALID_SOURCE_NOTE", "sourceNote must be a string under 50000 characters");
    }
    patch.sourceNote = body.sourceNote;
  }
  if (body.favorite !== undefined) {
    if (typeof body.favorite !== "boolean") {
      throw new HttpError(400, "INVALID_FAVORITE", "favorite must be boolean");
    }
    patch.favorite = body.favorite;
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") {
      throw new HttpError(400, "INVALID_ARCHIVED", "archived must be boolean");
    }
    patch.archived = body.archived;
  }
  if (body.collectionIds !== undefined) {
    patch.collectionIds = collectionIdsValue(body.collectionIds);
  }
  if (!Object.keys(patch).length) {
    throw new HttpError(400, "EMPTY_PATCH", "At least one editable field is required");
  }
  return { revision, patch };
}

function nullableText(value: unknown, field: string, maxLength: number) {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    const code = field.replace(/[A-Z]/gu, (letter) => `_${letter}`).toUpperCase();
    throw new HttpError(400, `INVALID_${code}`, `${field} must be null or a non-empty string under ${maxLength} characters`);
  }
  return value.trim();
}

function publishedDate(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_PUBLISHED_AT", "publishedAt must be null or a YYYY-MM-DD date");
  }
  const date = value.trim();
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, "INVALID_PUBLISHED_AT", "publishedAt must be null or a real YYYY-MM-DD date");
  }
  return date;
}

function collectionIdsValue(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, "INVALID_COLLECTION_IDS", "collectionIds must be an array with at most 100 items");
  }
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item || item.length > 200 || item !== item.trim()) {
      throw new HttpError(400, "INVALID_COLLECTION_IDS", "each collection ID must contain 1 to 200 characters");
    }
    unique.add(item);
  }
  return [...unique];
}

function collectionName(body: Record<string, unknown>) {
  if (Object.keys(body).some((key) => key !== "name")) {
    throw new HttpError(400, "INVALID_COLLECTION", "name must be the only field");
  }
  if (typeof body.name !== "string") {
    throw new HttpError(400, "INVALID_COLLECTION_NAME", "name must contain 1 to 100 characters");
  }
  const name = body.name.normalize("NFKC").trim();
  if (!name || name.length > 100) {
    throw new HttpError(400, "INVALID_COLLECTION_NAME", "name must contain 1 to 100 characters");
  }
  return name;
}

function tagsValue(value: unknown) {
  if (!Array.isArray(value) || value.length > 50) {
    throw new HttpError(400, "INVALID_TAGS", "tags must be an array with at most 50 items");
  }
  const unique = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== "string") {
      throw new HttpError(400, "INVALID_TAGS", "each tag must contain 1 to 100 characters");
    }
    const name = item.normalize("NFKC").trim();
    if (!name || name.length > 100) {
      throw new HttpError(400, "INVALID_TAGS", "each tag must contain 1 to 100 characters");
    }
    unique.set(name.toLocaleLowerCase(), name);
  }
  return [...unique.values()];
}

function documentDraft(body: Record<string, unknown>) {
  const expectedDraftRevision = draftRevision(body.expectedDraftRevision, true);
  const baseRevision = bodyRevision({ revision: body.baseRevision });
  if (typeof body.title !== "string" || body.title.length > 1000) {
    throw new HttpError(400, "INVALID_TITLE", "title must be a string under 1000 characters");
  }
  if (typeof body.markdown !== "string") {
    throw new HttpError(400, "INVALID_MARKDOWN", "markdown must be a string");
  }
  return {
    expectedDraftRevision,
    baseRevision,
    title: body.title.trim(),
    markdown: body.markdown,
    tags: tagsValue(body.tags),
  };
}

function bodyRevision(body: Record<string, unknown>) {
  if (typeof body.revision !== "number" || !Number.isInteger(body.revision) || body.revision < 1) {
    throw new HttpError(400, "INVALID_REVISION", "revision must be a positive integer");
  }
  return body.revision;
}

function draftRevision(value: unknown, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HttpError(400, "INVALID_DRAFT_REVISION", "draftRevision must be a positive integer");
  }
  return value;
}

function closeAttemptId(value: unknown) {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/u.test(value)) {
    throw new HttpError(400, "INVALID_CLOSE_ATTEMPT", "attemptId must be a positive integer string");
  }
  return value;
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

function tagNameValue(value: unknown) {
  return tagsValue([value])[0]!;
}

function tagName(body: Record<string, unknown>, field: "name" | "target") {
  if (Object.keys(body).some((key) => key !== field)) {
    throw new HttpError(400, "INVALID_TAG", `${field} must be the only field`);
  }
  return tagNameValue(body[field]);
}

function strictBoolean(value: string | null, field: string) {
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HttpError(400, "INVALID_FILTER", `${field} must be true or false`);
}

function filterDate(value: string | null, field: "from" | "to") {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    const parsed = Date.parse(`${trimmed}T00:00:00.000Z`);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== trimmed) {
      throw new HttpError(400, "INVALID_DATE_FILTER", `${field} must be a real date or ISO timestamp`);
    }
    return field === "from"
      ? `${trimmed}T00:00:00.000Z`
      : new Date(parsed + 24 * 60 * 60 * 1000).toISOString();
  }
  const parsed = Date.parse(trimmed);
  if (!trimmed || trimmed.length > 50 || !Number.isFinite(parsed)) {
    throw new HttpError(400, "INVALID_DATE_FILTER", `${field} must be a real date or ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function documentFilters(requestUrl: URL): DocumentFilters {
  for (const key of requestUrl.searchParams.keys()) {
    if (!documentFilterKeys.has(key)) throw new HttpError(400, "INVALID_FILTER", `Unknown document filter: ${key}`);
    if (requestUrl.searchParams.getAll(key).length !== 1) {
      throw new HttpError(400, "INVALID_FILTER", `Document filter may only appear once: ${key}`);
    }
  }

  const q = requestUrl.searchParams.get("q")?.trim() || undefined;
  if (q && q.length > 500) throw new HttpError(400, "INVALID_QUERY", "Search query is too long");
  const scopeValue = requestUrl.searchParams.get("scope") ?? undefined;
  if (scopeValue && !searchScopes.has(scopeValue as DocumentSearchScope)) {
    throw new HttpError(400, "INVALID_FILTER", "Unknown search scope");
  }
  const tagValue = requestUrl.searchParams.get("tag");
  const tag = tagValue === null ? undefined : tagNameValue(tagValue);
  const collectionIdValue = requestUrl.searchParams.get("collectionId");
  const collectionId = collectionIdValue === null ? undefined : collectionIdsValue([collectionIdValue])[0];
  const statusValue = requestUrl.searchParams.get("status") ?? undefined;
  if (statusValue && !statuses.has(statusValue as CaptureStatus)) {
    throw new HttpError(400, "INVALID_STATUS", "Unknown capture status");
  }
  const captureModeValue = requestUrl.searchParams.get("captureMode") ?? undefined;
  if (captureModeValue && !captureModes.has(captureModeValue as CaptureMode)) {
    throw new HttpError(400, "INVALID_FILTER", "Unknown capture mode");
  }
  const sortValue = requestUrl.searchParams.get("sort") ?? undefined;
  if (sortValue && !documentSorts.has(sortValue as DocumentSort)) {
    throw new HttpError(400, "INVALID_FILTER", "Unknown document sort");
  }
  const pageValue = requestUrl.searchParams.get("page");
  const page = pageValue === null ? 1 : Number(pageValue);
  if (!Number.isInteger(page) || page < 1 || page > 1_000_000) {
    throw new HttpError(400, "INVALID_PAGE", "page must be an integer from 1 to 1000000");
  }
  const from = filterDate(requestUrl.searchParams.get("from"), "from");
  const to = filterDate(requestUrl.searchParams.get("to"), "to");
  if (from && to && from > to) throw new HttpError(400, "INVALID_DATE_FILTER", "from must not be after to");
  return {
    q,
    scope: scopeValue as DocumentSearchScope | undefined,
    tag,
    collectionId,
    status: statusValue as CaptureStatus | undefined,
    favorite: strictBoolean(requestUrl.searchParams.get("favorite"), "favorite"),
    archived: strictBoolean(requestUrl.searchParams.get("archived"), "archived"),
    unorganized: strictBoolean(requestUrl.searchParams.get("unorganized"), "unorganized"),
    from,
    to,
    captureMode: captureModeValue as CaptureMode | undefined,
    sort: sortValue as DocumentSort | undefined,
    page,
    trash: trashFilter(requestUrl),
  };
}

function recentFiltersValue(body: Record<string, unknown>) {
  if (Object.keys(body).some((key) => key !== "filters" && key !== "revision") || !Array.isArray(body.filters) || body.filters.length > 5) {
    throw new HttpError(400, "INVALID_RECENT_FILTERS", "filters must be an array with at most 5 items");
  }
  return body.filters.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpError(400, "INVALID_RECENT_FILTERS", "each recent filter must be an object");
    }
    const input = value as Record<string, unknown>;
    const required = [
      "label", "query", "scope", "tag", "collectionId", "status", "unorganized", "captureMode", "from", "to", "sort",
    ];
    const allowed = new Set([...required, "favorite", "archived"]);
    if (required.some((key) => !(key in input)) || Object.keys(input).some((key) => !allowed.has(key))) {
      throw new HttpError(400, "INVALID_RECENT_FILTERS", "recent filter contains an unknown field");
    }
    if (typeof input.label !== "string") {
      throw new HttpError(400, "INVALID_RECENT_FILTERS", "label must contain 1 to 100 characters");
    }
    const label = input.label.normalize("NFKC").trim();
    if (!label || label.length > 100) {
      throw new HttpError(400, "INVALID_RECENT_FILTERS", "label must contain 1 to 100 characters");
    }
    if (typeof input.query !== "string" || input.query.length > 500) {
      throw new HttpError(400, "INVALID_RECENT_FILTERS", "query must be a string under 500 characters");
    }
    if (typeof input.scope !== "string" || !searchScopes.has(input.scope as DocumentSearchScope)) {
      throw new HttpError(400, "INVALID_RECENT_FILTERS", "Unknown search scope");
    }
    if (typeof input.tag !== "string" || input.tag.length > 100) {
      throw new HttpError(400, "INVALID_RECENT_FILTERS", "tag must be empty or contain at most 100 characters");
    }
    const tag = input.tag ? tagNameValue(input.tag) : "";
    if (typeof input.collectionId !== "string" || input.collectionId.length > 200) {
      throw new HttpError(400, "INVALID_RECENT_FILTERS", "collectionId must be empty or contain at most 200 characters");
    }
    const collectionId = input.collectionId ? collectionIdsValue([input.collectionId])[0]! : "";
    if (typeof input.status !== "string" || (input.status !== "" && !statuses.has(input.status as CaptureStatus))) {
      throw new HttpError(400, "INVALID_RECENT_FILTERS", "Unknown capture status");
    }
    if (typeof input.unorganized !== "boolean") {
      throw new HttpError(400, "INVALID_RECENT_FILTERS", "unorganized must be boolean");
    }
    const optional: Pick<RecentFilter, "favorite" | "archived"> = {};
    for (const field of ["favorite", "archived"] as const) {
      if (input[field] === undefined) continue;
      if (typeof input[field] !== "boolean") {
        throw new HttpError(400, "INVALID_RECENT_FILTERS", `${field} must be boolean`);
      }
      optional[field] = input[field];
    }
    if (
      typeof input.captureMode !== "string" ||
      (input.captureMode !== "" && !captureModes.has(input.captureMode as CaptureMode))
    ) {
      throw new HttpError(400, "INVALID_RECENT_FILTERS", "Unknown capture mode");
    }
    if (typeof input.from !== "string" || typeof input.to !== "string") {
      throw new HttpError(400, "INVALID_RECENT_FILTERS", "from and to must be dates or empty strings");
    }
    const normalizedFrom = input.from ? filterDate(input.from, "from") : undefined;
    const normalizedTo = input.to ? filterDate(input.to, "to") : undefined;
    if (normalizedFrom && normalizedTo && normalizedFrom > normalizedTo) {
      throw new HttpError(400, "INVALID_RECENT_FILTERS", "from must not be after to");
    }
    if (typeof input.sort !== "string" || !documentSorts.has(input.sort as DocumentSort)) {
      throw new HttpError(400, "INVALID_RECENT_FILTERS", "Unknown document sort");
    }
    return {
      label,
      query: input.query.trim(),
      scope: input.scope as DocumentSearchScope,
      tag,
      collectionId,
      status: input.status as CaptureStatus | "",
      ...optional,
      unorganized: input.unorganized,
      captureMode: input.captureMode as CaptureMode | "",
      from: input.from.trim(),
      to: input.to.trim(),
      sort: input.sort as DocumentSort,
    } satisfies RecentFilter;
  });
}

function batchDocumentsRequest(body: Record<string, unknown>): BatchDocumentsRequest {
  if (Object.keys(body).some((key) => key !== "documents" && key !== "action" && key !== "value")) {
    throw new HttpError(400, "INVALID_BATCH", "Batch request contains an unknown field");
  }
  if (!Array.isArray(body.documents) || body.documents.length < 1 || body.documents.length > 30) {
    throw new HttpError(400, "INVALID_BATCH", "documents must contain 1 to 30 current-page items");
  }
  const seen = new Set<string>();
  const documents = body.documents.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, "INVALID_BATCH", "each document target must contain id and revision");
    }
    const target = item as Record<string, unknown>;
    if (Object.keys(target).some((key) => key !== "id" && key !== "revision")) {
      throw new HttpError(400, "INVALID_BATCH", "document target contains an unknown field");
    }
    if (typeof target.id !== "string" || !target.id || target.id.length > 200 || target.id !== target.id.trim()) {
      throw new HttpError(400, "INVALID_BATCH", "document id must contain 1 to 200 characters");
    }
    if (seen.has(target.id)) throw new HttpError(400, "INVALID_BATCH", "document ids must be unique");
    seen.add(target.id);
    return { id: target.id, revision: bodyRevision({ revision: target.revision }) };
  });
  if (typeof body.action !== "string" || !batchActions.has(body.action as BatchDocumentAction)) {
    throw new HttpError(400, "INVALID_BATCH", "Unknown batch action");
  }
  const action = body.action as BatchDocumentAction;
  const needsValue = action === "add-tag" || action === "remove-tag" ||
    action === "add-collection" || action === "remove-collection";
  if (!needsValue && body.value !== undefined) {
    throw new HttpError(400, "INVALID_BATCH", "This batch action does not accept value");
  }
  let value: string | undefined;
  if (action === "add-tag" || action === "remove-tag") value = tagNameValue(body.value);
  if (action === "add-collection" || action === "remove-collection") {
    value = collectionIdsValue([body.value])[0];
  }
  return { documents, action, ...(value === undefined ? {} : { value }) };
}

function captureFailure(error: unknown): { code: CaptureErrorCode; message: string } {
  const candidate = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const code = captureErrorCodes.has(candidate as CaptureErrorCode)
    ? (candidate as CaptureErrorCode)
    : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : "Capture failed";
  return { code, message: message.slice(0, 2000) || "Capture failed" };
}

async function readSnapshotHtml(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(409, "SNAPSHOT_MISSING", "The HTML snapshot file is missing");
    }
    throw new HttpError(422, "SNAPSHOT_INVALID", "The HTML snapshot cannot be opened safely");
  });
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_COMPRESSED_SNAPSHOT_BYTES) {
      throw new HttpError(422, "SNAPSHOT_INVALID", "The HTML snapshot is invalid or too large");
    }
    const html = await gunzipAsync(await file.readFile(), { maxOutputLength: MAX_HTML_BYTES });
    return html.toString("utf8");
  } catch (cause) {
    if (cause instanceof HttpError) throw cause;
    throw new HttpError(422, "SNAPSHOT_INVALID", "The HTML snapshot is corrupt or exceeds 5 MiB");
  } finally {
    await file.close();
  }
}

async function serveAsset(
  request: IncomingMessage,
  response: ServerResponse,
  database: KnowledgeDatabase,
  hash: string,
) {
  if (!/^[a-f0-9]{64}$/u.test(hash)) {
    throw new HttpError(400, "INVALID_ASSET_HASH", "Asset hash must be 64 lowercase hexadecimal characters");
  }
  const asset = database.getAsset(hash);
  if (!asset) throw new HttpError(404, "ASSET_NOT_FOUND", "Cached asset not found");
  const file = await open(database.assetFilePath(hash), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HttpError(404, "ASSET_MISSING", "Cached asset file is missing");
      }
      throw new HttpError(422, "ASSET_INVALID", "Cached asset cannot be opened safely");
    },
  );
  const etag = `"${hash}"`;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== asset.byteSize) {
      throw new HttpError(422, "ASSET_INVALID", "Cached asset does not match its database record");
    }
    const headers = {
      "Content-Type": asset.mimeType,
      "Content-Length": String(asset.byteSize),
      "Cache-Control": "private, max-age=31536000, immutable",
      "Cross-Origin-Resource-Policy": "same-origin",
      ETag: etag,
      ...securityHeaders(),
    };
    if (request.headers["if-none-match"] === etag) {
      await file.close();
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, headers);
    if (request.method === "HEAD") {
      await file.close();
      response.end();
      return;
    }
    file.createReadStream({ autoClose: true })
      .on("error", (error) => response.destroy(error))
      .pipe(response);
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
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
    `collections: ${JSON.stringify(document.collections.map(({ name }) => name))}`,
    `favorite: ${JSON.stringify(document.favorite)}`,
    `archived_at: ${JSON.stringify(document.archivedAt)}`,
    `source_note: ${JSON.stringify(document.sourceNote)}`,
    "---",
    "",
  ];
  return `${frontMatter.join("\n")}\n${document.markdown.trimEnd()}\n`;
}

function createWorker(
  getDb: () => KnowledgeDatabase | null,
  capture: CaptureFunction,
  fetchAsset: AssetFetchFunction | undefined,
  enabled: boolean,
) {
  let userPaused = !enabled;
  let maintenancePaused = false;
  let stopped = false;
  let current: Promise<void> | null = null;
  const paused = () => userPaused || maintenancePaused;

  const run = async () => {
    while (!paused() && !stopped) {
      const db = getDb();
      if (!db) return;
      const job = db.claimNextCapture();
      if (!job) return;
      try {
        const page = await capture(job.url);
        db.markExtracting(job, page.mode, page.httpStatus);
        let snapshotPath: string | null = null;
        if (page.rawHtml) {
          const filename = `${job.captureId}.html.gz`;
          snapshotPath = join("snapshots", filename);
          await writeFile(join(db.snapshotsDir, filename), await gzipAsync(page.rawHtml), {
            mode: 0o600,
            flag: "wx",
            flush: true,
          });
          const snapshotsDescriptor = openSync(db.snapshotsDir, "r");
          try {
            fsyncSync(snapshotsDescriptor);
          } finally {
            closeSync(snapshotsDescriptor);
          }
          db.planCaptureSnapshot(job, snapshotPath);
        }
        const previous = db.getDocument(job.documentId)!;
        const result: CaptureResult = {
          extractorVersion: page.extractorVersion,
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
        const document = db.completeCapture(job, result, snapshotPath);
        try {
          await cacheDocumentAssets(
            db,
            document.id,
            document.markdown,
            document.finalUrl ?? document.sourceUrl,
            fetchAsset,
          );
        } catch (error) {
          console.error("Image caching failed after capture completed", error);
        }
      } catch (error) {
        const failure = captureFailure(error);
        db.failCapture(job, failure.code, failure.message);
      }
    }
  };

  const wake = () => {
    if (paused() || stopped || current) return;
    current = run().finally(() => {
      current = null;
      if (!paused() && !stopped && getDb()?.hasPendingCaptures()) queueMicrotask(wake);
    });
  };

  if (enabled) queueMicrotask(wake);
  return {
    wake,
    isPaused() {
      return userPaused;
    },
    setPaused(value: boolean) {
      if (stopped || !enabled) return;
      userPaused = value;
      if (!paused()) wake();
    },
    async pause() {
      maintenancePaused = true;
      await current;
    },
    resume() {
      if (stopped || !enabled) return;
      maintenancePaused = false;
      if (!paused()) wake();
    },
    async stop() {
      maintenancePaused = true;
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
  let db = options.database;
  let dataEpoch = randomUUID();
  let recoveryError: unknown = options.recoveryError ?? null;
  const backupRoot = options.backupRoot ?? defaultBackupRoot(options.dataDir);
  const auth = createAuth({
    bootstrapToken: options.bootstrapToken ?? process.env.KB_BOOTSTRAP_TOKEN,
    sessionToken: options.sessionToken,
    dev: options.dev,
  });
  const capture: CaptureFunction =
    options.capture ?? (async (url) => (await import("./capture.js")).captureUrl(url));
  let worker = createWorker(
    () => db,
    capture,
    options.fetchAsset,
    options.startWorker !== false && db !== null,
  );
  let maintenanceKind: string | null = null;
  let maintenanceDone: Promise<void> | null = null;
  let finishMaintenance: (() => void) | null = null;

  const requireDatabase = () => {
    if (maintenanceKind) {
      throw new HttpError(503, "MAINTENANCE", `Data maintenance is in progress: ${maintenanceKind}`);
    }
    if (!db) throw new HttpError(503, "DATA_UNAVAILABLE", "Knowledge-base data needs recovery");
    return db;
  };

  function assertDataEpoch(
    enteringEpoch: string | string[] | null | undefined,
  ): asserts enteringEpoch is string {
    if (enteringEpoch !== dataEpoch) {
      throw new HttpError(409, "STALE_DATA_EPOCH", "Knowledge-base data was restored; reload before writing");
    }
  }

  const guardDataMutation = (request: IncomingMessage) => {
    guardMutation(request);
    const enteringEpoch = request.headers[DATA_EPOCH_HEADER.toLowerCase()];
    assertDataEpoch(enteringEpoch);
    return enteringEpoch;
  };

  const guardBundleMutation = (request: IncomingMessage) => {
    if (!sameOrigin(request)) throw new HttpError(403, "ORIGIN_REJECTED", "Cross-origin mutations are not allowed");
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/zip") {
      throw new HttpError(415, "ZIP_REQUIRED", "Content-Type must be application/zip");
    }
    const enteringEpoch = request.headers[DATA_EPOCH_HEADER.toLowerCase()];
    assertDataEpoch(enteringEpoch);
    return enteringEpoch;
  };

  const mutationBody = async (request: IncomingMessage) => {
    const enteringEpoch = request.headers[DATA_EPOCH_HEADER.toLowerCase()];
    const body = await readJson(request);
    assertDataEpoch(enteringEpoch);
    requireDatabase();
    return body;
  };

  const queueStatus = () => ({ paused: worker.isPaused(), ...requireDatabase().getCaptureQueueCounts() });

  const runMaintenance = async <T,>(kind: string, operation: () => Promise<T>) => {
    if (maintenanceKind) throw new HttpError(503, "MAINTENANCE", "Another data operation is in progress");
    maintenanceKind = kind;
    maintenanceDone = new Promise<void>((resolveDone) => {
      finishMaintenance = resolveDone;
    });
    try {
      return await operation();
    } finally {
      maintenanceKind = null;
      finishMaintenance?.();
      finishMaintenance = null;
      maintenanceDone = null;
    }
  };

  const status = async (): Promise<DataSafetyStatus> => {
    if (maintenanceKind) {
      return {
        mode: db ? "ready" : "recovery",
        maintenance: true,
        recoveryError: recoveryError ? errorDetails(recoveryError) : null,
        health: null,
        backups: [],
        settings: null,
      };
    }
    if (!db) {
      return {
        mode: "recovery",
        maintenance: false,
        recoveryError: recoveryError ? errorDetails(recoveryError) : null,
        health: null,
        backups: await listRecoveryBackups(backupRoot),
        settings: null,
      };
    }
    return {
      mode: "ready",
      maintenance: false,
      recoveryError: null,
      health: dataSafetyHealth(db),
      backups: db.listBackupRecords(),
      settings: db.getBackupSettings(),
    };
  };

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (!localHost(request.headers.host)) {
        sendError(response, 400, "INVALID_HOST", "Only localhost requests are accepted");
        return;
      }
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const { pathname } = requestUrl;
      if (pathname.startsWith("/api/")) response.setHeader(DATA_EPOCH_HEADER, dataEpoch);

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
      const bundlePreview = pathname === "/api/imports/bundle/preview" && request.method === "POST";
      const enteringDataEpoch = pathname.startsWith("/api/") && JSON_MUTATION_METHODS.has(request.method ?? "")
        ? bundlePreview ? guardBundleMutation(request) : guardDataMutation(request)
        : null;

      if (pathname === "/api/data-safety" && request.method === "GET") {
        sendJson(response, 200, await status());
        return;
      }

      if (pathname === "/api/settings/recent-filters" && request.method === "GET") {
        if (requestUrl.searchParams.size) {
          throw new HttpError(400, "INVALID_RECENT_FILTERS", "Recent filters do not accept query parameters");
        }
        sendJson(response, 200, requireDatabase().getRecentFilters());
        return;
      }

      if (pathname === "/api/settings/recent-filters" && request.method === "PUT") {
        const body = await mutationBody(request);
        const filters = recentFiltersValue(body);
        if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) {
          throw new HttpError(400, "INVALID_RECENT_FILTERS", "revision must be a non-negative integer");
        }
        const result = requireDatabase().setRecentFilters(filters, body.revision as number);
        if (result.kind === "conflict") {
          sendError(response, 409, "RECENT_FILTERS_CONFLICT", "Recent filters changed in another window");
          return;
        }
        sendJson(response, 200, result.state);
        return;
      }

      if (pathname === "/api/capture-queue" && request.method === "GET") {
        sendJson(response, 200, queueStatus());
        return;
      }

      if (pathname === "/api/capture-queue" && request.method === "PATCH") {
        const body = await mutationBody(request);
        if (typeof body.paused !== "boolean" || Object.keys(body).some((key) => key !== "paused")) {
          throw new HttpError(400, "INVALID_QUEUE_STATE", "paused must be the only field and must be boolean");
        }
        worker.setPaused(body.paused);
        sendJson(response, 200, queueStatus());
        return;
      }

      if (pathname === "/api/imports/preview" && request.method === "POST") {
        const body = await mutationBody(request);
        if (!importKinds.has(body.kind as ImportKind)) {
          throw new HttpError(400, "INVALID_IMPORT_KIND", "kind must be urls, bookmarks, or markdown");
        }
        const kind = body.kind as ImportKind;
        const allowed = kind === "markdown" ? new Set(["kind", "files"]) : new Set(["kind", "content"]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new HttpError(400, "INVALID_IMPORT", "Import request contains an unknown field");
        }
        try {
          sendJson(response, 201, requireDatabase().createImportBatch(kind, parseImportRequest(kind, body)));
        } catch (error) {
          if (error instanceof ImportParseError) throw new HttpError(400, error.code, error.message);
          throw error;
        }
        return;
      }

      if (pathname === "/api/imports/bundle/preview" && request.method === "POST") {
        const archive = await readBinary(request, 100 * 1024 * 1024);
        assertDataEpoch(enteringDataEpoch);
        const operation = operationAbort(request, response);
        try {
          sendJson(response, 201, await stagePortableBundle(requireDatabase(), archive, operation.signal));
        } finally {
          operation.dispose();
        }
        return;
      }

      if (pathname === "/api/exports/portable" && request.method === "POST") {
        const body = await mutationBody(request);
        if (body.scope !== "all" && body.scope !== "selected") {
          throw new HttpError(400, "INVALID_EXPORT_SCOPE", "scope must be all or selected");
        }
        const allowed = body.scope === "all" ? new Set(["scope"]) : new Set(["scope", "documentIds"]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new HttpError(400, "INVALID_EXPORT", "Portable export request contains an unknown field");
        }
        let documentIds: string[] | undefined;
        if (body.scope === "selected") {
          if (
            !Array.isArray(body.documentIds) || !body.documentIds.length || body.documentIds.length > 1_000 ||
            body.documentIds.some((id) => typeof id !== "string" || !id || id.length > 200) ||
            new Set(body.documentIds as string[]).size !== body.documentIds.length
          ) throw new HttpError(400, "INVALID_EXPORT_IDS", "documentIds must contain 1 to 1000 unique document IDs");
          documentIds = body.documentIds as string[];
        }
        const operation = operationAbort(request, response);
        let archive: Buffer;
        try {
          archive = await createPortableBundle(requireDatabase(), documentIds, operation.signal);
        } finally {
          operation.dispose();
        }
        const filename = `zhiye-export-${new Date().toISOString().slice(0, 10)}.zip`;
        response.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(archive.length),
          "Cache-Control": "no-store",
          ...securityHeaders(),
        });
        response.end(archive);
        return;
      }

      const applyImportMatch = pathname.match(/^\/api\/imports\/([^/]+)\/apply$/u);
      if (applyImportMatch && request.method === "POST") {
        const body = await mutationBody(request);
        if (!importStrategies.has(body.strategy as ImportStrategy) || Object.keys(body).some((key) => key !== "strategy")) {
          throw new HttpError(400, "INVALID_IMPORT_STRATEGY", "strategy must be skip, copy, or update");
        }
        const database = requireDatabase();
        const importId = decodeId(applyImportMatch[1]);
        promotePortableAssets(database, importId);
        let result: ReturnType<KnowledgeDatabase["applyImportBatch"]>;
        try {
          result = database.applyImportBatch(importId, body.strategy as ImportStrategy);
        } finally {
          database.cleanupUnreferencedAssets();
        }
        if (!result) throw new HttpError(404, "IMPORT_NOT_FOUND", "Import preview not found");
        worker.wake();
        sendJson(response, 200, result);
        return;
      }

      const importMatch = pathname.match(/^\/api\/imports\/([^/]+)$/u);
      if (importMatch && request.method === "DELETE") {
        const body = await mutationBody(request);
        if (Object.keys(body).length) throw new HttpError(400, "INVALID_IMPORT_DELETE", "Import deletion accepts no options");
        if (!requireDatabase().deleteImportBatch(decodeId(importMatch[1]))) {
          throw new HttpError(404, "IMPORT_NOT_FOUND", "Import preview not found");
        }
        response.writeHead(204, { "Cache-Control": "no-store", ...securityHeaders() });
        response.end();
        return;
      }

      if (pathname === "/api/desktop/close-ready" && request.method === "POST") {
        if (!options.onDesktopCloseReady) throw new HttpError(404, "NOT_FOUND", "API endpoint not found");
        const closeBody = await readJson(request);
        assertDataEpoch(enteringDataEpoch);
        const attemptId = closeAttemptId(closeBody.attemptId);
        await maintenanceDone;
        assertDataEpoch(enteringDataEpoch);
        sendJson(response, 200, { ok: true });
        setImmediate(() => options.onDesktopCloseReady?.(attemptId));
        return;
      }

      if (maintenanceKind && pathname.startsWith("/api/")) {
        throw new HttpError(503, "MAINTENANCE", `Data maintenance is in progress: ${maintenanceKind}`);
      }

      if (pathname === "/api/data-safety/backups" && request.method === "POST") {
        await mutationBody(request);
        const database = requireDatabase();
        const record = await runMaintenance("backup", async () => {
          await worker.pause();
          try {
            return await createRecordedBackup(database, options.dataDir, backupRoot, "manual");
          } finally {
            worker.resume();
          }
        });
        sendJson(response, 201, record);
        return;
      }

      const verifyBackupMatch = pathname.match(/^\/api\/data-safety\/backups\/([^/]+)\/verify$/u);
      if (verifyBackupMatch && request.method === "POST") {
        await mutationBody(request);
        const database = requireDatabase();
        const record = await runMaintenance("backup verification", async () => {
          await worker.pause();
          try {
            return await verifyBackupRecord(database, backupRoot, decodeId(verifyBackupMatch[1]));
          } finally {
            worker.resume();
          }
        });
        sendJson(response, 200, record);
        return;
      }

      if (pathname === "/api/data-safety/settings" && request.method === "PATCH") {
        const body = await mutationBody(request);
        if (
          typeof body.automaticRetentionCount !== "number" ||
          !Number.isInteger(body.automaticRetentionCount) ||
          body.automaticRetentionCount < 1 ||
          body.automaticRetentionCount > 100
        ) {
          throw new HttpError(400, "INVALID_RETENTION", "automaticRetentionCount must be an integer from 1 to 100");
        }
        const database = requireDatabase();
        const settings = await runMaintenance("backup retention", async () => {
          await worker.pause();
          try {
            const updated = database.setAutomaticRetentionCount(body.automaticRetentionCount as number);
            await pruneAutomaticBackups(database, backupRoot);
            return updated;
          } finally {
            worker.resume();
          }
        });
        sendJson(response, 200, settings);
        return;
      }

      if (pathname === "/api/data-safety/cleanup" && request.method === "POST") {
        await mutationBody(request);
        const database = requireDatabase();
        const result = await runMaintenance("storage cleanup", async () => {
          await worker.pause();
          try {
            return cleanupOrphanSnapshots(database);
          } finally {
            worker.resume();
          }
        });
        sendJson(response, 200, result);
        return;
      }

      const restoreBackupMatch = pathname.match(/^\/api\/data-safety\/backups\/([^/]+)\/restore$/u);
      if (restoreBackupMatch && request.method === "POST") {
        const body = await readJson(request);
        assertDataEpoch(enteringDataEpoch);
        if (maintenanceKind) throw new HttpError(503, "MAINTENANCE", "Another data operation is in progress");
        if (Object.keys(body).some((key) => key !== "allowQuarantine")) {
          throw new HttpError(400, "INVALID_RESTORE_REQUEST", "Only allowQuarantine may be provided");
        }
        if (body.allowQuarantine !== undefined && typeof body.allowQuarantine !== "boolean") {
          throw new HttpError(400, "INVALID_RESTORE_REQUEST", "allowQuarantine must be a boolean");
        }
        const queueWasPaused = worker.isPaused();
        const result = await runMaintenance("restore", async () => {
          await worker.stop();
          assertDataEpoch(enteringDataEpoch);
          const reopenExpected = db !== null;
          try {
            const selected = await resolveBackupRecord(
              db,
              backupRoot,
              decodeId(restoreBackupMatch[1]),
            );
            db?.close();
            db = null;
            const restored = await restoreBackup({
              dataDir: options.dataDir,
              backupRoot,
              backupPath: selected.backupValue.path,
              supportedSchemaVersion: CURRENT_SCHEMA_VERSION,
              allowQuarantine: body.allowQuarantine as boolean | undefined,
              prepareStaging(stagingDataDir) {
                migrateDatabase(stagingDataDir);
                const candidate = openDatabase(stagingDataDir);
                try {
                  const health = candidate.getDatabaseHealth();
                  if (
                    health.integrityCheck.length !== 1 ||
                    health.integrityCheck[0] !== "ok" ||
                    health.foreignKeyViolations.length
                  ) {
                    throw new Error("Restored database health check failed");
                  }
                } finally {
                  candidate.close();
                }
              },
            });
            db = openDatabase(options.dataDir);
            dataEpoch = randomUUID();
            recoveryError = null;
            try {
              await reconcileBackupRecords(db, backupRoot);
            } catch (error) {
              console.error("Backup reconciliation after restore failed", error);
            }
            return {
              backupId: selected.record.id,
              preRestoreBackupId: restored.preRestoreBackup
                ? db.getBackupRecordByDirectoryName(basename(restored.preRestoreBackup.path))?.id ?? null
                : null,
              quarantinedDataPath: restored.quarantinedDataPath,
              cleanupPending: restored.cleanupPending,
            };
          } catch (error) {
            if (!db) {
              recoveryError = error;
              if (reopenExpected) {
                try {
                  recoverInterruptedRestore(options.dataDir);
                  db = openDatabase(options.dataDir);
                  recoveryError = null;
                  try {
                    await reconcileBackupRecords(db, backupRoot);
                  } catch (reconcileError) {
                    console.error("Backup reconciliation after failed restore failed", reconcileError);
                  }
                } catch (reopenError) {
                  recoveryError = new AggregateError([error, reopenError], "Restore failed and data could not reopen");
                }
              }
            } else {
              recoveryError = null;
            }
            throw error;
          } finally {
            worker = createWorker(
              () => db,
              capture,
              options.fetchAsset,
              options.startWorker !== false && db !== null,
            );
            worker.setPaused(queueWasPaused);
          }
        });
        response.setHeader(DATA_EPOCH_HEADER, dataEpoch);
        sendJson(response, 200, result);
        return;
      }

      if (!db && pathname.startsWith("/api/")) {
        throw new HttpError(503, "DATA_UNAVAILABLE", "Knowledge-base data needs recovery");
      }

      if (pathname === "/api/documents/batch" && request.method === "POST") {
        const body = batchDocumentsRequest(await mutationBody(request));
        const result = requireDatabase().batchDocuments(body.documents, body.action, body.value);
        if (result.kind === "missing") {
          throw new HttpError(404, "BATCH_DOCUMENT_NOT_FOUND", "One or more selected documents no longer exist");
        }
        if (result.kind === "conflict") {
          throw new HttpError(409, "BATCH_CONFLICT", "One or more selected documents changed since selection");
        }
        if (result.kind === "invalid_state") {
          throw new HttpError(409, "BATCH_INVALID_STATE", "Selected documents are not in the state required by this action");
        }
        if (result.kind === "invalid_collection") {
          throw new HttpError(400, "INVALID_COLLECTION_IDS", "The selected collection does not exist");
        }
        if (result.kind === "tag_limit") {
          throw new HttpError(400, "TAG_LIMIT", "A selected document already has the maximum of 50 tags");
        }
        if (result.kind === "collection_limit") {
          throw new HttpError(400, "COLLECTION_LIMIT", "A selected document already has the maximum of 100 collections");
        }
        if (result.kind === "invalid_tag") throw new HttpError(400, "INVALID_TAG", "A tag is required");
        if (body.action === "restore" && result.response.affectedDocuments) worker.wake();
        sendJson(response, 200, result.response);
        return;
      }

      if (pathname === "/api/documents" && request.method === "POST") {
        const body = await mutationBody(request);
        if (body.force !== undefined && typeof body.force !== "boolean") {
          throw new HttpError(400, "INVALID_FORCE", "force must be boolean");
        }
        if (Object.keys(body).some((key) => key !== "url" && key !== "force")) {
          throw new HttpError(400, "INVALID_IMPORT_REQUEST", "Only url and force may be provided");
        }
        const result = requireDatabase().createOrGetDocument(normalizeUrl(body.url), body.force === true);
        if (result.created) worker.wake();
        sendJson(response, result.created ? 202 : 200, result);
        return;
      }

      if (pathname === "/api/documents" && request.method === "GET") {
        sendJson(response, 200, requireDatabase().listDocuments(documentFilters(requestUrl)));
        return;
      }

      if (pathname === "/api/tags/manage" && request.method === "GET") {
        sendJson(response, 200, requireDatabase().listManagedTags());
        return;
      }

      if (pathname === "/api/tags" && request.method === "GET") {
        sendJson(response, 200, requireDatabase().listTags(trashFilter(requestUrl)));
        return;
      }

      const mergeTagMatch = pathname.match(/^\/api\/tags\/([^/]+)\/merge$/u);
      if (mergeTagMatch && request.method === "POST") {
        const source = tagNameValue(decodeId(mergeTagMatch[1]));
        const target = tagName(await mutationBody(request), "target");
        const result = requireDatabase().mergeTag(source, target);
        if (result.kind === "missing") throw new HttpError(404, "TAG_NOT_FOUND", "Source or target tag not found");
        if (result.kind === "same") throw new HttpError(400, "SAME_TAG", "A tag cannot be merged into itself");
        sendJson(response, 200, result.response);
        return;
      }

      const tagMatch = pathname.match(/^\/api\/tags\/([^/]+)$/u);
      if (tagMatch && request.method === "PATCH") {
        const currentName = tagNameValue(decodeId(tagMatch[1]));
        const result = requireDatabase().renameTag(currentName, tagName(await mutationBody(request), "name"));
        if (result.kind === "missing") throw new HttpError(404, "TAG_NOT_FOUND", "Tag not found");
        if (result.kind === "duplicate") {
          throw new HttpError(409, "TAG_NAME_CONFLICT", "A tag with this name already exists");
        }
        sendJson(response, 200, result.response);
        return;
      }
      if (tagMatch && request.method === "DELETE") {
        const body = await mutationBody(request);
        if (Object.keys(body).length) throw new HttpError(400, "INVALID_TAG_DELETE", "Tag deletion accepts no options");
        const result = requireDatabase().deleteTag(tagNameValue(decodeId(tagMatch[1])));
        if (result.kind === "missing") throw new HttpError(404, "TAG_NOT_FOUND", "Tag not found");
        sendJson(response, 200, result.response);
        return;
      }

      if (pathname === "/api/collections" && request.method === "GET") {
        sendJson(response, 200, requireDatabase().listCollections());
        return;
      }

      if (pathname === "/api/collections" && request.method === "POST") {
        const name = collectionName(await mutationBody(request));
        const result = requireDatabase().createCollection(name);
        if (result.kind === "duplicate") {
          throw new HttpError(409, "COLLECTION_NAME_CONFLICT", "A collection with this name already exists");
        }
        sendJson(response, 201, result.collection);
        return;
      }

      const mergeCollectionMatch = pathname.match(/^\/api\/collections\/([^/]+)\/merge$/u);
      if (mergeCollectionMatch && request.method === "POST") {
        const body = await mutationBody(request);
        if (Object.keys(body).some((key) => key !== "targetId")) {
          throw new HttpError(400, "INVALID_COLLECTION_MERGE", "targetId must be the only field");
        }
        const [targetId] = collectionIdsValue([body.targetId]);
        const result = requireDatabase().mergeCollection(decodeId(mergeCollectionMatch[1]), targetId!);
        if (result.kind === "missing") {
          throw new HttpError(404, "COLLECTION_NOT_FOUND", "Source or target collection not found");
        }
        if (result.kind === "same") {
          throw new HttpError(400, "SAME_COLLECTION", "A collection cannot be merged into itself");
        }
        sendJson(response, 200, {
          collection: result.collection,
          affectedDocuments: result.affectedDocuments,
        });
        return;
      }

      const collectionMatch = pathname.match(/^\/api\/collections\/([^/]+)$/u);
      if (collectionMatch && request.method === "PATCH") {
        const name = collectionName(await mutationBody(request));
        const result = requireDatabase().renameCollection(decodeId(collectionMatch[1]), name);
        if (result.kind === "missing") throw new HttpError(404, "NOT_FOUND", "Collection not found");
        if (result.kind === "duplicate") {
          throw new HttpError(409, "COLLECTION_NAME_CONFLICT", "A collection with this name already exists");
        }
        sendJson(response, 200, result.collection);
        return;
      }

      if (collectionMatch && request.method === "DELETE") {
        const body = await mutationBody(request);
        if (Object.keys(body).length) {
          throw new HttpError(400, "INVALID_COLLECTION_DELETE", "Collection deletion does not accept options");
        }
        const result = requireDatabase().deleteCollection(decodeId(collectionMatch[1]));
        if (result.kind === "missing") throw new HttpError(404, "NOT_FOUND", "Collection not found");
        sendJson(response, 200, { deleted: true, affectedDocuments: result.affectedDocuments });
        return;
      }

      const assetFileMatch = pathname.match(/^\/api\/assets\/([^/]+)$/u);
      if (assetFileMatch && (request.method === "GET" || request.method === "HEAD")) {
        await serveAsset(request, response, requireDatabase(), decodeId(assetFileMatch[1]));
        return;
      }

      const documentAssetsMatch = pathname.match(/^\/api\/documents\/([^/]+)\/assets$/u);
      if (documentAssetsMatch && request.method === "GET") {
        const assets = requireDatabase().listDocumentAssets(decodeId(documentAssetsMatch[1]));
        if (!assets) throw new HttpError(404, "NOT_FOUND", "Document not found");
        sendJson(response, 200, assets);
        return;
      }

      const duplicateMatch = pathname.match(/^\/api\/documents\/([^/]+)\/duplicate$/u);
      if (duplicateMatch && request.method === "GET") {
        const database = requireDatabase();
        const id = decodeId(duplicateMatch[1]);
        if (!database.getDocument(id)) throw new HttpError(404, "NOT_FOUND", "Document not found");
        sendJson(response, 200, database.findDuplicateDocument(id));
        return;
      }

      const cancelMatch = pathname.match(/^\/api\/documents\/([^/]+)\/cancel$/u);
      if (cancelMatch && request.method === "POST") {
        const body = await mutationBody(request);
        if (Object.keys(body).length) {
          throw new HttpError(400, "INVALID_CANCEL_REQUEST", "Cancellation does not accept options");
        }
        const result = requireDatabase().cancelQueuedCapture(decodeId(cancelMatch[1]));
        if (result.kind === "missing") throw new HttpError(404, "NOT_FOUND", "Document not found");
        if (result.kind === "not_queued") {
          sendError(response, 409, "CAPTURE_NOT_QUEUED", "Only queued captures can be cancelled", result.document);
          return;
        }
        sendJson(response, 200, result.document);
        return;
      }

      const reextractMatch = pathname.match(/^\/api\/documents\/([^/]+)\/captures\/([^/]+)\/reextract$/u);
      if (reextractMatch && request.method === "POST") {
        const body = await mutationBody(request);
        if (Object.keys(body).length) {
          throw new HttpError(400, "INVALID_REEXTRACTION_REQUEST", "Re-extraction does not accept options");
        }
        const database = requireDatabase();
        const documentId = decodeId(reextractMatch[1]);
        const captureId = decodeId(reextractMatch[2]);
        const initialDocument = database.getDocument(documentId);
        if (!initialDocument) throw new HttpError(404, "NOT_FOUND", "Document not found");
        if (initialDocument.deletedAt) {
          sendError(response, 409, "DOCUMENT_DELETED", "Restore the document before re-extracting", initialDocument);
          return;
        }
        const source = database.getCaptureSnapshotSource(documentId, captureId);
        if (source.kind === "missing") throw new HttpError(404, "CAPTURE_NOT_FOUND", "Capture not found");
        if (source.kind === "snapshot_missing") {
          throw new HttpError(409, "SNAPSHOT_MISSING", "This capture has no HTML snapshot");
        }
        if (source.kind === "snapshot_invalid") {
          throw new HttpError(422, "SNAPSHOT_INVALID", "The capture references an unsafe HTML snapshot");
        }
        let extracted: Awaited<ReturnType<typeof extractHtml>>;
        try {
          extracted = await extractHtml(await readSnapshotHtml(source.path), source.sourceUrl);
        } catch (cause) {
          if (cause instanceof HttpError) throw cause;
          throw new HttpError(422, "REEXTRACTION_FAILED", "The HTML snapshot could not be extracted");
        }
        if (!extracted.markdown.trim()) {
          throw new HttpError(422, "EXTRACTION_EMPTY", "The HTML snapshot contains no extractable body");
        }
        const currentDatabase = requireDatabase();
        if (currentDatabase !== database) {
          throw new HttpError(409, "DATA_CHANGED", "Local data changed while the snapshot was being extracted");
        }
        const document = currentDatabase.getDocument(documentId);
        if (!document) throw new HttpError(404, "NOT_FOUND", "Document not found");
        if (document.deletedAt) {
          sendError(response, 409, "DOCUMENT_DELETED", "Restore the document before re-extracting", document);
          return;
        }
        sendJson(response, 200, {
          captureId,
          baseRevision: document.revision,
          extractorVersion: extracted.extractorVersion,
          before: { title: document.title, markdown: document.markdown },
          after: { title: extracted.title, markdown: extracted.markdown },
          createdAt: new Date().toISOString(),
        });
        return;
      }

      const captureHistoryMatch = pathname.match(/^\/api\/documents\/([^/]+)\/captures$/u);
      if (captureHistoryMatch && request.method === "GET") {
        const history = requireDatabase().listCaptureHistory(decodeId(captureHistoryMatch[1]));
        if (!history) throw new HttpError(404, "NOT_FOUND", "Document not found");
        sendJson(response, 200, history);
        return;
      }

      const draftMatch = pathname.match(/^\/api\/documents\/([^/]+)\/draft$/u);
      if (draftMatch && request.method === "GET") {
        const id = decodeId(draftMatch[1]);
        const database = requireDatabase();
        if (!database.getDocument(id)) throw new HttpError(404, "NOT_FOUND", "Document not found");
        sendJson(response, 200, database.getDocumentDraft(id));
        return;
      }
      if (draftMatch && request.method === "PUT") {
        const id = decodeId(draftMatch[1]);
        const draft = documentDraft(await mutationBody(request));
        const result = requireDatabase().saveDocumentDraft(
          id,
          draft.expectedDraftRevision,
          draft.baseRevision,
          draft.title,
          draft.markdown,
          draft.tags,
        );
        if (result.kind === "missing") throw new HttpError(404, "NOT_FOUND", "Document not found");
        if (result.kind === "conflict") {
          sendError(response, 409, "DRAFT_CONFLICT", "Draft changed since it was loaded", undefined, result.draft);
          return;
        }
        sendJson(response, 200, result.draft);
        return;
      }
      if (draftMatch && request.method === "DELETE") {
        const expectedRevision = draftRevision((await mutationBody(request)).draftRevision);
        const id = decodeId(draftMatch[1]);
        const database = requireDatabase();
        if (!database.getDocument(id)) throw new HttpError(404, "NOT_FOUND", "Document not found");
        const result = database.deleteDocumentDraft(id, expectedRevision!);
        if (result.kind === "conflict") {
          sendError(response, 409, "DRAFT_CONFLICT", "Draft changed since it was loaded", undefined, result.draft);
          return;
        }
        response.writeHead(204, { "Cache-Control": "no-store", ...securityHeaders() });
        response.end();
        return;
      }

      const revisionRestoreMatch = pathname.match(
        /^\/api\/documents\/([^/]+)\/revisions\/([^/]+)\/restore$/u,
      );
      if (request.method === "POST" && revisionRestoreMatch) {
        const currentRevision = bodyRevision(await mutationBody(request));
        const result = requireDatabase().restoreDocumentRevision(
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
        const revisions = requireDatabase().listDocumentRevisions(decodeId(revisionsMatch[1]));
        if (!revisions) throw new HttpError(404, "NOT_FOUND", "Document not found");
        sendJson(response, 200, revisions);
        return;
      }

      const restoreMatch = pathname.match(/^\/api\/documents\/([^/]+)\/restore$/u);
      if (request.method === "POST" && restoreMatch) {
        const revision = bodyRevision(await mutationBody(request));
        const result = requireDatabase().restoreDocument(decodeId(restoreMatch[1]), revision);
        if (result.kind === "missing") throw new HttpError(404, "NOT_FOUND", "Document not found");
        if (result.kind === "conflict") {
          sendError(response, 409, "REVISION_CONFLICT", "Document changed since it was loaded", result.document);
          return;
        }
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
        const body = await mutationBody(request);
        const revision = bodyRevision(body);
        const confirmedDraftRevision = draftRevision(body.draftRevision, true);
        const result = requireDatabase().permanentlyDeleteDocument(
          decodeId(permanentMatch[1]),
          revision,
          confirmedDraftRevision,
        );
        if (result.kind === "missing") throw new HttpError(404, "NOT_FOUND", "Document not found");
        if (result.kind === "not_deleted") {
          sendError(response, 409, "NOT_IN_TRASH", "Document must be in the trash before permanent deletion", result.document);
          return;
        }
        if (result.kind === "capture_running") {
          sendError(response, 409, "CAPTURE_IN_PROGRESS", "Wait for the active capture to finish", result.document);
          return;
        }
        if (result.kind === "draft_exists") {
          sendError(response, 409, "DRAFT_EXISTS", "A newer draft must be reviewed before deletion", result.document);
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
        const document = requireDatabase().getDocument(decodeId(exportMatch[1]));
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
        await mutationBody(request);
        const result = requireDatabase().retryDocument(decodeId(retryMatch[1]));
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
        const document = requireDatabase().getDocument(decodeId(documentMatch[1]));
        if (!document) throw new HttpError(404, "NOT_FOUND", "Document not found");
        sendJson(response, 200, document);
        return;
      }
      if (documentMatch && request.method === "PATCH") {
        const { revision, patch } = documentPatch(await mutationBody(request));
        const result = requireDatabase().updateDocument(decodeId(documentMatch[1]), revision, patch);
        if (result.kind === "missing") throw new HttpError(404, "NOT_FOUND", "Document not found");
        if (result.kind === "deleted") {
          sendError(response, 409, "DOCUMENT_DELETED", "Restore the document before changing it", result.document);
          return;
        }
        if (result.kind === "conflict") {
          sendError(response, 409, "REVISION_CONFLICT", "Document changed since it was loaded", result.document);
          return;
        }
        if (result.kind === "invalid_collections") {
          sendJson(response, 400, {
            error: {
              code: "INVALID_COLLECTION_IDS",
              message: "One or more collections do not exist",
              missingCollectionIds: result.missingCollectionIds,
            },
          });
          return;
        }
        sendJson(response, 200, result.document);
        return;
      }
      if (documentMatch && request.method === "DELETE") {
        const revision = bodyRevision(await mutationBody(request));
        const result = requireDatabase().softDeleteDocument(decodeId(documentMatch[1]), revision);
        if (result.kind === "missing") throw new HttpError(404, "NOT_FOUND", "Document not found");
        if (result.kind === "conflict") {
          sendError(response, 409, "REVISION_CONFLICT", "Document changed since it was loaded", result.document);
          return;
        }
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
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if ((request.url ?? "").startsWith("/api/")) response.setHeader(DATA_EPOCH_HEADER, dataEpoch);
      if (error instanceof HttpError) sendError(response, error.status, error.code, error.message);
      else if (error instanceof DataSafetyError) sendError(response, error.status, error.code, error.message);
      else if (error instanceof BackupError) {
        sendError(
          response,
          error.code === "QUARANTINE_REQUIRED" ? 409 : 400,
          error.code,
          error.message,
        );
      }
      else if (error instanceof PortableError) sendError(response, error.status, error.code, error.message);
      else {
        console.error(error);
        sendError(response, 500, "INTERNAL_ERROR", "Internal server error");
      }
    }
  };

  let closed = false;
  return {
    handler,
    get db() {
      if (!db) throw new Error("Knowledge-base data is unavailable");
      return db;
    },
    bootstrapToken: auth.bootstrapToken,
    async close() {
      if (closed) return;
      closed = true;
      await maintenanceDone;
      await worker.stop();
      db?.close();
      db = null;
    },
  };
}
