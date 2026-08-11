import type {
  ApiError,
  BackupRecord,
  BackupSettings,
  BatchDocumentsRequest,
  BatchDocumentsResponse,
  CaptureHistoryItem,
  CaptureQueueStatus,
  CreateDocumentResponse,
  DataSafetyStatus,
  DiagnosticReport,
  DeleteCollectionResponse,
  DerivedPreview,
  DerivedResult,
  DerivedResultListResponse,
  DerivedResultType,
  DerivedTask,
  DocumentAsset,
  DocumentDraft,
  DocumentFilters,
  DocumentListResponse,
  DocumentRevision,
  DocumentSummary,
  ImportApplyResult,
  ImportPreview,
  OnboardingState,
  ImportStrategy,
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeTag,
  MergeCollectionResponse,
  LlmSettings,
  RecentFilter,
  RecentFiltersState,
  ReextractionPreview,
  TagMutationResponse,
  UpdateLlmSettingsInput,
} from "../shared/types";

export type { DataSafetyStatus, DocumentFilters, RecentFilter } from "../shared/types";

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

async function requestResponse(path: string, init: RequestInit = {}, replaceDataEpoch = false) {
  if (init.body && dataEpoch === null) await requestResponse("/api/capture-queue");
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
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

  return response;
}

async function request<T>(path: string, init: RequestInit = {}, replaceDataEpoch = false): Promise<T> {
  const response = await requestResponse(path, init, replaceDataEpoch);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
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
  getOnboarding(signal?: AbortSignal) {
    return request<OnboardingState>("/api/settings/onboarding", { signal });
  },

  saveOnboarding(completed: boolean, revision: number) {
    return request<OnboardingState>("/api/settings/onboarding", {
      method: "PUT",
      body: JSON.stringify({ completed, revision }),
    });
  },

  getDiagnostics(signal?: AbortSignal) {
    return request<DiagnosticReport>("/api/diagnostics", { signal });
  },

  async exportDiagnostics(signal?: AbortSignal) {
    const response = await requestResponse("/api/diagnostics/export.zip", {
      headers: { Accept: "application/zip" },
      signal,
    });
    const disposition = response.headers.get("Content-Disposition") || "";
    const fileName = /filename="?([^";]+)"?/iu.exec(disposition)?.[1]?.replace(/[\\/]/gu, "-") || "zhiye-diagnostics.zip";
    return { blob: await response.blob(), fileName };
  },

  getLlmSettings(signal?: AbortSignal) {
    return request<LlmSettings>("/api/settings/llm", { signal });
  },

  updateLlmSettings(settings: UpdateLlmSettingsInput) {
    return request<LlmSettings>("/api/settings/llm", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  },

  disableLlm(revision: number, deleteResults: boolean) {
    return request<{ settings: LlmSettings; deletedResults: number }>("/api/settings/llm/disable", {
      method: "POST",
      body: JSON.stringify({ revision, deleteResults }),
    });
  },

  previewDerivedResult(documentId: string, type: DerivedResultType, revision: number) {
    return request<DerivedPreview>(`/api/documents/${encodeURIComponent(documentId)}/derived-preview`, {
      method: "POST",
      body: JSON.stringify({ type, revision }),
    });
  },

  startDerivedTask(documentId: string, preview: DerivedPreview) {
    return request<DerivedTask>(`/api/documents/${encodeURIComponent(documentId)}/derived-task`, {
      method: "POST",
      body: JSON.stringify({
        type: preview.type,
        revision: preview.revision,
        inputHash: preview.inputHash,
        settingsRevision: preview.settingsRevision,
      }),
    });
  },

  getDerivedTask(documentId: string, signal?: AbortSignal) {
    return request<DerivedTask | null>(`/api/documents/${encodeURIComponent(documentId)}/derived-task`, { signal });
  },

  getDerivedTaskById(id: string, signal?: AbortSignal) {
    return request<DerivedTask>(`/api/derived-tasks/${encodeURIComponent(id)}`, { signal });
  },

  cancelDerivedTask(id: string) {
    return request<DerivedTask>(`/api/derived-tasks/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({}),
    });
  },

  retryDerivedTask(id: string) {
    return request<DerivedTask>(`/api/derived-tasks/${encodeURIComponent(id)}/retry`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  listDerivedResults(documentId: string, page = 1, signal?: AbortSignal) {
    return request<DerivedResultListResponse>(`/api/documents/${encodeURIComponent(documentId)}/derived-results?page=${page}`, { signal });
  },

  pinDerivedResult(documentId: string, resultId: string, pinned: boolean) {
    return request<DerivedResult>(`/api/documents/${encodeURIComponent(documentId)}/derived-results/${encodeURIComponent(resultId)}`, {
      method: "PATCH",
      body: JSON.stringify({ pinned }),
    });
  },

  deleteDerivedResult(documentId: string, resultId: string) {
    return request<void>(`/api/documents/${encodeURIComponent(documentId)}/derived-results/${encodeURIComponent(resultId)}`, {
      method: "DELETE",
      body: JSON.stringify({}),
    });
  },

  async exportPortable(scope: "all" | "selected", documentIds: string[], signal?: AbortSignal) {
    const response = await requestResponse("/api/exports/portable", {
      method: "POST",
      headers: { Accept: "application/zip" },
      body: JSON.stringify(scope === "all" ? { scope } : { scope, documentIds }),
      signal,
    });
    const disposition = response.headers.get("Content-Disposition") || "";
    const fileName = /filename="?([^";]+)"?/iu.exec(disposition)?.[1]?.replace(/[\\/]/gu, "-") || "zhiye-export.zip";
    return { blob: await response.blob(), fileName };
  },

  previewBundle(file: File, signal?: AbortSignal) {
    return request<ImportPreview>("/api/imports/bundle/preview", {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: file,
      signal,
    });
  },

  previewImport(body: { kind: "urls" | "bookmarks"; content: string } | { kind: "markdown"; files: Array<{ path: string; content: string }> }, signal?: AbortSignal) {
    return request<ImportPreview>("/api/imports/preview", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    });
  },

  applyImport(id: string, strategy: ImportStrategy, signal?: AbortSignal) {
    return request<ImportApplyResult>(`/api/imports/${encodeURIComponent(id)}/apply`, {
      method: "POST",
      body: JSON.stringify({ strategy }),
      signal,
    });
  },

  cancelImport(id: string, signal?: AbortSignal) {
    return request<void>(`/api/imports/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({}),
      signal,
    });
  },

  getRecentFilters(signal?: AbortSignal) {
    return request<RecentFiltersState>("/api/settings/recent-filters", { signal });
  },

  saveRecentFilters(filters: RecentFilter[], revision: number) {
    return request<RecentFiltersState>("/api/settings/recent-filters", {
      method: "PUT",
      body: JSON.stringify({ filters, revision }),
    });
  },

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

  listManagedTags(signal?: AbortSignal) {
    return request<KnowledgeTag[]>("/api/tags/manage", { signal });
  },

  renameTag(name: string, newName: string) {
    return request<TagMutationResponse>(`/api/tags/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: newName }),
    });
  },

  mergeTag(name: string, targetName: string) {
    return request<TagMutationResponse>(`/api/tags/${encodeURIComponent(name)}/merge`, {
      method: "POST",
      body: JSON.stringify({ target: targetName }),
    });
  },

  deleteTag(name: string) {
    return request<TagMutationResponse>(`/api/tags/${encodeURIComponent(name)}`, {
      method: "DELETE",
      body: JSON.stringify({}),
    });
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

  mergeCollection(id: string, targetId: string) {
    return request<MergeCollectionResponse>(`/api/collections/${encodeURIComponent(id)}/merge`, {
      method: "POST",
      body: JSON.stringify({ targetId }),
    });
  },

  listDocuments(filters: DocumentFilters, signal?: AbortSignal) {
    const query = new URLSearchParams();
    if (filters.q?.trim()) query.set("q", filters.q.trim());
    if (filters.scope) query.set("scope", filters.scope);
    if (filters.tag) query.set("tag", filters.tag);
    if (filters.collectionId) query.set("collectionId", filters.collectionId);
    if (filters.status) query.set("status", filters.status);
    if (filters.favorite !== undefined) query.set("favorite", String(filters.favorite));
    if (filters.archived !== undefined) query.set("archived", String(filters.archived));
    if (filters.unorganized !== undefined) query.set("unorganized", String(filters.unorganized));
    if (filters.from) query.set("from", filters.from);
    if (filters.to) query.set("to", filters.to);
    if (filters.captureMode) query.set("captureMode", filters.captureMode);
    if (filters.sort) query.set("sort", filters.sort);
    if (filters.trash) query.set("trash", filters.trash);
    query.set("page", String(filters.page || 1));
    return request<DocumentListResponse>(`/api/documents?${query}`, { signal });
  },

  batchDocuments(body: BatchDocumentsRequest) {
    return request<BatchDocumentsResponse>("/api/documents/batch", {
      method: "POST",
      body: JSON.stringify(body),
    });
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
