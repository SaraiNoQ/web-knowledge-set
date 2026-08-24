import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { StatementSync } from "node:sqlite";
import { unzipSync } from "fflate";

import { BackupError, createBackup, type VerifiedBackup } from "./backup.js";
import { CURRENT_SCHEMA_VERSION, KnowledgeDatabase, derivedTargetLanguage } from "./db.js";
import type { BackupRecord, DerivedResultType } from "../shared/types.js";
import { TRANSLATION_LANGUAGES } from "../shared/types.js";

/**
 * Import a `zhiye-cloud-backup` (the Cloudflare Worker's JSON archive) into the
 * desktop app as a real, restorable `.zhiye-backup`.
 *
 * The cloud archive is a plain JSON object of structured records; the app backup
 * is a ZIP of a SQLite snapshot plus snapshots/ and assets/ directories. This
 * module builds a temporary database that matches the app's current schema,
 * ingests the cloud records into it (preserving document and folder ids so
 * derived results stay attached), and then runs the app's own `createBackup`
 * pipeline to produce a validated, restorable `.zhiye-backup` directory.
 *
 * The cloud never stores HTML snapshots or image assets, so those are empty in
 * the resulting backup by design; it is not data loss relative to the source.
 */

const FORMAT = "zhiye-cloud-backup";
const MAX_CLOUD_ARCHIVE_BYTES = 8 * 1024 * 1024;
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const safeIdentifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/u;
const sha256Re = /^[a-f0-9]{64}$/u;
const derivedTypes = new Set<DerivedResultType>([
  "summary",
  "outline",
  "keywords",
  "tag-suggestions",
  "translation",
]);

interface CloudFolder {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface CloudDocument {
  id: string;
  sourceUrl: string;
  finalUrl: string | null;
  canonicalUrl: string | null;
  title: string;
  author: string | null;
  publishedAt: string | null;
  markdown: string;
  sourceNote: string;
  folderId: string | null;
  deletedAt: string | null;
  favorite: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface CloudDerivedResult {
  id: string;
  documentId: string;
  type: DerivedResultType;
  model: string;
  endpointId: string;
  promptVersion: string;
  inputHash: string;
  output: string;
  durationMs: number;
  usageJson: string | null;
  sourceChars: number;
  sentChars: number;
  truncated: boolean;
  pinned: boolean;
  targetLanguage: string | null;
  createdAt: string;
}

interface CloudDerivedAsset {
  hash: string;
  mime: string;
  bytes: number;
}

interface CloudArchive {
  version: 1 | 2 | 3 | 4 | 5;
  createdAt: string;
  folders: CloudFolder[];
  documents: CloudDocument[];
  derivedResults: CloudDerivedResult[];
  llmSettings: { value: string; revision: number } | null;
  assets: CloudDerivedAsset[];
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new BackupError(code, message, cause);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value: unknown) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && safeIdentifier.test(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function safeUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 8_192) return false;
  try {
    const url = new URL(value);
    return ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) ||
      (url.protocol === "zhiye:" && url.hostname === "article" && /^\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(url.pathname));
  } catch {
    return false;
  }
}

