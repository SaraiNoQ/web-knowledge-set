import type {
  ApiError,
  BackupRecord,
  BackupSettings,
  CaptureHistoryItem,
  CaptureQueueStatus,
  CaptureStatus,
  CreateDocumentResponse,
  DataSafetyStatus,
  DeleteCollectionResponse,
  DocumentAsset,
  DocumentDraft,
  DocumentListResponse,
  DocumentRevision,
  DocumentSummary,
  KnowledgeCollection,
  KnowledgeDocument,
  ReextractionPreview,
} from "../shared/types";

export type { DataSafetyStatus } from "../shared/types";

const DATA_EPOCH_HEADER = "X-Zhiye-Data-Epoch";
let dataEpoch: string | null = null;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "REQUEST_FAILED",
    readonly document?: KnowledgeDocument,
    readonly draft?: DocumentDraft | null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init: RequestInit = {}, replaceDataEpoch = false): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  if (init.body && dataEpoch) headers.set(DATA_EPOCH_HEADER, dataEpoch);

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  const responseEpoch = response.headers.get(DATA_EPOCH_HEADER);
  if (responseEpoch) {
    if (dataEpoch === null || (replaceDataEpoch && response.ok)) dataEpoch = responseEpoch;
    else if (responseEpoch !== dataEpoch) {
      throw new ApiRequestError("本地知识库已从留档恢复，请刷新页面后继续。", 409, "STALE_DATA_EPOCH");
    }
  }

  if (!response.ok) {
    let payload: ApiError | undefined;
    try {
      payload = (await response.json()) as ApiError;
    } catch {
      // Non-JSON failures still surface with a useful HTTP fallback.
    }
    throw new ApiRequestError(
      payload?.error.message || `请求失败（${response.status}）`,
      response.status,
      payload?.error.code,
      payload?.error.document,
      payload?.error.draft,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface DocumentFilters {
  q?: string;
  tag?: string;
  status?: CaptureStatus | "";
  trash?: "only";
  page?: number;
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
  revision: number;
}

export interface RestoreBackupResult {
  backupId: string;
  preRestoreBackupId: string | null;
  quarantinedDataPath: string | null;
  cleanupPending: boolean;
}

export interface CleanupDataResult {
  queued: string[];
  referenced: string[];
  deleted: string[];
  unsafeSnapshotEntries: string[];
}

export const api = {
  getDataSafety(signal?: AbortSignal) {
    return request<DataSafetyStatus>("/api/data-safety", { signal });
  },

  createBackup() {
    return request<BackupRecord>("/api/data-safety/backups", {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  verifyBackup(id: string) {
    return request<BackupRecord>(`/api/data-safety/backups/${encodeURIComponent(id)}/verify`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  restoreBackup(id: string, allowQuarantine = false) {
    return request<RestoreBackupResult>(`/api/data-safety/backups/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      body: JSON.stringify({ allowQuarantine }),
    }, true);
  },

  updateBackupSettings(automaticRetentionCount: number) {
    return request<BackupSettings>("/api/data-safety/settings", {
      method: "PATCH",
      body: JSON.stringify({ automaticRetentionCount }),
    });
  },

  cleanupData() {
    return request<CleanupDataResult>("/api/data-safety/cleanup", {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  listTags(trash?: "only", signal?: AbortSignal) {
    return request<string[]>(`/api/tags${trash ? "?trash=only" : ""}`, { signal });
  },

  listCollections(signal?: AbortSignal) {
    return request<KnowledgeCollection[]>("/api/collections", { signal });
  },

  createCollection(name: string) {
    return request<KnowledgeCollection>("/api/collections", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },

  updateCollection(id: string, name: string) {
    return request<KnowledgeCollection>(`/api/collections/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  },

  deleteCollection(id: string) {
    return request<DeleteCollectionResponse>(`/api/collections/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({}),
    });
  },

  listDocuments(filters: DocumentFilters, signal?: AbortSignal) {
    const query = new URLSearchParams();
    if (filters.q?.trim()) query.set("q", filters.q.trim());
    if (filters.tag) query.set("tag", filters.tag);
    if (filters.status) query.set("status", filters.status);
    if (filters.trash) query.set("trash", filters.trash);
    query.set("page", String(filters.page || 1));
    return request<DocumentListResponse>(`/api/documents?${query}`, { signal });
  },

  createDocument(url: string, force = false) {
    return request<CreateDocumentResponse>("/api/documents", {
      method: "POST",
      body: JSON.stringify(force ? { url, force: true } : { url }),
    });
  },

  getCaptureQueue(signal?: AbortSignal) {
    return request<CaptureQueueStatus>("/api/capture-queue", { signal });
  },

  updateCaptureQueue(paused: boolean) {
    return request<CaptureQueueStatus>("/api/capture-queue", {
      method: "PATCH",
      body: JSON.stringify({ paused }),
    });
  },

  getDocument(id: string, signal?: AbortSignal) {
    return request<KnowledgeDocument>(`/api/documents/${encodeURIComponent(id)}`, { signal });
  },

  getDocumentDuplicate(id: string, signal?: AbortSignal) {
    return request<DocumentSummary | null>(`/api/documents/${encodeURIComponent(id)}/duplicate`, { signal });
  },

  cancelDocument(id: string) {
    return request<KnowledgeDocument>(`/api/documents/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  listDocumentAssets(id: string, signal?: AbortSignal) {
    return request<DocumentAsset[]>(`/api/documents/${encodeURIComponent(id)}/assets`, { signal });
  },

  assetUrl(hash: string) {
    return `/api/assets/${encodeURIComponent(hash)}`;
  },

  listCaptureHistory(id: string, signal?: AbortSignal) {
    return request<CaptureHistoryItem[]>(`/api/documents/${encodeURIComponent(id)}/captures`, { signal });
  },

  reextractCapture(documentId: string, captureId: string) {
    return request<ReextractionPreview>(
      `/api/documents/${encodeURIComponent(documentId)}/captures/${encodeURIComponent(captureId)}/reextract`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },

  getDocumentDraft(id: string, signal?: AbortSignal) {
    return request<DocumentDraft | null>(`/api/documents/${encodeURIComponent(id)}/draft`, { signal });
  },

  saveDocumentDraft(
    id: string,
    draft: Omit<DocumentDraft, "documentId" | "draftRevision" | "updatedAt"> & {
      expectedDraftRevision: number | null;
    },
  ) {
    return request<DocumentDraft>(`/api/documents/${encodeURIComponent(id)}/draft`, {
      method: "PUT",
      body: JSON.stringify(draft),
    });
  },

  deleteDocumentDraft(id: string, draftRevision: number) {
    return request<void>(`/api/documents/${encodeURIComponent(id)}/draft`, {
      method: "DELETE",
      body: JSON.stringify({ draftRevision }),
    });
  },

  desktopCloseReady(attemptId: string) {
    return request<{ ok: true }>("/api/desktop/close-ready", {
      method: "POST",
      body: JSON.stringify({ attemptId }),
    });
  },

  updateDocument(id: string, patch: DocumentPatch) {
    return request<KnowledgeDocument>(`/api/documents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },

  retryDocument(id: string) {
    return request<KnowledgeDocument>(`/api/documents/${encodeURIComponent(id)}/retry`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  deleteDocument(id: string, revision: number) {
    return request<KnowledgeDocument>(`/api/documents/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ revision }),
    });
  },

  restoreDocument(id: string, revision: number) {
    return request<KnowledgeDocument>(`/api/documents/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      body: JSON.stringify({ revision }),
    });
  },

  permanentlyDeleteDocument(id: string, revision: number, draftRevision: number | null) {
    return request<void>(`/api/documents/${encodeURIComponent(id)}/permanent`, {
      method: "DELETE",
      body: JSON.stringify({ revision, draftRevision }),
    });
  },

  listDocumentRevisions(id: string) {
    return request<DocumentRevision[]>(`/api/documents/${encodeURIComponent(id)}/revisions`);
  },

  restoreDocumentRevision(id: string, revision: number, currentRevision: number) {
    return request<KnowledgeDocument>(
      `/api/documents/${encodeURIComponent(id)}/revisions/${revision}/restore`,
      { method: "POST", body: JSON.stringify({ revision: currentRevision }) },
    );
  },

  exportUrl(id: string) {
    return `/api/documents/${encodeURIComponent(id)}/export.md`;
  },
};
