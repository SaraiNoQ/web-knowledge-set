import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AssetMimeType,
  AssetSettings,
  AssetStatus,
  BackupRecord,
  BackupSettings,
  BatchDocumentAction,
  BatchDocumentsResponse,
  CaptureErrorCode,
  CaptureHistoryItem,
  CaptureMode,
  CaptureStatus,
  DatabaseHealth,
  DocumentCollection,
  DocumentFilters,
  DocumentListResponse,
  DocumentDraft,
  DocumentRevision,
  DocumentSummary,
  DocumentAsset,
  DerivedResult,
  DerivedResultListResponse,
  DerivedResultType,
  DerivedResultUsage,
  KnowledgeDocument,
  KnowledgeCollection,
  KnowledgeTag,
  ImportApplyResult,
  ImportKind,
  ImportPreview,
  ImportStrategy,
  LlmEndpointKind,
  LlmSettings,
  RecentFilter,
  SaveDerivedResultInput,
  TagMutationResponse,
} from "../shared/types.js";

const PAGE_SIZE = 30;

interface StoredLlmSettings {
  enabled: boolean;
  target: LlmEndpointKind;
  remote: { endpointUrl: string; model: string };
  local: { endpointUrl: string; model: string; trusted: boolean };
}

const defaultLlmSettings: StoredLlmSettings = {
  enabled: false,
  target: "remote",
  remote: { endpointUrl: "", model: "" },
  local: { endpointUrl: "", model: "", trusted: false },
};

function parseLlmSettings(value: string): StoredLlmSettings {
  const parsed = JSON.parse(value) as Partial<StoredLlmSettings>;
  if (
    typeof parsed.enabled !== "boolean" ||
    (parsed.target !== "remote" && parsed.target !== "local") ||
    !parsed.remote || typeof parsed.remote.endpointUrl !== "string" || typeof parsed.remote.model !== "string" ||
    !parsed.local || typeof parsed.local.endpointUrl !== "string" || typeof parsed.local.model !== "string" ||
    typeof parsed.local.trusted !== "boolean"
  ) throw new Error("Stored LLM settings are invalid");
  return parsed as StoredLlmSettings;
}

const migrations = [
  `
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    source_url TEXT NOT NULL UNIQUE,
    canonical_url TEXT,
    title TEXT NOT NULL,
    author TEXT,
    published_at TEXT,
    markdown TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('queued', 'fetching', 'extracting', 'ready', 'failed')),
    warning TEXT,
    error_code TEXT,
    error_message TEXT,
    capture_mode TEXT CHECK (capture_mode IS NULL OR capture_mode IN ('http', 'browser')),
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE captures (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    job_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('fetching', 'extracting', 'ready', 'failed')),
    mode TEXT CHECK (mode IS NULL OR mode IN ('http', 'browser')),
    http_status INTEGER,
    snapshot_path TEXT,
    warning TEXT,
    error_code TEXT,
    error_message TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE capture_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX capture_jobs_one_active
    ON capture_jobs(document_id)
    WHERE status IN ('queued', 'running');
  CREATE INDEX capture_jobs_next ON capture_jobs(status, available_at, id);
  CREATE INDEX captures_document ON captures(document_id, started_at DESC);

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE
  );

  CREATE TABLE document_tags (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
  );
  CREATE INDEX document_tags_tag ON document_tags(tag_id, document_id);

  CREATE VIRTUAL TABLE documents_fts USING fts5(
    title,
    markdown,
    content='documents',
    content_rowid='rowid',
    tokenize='unicode61'
  );

  CREATE TRIGGER documents_fts_insert AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, markdown)
    VALUES (new.rowid, new.title, new.markdown);
  END;
  CREATE TRIGGER documents_fts_delete AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, markdown)
    VALUES ('delete', old.rowid, old.title, old.markdown);
  END;
  CREATE TRIGGER documents_fts_update AFTER UPDATE OF title, markdown ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, markdown)
    VALUES ('delete', old.rowid, old.title, old.markdown);
    INSERT INTO documents_fts(rowid, title, markdown)
    VALUES (new.rowid, new.title, new.markdown);
  END;
  `,
  `
  ALTER TABLE documents ADD COLUMN title_edited INTEGER NOT NULL DEFAULT 0
    CHECK (title_edited IN (0, 1));
  ALTER TABLE documents ADD COLUMN markdown_edited INTEGER NOT NULL DEFAULT 0
    CHECK (markdown_edited IN (0, 1));

  DROP TRIGGER documents_fts_insert;
  DROP TRIGGER documents_fts_delete;
  DROP TRIGGER documents_fts_update;
  DROP TABLE documents_fts;

  CREATE VIRTUAL TABLE documents_fts USING fts5(
    title,
    markdown,
    source_url,
    content='documents',
    content_rowid='rowid',
    tokenize='trigram'
  );
  INSERT INTO documents_fts(rowid, title, markdown, source_url)
    SELECT rowid, title, markdown, source_url FROM documents;

  CREATE TRIGGER documents_fts_insert AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, markdown, source_url)
    VALUES (new.rowid, new.title, new.markdown, new.source_url);
  END;
  CREATE TRIGGER documents_fts_delete AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, markdown, source_url)
    VALUES ('delete', old.rowid, old.title, old.markdown, old.source_url);
  END;
  CREATE TRIGGER documents_fts_update AFTER UPDATE OF title, markdown, source_url ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, markdown, source_url)
    VALUES ('delete', old.rowid, old.title, old.markdown, old.source_url);
    INSERT INTO documents_fts(rowid, title, markdown, source_url)
    VALUES (new.rowid, new.title, new.markdown, new.source_url);
  END;
  `,
  `
  ALTER TABLE documents ADD COLUMN final_url TEXT;
  ALTER TABLE captures ADD COLUMN request_url TEXT;
  ALTER TABLE captures ADD COLUMN final_url TEXT;
  ALTER TABLE captures ADD COLUMN extracted_title TEXT;
  ALTER TABLE captures ADD COLUMN extracted_author TEXT;
  ALTER TABLE captures ADD COLUMN extracted_published_at TEXT;
  ALTER TABLE captures ADD COLUMN extracted_canonical_url TEXT;
  ALTER TABLE captures ADD COLUMN extracted_markdown TEXT;

  UPDATE captures SET request_url = (
    SELECT source_url FROM documents WHERE documents.id = captures.document_id
  ) WHERE request_url IS NULL;
  `,
  `
  ALTER TABLE documents ADD COLUMN deleted_at TEXT;
  CREATE INDEX documents_deleted_updated ON documents(deleted_at, updated_at DESC);

  CREATE TABLE document_revisions (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    title TEXT NOT NULL,
    markdown TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (document_id, revision)
  );
  CREATE INDEX document_revisions_document
    ON document_revisions(document_id, revision DESC);

  INSERT INTO document_revisions(document_id, revision, title, markdown, tags_json, created_at)
  SELECT d.id, d.revision, d.title, d.markdown,
         COALESCE((
           SELECT json_group_array(name) FROM (
             SELECT t.name AS name FROM tags t
             JOIN document_tags dt ON dt.tag_id = t.id
             WHERE dt.document_id = d.id
             ORDER BY lower(t.name), t.name
           )
         ), '[]'),
         d.updated_at
  FROM documents d;
  `,
  `
  CREATE TABLE file_deletions (
    path TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE document_drafts (
    document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
    base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
    title TEXT NOT NULL,
    markdown TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE backup_records (
    id TEXT PRIMARY KEY,
    directory_name TEXT UNIQUE,
    reason TEXT NOT NULL CHECK (reason IN ('manual', 'automatic', 'pre-migration', 'pre-restore')),
    status TEXT NOT NULL CHECK (status IN ('creating', 'verified', 'failed', 'invalid', 'missing')),
    created_at TEXT NOT NULL,
    finished_at TEXT,
    verified_at TEXT,
    total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
    schema_version INTEGER CHECK (schema_version IS NULL OR schema_version >= 1),
    error_code TEXT,
    error_message TEXT
  );
  CREATE INDEX backup_records_created ON backup_records(created_at DESC, id DESC);

  CREATE TABLE backup_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    automatic_retention_count INTEGER NOT NULL DEFAULT 7
      CHECK (automatic_retention_count BETWEEN 1 AND 100)
  );
  INSERT INTO backup_settings(id, automatic_retention_count) VALUES (1, 7);
  `,
  `
  ALTER TABLE captures ADD COLUMN extractor_version TEXT;
  `,
  `
  CREATE TABLE assets (
    hash TEXT PRIMARY KEY
      CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
    mime TEXT NOT NULL
      CHECK (mime IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif')),
    bytes INTEGER NOT NULL CHECK (bytes >= 0),
    created_at TEXT NOT NULL
  );

  CREATE TABLE document_assets (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    source_url TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'fetching', 'ready', 'failed')),
    asset_hash TEXT REFERENCES assets(hash) ON DELETE RESTRICT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (document_id, source_url),
    CHECK ((status = 'ready' AND asset_hash IS NOT NULL) OR
           (status <> 'ready' AND asset_hash IS NULL))
  );
  CREATE INDEX document_assets_status ON document_assets(status, updated_at);
  CREATE INDEX document_assets_hash ON document_assets(asset_hash)
    WHERE asset_hash IS NOT NULL;

  CREATE TABLE asset_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    max_asset_bytes INTEGER NOT NULL DEFAULT 10485760
      CHECK (max_asset_bytes BETWEEN 1 AND 10485760),
    max_assets_per_document INTEGER NOT NULL DEFAULT 100
      CHECK (max_assets_per_document BETWEEN 1 AND 100),
    max_document_asset_bytes INTEGER NOT NULL DEFAULT 104857600
      CHECK (max_document_asset_bytes BETWEEN 1 AND 104857600),
    concurrency INTEGER NOT NULL DEFAULT 3 CHECK (concurrency BETWEEN 1 AND 3)
  );
  INSERT INTO asset_settings(
    id, max_asset_bytes, max_assets_per_document, max_document_asset_bytes, concurrency
  ) VALUES (1, 10485760, 100, 104857600, 3);
  `,
  `
  ALTER TABLE documents ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0
    CHECK (favorite IN (0, 1));
  ALTER TABLE documents ADD COLUMN archived_at TEXT;
  ALTER TABLE documents ADD COLUMN source_note TEXT NOT NULL DEFAULT '';
  ALTER TABLE documents ADD COLUMN author_edited INTEGER NOT NULL DEFAULT 0
    CHECK (author_edited IN (0, 1));
  ALTER TABLE documents ADD COLUMN published_at_edited INTEGER NOT NULL DEFAULT 0
    CHECK (published_at_edited IN (0, 1));
  CREATE INDEX documents_archive_favorite_updated
    ON documents(deleted_at, archived_at, favorite, updated_at DESC);

  CREATE TABLE collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE document_collections (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, collection_id)
  );
  CREATE INDEX document_collections_collection
    ON document_collections(collection_id, document_id);
  `,
  `
  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE import_batches (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('urls', 'bookmarks', 'markdown')),
    status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'applied')),
    strategy TEXT CHECK (strategy IS NULL OR strategy IN ('skip', 'copy', 'update')),
    created_at TEXT NOT NULL,
    applied_at TEXT
  );

  CREATE TABLE import_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    item_index INTEGER NOT NULL,
    label TEXT NOT NULL,
    source_url TEXT,
    preview_status TEXT NOT NULL CHECK (preview_status IN ('valid', 'duplicate', 'invalid')),
    existing_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    expected_revision INTEGER,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    payload_json TEXT NOT NULL,
    result_status TEXT CHECK (result_status IS NULL OR result_status IN ('created', 'updated', 'skipped', 'conflict', 'failed')),
    result_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    result_error TEXT,
    UNIQUE(batch_id, item_index)
  );
  CREATE INDEX import_items_batch ON import_items(batch_id, item_index);
  `,
  `
  ALTER TABLE import_items RENAME TO import_items_v12;
  ALTER TABLE import_batches RENAME TO import_batches_v12;
  DROP INDEX import_items_batch;

  CREATE TABLE import_batches (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('urls', 'bookmarks', 'markdown', 'bundle')),
    status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'applied')),
    strategy TEXT CHECK (strategy IS NULL OR strategy IN ('skip', 'copy', 'update')),
    staging_path TEXT,
    asset_count INTEGER NOT NULL DEFAULT 0 CHECK (asset_count >= 0),
    created_at TEXT NOT NULL,
    applied_at TEXT
  );

  CREATE TABLE import_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    item_index INTEGER NOT NULL,
    label TEXT NOT NULL,
    source_url TEXT,
    preview_status TEXT NOT NULL CHECK (preview_status IN ('valid', 'duplicate', 'invalid')),
    existing_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    expected_revision INTEGER,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    payload_json TEXT NOT NULL,
    result_status TEXT CHECK (result_status IS NULL OR result_status IN ('created', 'updated', 'skipped', 'conflict', 'failed')),
    result_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    result_error TEXT,
    UNIQUE(batch_id, item_index)
  );

  INSERT INTO import_batches(id, kind, status, strategy, created_at, applied_at)
    SELECT id, kind, status, strategy, created_at, applied_at FROM import_batches_v12;
  INSERT INTO import_items
    SELECT * FROM import_items_v12;
  DROP TABLE import_items_v12;
  DROP TABLE import_batches_v12;
  CREATE INDEX import_items_batch ON import_items(batch_id, item_index);
  `,
  `
  CREATE TABLE derived_results (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('summary', 'outline', 'keywords', 'tag-suggestions')),
    model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
    endpoint_id TEXT NOT NULL CHECK (length(endpoint_id) BETWEEN 1 AND 100),
    prompt_version TEXT NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 100),
    input_hash TEXT NOT NULL
      CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
    output TEXT NOT NULL CHECK (length(output) BETWEEN 1 AND 2097152),
    duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 0 AND 86400000),
    usage_json TEXT CHECK (
      usage_json IS NULL OR (json_valid(usage_json) AND json_type(usage_json) = 'object')
    ),
    source_chars INTEGER NOT NULL CHECK (source_chars BETWEEN 1 AND 10485760),
    sent_chars INTEGER NOT NULL CHECK (sent_chars BETWEEN 1 AND source_chars),
    truncated INTEGER NOT NULL CHECK (
      (truncated = 0 AND sent_chars = source_chars) OR
      (truncated = 1 AND sent_chars < source_chars)
    ),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (
      pinned IN (0, 1) AND (pinned = 0 OR type = 'summary')
    ),
    created_at TEXT NOT NULL,
    UNIQUE(document_id, type, model, endpoint_id, prompt_version, input_hash)
  );
  CREATE INDEX derived_results_document_created
    ON derived_results(document_id, created_at DESC, id DESC);
  CREATE UNIQUE INDEX derived_results_one_pinned_summary
    ON derived_results(document_id) WHERE type = 'summary' AND pinned = 1;

  CREATE TRIGGER derived_results_immutable
  BEFORE UPDATE OF id, document_id, type, model, endpoint_id, prompt_version,
                   input_hash, output, duration_ms, usage_json, source_chars,
                   sent_chars, truncated, created_at
  ON derived_results BEGIN
    SELECT RAISE(ABORT, 'derived results are immutable');
  END;
  `,
];

