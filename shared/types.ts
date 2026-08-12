export type CaptureStatus = "queued" | "fetching" | "extracting" | "ready" | "failed";

export type CaptureMode = "http" | "browser";

export type CaptureErrorCode =
  | "INVALID_URL"
  | "BLOCKED_ADDRESS"
  | "FETCH_TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "HTTP_ERROR"
  | "EXTRACTION_EMPTY"
  | "BROWSER_FAILED"
  | "CAPTURE_CANCELLED"
  | "INTERNAL_ERROR";

export interface DocumentCollection {
  id: string;
  name: string;
}

export interface KnowledgeTag {
  name: string;
  documentCount: number;
}

export interface TagMutationResponse {
  tag: KnowledgeTag | null;
  affectedDocuments: number;
}

export interface KnowledgeCollection extends DocumentCollection {
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeleteCollectionResponse {
  deleted: true;
  affectedDocuments: number;
}

export interface MergeCollectionResponse {
  collection: KnowledgeCollection;
  affectedDocuments: number;
}

export interface DocumentSummary {
  id: string;
  title: string;
  sourceUrl: string;
  finalUrl: string | null;
  canonicalUrl: string | null;
  author: string | null;
  status: CaptureStatus;
  warning: string | null;
  errorCode: CaptureErrorCode | null;
  errorMessage: string | null;
  tags: string[];
  collections: DocumentCollection[];
  favorite: boolean;
  archivedAt: string | null;
  revision: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocument extends DocumentSummary {
  publishedAt: string | null;
  markdown: string;
  captureMode: CaptureMode | null;
  sourceNote: string;
}

export const TRANSLATION_LANGUAGES = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  fr: "Français",
  de: "Deutsch",
  es: "Español",
  pt: "Português",
  ru: "Русский",
  ar: "العربية",
} as const;

export type TranslationLanguage = keyof typeof TRANSLATION_LANGUAGES;

export type DerivedResultType = "summary" | "outline" | "keywords" | "tag-suggestions" | "translation";

export interface DerivedResultUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface DerivedResult {
  id: string;
  documentId: string;
  type: DerivedResultType;
  model: string;
  endpointId: string;
  promptVersion: string;
  targetLanguage: TranslationLanguage | null;
  inputHash: string;
  output: string;
  durationMs: number;
  usage: DerivedResultUsage | null;
  sourceChars: number;
  sentChars: number;
  truncated: boolean;
  pinned: boolean;
  stale: boolean;
  createdAt: string;
}

export interface SaveDerivedResultInput {
  documentId: string;
  type: DerivedResultType;
  model: string;
  /** Opaque, non-secret identifier. It must not contain an endpoint URL or credential. */
  endpointId: string;
  promptVersion: string;
  inputHash: string;
  output: string;
  durationMs: number;
  usage?: DerivedResultUsage | null;
  sourceChars: number;
  sentChars: number;
  truncated: boolean;
}

export interface DerivedResultListResponse {
  items: DerivedResult[];
  page: number;
  pageSize: number;
  total: number;
}

export interface DeleteDerivedResultsResponse {
  deleted: true;
  deletedResults: number;
}

export type LlmEndpointKind = "remote" | "local";

export interface LlmEndpointSettings {
  endpointUrl: string;
  model: string;
}

export interface LlmSettings {
  enabled: boolean;
  target: LlmEndpointKind;
  remote: LlmEndpointSettings;
  local: LlmEndpointSettings & { trusted: boolean };
  revision: number;
  apiKeyConfigured: boolean;
}

export type UpdateLlmSettingsInput = Omit<LlmSettings, "apiKeyConfigured">;

export interface DerivedCoverage {
  sourceChars: number;
  sentChars: number;
  truncated: boolean;
}

export interface DerivedPreview {
  type: DerivedResultType;
  targetLanguage: TranslationLanguage | null;
  revision: number;
  inputHash: string;
  promptVersion: string;
  settingsRevision: number;
  model: string;
  endpointId: string;
  target: { kind: LlmEndpointKind; url: string };
  coverage: DerivedCoverage;
  sentText: string;
}

export interface StartDerivedTaskInput {
  type: DerivedResultType;
  targetLanguage?: TranslationLanguage;
  revision: number;
  inputHash: string;
  settingsRevision: number;
}

export type DerivedTaskStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface DerivedTask {
  id: string;
  documentId: string;
  type: DerivedResultType;
  targetLanguage: TranslationLanguage | null;
  status: DerivedTaskStatus;
  preview: DerivedPreview;
  result: DerivedResult | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface DocumentListResponse {
  items: DocumentSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export type DocumentSearchScope = "all" | "title" | "body" | "source";

export type DocumentSort = "updated" | "created" | "title";

export interface DocumentFilters {
  q?: string;
  scope?: DocumentSearchScope;
  tag?: string;
  collectionId?: string;
  status?: CaptureStatus | "";
  favorite?: boolean;
  archived?: boolean;
  unorganized?: boolean;
  from?: string;
  to?: string;
  captureMode?: CaptureMode;
  sort?: DocumentSort;
  page?: number;
  trash?: "only";
}

export interface RecentFilter {
  label: string;
  query: string;
  scope: DocumentSearchScope;
  tag: string;
  collectionId: string;
  status: CaptureStatus | "";
  favorite?: boolean;
  archived?: boolean;
  unorganized: boolean;
  captureMode: CaptureMode | "";
  from: string;
  to: string;
  sort: DocumentSort;
}

export interface RecentFiltersState {
  filters: RecentFilter[];
  revision: number;
}

export type ImportKind = "urls" | "bookmarks" | "markdown" | "bundle";

export type ImportStrategy = "skip" | "copy" | "update";

export interface ImportPreviewItem {
  id: string;
  index: number;
  label: string;
  sourceUrl: string | null;
  status: "valid" | "duplicate" | "invalid";
  existingDocumentId: string | null;
  warnings: string[];
  error: string | null;
}

export interface ImportPreview {
  id: string;
  kind: ImportKind;
  status: "preview";
  createdAt: string;
  counts: { total: number; valid: number; duplicate: number; invalid: number; assets?: number };
  items: ImportPreviewItem[];
}

export interface ImportApplyItem {
  id: string;
  index: number;
  status: "created" | "updated" | "skipped" | "conflict" | "failed";
  documentId: string | null;
  error: string | null;
}

export interface ImportApplyResult {
  id: string;
  status: "applied";
  strategy: ImportStrategy;
  counts: { created: number; updated: number; skipped: number; conflicts: number; failed: number };
  items: ImportApplyItem[];
}

export type BatchDocumentAction =
  | "add-tag"
  | "remove-tag"
  | "add-collection"
  | "remove-collection"
  | "archive"
  | "unarchive"
  | "trash"
  | "restore";

export interface BatchDocumentTarget {
  id: string;
  revision: number;
}

export interface BatchDocumentsRequest {
  documents: BatchDocumentTarget[];
  action: BatchDocumentAction;
  value?: string;
}

export interface BatchDocumentResult {
  id: string;
  changed: boolean;
  revision: number | null;
}

export interface BatchDocumentsResponse {
  affectedDocuments: number;
  results: BatchDocumentResult[];
}

export type DuplicateKind = "source" | "resolved" | null;

export interface CreateDocumentResponse {
  document: KnowledgeDocument;
  created: boolean;
  duplicateKind: DuplicateKind;
}

export interface CaptureQueueStatus {
  paused: boolean;
  active: number;
  queued: number;
}

export interface DocumentRevision {
  revision: number;
  title: string;
  markdown: string;
  tags: string[];
  createdAt: string;
}

export interface DocumentDraft {
  documentId: string;
  draftRevision: number;
  baseRevision: number;
  title: string;
  markdown: string;
  tags: string[];
  updatedAt: string;
}

export interface CaptureHistoryItem {
  id: string;
  documentId: string;
  status: Exclude<CaptureStatus, "queued">;
  mode: CaptureMode | null;
  requestUrl: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  snapshotStored: "available" | "missing" | "none";
  extractorVersion: string | null;
  warning: string | null;
  errorCode: CaptureErrorCode | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface ReextractionPreview {
  captureId: string;
  baseRevision: number;
  extractorVersion: string;
  before: { title: string; markdown: string };
  after: { title: string; markdown: string };
  createdAt: string;
}

export type AssetStatus = "queued" | "fetching" | "ready" | "failed";

export type AssetMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp"
  | "image/avif";

export interface DocumentAsset {
  documentId: string;
  sourceUrl: string;
  status: AssetStatus;
  assetHash: string | null;
  mimeType: AssetMimeType | null;
  byteSize: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetSettings {
  maxAssetBytes: number;
  maxAssetsPerDocument: number;
  maxDocumentAssetBytes: number;
  concurrency: number;
}

export type BackupReason = "manual" | "automatic" | "pre-migration" | "pre-restore";

export type BackupStatus = "creating" | "verified" | "failed" | "invalid" | "missing";

export interface BackupRecord {
  id: string;
  directoryName: string | null;
  reason: BackupReason;
  status: BackupStatus;
  createdAt: string;
  finishedAt: string | null;
  verifiedAt: string | null;
  totalBytes: number | null;
  schemaVersion: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface BackupSettings {
  automaticRetentionCount: number;
}

export interface DatabaseHealth {
  integrityCheck: string[];
  foreignKeyViolations: Array<{
    table: string;
    rowId: number | null;
    parent: string;
    foreignKeyId: number;
  }>;
  referencedSnapshotPaths: string[];
  referencedAssetPaths: string[];
  pendingFileDeletions: Array<{
    path: string;
    attempts: number;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  recentErrors: Array<{
    source: "capture" | "asset" | "backup" | "file-deletion";
    code: string | null;
    message: string;
    occurredAt: string;
  }>;
}

export interface DataSafetyHealth {
  database: DatabaseHealth;
  missingSnapshots: string[];
  orphanSnapshots: string[];
  unsafeSnapshotEntries: string[];
  missingAssets: string[];
  orphanAssets: string[];
  unsafeAssetEntries: string[];
  storageBytes: number;
  recentBackup: BackupRecord | null;
}

export interface DataSafetyStatus {
  mode: "ready" | "recovery";
  maintenance: boolean;
  recoveryError: { code: string; message: string } | null;
  health: DataSafetyHealth | null;
  backups: BackupRecord[];
  settings: BackupSettings | null;
}

export interface OnboardingState {
  completed: boolean;
  revision: number;
}

export type DiagnosticLogLevel = "info" | "warning" | "error";

export type DiagnosticLogEvent =
  | "service_starting"
  | "service_ready"
  | "service_stopping"
  | "backup_cleanup_failed"
  | "backup_reconciliation_failed"
  | "automatic_backup_failed"
  | "asset_cache_failed"
  | "capture_failed"
  | "restore_reconciliation_failed"
  | "unexpected_api_error"
  | "server_error";

export interface DiagnosticLogEntry {
  timestamp: string;
  level: DiagnosticLogLevel;
  event: DiagnosticLogEvent;
  code?: string;
  durationMs?: number;
  count?: number;
  mode?: "web" | "desktop" | CaptureMode | "recovery";
}

export interface DiagnosticReport {
  format: "zhiye-diagnostics";
  formatVersion: 1;
  generatedAt: string;
  application: {
    version: string;
    nodeVersion: string;
    platform: string;
    architecture: string;
    desktop: boolean;
  };
  schema: {
    current: number | null;
    supported: number;
    status: "current" | "unavailable";
  };
  queue: CaptureQueueStatus | null;
  health: null | {
    databaseIntegrity: "ok" | "failed";
    foreignKeyViolations: number;
    missingSnapshots: number;
    orphanSnapshots: number;
    unsafeSnapshotEntries: number;
    missingAssets: number;
    orphanAssets: number;
    unsafeAssetEntries: number;
    pendingFileDeletions: number;
    storageBytes: number;
    recentBackup: null | Pick<
      BackupRecord,
      "reason" | "status" | "createdAt" | "schemaVersion" | "totalBytes"
    >;
  };
  recentErrors: Array<{
    source: DatabaseHealth["recentErrors"][number]["source"] | "startup";
    code: string;
    occurredAt: string;
  }>;
  logs: DiagnosticLogEntry[];
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    document?: KnowledgeDocument;
    draft?: DocumentDraft | null;
  };
}