function parseCloudArchive(bytes: Uint8Array): CloudArchive {
  if (bytes.byteLength > MAX_CLOUD_ARCHIVE_BYTES) {
    fail("BACKUP_ARCHIVE_TOO_LARGE", "Cloud backup exceeds 8 MiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("INVALID_BACKUP_ARCHIVE", "Cloud backup is not valid JSON");
  }
  if (!record(value)) fail("INVALID_BACKUP_ARCHIVE", "Cloud backup must be an object");
  const version = value.version;
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) {
    fail("UNSUPPORTED_FORMAT", "Unsupported cloud backup format version");
  }
  if (value.format !== FORMAT) fail("INVALID_BACKUP_ARCHIVE", "Cloud backup format is unknown");
  if (!timestamp(value.createdAt)) fail("INVALID_BACKUP_ARCHIVE", "Cloud backup createdAt is invalid");
  if (!Array.isArray(value.documents) || !Array.isArray(value.derivedResults)) {
    fail("INVALID_BACKUP_ARCHIVE", "Cloud backup must contain documents and derivedResults");
  }
  const folders = version === 1 ? [] : value.folders;
  if (!Array.isArray(folders)) fail("INVALID_BACKUP_ARCHIVE", "Cloud backup folders are invalid");

  const folderIds = new Set<string>();
  const folderNames = new Set<string>();
  const parsedFolders: CloudFolder[] = folders.map((entry, index) => {
    if (!record(entry)) fail("INVALID_BACKUP_ARCHIVE", `Cloud backup folder ${index} is invalid`);
    const id = entry.id;
    const name = entry.name;
    if (!identifier(id) || folderIds.has(id) || typeof name !== "string" || !name || name.length > 100 ||
      name !== name.normalize("NFKC").trim() || control.test(name) || folderNames.has(name.toLowerCase()) ||
      !timestamp(entry.created_at) || !timestamp(entry.updated_at)) {
      fail("INVALID_BACKUP_ARCHIVE", `Cloud backup folder ${index} is invalid`);
    }
    folderIds.add(id);
    folderNames.add(name.toLowerCase());
    return { id, name, createdAt: entry.created_at, updatedAt: entry.updated_at } as CloudFolder;
  });

  const documentIds = new Set<string>();
  const documentSourceUrls = new Set<string>();
  const parsedDocuments: CloudDocument[] = value.documents.map((entry, index) => {
    if (!record(entry)) fail("INVALID_BACKUP_ARCHIVE", `Cloud backup document ${index} is invalid`);
    const id = entry.id;
    const title = entry.title;
    const markdown = entry.markdown;
    const sourceUrl = entry.source_url;
    const folderId = version === 1 ? null : entry.folder_id ?? null;
    const deletedAt = version >= 3 ? (entry.deleted_at ?? null) : null;
    const favorite = version >= 4 ? (entry.favorite ?? 0) : 0;
    if (!identifier(id) || documentIds.has(id) || typeof sourceUrl !== "string" || !safeUrl(sourceUrl) ||
      documentSourceUrls.has(sourceUrl) || typeof title !== "string" || !title.trim() || title.length > 1_000 ||
      typeof markdown !== "string" || typeof entry.source_note !== "string" || entry.source_note.length > 50_000 ||
      control.test(title) || control.test(markdown) || control.test(entry.source_note) ||
      entry.status !== "ready" || !positiveInteger(entry.revision) || !timestamp(entry.created_at) ||
      !timestamp(entry.updated_at) || ![entry.final_url, entry.canonical_url, entry.author, entry.published_at].every(
        (item) => item == null || typeof item === "string",
      ) || ([entry.final_url, entry.canonical_url].some((item) => item != null && !safeUrl(item))) ||
      (folderId !== null && (!identifier(folderId) || !folderIds.has(folderId))) ||
      (deletedAt !== null && !timestamp(deletedAt)) || (favorite !== 0 && favorite !== 1)) {
      fail("INVALID_BACKUP_ARCHIVE", `Cloud backup document ${index} is invalid`);
    }
    documentIds.add(id);
    documentSourceUrls.add(sourceUrl);
    return {
      id,
      sourceUrl,
      finalUrl: entry.final_url ?? null,
      canonicalUrl: entry.canonical_url ?? null,
      title,
      author: entry.author ?? null,
      publishedAt: entry.published_at ?? null,
      markdown,
      sourceNote: entry.source_note,
      folderId,
      deletedAt,
      favorite: favorite === 1,
      revision: entry.revision,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
    } as CloudDocument;
  });

  const derivedResults: CloudDerivedResult[] = value.derivedResults.map((entry, index) => {
    if (!record(entry)) fail("INVALID_BACKUP_ARCHIVE", `Cloud backup AI result ${index} is invalid`);
    const id = entry.id;
    const type = entry.type;
    const language = entry.target_language;
    if (!identifier(id) || !identifier(entry.document_id) || !documentIds.has(entry.document_id) ||
      typeof type !== "string" || !derivedTypes.has(type as DerivedResultType) ||
      (type === "translation" ? typeof language !== "string" || !Object.hasOwn(TRANSLATION_LANGUAGES, language) : language != null) ||
      typeof entry.model !== "string" || typeof entry.endpoint_id !== "string" ||
      typeof entry.prompt_version !== "string" || typeof entry.input_hash !== "string" ||
      typeof entry.output !== "string" || !sha256Re.test(entry.input_hash) ||
      !nonNegativeInteger(entry.duration_ms) || !nonNegativeInteger(entry.source_chars) ||
      !nonNegativeInteger(entry.sent_chars) || (entry.truncated !== 0 && entry.truncated !== 1) ||
      (entry.pinned !== 0 && entry.pinned !== 1) || (entry.pinned === 1 && type !== "summary") ||
      !timestamp(entry.created_at) || (entry.usage_json != null && typeof entry.usage_json !== "string")) {
      fail("INVALID_BACKUP_ARCHIVE", `Cloud backup AI result ${index} is invalid`);
    }
    return {
      id,
      documentId: entry.document_id,
      type: type as DerivedResultType,
      model: entry.model,
      endpointId: entry.endpoint_id,
      promptVersion: entry.prompt_version,
      inputHash: entry.input_hash,
      output: entry.output,
      durationMs: entry.duration_ms,
      usageJson: entry.usage_json ?? null,
      sourceChars: entry.source_chars,
      sentChars: entry.sent_chars,
      truncated: entry.truncated === 1,
      pinned: entry.pinned === 1,
      targetLanguage: type === "translation" ? language : null,
      createdAt: entry.created_at,
    } as CloudDerivedResult;
  });

  let llmSettings: CloudArchive["llmSettings"] = null;
  if (value.llmSettings !== null) {
    if (!value.llmSettings || typeof value.llmSettings !== "object" || !record(value.llmSettings) ||
      typeof value.llmSettings.value !== "string" || !nonNegativeInteger(value.llmSettings.revision)) {
      fail("INVALID_BACKUP_ARCHIVE", "Cloud backup AI settings are invalid");
    }
    if (!parseLlmSettingsValue(value.llmSettings.value)) {
      fail("INVALID_BACKUP_ARCHIVE", "Cloud backup AI settings are invalid");
    }
    llmSettings = { value: value.llmSettings.value, revision: value.llmSettings.revision };
  }

  let assets: CloudDerivedAsset[] = [];
  if (version === 5) {
    if (!Array.isArray(value.assets)) fail("INVALID_BACKUP_ARCHIVE", "Cloud backup assets are invalid");
    const seen = new Set<string>();
    assets = value.assets.map((entry, index) => {
      if (!record(entry) || typeof entry.hash !== "string" || !/^[a-f0-9]{64}$/u.test(entry.hash) ||
        seen.has(entry.hash) || typeof entry.mime !== "string" || !entry.mime ||
        !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0 || Number(entry.bytes) > 512 * 1024 * 1024) {
        fail("INVALID_BACKUP_ARCHIVE", `Cloud backup asset ${index} is invalid`);
      }
      seen.add(entry.hash);
      return { hash: entry.hash, mime: entry.mime, bytes: Number(entry.bytes) };
    });
  }

  return {
    version: version as 1 | 2 | 3 | 4 | 5,
    createdAt: value.createdAt as string,
    folders: parsedFolders,
    documents: parsedDocuments,
    derivedResults,
    llmSettings,
    assets,
  };
}

