import type { SemanticIndexStepResult, SemanticSettings, SemanticSettingsInput, SemanticVectorEntry } from "../shared/types";
import {
  aggregateSemanticVectors,
  DEFAULT_SEMANTIC_MODEL,
  embedSemanticTexts,
  estimateSemanticChunkCount,
  extractSemanticMarkdown,
  SemanticEmbeddingError,
  semanticHash,
  SEMANTIC_CHUNKS_PER_STEP,
  SEMANTIC_FORMAT_VERSION,
  SEMANTIC_MAX_ATTEMPTS,
  SEMANTIC_RETRY_DELAYS_MS,
  isRetryableSemanticError,
  splitSemanticSections,
  type SemanticSourceSection,
} from "../shared/semantic";
import { CloudHttpError, getDocument, jsonObject, type D1Database } from "./extension";
import { getPaper } from "./paper";

const KEY_HEADER = "X-Zhiye-Embedding-Key";
const KEY_MAX_BYTES = 16 * 1024;
const SEMANTIC_CONFIG_CURRENT = "EXISTS (SELECT 1 FROM app_settings WHERE key='semantic_settings' AND revision=? " +
  "AND json_extract(value,'$.enabled')=1 AND json_extract(value,'$.model')=?)";
const SEMANTIC_SOURCE_CURRENT = "EXISTS (SELECT 1 FROM cloud_documents d LEFT JOIN cloud_papers p ON p.id=d.id " +
  "WHERE d.id=? AND d.revision=? AND d.deleted_at IS NULL AND d.status='ready' AND " +
  "((d.kind='article' AND ? IS NULL) OR (d.kind='paper' AND p.status='ready' AND p.extraction_id=?)))";

interface SemanticReply { body: unknown; status?: number }
interface SemanticSource {
  id: string;
  revision: number;
  extractionId: string | null;
  title: string;
  sections: SemanticSourceSection[];
}

function cloudError(status: number, code: string, message: string): CloudHttpError {
  return new CloudHttpError(status, code, message);
}

function key(request: Request) {
  const value = request.headers.get(KEY_HEADER)?.trim() || "";
  if (!value || new TextEncoder().encode(value).byteLength > KEY_MAX_BYTES || /\p{Cc}/u.test(value)) {
    throw cloudError(409, "SEMANTIC_KEY_MISSING", "Set the embedding API key before continuing");
  }
  return value;
}

function settingsRow(db: D1Database) {
  return db.prepare("SELECT value, revision FROM app_settings WHERE key = 'semantic_settings'")
    .first<{ value: string; revision: number }>();
}

