import { documentListUrl } from "./document-list-url";
import type {
  AppearanceSettings,
  ApiError,
  BackupRecord,
  BackupSettings,
  BrowserExtensionPairing,
  BrowserExtensionPairingCode,
  BatchDocumentsRequest,
  BatchDocumentsResponse,
  CaptureHistoryItem,
  CaptureQueueStatus,
  CreateDocumentResponse,
  DataSafetyStatus,
  StartupStatus,
  DiagnosticReport,
  DeleteCollectionResponse,
  DeleteFolderResponse,
  DerivedPreview,
  DerivedResult,
  DerivedResultListResponse,
  DerivedResultType,
  DerivedTask,
  TranslationLanguage,
  DocumentAsset,
  DocumentDraft,
  DocumentFilters,
  DocumentListResponse,
  DocumentRevision,
  DocumentSummary,
  ImportApplyResult,
  ImportPreview,
  OnboardingState,
  PaperDocument,
  PaperExtractionPlan,
  PaperExtractionTask,
  PaperPage,
  PaperPageRenderResult,
  ImportStrategy,
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeFolder,
  KnowledgeMapResponse,
  LibraryItemKind,
  KnowledgeTag,
  LlmConnectionTestInput,
  LlmConnectionTestResult,
  MergeCollectionResponse,
  LlmSettings,
  LlmApiKeyStatus,
  RecentFilter,
  RecentFiltersState,
  ReextractionPreview,
  SemanticIndexStepResult,
  SemanticSettings,
  SemanticSettingsInput,
  SemanticVectorEntry,
  TagMutationResponse,
  UpdateLlmSettingsInput,
} from "../shared/types";
import { isAbortError, userErrorMessage } from "./error-messages";
import { PAPER_PAGE_IMAGE_TYPE } from "../shared/paper";
import type { ReadingAnnotation, DocumentConnection, SelectionTranslationInput, SourceAnchor } from "../shared/reader-tools";
import {
  cloudLlmCredentialHeaders,
  cloudLlmCredentialMatches,
  deleteCloudLlmCredential,
  loadCloudLlmCredential,
  saveCloudLlmCredential,
  cloudSemanticCredentialConfigured,
  cloudSemanticCredentialHeaders,
  deleteCloudSemanticCredential,
  loadCloudSemanticCredential,
  saveCloudSemanticCredential,
} from "./cloud-llm-credential";

export type { DataSafetyStatus, DocumentFilters, RecentFilter } from "../shared/types";

const DATA_EPOCH_HEADER = "X-Zhiye-Data-Epoch";
let dataEpoch: string | null = null;
export function currentDataEpoch() { return dataEpoch; }
let cloudRuntime = globalThis.location?.hostname === "zhiye.sarainoq.cn";
function cloudCredentialStorage() {
  if (globalThis.location?.hostname !== "zhiye.sarainoq.cn") return null;
  try { return globalThis.localStorage; } catch { return null; }
}
function currentCloudLlmCredential() {
  const storage = cloudCredentialStorage();
  return storage ? loadCloudLlmCredential(storage) : null;
}

export function cloudLlmHeaders(endpointUrl: string): Record<string, string> {
  return cloudRuntime ? cloudLlmCredentialHeaders(currentCloudLlmCredential(), endpointUrl) : {};
}

function cloudSemanticHeaders(): Record<string, string> {
  const credential = cloudCredentialStorage() ? loadCloudSemanticCredential(cloudCredentialStorage()!) : null;
  return cloudRuntime ? cloudSemanticCredentialHeaders(credential) : {};
}

function wakeSemanticIndexer() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("zhiye:semantic-wake"));
}

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

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new ApiRequestError(userErrorMessage("LOCAL_SERVICE_UNREACHABLE"), 0, "LOCAL_SERVICE_UNREACHABLE");
  }
  const responseEpoch = response.headers.get(DATA_EPOCH_HEADER);
  if (responseEpoch) {
    if (dataEpoch === null || (replaceDataEpoch && response.ok)) dataEpoch = responseEpoch;
    else if (responseEpoch !== dataEpoch) {
      throw new ApiRequestError("知识库已从备份恢复，请刷新后继续。", 409, "STALE_DATA_EPOCH");
    }
  }

  if (!response.ok) {
    let payload: ApiError | undefined;
    try {
      payload = (await response.json()) as ApiError;
    } catch {
      // Non-JSON failures still surface with a useful HTTP fallback.
    }
    const code = payload?.error.code || "REQUEST_FAILED";
    throw new ApiRequestError(
      userErrorMessage(code, response.status),
      response.status,
      code,
      payload?.error.document,
      payload?.error.draft,
    );
  }

  return response;
}