function parseLlmSettingsValue(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!record(parsed)) return false;
  const settings = parsed;
  const remote = settings.remote;
  const local = settings.local;
  if (!record(remote) || !record(local)) return false;
  return typeof settings.enabled === "boolean" &&
    (settings.target === "remote" || settings.target === "local") &&
    typeof remote.endpointUrl === "string" && typeof remote.model === "string" &&
    typeof local.endpointUrl === "string" && typeof local.model === "string" &&
    typeof local.trusted === "boolean";
}

function ingest(database: KnowledgeDatabase, archive: CloudArchive) {
  const sql = database.sql;
  const timestamp = new Date().toISOString();
  sql.exec("BEGIN IMMEDIATE");
  try {
    const insertFolder = sql.prepare(
      "INSERT INTO folders(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    );
    for (const folder of archive.folders) {
      insertFolder.run(folder.id, folder.name, folder.createdAt, folder.updatedAt);
    }

    const insertDocument = sql.prepare(
      `INSERT INTO documents(
         id, source_url, final_url, canonical_url, title, author, published_at, markdown, status,
         title_edited, markdown_edited, author_edited, published_at_edited, favorite, archived_at,
         source_note, folder_id, revision, deleted_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', 1, 1, 1, 1, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    );
    for (const document of archive.documents) {
      insertDocument.run(
        document.id, document.sourceUrl, document.finalUrl, document.canonicalUrl, document.title,
        document.author, document.publishedAt, document.markdown, document.favorite ? 1 : 0,
        document.sourceNote, document.folderId, document.revision, document.deletedAt,
        document.createdAt, document.updatedAt,
      );
    }

    const insertDerived = sql.prepare(
      `INSERT OR IGNORE INTO derived_results(
         id, document_id, type, model, endpoint_id, prompt_version, input_hash, output,
         duration_ms, usage_json, source_chars, sent_chars, truncated, pinned, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const result of archive.derivedResults) {
      ingestDerivedResult(insertDerived, result);
    }

    if (archive.llmSettings) {
      sql.prepare(
        `INSERT INTO app_settings(key, value, revision, updated_at)
         VALUES ('llm', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, revision = excluded.revision, updated_at = excluded.updated_at`,
      ).run(archive.llmSettings.value, Math.max(1, archive.llmSettings.revision), timestamp);
    }

    sql.exec("COMMIT");
  } catch (error) {
    sql.exec("ROLLBACK");
    throw error;
  }
}

function ingestDerivedResult(
  insert: StatementSync,
  result: CloudDerivedResult,
) {
  let promptVersion = result.promptVersion.slice(0, 100);
  if (result.type === "translation") {
    const language = result.targetLanguage && Object.hasOwn(TRANSLATION_LANGUAGES, result.targetLanguage)
      ? result.targetLanguage
      : null;
    if (language && !derivedTargetLanguage("translation", promptVersion)) {
      promptVersion = `translation-v1-p40000:${language}`;
    }
  }
  let model = result.model.slice(0, 200);
  let endpointId = result.endpointId.slice(0, 100);
  let sourceChars = result.sourceChars;
  let sentChars = result.sentChars;
  if (sourceChars < 1) sourceChars = 1;
  if (sourceChars > 10_485_760) sourceChars = 10_485_760;
  if (sentChars < 1) sentChars = 1;
  if (sentChars > sourceChars) sentChars = sourceChars;
  const durationMs = result.durationMs > 86_400_000 ? 86_400_000 : result.durationMs;
  let usageJson = result.usageJson;
  if (usageJson !== null) {
    try {
      const parsed: unknown = JSON.parse(usageJson);
      if (!record(parsed) || Array.isArray(parsed)) throw new Error("invalid usage");
    } catch {
      usageJson = null;
    }
  }
  if (!model || !endpointId || !promptVersion || !result.output || result.output.length < 1 ||
    Buffer.byteLength(result.output, "utf8") > 2 * 1024 * 1024) {
    return;
  }

  insert.run(
    randomUUID(), result.documentId, result.type, model, endpointId, promptVersion, result.inputHash,
    result.output, durationMs, usageJson, sourceChars, sentChars, sentChars < sourceChars ? 1 : 0,
    result.pinned ? 1 : 0, result.createdAt,
  );
}

function ingestAssets(database: KnowledgeDatabase, archive: CloudArchive, assetBytes: Map<string, Uint8Array>) {
  if (!archive.assets.length) return;
  const timestamp = new Date().toISOString();
  if (!existsSync(database.assetsDir)) mkdirSync(database.assetsDir, { recursive: true, mode: 0o700 });
  const insertAsset = database.sql.prepare(
    "INSERT INTO assets(hash, mime, bytes, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING",
  );
  const insertMapping = database.sql.prepare(
    `INSERT INTO document_assets(document_id, source_url, status, asset_hash, created_at, updated_at)
     VALUES (?, ?, 'ready', ?, ?, ?)
     ON CONFLICT(document_id, source_url) DO UPDATE SET
       status = 'ready', asset_hash = ?, error_code = NULL, error_message = NULL, updated_at = excluded.updated_at`,
  );
  for (const asset of archive.assets) {
    const bytes = assetBytes.get(asset.hash);
    if (!bytes || bytes.byteLength !== asset.bytes) {
      fail("INVALID_BACKUP_ARCHIVE", "Cloud backup asset bytes are missing");
    }
    writeFileSync(database.assetFilePath(asset.hash), bytes, { mode: 0o600, flag: "wx" });
    insertAsset.run(asset.hash, asset.mime, asset.bytes, timestamp);
    for (const document of archive.documents) {
      const uri = `zhiye://asset/${asset.hash}`;
      if (document.markdown.includes(uri)) {
        insertMapping.run(document.id, uri, asset.hash, timestamp, timestamp, asset.hash);
      }
    }
  }
}

function parseCloudZip(bytes: Uint8Array): { archive: CloudArchive; assetBytes: Map<string, Uint8Array> } {
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(bytes);
  } catch {
    fail("INVALID_BACKUP_ARCHIVE", "Cloud backup ZIP is invalid");
  }
  let total = 0;
  for (const value of Object.values(unpacked)) {
    total += value.byteLength;
    if (total > 2 * 1024 * 1024 * 1024) fail("INVALID_BACKUP_ARCHIVE", "Cloud backup unpacked data exceeds the archive budget");
  }
  const manifest = unpacked["manifest.json"];
  if (!manifest) fail("INVALID_BACKUP_ARCHIVE", "Cloud backup ZIP is missing its manifest");
  const archive = parseCloudArchive(manifest);
  const assetBytes = new Map<string, Uint8Array>();
  for (const asset of archive.assets) {
    const value = unpacked[`assets/${asset.hash}`];
    if (!value) fail("INVALID_BACKUP_ARCHIVE", `Cloud backup ZIP is missing an asset`);
    assetBytes.set(asset.hash, value);
  }
  return { archive, assetBytes };
}

export async function importCloudZipBackup(
  db: KnowledgeDatabase | null,
  dataDir: string,
  backupRoot: string,
  bytes: Uint8Array,
  supportedSchemaVersion: number,
  signal?: AbortSignal,
): Promise<BackupRecord> {
  if (signal?.aborted) fail("REQUEST_ABORTED", "Backup archive operation was aborted");
  if (!Number.isSafeInteger(supportedSchemaVersion) || supportedSchemaVersion < 1) {
    fail("INVALID_SUPPORTED_SCHEMA", "supportedSchemaVersion must be a positive safe integer");
  }
  const { archive, assetBytes } = parseCloudZip(bytes);
  if (signal?.aborted) fail("REQUEST_ABORTED", "Backup archive operation was aborted");

  const temporaryDataDir = mkdtempSync(join(tmpdir(), "zhiye-cloud-"));
  chmodSync(temporaryDataDir, 0o700);
  let database: KnowledgeDatabase | undefined;
  try {
    database = new KnowledgeDatabase(temporaryDataDir);
    if (database.getSchemaVersion() !== CURRENT_SCHEMA_VERSION) {
      fail("UNSUPPORTED_SCHEMA", "Cloud backup could not be staged at the supported schema version");
    }
    ingest(database, archive);
    ingestAssets(database, archive, assetBytes);
    const backup = await createBackup({
      dataDir: temporaryDataDir,
      backupRoot,
      database: database.sql,
      reason: "manual",
    });
    if (backup.manifest.schemaVersion > supportedSchemaVersion) {
      fail("UNSUPPORTED_SCHEMA", "Cloud backup was created by a newer version of Zhiye");
    }
    const record = verifiedRecord(backup);
    db?.upsertBackupRecord(record);
    return record;
  } finally {
    database?.close();
    rmSync(temporaryDataDir, { recursive: true, force: true });
  }
}

export async function importCloudJsonBackup(
  db: KnowledgeDatabase | null,
  dataDir: string,
  backupRoot: string,
  bytes: Uint8Array,
  supportedSchemaVersion: number,
  signal?: AbortSignal,
): Promise<BackupRecord> {
  if (signal?.aborted) fail("REQUEST_ABORTED", "Backup archive operation was aborted");
  if (!Number.isSafeInteger(supportedSchemaVersion) || supportedSchemaVersion < 1) {
    fail("INVALID_SUPPORTED_SCHEMA", "supportedSchemaVersion must be a positive safe integer");
  }
  if (bytes.byteLength > MAX_CLOUD_ARCHIVE_BYTES) {
    fail("BACKUP_ARCHIVE_TOO_LARGE", "Cloud backup exceeds 8 MiB");
  }
  const archive = parseCloudArchive(bytes);
  if (signal?.aborted) fail("REQUEST_ABORTED", "Backup archive operation was aborted");

  const temporaryDataDir = mkdtempSync(join(tmpdir(), "zhiye-cloud-"));
  chmodSync(temporaryDataDir, 0o700);
  let database: KnowledgeDatabase | undefined;
  try {
    database = new KnowledgeDatabase(temporaryDataDir);
    if (database.getSchemaVersion() !== CURRENT_SCHEMA_VERSION) {
      fail("UNSUPPORTED_SCHEMA", "Cloud backup could not be staged at the supported schema version");
    }
    ingest(database, archive);
    const backup = await createBackup({
      dataDir: temporaryDataDir,
      backupRoot,
      database: database.sql,
      reason: "manual",
    });
    if (backup.manifest.schemaVersion > supportedSchemaVersion) {
      fail("UNSUPPORTED_SCHEMA", "Cloud backup was created by a newer version of Zhiye");
    }
    const record = verifiedRecord(backup);
    db?.upsertBackupRecord(record);
    return record;
  } finally {
    database?.close();
    rmSync(temporaryDataDir, { recursive: true, force: true });
  }
}

function verifiedRecord(backup: VerifiedBackup): BackupRecord {
  const directoryName = basename(backup.path);
  const timestamp = new Date().toISOString();
  return {
    id: directoryName,
    directoryName,
    reason: "manual",
    status: "verified",
    createdAt: backup.manifest.createdAt,
    finishedAt: timestamp,
    verifiedAt: timestamp,
    totalBytes: backup.manifest.totalBytes,
    schemaVersion: backup.manifest.schemaVersion,
    errorCode: null,
    errorMessage: null,
  };
}