async function settings(db: D1Database, apiKeyConfigured: boolean, includeEstimate = false): Promise<SemanticSettings> {
  const row = await settingsRow(db);
  const stored = row ? JSON.parse(row.value) as { enabled?: unknown; model?: unknown } : {};
  if (row && (typeof stored.enabled !== "boolean" || typeof stored.model !== "string")) {
    throw cloudError(500, "SEMANTIC_SETTINGS_INVALID", "Stored semantic settings are invalid");
  }
  const model = typeof stored.model === "string" ? stored.model : DEFAULT_SEMANTIC_MODEL;
  const [counts, runtime, estimateRows] = await Promise.all([
    db.prepare("SELECT SUM(CASE WHEN si.state IS NULL OR si.state = 'pending' THEN 1 ELSE 0 END) AS pending, " +
      "SUM(CASE WHEN si.state = 'indexing' THEN 1 ELSE 0 END) AS indexing, SUM(CASE WHEN si.state = 'ready' THEN 1 ELSE 0 END) AS ready, " +
      "SUM(CASE WHEN si.state = 'failed' THEN 1 ELSE 0 END) AS failed, COALESCE(SUM(si.chunk_done),0) AS chunksDone, " +
      "COALESCE(SUM(si.chunk_total),0) AS chunksTotal FROM cloud_documents d LEFT JOIN cloud_papers p ON p.id=d.id " +
      "LEFT JOIN cloud_semantic_indexes si ON si.document_id=d.id AND si.model=json_extract((SELECT value FROM app_settings WHERE key='semantic_settings'),'$.model') " +
      "AND si.format_version='" + SEMANTIC_FORMAT_VERSION + "' WHERE d.deleted_at IS NULL " +
      "AND ((d.kind='article' AND d.status='ready') OR (d.kind='paper' AND p.status='ready' AND p.extraction_id IS NOT NULL))")
      .first<Record<string, number | null>>(),
    db.prepare("SELECT value FROM app_settings WHERE key = 'semantic_runtime'").first<{ value: string }>(),
    includeEstimate ? db.prepare(
      "SELECT CASE WHEN d.kind='article' THEN length(d.markdown) ELSE COALESCE((" +
      "SELECT SUM(length(json_extract(block.value,'$.original'))) FROM cloud_paper_pages page,json_each(page.original_json) block " +
      "WHERE page.paper_id=d.id AND page.extraction_id=p.extraction_id),0) END AS sourceChars," +
      "si.chunk_total AS chunkTotal,si.chunk_done AS chunkDone FROM cloud_documents d LEFT JOIN cloud_papers p ON p.id=d.id " +
      "LEFT JOIN cloud_semantic_indexes si ON si.document_id=d.id AND si.model=? AND si.format_version=? " +
      "WHERE d.deleted_at IS NULL AND ((d.kind='article' AND d.status='ready') OR " +
      "(d.kind='paper' AND p.status='ready' AND p.extraction_id IS NOT NULL)) " +
      "AND (si.state IS NULL OR si.state IN ('pending','indexing'))",
    ).bind(model, SEMANTIC_FORMAT_VERSION).all<{ sourceChars: number; chunkTotal: number | null; chunkDone: number | null }>()
      : Promise.resolve({ results: [] as Array<{ sourceChars: number; chunkTotal: number | null; chunkDone: number | null }> }),
  ]);
  const runtimeValue = runtime ? JSON.parse(runtime.value) as { consecutiveFailures?: number; lastError?: string | null } : {};
  const estimatedPendingChunks = includeEstimate ? estimateRows.results.reduce((sum, row) => sum + (
    row.chunkTotal ? Math.max(0, Number(row.chunkTotal) - Number(row.chunkDone ?? 0)) : estimateSemanticChunkCount(Number(row.sourceChars ?? 0))
  ), 0) : null;
  return {
    enabled: stored.enabled === true,
    model,
    revision: row?.revision ?? 0,
    apiKeyConfigured,
    pendingDocuments: Number(counts?.pending ?? 0),
    indexingDocuments: Number(counts?.indexing ?? 0),
    indexedDocuments: Number(counts?.ready ?? 0),
    failedDocuments: Number(counts?.failed ?? 0),
    completedChunks: Number(counts?.chunksDone ?? 0),
    totalChunks: Number(counts?.chunksTotal ?? 0),
    estimatedPendingChunks,
    consecutiveFailures: runtimeValue.consecutiveFailures ?? 0,
    lastError: runtimeValue.lastError ?? null,
  };
}

function settingsInput(body: Record<string, unknown>): SemanticSettingsInput {
  if (Object.keys(body).some((name) => !["enabled", "model", "revision"].includes(name)) ||
    typeof body.enabled !== "boolean" || typeof body.model !== "string" ||
    !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) {
    throw cloudError(400, "INVALID_SEMANTIC_SETTINGS", "enabled, model and revision are required");
  }
  const model = body.model.trim();
  if (!model || model.length > 200 || /\p{Cc}/u.test(model)) {
    throw cloudError(400, "INVALID_SEMANTIC_SETTINGS", "model must contain 1-200 characters without controls");
  }
  return { enabled: body.enabled, model, revision: Number(body.revision) };
}

