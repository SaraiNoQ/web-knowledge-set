import type {
  ApiError,
  CaptureStatus,
  DocumentListResponse,
  KnowledgeDocument,
} from "../shared/types";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "REQUEST_FAILED",
    readonly document?: KnowledgeDocument,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

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
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface DocumentFilters {
  q?: string;
  tag?: string;
  status?: CaptureStatus | "";
  page?: number;
}

export interface DocumentPatch {
  title?: string;
  markdown?: string;
  tags?: string[];
  revision: number;
}

export const api = {
  listDocuments(filters: DocumentFilters, signal?: AbortSignal) {
    const query = new URLSearchParams();
    if (filters.q?.trim()) query.set("q", filters.q.trim());
    if (filters.tag) query.set("tag", filters.tag);
    if (filters.status) query.set("status", filters.status);
    query.set("page", String(filters.page || 1));
    return request<DocumentListResponse>(`/api/documents?${query}`, { signal });
  },

  createDocument(url: string) {
    return request<KnowledgeDocument>("/api/documents", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  },

  getDocument(id: string, signal?: AbortSignal) {
    return request<KnowledgeDocument>(`/api/documents/${encodeURIComponent(id)}`, { signal });
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

  exportUrl(id: string) {
    return `/api/documents/${encodeURIComponent(id)}/export.md`;
  },
};
