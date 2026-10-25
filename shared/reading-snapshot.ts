import { parseSourceAnchor, readerRevision, readerText, ReaderInputError, type ReadingAnnotation, type DocumentConnection } from "./reader-tools.js";

export interface ReadingSnapshot { annotations: ReadingAnnotation[]; connections: DocumentConnection[] }
export function parseReadingSnapshot(value: unknown, documents: Set<string>): ReadingSnapshot {
  const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new ReaderInputError("Invalid reading snapshot");
    return value as Record<string, unknown>;
  };
  const root = exact(value, ["annotations", "connections"]);
  if (!Array.isArray(root.annotations) || !Array.isArray(root.connections) || root.annotations.length + root.connections.length > 100_000) throw new ReaderInputError("Reading snapshot exceeds its record limit");
  const ids = new Set<string>(), pairs = new Set<string>();
  const id = (value: unknown) => { const text = readerText(value, 200, true); if (ids.has(text)) throw new ReaderInputError("Duplicate reading record"); ids.add(text); return text; };
  const doc = (value: unknown) => { const text = readerText(value, 200, true); if (!documents.has(text)) throw new ReaderInputError("Missing reading document"); return text; };
  const date = (value: unknown) => { const text = readerText(value, 50, true); if (!Number.isFinite(Date.parse(text))) throw new ReaderInputError("Invalid reading timestamp"); return text; };
  return {
    annotations: root.annotations.map((value) => {
      const row = exact(value, ["id", "documentId", "sourceRevision", "anchor", "note", "translation", "revision", "createdAt", "updatedAt"]);
      const anchor = parseSourceAnchor(row.anchor), note = readerText(row.note, 4_000), translation = readerText(row.translation, 16_000);
      if (new TextEncoder().encode(JSON.stringify([anchor, note, translation])).length > 48 * 1024) throw new ReaderInputError("Annotation is too large");
      return { id: id(row.id), documentId: doc(row.documentId), sourceRevision: readerRevision(row.sourceRevision), anchor, note, translation, revision: readerRevision(row.revision), createdAt: date(row.createdAt), updatedAt: date(row.updatedAt) };
    }),
    connections: root.connections.map((value) => {
      const row = exact(value, ["id", "sourceId", "targetId", "note", "revision", "createdAt", "updatedAt"]);
      const sourceId = doc(row.sourceId), targetId = doc(row.targetId), pair = JSON.stringify([sourceId, targetId]);
      if (sourceId >= targetId || pairs.has(pair)) throw new ReaderInputError("Invalid reading connection");
      pairs.add(pair);
      return { id: id(row.id), sourceId, targetId, note: readerText(row.note, 2_000), revision: readerRevision(row.revision), createdAt: date(row.createdAt), updatedAt: date(row.updatedAt) };
    }),
  };
}
export const insertAnnotationSql = "INSERT INTO reading_annotations(id, document_id, source_revision, anchor_json, note, translation, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
export const annotationValues = (row: ReadingAnnotation) => [row.id, row.documentId, row.sourceRevision, JSON.stringify(row.anchor), row.note, row.translation, row.revision, row.createdAt, row.updatedAt];
export const insertConnectionSql = "INSERT INTO document_connections(id, source_id, target_id, note, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)";
export const connectionValues = (row: DocumentConnection) => [row.id, row.sourceId, row.targetId, row.note, row.revision, row.createdAt, row.updatedAt];