async function setSettings(db: D1Database, input: SemanticSettingsInput, apiKeyConfigured: boolean) {
  const current = await settings(db, apiKeyConfigured);
  if (input.revision !== current.revision) throw cloudError(409, "SEMANTIC_SETTINGS_CONFLICT", "Semantic settings changed in another window");
  if (current.model !== input.model && input.enabled) throw cloudError(409, "SEMANTIC_MODEL_CHANGE_REQUIRES_PAUSE", "Pause semantic indexing before changing its model");
  if (input.enabled && !apiKeyConfigured) throw cloudError(409, "SEMANTIC_KEY_MISSING", "Set the embedding API key before enabling semantic indexing");
  if (!db.batch) throw cloudError(503, "CLOUD_BATCH_UNAVAILABLE", "D1 batch support is required");
  const now = new Date().toISOString();
  const value = JSON.stringify({ enabled: input.enabled, model: input.model });
  const write = input.revision === 0
    ? db.prepare("INSERT OR IGNORE INTO app_settings(key,value,revision,updated_at) VALUES ('semantic_settings',?,1,?)").bind(value, now)
    : db.prepare("UPDATE app_settings SET value=?,revision=revision+1,updated_at=? WHERE key='semantic_settings' AND revision=?").bind(value, now, input.revision);
  const statements = [write];
  if (current.model !== input.model) statements.push(
    db.prepare("DELETE FROM cloud_semantic_indexes WHERE EXISTS (SELECT 1 FROM app_settings WHERE key='semantic_settings' AND revision=? AND value=?)")
      .bind(input.revision === 0 ? 1 : input.revision + 1, value),
    db.prepare("DELETE FROM app_settings WHERE key='semantic_runtime' AND EXISTS (SELECT 1 FROM app_settings WHERE key='semantic_settings' AND revision=? AND value=?)")
      .bind(input.revision === 0 ? 1 : input.revision + 1, value),
  );
  const result = await db.batch(statements);
  if ((result[0]?.meta.changes ?? 0) !== 1) throw cloudError(409, "SEMANTIC_SETTINGS_CONFLICT", "Semantic settings changed in another window");
  return await settings(db, apiKeyConfigured);
}

async function source(db: D1Database, id: string): Promise<SemanticSource | null> {
  const document = await getDocument(db, id);
  if (!document || document.deletedAt || document.status !== "ready") return null;
  if (document.kind === "article") {
    const text = extractSemanticMarkdown(document.markdown);
    return { id, revision: document.revision, extractionId: null, title: document.title, sections: text ? [{ pageNumber: null, text }] : [] };
  }
  const paper = await db.prepare("SELECT p.status,p.extraction_id AS extractionId,d.revision,d.title FROM cloud_papers p " +
    "JOIN cloud_documents d ON d.id=p.id WHERE p.id=? AND d.deleted_at IS NULL").bind(id)
    .first<{ status: string; extractionId: string | null; revision: number; title: string }>();
  if (!paper || paper.status !== "ready" || !paper.extractionId) return null;
  const pages = await db.prepare("SELECT page_number AS pageNumber,original_json AS originalJson FROM cloud_paper_pages " +
    "WHERE paper_id=? AND extraction_id=? ORDER BY page_number").bind(id, paper.extractionId).all<{ pageNumber: number; originalJson: string }>();
  return {
    id, revision: Number(paper.revision), extractionId: paper.extractionId, title: String(paper.title),
    sections: pages.results.map((page) => ({
      pageNumber: page.pageNumber,
      text: (JSON.parse(page.originalJson) as Array<{ original: string }>).map((block) => block.original).filter(Boolean).join("\n"),
    })).filter((section) => section.text.trim()),
  };
}

async function nextDocument(db: D1Database, now: number, model: string) {
  const row = await db.prepare("SELECT d.id FROM cloud_documents d LEFT JOIN cloud_papers p ON p.id=d.id " +
    "LEFT JOIN cloud_semantic_indexes si ON si.document_id=d.id WHERE d.deleted_at IS NULL " +
    "AND ((d.kind='article' AND d.status='ready') OR (d.kind='paper' AND p.status='ready' AND p.extraction_id IS NOT NULL)) " +
    "AND (si.document_id IS NULL OR si.model<>? OR si.format_version<>? OR " +
    "(si.state='pending' AND (si.attempts=0 OR (si.attempts=1 AND si.updated_at<=?) OR (si.attempts=2 AND si.updated_at<=?))) OR " +
    "(si.state='indexing' AND COALESCE(si.lease_until,0) < ?)) " +
    "ORDER BY d.updated_at,d.id LIMIT 1").bind(
      model, SEMANTIC_FORMAT_VERSION,
      new Date(now - SEMANTIC_RETRY_DELAYS_MS[0]).toISOString(),
      new Date(now - SEMANTIC_RETRY_DELAYS_MS[1]).toISOString(), now,
    ).first<{ id: string }>();
  return row?.id ?? null;
}

