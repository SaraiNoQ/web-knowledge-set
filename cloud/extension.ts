export interface D1Result<T = unknown> {
  results: T[];
  meta: { changes?: number };
}

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(sql: string): D1Statement;
}

export type BrowserKind = "chrome" | "firefox";

export class CloudHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const encoder = new TextEncoder();
const unsafeControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export async function jsonObject(request: Request, maxBytes = 2 * 1024 * 1024 + 16_384) {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new CloudHttpError(415, "JSON_REQUIRED", "Content-Type must be application/json");
  }
  const declared = request.headers.get("Content-Length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
    throw new CloudHttpError(413, "REQUEST_TOO_LARGE", "JSON body is too large");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new CloudHttpError(413, "REQUEST_TOO_LARGE", "JSON body is too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value as Record<string, unknown>;
  } catch {
    throw new CloudHttpError(400, "INVALID_JSON", "Request body must be a JSON object");
  }
}

export function extensionOrigin(request: Request): { browser: BrowserKind; origin: string } {
  const origin = request.headers.get("Origin") || "";
  if (/^chrome-extension:\/\/[a-p]{32}$/u.test(origin)) return { browser: "chrome", origin };
  if (/^moz-extension:\/\/[0-9a-f-]{36}$/iu.test(origin)) return { browser: "firefox", origin };
  throw new CloudHttpError(403, "EXTENSION_ORIGIN_REJECTED", "Browser extension origin required");
}

