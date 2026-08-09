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
  | "INTERNAL_ERROR";

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
  revision: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocument extends DocumentSummary {
  publishedAt: string | null;
  markdown: string;
  captureMode: CaptureMode | null;
}

export interface DocumentListResponse {
  items: DocumentSummary[];
  page: number;
  pageSize: number;
  total: number;
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
  pendingFileDeletions: Array<{
    path: string;
    attempts: number;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  recentErrors: Array<{
    source: "capture" | "backup" | "file-deletion";
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

export interface ApiError {
  error: {
    code: string;
    message: string;
    document?: KnowledgeDocument;
    draft?: DocumentDraft | null;
  };
}