export async function request<T>(path: string, init: RequestInit = {}, replaceDataEpoch = false): Promise<T> {
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
  folderId?: string | null;
  revision: number;
}

export interface ReaderDataSnapshot {
  page: number; totalAnnotations: number; totalConnections: number;
  annotations: ReadingAnnotation[];
  connections: Array<DocumentConnection & { peer: { id: string; title: string; kind: string } }>;
}

export async function streamSelectionTranslation(documentId: string, input: SelectionTranslationInput, onText: (text: string) => void, signal: AbortSignal) {
  const settings = await api.getLlmSettings(signal);
  const response = await requestResponse(`/api/reader-tools/documents/${encodeURIComponent(documentId)}/translate`, {
    method: "POST", headers: cloudLlmHeaders(settings.remote.endpointUrl), body: JSON.stringify(input), signal,
  });
  if (!response.body) throw new ApiRequestError("翻译服务没有返回内容。", 502, "LLM_INVALID_RESPONSE");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", complete = false, total = 0;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const packet = JSON.parse(line) as { type?: string; text?: unknown; code?: string };
    if (packet.type === "error") throw new ApiRequestError(userErrorMessage(packet.code ?? "LLM_NETWORK_ERROR"), 502, packet.code);
    if (packet.type === "done") { complete = true; return; }
    if (packet.type !== "delta" || typeof packet.text !== "string" || complete) throw new ApiRequestError("翻译响应格式无效。", 502, "LLM_INVALID_RESPONSE");
    total += packet.text.length;
    if (total > 64_000) throw new ApiRequestError("译文过长，请缩短选区。", 502, "LLM_RESPONSE_TOO_LARGE");
    onText(packet.text);
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const value = await reader.read();
      if (value.done) break;
      buffer += decoder.decode(value.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (buffer.length > 256_000) throw new ApiRequestError("翻译响应过长。", 502, "LLM_RESPONSE_TOO_LARGE");
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (!complete) throw new ApiRequestError("翻译中断，请重试。", 502, "LLM_INVALID_RESPONSE");
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export const readerDataApi = {
  connections: (id: string, signal?: AbortSignal) => request<ReaderDataSnapshot>(`/api/reader-tools/documents/${encodeURIComponent(id)}/data?projection=connections`, { signal }),
  list: (id: string, signal?: AbortSignal, page = 1) => request<ReaderDataSnapshot>(`/api/reader-tools/documents/${encodeURIComponent(id)}/data?page=${page}`, { signal }),
  annotate: (id: string, revision: number, anchor: SourceAnchor, note = "", translation = "") => request<ReadingAnnotation>(`/api/reader-tools/documents/${encodeURIComponent(id)}/annotations`, { method: "POST", body: JSON.stringify({ revision, anchor, note, translation }) }),
  update: (id: string, annotation: ReadingAnnotation, note: string) => request<ReadingAnnotation>(`/api/reader-tools/documents/${encodeURIComponent(id)}/annotations/${encodeURIComponent(annotation.id)}`, { method: "PATCH", body: JSON.stringify({ revision: annotation.revision, note }) }),
  remove: (id: string, annotation: ReadingAnnotation) => request(`/api/reader-tools/documents/${encodeURIComponent(id)}/annotations/${encodeURIComponent(annotation.id)}`, { method: "DELETE", body: JSON.stringify({ revision: annotation.revision }) }),
  connect: (id: string, revision: number, targetId: string, note: string) => request(`/api/reader-tools/documents/${encodeURIComponent(id)}/connections`, { method: "POST", body: JSON.stringify({ revision, targetId, note }) }),
  disconnect: (id: string, connection: DocumentConnection) => request(`/api/reader-tools/documents/${encodeURIComponent(id)}/connections/${encodeURIComponent(connection.id)}`, { method: "DELETE", body: JSON.stringify({ revision: connection.revision }) }),
};

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
  unsafeAssetEntries: string[];
}

export const api = {
  async getRuntimeMode(signal?: AbortSignal) {
    const health = await request<{ mode?: string }>("/health", { signal });
    // Tauri always owns a local sidecar; keep a misreported health response
    // from sending desktop document requests through the Cloudflare API path.
    cloudRuntime = !("__TAURI_INTERNALS__" in globalThis) && health.mode === "cloud-core";
    return cloudRuntime ? "cloud" as const : "local" as const;
  },

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

  async getLlmSettings(signal?: AbortSignal) {
    const value = await request<LlmSettings>("/api/settings/llm", { signal });
    return cloudRuntime ? { ...value, apiKeyConfigured: cloudLlmCredentialMatches(currentCloudLlmCredential(), value.remote.endpointUrl) } : value;
  },

  getLlmApiKeyStatus(signal?: AbortSignal) {
    if (cloudRuntime) {
      const credential = currentCloudLlmCredential();
      return Promise.resolve({ configured: Boolean(credential), endpointUrl: credential?.endpointUrl ?? null });
    }
    return request<LlmApiKeyStatus>("/api/settings/llm/key", { signal });
  },

  testLlmConnection(input: LlmConnectionTestInput, signal?: AbortSignal) {
    return request<LlmConnectionTestResult>("/api/settings/llm/test", {
      method: "POST",
      headers: cloudLlmHeaders(input.endpointUrl),
      body: JSON.stringify(input),
      signal,
    });
  },

  updateLlmSettings(settings: UpdateLlmSettingsInput) {
    return request<LlmSettings>("/api/settings/llm", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  },

  setLlmApiKey(apiKey: string, endpointUrl: string) {
    if (cloudRuntime) {
      const storage = cloudCredentialStorage();
      if (!storage) return Promise.reject(new ApiRequestError(userErrorMessage("LLM_KEY_STORAGE_FAILED"), 0, "LLM_KEY_STORAGE_FAILED"));
      try {
        const credential = saveCloudLlmCredential(storage, apiKey, endpointUrl);
        return Promise.resolve({ configured: true, endpointUrl: credential.endpointUrl });
      } catch (cause) {
        const code = cause instanceof TypeError ? "INVALID_LLM_API_KEY" : "LLM_KEY_STORAGE_FAILED";
        return Promise.reject(new ApiRequestError(userErrorMessage(code), 0, code));
      }
    }
    return request<LlmApiKeyStatus>("/api/settings/llm/key", {
      method: "PUT",
      body: JSON.stringify({ apiKey, endpointUrl }),
    });
  },

  deleteLlmApiKey() {
    if (cloudRuntime) {
      try {
        const storage = cloudCredentialStorage();
        if (storage) deleteCloudLlmCredential(storage);
        return Promise.resolve({ configured: false, endpointUrl: null });
      } catch {
        return Promise.reject(new ApiRequestError(userErrorMessage("LLM_KEY_STORAGE_FAILED"), 0, "LLM_KEY_STORAGE_FAILED"));
      }
    }
    return request<LlmApiKeyStatus>("/api/settings/llm/key", {
      method: "DELETE",
      body: "{}",
    });
  },

  async getSemanticSettings(signal?: AbortSignal, includeEstimate = false) {
    const value = await request<SemanticSettings>("/api/settings/semantic" + (includeEstimate ? "?estimate=true" : ""), { signal });
    return cloudRuntime ? { ...value, apiKeyConfigured: cloudSemanticCredentialConfigured(
      cloudCredentialStorage() ? loadCloudSemanticCredential(cloudCredentialStorage()!) : null,
    ) } : value;
  },

  setSemanticSettings(value: SemanticSettingsInput) {
    return request<SemanticSettings>("/api/settings/semantic", {
      method: "PUT", headers: cloudSemanticHeaders(), body: JSON.stringify(value),
    }).then((result) => { wakeSemanticIndexer(); return result; });
  },

  setSemanticApiKey(apiKey: string) {
    if (cloudRuntime) {
      const storage = cloudCredentialStorage();
      if (!storage) return Promise.reject(new ApiRequestError("浏览器无法保存推荐密钥，请检查权限。", 0, "SEMANTIC_KEY_STORAGE_FAILED"));
      try {
        const credential = saveCloudSemanticCredential(storage, apiKey);
        wakeSemanticIndexer();
        return Promise.resolve({ configured: true, endpointUrl: credential.endpointUrl });
      } catch {
        return Promise.reject(new ApiRequestError("推荐密钥无效或无法保存。", 400, "SEMANTIC_KEY_INVALID"));
      }
    }
    return request<{ configured: boolean; endpointUrl: string | null }>("/api/settings/semantic/key", {
      method: "PUT", body: JSON.stringify({ apiKey }),
    }).then((result) => { wakeSemanticIndexer(); return result; });
  },

  async deleteSemanticApiKey() {
    if (cloudRuntime) {
      try {
        const storage = cloudCredentialStorage();
        const current = await request<SemanticSettings>("/api/settings/semantic");
        if (current.enabled) {
          await request<SemanticSettings>("/api/settings/semantic", {
            method: "PUT",
            body: JSON.stringify({ enabled: false, model: current.model, revision: current.revision }),
          });
        }
        if (storage) deleteCloudSemanticCredential(storage);
        wakeSemanticIndexer();
        return { configured: false, endpointUrl: null };
      } catch {
        throw new ApiRequestError("无法删除推荐密钥。", 0, "SEMANTIC_KEY_STORAGE_FAILED");
      }
    }
    const status = await request<{ configured: boolean; endpointUrl: string | null }>("/api/settings/semantic/key", {
      method: "DELETE", body: "{}",
    });
    wakeSemanticIndexer();
    return status;
  },

  testSemanticEmbedding(model: string, signal?: AbortSignal) {
    return request<{ ok: true; model: string; dimension: number }>("/api/semantic/test", {
      method: "POST", headers: cloudSemanticHeaders(), body: JSON.stringify({ model }), signal,
    });
  },

  async advanceSemanticIndex(signal?: AbortSignal) {
    const result = await request<SemanticIndexStepResult>("/api/semantic/index-step", {
      method: "POST", headers: cloudSemanticHeaders(), body: JSON.stringify({}), signal,
    });
    return result;
  },

  retrySemanticFailures() {
    return request<{ affectedDocuments: number }>("/api/semantic/retry", {
      method: "POST", headers: cloudSemanticHeaders(), body: JSON.stringify({}),
    }).then((result) => { wakeSemanticIndexer(); return result; });
  },

  rebuildSemanticIndexes() {
    return request<{ affectedDocuments: number }>("/api/semantic/rebuild", {
      method: "POST", headers: cloudSemanticHeaders(), body: JSON.stringify({}),
    }).then((result) => { wakeSemanticIndexer(); return result; });
  },

  listKnowledgeMapVectors(cursor?: string, signal?: AbortSignal, ids?: string[]) {
    const query = new URLSearchParams({ limit: "250" });
    if (cursor) query.set("cursor", cursor);
    if (ids) query.set("ids", JSON.stringify(ids));
    return request<{ items: SemanticVectorEntry[]; total: number; nextCursor: string | null }>(`/api/knowledge-map/vectors?${query}`, { signal });
  },

  disableLlm(revision: number, deleteResults: boolean) {
    return request<{ settings: LlmSettings; deletedResults: number }>("/api/settings/llm/disable", {
      method: "POST",
      body: JSON.stringify({ revision, deleteResults }),
    });
  },

  previewDerivedResult(documentId: string, type: DerivedResultType, revision: number, targetLanguage?: TranslationLanguage, customPrompt?: string) {
    return request<DerivedPreview>(`/api/documents/${encodeURIComponent(documentId)}/derived-preview`, {
      method: "POST",
      body: JSON.stringify({ type, revision, ...(targetLanguage ? { targetLanguage } : {}), ...(customPrompt ? { customPrompt } : {}) }),
    });
  },

  startDerivedTask(documentId: string, preview: DerivedPreview) {
    return request<DerivedTask>(`/api/documents/${encodeURIComponent(documentId)}/derived-task`, {
      method: "POST",
      headers: cloudLlmHeaders(preview.target.url),
      body: JSON.stringify({
        type: preview.type,
        ...(preview.customPrompt ? { customPrompt: preview.customPrompt } : {}),
        revision: preview.revision,
        inputHash: preview.inputHash,
        sendHash: preview.sendHash,
        settingsRevision: preview.settingsRevision,
        ...(preview.targetLanguage ? { targetLanguage: preview.targetLanguage } : {}),
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

  async getAppearance(cloud: boolean, signal?: AbortSignal): Promise<AppearanceSettings> {
    if (cloud) return { immersiveMode: globalThis.localStorage.getItem("zhiye:immersive-mode") === "true" };
    return request<AppearanceSettings>("/api/settings/appearance", { signal });
  },

  async saveAppearance(settings: AppearanceSettings, cloud: boolean): Promise<AppearanceSettings> {
    if (cloud) {
      globalThis.localStorage.setItem("zhiye:immersive-mode", String(settings.immersiveMode));
      return settings;
    }
    return request<AppearanceSettings>("/api/settings/appearance", { method: "PUT", body: JSON.stringify(settings) });
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

  getStartupStatus(signal?: AbortSignal) {
    return request<StartupStatus>("/api/startup-status", { signal });
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

  backupExportUrl(id: string) {
    return `/api/data-safety/backups/${encodeURIComponent(id)}/export.zhiye-backup`;
  },

  importBackup(file: File) {
    return request<BackupRecord>("/api/data-safety/backups/import", {
      method: "POST",
      headers: { "Content-Type": cloudRuntime ? "application/vnd.zhiye.cloud-backup+json" : "application/vnd.zhiye.backup+zip" },
      body: file,
    });
  },

  restoreBackup(id: string, allowQuarantine = false) {
    return request<RestoreBackupResult>(`/api/data-safety/backups/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      body: JSON.stringify({ allowQuarantine }),
    }, true);
  },

  deleteBackup(id: string) {
    return request<void>(`/api/data-safety/backups/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({}),
    });
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

  listFolders(signal?: AbortSignal) {
    return request<KnowledgeFolder[]>("/api/folders", { signal });
  },

  createFolder(name: string) {
    return request<KnowledgeFolder>("/api/folders", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },

  updateFolder(id: string, name: string) {
    return request<KnowledgeFolder>(`/api/folders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  },

  deleteFolder(id: string) {
    return request<DeleteFolderResponse>(`/api/folders/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({}),
    });
  },

  async listDocuments(filters: DocumentFilters, signal?: AbortSignal) {
    const response = await requestResponse(documentListUrl(filters), { signal });
    const epoch = response.headers.get(DATA_EPOCH_HEADER);
    const result = await response.json() as DocumentListResponse;
    if (epoch && epoch !== dataEpoch) throw new ApiRequestError("知识库已从备份恢复，请刷新后继续。", 409, "STALE_DATA_EPOCH");
    return result;
  },

  listLibrary(filters: DocumentFilters, signal?: AbortSignal) {
    const query = new URLSearchParams();
    if (filters.q?.trim()) query.set("q", filters.q.trim());
    if (filters.scope) query.set("scope", filters.scope);
    if (filters.caseSensitive !== undefined) query.set("caseSensitive", String(filters.caseSensitive));
    if (filters.kind) query.set("kind", filters.kind);
    if (filters.folderId) query.set("folderId", filters.folderId);
    if (filters.unfiled !== undefined) query.set("unfiled", String(filters.unfiled));
    if (filters.favorite !== undefined) query.set("favorite", String(filters.favorite));
    if (filters.archived !== undefined) query.set("archived", String(filters.archived));
    if (filters.sort) query.set("sort", filters.sort);
    if (filters.trash) query.set("trash", filters.trash);
    query.set("page", String(filters.page || 1));
    return request<DocumentListResponse>(`/api/library?${query}`, { signal });
  },

  async listKnowledgeMap(filters: { cursor?: string; q?: string; kind?: LibraryItemKind; folderId?: string; favorite?: boolean; includeArchived?: boolean }, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: "250" });
    if (filters.cursor) query.set("cursor", filters.cursor);
    if (filters.q?.trim()) query.set("q", filters.q.trim());
    if (filters.kind) query.set("kind", filters.kind);
    if (filters.folderId) query.set("folderId", filters.folderId);
    if (filters.favorite !== undefined) query.set("favorite", String(filters.favorite));
    if (filters.includeArchived) query.set("includeArchived", "true");
    return request<KnowledgeMapResponse>(`/api/knowledge-map?${query}`, { signal });
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

  createArticle(title = "未命名文章") {
    return request<CreateDocumentResponse>("/api/documents", {
      method: "POST",
      body: JSON.stringify({ title }),
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

  createPaperFromUrl(url: string, signal?: AbortSignal) {
    return request<{ created: boolean; paper?: PaperDocument; duplicate?: PaperDocument }>("/api/papers", {
      method: "POST",
      body: JSON.stringify({ url }),
      signal,
    });
  },

  uploadPaper(file: File, signal?: AbortSignal) {
    return request<{ created: boolean; paper?: PaperDocument; duplicate?: PaperDocument }>("/api/papers/upload", {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "X-Filename": file.name },
      body: file,
      signal,
    });
  },

  getPaper(id: string, signal?: AbortSignal) {
    return request<PaperDocument>(`/api/papers/${encodeURIComponent(id)}`, { signal });
  },

  getPaperPage(id: string, page: number, signal?: AbortSignal) {
    return request<PaperPage>(`/api/papers/${encodeURIComponent(id)}/pages/${page}`, { signal });
  },

  async startPaperExtraction(id: string, signal?: AbortSignal) {
    const headers = cloudRuntime ? cloudLlmHeaders((await api.getLlmSettings()).remote.endpointUrl) : {};
    return request<PaperExtractionTask>(`/api/papers/${encodeURIComponent(id)}/extractions`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
      signal,
    });
  },

  planPaperExtraction(id: string, signal?: AbortSignal) {
    return request<PaperExtractionPlan>(`/api/papers/${encodeURIComponent(id)}/extraction-plan`, { signal });
  },

  registerPaperPageCount(id: string, pageCount: number, signal?: AbortSignal) {
    return request<PaperPageRenderResult>(`/api/papers/${encodeURIComponent(id)}/page-renders`, {
      method: "POST",
      body: JSON.stringify({ pageCount }),
      signal,
    });
  },

  uploadPaperPageImage(id: string, page: number, image: Blob, signal?: AbortSignal) {
    return request<{ pageNumber: number; bytes: number }>(`/api/papers/${encodeURIComponent(id)}/pages/${page}/image`, {
      method: "PUT",
      headers: { "Content-Type": PAPER_PAGE_IMAGE_TYPE },
      body: image,
      signal,
    });
  },

  // One batch per call: the page-scoped key travels on this request, so the
  // batches have to be driven from here rather than by a server-side worker.
  async advancePaperTask(id: string, signal?: AbortSignal) {
    const headers = cloudRuntime ? cloudLlmHeaders((await api.getLlmSettings()).remote.endpointUrl) : {};
    return request<PaperExtractionTask>(`/api/paper-tasks/${encodeURIComponent(id)}/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
      signal,
    });
  },

  getPaperTask(id: string, signal?: AbortSignal) {
    return request<PaperExtractionTask>(`/api/paper-tasks/${encodeURIComponent(id)}`, { signal });
  },

  updatePaperPage(id: string, page: number, revision: number, translationBlocks: PaperPage["translationBlocks"]) {
    return request<PaperPage>(`/api/papers/${encodeURIComponent(id)}/pages/${page}`, {
      method: "PATCH",
      body: JSON.stringify({ revision, translationBlocks }),
    });
  },

  paperSourceUrl(id: string) {
    return `/api/papers/${encodeURIComponent(id)}/source.pdf`;
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

  /**
   * Cloud capture leaves the publisher's own title. This asks the configured
   * cloud AI to replace it, and returns null when cloud AI cannot be used.
   */
  async autoTitleDocument(id: string, revision: number) {
    if (!cloudRuntime) return null;
    const settings = await api.getLlmSettings();
    if (!settings.enabled) return null;
    const headers = cloudLlmHeaders(settings.remote.endpointUrl);
    if (!headers["X-Zhiye-LLM-Key"]) return null;
    return request<KnowledgeDocument>(`/api/documents/${encodeURIComponent(id)}/auto-title`, {
      method: "POST",
      headers,
      body: JSON.stringify({ revision }),
    });
  },

  retryDocument(id: string) {
    return request<KnowledgeDocument>(`/api/documents/${encodeURIComponent(id)}/retry`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  convertFailedDocumentToManual(id: string, revision: number) {
    return request<KnowledgeDocument>(`/api/documents/${encodeURIComponent(id)}/manual`, {
      method: "POST",
      body: JSON.stringify({ revision }),
    });
  },

  createBrowserExtensionPairingCode() {
    return request<BrowserExtensionPairingCode>("/api/settings/browser-extension/pairing-code", {
      method: "POST",
      body: "{}",
    });
  },

  getBrowserExtensionPairings(signal?: AbortSignal) {
    return request<{ pairings: BrowserExtensionPairing[] }>("/api/settings/browser-extension/pairings", { signal });
  },

  revokeBrowserExtensionPairing(id: string) {
    return request<void>(`/api/settings/browser-extension/pairings/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: "{}",
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
