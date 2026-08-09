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

export interface ApiError {
  error: {
    code: string;
    message: string;
    document?: KnowledgeDocument;
  };
}