async function claim(db: D1Database, doc: SemanticSource, sourceHash: string, model: string, settingsRevision: number,
  chunkTotal: number, token: string, now: number) {
  if (!db.batch) throw cloudError(503, "CLOUD_BATCH_UNAVAILABLE", "D1 batch support is required");
  const currentTime = new Date(now).toISOString();
  const results = await db.batch([
    db.prepare("DELETE FROM cloud_semantic_indexes WHERE document_id=? AND " +
      "(source_hash<>? OR model<>? OR format_version<>?) AND " + SEMANTIC_CONFIG_CURRENT + " AND " + SEMANTIC_SOURCE_CURRENT)
      .bind(doc.id, sourceHash, model, SEMANTIC_FORMAT_VERSION, settingsRevision, model, doc.id, doc.revision, doc.extractionId, doc.extractionId),
    db.prepare("INSERT OR IGNORE INTO cloud_semantic_indexes(document_id,source_hash,model,format_version,state,chunk_total,updated_at) " +
      "SELECT ?,?,?,?, 'pending',?,? WHERE " + SEMANTIC_SOURCE_CURRENT + " AND " + SEMANTIC_CONFIG_CURRENT)
      .bind(doc.id, sourceHash, model, SEMANTIC_FORMAT_VERSION, chunkTotal, currentTime,
        doc.id, doc.revision, doc.extractionId, doc.extractionId, settingsRevision, model),
    db.prepare("UPDATE cloud_semantic_indexes SET state='indexing',chunk_total=?,lease_token=?,lease_until=?,updated_at=? " +
    "WHERE document_id=? AND source_hash=? AND model=? AND format_version=? AND state IN ('pending','indexing') " +
    "AND (lease_token IS NULL OR lease_until IS NULL OR lease_until<? OR lease_token=?) " +
      "AND " + SEMANTIC_CONFIG_CURRENT + " AND " + SEMANTIC_SOURCE_CURRENT)
      .bind(chunkTotal, token, now + 90_000, currentTime, doc.id, sourceHash, model, SEMANTIC_FORMAT_VERSION, now, token,
        settingsRevision, model, doc.id, doc.revision, doc.extractionId, doc.extractionId),
  ]);
  return (results[2]?.meta.changes ?? 0) === 1;
}

async function missingChunks(db: D1Database, id: string, total: number) {
  const rows = await db.prepare("SELECT chunk_index AS chunkIndex FROM cloud_semantic_chunks WHERE document_id=? ORDER BY chunk_index")
    .bind(id).all<{ chunkIndex: number }>();
  const present = new Set(rows.results.map((row) => Number(row.chunkIndex)));
  return Array.from({ length: total }, (_, index) => index).filter((index) => !present.has(index));
}

async function leaseIsCurrent(db: D1Database, doc: SemanticSource, sourceHash: string, model: string, settingsRevision: number, token: string) {
  return Boolean(await db.prepare("SELECT 1 FROM cloud_semantic_indexes si JOIN cloud_documents d ON d.id=si.document_id " +
    "LEFT JOIN cloud_papers p ON p.id=d.id WHERE si.document_id=? AND si.source_hash=? AND si.model=? AND si.format_version=? " +
    "AND si.state='indexing' AND si.lease_token=? AND si.lease_until>=? AND " + SEMANTIC_CONFIG_CURRENT + " " +
    "AND d.revision=? AND d.deleted_at IS NULL AND d.status='ready' AND " +
    "((d.kind='article' AND ? IS NULL) OR (d.kind='paper' AND p.status='ready' AND p.extraction_id=?))")
    .bind(doc.id, sourceHash, model, SEMANTIC_FORMAT_VERSION, token, Date.now(), settingsRevision, model,
      doc.revision, doc.extractionId, doc.extractionId).first());
}

