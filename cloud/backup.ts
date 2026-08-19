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

interface BackupReply { status?: number; body: unknown; epoch?: string }

interface ArchiveV1 {
  format: "zhiye-cloud-backup";
  version: 1;
  createdAt: string;
  documents: Record<string, unknown>[];
  derivedResults: Record<string, unknown>[];
  llmSettings: { value: string; revision: number } | null;
}

interface ArchiveV2 extends Omit<ArchiveV1, "version"> {
  version: 2;
  folders: Record<string, unknown>[];
}

interface ArchiveV3 extends Omit<ArchiveV2, "version"> {
  version: 3;
}

type Archive = ArchiveV1 | ArchiveV2 | ArchiveV3;

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
    schemaVersion: 7, errorCode: row.errorCode ? String(row.errorCode) : null, errorMessage: null,
  };
}

const backupColumns = `id, object_key AS objectKey, reason, status, created_at AS createdAt,
  verified_at AS verifiedAt, total_bytes AS totalBytes, sha256, error_code AS errorCode`;

function parseArchive(bytes: Uint8Array): Archive {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup must be an object");
  }
  const raw = value as Record<string, unknown>;
  const version = raw.version;
  const topFields = version === 1
    ? ["format", "version", "createdAt", "documents", "derivedResults", "llmSettings"]
    : ["format", "version", "createdAt", "folders", "documents", "derivedResults", "llmSettings"];
  if ((version !== 1 && version !== 2 && version !== 3) || !exact(raw, topFields) || raw.format !== "zhiye-cloud-backup" ||
    !timestamp(raw.createdAt) || !Array.isArray(raw.documents) || !Array.isArray(raw.derivedResults) ||
    (version !== 1 && !Array.isArray(raw.folders))) {
    throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup schema is invalid");
  }
  const result = raw as unknown as Archive;
  const folders = result.version === 1 ? [] : result.folders;
  if (folders.length + result.documents.length + result.derivedResults.length > MAX_ARCHIVE_RECORDS) {
    throw new CloudHttpError(413, "BACKUP_ARCHIVE_TOO_LARGE", "Cloud backup exceeds 32 records");
  }

  const folderIds = new Set<string>();
  const folderNames = new Set<string>();
  for (const row of folders) {
    if (!record(row)) throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup folder row is invalid");
    const id = row.id;
    const name = row.name;
    if (!exact(row, ["id", "name", "created_at", "updated_at"]) || !identifier(id) || folderIds.has(id) ||
      typeof name !== "string" || !name || name.length > 100 || name !== name.normalize("NFKC").trim() || control.test(name) ||
      folderNames.has(sqliteNoCase(name)) || !timestamp(row.created_at) || !timestamp(row.updated_at)) {
      throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup folder row is invalid");
    }
    folderIds.add(id);
    folderNames.add(sqliteNoCase(name));
  }

  const documentIds = new Set<string>();
  const documentFields = ["id", "source_url", "final_url", "canonical_url", "title", "author", "published_at", "markdown", "status", "source_note", "revision", "created_at", "updated_at"];
  for (const row of result.documents) {
    if (!record(row)) throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup document row is invalid");
    const id = row.id;
    const title = row.title;
    const markdown = row.markdown;
    const note = row.source_note;
    const folderId = result.version === 1 ? null : row.folder_id;
    const deletedAt = result.version === 3 ? row.deleted_at : null;
    const expectedFields = result.version === 1 ? documentFields : result.version === 2 ? [...documentFields, "folder_id"] : [...documentFields, "folder_id", "deleted_at"];
    if (!exact(row, expectedFields) || !identifier(id) || documentIds.has(id) ||
      !safeUrl(row.source_url) || ![row.final_url, row.canonical_url].every((entry) => entry == null || safeUrl(entry)) ||
      typeof title !== "string" || !title.trim() || title.length > 1_000 || typeof markdown !== "string" ||
      rowBytes(row) > MAX_CLOUD_ROW_TEXT_BYTES || typeof note !== "string" || note.length > 50_000 ||
      control.test(title) || control.test(markdown) || control.test(note) || row.status !== "ready" ||
      !positiveInteger(row.revision) || !timestamp(row.created_at) || !timestamp(row.updated_at) ||
      (deletedAt !== null && !timestamp(deletedAt)) ||
      [row.final_url, row.canonical_url, row.author, row.published_at].some((entry) => entry != null && typeof entry !== "string") ||
      (folderId !== null && (!identifier(folderId) || !folderIds.has(folderId)))) {
      throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup document row is invalid");
    }
    documentIds.add(id);
  }

  const resultIds = new Set<string>();
  for (const row of result.derivedResults) {
    if (!record(row)) throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup AI result row is invalid");
    const resultId = row.id;
    const type = row.type;
    const language = row.target_language;
    if (!exact(row, ["id", "document_id", "type", "target_language", "model", "endpoint_id", "prompt_version", "input_hash", "output", "duration_ms", "usage_json", "source_chars", "sent_chars", "truncated", "pinned", "source_revision", "created_at"]) ||
      !identifier(resultId) || resultIds.has(resultId) || !identifier(row.document_id) || !documentIds.has(row.document_id) ||
      typeof type !== "string" || !["summary", "outline", "keywords", "translation"].includes(type) ||
      ![row.model, row.endpoint_id, row.prompt_version, row.input_hash, row.output].every((entry) => typeof entry === "string") ||
      rowBytes(row) > MAX_CLOUD_ROW_TEXT_BYTES || !nonNegativeInteger(row.duration_ms) || !nonNegativeInteger(row.source_chars) ||
      !nonNegativeInteger(row.sent_chars) || (row.truncated !== 0 && row.truncated !== 1) || (row.pinned !== 0 && row.pinned !== 1) ||
      !positiveInteger(row.source_revision) || !timestamp(row.created_at) ||
      (type === "translation" ? typeof language !== "string" || !Object.hasOwn(TRANSLATION_LANGUAGES, language) : language != null) ||
      (row.pinned === 1 && type !== "summary")) {
      throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup AI result row is invalid");
    }
    resultIds.add(resultId);
    if (row.usage_json != null) try {
      const usage = JSON.parse(String(row.usage_json)) as unknown;
      if (!usage || typeof usage !== "object" || Array.isArray(usage) ||
        Object.entries(usage).some(([name, entry]) => !["inputTokens", "outputTokens", "totalTokens"].includes(name) || !nonNegativeInteger(entry))) {
        throw new Error("invalid");
      }
    } catch { throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup usage data is invalid"); }
  }

  if (result.llmSettings !== null) {
    if (!result.llmSettings || typeof result.llmSettings !== "object" ||
      !exact(result.llmSettings as unknown as Record<string, unknown>, ["value", "revision"]) ||
      typeof result.llmSettings.value !== "string" || !nonNegativeInteger(result.llmSettings.revision)) {
      throw new CloudHttpError(400, "INVALID_BACKUP_ARCHIVE", "Cloud backup AI settings are invalid");
    }
    validateStoredLlmSettings(result.llmSettings.value);
  }
  return result;
}

