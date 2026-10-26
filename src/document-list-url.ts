import type { DocumentFilters } from "../shared/types";

export function documentListUrl(filters: DocumentFilters) {
  const query = new URLSearchParams();
  if (filters.q?.trim()) query.set("q", filters.q.trim());
  if (filters.scope) query.set("scope", filters.scope);
  if (filters.caseSensitive !== undefined) query.set("caseSensitive", String(filters.caseSensitive));
  if (filters.kind) query.set("kind", filters.kind);
  if (filters.tag) query.set("tag", filters.tag);
  if (filters.collectionId) query.set("collectionId", filters.collectionId);
  if (filters.folderId) query.set("folderId", filters.folderId);
  if (filters.unfiled !== undefined) query.set("unfiled", String(filters.unfiled));
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
  return `/api/documents?${query}`;
}