async function storeChunks(db: D1Database, doc: SemanticSource, sourceHash: string, model: string, settingsRevision: number,
  token: string, chunks: Array<{ chunk: import("../shared/semantic").SemanticChunk; vector: number[] }>) {
  if (!db.batch) throw cloudError(503, "CLOUD_BATCH_UNAVAILABLE", "D1 batch support is required");
  const now = Date.now();
  const exists = "(SELECT 1 FROM cloud_semantic_indexes si JOIN cloud_documents d ON d.id=si.document_id " +
    "LEFT JOIN cloud_papers p ON p.id=d.id WHERE si.document_id=? AND si.source_hash=? AND si.model=? AND si.format_version=? " +
    "AND si.state='indexing' AND si.lease_token=? AND si.lease_until>=? " +
    "AND " + SEMANTIC_CONFIG_CURRENT + " " +
    "AND d.revision=? AND d.deleted_at IS NULL AND ((d.kind='article' AND d.status='ready') OR " +
    "(d.kind='paper' AND p.status='ready' AND p.extraction_id=?)))";
  const statements = chunks.map(({ chunk, vector }) => db.prepare(
    "INSERT INTO cloud_semantic_chunks(document_id,chunk_index,page_number,start_offset,end_offset,text_hash,vector_json) " +
    "SELECT ?,?,?,?,?,?,? WHERE EXISTS " + exists + " ON CONFLICT(document_id,chunk_index) DO UPDATE SET " +
    "page_number=excluded.page_number,start_offset=excluded.start_offset,end_offset=excluded.end_offset," +
    "text_hash=excluded.text_hash,vector_json=excluded.vector_json")
    .bind(doc.id, chunk.index, chunk.pageNumber, chunk.startOffset, chunk.endOffset, chunk.textHash, JSON.stringify(vector),
      doc.id, sourceHash, model, SEMANTIC_FORMAT_VERSION, token, now, settingsRevision, model, doc.revision, doc.extractionId));
  statements.push(db.prepare("UPDATE cloud_semantic_indexes SET chunk_done=(SELECT COUNT(*) FROM cloud_semantic_chunks WHERE document_id=?),updated_at=? " +
    "WHERE document_id=? AND lease_token=? AND lease_until>=? AND " + SEMANTIC_CONFIG_CURRENT + " AND " + SEMANTIC_SOURCE_CURRENT)
    .bind(doc.id, new Date(now).toISOString(), doc.id, token, now, settingsRevision, model,
      doc.id, doc.revision, doc.extractionId, doc.extractionId));
  const result = await db.batch(statements);
  return (result[result.length - 1]?.meta.changes ?? 0) === 1;
}

async function chunkVectors(db: D1Database, id: string) {
  const rows = await db.prepare("SELECT vector_json AS vectorJson FROM cloud_semantic_chunks WHERE document_id=? ORDER BY chunk_index")
    .bind(id).all<{ vectorJson: string }>();
  return rows.results.map((row) => JSON.parse(row.vectorJson) as number[]);
}

async function releaseLease(db: D1Database, id: string, token: string) {
  await db.prepare("UPDATE cloud_semantic_indexes SET lease_token=NULL,lease_until=NULL,updated_at=? WHERE document_id=? AND state='indexing' AND lease_token=?")
    .bind(new Date().toISOString(), id, token).run();
}

async function complete(db: D1Database, doc: SemanticSource, sourceHash: string, model: string, settingsRevision: number,
  token: string, vector: number[]) {
  if (!db.batch) throw cloudError(503, "CLOUD_BATCH_UNAVAILABLE", "D1 batch support is required");
  const now = new Date().toISOString();
  const update = db.prepare("UPDATE cloud_semantic_indexes SET state='ready',vector_json=?,lease_token=NULL,lease_until=NULL," +
    "error_code=NULL,chunk_done=chunk_total,updated_at=? WHERE document_id=? AND source_hash=? AND model=? " +
    "AND format_version=? AND state='indexing' AND lease_token=? AND lease_until>=? AND chunk_done=chunk_total " +
    "AND " + SEMANTIC_CONFIG_CURRENT + " AND " + SEMANTIC_SOURCE_CURRENT)
    .bind(JSON.stringify(vector), now, doc.id, sourceHash, model, SEMANTIC_FORMAT_VERSION, token, Date.now(),
      settingsRevision, model, doc.id, doc.revision, doc.extractionId, doc.extractionId);
  const resetFailures = db.prepare("DELETE FROM app_settings WHERE key='semantic_runtime' AND " +
    SEMANTIC_CONFIG_CURRENT + " AND EXISTS (SELECT 1 FROM cloud_semantic_indexes WHERE document_id=? AND source_hash=? " +
    "AND model=? AND format_version=? AND state='ready') AND " + SEMANTIC_SOURCE_CURRENT)
    .bind(settingsRevision, model, doc.id, sourceHash, model, SEMANTIC_FORMAT_VERSION, doc.id, doc.revision, doc.extractionId, doc.extractionId);
  const results = await db.batch([update, resetFailures]);
  return (results[0]?.meta.changes ?? 0) === 1;
}

