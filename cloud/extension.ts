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
  batch?(statements: D1Statement[]): Promise<D1Result[]>;
}

export type BrowserKind = "chrome" | "firefox";

export class CloudHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly document?: unknown) {
    super(message);
  }
}

const encoder = new TextEncoder();
export const MAX_CLOUD_ROW_TEXT_BYTES = 1_900_000;
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

const epochGuardSql = `SELECT CASE
  WHEN EXISTS (SELECT 1 FROM app_settings WHERE key = 'data_epoch' AND value = ?) THEN 1
  ELSE json('invalid epoch')
END AS guarded`;

async function rethrowEpochError(db: D1Database, expectedEpoch: string, cause: unknown): Promise<never> {
  const current = await db.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").first<{ value: string }>();
  if (current?.value !== expectedEpoch) {
    throw new CloudHttpError(409, "STALE_DATA_EPOCH", "Cloud data changed; reload before writing");
  }
  throw cause;
}

export function epochGuardedDatabase(db: D1Database, expectedEpoch: string): D1Database {
  if (!db.batch) throw new CloudHttpError(503, "CLOUD_BATCH_UNAVAILABLE", "D1 batch API is unavailable");
  const originals = new WeakMap<object, D1Statement>();
  const guardedBatch = async (statements: D1Statement[]) => {
    try {
      const result = await db.batch!([
        db.prepare(epochGuardSql).bind(expectedEpoch),
        ...statements.map((statement) => originals.get(statement as object) ?? statement),
      ]);
      return result.slice(1);
    } catch (cause) {
      return await rethrowEpochError(db, expectedEpoch, cause);
    }
  };
  const wrap = (statement: D1Statement): D1Statement => {
    const wrapped: D1Statement = {
      bind(...values) { return wrap(statement.bind(...values)); },
      first<T>() { return statement.first<T>(); },
      all<T>() { return statement.all<T>(); },
      async run<T>() { return (await guardedBatch([statement]))[0] as D1Result<T>; },
    };
    originals.set(wrapped as object, statement);
    return wrapped;
  };
  return {
    prepare(sql) { return wrap(db.prepare(sql)); },
    batch: guardedBatch,
  };
}

export async function recoverExpiredRestore(db: D1Database, epoch: string) {
  const reservation = /^restore:(\d+):/u.exec(epoch);
  if (!reservation || Number(reservation[1]) > Date.now()) return epoch;
  if (!db.batch) throw new CloudHttpError(503, "CLOUD_BATCH_UNAVAILABLE", "D1 batch API is unavailable");
  const fresh = `cloud-${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  const [, released] = await db.batch([
    db.prepare(`UPDATE cloud_capture_jobs SET status = 'failed', error_code = 'RESTORE_INTERRUPTED',
      revision = revision + 1, updated_at = ? WHERE status IN ('queued', 'fetching')
      AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'data_epoch' AND value = ?)`).bind(timestamp, epoch),
    db.prepare(
      "UPDATE app_settings SET value = ?, revision = revision + 1, updated_at = ? WHERE key = 'data_epoch' AND value = ?",
    ).bind(fresh, timestamp, epoch),
  ]);
  if ((released?.meta.changes ?? 0) === 1) return fresh;
  return (await db.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").first<{ value: string }>())?.value ?? null;
}

function folderName(body: Record<string, unknown>) {
  if (Object.keys(body).some((key) => key !== "name") || typeof body.name !== "string") {
    throw new CloudHttpError(400, "INVALID_FOLDER_NAME", "name must be the only field and contain 1 to 100 characters");
  }
  const name = body.name.normalize("NFKC").trim();
  if (!name || name.length > 100 || unsafeControl.test(name)) {
    throw new CloudHttpError(400, "INVALID_FOLDER_NAME", "name must contain 1 to 100 safe characters");
  }
  return name;
}

export function folderIdValue(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 200 || value !== value.trim() || unsafeControl.test(value)) {
    throw new CloudHttpError(400, "INVALID_FOLDER_ID", "folderId must be null or a valid folder identifier");
  }
  return value;
}

interface FolderRow {
  id: string;
  name: string;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

const folderColumns = `f.id, f.name,
  ((SELECT COUNT(*) FROM cloud_documents d WHERE d.folder_id = f.id AND d.deleted_at IS NULL) +
   (SELECT COUNT(*) FROM cloud_capture_jobs j WHERE j.folder_id = f.id
      AND j.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM cloud_documents d WHERE d.id = j.id))) AS documentCount,
  f.created_at AS createdAt, f.updated_at AS updatedAt`;

async function getFolder(db: D1Database, id: string) {
  return await db.prepare(`SELECT ${folderColumns} FROM cloud_folders f WHERE f.id = ?`).bind(id).first<FolderRow>();
}

export async function listFolders(db: D1Database) {
  const rows = await db.prepare(`SELECT ${folderColumns} FROM cloud_folders f ORDER BY f.name COLLATE NOCASE, f.id`).all<FolderRow>();
  return rows.results;
}

export async function createFolder(db: D1Database, body: Record<string, unknown>) {
  const name = folderName(body);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await db.prepare(`INSERT INTO cloud_folders(id, name, created_at, updated_at)
    SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM cloud_folders WHERE name = ? COLLATE NOCASE)`)
    .bind(id, name, now, now, name).run();
  if (changes(result) !== 1) throw new CloudHttpError(409, "FOLDER_NAME_CONFLICT", "A folder with this name already exists");
  return { id, name, documentCount: 0, createdAt: now, updatedAt: now };
}

export async function updateFolder(db: D1Database, id: string, body: Record<string, unknown>) {
  folderIdValue(id);
  const name = folderName(body);
  const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE cloud_folders SET name = ?, updated_at = ?
    WHERE id = ? AND NOT EXISTS (
      SELECT 1 FROM cloud_folders WHERE name = ? COLLATE NOCASE AND id <> ?
    )`).bind(name, now, id, name, id).run();
  if (changes(result) !== 1) {
    if (!await getFolder(db, id)) throw new CloudHttpError(404, "FOLDER_NOT_FOUND", "Folder not found");
    throw new CloudHttpError(409, "FOLDER_NAME_CONFLICT", "A folder with this name already exists");
  }
  return await getFolder(db, id);
}