function exact(row: Record<string, unknown>, fields: string[]) {
  return Object.keys(row).length === fields.length && fields.every((name) => Object.hasOwn(row, name));
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && value === value.trim() && !control.test(value);
}

function timestamp(value: unknown) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function positiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function sqliteNoCase(value: string) {
  return value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

function rowBytes(row: Record<string, unknown>) {
  return Object.values(row).reduce<number>((sum, value) => sum + (typeof value === "string" ? encoder.encode(value).byteLength : 0), 0);
}

function safeUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 8_192) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch { return false; }
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
  const [folders, documents, derived, settings] = await db.batch([
    db.prepare("SELECT * FROM cloud_folders ORDER BY created_at"),
    db.prepare("SELECT * FROM cloud_documents ORDER BY created_at"),
    db.prepare("SELECT * FROM cloud_derived_results ORDER BY created_at"),
    db.prepare("SELECT value, revision FROM app_settings WHERE key = 'llm_settings'"),
  ]);
  if (folders.results.length + documents.results.length + derived.results.length > MAX_ARCHIVE_RECORDS) {
    throw new CloudHttpError(413, "BACKUP_ARCHIVE_TOO_LARGE", "Cloud backup exceeds 32 records");
  }
  return {
    format: "zhiye-cloud-backup", version: 3, createdAt: new Date().toISOString(),
    folders: folders.results as Record<string, unknown>[], documents: documents.results as Record<string, unknown>[],
    derivedResults: derived.results as Record<string, unknown>[],
    llmSettings: settings.results[0] as { value: string; revision: number } | undefined ?? null,
  };
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