async function failure(db: D1Database, doc: SemanticSource, model: string, settingsRevision: number, token: string, code: string) {
  const now = new Date().toISOString();
  const current = await db.prepare("SELECT attempts FROM cloud_semantic_indexes WHERE document_id=? AND state='indexing' AND lease_token=? " +
    "AND " + SEMANTIC_CONFIG_CURRENT + " AND " + SEMANTIC_SOURCE_CURRENT)
    .bind(doc.id, token, settingsRevision, model, doc.id, doc.revision, doc.extractionId, doc.extractionId).first<{ attempts: number }>();
  if (!current) {
    await releaseLease(db, doc.id, token).catch(() => undefined);
    return;
  }
  const attempts = Number(current.attempts) + 1;
  const state = isRetryableSemanticError(code) && attempts < SEMANTIC_MAX_ATTEMPTS ? "pending" : "failed";
  const update = db.prepare("UPDATE cloud_semantic_indexes SET state=?,attempts=attempts+1,error_code=?," +
    "lease_token=NULL,lease_until=NULL,updated_at=? WHERE document_id=? AND state='indexing' AND lease_token=? AND " +
    SEMANTIC_CONFIG_CURRENT + " AND " + SEMANTIC_SOURCE_CURRENT)
    .bind(state, code, now, doc.id, token, settingsRevision, model, doc.id, doc.revision, doc.extractionId, doc.extractionId);
  if (code === "SEMANTIC_EMPTY_CONTENT") {
    const result = await update.run();
    if ((result.meta.changes ?? 0) !== 1) await releaseLease(db, doc.id, token).catch(() => undefined);
    return;
  }
  if (!db.batch) throw cloudError(503, "CLOUD_BATCH_UNAVAILABLE", "D1 batch support is required");
  const runtime = db.prepare("INSERT INTO app_settings(key,value,revision,updated_at) " +
    "SELECT 'semantic_runtime',json_object('consecutiveFailures',1,'lastError',?),1,? WHERE EXISTS (" +
    "SELECT 1 FROM cloud_semantic_indexes WHERE document_id=? AND state=? AND attempts=? AND error_code=? AND updated_at=? AND lease_token IS NULL) " +
    "AND " + SEMANTIC_CONFIG_CURRENT + " ON CONFLICT(key) DO UPDATE SET value=json_set(app_settings.value,'$.consecutiveFailures'," +
    "COALESCE(json_extract(app_settings.value,'$.consecutiveFailures'),0)+1,'$.lastError',?)," +
    "revision=app_settings.revision+1,updated_at=excluded.updated_at")
    .bind(code, now, doc.id, state, attempts, code, now, settingsRevision, model, code);
  const disable = db.prepare("UPDATE app_settings SET value=json_set(value,'$.enabled',json('false')),revision=revision+1,updated_at=? " +
    "WHERE key='semantic_settings' AND revision=? AND json_extract(value,'$.model')=? AND json_extract(value,'$.enabled')=1 " +
    "AND (?=1 OR COALESCE((SELECT json_extract(value,'$.consecutiveFailures') FROM app_settings WHERE key='semantic_runtime'),0)>=3) " +
    "AND EXISTS (SELECT 1 FROM cloud_semantic_indexes WHERE document_id=? AND state=? AND attempts=? AND error_code=? AND updated_at=? AND lease_token IS NULL)")
    .bind(now, settingsRevision, model, Number(code === "SEMANTIC_AUTH_FAILED" || code === "SEMANTIC_KEY_INVALID"),
      doc.id, state, attempts, code, now);
  const result = await db.batch([update, runtime, disable]);
  if ((result[0]?.meta.changes ?? 0) !== 1) await releaseLease(db, doc.id, token).catch(() => undefined);
}

