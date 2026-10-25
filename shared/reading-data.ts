import { parseSourceAnchor, readerRevision, readerText, ReaderInputError, type ReadingAnnotation, type DocumentConnection } from "./reader-tools.js";

export const READING_DATA_SCHEMA = `
CREATE TABLE reading_annotations (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 source_revision INTEGER NOT NULL, anchor_json TEXT NOT NULL CHECK(json_valid(anchor_json)),
 note TEXT NOT NULL, translation TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX reading_annotations_document ON reading_annotations(document_id, created_at);
CREATE TABLE document_connections (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 target_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, note TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK(source_id < target_id), UNIQUE(source_id, target_id)
);
CREATE INDEX document_connections_target ON document_connections(target_id);
`;
export const annotationColumns = "id, document_id AS documentId, source_revision AS sourceRevision, anchor_json AS anchorJson, note, translation, revision, created_at AS createdAt, updated_at AS updatedAt";
export const connectionColumns = "id, source_id AS sourceId, target_id AS targetId, note, revision, created_at AS createdAt, updated_at AS updatedAt";
type Row = Record<string, unknown>;
export function annotationFromRow(row: Row): ReadingAnnotation {
  return { id: String(row.id), documentId: String(row.documentId), sourceRevision: Number(row.sourceRevision), anchor: parseSourceAnchor(JSON.parse(String(row.anchorJson))),
    note: String(row.note), translation: String(row.translation), revision: Number(row.revision), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) };
}
export function connectionFromRow(row: Row): DocumentConnection {
  return { id: String(row.id), sourceId: String(row.sourceId), targetId: String(row.targetId), note: String(row.note),
    revision: Number(row.revision), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) };
}
export interface ReadingAdapter {
  all(sql: string, values: unknown[]): Promise<Row[]>;
  run(sql: string, values: unknown[]): Promise<number>;
  document(id: string): Promise<{ id: string; revision: number; deletedAt: string | null } | null>;
  documentsTable: "documents" | "cloud_documents";
}
export class ReadingDataError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
function body(value: unknown, allowed: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new ReaderInputError("Invalid reading data");
  return value as Record<string, unknown>;
}
export function createReadingRepository(db: ReadingAdapter) {
  const docs = db.documentsTable;
  const document = async (id: string, revision?: unknown) => {
    const result = await db.document(id);
    if (!result || result.deletedAt) throw new ReadingDataError(404, "DOCUMENT_NOT_FOUND");
    if (revision !== undefined && result.revision !== readerRevision(revision)) throw new ReadingDataError(409, "REVISION_CONFLICT");
    return result;
  };
  const annotation = async (id: string, documentId: string) => {
    const rows = await db.all(`SELECT ${annotationColumns} FROM reading_annotations WHERE id = ? AND document_id = ?`, [id, documentId]);
    if (!rows[0]) throw new ReadingDataError(404, "ANNOTATION_NOT_FOUND");
    return annotationFromRow(rows[0]);
  };
  return {
    async list(documentId: string, page = 1, includeAnnotations = true) {
      if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new ReaderInputError("Invalid reading data page");
      await document(documentId);
      const [notes, links, totals] = await Promise.all([
        includeAnnotations ? db.all(`SELECT ${annotationColumns} FROM reading_annotations WHERE document_id = ? ORDER BY created_at DESC, id LIMIT 20 OFFSET ?`, [documentId, (page - 1) * 20]) : Promise.resolve([]),
        db.all(`SELECT c.id, c.source_id AS sourceId, c.target_id AS targetId, c.note, c.revision, c.created_at AS createdAt, c.updated_at AS updatedAt,
          p.id AS peerId, p.title AS peerTitle, p.kind AS peerKind FROM document_connections c JOIN ${docs} p ON p.id = CASE WHEN c.source_id = ? THEN c.target_id ELSE c.source_id END
          WHERE (c.source_id = ? OR c.target_id = ?) AND p.deleted_at IS NULL ORDER BY c.created_at DESC, c.id LIMIT 20 OFFSET ?`, [documentId, documentId, documentId, (page - 1) * 20]),
        db.all(`SELECT (SELECT COUNT(*) FROM reading_annotations WHERE document_id = ?) AS annotations,
          (SELECT COUNT(*) FROM document_connections c JOIN ${docs} p ON p.id = CASE WHEN c.source_id = ? THEN c.target_id ELSE c.source_id END WHERE (c.source_id = ? OR c.target_id = ?) AND p.deleted_at IS NULL) AS connections`, [documentId, documentId, documentId, documentId]),
      ]);
      return { page, totalAnnotations: Number(totals[0]?.annotations ?? 0), totalConnections: Number(totals[0]?.connections ?? 0), annotations: notes.map(annotationFromRow), connections: links.map((row) => ({ ...connectionFromRow(row), peer: { id: String(row.peerId), title: String(row.peerTitle), kind: String(row.peerKind) } })) };
    },
    async createAnnotation(documentId: string, value: unknown) {
      const input = body(value, ["revision", "anchor", "note", "translation"]);
      const doc = await document(documentId, readerRevision(input.revision));
      const anchor = parseSourceAnchor(input.anchor), note = readerText(input.note ?? "", 4_000), translation = readerText(input.translation ?? "", 16_000);
      if (new TextEncoder().encode(JSON.stringify([anchor, note, translation])).length > 48 * 1024) throw new ReaderInputError("Annotation is too large");
      const id = crypto.randomUUID(), timestamp = new Date().toISOString();
      const changed = await db.run(`INSERT INTO reading_annotations(id, document_id, source_revision, anchor_json, note, translation, revision, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM ${docs} WHERE id = ? AND revision = ? AND deleted_at IS NULL)`,
      [id, documentId, doc.revision, JSON.stringify(anchor), note, translation, timestamp, timestamp, documentId, doc.revision]);
      if (!changed) throw new ReadingDataError(409, "REVISION_CONFLICT");
      return annotation(id, documentId);
    },
    async updateAnnotation(documentId: string, id: string, value: unknown) {
      const input = body(value, ["revision", "note"]);
      await document(documentId);
      const changed = await db.run(`UPDATE reading_annotations SET note = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND document_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM ${docs} WHERE id = ? AND deleted_at IS NULL)`,
        [readerText(input.note, 4_000), new Date().toISOString(), id, documentId, readerRevision(input.revision), documentId]);
      if (!changed) throw new ReadingDataError(409, "ANNOTATION_CONFLICT");
      return annotation(id, documentId);
    },
    async deleteAnnotation(documentId: string, id: string, value: unknown) {
      await document(documentId);
      const input = body(value, ["revision"]);
      if (!await db.run(`DELETE FROM reading_annotations WHERE id = ? AND document_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM ${docs} WHERE id = ? AND deleted_at IS NULL)`, [id, documentId, readerRevision(input.revision), documentId])) throw new ReadingDataError(409, "ANNOTATION_CONFLICT");
      return { deleted: true };
    },
    async connect(documentId: string, value: unknown) {
      const input = body(value, ["revision", "targetId", "note"]);
      const source = await document(documentId, readerRevision(input.revision));
      const targetId = readerText(input.targetId, 200, true);
      if (targetId === documentId) throw new ReaderInputError("Cannot connect a document to itself");
      await document(targetId);
      const [first, second] = [documentId, targetId].sort();
      const timestamp = new Date().toISOString();
      const changed = await db.run(`INSERT INTO document_connections(id, source_id, target_id, note, revision, created_at, updated_at)
        SELECT ?, ?, ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM ${docs} WHERE id = ? AND revision = ? AND deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM ${docs} WHERE id = ? AND deleted_at IS NULL) ON CONFLICT(source_id, target_id) DO NOTHING`,
        [crypto.randomUUID(), first, second, readerText(input.note ?? "", 2_000), timestamp, timestamp, documentId, source.revision, targetId]);
      const rows = await db.all(`SELECT ${connectionColumns} FROM document_connections WHERE source_id = ? AND target_id = ?`, [first, second]);
      if (!rows[0]) throw new ReadingDataError(409, "REVISION_CONFLICT");
      return { connection: connectionFromRow(rows[0]), created: changed === 1 };
    },
    async disconnect(documentId: string, id: string, value: unknown) {
      await document(documentId);
      const input = body(value, ["revision"]);
      if (!await db.run(`DELETE FROM document_connections WHERE id = ? AND (source_id = ? OR target_id = ?) AND revision = ? AND EXISTS (SELECT 1 FROM ${docs} WHERE id = ? AND deleted_at IS NULL)`, [id, documentId, documentId, readerRevision(input.revision), documentId])) throw new ReadingDataError(409, "CONNECTION_CONFLICT");
      return { deleted: true };
    },
  };
}