export async function deleteFolder(db: D1Database, id: string, body: Record<string, unknown>) {
  folderIdValue(id);
  if (Object.keys(body).length) throw new CloudHttpError(400, "INVALID_FOLDER_DELETE", "Folder deletion accepts no options");
  if (!await getFolder(db, id)) throw new CloudHttpError(404, "FOLDER_NOT_FOUND", "Folder not found");
  if (!db.batch) throw new CloudHttpError(503, "CLOUD_BATCH_UNAVAILABLE", "D1 batch API is unavailable");
  const now = new Date().toISOString();
  const [documents, jobs, deleted] = await db.batch([
    db.prepare("UPDATE cloud_documents SET folder_id = NULL, revision = revision + 1, updated_at = ? WHERE folder_id = ?").bind(now, id),
    db.prepare("UPDATE cloud_capture_jobs SET folder_id = NULL, revision = revision + 1, updated_at = ? WHERE folder_id = ?").bind(now, id),
    db.prepare("DELETE FROM cloud_folders WHERE id = ?").bind(id),
  ]);
  if (changes(deleted) !== 1) throw new CloudHttpError(404, "FOLDER_NOT_FOUND", "Folder not found");
  return { deleted: true as const, affectedDocuments: changes(documents) + changes(jobs) };
}

export function documentFolderFilter(url: URL) {
  const folderValues = url.searchParams.getAll("folderId");
  const unfiledValues = url.searchParams.getAll("unfiled");
  if (folderValues.length > 1 || unfiledValues.length > 1 || (folderValues.length && unfiledValues.length) ||
    (unfiledValues.length === 1 && unfiledValues[0] !== "true" && unfiledValues[0] !== "false")) {
    throw new CloudHttpError(400, "INVALID_FILTER", "folderId and unfiled must be valid and cannot be combined");
  }
  return {
    folderId: folderValues.length ? folderIdValue(folderValues[0]) : null,
    unfiled: unfiledValues.length ? unfiledValues[0] === "true" : null,
  };
}