export const CURRENT_SCHEMA_VERSION = migrations.length;

export type DatabaseSchemaStatus = "empty" | "pending" | "current" | "future" | "non-contiguous";

export interface DatabaseSchemaInspection {
  status: DatabaseSchemaStatus;
  currentVersion: number;
  supportedVersion: number;
  appliedVersions: number[];
  pendingVersions: number[];
}

export class DatabaseSchemaError extends Error {
  readonly code: "FUTURE_SCHEMA" | "NON_CONTIGUOUS_MIGRATIONS";
  readonly inspection: DatabaseSchemaInspection;

  constructor(inspection: DatabaseSchemaInspection) {
    const future = inspection.status === "future";
    super(future ? "Database schema is newer than this application" : "Database migrations are non-contiguous");
    this.name = "DatabaseSchemaError";
    this.code = future ? "FUTURE_SCHEMA" : "NON_CONTIGUOUS_MIGRATIONS";
    this.inspection = inspection;
  }
}

interface DocumentRow {
  id: string;
  source_url: string;
  final_url: string | null;
  canonical_url: string | null;
  title: string;
  author: string | null;
  published_at: string | null;
  markdown: string;
  status: CaptureStatus;
  warning: string | null;
  error_code: CaptureErrorCode | null;
  error_message: string | null;
  capture_mode: CaptureMode | null;
  favorite: number;
  archived_at: string | null;
  source_note: string;
  revision: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CollectionRow {
  id: string;
  name: string;
  document_count: number;
  created_at: string;
  updated_at: string;
}

interface TagRow {
  name: string;
  document_count: number;
}

interface DocumentDraftRow {
  document_id: string;
  draft_revision: number;
  base_revision: number;
  title: string;
  markdown: string;
  tags_json: string;
  deleted: number;
  updated_at: string;
}

interface BackupRecordRow {
  id: string;
  directory_name: string | null;
  reason: BackupRecord["reason"];
  status: BackupRecord["status"];
  created_at: string;
  finished_at: string | null;
  verified_at: string | null;
  total_bytes: number | null;
  schema_version: number | null;
  error_code: string | null;
  error_message: string | null;
}

interface CaptureRow {
  id: string;
  document_id: string;
  status: Exclude<CaptureStatus, "queued">;
  mode: CaptureMode | null;
  http_status: number | null;
  snapshot_path: string | null;
  warning: string | null;
  error_code: CaptureErrorCode | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  request_url: string | null;
  final_url: string | null;
  extractor_version: string | null;
}

interface DocumentAssetRow {
  document_id: string;
  source_url: string;
  status: AssetStatus;
  asset_hash: string | null;
  mime: AssetMimeType | null;
  bytes: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface DerivedResultRow {
  id: string;
  document_id: string;
  type: DerivedResultType;
  model: string;
  endpoint_id: string;
  prompt_version: string;
  input_hash: string;
  output: string;
  duration_ms: number;
  usage_json: string | null;
  source_chars: number;
  sent_chars: number;
  truncated: number;
  pinned: number;
  created_at: string;
}

export interface CaptureJob {
  id: number;
  captureId: string;
  documentId: string;
  url: string;
}

export interface CaptureResult {
  extractorVersion?: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  finalUrl: string;
  canonicalUrl: string | null;
  markdown: string;
  mode: CaptureMode;
  warning: string | null;
  httpStatus: number | null;
}

export interface DocumentPatch {
  title?: string;
  markdown?: string;
  tags?: string[];
  author?: string | null;
  publishedAt?: string | null;
  sourceNote?: string;
  favorite?: boolean;
  archived?: boolean;
  collectionIds?: string[];
}

export type ImportPayload =
  | { type: "url"; url: string | null }
  | {
    type: "markdown";
    title: string;
    sourceUrl: string | null;
    finalUrl: string | null;
    canonicalUrl: string | null;
    author: string | null;
    publishedAt: string | null;
    capturedAt: string | null;
    tags: string[];
    collections: string[];
    favorite: boolean;
    archivedAt: string | null;
    sourceNote: string;
    markdown: string;
    assets?: Array<{
      path: string;
      sha256: string;
      mimeType: AssetMimeType;
      sourceUrl: string;
      byteSize: number;
    }>;
  };

export interface PreparedImportItem {
  label: string;
  sourceUrl: string | null;
  warnings: string[];
  error: string | null;
  payload: ImportPayload;
}

interface ImportBatchRow {
  id: string;
  kind: ImportKind;
  status: "preview" | "applied";
  strategy: ImportStrategy | null;
  staging_path: string | null;
  asset_count: number;
  created_at: string;
}

interface ImportItemRow {
  id: string;
  item_index: number;
  label: string;
  source_url: string | null;
  preview_status: "valid" | "duplicate" | "invalid";
  existing_document_id: string | null;
  expected_revision: number | null;
  warnings_json: string;
  error: string | null;
  payload_json: string;
  result_status: "created" | "updated" | "skipped" | "conflict" | "failed" | null;
  result_document_id: string | null;
  result_error: string | null;
}

export type ListFilters = DocumentFilters;

const derivedResultTypes = new Set<DerivedResultType>([
  "summary",
  "outline",
  "keywords",
  "tag-suggestions",
]);

function now() {
  return new Date().toISOString();
}

export function derivedInputHash(title: string, markdown: string) {
  return createHash("sha256")
    .update("zhiye-derived-input-v1\0", "utf8")
    .update(JSON.stringify([title, markdown]), "utf8")
    .digest("hex");
}

function validDerivedUsage(value: unknown): value is DerivedResultUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["inputTokens", "outputTokens", "totalTokens"]);
  return keys.length > 0 && keys.every((key) => allowed.has(key)) &&
    Object.values(value).every((item) => Number.isSafeInteger(item) && (item as number) >= 0);
}

function parseDerivedUsage(value: string | null) {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return validDerivedUsage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedDerivedResult(input: SaveDerivedResultInput) {
  if (!derivedResultTypes.has(input.type)) throw new RangeError("Derived result type is invalid");
  const model = input.model.trim();
  const endpointId = input.endpointId.trim();
  const promptVersion = input.promptVersion.trim();
  if (!model || model.length > 200) throw new RangeError("Derived result model must be 1 to 200 characters");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u.test(endpointId)) {
    throw new RangeError("Derived result endpoint ID must be a non-secret identifier, not a URL");
  }
  if (!promptVersion || promptVersion.length > 100) throw new RangeError("Derived result prompt version must be 1 to 100 characters");
  if (!/^[a-f0-9]{64}$/u.test(input.inputHash)) throw new RangeError("Derived result input hash must be lowercase SHA-256");
  if (!input.output.trim() || Buffer.byteLength(input.output, "utf8") > 2 * 1024 * 1024) {
    throw new RangeError("Derived result output must be non-empty and no larger than 2 MiB");
  }
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > 86_400_000) {
    throw new RangeError("Derived result duration must be an integer from 0 to 86400000 milliseconds");
  }
  if (!Number.isSafeInteger(input.sourceChars) || input.sourceChars < 1 || input.sourceChars > 10_485_760) {
    throw new RangeError("Derived result source character count is invalid");
  }
  if (!Number.isSafeInteger(input.sentChars) || input.sentChars < 1 || input.sentChars > input.sourceChars) {
    throw new RangeError("Derived result sent character count is invalid");
  }
  if (typeof input.truncated !== "boolean" || input.truncated !== (input.sentChars < input.sourceChars)) {
    throw new RangeError("Derived result truncation flag must match its coverage");
  }
  let usageJson: string | null = null;
  if (input.usage !== undefined && input.usage !== null) {
    if (!validDerivedUsage(input.usage)) {
      throw new RangeError("Derived result usage contains unknown or no fields");
    }
    usageJson = JSON.stringify(input.usage);
  }
  return { ...input, model, endpointId, promptVersion, usageJson };
}

function durationMs(startedAt: string, finishedAt: string | null) {
  if (!finishedAt) return null;
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) ? Math.max(0, duration) : null;
}

function transaction<T>(sql: DatabaseSync, work: () => T): T {
  sql.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    sql.exec("COMMIT");
    return result;
  } catch (error) {
    sql.exec("ROLLBACK");
    throw error;
  }
}

function emptySchemaInspection(status: "empty" | "non-contiguous" = "empty"): DatabaseSchemaInspection {
  return {
    status,
    currentVersion: 0,
    supportedVersion: CURRENT_SCHEMA_VERSION,
    appliedVersions: [],
    pendingVersions: status === "empty" ? Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1) : [],
  };
}

function inspectSchema(sql: DatabaseSync): DatabaseSchemaInspection {
  const migrationTable = sql
    .prepare("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { found: number } | undefined;
  if (!migrationTable) {
    const row = sql
      .prepare("SELECT count(*) AS total FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .get() as { total: number };
    return emptySchemaInspection(Number(row.total) === 0 ? "empty" : "non-contiguous");
  }

  const rawVersions = (
    sql.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: unknown }>
  ).map(({ version }) => version);
  const appliedVersions = rawVersions.filter(
    (version): version is number => typeof version === "number" && Number.isSafeInteger(version),
  );
  const otherTables = sql
    .prepare(
      `SELECT count(*) AS total FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'`,
    )
    .get() as { total: number };
  if (!rawVersions.length) {
    return Number(otherTables.total) === 0 ? emptySchemaInspection() : emptySchemaInspection("non-contiguous");
  }

  const currentVersion = appliedVersions.at(-1) ?? 0;
  const contiguous =
    appliedVersions.length === rawVersions.length &&
    appliedVersions.every((version, index) => version === index + 1);
  const status: DatabaseSchemaStatus = !contiguous
    ? "non-contiguous"
    : currentVersion > CURRENT_SCHEMA_VERSION
      ? "future"
      : currentVersion === CURRENT_SCHEMA_VERSION
        ? "current"
        : "pending";
  return {
    status,
    currentVersion,
    supportedVersion: CURRENT_SCHEMA_VERSION,
    appliedVersions,
    pendingVersions:
      status === "pending"
        ? Array.from({ length: CURRENT_SCHEMA_VERSION - currentVersion }, (_, index) => currentVersion + index + 1)
        : [],
  };
}

function applyMigrations(sql: DatabaseSync) {
  const inspection = inspectSchema(sql);
  assertMigratable(inspection);
  if (inspection.status === "current") return inspection;

  transaction(sql, () => {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    for (const version of inspection.pendingVersions) {
      sql.exec(migrations[version - 1]!);
      sql.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, now());
    }
  });
  return inspectSchema(sql);
}

function assertMigratable(inspection: DatabaseSchemaInspection) {
  if (inspection.status === "future" || inspection.status === "non-contiguous") {
    throw new DatabaseSchemaError(inspection);
  }
}

function databaseFile(dataDir: string) {
  return join(dataDir, "zhiye.sqlite3");
}

function regularFileExists(path: string) {
  try {
    if (!lstatSync(path).isFile()) throw new Error("Database path must be a regular file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertDatabaseFile(path: string) {
  const exists = regularFileExists(path);
  for (const suffix of ["-wal", "-shm"]) regularFileExists(`${path}${suffix}`);
  return exists;
}

function syncDirectory(path: string) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function secureStorageDirectory(path: string) {
  let created = false;
  try {
    if (!lstatSync(path).isDirectory()) throw new Error("Storage path must be a real directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    created = true;
    if (!lstatSync(path).isDirectory()) throw new Error("Storage path must be a real directory");
  }
  chmodSync(path, 0o700);
  syncDirectory(path);
  if (created) syncDirectory(dirname(path));
}

function cleanupAssetTemporaries(path: string) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isFile() && /^\.asset-[a-f0-9-]{36}\.tmp$/u.test(entry.name)) unlinkSync(join(path, entry.name));
  }
  syncDirectory(path);
}

function configureDatabase(sql: DatabaseSync) {
  sql.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
}