export function extensionCors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function randomBase64Url(size: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

async function sha256(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalHex(left: string, right: string) {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}

function changes(result: D1Result) {
  return result.meta.changes ?? 0;
}

export async function createPairingCode(db: D1Database) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const code = [...bytes].map((byte) => alphabet[byte & 31]).join("");
  const expiresAt = Date.now() + 5 * 60_000;
  await db.prepare(
    `INSERT INTO browser_extension_pairing_code(singleton, code_hash, expires_at, failures)
     VALUES (1, ?, ?, 0)
     ON CONFLICT(singleton) DO UPDATE SET code_hash = excluded.code_hash,
       expires_at = excluded.expires_at, failures = 0`,
  ).bind(await sha256(code), expiresAt).run();
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

export async function listPairings(db: D1Database) {
  const result = await db.prepare(
    "SELECT id, browser, created_at AS createdAt FROM browser_extension_pairings ORDER BY created_at DESC",
  ).all<{ id: string; browser: BrowserKind; createdAt: string }>();
  return result.results;
}

export async function revokePairing(db: D1Database, id: string) {
  return changes(await db.prepare("DELETE FROM browser_extension_pairings WHERE id = ?").bind(id).run()) === 1;
}

export async function exchangePairing(db: D1Database, body: Record<string, unknown>, browser: BrowserKind) {
  if (Object.keys(body).some((key) => key !== "code" && key !== "browser") || body.browser !== browser ||
    typeof body.code !== "string" || !/^[A-Z2-9]{10}$/u.test(body.code)) {
    throw new CloudHttpError(400, "INVALID_PAIRING_REQUEST", "A valid pairing code and browser are required");
  }
  const row = await db.prepare(
    "SELECT code_hash AS codeHash, expires_at AS expiresAt, failures FROM browser_extension_pairing_code WHERE singleton = 1",
  ).first<{ codeHash: string; expiresAt: number; failures: number }>();
  const candidateHash = await sha256(body.code);
  const now = Date.now();
  if (!row || row.expiresAt <= now || row.failures >= 5 || !equalHex(row.codeHash, candidateHash)) {
    if (row) {
      await db.prepare(
        `UPDATE browser_extension_pairing_code SET failures = failures + 1
         WHERE singleton = 1 AND code_hash = ? AND expires_at > ? AND failures < 5`,
      ).bind(row.codeHash, now).run();
    }
    throw new CloudHttpError(401, "PAIRING_CODE_REJECTED", "Pairing code is invalid or expired");
  }
  const consumed = await db.prepare(
    `DELETE FROM browser_extension_pairing_code
     WHERE singleton = 1 AND code_hash = ? AND expires_at > ? AND failures < 5`,
  ).bind(candidateHash, now).run();
  if (changes(consumed) !== 1) {
    throw new CloudHttpError(401, "PAIRING_CODE_REJECTED", "Pairing code is invalid or expired");
  }

  const token = randomBase64Url(32);
  const pairing = { id: crypto.randomUUID(), browser, createdAt: new Date().toISOString() };
  const inserted = await db.prepare(
    `INSERT INTO browser_extension_pairings(id, browser, token_hash, created_at)
     SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM browser_extension_pairings) < 20`,
  ).bind(pairing.id, browser, await sha256(token), pairing.createdAt).run();
  if (changes(inserted) !== 1) throw new CloudHttpError(409, "PAIRING_LIMIT", "Pairing limit reached");
  return { token, pairing };
}

function clipInput(body: Record<string, unknown>) {
  const allowed = new Set(["sourceUrl", "title", "author", "publishedAt", "markdown"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new CloudHttpError(400, "INVALID_EXTENSION_CLIP", "Extension clip contains an unknown field");
  }
  if (typeof body.sourceUrl !== "string" || body.sourceUrl.length > 8_192) {
    throw new CloudHttpError(400, "INVALID_URL", "A valid HTTP or HTTPS URL is required");
  }
  let sourceUrl: string;
  try {
    const url = new URL(body.sourceUrl.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error("invalid");
    url.hash = "";
    sourceUrl = url.toString();
  } catch {
    throw new CloudHttpError(400, "INVALID_URL", "A valid HTTP or HTTPS URL is required");
  }
  if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 1_000) {
    throw new CloudHttpError(400, "INVALID_TITLE", "title must be non-empty and under 1000 characters");
  }
  if (typeof body.markdown !== "string" || !body.markdown.trim()) {
    throw new CloudHttpError(400, "INVALID_MARKDOWN", "markdown must be non-empty");
  }
  if (encoder.encode(body.markdown).byteLength > 2 * 1024 * 1024) {
    throw new CloudHttpError(413, "MARKDOWN_TOO_LARGE", "markdown exceeds 2 MiB");
  }
  if (unsafeControl.test(body.title) || unsafeControl.test(body.markdown)) {
    throw new CloudHttpError(400, "INVALID_CONTROL_CHARACTER", "clip text contains a control character");
  }
  const author = body.author === undefined || body.author === null ? null : body.author;
  if (author !== null && (typeof author !== "string" || !author.trim() || author.length > 1_000 || unsafeControl.test(author))) {
    throw new CloudHttpError(400, "INVALID_AUTHOR", "author must be null or a short non-empty string");
  }
  const publishedAt = body.publishedAt === undefined || body.publishedAt === null ? null : body.publishedAt;
  if (publishedAt !== null && (typeof publishedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(publishedAt) ||
    new Date(`${publishedAt}T00:00:00.000Z`).toISOString().slice(0, 10) !== publishedAt)) {
    throw new CloudHttpError(400, "INVALID_PUBLISHED_AT", "publishedAt must be a real YYYY-MM-DD date");
  }
  return { sourceUrl, title: body.title.trim(), author: author?.trim() ?? null, publishedAt, markdown: body.markdown };
}

export async function createClip(db: D1Database, request: Request) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(request.headers.get("Authorization") || "");
  if (!match) throw new CloudHttpError(401, "EXTENSION_UNAUTHORIZED", "Extension token required");
  const pairing = await db.prepare("SELECT id FROM browser_extension_pairings WHERE token_hash = ?")
    .bind(await sha256(match[1])).first<{ id: string }>();
  if (!pairing) throw new CloudHttpError(401, "EXTENSION_UNAUTHORIZED", "Extension token is invalid or revoked");

  const input = clipInput(await jsonObject(request));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO cloud_documents(
       id, source_url, final_url, canonical_url, title, author, published_at, markdown,
       status, source_note, revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', '浏览器扩展剪藏', 1, ?, ?)`,
  ).bind(
    id, input.sourceUrl, input.sourceUrl, input.sourceUrl, input.title, input.author,
    input.publishedAt, input.markdown, now, now,
  ).run();
  return { documentId: id };
}

interface DocumentSummaryRow {
  id: string;
  sourceUrl: string;
  finalUrl: string | null;
  canonicalUrl: string | null;
  title: string;
  author: string | null;
  status: "ready";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface DocumentRow extends DocumentSummaryRow {
  publishedAt: string | null;
  markdown: string;
  sourceNote: string;
}

function summary(row: DocumentSummaryRow) {
  return {
    id: row.id,
    title: row.title,
    sourceUrl: row.sourceUrl,
    finalUrl: row.finalUrl,
    canonicalUrl: row.canonicalUrl,
    author: row.author,
    status: row.status,
    warning: null,
    errorCode: null,
    errorMessage: null,
    tags: [],
    collections: [],
    favorite: false,
    archivedAt: null,
    revision: row.revision,
    deletedAt: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const summaryColumns = `id, source_url AS sourceUrl, final_url AS finalUrl, canonical_url AS canonicalUrl,
  title, author, status, revision, created_at AS createdAt, updated_at AS updatedAt`;

export async function listDocuments(db: D1Database, url: URL) {
  const pageValue = url.searchParams.get("page") || "1";
  if (!/^[1-9]\d*$/u.test(pageValue)) throw new CloudHttpError(400, "INVALID_PAGE", "page must be a positive integer");
  const page = Number.parseInt(pageValue, 10);
  const query = url.searchParams.get("q")?.trim() || "";
  if (query.length > 500) throw new CloudHttpError(400, "INVALID_QUERY", "query is too long");
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (query) {
    const scope = url.searchParams.get("scope") || "all";
    const columns = scope === "title" ? ["title"] : scope === "body" ? ["markdown"] :
      scope === "source" ? ["source_url"] : scope === "all" ? ["title", "markdown", "source_url"] : null;
    if (!columns) throw new CloudHttpError(400, "INVALID_SCOPE", "Unknown search scope");
    conditions.push(`(${columns.map((column) => `${column} LIKE ?`).join(" OR ")})`);
    values.push(...columns.map(() => `%${query}%`));
  }
  const unsupported = (url.searchParams.get("status") && url.searchParams.get("status") !== "ready") ||
    url.searchParams.get("favorite") === "true" || url.searchParams.get("archived") === "true" ||
    Boolean(url.searchParams.get("tag") || url.searchParams.get("collectionId") || url.searchParams.get("captureMode")) ||
    url.searchParams.get("trash") === "only";
  if (unsupported) conditions.push("0");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  for (const [parameter, operator, suffix] of [["from", ">=", "T00:00:00.000Z"], ["to", "<=", "T23:59:59.999Z"]] as const) {
    const date = url.searchParams.get(parameter);
    if (!date) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
      throw new CloudHttpError(400, "INVALID_DATE", `${parameter} must be a real YYYY-MM-DD date`);
    }
    conditions.push(`created_at ${operator} ?`);
    values.push(`${date}${suffix}`);
  }
  if (from && to && from > to) throw new CloudHttpError(400, "INVALID_DATE_RANGE", "from must not be after to");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const count = await db.prepare(`SELECT COUNT(*) AS count FROM cloud_documents ${where}`)
    .bind(...values).first<{ count: number }>();
  const sort = url.searchParams.get("sort") === "title" ? "title COLLATE NOCASE ASC" :
    url.searchParams.get("sort") === "created" ? "created_at DESC" : "updated_at DESC";
  const rows = await db.prepare(
    `SELECT ${summaryColumns} FROM cloud_documents ${where} ORDER BY ${sort} LIMIT 30 OFFSET ?`,
  ).bind(...values, (page - 1) * 30).all<DocumentSummaryRow>();
  return { items: rows.results.map(summary), page, pageSize: 30, total: count?.count ?? 0 };
}

export async function getDocument(db: D1Database, id: string) {
  const row = await db.prepare(
    `SELECT ${summaryColumns}, published_at AS publishedAt, markdown, source_note AS sourceNote
     FROM cloud_documents WHERE id = ?`,
  )
    .bind(id).first<DocumentRow>();
  return row ? { ...summary(row), publishedAt: row.publishedAt, markdown: row.markdown, captureMode: null, sourceNote: row.sourceNote } : null;
}