export function documentTrashFilter(url: URL) {
  const values = url.searchParams.getAll("trash");
  if (values.length > 1 || (values.length === 1 && values[0] !== "only")) {
    throw new CloudHttpError(400, "INVALID_TRASH_FILTER", "trash must be omitted or equal only");
  }
  return values[0] === "only";
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
  if (encoder.encode(body.markdown).byteLength > MAX_CLOUD_ROW_TEXT_BYTES) {
    throw new CloudHttpError(413, "MARKDOWN_TOO_LARGE", "markdown exceeds the D1 row budget");
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
  const tokenHash = await sha256(match[1]);
  const pairing = await db.prepare("SELECT id FROM browser_extension_pairings WHERE token_hash = ?")
    .bind(tokenHash).first<{ id: string }>();
  if (!pairing) throw new CloudHttpError(401, "EXTENSION_UNAUTHORIZED", "Extension token is invalid or revoked");

  const input = clipInput(await jsonObject(request));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const inserted = await db.prepare(
    `INSERT INTO cloud_documents(
       id, source_url, final_url, canonical_url, title, author, published_at, markdown,
       status, source_note, revision, created_at, updated_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'ready', '浏览器扩展剪藏', 1, ?, ?
       WHERE EXISTS (SELECT 1 FROM browser_extension_pairings WHERE token_hash = ?)`,
  ).bind(
    id, input.sourceUrl, input.sourceUrl, input.sourceUrl, input.title, input.author,
    input.publishedAt, input.markdown, now, now, tokenHash,
  ).run();
  if (changes(inserted) !== 1) throw new CloudHttpError(401, "EXTENSION_UNAUTHORIZED", "Extension token was revoked before save");
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
  folderId: string | null;
  favorite: number;
  revision: number;
  deletedAt: string | null;
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
    folderId: row.folderId,
    favorite: Boolean(row.favorite),
    archivedAt: null,
    revision: row.revision,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const summaryColumns = `id, source_url AS sourceUrl, final_url AS finalUrl, canonical_url AS canonicalUrl,
  title, author, status, folder_id AS folderId, favorite, revision, deleted_at AS deletedAt,
  created_at AS createdAt, updated_at AS updatedAt`;

export async function listDocuments(db: D1Database, url: URL, window?: { limit: number; offset: number }) {
  const pageValue = url.searchParams.get("page") || "1";
  if (!/^[1-9]\d*$/u.test(pageValue)) throw new CloudHttpError(400, "INVALID_PAGE", "page must be a positive integer");
  const page = Number.parseInt(pageValue, 10);
  const query = url.searchParams.get("q")?.trim() || "";
  if (query.length > 500) throw new CloudHttpError(400, "INVALID_QUERY", "query is too long");
  const conditions: string[] = [];
  const values: unknown[] = [];
  conditions.push(documentTrashFilter(url) ? "deleted_at IS NOT NULL" : "deleted_at IS NULL");
  const folder = documentFolderFilter(url);
  if (folder.folderId) {
    conditions.push("folder_id = ?");
    values.push(folder.folderId);
  } else if (folder.unfiled === true) {
    conditions.push("folder_id IS NULL");
  } else if (folder.unfiled === false) {
    conditions.push("folder_id IS NOT NULL");
  }
  if (query) {
    const scope = url.searchParams.get("scope") || "all";
    const columns = scope === "title" ? ["title"] : scope === "body" ? ["markdown"] :
      scope === "source" ? ["source_url"] : scope === "all" ? ["title", "markdown", "source_url"] : null;
    if (!columns) throw new CloudHttpError(400, "INVALID_SCOPE", "Unknown search scope");
    conditions.push(`(${columns.map((column) => `${column} LIKE ?`).join(" OR ")})`);
    values.push(...columns.map(() => `%${query}%`));
  }
  const favorite = url.searchParams.get("favorite");
  if (favorite !== null) {
    if (favorite !== "true" && favorite !== "false") throw new CloudHttpError(400, "INVALID_FILTER", "favorite must be true or false");
    conditions.push("favorite = ?");
    values.push(favorite === "true" ? 1 : 0);
  }
  const unsupported = (url.searchParams.get("status") && url.searchParams.get("status") !== "ready") ||
    url.searchParams.get("archived") === "true" ||
    Boolean(url.searchParams.get("tag") || url.searchParams.get("collectionId") || url.searchParams.get("captureMode"));
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
  const sort = url.searchParams.get("sort") === "title" ? "lower(title) COLLATE BINARY ASC, id ASC" :
    url.searchParams.get("sort") === "created" ? "created_at DESC, id ASC" : "updated_at DESC, id ASC";
  const rows = await db.prepare(
    `SELECT ${summaryColumns} FROM cloud_documents ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`,
  ).bind(...values, window?.limit ?? 30, window?.offset ?? (page - 1) * 30).all<DocumentSummaryRow>();
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

export async function createArticle(db: D1Database, title: string) {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  await db.prepare(`INSERT INTO cloud_documents(
    id, source_url, title, markdown, status, source_note, revision, created_at, updated_at
  ) VALUES (?, ?, ?, '', 'ready', '织页新建文章', 1, ?, ?)`).bind(
    id, `zhiye://article/${id}`, title, timestamp, timestamp,
  ).run();
  return await getDocument(db, id);
}

function documentRevision(body: Record<string, unknown>, permanent = false) {
  const allowed = permanent ? ["revision", "draftRevision"] : ["revision"];
  if (Object.keys(body).some((key) => !allowed.includes(key)) ||
    typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 1 ||
    (permanent && body.draftRevision !== null && body.draftRevision !== undefined)) {
    throw new CloudHttpError(400, "INVALID_DOCUMENT_UPDATE", "A positive revision is required");
  }
  return body.revision;
}

export async function trashDocument(db: D1Database, id: string, body: Record<string, unknown>) {
  const revision = documentRevision(body);
  const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE cloud_documents SET deleted_at = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL`).bind(now, now, id, revision).run();
  if (changes(result) === 1) return await getDocument(db, id);
  const current = await getDocument(db, id);
  if (!current) throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  if (current.revision !== revision) throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", current);
  throw new CloudHttpError(409, "DOCUMENT_DELETED", "Document is already in the trash", current);
}

export async function restoreDocument(db: D1Database, id: string, body: Record<string, unknown>) {
  const revision = documentRevision(body);
  const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE cloud_documents SET deleted_at = NULL, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL`).bind(now, id, revision).run();
  if (changes(result) === 1) return await getDocument(db, id);
  const current = await getDocument(db, id);
  if (!current) throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  if (current.revision !== revision) throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", current);
  throw new CloudHttpError(409, "NOT_IN_TRASH", "Document is not in the trash", current);
}

export async function permanentlyDeleteDocument(db: D1Database, id: string, body: Record<string, unknown>) {
  const revision = documentRevision(body, true);
  const result = await db.prepare("DELETE FROM cloud_documents WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL")
    .bind(id, revision).run();
  if (changes(result) === 1) return;
  const current = await getDocument(db, id);
  if (!current) throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  if (current.revision !== revision) throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", current);
  throw new CloudHttpError(409, "NOT_IN_TRASH", "Document must be in the trash before permanent deletion", current);
}

export async function updateDocument(db: D1Database, id: string, body: Record<string, unknown>) {
  const keys = Object.keys(body);
  const hasTitle = Object.hasOwn(body, "title");
  const hasMarkdown = Object.hasOwn(body, "markdown");
  const hasFolder = Object.hasOwn(body, "folderId");
  const hasFavorite = Object.hasOwn(body, "favorite");
  if (keys.some((key) => !["title", "markdown", "folderId", "favorite", "revision"].includes(key)) ||
    typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 1 ||
    hasTitle !== hasMarkdown || (!hasTitle && !hasFolder && !hasFavorite) ||
    (hasFavorite && typeof body.favorite !== "boolean") ||
    (hasTitle && (typeof body.title !== "string" || !body.title.trim() || body.title.length > 1_000 ||
      typeof body.markdown !== "string" || encoder.encode(body.markdown).byteLength > MAX_CLOUD_ROW_TEXT_BYTES ||
      unsafeControl.test(body.title) || unsafeControl.test(body.markdown)))) {
    throw new CloudHttpError(400, "INVALID_DOCUMENT_UPDATE", "A positive revision and a valid content or folder change are required");
  }
  const folderId = hasFolder ? folderIdValue(body.folderId) : undefined;
  const assignments: string[] = [];
  const values: unknown[] = [];
  if (hasTitle) {
    assignments.push("title = ?", "markdown = ?");
    values.push((body.title as string).trim(), body.markdown);
  }
  if (hasFolder) {
    assignments.push("folder_id = ?");
    values.push(folderId);
  }
  if (hasFavorite) {
    assignments.push("favorite = ?");
    values.push(body.favorite ? 1 : 0);
  }
  const now = new Date().toISOString();
  const result = await db.prepare(
    `UPDATE cloud_documents SET ${assignments.join(", ")}, revision = revision + 1, updated_at = ?
     WHERE id = ? AND revision = ? AND deleted_at IS NULL${folderId ? " AND EXISTS (SELECT 1 FROM cloud_folders WHERE id = ?)" : ""}`,
  ).bind(...values, now, id, body.revision, ...(folderId ? [folderId] : [])).run();
  if (changes(result) !== 1) {
    const current = await getDocument(db, id);
    if (!current) throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    if (current.revision !== body.revision) {
      throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", current);
    }
    if (current.deletedAt) throw new CloudHttpError(409, "DOCUMENT_DELETED", "Restore the document before changing it", current);
    if (folderId && !await getFolder(db, folderId)) throw new CloudHttpError(400, "INVALID_FOLDER_ID", "folderId does not reference an existing folder");
    throw new CloudHttpError(409, "DOCUMENT_CONFLICT", "Document was updated elsewhere", current);
  }
  return await getDocument(db, id);
}