function secureDatabaseFiles(path: string) {
  if (!assertDatabaseFile(path)) throw new Error("Database file is missing");
  chmodSync(path, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${path}${suffix}`;
    if (regularFileExists(sidecar)) chmodSync(sidecar, 0o600);
  }
}

function assertBackupDirectoryName(name: string) {
  if (
    name !== basename(name) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/u.test(name)
  ) {
    throw new RangeError("Backup directory name must be a safe basename");
  }
}

function assertRetentionCount(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new RangeError("Automatic backup retention must be an integer from 1 to 100");
  }
}

export function inspectDatabaseSchema(dataDir: string): DatabaseSchemaInspection {
  const path = databaseFile(dataDir);
  if (!assertDatabaseFile(path)) return emptySchemaInspection();
  const sql = new DatabaseSync(path, { readOnly: true });
  try {
    sql.exec("PRAGMA query_only = ON");
    return inspectSchema(sql);
  } finally {
    sql.close();
  }
}

export function migrateDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  assertMigratable(inspectDatabaseSchema(dataDir));
  const path = databaseFile(dataDir);
  assertDatabaseFile(path);
  const sql = new DatabaseSync(path);
  try {
    secureDatabaseFiles(path);
    configureDatabase(sql);
    const inspection = applyMigrations(sql);
    secureDatabaseFiles(path);
    return inspection;
  } finally {
    sql.close();
  }
}

function ftsQuery(query: string) {
  return query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function searchTerms(query: string) {
  return query.trim().split(/\s+/u).filter(Boolean);
}

function escapeLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export class KnowledgeDatabase {
  readonly dataDir: string;
  readonly snapshotsDir: string;
  readonly assetsDir: string;
  readonly importStagingDir: string;
  readonly sql: DatabaseSync;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.snapshotsDir = join(dataDir, "snapshots");
    this.assetsDir = join(dataDir, "assets");
    this.importStagingDir = join(dataDir, "import-staging");
    secureStorageDirectory(this.snapshotsDir);
    secureStorageDirectory(this.assetsDir);
    secureStorageDirectory(this.importStagingDir);
    cleanupAssetTemporaries(this.assetsDir);
    const databasePath = databaseFile(dataDir);
    assertMigratable(inspectDatabaseSchema(dataDir));
    assertDatabaseFile(databasePath);
    this.sql = new DatabaseSync(databasePath);
    try {
      secureDatabaseFiles(databasePath);
      configureDatabase(this.sql);
      applyMigrations(this.sql);
      secureDatabaseFiles(databasePath);
      this.processPendingFileDeletions();
      this.cleanupUnreferencedAssets();
      this.recoverInterruptedJobs();
      this.cleanupExpiredImports();
      this.cleanupOrphanImportStaging();
    } catch (error) {
      this.sql.close();
      throw error;
    }
  }

  private recoverInterruptedJobs() {
    const timestamp = now();
    transaction(this.sql, () => {
      this.sql
        .prepare(
          `UPDATE captures
           SET status = 'failed', error_code = 'INTERNAL_ERROR',
               error_message = 'Capture interrupted by application restart', finished_at = ?
           WHERE status IN ('fetching', 'extracting')`,
        )
        .run(timestamp);
      this.sql
        .prepare(
          `UPDATE capture_jobs
           SET status = 'queued', available_at = ?, updated_at = ?,
               last_error = 'Interrupted by application restart'
           WHERE status = 'running'`,
        )
        .run(timestamp, timestamp);
      this.sql
        .prepare(
          `UPDATE documents SET status = 'queued', updated_at = ?
           WHERE status IN ('fetching', 'extracting')`,
        )
        .run(timestamp);
      this.sql
        .prepare(
          `UPDATE document_assets
           SET status = 'failed', asset_hash = NULL, error_code = 'INTERRUPTED',
               error_message = 'Asset caching interrupted by application restart', updated_at = ?
           WHERE status IN ('queued', 'fetching')`,
        )
        .run(timestamp);
    });
  }

  close() {
    this.sql.close();
  }

  private cleanupExpiredImports() {
    const rows = this.sql.prepare("SELECT id, staging_path FROM import_batches WHERE created_at < ?")
      .all(new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString()) as Array<{ id: string; staging_path: string | null }>;
    for (const row of rows) {
      if (row.staging_path) this.removeImportStaging(row.staging_path);
      this.sql.prepare("DELETE FROM import_batches WHERE id = ?").run(row.id);
    }
  }

  private cleanupOrphanImportStaging() {
    const referenced = new Set(
      (this.sql.prepare("SELECT staging_path FROM import_batches WHERE staging_path IS NOT NULL").all() as Array<{ staging_path: string }>)
        .map(({ staging_path }) => staging_path),
    );
    for (const entry of readdirSync(this.importStagingDir, { withFileTypes: true })) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(entry.name) || !entry.isDirectory()) {
        throw new Error(`Unsafe import staging entry: ${entry.name}`);
      }
      if (!referenced.has(entry.name)) rmSync(join(this.importStagingDir, entry.name), { recursive: true });
    }
    syncDirectory(this.importStagingDir);
  }

  createImportStaging() {
    const name = randomUUID();
    mkdirSync(join(this.importStagingDir, name), { mode: 0o700 });
    syncDirectory(this.importStagingDir);
    return name;
  }

  importStagingPath(name: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(name) || name !== basename(name)) throw new Error("Invalid import staging path");
    const root = resolve(this.importStagingDir);
    if (!lstatSync(root).isDirectory()) throw new Error("Import staging root is unsafe");
    return join(root, name);
  }

  private removeImportStaging(name: string) {
    const path = this.importStagingPath(name);
    try {
      if (!lstatSync(path).isDirectory()) throw new Error("Import staging path is unsafe");
      rmSync(path, { recursive: true });
      syncDirectory(this.importStagingDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  getRecentFilters(): { filters: RecentFilter[]; revision: number } {
    const row = this.sql
      .prepare("SELECT value, revision FROM app_settings WHERE key = 'recent-filters'")
      .get() as { value: string; revision: number } | undefined;
    return row ? { filters: JSON.parse(row.value) as RecentFilter[], revision: row.revision } : { filters: [], revision: 0 };
  }

  setRecentFilters(filters: RecentFilter[], expectedRevision: number) {
    const timestamp = now();
    const result = expectedRevision === 0
      ? this.sql.prepare(
        `INSERT OR IGNORE INTO app_settings(key, value, revision, updated_at)
         VALUES ('recent-filters', ?, 1, ?)`,
      ).run(JSON.stringify(filters), timestamp)
      : this.sql.prepare(
        `UPDATE app_settings SET value = ?, revision = revision + 1, updated_at = ?
         WHERE key = 'recent-filters' AND revision = ?`,
      ).run(JSON.stringify(filters), timestamp, expectedRevision);
    return result.changes === 1 ? { kind: "updated" as const, state: this.getRecentFilters() } : { kind: "conflict" as const };
  }

  getLlmSettings(apiKeyConfigured = false): LlmSettings {
    const row = this.sql
      .prepare("SELECT value, revision FROM app_settings WHERE key = 'llm'")
      .get() as { value: string; revision: number } | undefined;
    return {
      ...(row ? parseLlmSettings(row.value) : defaultLlmSettings),
      revision: row?.revision ?? 0,
      apiKeyConfigured,
    };
  }

  setLlmSettings(settings: StoredLlmSettings, expectedRevision: number, apiKeyConfigured = false) {
    const timestamp = now();
    const value = JSON.stringify(settings);
    const result = expectedRevision === 0
      ? this.sql.prepare(
        `INSERT OR IGNORE INTO app_settings(key, value, revision, updated_at)
         VALUES ('llm', ?, 1, ?)`,
      ).run(value, timestamp)
      : this.sql.prepare(
        `UPDATE app_settings SET value = ?, revision = revision + 1, updated_at = ?
         WHERE key = 'llm' AND revision = ?`,
      ).run(value, timestamp, expectedRevision);
    return result.changes === 1
      ? { kind: "updated" as const, settings: this.getLlmSettings(apiKeyConfigured) }
      : { kind: "conflict" as const, settings: this.getLlmSettings(apiKeyConfigured) };
  }

  disableLlm(expectedRevision: number, deleteResults: boolean, apiKeyConfigured = false) {
    return transaction(this.sql, () => {
      const current = this.getLlmSettings(apiKeyConfigured);
      const result = this.setLlmSettings({
        enabled: false,
        target: current.target,
        remote: current.remote,
        local: current.local,
      }, expectedRevision, apiKeyConfigured);
      if (result.kind === "conflict") return result;
      const deletedResults = deleteResults ? this.deleteAllDerivedResults() : 0;
      return { ...result, deletedResults };
    });
  }

  private toBackupRecord(row: BackupRecordRow): BackupRecord {
    return {
      id: row.id,
      directoryName: row.directory_name,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      verifiedAt: row.verified_at,
      totalBytes: row.total_bytes,
      schemaVersion: row.schema_version,
      errorCode: row.error_code,
      errorMessage: row.error_message,
    };
  }

  upsertBackupRecord(record: BackupRecord) {
    if (record.directoryName !== null) assertBackupDirectoryName(record.directoryName);
    this.sql
      .prepare(
        `INSERT INTO backup_records(
           id, directory_name, reason, status, created_at, finished_at, verified_at,
           total_bytes, schema_version, error_code, error_message
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           directory_name = excluded.directory_name,
           reason = excluded.reason,
           status = excluded.status,
           created_at = excluded.created_at,
           finished_at = excluded.finished_at,
           verified_at = excluded.verified_at,
           total_bytes = excluded.total_bytes,
           schema_version = excluded.schema_version,
           error_code = excluded.error_code,
           error_message = excluded.error_message`,
      )
      .run(
        record.id,
        record.directoryName,
        record.reason,
        record.status,
        record.createdAt,
        record.finishedAt,
        record.verifiedAt,
        record.totalBytes,
        record.schemaVersion,
        record.errorCode,
        record.errorMessage,
      );
    return this.getBackupRecord(record.id)!;
  }

  getBackupRecord(id: string) {
    const row = this.sql.prepare("SELECT * FROM backup_records WHERE id = ?").get(id) as
      | BackupRecordRow
      | undefined;
    return row ? this.toBackupRecord(row) : null;
  }

  getBackupRecordByDirectoryName(directoryName: string) {
    assertBackupDirectoryName(directoryName);
    const row = this.sql
      .prepare("SELECT * FROM backup_records WHERE directory_name = ?")
      .get(directoryName) as BackupRecordRow | undefined;
    return row ? this.toBackupRecord(row) : null;
  }

  listBackupRecords() {
    return (
      this.sql.prepare("SELECT * FROM backup_records ORDER BY created_at DESC, id DESC").all() as unknown as BackupRecordRow[]
    ).map((row) => this.toBackupRecord(row));
  }

  hasAutomaticBackupForDay(dayStart: string, nextDayStart: string) {
    if (!dayStart || dayStart >= nextDayStart) throw new RangeError("Backup day range is invalid");
    return Boolean(
      this.sql
        .prepare(
          `SELECT 1 AS found FROM backup_records
           WHERE reason = 'automatic' AND status = 'verified'
             AND created_at >= ? AND created_at < ? LIMIT 1`,
        )
        .get(dayStart, nextDayStart),
    );
  }

  listExpiredAutomaticBackups(retentionCount = this.getBackupSettings().automaticRetentionCount) {
    assertRetentionCount(retentionCount);
    const rows = this.sql
      .prepare(
        `SELECT * FROM backup_records
         WHERE reason = 'automatic' AND status = 'verified' AND directory_name IS NOT NULL
         ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?`,
      )
      .all(retentionCount) as unknown as BackupRecordRow[];
    return rows.reverse().map((row) => this.toBackupRecord(row));
  }

  deleteAutomaticBackupRecord(id: string, retentionCount = this.getBackupSettings().automaticRetentionCount) {
    if (!this.listExpiredAutomaticBackups(retentionCount).some((record) => record.id === id)) return false;
    return (
      this.sql
        .prepare("DELETE FROM backup_records WHERE id = ? AND reason = 'automatic' AND status = 'verified'")
        .run(id).changes === 1
    );
  }

  getBackupSettings(): BackupSettings {
    const row = this.sql.prepare("SELECT automatic_retention_count FROM backup_settings WHERE id = 1").get() as
      | { automatic_retention_count: number }
      | undefined;
    if (!row) throw new Error("Backup settings are missing");
    return { automaticRetentionCount: row.automatic_retention_count };
  }

  setAutomaticRetentionCount(count: number) {
    assertRetentionCount(count);
    this.sql.prepare("UPDATE backup_settings SET automatic_retention_count = ? WHERE id = 1").run(count);
    return this.getBackupSettings();
  }

  getAssetSettings(): AssetSettings {
    const row = this.sql
      .prepare(
        `SELECT max_asset_bytes, max_assets_per_document, max_document_asset_bytes, concurrency
         FROM asset_settings WHERE id = 1`,
      )
      .get() as
      | {
          max_asset_bytes: number;
          max_assets_per_document: number;
          max_document_asset_bytes: number;
          concurrency: number;
        }
      | undefined;
    if (!row) throw new Error("Asset settings are missing");
    return {
      maxAssetBytes: row.max_asset_bytes,
      maxAssetsPerDocument: row.max_assets_per_document,
      maxDocumentAssetBytes: row.max_document_asset_bytes,
      concurrency: row.concurrency,
    };
  }

  getDatabaseHealth(): DatabaseHealth {
    const integrityCheck = (
      this.sql.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>
    ).map(({ integrity_check }) => integrity_check);
    const foreignKeyViolations = (
      this.sql.prepare("PRAGMA foreign_key_check").all() as Array<{
        table: string;
        rowid: number | null;
        parent: string;
        fkid: number;
      }>
    ).map((row) => ({
      table: row.table,
      rowId: row.rowid,
      parent: row.parent,
      foreignKeyId: row.fkid,
    }));
    const referencedSnapshotPaths = (
      this.sql
        .prepare(
          `SELECT DISTINCT snapshot_path AS path FROM captures
           WHERE snapshot_path IS NOT NULL ORDER BY snapshot_path`,
        )
        .all() as Array<{ path: string }>
    ).map(({ path }) => path);
    const referencedAssetPaths = (
      this.sql
        .prepare(
          `SELECT DISTINCT 'assets/' || a.hash AS path
           FROM assets a JOIN document_assets da ON da.asset_hash = a.hash
           WHERE da.status = 'ready' ORDER BY path`,
        )
        .all() as Array<{ path: string }>
    ).map(({ path }) => path);
    const pendingFileDeletions = (
      this.sql.prepare("SELECT * FROM file_deletions ORDER BY created_at, path").all() as Array<{
        path: string;
        attempts: number;
        last_error: string | null;
        created_at: string;
        updated_at: string;
      }>
    ).map((row) => ({
      path: row.path,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const recentErrors = (
      this.sql
        .prepare(
          `SELECT source, code, message, occurred_at FROM (
             SELECT 'capture' AS source, error_code AS code, error_message AS message,
                    COALESCE(finished_at, started_at) AS occurred_at
             FROM captures WHERE error_message IS NOT NULL
             UNION ALL
             SELECT 'asset', error_code, error_message, updated_at
             FROM document_assets WHERE error_message IS NOT NULL
             UNION ALL
             SELECT 'backup', error_code, error_message, COALESCE(finished_at, created_at)
             FROM backup_records WHERE error_message IS NOT NULL
             UNION ALL
             SELECT 'file-deletion', 'FILE_DELETE_FAILED', last_error, updated_at
             FROM file_deletions WHERE last_error IS NOT NULL
           ) ORDER BY occurred_at DESC LIMIT 20`,
        )
        .all() as Array<{
        source: DatabaseHealth["recentErrors"][number]["source"];
        code: string | null;
        message: string;
        occurred_at: string;
      }>
    ).map((row) => ({
      source: row.source,
      code: row.code,
      message: row.message,
      occurredAt: row.occurred_at,
    }));
    return {
      integrityCheck,
      foreignKeyViolations,
      referencedSnapshotPaths,
      referencedAssetPaths,
      pendingFileDeletions,
      recentErrors,
    };
  }

  private tagsFor(documentId: string) {
    return (
      this.sql
        .prepare(
          `SELECT t.name FROM tags t
           JOIN document_tags dt ON dt.tag_id = t.id
           WHERE dt.document_id = ? ORDER BY lower(t.name), t.name`,
        )
        .all(documentId) as Array<{ name: string }>
    ).map(({ name }) => name);
  }

  private collectionsFor(documentId: string): DocumentCollection[] {
    return (
      this.sql
        .prepare(
          `SELECT c.id, c.name FROM collections c
           JOIN document_collections dc ON dc.collection_id = c.id
           WHERE dc.document_id = ? ORDER BY lower(c.name), c.name`,
        )
        .all(documentId) as Array<{ id: string; name: string }>
    ).map(({ id, name }) => ({ id, name }));
  }

  private toCollection(row: CollectionRow): KnowledgeCollection {
    return {
      id: row.id,
      name: row.name,
      documentCount: Number(row.document_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toDocument(row: DocumentRow): KnowledgeDocument {
    return {
      id: row.id,
      title: row.title,
      sourceUrl: row.source_url,
      finalUrl: row.final_url,
      canonicalUrl: row.canonical_url,
      author: row.author,
      publishedAt: row.published_at,
      markdown: row.markdown,
      status: row.status,
      warning: row.warning,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      captureMode: row.capture_mode,
      tags: this.tagsFor(row.id),
      collections: this.collectionsFor(row.id),
      favorite: Boolean(row.favorite),
      archivedAt: row.archived_at,
      revision: row.revision,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sourceNote: row.source_note,
    };
  }

  private toSummary(row: DocumentRow): DocumentSummary {
    const {
      publishedAt: _publishedAt,
      markdown: _markdown,
      captureMode: _captureMode,
      sourceNote: _sourceNote,
      ...summary
    } = this.toDocument(row);
    return summary;
  }

  private toCaptureHistory(row: CaptureRow): CaptureHistoryItem {
    let snapshotStored: CaptureHistoryItem["snapshotStored"] = "none";
    if (row.snapshot_path) {
      try {
        snapshotStored = lstatSync(this.snapshotPath(row.snapshot_path)).isFile() ? "available" : "missing";
      } catch {
        snapshotStored = "missing";
      }
    }
    return {
      id: row.id,
      documentId: row.document_id,
      status: row.status,
      mode: row.mode,
      requestUrl: row.request_url,
      finalUrl: row.final_url,
      httpStatus: row.http_status,
      snapshotStored,
      extractorVersion: row.extractor_version,
      warning: row.warning,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: durationMs(row.started_at, row.finished_at),
    };
  }

  getDocument(id: string) {
    const row = this.sql.prepare("SELECT * FROM documents WHERE id = ?").get(id) as
      | DocumentRow
      | undefined;
    return row ? this.toDocument(row) : null;
  }

  private toDerivedResult(row: DerivedResultRow, currentInputHash: string): DerivedResult {
    return {
      id: row.id,
      documentId: row.document_id,
      type: row.type,
      model: row.model,
      endpointId: row.endpoint_id,
      promptVersion: row.prompt_version,
      inputHash: row.input_hash,
      output: row.output,
      durationMs: row.duration_ms,
      usage: parseDerivedUsage(row.usage_json),
      sourceChars: row.source_chars,
      sentChars: row.sent_chars,
      truncated: Boolean(row.truncated),
      pinned: Boolean(row.pinned),
      stale: row.input_hash !== currentInputHash,
      createdAt: row.created_at,
    };
  }

  saveDerivedResult(input: SaveDerivedResultInput) {
    const value = normalizedDerivedResult(input);
    return transaction(this.sql, () => {
      const document = this.sql.prepare("SELECT title, markdown, deleted_at FROM documents WHERE id = ?").get(value.documentId) as
        | { title: string; markdown: string; deleted_at: string | null }
        | undefined;
      if (!document) return { kind: "missing" as const };
      if (document.deleted_at) return { kind: "deleted" as const };
      const currentInputHash = derivedInputHash(document.title, document.markdown);
      if (value.inputHash !== currentInputHash) {
        return { kind: "source_changed" as const, currentInputHash };
      }
      const id = randomUUID();
      const createdAt = now();
      const inserted = this.sql.prepare(
        `INSERT OR IGNORE INTO derived_results(
           id, document_id, type, model, endpoint_id, prompt_version, input_hash,
           output, duration_ms, usage_json, source_chars, sent_chars, truncated, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        value.documentId,
        value.type,
        value.model,
        value.endpointId,
        value.promptVersion,
        value.inputHash,
        value.output,
        value.durationMs,
        value.usageJson,
        value.sourceChars,
        value.sentChars,
        Number(value.truncated),
        createdAt,
      );
      const row = (inserted.changes
        ? this.sql.prepare("SELECT * FROM derived_results WHERE id = ?").get(id)
        : this.sql.prepare(
          `SELECT * FROM derived_results
           WHERE document_id = ? AND type = ? AND model = ? AND endpoint_id = ?
             AND prompt_version = ? AND input_hash = ?`,
        ).get(
          value.documentId,
          value.type,
          value.model,
          value.endpointId,
          value.promptVersion,
          value.inputHash,
        )) as unknown as DerivedResultRow;
      return {
        kind: "saved" as const,
        created: inserted.changes === 1,
        result: this.toDerivedResult(row, currentInputHash),
      };
    });
  }

  findDerivedResult(
    documentId: string,
    type: DerivedResultType,
    model: string,
    endpointId: string,
    promptVersion: string,
    inputHash: string,
  ) {
    const row = this.sql.prepare(
      `SELECT * FROM derived_results
       WHERE document_id = ? AND type = ? AND model = ? AND endpoint_id = ?
         AND prompt_version = ? AND input_hash = ?`,
    ).get(documentId, type, model, endpointId, promptVersion, inputHash) as unknown as DerivedResultRow | undefined;
    return row ? this.toDerivedResult(row, inputHash) : null;
  }

  listDerivedResults(documentId: string, page = 1) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) {
      throw new RangeError("Derived result page must be an integer from 1 to 1000000");
    }
    const document = this.sql.prepare("SELECT title, markdown FROM documents WHERE id = ?").get(documentId) as
      | { title: string; markdown: string }
      | undefined;
    if (!document) return null;
    const currentInputHash = derivedInputHash(document.title, document.markdown);
    const total = Number((
      this.sql.prepare("SELECT count(*) AS total FROM derived_results WHERE document_id = ?").get(documentId) as
        { total: number }
    ).total);
    const items = (
      this.sql.prepare(
        `SELECT * FROM derived_results WHERE document_id = ?
         ORDER BY pinned DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ).all(documentId, PAGE_SIZE, (page - 1) * PAGE_SIZE) as unknown as DerivedResultRow[]
    ).map((row) => this.toDerivedResult(row, currentInputHash));
    return { items, page, pageSize: PAGE_SIZE, total } satisfies DerivedResultListResponse;
  }

  pinDerivedResult(documentId: string, resultId: string, pinned: boolean) {
    return transaction(this.sql, () => {
      const document = this.sql.prepare("SELECT title, markdown FROM documents WHERE id = ?").get(documentId) as
        | { title: string; markdown: string }
        | undefined;
      if (!document) return { kind: "missing" as const };
      const target = this.sql.prepare(
        "SELECT * FROM derived_results WHERE id = ? AND document_id = ?",
      ).get(resultId, documentId) as unknown as DerivedResultRow | undefined;
      if (!target) return { kind: "result_missing" as const };
      if (pinned && target.type !== "summary") return { kind: "not_summary" as const };
      if (pinned) {
        this.sql.prepare(
          "UPDATE derived_results SET pinned = 0 WHERE document_id = ? AND type = 'summary' AND pinned = 1",
        ).run(documentId);
      }
      this.sql.prepare("UPDATE derived_results SET pinned = ? WHERE id = ?").run(Number(pinned), resultId);
      const result = this.sql.prepare("SELECT * FROM derived_results WHERE id = ?").get(resultId) as unknown as DerivedResultRow;
      return {
        kind: "updated" as const,
        result: this.toDerivedResult(result, derivedInputHash(document.title, document.markdown)),
      };
    });
  }

  deleteDerivedResult(documentId: string, resultId: string) {
    if (!this.sql.prepare("SELECT 1 FROM documents WHERE id = ?").get(documentId)) {
      return { kind: "missing" as const };
    }
    const deleted = this.sql.prepare(
      "DELETE FROM derived_results WHERE id = ? AND document_id = ?",
    ).run(resultId, documentId);
    return deleted.changes === 1 ? { kind: "deleted" as const } : { kind: "result_missing" as const };
  }

  deleteAllDerivedResults() {
    return Number(this.sql.prepare("DELETE FROM derived_results").run().changes);
  }

  *documentsForPortableExport(documentIds?: string[]) {
    if (!documentIds) {
      const rows = this.sql.prepare("SELECT * FROM documents WHERE deleted_at IS NULL ORDER BY created_at, id")
        .iterate() as unknown as Iterable<DocumentRow>;
      for (const row of rows) yield this.toDocument(row);
      return;
    }
    if (!documentIds.length) return;
    const select = this.sql.prepare("SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL");
    for (const id of documentIds) {
      const row = select.get(id) as unknown as DocumentRow | undefined;
      if (row) yield this.toDocument(row);
    }
  }

  private toDocumentAsset(row: DocumentAssetRow): DocumentAsset {
    return {
      documentId: row.document_id,
      sourceUrl: row.source_url,
      status: row.status,
      assetHash: row.asset_hash,
      mimeType: row.mime,
      byteSize: row.bytes,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  prepareDocumentAssets(documentId: string, sourceUrls: string[]) {
    return transaction(this.sql, () => {
      if (!this.sql.prepare("SELECT 1 FROM documents WHERE id = ?").get(documentId)) return false;
      const timestamp = now();
      for (const sourceUrl of new Set(sourceUrls)) {
        this.sql
          .prepare(
            `INSERT INTO document_assets(
               document_id, source_url, status, created_at, updated_at
             ) VALUES (?, ?, 'queued', ?, ?)
             ON CONFLICT(document_id, source_url) DO UPDATE SET
               status = 'queued', asset_hash = NULL, error_code = NULL, error_message = NULL,
               updated_at = excluded.updated_at
             WHERE document_assets.status = 'failed'`,
          )
          .run(documentId, sourceUrl, timestamp, timestamp);
      }
      return true;
    });
  }

  listDocumentAssets(documentId: string): DocumentAsset[] | null {
    if (!this.sql.prepare("SELECT 1 FROM documents WHERE id = ?").get(documentId)) return null;
    const rows = this.sql
      .prepare(
        `SELECT da.*, a.mime, a.bytes
         FROM document_assets da LEFT JOIN assets a ON a.hash = da.asset_hash
         WHERE da.document_id = ? ORDER BY da.created_at, da.source_url`,
      )
      .all(documentId) as unknown as DocumentAssetRow[];
    return rows.map((row) => this.toDocumentAsset(row));
  }

  markAssetFetching(documentId: string, sourceUrl: string) {
    return (
      this.sql
        .prepare(
          `UPDATE document_assets
           SET status = 'fetching', asset_hash = NULL, error_code = NULL,
               error_message = NULL, updated_at = ?
           WHERE document_id = ? AND source_url = ? AND status = 'queued'`,
        )
        .run(now(), documentId, sourceUrl).changes === 1
    );
  }

  completeAsset(
    documentId: string,
    sourceUrl: string,
    hash: string,
    mime: AssetMimeType,
    bytes: number,
  ) {
    return transaction(this.sql, () => {
      const mapping = this.sql
        .prepare(
          `SELECT 1 AS found FROM document_assets
           WHERE document_id = ? AND source_url = ? AND status = 'fetching'`,
        )
        .get(documentId, sourceUrl);
      if (!mapping) return false;
      const timestamp = now();
      this.sql
        .prepare(
          `INSERT INTO assets(hash, mime, bytes, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(hash) DO NOTHING`,
        )
        .run(hash, mime, bytes, timestamp);
      const existing = this.sql.prepare("SELECT mime, bytes FROM assets WHERE hash = ?").get(hash) as {
        mime: string;
        bytes: number;
      };
      if (existing.mime !== mime || existing.bytes !== bytes) {
        throw new Error("Stored asset metadata does not match its content hash");
      }
      const result = this.sql
        .prepare(
          `UPDATE document_assets
           SET status = 'ready', asset_hash = ?, error_code = NULL, error_message = NULL,
               updated_at = ?
           WHERE document_id = ? AND source_url = ? AND status = 'fetching'`,
        )
        .run(hash, timestamp, documentId, sourceUrl);
      return result.changes === 1;
    });
  }

  failAsset(documentId: string, sourceUrl: string, code: string, message: string) {
    return (
      this.sql
        .prepare(
          `UPDATE document_assets
           SET status = 'failed', asset_hash = NULL, error_code = ?, error_message = ?, updated_at = ?
           WHERE document_id = ? AND source_url = ? AND status IN ('queued', 'fetching')`,
        )
        .run(code.slice(0, 100), message.slice(0, 2000), now(), documentId, sourceUrl).changes === 1
    );
  }

  getAsset(hash: string) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) return null;
    const row = this.sql.prepare("SELECT hash, mime, bytes, created_at FROM assets WHERE hash = ?").get(hash) as
      | { hash: string; mime: AssetMimeType; bytes: number; created_at: string }
      | undefined;
    return row
      ? { hash: row.hash, mimeType: row.mime, byteSize: row.bytes, createdAt: row.created_at }
      : null;
  }

  assetFilePath(hash: string) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Asset hash is invalid");
    return this.storagePath(`assets/${hash}`);
  }

  listCaptureHistory(documentId: string): CaptureHistoryItem[] | null {
    if (!this.sql.prepare("SELECT 1 FROM documents WHERE id = ?").get(documentId)) return null;
    return (
      this.sql
        .prepare("SELECT * FROM captures WHERE document_id = ? ORDER BY started_at DESC, id DESC")
        .all(documentId) as unknown as CaptureRow[]
    ).map((row) => this.toCaptureHistory(row));
  }

  getCaptureSnapshotSource(documentId: string, captureId: string) {
    const row = this.sql
      .prepare(
        `SELECT c.snapshot_path, COALESCE(c.final_url, c.request_url, d.source_url) AS source_url
         FROM captures c JOIN documents d ON d.id = c.document_id
         WHERE c.id = ? AND c.document_id = ?`,
      )
      .get(captureId, documentId) as { snapshot_path: string | null; source_url: string } | undefined;
    if (!row) return { kind: "missing" as const };
    if (!row.snapshot_path) return { kind: "snapshot_missing" as const };
    try {
      return {
        kind: "ready" as const,
        path: this.snapshotPath(row.snapshot_path),
        sourceUrl: row.source_url,
      };
    } catch {
      return { kind: "snapshot_invalid" as const };
    }
  }

  private getDocumentDraftRow(id: string) {
    return this.sql
      .prepare("SELECT * FROM document_drafts WHERE document_id = ?")
      .get(id) as DocumentDraftRow | undefined;
  }

  private toDocumentDraft(row: DocumentDraftRow): DocumentDraft {
    return {
      documentId: row.document_id,
      draftRevision: row.draft_revision,
      baseRevision: row.base_revision,
      title: row.title,
      markdown: row.markdown,
      tags: JSON.parse(row.tags_json) as string[],
      updatedAt: row.updated_at,
    };
  }

  getDocumentDraft(id: string): DocumentDraft | null {
    const row = this.getDocumentDraftRow(id);
    return row && !row.deleted ? this.toDocumentDraft(row) : null;
  }

  saveDocumentDraft(
    id: string,
    expectedDraftRevision: number | null,
    baseRevision: number,
    title: string,
    markdown: string,
    tags: string[],
  ) {
    // ponytail: one draft per document; add session keys only when multi-window editing is supported.
    return transaction(this.sql, () => {
      if (!this.getDocument(id)) return { kind: "missing" as const };
      const current = this.getDocumentDraftRow(id);
      const active = current && !current.deleted ? this.toDocumentDraft(current) : null;
      if (
        (!current || current.deleted)
          ? expectedDraftRevision !== null
          : expectedDraftRevision !== current.draft_revision
      ) {
        return { kind: "conflict" as const, draft: active };
      }

      const updatedAt = now();
      if (current) {
        this.sql
          .prepare(
            `UPDATE document_drafts
             SET draft_revision = draft_revision + 1, base_revision = ?, title = ?, markdown = ?,
                 tags_json = ?, deleted = 0, updated_at = ?
             WHERE document_id = ?`,
          )
          .run(baseRevision, title, markdown, JSON.stringify(tags), updatedAt, id);
      } else {
        this.sql
          .prepare(
            `INSERT INTO document_drafts(
               document_id, draft_revision, base_revision, title, markdown, tags_json, updated_at
             ) VALUES (?, 1, ?, ?, ?, ?, ?)`,
          )
          .run(id, baseRevision, title, markdown, JSON.stringify(tags), updatedAt);
      }
      return { kind: "saved" as const, draft: this.getDocumentDraft(id)! };
    });
  }

  deleteDocumentDraft(id: string, draftRevision: number) {
    return transaction(this.sql, () => {
      const current = this.getDocumentDraft(id);
      if (!current) return { kind: "missing" as const };
      if (current.draftRevision !== draftRevision) {
        return { kind: "conflict" as const, draft: current };
      }
      this.sql
        .prepare(
          `UPDATE document_drafts
           SET draft_revision = draft_revision + 1, deleted = 1, updated_at = ?
           WHERE document_id = ? AND draft_revision = ? AND deleted = 0`,
        )
        .run(now(), id, draftRevision);
      return { kind: "deleted" as const };
    });
  }

  createOrGetDocument(sourceUrl: string, force = false) {
    return transaction(this.sql, () => {
      const existing = this.sql.prepare("SELECT * FROM documents WHERE source_url = ?").get(sourceUrl) as
        | DocumentRow
        | undefined;
      if (existing) {
        return { document: this.toDocument(existing), created: false, duplicateKind: "source" as const };
      }
      const resolved = this.sql
        .prepare(
          `SELECT * FROM documents
           WHERE final_url = ? OR canonical_url = ?
           ORDER BY deleted_at IS NOT NULL, updated_at DESC LIMIT 1`,
        )
        .get(sourceUrl, sourceUrl) as DocumentRow | undefined;
      if (resolved && !force) {
        return { document: this.toDocument(resolved), created: false, duplicateKind: "resolved" as const };
      }

      const id = randomUUID();
      const timestamp = now();
      const title = new URL(sourceUrl).hostname;
      this.sql
        .prepare(
          `INSERT INTO documents(
             id, source_url, title, status, created_at, updated_at
           ) VALUES (?, ?, ?, 'queued', ?, ?)`,
        )
        .run(id, sourceUrl, title, timestamp, timestamp);
      this.sql
        .prepare(
          `INSERT INTO capture_jobs(document_id, status, available_at, created_at, updated_at)
           VALUES (?, 'queued', ?, ?, ?)`,
        )
        .run(id, timestamp, timestamp, timestamp);
      return {
        document: this.getDocument(id)!,
        created: true,
        duplicateKind: resolved ? "resolved" as const : null,
      };
    });
  }

  createImportBatch(
    kind: ImportKind,
    items: PreparedImportItem[],
    options: { stagingPath?: string; assetCount?: number } = {},
  ): ImportPreview {
    this.cleanupExpiredImports();
    return transaction(this.sql, () => {
      const id = randomUUID();
      const createdAt = now();
      if (options.stagingPath) this.importStagingPath(options.stagingPath);
      this.sql.prepare(
        "INSERT INTO import_batches(id, kind, staging_path, asset_count, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, kind, options.stagingPath ?? null, options.assetCount ?? 0, createdAt);
      const insert = this.sql.prepare(
        `INSERT INTO import_items(
           id, batch_id, item_index, label, source_url, preview_status, existing_document_id,
           expected_revision, warnings_json, error, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const seen = new Set<string>();
      items.forEach((item, index) => {
        const existing = item.sourceUrl
          ? this.sql.prepare(
            `SELECT id, revision FROM documents
             WHERE source_url = ? OR final_url = ? OR canonical_url = ?
             ORDER BY source_url = ? DESC, deleted_at IS NOT NULL, updated_at DESC LIMIT 1`,
          ).get(item.sourceUrl, item.sourceUrl, item.sourceUrl, item.sourceUrl) as { id: string; revision: number } | undefined
          : undefined;
        const repeated = item.sourceUrl ? seen.has(item.sourceUrl) : false;
        if (item.sourceUrl) seen.add(item.sourceUrl);
        const previewStatus = item.error ? "invalid" : existing || repeated ? "duplicate" : "valid";
        insert.run(
          randomUUID(), id, index, item.label, item.sourceUrl, previewStatus, existing?.id ?? null,
          existing?.revision ?? null, JSON.stringify(item.warnings), item.error, JSON.stringify(item.payload),
        );
      });
      return this.getImportPreview(id)!;
    });
  }

  getImportPreview(id: string): ImportPreview | null {
    const batch = this.sql.prepare("SELECT * FROM import_batches WHERE id = ?").get(id) as ImportBatchRow | undefined;
    if (!batch) return null;
    const rows = this.sql.prepare("SELECT * FROM import_items WHERE batch_id = ? ORDER BY item_index").all(id) as unknown as ImportItemRow[];
    const items = rows.map((row) => ({
      id: row.id,
      index: row.item_index,
      label: row.label,
      sourceUrl: row.source_url,
      status: row.preview_status,
      existingDocumentId: row.existing_document_id,
      warnings: JSON.parse(row.warnings_json) as string[],
      error: row.error,
    }));
    return {
      id: batch.id,
      kind: batch.kind,
      status: "preview",
      createdAt: batch.created_at,
      counts: {
        total: items.length,
        valid: items.filter(({ status }) => status === "valid").length,
        duplicate: items.filter(({ status }) => status === "duplicate").length,
        invalid: items.filter(({ status }) => status === "invalid").length,
        ...(batch.kind === "bundle" ? { assets: batch.asset_count } : {}),
      },
      items,
    };
  }

  private importCollections(names: string[], timestamp: string) {
    const ids: string[] = [];
    for (const name of names) {
      let row = this.sql.prepare("SELECT id FROM collections WHERE name = ? COLLATE NOCASE").get(name) as { id: string } | undefined;
      if (!row) {
        row = { id: randomUUID() };
        this.sql.prepare("INSERT INTO collections(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
          .run(row.id, name, timestamp, timestamp);
      }
      ids.push(row.id);
    }
    return ids;
  }

  private replaceImportedAssets(
    documentId: string,
    assets: NonNullable<Extract<ImportPayload, { type: "markdown" }>["assets"]>,
    timestamp: string,
  ) {
    this.sql.prepare("DELETE FROM document_assets WHERE document_id = ?").run(documentId);
    for (const asset of assets) {
      this.sql.prepare(
        "INSERT INTO assets(hash, mime, bytes, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING",
      ).run(asset.sha256, asset.mimeType, asset.byteSize, timestamp);
      const stored = this.sql.prepare("SELECT mime, bytes FROM assets WHERE hash = ?").get(asset.sha256) as {
        mime: string; bytes: number;
      };
      if (stored.mime !== asset.mimeType || stored.bytes !== asset.byteSize) throw new Error("Imported asset metadata conflicts");
      this.sql.prepare(
        `INSERT INTO document_assets(
           document_id, source_url, status, asset_hash, created_at, updated_at
         ) VALUES (?, ?, 'ready', ?, ?, ?)`,
      ).run(documentId, asset.sourceUrl, asset.sha256, timestamp, timestamp);
    }
  }

  private insertImportedMarkdown(itemId: string, payload: Extract<ImportPayload, { type: "markdown" }>, copy: boolean) {
    const id = randomUUID();
    const timestamp = now();
    const sourceUrl = payload.sourceUrl
      ? copy ? `${payload.sourceUrl}#zhiye-copy-${id.slice(0, 8)}` : payload.sourceUrl
      : `zhiye://import/${itemId}`;
    const createdAt = payload.capturedAt ? new Date(payload.capturedAt).toISOString() : timestamp;
    this.sql.prepare(
      `INSERT INTO documents(
         id, source_url, final_url, canonical_url, title, author, published_at, markdown, status,
         title_edited, markdown_edited, author_edited, published_at_edited, favorite, archived_at,
         source_note, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', 1, 1, 1, 1, ?, ?, ?, ?, ?)`,
    ).run(
      id, sourceUrl, payload.finalUrl, payload.canonicalUrl, payload.title, payload.author,
      payload.publishedAt, payload.markdown, Number(payload.favorite), payload.archivedAt,
      payload.sourceNote, createdAt, timestamp,
    );
    this.replaceTags(id, payload.tags);
    this.replaceCollections(id, this.importCollections(payload.collections, timestamp));
    if (payload.assets) this.replaceImportedAssets(id, payload.assets, timestamp);
    this.recordRevision(this.getDocument(id)!);
    return id;
  }

  private insertImportedUrl(itemId: string, url: string, copy: boolean) {
    const id = randomUUID();
    const timestamp = now();
    const sourceUrl = copy ? `${url}#zhiye-copy-${id.slice(0, 8)}` : url;
    this.sql.prepare(
      "INSERT INTO documents(id, source_url, title, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)",
    ).run(id, sourceUrl, new URL(url).hostname, timestamp, timestamp);
    this.sql.prepare(
      "INSERT INTO capture_jobs(document_id, status, available_at, created_at, updated_at) VALUES (?, 'queued', ?, ?, ?)",
    ).run(id, timestamp, timestamp, timestamp);
    return id;
  }

  applyImportBatch(id: string, strategy: ImportStrategy): ImportApplyResult | null {
    return transaction(this.sql, () => {
      const batch = this.sql.prepare("SELECT * FROM import_batches WHERE id = ?").get(id) as ImportBatchRow | undefined;
      if (!batch) return null;
      const rows = this.sql.prepare("SELECT * FROM import_items WHERE batch_id = ? ORDER BY item_index").all(id) as unknown as ImportItemRow[];
      if (batch.status === "applied") return this.importApplyResult(batch, rows);
      const updateResult = this.sql.prepare(
        "UPDATE import_items SET result_status = ?, result_document_id = ?, result_error = ? WHERE id = ?",
      );
      for (const row of rows) {
        this.sql.exec("SAVEPOINT import_item");
        try {
        const payload = JSON.parse(row.payload_json) as ImportPayload;
        let status: NonNullable<ImportItemRow["result_status"]>;
        let documentId: string | null = null;
        let error: string | null = null;
        if (row.preview_status === "invalid") {
          status = "failed";
          error = row.error ?? "Invalid import item";
        } else if (row.preview_status === "duplicate" && strategy === "skip") {
          status = "skipped";
          documentId = row.existing_document_id;
        } else if (row.preview_status === "duplicate" && strategy === "update") {
          const current = row.existing_document_id ? this.getDocument(row.existing_document_id) : null;
          if (!current || current.revision !== row.expected_revision || current.deletedAt) {
            status = "conflict";
            documentId = current?.id ?? null;
            error = "The source document changed after preview";
          } else if (
            this.sql.prepare(
              "SELECT 1 AS found FROM capture_jobs WHERE document_id = ? AND status IN ('queued', 'running')",
            ).get(current.id)
          ) {
            status = "conflict";
            documentId = current.id;
            error = "The source document already has an active capture";
          } else if (payload.type === "url") {
            const timestamp = now();
            this.sql.prepare(
              `UPDATE documents SET status = 'queued', warning = NULL, error_code = NULL, error_message = NULL,
                 revision = revision + 1, updated_at = ? WHERE id = ?`,
            ).run(timestamp, current.id);
            this.sql.prepare(
              "INSERT INTO capture_jobs(document_id, status, available_at, created_at, updated_at) VALUES (?, 'queued', ?, ?, ?)",
            ).run(current.id, timestamp, timestamp, timestamp);
            status = "updated";
            documentId = current.id;
          } else {
            const timestamp = now();
            this.sql.prepare(
              `UPDATE documents SET final_url = ?, canonical_url = ?, title = ?, author = ?, published_at = ?,
                 markdown = ?, status = 'ready', warning = NULL, error_code = NULL, error_message = NULL,
                 title_edited = 1, markdown_edited = 1, author_edited = 1, published_at_edited = 1,
                 favorite = ?, archived_at = ?, source_note = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
            ).run(
              payload.finalUrl, payload.canonicalUrl, payload.title, payload.author, payload.publishedAt,
              payload.markdown, Number(payload.favorite), payload.archivedAt, payload.sourceNote, timestamp, current.id,
            );
            this.replaceTags(current.id, payload.tags);
            this.replaceCollections(current.id, this.importCollections(payload.collections, timestamp));
            if (payload.assets) this.replaceImportedAssets(current.id, payload.assets, timestamp);
            this.recordRevision(this.getDocument(current.id)!);
            status = "updated";
            documentId = current.id;
          }
        } else {
          const copy = row.preview_status === "duplicate" && strategy === "copy";
          documentId = payload.type === "url"
            ? this.insertImportedUrl(row.id, payload.url!, copy)
            : this.insertImportedMarkdown(row.id, payload, copy);
          status = "created";
        }
        updateResult.run(status, documentId, error, row.id);
          this.sql.exec("RELEASE import_item");
        } catch (cause) {
          this.sql.exec("ROLLBACK TO import_item");
          this.sql.exec("RELEASE import_item");
          updateResult.run(
            "failed",
            null,
            cause instanceof Error ? cause.message.slice(0, 1_000) : "Import item failed",
            row.id,
          );
        }
      }
      this.sql.prepare("UPDATE import_batches SET status = 'applied', strategy = ?, applied_at = ? WHERE id = ?")
        .run(strategy, now(), id);
      const applied = this.sql.prepare("SELECT * FROM import_batches WHERE id = ?").get(id) as unknown as ImportBatchRow;
      const appliedRows = this.sql.prepare("SELECT * FROM import_items WHERE batch_id = ? ORDER BY item_index").all(id) as unknown as ImportItemRow[];
      return this.importApplyResult(applied, appliedRows);
    });
  }

  private importApplyResult(batch: ImportBatchRow, rows: ImportItemRow[]): ImportApplyResult {
    const items = rows.map((row) => ({
      id: row.id,
      index: row.item_index,
      status: row.result_status!,
      documentId: row.result_document_id,
      error: row.result_error,
    }));
    return {
      id: batch.id,
      status: "applied",
      strategy: batch.strategy!,
      counts: {
        created: items.filter(({ status }) => status === "created").length,
        updated: items.filter(({ status }) => status === "updated").length,
        skipped: items.filter(({ status }) => status === "skipped").length,
        conflicts: items.filter(({ status }) => status === "conflict").length,
        failed: items.filter(({ status }) => status === "failed").length,
      },
      items,
    };
  }

  deleteImportBatch(id: string) {
    const row = this.sql.prepare("SELECT staging_path FROM import_batches WHERE id = ?")
      .get(id) as { staging_path: string | null } | undefined;
    if (!row) return false;
    if (row.staging_path) this.removeImportStaging(row.staging_path);
    return this.sql.prepare("DELETE FROM import_batches WHERE id = ?").run(id).changes === 1;
  }

  getImportBundleStaging(id: string) {
    const row = this.sql.prepare(
      "SELECT staging_path FROM import_batches WHERE id = ? AND kind = 'bundle'",
    ).get(id) as { staging_path: string | null } | undefined;
    return row?.staging_path ? this.importStagingPath(row.staging_path) : null;
  }

  findDuplicateDocument(id: string): DocumentSummary | null {
    const target = this.getDocument(id);
    if (!target) return null;
    const urls = [...new Set([target.sourceUrl, target.finalUrl, target.canonicalUrl].filter(
      (url): url is string => Boolean(url),
    ))];
    const placeholders = urls.map(() => "?").join(", ");
    const rows = this.sql
      .prepare(
        `SELECT * FROM documents d
         WHERE d.id <> ? AND (
           d.source_url IN (${placeholders}) OR
           d.final_url IN (${placeholders}) OR
           d.canonical_url IN (${placeholders})
         )`,
      )
      .all(id, ...urls, ...urls, ...urls) as unknown as DocumentRow[];
    rows.sort((left, right) => {
      const sourceDifference = Number(!urls.includes(left.source_url)) - Number(!urls.includes(right.source_url));
      if (sourceDifference) return sourceDifference;
      const trashDifference = Number(left.deleted_at !== null) - Number(right.deleted_at !== null);
      return trashDifference || right.updated_at.localeCompare(left.updated_at);
    });
    return rows[0] ? this.toSummary(rows[0]) : null;
  }

  listDocuments(filters: ListFilters = {}): DocumentListResponse {
    const page = Math.max(1, Math.trunc(filters.page ?? 1));
    const where: string[] = [];
    const params: Array<string | number> = [];
    let from = "FROM documents d";

    where.push(filters.trash === "only" ? "d.deleted_at IS NOT NULL" : "d.deleted_at IS NULL");

    if (filters.q?.trim()) {
      const terms = searchTerms(filters.q);
      const scope = filters.scope ?? "all";
      if (scope !== "source" && terms.every((term) => [...term].length >= 3)) {
        from = "FROM documents_fts CROSS JOIN documents d ON d.rowid = documents_fts.rowid";
        where.push("documents_fts MATCH ?");
        const query = ftsQuery(filters.q);
        params.push(scope === "all" ? query : `${scope === "body" ? "markdown" : "title"} : (${query})`);
      } else {
        for (const term of terms) {
          const pattern = `%${escapeLike(term)}%`;
          if (scope === "title") {
            where.push("d.title LIKE ? ESCAPE '\\'");
            params.push(pattern);
          } else if (scope === "body") {
            where.push("d.markdown LIKE ? ESCAPE '\\'");
            params.push(pattern);
          } else if (scope === "source") {
            where.push(
              `(d.source_url LIKE ? ESCAPE '\\' OR COALESCE(d.final_url, '') LIKE ? ESCAPE '\\' OR
                COALESCE(d.canonical_url, '') LIKE ? ESCAPE '\\' OR COALESCE(d.author, '') LIKE ? ESCAPE '\\' OR
                d.source_note LIKE ? ESCAPE '\\')`,
            );
            params.push(pattern, pattern, pattern, pattern, pattern);
          } else {
            where.push(
              "(d.title LIKE ? ESCAPE '\\' OR d.markdown LIKE ? ESCAPE '\\' OR d.source_url LIKE ? ESCAPE '\\')",
            );
            params.push(pattern, pattern, pattern);
          }
        }
      }
    }
    if (filters.tag?.trim()) {
      where.push(
        `EXISTS (
          SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
          WHERE dt.document_id = d.id AND t.name = ? COLLATE NOCASE
        )`,
      );
      params.push(filters.tag.trim());
    }
    if (filters.collectionId) {
      where.push(
        `EXISTS (
          SELECT 1 FROM document_collections dc
          WHERE dc.document_id = d.id AND dc.collection_id = ?
        )`,
      );
      params.push(filters.collectionId);
    }
    if (filters.status) {
      where.push("d.status = ?");
      params.push(filters.status);
    }
    if (filters.favorite !== undefined) {
      where.push("d.favorite = ?");
      params.push(Number(filters.favorite));
    }
    if (filters.archived !== undefined) {
      where.push(filters.archived ? "d.archived_at IS NOT NULL" : "d.archived_at IS NULL");
    }
    if (filters.unorganized !== undefined) {
      const hasOrganization = `(EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id) OR
        EXISTS (SELECT 1 FROM document_collections dc WHERE dc.document_id = d.id))`;
      where.push(filters.unorganized ? `NOT ${hasOrganization}` : hasOrganization);
    }
    if (filters.from) {
      where.push("d.updated_at >= ?");
      params.push(filters.from);
    }
    if (filters.to) {
      where.push("d.updated_at < ?");
      params.push(filters.to);
    }
    if (filters.captureMode) {
      where.push("d.capture_mode = ?");
      params.push(filters.captureMode);
    }

    const condition = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const order = filters.sort === "created"
      ? "d.created_at DESC, d.id"
      : filters.sort === "title"
        ? "d.title COLLATE NOCASE, d.id"
        : "d.updated_at DESC, d.id";
    const totalRow = this.sql
      .prepare(`SELECT count(*) AS total ${from}${condition}`)
      .get(...params) as { total: number };
    const rows = this.sql
      .prepare(
        `SELECT d.id, d.source_url, d.final_url, d.canonical_url, d.title, d.author,
                NULL AS published_at, '' AS markdown, d.status, d.warning,
                d.error_code, d.error_message, NULL AS capture_mode,
                d.favorite, d.archived_at, '' AS source_note,
                d.revision, d.deleted_at, d.created_at, d.updated_at
         ${from}${condition} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as unknown as DocumentRow[];

    return {
      items: rows.map((row) => this.toSummary(row)),
      page,
      pageSize: PAGE_SIZE,
      total: Number(totalRow.total),
    };
  }

  listTags(trash?: "only") {
    return (
      this.sql
        .prepare(
          `SELECT t.name FROM tags t
           JOIN document_tags dt ON dt.tag_id = t.id
           JOIN documents d ON d.id = dt.document_id
           WHERE ${trash === "only" ? "d.deleted_at IS NOT NULL" : "d.deleted_at IS NULL"}
           GROUP BY t.id ORDER BY lower(t.name), t.name`,
        )
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
  }

  listManagedTags(): KnowledgeTag[] {
    return (
      this.sql
        .prepare(
          `SELECT t.name, count(dt.document_id) AS document_count
           FROM tags t
           LEFT JOIN document_tags dt ON dt.tag_id = t.id
           GROUP BY t.id
           ORDER BY lower(t.name), t.name`,
        )
        .all() as unknown as TagRow[]
    ).map(({ name, document_count }) => ({ name, documentCount: Number(document_count) }));
  }

  private getManagedTag(name: string): KnowledgeTag | null {
    const row = this.sql
      .prepare(
        `SELECT t.name, count(dt.document_id) AS document_count
         FROM tags t
         LEFT JOIN document_tags dt ON dt.tag_id = t.id
         WHERE t.name = ? COLLATE NOCASE
         GROUP BY t.id`,
      )
      .get(name) as TagRow | undefined;
    return row ? { name: row.name, documentCount: Number(row.document_count) } : null;
  }

  private documentIdsForTag(name: string) {
    return (
      this.sql
        .prepare(
          `SELECT dt.document_id AS id
           FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
           WHERE t.name = ? COLLATE NOCASE ORDER BY dt.document_id`,
        )
        .all(name) as Array<{ id: string }>
    ).map(({ id }) => id);
  }

  private touchDocuments(documentIds: string[], timestamp: string, recordTags = false) {
    if (!documentIds.length) return;
    const placeholders = documentIds.map(() => "?").join(", ");
    this.sql
      .prepare(`UPDATE documents SET revision = revision + 1, updated_at = ? WHERE id IN (${placeholders})`)
      .run(timestamp, ...documentIds);
    if (recordTags) {
      for (const id of documentIds) this.recordRevision(this.getDocument(id)!);
    }
  }

  renameTag(name: string, newName: string) {
    return transaction(this.sql, () => {
      const current = this.getManagedTag(name);
      if (!current) return { kind: "missing" as const };
      const duplicate = this.sql
        .prepare("SELECT 1 FROM tags WHERE name = ? COLLATE NOCASE AND name <> ? COLLATE NOCASE")
        .get(newName, current.name);
      if (duplicate) return { kind: "duplicate" as const, tag: this.getManagedTag(newName)! };
      const documentIds = this.documentIdsForTag(current.name);
      this.sql.prepare("UPDATE tags SET name = ? WHERE name = ? COLLATE NOCASE").run(newName, current.name);
      this.touchDocuments(documentIds, now(), true);
      return {
        kind: "renamed" as const,
        response: { tag: this.getManagedTag(newName), affectedDocuments: documentIds.length } satisfies TagMutationResponse,
      };
    });
  }

  mergeTag(name: string, targetName: string) {
    return transaction(this.sql, () => {
      const source = this.getManagedTag(name);
      const target = this.getManagedTag(targetName);
      if (!source || !target) return { kind: "missing" as const };
      if (source.name.toLocaleLowerCase() === target.name.toLocaleLowerCase()) return { kind: "same" as const };
      const documentIds = this.documentIdsForTag(source.name);
      this.sql
        .prepare(
          `INSERT OR IGNORE INTO document_tags(document_id, tag_id)
           SELECT dt.document_id, target.id
           FROM document_tags dt JOIN tags source ON source.id = dt.tag_id
           JOIN tags target ON target.name = ? COLLATE NOCASE
           WHERE source.name = ? COLLATE NOCASE`,
        )
        .run(target.name, source.name);
      this.sql.prepare("DELETE FROM tags WHERE name = ? COLLATE NOCASE").run(source.name);
      this.touchDocuments(documentIds, now(), true);
      return {
        kind: "merged" as const,
        response: { tag: this.getManagedTag(target.name), affectedDocuments: documentIds.length } satisfies TagMutationResponse,
      };
    });
  }

  deleteTag(name: string) {
    return transaction(this.sql, () => {
      const current = this.getManagedTag(name);
      if (!current) return { kind: "missing" as const };
      const documentIds = this.documentIdsForTag(current.name);
      this.sql.prepare("DELETE FROM tags WHERE name = ? COLLATE NOCASE").run(current.name);
      this.touchDocuments(documentIds, now(), true);
      return {
        kind: "deleted" as const,
        response: { tag: null, affectedDocuments: documentIds.length } satisfies TagMutationResponse,
      };
    });
  }

  listCollections(): KnowledgeCollection[] {
    return (
      this.sql
        .prepare(
          `SELECT c.id, c.name, count(dc.document_id) AS document_count,
                  c.created_at, c.updated_at
           FROM collections c
           LEFT JOIN document_collections dc ON dc.collection_id = c.id
           GROUP BY c.id
           ORDER BY lower(c.name), c.name`,
        )
        .all() as unknown as CollectionRow[]
    ).map((row) => this.toCollection(row));
  }

  getCollection(id: string): KnowledgeCollection | null {
    const row = this.sql
      .prepare(
        `SELECT c.id, c.name, count(dc.document_id) AS document_count,
                c.created_at, c.updated_at
         FROM collections c
         LEFT JOIN document_collections dc ON dc.collection_id = c.id
         WHERE c.id = ? GROUP BY c.id`,
      )
      .get(id) as CollectionRow | undefined;
    return row ? this.toCollection(row) : null;
  }

  createCollection(name: string) {
    return transaction(this.sql, () => {
      const existing = this.sql
        .prepare("SELECT id FROM collections WHERE name = ? COLLATE NOCASE")
        .get(name) as { id: string } | undefined;
      if (existing) return { kind: "duplicate" as const, collection: this.getCollection(existing.id)! };
      const id = randomUUID();
      const timestamp = now();
      this.sql
        .prepare("INSERT INTO collections(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(id, name, timestamp, timestamp);
      return { kind: "created" as const, collection: this.getCollection(id)! };
    });
  }

  renameCollection(id: string, name: string) {
    return transaction(this.sql, () => {
      const current = this.getCollection(id);
      if (!current) return { kind: "missing" as const };
      const duplicate = this.sql
        .prepare("SELECT id FROM collections WHERE name = ? COLLATE NOCASE AND id <> ?")
        .get(name, id) as { id: string } | undefined;
      if (duplicate) return { kind: "duplicate" as const, collection: this.getCollection(duplicate.id)! };
      this.sql.prepare("UPDATE collections SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), id);
      return { kind: "renamed" as const, collection: this.getCollection(id)! };
    });
  }

  deleteCollection(id: string) {
    return transaction(this.sql, () => {
      const current = this.getCollection(id);
      if (!current) return { kind: "missing" as const };
      const documentIds = (
        this.sql
          .prepare("SELECT document_id AS id FROM document_collections WHERE collection_id = ? ORDER BY document_id")
          .all(id) as Array<{ id: string }>
      ).map(({ id: documentId }) => documentId);
      this.touchDocuments(documentIds, now());
      this.sql.prepare("DELETE FROM collections WHERE id = ?").run(id);
      return { kind: "deleted" as const, affectedDocuments: documentIds.length };
    });
  }

  mergeCollection(id: string, targetId: string) {
    return transaction(this.sql, () => {
      const source = this.getCollection(id);
      const target = this.getCollection(targetId);
      if (!source || !target) return { kind: "missing" as const };
      if (source.id === target.id) return { kind: "same" as const };
      const documentIds = (
        this.sql
          .prepare("SELECT document_id AS id FROM document_collections WHERE collection_id = ? ORDER BY document_id")
          .all(id) as Array<{ id: string }>
      ).map(({ id: documentId }) => documentId);
      this.sql
        .prepare(
          `INSERT OR IGNORE INTO document_collections(document_id, collection_id)
           SELECT document_id, ? FROM document_collections WHERE collection_id = ?`,
        )
        .run(targetId, id);
      this.sql.prepare("DELETE FROM collections WHERE id = ?").run(id);
      this.touchDocuments(documentIds, now());
      return {
        kind: "merged" as const,
        collection: this.getCollection(targetId)!,
        affectedDocuments: documentIds.length,
      };
    });
  }

  batchDocuments(targets: Array<{ id: string; revision: number }>, action: BatchDocumentAction, value?: string) {
    return transaction(this.sql, () => {
      const documentIds = targets.map(({ id }) => id);
      const documents = documentIds.map((id) => this.getDocument(id));
      const missing = documentIds.filter((_, index) => !documents[index]);
      if (missing.length) return { kind: "missing" as const, documentIds: missing };
      const current = documents as KnowledgeDocument[];
      const conflicts = current
        .filter((document, index) => document.revision !== targets[index]!.revision)
        .map(({ id }) => id);
      if (conflicts.length) return { kind: "conflict" as const, documentIds: conflicts };
      const expectsDeleted = action === "restore";
      const invalidState = current
        .filter((document) => expectsDeleted ? !document.deletedAt : Boolean(document.deletedAt))
        .map(({ id }) => id);
      if (invalidState.length) return { kind: "invalid_state" as const, documentIds: invalidState };

      if ((action === "add-tag" || action === "remove-tag") && !value) {
        return { kind: "invalid_tag" as const };
      }
      if (action === "add-collection" || action === "remove-collection") {
        if (!value || !this.getCollection(value)) return { kind: "invalid_collection" as const };
      }

      const storedTag = action === "add-tag" || action === "remove-tag" ? this.getManagedTag(value!) : null;
      let changedIds: string[];
      if (action === "add-tag") {
        changedIds = current
          .filter((document) => !storedTag || !document.tags.includes(storedTag.name))
          .map(({ id }) => id);
        const overLimit = current
          .filter((document) => changedIds.includes(document.id) && document.tags.length >= 50)
          .map(({ id }) => id);
        if (overLimit.length) return { kind: "tag_limit" as const, documentIds: overLimit };
      } else if (action === "remove-tag") {
        changedIds = storedTag
          ? current.filter((document) => document.tags.includes(storedTag.name)).map(({ id }) => id)
          : [];
      } else if (action === "add-collection") {
        changedIds = current.filter((document) => !document.collections.some(({ id }) => id === value)).map(({ id }) => id);
        const overLimit = current
          .filter((document) => changedIds.includes(document.id) && document.collections.length >= 100)
          .map(({ id }) => id);
        if (overLimit.length) return { kind: "collection_limit" as const, documentIds: overLimit };
      } else if (action === "remove-collection") {
        changedIds = current.filter((document) => document.collections.some(({ id }) => id === value)).map(({ id }) => id);
      } else if (action === "archive") {
        changedIds = current.filter((document) => !document.archivedAt).map(({ id }) => id);
      } else if (action === "unarchive") {
        changedIds = current.filter((document) => Boolean(document.archivedAt)).map(({ id }) => id);
      } else {
        changedIds = [...documentIds];
      }

      const timestamp = now();
      if (changedIds.length) {
        const placeholders = changedIds.map(() => "?").join(", ");
        if (action === "add-tag") {
          this.sql.prepare("INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(value!);
          const tag = this.sql.prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE").get(value!) as { id: number };
          const insert = this.sql.prepare("INSERT INTO document_tags(document_id, tag_id) VALUES (?, ?)");
          for (const id of changedIds) insert.run(id, tag.id);
        } else if (action === "remove-tag") {
          this.sql
            .prepare(
              `DELETE FROM document_tags WHERE document_id IN (${placeholders}) AND tag_id IN (
                 SELECT id FROM tags WHERE name = ? COLLATE NOCASE
               )`,
            )
            .run(...changedIds, value!);
          this.sql.prepare("DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM document_tags WHERE tag_id = tags.id)").run();
        } else if (action === "add-collection") {
          const insert = this.sql.prepare("INSERT INTO document_collections(document_id, collection_id) VALUES (?, ?)");
          for (const id of changedIds) insert.run(id, value!);
        } else if (action === "remove-collection") {
          this.sql
            .prepare(`DELETE FROM document_collections WHERE document_id IN (${placeholders}) AND collection_id = ?`)
            .run(...changedIds, value!);
        } else if (action === "archive") {
          this.sql.prepare(`UPDATE documents SET archived_at = ? WHERE id IN (${placeholders})`).run(timestamp, ...changedIds);
        } else if (action === "unarchive") {
          this.sql.prepare(`UPDATE documents SET archived_at = NULL WHERE id IN (${placeholders})`).run(...changedIds);
        } else if (action === "trash") {
          this.sql.prepare(`UPDATE documents SET deleted_at = ? WHERE id IN (${placeholders})`).run(timestamp, ...changedIds);
        } else if (action === "restore") {
          this.sql.prepare(`UPDATE documents SET deleted_at = NULL WHERE id IN (${placeholders})`).run(...changedIds);
        }
        this.touchDocuments(changedIds, timestamp, action === "add-tag" || action === "remove-tag");
      }
      const changed = new Set(changedIds);
      return {
        kind: "updated" as const,
        response: {
          affectedDocuments: changedIds.length,
          results: documentIds.map((id) => ({
            id,
            changed: changed.has(id),
            revision: this.getDocument(id)!.revision,
          })),
        } satisfies BatchDocumentsResponse,
      };
    });
  }

  updateDocument(id: string, revision: number, patch: DocumentPatch) {
    return transaction(this.sql, () => {
      const current = this.getDocument(id);
      if (!current) return { kind: "missing" as const };
      if (current.deletedAt) return { kind: "deleted" as const, document: current };
      if (current.revision !== revision) return { kind: "conflict" as const, document: current };

      const timestamp = now();
      const assignments = ["revision = revision + 1", "updated_at = ?"];
      const values: Array<string | number | null> = [timestamp];
      if (patch.title !== undefined) {
        assignments.push("title = ?", "title_edited = 1");
        values.push(patch.title);
      }
      if (patch.markdown !== undefined) {
        assignments.push("markdown = ?", "markdown_edited = 1");
        values.push(patch.markdown);
      }
      if (patch.author !== undefined) {
        assignments.push("author = ?", "author_edited = 1");
        values.push(patch.author);
      }
      if (patch.publishedAt !== undefined) {
        assignments.push("published_at = ?", "published_at_edited = 1");
        values.push(patch.publishedAt);
      }
      if (patch.sourceNote !== undefined) {
        assignments.push("source_note = ?");
        values.push(patch.sourceNote);
      }
      if (patch.favorite !== undefined) {
        assignments.push("favorite = ?");
        values.push(Number(patch.favorite));
      }
      if (patch.archived !== undefined) {
        assignments.push("archived_at = ?");
        values.push(patch.archived ? timestamp : null);
      }
      if (patch.collectionIds !== undefined) {
        const missingCollectionIds = this.missingCollectionIds(patch.collectionIds);
        if (missingCollectionIds.length) {
          return { kind: "invalid_collections" as const, missingCollectionIds, document: current };
        }
      }
      this.sql
        .prepare(`UPDATE documents SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...values, id);

      if (patch.tags !== undefined) this.replaceTags(id, patch.tags);
      if (patch.collectionIds !== undefined) this.replaceCollections(id, patch.collectionIds);
      if (patch.title !== undefined && patch.markdown !== undefined && patch.tags !== undefined) {
        this.sql
          .prepare(
            `UPDATE document_drafts
             SET draft_revision = draft_revision + 1, deleted = 1, updated_at = ?
             WHERE document_id = ? AND title = ? AND markdown = ? AND tags_json = ? AND deleted = 0`,
          )
          .run(timestamp, id, patch.title, patch.markdown, JSON.stringify(patch.tags));
      }
      const document = this.getDocument(id)!;
      if (patch.title !== undefined || patch.markdown !== undefined || patch.tags !== undefined) {
        this.recordRevision(document);
      }
      return { kind: "updated" as const, document };
    });
  }

  private replaceTags(documentId: string, tags: string[]) {
    this.sql.prepare("DELETE FROM document_tags WHERE document_id = ?").run(documentId);
    for (const name of tags) {
      this.sql.prepare("INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(name);
      const tag = this.sql.prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE").get(name) as {
        id: number;
      };
      this.sql.prepare("INSERT INTO document_tags(document_id, tag_id) VALUES (?, ?)").run(documentId, tag.id);
    }
    this.sql.prepare("DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM document_tags WHERE tag_id = tags.id)").run();
  }

  private missingCollectionIds(collectionIds: string[]) {
    if (!collectionIds.length) return [];
    const placeholders = collectionIds.map(() => "?").join(", ");
    const found = new Set(
      (
        this.sql.prepare(`SELECT id FROM collections WHERE id IN (${placeholders})`).all(...collectionIds) as Array<{
          id: string;
        }>
      ).map(({ id }) => id),
    );
    return collectionIds.filter((id) => !found.has(id));
  }

  private replaceCollections(documentId: string, collectionIds: string[]) {
    this.sql.prepare("DELETE FROM document_collections WHERE document_id = ?").run(documentId);
    const insert = this.sql.prepare(
      "INSERT INTO document_collections(document_id, collection_id) VALUES (?, ?)",
    );
    for (const collectionId of collectionIds) insert.run(documentId, collectionId);
  }

  private recordRevision(document: KnowledgeDocument) {
    this.sql
      .prepare(
        `INSERT INTO document_revisions(document_id, revision, title, markdown, tags_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        document.id,
        document.revision,
        document.title,
        document.markdown,
        JSON.stringify(document.tags),
        document.updatedAt,
      );
  }

  listDocumentRevisions(id: string): DocumentRevision[] | null {
    if (!this.getDocument(id)) return null;
    return (
      this.sql
        .prepare(
          `SELECT revision, title, markdown, tags_json, created_at
           FROM document_revisions WHERE document_id = ? ORDER BY revision DESC`,
        )
        .all(id) as Array<{
        revision: number;
        title: string;
        markdown: string;
        tags_json: string;
        created_at: string;
      }>
    ).map((row) => ({
      revision: row.revision,
      title: row.title,
      markdown: row.markdown,
      tags: JSON.parse(row.tags_json) as string[],
      createdAt: row.created_at,
    }));
  }

  restoreDocumentRevision(id: string, targetRevision: number, currentRevision: number) {
    return transaction(this.sql, () => {
      const current = this.getDocument(id);
      if (!current) return { kind: "missing" as const };
      if (current.deletedAt) return { kind: "deleted" as const, document: current };
      if (current.revision !== currentRevision) return { kind: "conflict" as const, document: current };
      const target = this.sql
        .prepare(
          `SELECT title, markdown, tags_json FROM document_revisions
           WHERE document_id = ? AND revision = ?`,
        )
        .get(id, targetRevision) as { title: string; markdown: string; tags_json: string } | undefined;
      if (!target) return { kind: "revision_missing" as const };

      const timestamp = now();
      this.sql
        .prepare(
          `UPDATE documents SET title = ?, markdown = ?, title_edited = 1, markdown_edited = 1,
             revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(target.title, target.markdown, timestamp, id);
      this.replaceTags(id, JSON.parse(target.tags_json) as string[]);
      const document = this.getDocument(id)!;
      this.recordRevision(document);
      return { kind: "restored" as const, document };
    });
  }

  softDeleteDocument(id: string, revision: number) {
    return transaction(this.sql, () => {
      const current = this.getDocument(id);
      if (!current) return { kind: "missing" as const };
      if (current.revision !== revision) return { kind: "conflict" as const, document: current };
      if (current.deletedAt) return { kind: "already_deleted" as const, document: current };
      const timestamp = now();
      this.sql
        .prepare("UPDATE documents SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, id);
      return { kind: "deleted" as const, document: this.getDocument(id)! };
    });
  }

  restoreDocument(id: string, revision: number) {
    return transaction(this.sql, () => {
      const current = this.getDocument(id);
      if (!current) return { kind: "missing" as const };
      if (current.revision !== revision) return { kind: "conflict" as const, document: current };
      if (!current.deletedAt) return { kind: "not_deleted" as const, document: current };
      const timestamp = now();
      this.sql
        .prepare("UPDATE documents SET deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(timestamp, id);
      return { kind: "restored" as const, document: this.getDocument(id)! };
    });
  }

  permanentlyDeleteDocument(id: string, revision: number, draftRevision: number | null) {
    const result = transaction(this.sql, () => {
      const current = this.getDocument(id);
      if (!current) return { kind: "missing" as const };
      if (!current.deletedAt) return { kind: "not_deleted" as const, document: current };
      if (current.revision !== revision) return { kind: "conflict" as const, document: current };
      const draft = this.getDocumentDraft(id);
      if (draft && draft.draftRevision !== draftRevision) {
        return { kind: "draft_exists" as const, document: current };
      }
      const active = this.sql
        .prepare(
          `SELECT 1 AS found FROM capture_jobs
           WHERE document_id = ? AND status = 'running'
           UNION ALL
           SELECT 1 FROM document_assets
           WHERE document_id = ? AND status IN ('queued', 'fetching')
           LIMIT 1`,
        )
        .get(id, id) as { found: number } | undefined;
      if (active) return { kind: "capture_running" as const, document: current };

      const snapshotPaths = (
        this.sql
          .prepare(
            `SELECT DISTINCT c.snapshot_path FROM captures c
             WHERE c.document_id = ? AND c.snapshot_path IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM captures other
                 WHERE other.snapshot_path = c.snapshot_path AND other.document_id <> c.document_id
               )`,
          )
          .all(id) as Array<{ snapshot_path: string }>
      ).map(({ snapshot_path }) => snapshot_path);
      const assetHashes = (
        this.sql
          .prepare(
            `SELECT DISTINCT da.asset_hash AS hash FROM document_assets da
             WHERE da.document_id = ? AND da.asset_hash IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM document_assets other
                 WHERE other.asset_hash = da.asset_hash AND other.document_id <> da.document_id
               )`,
          )
          .all(id) as Array<{ hash: string }>
      ).map(({ hash }) => hash);
      const relativePaths = [...snapshotPaths, ...assetHashes.map((hash) => `assets/${hash}`)];
      try {
        for (const relativePath of relativePaths) {
          const path = this.storagePath(relativePath);
          try {
            if (!lstatSync(path).isFile()) throw new Error("Stored path is not a file");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      } catch {
        return { kind: "snapshot_failed" as const };
      }

      const timestamp = now();
      for (const path of relativePaths) {
        this.sql
          .prepare(
            `INSERT INTO file_deletions(path, created_at, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(path) DO NOTHING`,
          )
          .run(path, timestamp, timestamp);
      }
      this.sql.prepare("DELETE FROM documents WHERE id = ?").run(id);
      for (const hash of assetHashes) {
        this.sql
          .prepare("DELETE FROM assets WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM document_assets WHERE asset_hash = ?)")
          .run(hash, hash);
      }
      this.sql.prepare("DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM document_tags WHERE tag_id = tags.id)").run();
      return { kind: "deleted" as const };
    });
    if (result.kind === "deleted") this.processPendingFileDeletions();
    return result;
  }

  private storagePath(relativePath: string) {
    const snapshot = /^snapshots\/([a-zA-Z0-9-]+\.html\.gz)$/u.exec(relativePath);
    if (snapshot) {
      const root = resolve(this.snapshotsDir);
      if (!lstatSync(root).isDirectory()) throw new Error("Stored path is outside storage");
      return join(root, snapshot[1]);
    }
    const asset = /^assets\/([a-f0-9]{64})$/u.exec(relativePath);
    if (asset) {
      const root = resolve(this.assetsDir);
      if (!lstatSync(root).isDirectory()) throw new Error("Stored path is outside storage");
      return join(root, asset[1]);
    }
    throw new Error("Stored path is outside storage");
  }

  private snapshotPath(relativePath: string) {
    if (!relativePath.startsWith("snapshots/")) throw new Error("Snapshot path is outside storage");
    return this.storagePath(relativePath);
  }

  queueSnapshotDeletions(paths: string[]) {
    for (const path of paths) this.snapshotPath(path);
    return this.queueFileDeletions(paths);
  }

  queueFileDeletions(paths: string[]) {
    return transaction(this.sql, () => {
      const timestamp = now();
      const queued: string[] = [];
      const referenced: string[] = [];
      for (const path of new Set(paths)) {
        this.storagePath(path);
        const assetHash = /^assets\/([a-f0-9]{64})$/u.exec(path)?.[1];
        const inUse = assetHash
          ? this.sql.prepare("SELECT 1 AS found FROM document_assets WHERE asset_hash = ? LIMIT 1").get(assetHash)
          : this.sql.prepare("SELECT 1 AS found FROM captures WHERE snapshot_path = ? LIMIT 1").get(path);
        if (inUse) {
          referenced.push(path);
          continue;
        }
        if (assetHash) this.sql.prepare("DELETE FROM assets WHERE hash = ?").run(assetHash);
        const result = this.sql
          .prepare(
            `INSERT INTO file_deletions(path, created_at, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(path) DO NOTHING`,
          )
          .run(path, timestamp, timestamp);
        if (result.changes === 1) queued.push(path);
      }
      return { queued, referenced };
    });
  }

  cleanupUnreferencedAssets() {
    const paths = readdirSync(this.assetsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}$/u.test(entry.name))
      .map((entry) => `assets/${entry.name}`);
    const result = this.queueFileDeletions(paths);
    this.processPendingFileDeletions();
    return result;
  }

  processPendingFileDeletions() {
    const rows = this.sql.prepare("SELECT path FROM file_deletions ORDER BY created_at").all() as Array<{
      path: string;
    }>;
    for (const row of rows) {
      try {
        const path = this.storagePath(row.path);
        try {
          if (!lstatSync(path).isFile()) throw new Error("Stored path is not a file");
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.sql.prepare("DELETE FROM file_deletions WHERE path = ?").run(row.path);
      } catch (error) {
        this.sql
          .prepare(
            `UPDATE file_deletions SET attempts = attempts + 1, last_error = ?, updated_at = ?
             WHERE path = ?`,
          )
          .run(error instanceof Error ? error.message.slice(0, 1000) : "File deletion failed", now(), row.path);
      }
    }
  }

  retryDocument(id: string) {
    return transaction(this.sql, () => {
      const current = this.getDocument(id);
      if (!current) return { kind: "missing" as const };
      if (current.deletedAt) return { kind: "deleted" as const, document: current };
      if (current.status !== "failed") return { kind: "not_failed" as const, document: current };
      const timestamp = now();
      this.sql
        .prepare(
          `UPDATE documents
           SET status = 'queued', warning = NULL, error_code = NULL, error_message = NULL,
               revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(timestamp, id);
      this.sql
        .prepare(
          `INSERT INTO capture_jobs(document_id, status, available_at, created_at, updated_at)
           VALUES (?, 'queued', ?, ?, ?)`,
        )
        .run(id, timestamp, timestamp, timestamp);
      return { kind: "queued" as const, document: this.getDocument(id)! };
    });
  }

  cancelQueuedCapture(id: string) {
    return transaction(this.sql, () => {
      const current = this.getDocument(id);
      if (!current) return { kind: "missing" as const };
      const timestamp = now();
      const cancelled = this.sql
        .prepare(
          `UPDATE capture_jobs
           SET status = 'failed', last_error = 'Capture cancelled by user', updated_at = ?
           WHERE document_id = ? AND status = 'queued'`,
        )
        .run(timestamp, id);
      if (cancelled.changes !== 1) return { kind: "not_queued" as const, document: current };
      this.sql
        .prepare(
          `UPDATE documents
           SET status = 'failed', warning = NULL, error_code = 'CAPTURE_CANCELLED',
               error_message = 'Capture cancelled by user', revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(timestamp, id);
      return { kind: "cancelled" as const, document: this.getDocument(id)! };
    });
  }

  getCaptureQueueCounts() {
    const row = this.sql
      .prepare(
        `SELECT
           sum(CASE WHEN j.status = 'running' THEN 1 ELSE 0 END) AS active,
           sum(CASE WHEN j.status = 'queued' AND d.deleted_at IS NULL THEN 1 ELSE 0 END) AS queued
         FROM capture_jobs j JOIN documents d ON d.id = j.document_id`,
      )
      .get() as { active: number | null; queued: number | null };
    return { active: Number(row.active ?? 0), queued: Number(row.queued ?? 0) };
  }

  claimNextCapture(): CaptureJob | null {
    return transaction(this.sql, () => {
      const timestamp = now();
      const row = this.sql
        .prepare(
          `SELECT j.id, j.document_id, d.source_url
           FROM capture_jobs j JOIN documents d ON d.id = j.document_id
           WHERE j.status = 'queued' AND j.available_at <= ? AND d.deleted_at IS NULL
           ORDER BY j.id LIMIT 1`,
        )
        .get(timestamp) as { id: number; document_id: string; source_url: string } | undefined;
      if (!row) return null;

      const captureId = randomUUID();
      this.sql
        .prepare(
          `UPDATE capture_jobs
           SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`,
        )
        .run(timestamp, row.id);
      this.sql
        .prepare("UPDATE documents SET status = 'fetching', updated_at = ? WHERE id = ?")
        .run(timestamp, row.document_id);
      this.sql
        .prepare(
          `INSERT INTO captures(id, document_id, job_id, request_url, status, started_at)
           VALUES (?, ?, ?, ?, 'fetching', ?)`,
        )
        .run(captureId, row.document_id, row.id, row.source_url, timestamp);
      return {
        id: row.id,
        captureId,
        documentId: row.document_id,
        url: row.source_url,
      };
    });
  }

  markExtracting(job: CaptureJob, mode: CaptureMode, httpStatus: number | null) {
    const timestamp = now();
    transaction(this.sql, () => {
      this.sql
        .prepare("UPDATE documents SET status = 'extracting', updated_at = ? WHERE id = ?")
        .run(timestamp, job.documentId);
      this.sql
        .prepare("UPDATE captures SET status = 'extracting', mode = ?, http_status = ? WHERE id = ?")
        .run(mode, httpStatus, job.captureId);
    });
  }

  planCaptureSnapshot(job: CaptureJob, snapshotPath: string) {
    this.snapshotPath(snapshotPath);
    const result = this.sql
      .prepare("UPDATE captures SET snapshot_path = ? WHERE id = ? AND document_id = ? AND job_id = ?")
      .run(snapshotPath, job.captureId, job.documentId, job.id);
    if (result.changes !== 1) throw new Error("Capture is no longer active");
  }

  completeCapture(job: CaptureJob, result: CaptureResult, snapshotPath: string | null) {
    const timestamp = now();
    transaction(this.sql, () => {
      this.sql
        .prepare(
          `UPDATE documents SET
             final_url = ?,
             canonical_url = ?,
             title = CASE WHEN title_edited = 0 THEN ? ELSE title END,
             author = CASE WHEN author_edited = 0 THEN ? ELSE author END,
             published_at = CASE WHEN published_at_edited = 0 THEN ? ELSE published_at END,
             markdown = CASE WHEN markdown_edited = 0 THEN ? ELSE markdown END,
             status = 'ready', warning = ?, error_code = NULL, error_message = NULL,
             capture_mode = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          result.finalUrl,
          result.canonicalUrl,
          result.title,
          result.author,
          result.publishedAt,
          result.markdown,
          result.warning,
          result.mode,
          timestamp,
          job.documentId,
        );
      this.sql
        .prepare(
          `UPDATE captures SET status = 'ready', mode = ?, http_status = ?, snapshot_path = ?,
             final_url = ?, extracted_title = ?, extracted_author = ?,
             extracted_published_at = ?, extracted_canonical_url = ?, extracted_markdown = ?,
             extractor_version = ?, warning = ?, finished_at = ? WHERE id = ?`,
        )
        .run(
          result.mode,
          result.httpStatus,
          snapshotPath,
          result.finalUrl,
          result.title,
          result.author,
          result.publishedAt,
          result.canonicalUrl,
          result.markdown,
          result.extractorVersion ?? null,
          result.warning,
          timestamp,
          job.captureId,
        );
      this.sql
        .prepare("UPDATE capture_jobs SET status = 'done', updated_at = ? WHERE id = ?")
        .run(timestamp, job.id);
      this.recordRevision(this.getDocument(job.documentId)!);
    });
    return this.getDocument(job.documentId)!;
  }

  failCapture(job: CaptureJob, code: CaptureErrorCode, message: string) {
    const timestamp = now();
    transaction(this.sql, () => {
      this.sql
        .prepare(
          `UPDATE documents SET status = 'failed', error_code = ?, error_message = ?,
             warning = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(code, message, timestamp, job.documentId);
      this.sql
        .prepare(
          `UPDATE captures SET status = 'failed', error_code = ?, error_message = ?,
             finished_at = ? WHERE id = ?`,
        )
        .run(code, message, timestamp, job.captureId);
      this.sql
        .prepare("UPDATE capture_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
        .run(message, timestamp, job.id);
    });
    return this.getDocument(job.documentId)!;
  }

  hasPendingCaptures() {
    const row = this.sql
      .prepare(
        `SELECT 1 AS found FROM capture_jobs j JOIN documents d ON d.id = j.document_id
         WHERE j.status IN ('queued', 'running') AND d.deleted_at IS NULL LIMIT 1`,
      )
      .get() as { found: number } | undefined;
    return Boolean(row);
  }

}

export function openDatabase(dataDir: string) {
  return new KnowledgeDatabase(dataDir);
}