async function step(db: D1Database, request: Request): Promise<SemanticIndexStepResult> {
  const currentSettings = await settings(db, Boolean(request.headers.get(KEY_HEADER)));
  const empty = (status: SemanticIndexStepResult["status"], id: string | null, errorCode: string | null = null): SemanticIndexStepResult => ({
    status, documentId: id, completedChunks: currentSettings.completedChunks, totalChunks: currentSettings.totalChunks,
    pendingDocuments: currentSettings.pendingDocuments, errorCode,
  });
  if (!currentSettings.enabled) return empty("idle", null);
  const apiKey = key(request);
  const now = Date.now();
  const id = await nextDocument(db, now, currentSettings.model);
  if (!id) return empty("idle", null);
  const doc = await source(db, id);
  if (!doc) return empty("idle", id);
  const chunks = await splitSemanticSections(doc.sections);
  const sourceHash = await semanticHash(JSON.stringify([doc.title, doc.sections.map((section) => [section.pageNumber, section.text])]));
  const claimNow = Date.now();
  const token = crypto.randomUUID();
  if (!await claim(db, doc, sourceHash, currentSettings.model, currentSettings.revision, chunks.length, token, claimNow)) return empty("busy", id);
  try {
    if (!chunks.length) {
      await failure(db, doc, currentSettings.model, currentSettings.revision, token, "SEMANTIC_EMPTY_CONTENT");
      return empty("failed", id, "SEMANTIC_EMPTY_CONTENT");
    }
    const missing = await missingChunks(db, id, chunks.length);
    if (missing.length) {
      if (request.signal.aborted) {
        await releaseLease(db, id, token).catch(() => undefined);
        throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      if (!await leaseIsCurrent(db, doc, sourceHash, currentSettings.model, currentSettings.revision, token)) {
        await releaseLease(db, id, token).catch(() => undefined);
        return empty("idle", id);
      }
      const indexes = missing.slice(0, SEMANTIC_CHUNKS_PER_STEP);
      const title = Array.from(doc.title).slice(0, 128).join("");
      const vectors = await embedSemanticTexts(currentSettings.model, apiKey,
        indexes.map((index) => title + "\n\n" + chunks[index]!.text), request.signal ?? undefined);
      const saved = await storeChunks(db, doc, sourceHash, currentSettings.model, currentSettings.revision, token,
        indexes.map((index, offset) => ({ chunk: chunks[index]!, vector: vectors[offset]! })));
      if (!saved) {
        await releaseLease(db, id, token).catch(() => undefined);
        return empty("busy", id);
      }
    }
    if (await missingChunks(db, id, chunks.length).then((items) => items.length !== 0)) {
      await releaseLease(db, id, token);
      return empty("progress", id);
    }
    const aggregate = aggregateSemanticVectors(await chunkVectors(db, id), chunks);
    if (!await complete(db, doc, sourceHash, currentSettings.model, currentSettings.revision, token, aggregate)) {
      await releaseLease(db, id, token).catch(() => undefined);
      return empty("busy", id);
    }
    return empty("completed", id);
  } catch (cause) {
    if (request.signal.aborted) {
      await releaseLease(db, id, token).catch(() => undefined);
      throw request.signal.reason ?? cause;
    }
    const code = cause instanceof SemanticEmbeddingError ? cause.code : "SEMANTIC_INDEX_FAILED";
    await failure(db, doc, currentSettings.model, currentSettings.revision, token, code);
    if (cause instanceof SemanticEmbeddingError) throw cloudError(
      code === "SEMANTIC_AUTH_FAILED" ? 401 : code === "SEMANTIC_RATE_LIMITED" ? 429 : 502, code, cause.message,
    );
    throw cloudError(502, code, "Semantic indexing failed");
  }
}

export async function handleSemanticApi(request: Request, db: D1Database, url: URL): Promise<SemanticReply | null> {
  if (url.pathname === "/api/settings/semantic" && request.method === "GET") {
    const estimate = url.searchParams.get("estimate");
    if ([...url.searchParams.keys()].some((name) => name !== "estimate") || url.searchParams.getAll("estimate").length > 1 || (estimate !== null && estimate !== "true")) {
      throw cloudError(400, "INVALID_SEMANTIC_SETTINGS", "Semantic settings query parameters are invalid");
    }
    return { body: await settings(db, Boolean(request.headers.get(KEY_HEADER)), estimate === "true") };
  }
  if (url.pathname === "/api/settings/semantic" && request.method === "PUT") {
    const input = settingsInput(await jsonObject(request, 8_192));
    const configured = Boolean(request.headers.get(KEY_HEADER));
    if (input.enabled) key(request);
    return { body: await setSettings(db, input, configured) };
  }
  if (url.pathname === "/api/semantic/test" && request.method === "POST") {
    const body = await jsonObject(request, 8_192);
    if (Object.keys(body).length !== 1 || typeof body.model !== "string") throw cloudError(400, "INVALID_SEMANTIC_SETTINGS", "model is required");
    let vectors: number[][];
    try { vectors = await embedSemanticTexts(body.model, key(request), ["织页知识地图连接测试"], request.signal ?? undefined); }
    catch (cause) {
      if (cause instanceof SemanticEmbeddingError) throw cloudError(
        cause.code === "INVALID_SEMANTIC_REQUEST" ? 400 : cause.code === "SEMANTIC_AUTH_FAILED" ? 401 : cause.code === "SEMANTIC_RATE_LIMITED" ? 429 : 502,
        cause.code, cause.message,
      );
      throw cause;
    }
    return { body: { ok: true, model: body.model.trim(), dimension: vectors[0]!.length } };
  }
  if (url.pathname === "/api/semantic/index-step" && request.method === "POST") {
    const body = await jsonObject(request, 4_096);
    if (Object.keys(body).length) throw cloudError(400, "INVALID_SEMANTIC_REQUEST", "Index step accepts no fields");
    return { body: await step(db, request) };
  }
  if (url.pathname === "/api/semantic/retry" && request.method === "POST") {
    const body = await jsonObject(request, 4_096);
    if (Object.keys(body).length) throw cloudError(400, "INVALID_SEMANTIC_REQUEST", "Retry accepts no fields");
    const result = await db.prepare("UPDATE cloud_semantic_indexes SET state='pending',lease_token=NULL,lease_until=NULL,attempts=0,error_code=NULL,vector_json=NULL,updated_at=? WHERE state='failed'")
      .bind(new Date().toISOString()).run();
    await db.prepare("DELETE FROM app_settings WHERE key='semantic_runtime'").run();
    return { body: { affectedDocuments: result.meta.changes ?? 0 } };
  }
  if (url.pathname === "/api/semantic/rebuild" && request.method === "POST") {
    const body = await jsonObject(request, 4_096);
    if (Object.keys(body).length) throw cloudError(400, "INVALID_SEMANTIC_REQUEST", "Rebuild accepts no fields");
    const count = await db.prepare("SELECT COUNT(*) AS count FROM cloud_semantic_indexes").first<{ count: number }>();
    await db.prepare("DELETE FROM cloud_semantic_indexes").run();
    await db.prepare("DELETE FROM app_settings WHERE key='semantic_runtime'").run();
    return { body: { affectedDocuments: Number(count?.count ?? 0) } };
  }
  if (url.pathname === "/api/knowledge-map/vectors" && request.method === "GET") {
    const allowed = new Set(["cursor", "limit"]);
    for (const name of url.searchParams.keys()) if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1) {
      throw cloudError(400, "INVALID_SEMANTIC_PAGE", "Vector pagination parameters are invalid");
    }
    const cursor = url.searchParams.get("cursor") ?? "0";
    const limit = url.searchParams.get("limit") ?? "250";
    if (!/^(?:0|[1-9]\d*)$/u.test(cursor) || Number(cursor) > 1_000_000 || !/^[1-9]\d*$/u.test(limit) || Number(limit) > 500) {
      throw cloudError(400, "INVALID_SEMANTIC_PAGE", "Vector pagination parameters are invalid");
    }
    const current = await settings(db, false);
    if (!current.enabled) return { body: { items: [], total: 0, nextCursor: null } };
    const count = await db.prepare("SELECT COUNT(*) AS count FROM cloud_semantic_indexes WHERE state='ready' AND model=? AND format_version=?")
      .bind(current.model, SEMANTIC_FORMAT_VERSION).first<{ count: number }>();
    const rows = await db.prepare("SELECT document_id AS id,source_hash AS sourceHash,model,vector_json AS vectorJson " +
      "FROM cloud_semantic_indexes WHERE state='ready' AND model=? AND format_version=? ORDER BY document_id LIMIT ? OFFSET ?")
      .bind(current.model, SEMANTIC_FORMAT_VERSION, Number(limit), Number(cursor)).all<Record<string, unknown>>();
    const total = Number(count?.count ?? 0);
    const next = Number(cursor) + rows.results.length;
    return { body: {
      items: rows.results.map((row) => ({ id: String(row.id), sourceHash: String(row.sourceHash), model: String(row.model), formatVersion: SEMANTIC_FORMAT_VERSION, vector: JSON.parse(String(row.vectorJson)) as number[] } satisfies SemanticVectorEntry)),
      total, nextCursor: next < total ? String(next) : null,
    } };
  }
  return null;
}
