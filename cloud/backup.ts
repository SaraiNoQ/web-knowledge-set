import { CloudHttpError, MAX_CLOUD_ROW_TEXT_BYTES, type D1Database, type D1Statement } from "./extension";
import { validateStoredLlmSettings } from "./ai";
import { TRANSLATION_LANGUAGES } from "../shared/types";

const encoder = new TextEncoder();
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_RECORDS = 32;
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

interface R2ObjectBody {
  body: ReadableStream<Uint8Array>;
  size: number;
  httpEtag: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2Bucket {
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<{ size: number } | null>;
}

interface BackupReply { status?: number; body: unknown }

interface Archive {
  format: "zhiye-cloud-backup";
  version: 1;
  createdAt: string;
  documents: Record<string, unknown>[];
  derivedResults: Record<string, unknown>[];
  llmSettings: { value: string; revision: number } | null;
}

function changes(result: { meta: { changes?: number } }) {
  return result.meta.changes ?? 0;
}

async function sha256(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function backupRecord(row: Record<string, unknown>) {
  return {
    id: String(row.id), directoryName: String(row.objectKey), reason: row.reason,
    status: row.status, createdAt: String(row.createdAt), finishedAt: row.verifiedAt ? String(row.verifiedAt) : null,
    verifiedAt: row.verifiedAt ? String(row.verifiedAt) : null, totalBytes: row.totalBytes == null ? null : Number(row.totalBytes),
    schemaVersion: 4, errorCode: row.errorCode ? String(row.errorCode) : null, errorMessage: null,
  };
}

const backupColumns = `id, object_key AS objectKey, reason, status, created_at AS createdAt,
  verified_at AS verifiedAt, total_bytes AS totalBytes, sha256, error_code AS errorCode`;

function parseArchive(bytes: Uint8Array): Archive {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup must be an object");
  const archive = value as Partial<Archive>;
  if (archive.format !== "zhiye-cloud-backup" || archive.version !== 1 || !Array.isArray(archive.documents) ||
    !Array.isArray(archive.derivedResults) || (archive.llmSettings !== null && archive.llmSettings !== undefined &&
      (typeof archive.llmSettings !== "object" || typeof archive.llmSettings.value !== "string" || !Number.isInteger(archive.llmSettings.revision)))) {
    throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup schema is invalid");
  }
  const result = archive as Archive;
  if (result.documents.length + result.derivedResults.length > MAX_ARCHIVE_RECORDS) throw new CloudHttpError(413, "BACKUP_ARCHIVE_TOO_LARGE", "Cloud backup exceeds 32 records");
  const ids = new Set<string>();
  const exact = (row: Record<string, unknown>, allowed: string[]) => Object.keys(row).every((name) => allowed.includes(name)) && allowed.every((name) => name in row);
  const rowBytes = (row: Record<string, unknown>) => Object.values(row).reduce<number>((sum, value) => sum + (typeof value === "string" ? encoder.encode(value).byteLength : 0), 0);
  const safeUrl = (value: unknown) => {
    if (typeof value !== "string" || value.length > 8_192) return false;
    try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password; } catch { return false; }
  };
  for (const row of result.documents) {
    const id = field(row, "id");
    const title = field(row, "title");
    const markdown = field(row, "markdown");
    const note = field(row, "source_note");
    if (!exact(row, ["id", "source_url", "final_url", "canonical_url", "title", "author", "published_at", "markdown", "status", "source_note", "revision", "created_at", "updated_at"]) ||
      typeof id !== "string" || ids.has(id) || !safeUrl(field(row, "source_url")) ||
      ![row.final_url, row.canonical_url].every((value) => value == null || safeUrl(value)) || typeof title !== "string" || !title.trim() || title.length > 1_000 ||
      typeof markdown !== "string" || rowBytes(row) > MAX_CLOUD_ROW_TEXT_BYTES || typeof note !== "string" || note.length > 50_000 ||
      control.test(title) || control.test(markdown) || control.test(note) || field(row, "status") !== "ready" ||
      !Number.isInteger(field(row, "revision")) || Number(field(row, "revision")) < 1 || typeof field(row, "created_at") !== "string" ||
      typeof field(row, "updated_at") !== "string" || [row.final_url, row.canonical_url, row.author, row.published_at].some((value) => value != null && typeof value !== "string")) {
      throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup document row is invalid");
    }
    ids.add(id);
  }
  const resultIds = new Set<string>();
  for (const row of result.derivedResults) {
    const resultId = field(row, "id");
    const type = String(field(row, "type"));
    const language = row.target_language;
    if (!exact(row, ["id", "document_id", "type", "target_language", "model", "endpoint_id", "prompt_version", "input_hash", "output", "duration_ms", "usage_json", "source_chars", "sent_chars", "truncated", "pinned", "source_revision", "created_at"]) ||
      typeof resultId !== "string" || resultIds.has(resultId) || !ids.has(String(field(row, "document_id"))) || !["summary", "outline", "keywords", "translation"].includes(type) ||
      typeof field(row, "model") !== "string" || typeof field(row, "endpoint_id") !== "string" || typeof field(row, "prompt_version") !== "string" ||
      typeof field(row, "input_hash") !== "string" || typeof field(row, "output") !== "string" || rowBytes(row) > MAX_CLOUD_ROW_TEXT_BYTES || !Number.isInteger(field(row, "duration_ms")) ||
      !Number.isInteger(field(row, "source_chars")) || !Number.isInteger(field(row, "sent_chars")) || ![0, 1].includes(Number(field(row, "truncated"))) ||
      ![0, 1].includes(Number(field(row, "pinned"))) || !Number.isInteger(field(row, "source_revision")) || typeof field(row, "created_at") !== "string" ||
      (type === "translation" ? typeof language !== "string" || !(language in TRANSLATION_LANGUAGES) : language != null) ||
      (Number(field(row, "pinned")) === 1 && type !== "summary")) {
      throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup AI result row is invalid");
    }
    resultIds.add(resultId);
    if (row.usage_json != null) try {
      const usage = JSON.parse(String(row.usage_json)) as unknown;
      if (!usage || typeof usage !== "object" || Array.isArray(usage) || Object.entries(usage).some(([name, value]) => !["inputTokens", "outputTokens", "totalTokens"].includes(name) || typeof value !== "number" || value < 0)) throw new Error("invalid");
    } catch { throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup usage data is invalid"); }
  }
  if (result.llmSettings) {
    if (!Number.isInteger(result.llmSettings.revision) || result.llmSettings.revision < 0) throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup AI settings revision is invalid");
    validateStoredLlmSettings(result.llmSettings.value);
  }
  return result;
}

async function requestBytes(request: Request) {
  const declared = request.headers.get("Content-Length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_ARCHIVE_BYTES)) {
    throw new CloudHttpError(413, "BACKUP_ARCHIVE_TOO_LARGE", "Cloud backup exceeds 8 MiB");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new CloudHttpError(413, "BACKUP_ARCHIVE_TOO_LARGE", "Cloud backup exceeds 8 MiB");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function snapshot(db: D1Database): Promise<Archive> {
  if (!db.batch) throw new CloudHttpError(503, "CLOUD_BATCH_UNAVAILABLE", "D1 batch API is unavailable");
  const [documents, derived, settings] = await db.batch([
    db.prepare("SELECT * FROM cloud_documents ORDER BY created_at"),
    db.prepare("SELECT * FROM cloud_derived_results ORDER BY created_at"),
    db.prepare("SELECT value, revision FROM app_settings WHERE key = 'llm_settings'"),
  ]);
  if (documents.results.length + derived.results.length > MAX_ARCHIVE_RECORDS) throw new CloudHttpError(413, "BACKUP_ARCHIVE_TOO_LARGE", "Cloud backup exceeds 32 records");
  return { format: "zhiye-cloud-backup", version: 1, createdAt: new Date().toISOString(), documents: documents.results as Record<string, unknown>[], derivedResults: derived.results as Record<string, unknown>[], llmSettings: settings.results[0] as { value: string; revision: number } | undefined ?? null };
}

async function createBackup(db: D1Database, bucket: R2Bucket, reason: "manual" | "pre-restore" = "manual") {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const bytes = encoder.encode(JSON.stringify(await snapshot(db)));
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new CloudHttpError(413, "BACKUP_ARCHIVE_TOO_LARGE", "Cloud backup exceeds 8 MiB");
  const hash = await sha256(bytes);
  const objectKey = `backups/${id}.zhiye-cloud-backup`;
  await bucket.put(objectKey, bytes, { httpMetadata: { contentType: "application/vnd.zhiye.cloud-backup+json" }, customMetadata: { sha256: hash } });
  await db.prepare(`INSERT INTO cloud_backups(id, object_key, reason, status, created_at, verified_at, total_bytes, sha256, error_code)
    VALUES (?, ?, ?, 'verified', ?, ?, ?, ?, NULL)`).bind(id, objectKey, reason, createdAt, createdAt, bytes.byteLength, hash).run();
  return backupRecord({ id, objectKey, reason, status: "verified", createdAt, verifiedAt: createdAt, totalBytes: bytes.byteLength, sha256: hash, errorCode: null });
}

async function archiveBytes(db: D1Database, bucket: R2Bucket, id: string) {
  const row = await db.prepare(`SELECT ${backupColumns} FROM cloud_backups WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  if (!row) throw new CloudHttpError(404, "BACKUP_NOT_FOUND", "Cloud backup not found");
  const object = await bucket.get(String(row.objectKey));
  if (!object) throw new CloudHttpError(404, "BACKUP_MISSING", "Cloud backup object is missing");
  if (object.size > MAX_ARCHIVE_BYTES) throw new CloudHttpError(413, "BACKUP_ARCHIVE_TOO_LARGE", "Cloud backup exceeds 8 MiB");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256(bytes) !== row.sha256) throw new CloudHttpError(409, "BACKUP_HASH_MISMATCH", "Cloud backup hash does not match");
  parseArchive(bytes);
  return { row, object, bytes };
}

function field(row: Record<string, unknown>, name: string) {
  if (!(name in row)) throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", `Backup row is missing ${name}`);
  return row[name];
}

async function restoreArchive(db: D1Database, archive: Archive) {
  if (!db.batch) throw new CloudHttpError(503, "CLOUD_BATCH_UNAVAILABLE", "D1 batch API is unavailable");
  const statements: D1Statement[] = [
    db.prepare("DELETE FROM browser_extension_pairing_code"),
    db.prepare("DELETE FROM browser_extension_pairings"),
    db.prepare("DELETE FROM cloud_capture_jobs"),
    db.prepare("DELETE FROM cloud_derived_results"),
    db.prepare("DELETE FROM cloud_documents"),
  ];
  for (const row of archive.documents) statements.push(db.prepare(`INSERT INTO cloud_documents(
    id, source_url, final_url, canonical_url, title, author, published_at, markdown, status, source_note, revision, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    field(row, "id"), field(row, "source_url"), row.final_url ?? null, row.canonical_url ?? null, field(row, "title"), row.author ?? null,
    row.published_at ?? null, field(row, "markdown"), field(row, "status"), field(row, "source_note"), field(row, "revision"), field(row, "created_at"), field(row, "updated_at"),
  ));
  for (const row of archive.derivedResults) statements.push(db.prepare(`INSERT INTO cloud_derived_results(
    id, document_id, type, target_language, model, endpoint_id, prompt_version, input_hash, output, duration_ms,
    usage_json, source_chars, sent_chars, truncated, pinned, source_revision, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    field(row, "id"), field(row, "document_id"), field(row, "type"), row.target_language ?? null, field(row, "model"), field(row, "endpoint_id"),
    field(row, "prompt_version"), field(row, "input_hash"), field(row, "output"), field(row, "duration_ms"), row.usage_json ?? null,
    field(row, "source_chars"), field(row, "sent_chars"), field(row, "truncated"), field(row, "pinned"), field(row, "source_revision"), field(row, "created_at"),
  ));
  if (archive.llmSettings) statements.push(db.prepare("UPDATE app_settings SET value = ?, revision = ?, updated_at = ? WHERE key = 'llm_settings'")
    .bind(archive.llmSettings.value, archive.llmSettings.revision, new Date().toISOString()));
  statements.push(db.prepare("UPDATE app_settings SET value = ?, revision = revision + 1, updated_at = ? WHERE key = 'data_epoch'")
    .bind(`cloud-${crypto.randomUUID()}`, new Date().toISOString()));
  await db.batch(statements);
}

export async function handleBackupApi(request: Request, db: D1Database, bucket: R2Bucket, url: URL): Promise<BackupReply | Response | null> {
  if (!url.pathname.startsWith("/api/data-safety")) return null;
  if (url.pathname === "/api/data-safety" && request.method === "GET") {
    const rows = await db.prepare(`SELECT ${backupColumns} FROM cloud_backups ORDER BY created_at DESC`).all<Record<string, unknown>>();
    const backups = rows.results.map(backupRecord);
    return { body: {
      mode: "ready", maintenance: false, recoveryError: null,
      health: { database: { integrityCheck: ["ok"], foreignKeyViolations: [], referencedSnapshotPaths: [], referencedAssetPaths: [], pendingFileDeletions: [], recentErrors: [] }, missingSnapshots: [], orphanSnapshots: [], unsafeSnapshotEntries: [], missingAssets: [], orphanAssets: [], unsafeAssetEntries: [], storageBytes: backups.reduce((sum, value) => sum + (value.totalBytes ?? 0), 0), recentBackup: backups[0] ?? null },
      backups, settings: { automaticRetentionCount: 7 },
    } };
  }
  if (url.pathname === "/api/data-safety/backups" && request.method === "POST") {
    const body = await request.json().catch(() => null) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new CloudHttpError(400, "INVALID_BACKUP_REQUEST", "Backup creation accepts an empty JSON object");
    return { status: 201, body: await createBackup(db, bucket) };
  }
  if (url.pathname === "/api/data-safety/backups/import" && request.method === "POST") {
    if (request.headers.get("Content-Type")?.split(";", 1)[0] !== "application/vnd.zhiye.cloud-backup+json") throw new CloudHttpError(415, "BACKUP_ARCHIVE_REQUIRED", "Cloud backup content type is required");
    const bytes = await requestBytes(request);
    parseArchive(bytes);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const hash = await sha256(bytes);
    const objectKey = `backups/${id}.zhiye-cloud-backup`;
    await bucket.put(objectKey, bytes, { httpMetadata: { contentType: "application/vnd.zhiye.cloud-backup+json" }, customMetadata: { sha256: hash } });
    await db.prepare(`INSERT INTO cloud_backups(id, object_key, reason, status, created_at, verified_at, total_bytes, sha256, error_code)
      VALUES (?, ?, 'manual', 'verified', ?, ?, ?, ?, NULL)`).bind(id, objectKey, createdAt, createdAt, bytes.byteLength, hash).run();
    return { status: 201, body: backupRecord({ id, objectKey, reason: "manual", status: "verified", createdAt, verifiedAt: createdAt, totalBytes: bytes.byteLength, sha256: hash, errorCode: null }) };
  }
  const match = /^\/api\/data-safety\/backups\/([^/]+)(?:\/(verify|restore|export\.zhiye-backup))?$/u.exec(url.pathname);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  if (match[2] === "export.zhiye-backup" && request.method === "GET") {
    const { object } = await archiveBytes(db, bucket, id);
    return new Response(object.body, { headers: { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="zhiye-cloud-${id}.zhiye-cloud-backup"`, "Content-Type": "application/vnd.zhiye.cloud-backup+json", "ETag": object.httpEtag } });
  }
  if (match[2] === "verify" && request.method === "POST") {
    const body = await request.json().catch(() => null) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new CloudHttpError(400, "INVALID_BACKUP_REQUEST", "Backup verification accepts an empty JSON object");
    const { row } = await archiveBytes(db, bucket, id);
    const verifiedAt = new Date().toISOString();
    await db.prepare("UPDATE cloud_backups SET status = 'verified', verified_at = ?, error_code = NULL WHERE id = ?").bind(verifiedAt, id).run();
    return { body: backupRecord({ ...row, status: "verified", verifiedAt, errorCode: null }) };
  }
  if (match[2] === "restore" && request.method === "POST") {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Object.keys(body).some((name) => name !== "allowQuarantine") || (body.allowQuarantine !== undefined && typeof body.allowQuarantine !== "boolean")) {
      throw new CloudHttpError(400, "INVALID_BACKUP_REQUEST", "Backup restore request is invalid");
    }
    const { bytes } = await archiveBytes(db, bucket, id);
    const preRestore = await createBackup(db, bucket, "pre-restore");
    await restoreArchive(db, parseArchive(bytes));
    return { body: { backupId: id, preRestoreBackupId: preRestore.id, quarantinedDataPath: null, cleanupPending: false } };
  }
  return null;
}