async function reserveRestore(db: D1Database, expectedEpoch: string) {
  const token = `restore:${Date.now() + 15 * 60_000}:${crypto.randomUUID()}`;
  const reserved = await db.prepare(
    "UPDATE app_settings SET value = ?, revision = revision + 1, updated_at = ? WHERE key = 'data_epoch' AND value = ?",
  ).bind(token, new Date().toISOString(), expectedEpoch).run();
  if (changes(reserved) !== 1) {
    throw new CloudHttpError(409, "STALE_DATA_EPOCH", "Cloud data changed; reload before restoring");
  }
  return token;
}

async function releaseRestore(db: D1Database, token: string, expectedEpoch: string) {
  if (!db.batch) throw new CloudHttpError(503, "CLOUD_BATCH_UNAVAILABLE", "D1 batch API is unavailable");
  const timestamp = new Date().toISOString();
  const [, released] = await db.batch([
    db.prepare(`UPDATE cloud_capture_jobs SET status = 'failed', error_code = 'RESTORE_INTERRUPTED',
      revision = revision + 1, updated_at = ? WHERE status IN ('queued', 'fetching')
      AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'data_epoch' AND value = ?)`).bind(timestamp, token),
    db.prepare(
      "UPDATE app_settings SET value = ?, revision = revision + 1, updated_at = ? WHERE key = 'data_epoch' AND value = ?",
    ).bind(expectedEpoch, timestamp, token),
  ]);
  if (changes(released!) === 1) return expectedEpoch;
  return (await db.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").first<{ value: string }>())?.value ?? expectedEpoch;
}

async function restoreArchive(db: D1Database, archive: Archive, reservation: string, finalEpoch: string) {
  if (!db.batch) throw new CloudHttpError(503, "CLOUD_BATCH_UNAVAILABLE", "D1 batch API is unavailable");
  const statements: D1Statement[] = [
    db.prepare(`SELECT CASE
      WHEN EXISTS (SELECT 1 FROM app_settings WHERE key = 'data_epoch' AND value = ?) THEN 1
      ELSE json('invalid restore reservation')
    END AS guarded`).bind(reservation),
    db.prepare("DELETE FROM browser_extension_pairing_code"),
    db.prepare("DELETE FROM browser_extension_pairings"),
    db.prepare("DELETE FROM cloud_capture_jobs"),
    db.prepare("DELETE FROM cloud_derived_results"),
    db.prepare("DELETE FROM cloud_documents"),
    db.prepare("DELETE FROM cloud_folders"),
  ];
  if (archive.version !== 1) for (const row of archive.folders) statements.push(db.prepare(`INSERT INTO cloud_folders(
    id, name, created_at, updated_at
  ) VALUES (?, ?, ?, ?)`).bind(field(row, "id"), field(row, "name"), field(row, "created_at"), field(row, "updated_at")));
  for (const row of archive.documents) statements.push(db.prepare(`INSERT INTO cloud_documents(
    id, source_url, final_url, canonical_url, title, author, published_at, markdown, status, source_note, folder_id, revision, created_at, updated_at, deleted_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    field(row, "id"), field(row, "source_url"), row.final_url ?? null, row.canonical_url ?? null, field(row, "title"), row.author ?? null,
    row.published_at ?? null, field(row, "markdown"), field(row, "status"), field(row, "source_note"), archive.version === 1 ? null : row.folder_id,
    field(row, "revision"), field(row, "created_at"), field(row, "updated_at"), archive.version === 3 ? row.deleted_at : null,
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
  statements.push(db.prepare(
    "UPDATE app_settings SET value = ?, revision = revision + 1, updated_at = ? WHERE key = 'data_epoch' AND value = ?",
  ).bind(finalEpoch, new Date().toISOString(), reservation));
  await db.batch(statements);
}

export async function handleBackupApi(
  request: Request,
  db: D1Database,
  bucket: R2Bucket,
  url: URL,
  expectedEpoch?: string,
): Promise<BackupReply | Response | null> {
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
    const archive = parseArchive(bytes);
    if (!expectedEpoch) throw new CloudHttpError(409, "STALE_DATA_EPOCH", "Cloud restore requires the current data epoch");
    const reservation = await reserveRestore(db, expectedEpoch);
    try {
      const preRestore = await createBackup(db, bucket, "pre-restore");
      const finalEpoch = `cloud-${crypto.randomUUID()}`;
      await restoreArchive(db, archive, reservation, finalEpoch);
      return {
        body: { backupId: id, preRestoreBackupId: preRestore.id, quarantinedDataPath: null, cleanupPending: false },
        epoch: finalEpoch,
      };
    } catch (cause) {
      await releaseRestore(db, reservation, expectedEpoch);
      throw cause;
    }
  }
  return null;
}
