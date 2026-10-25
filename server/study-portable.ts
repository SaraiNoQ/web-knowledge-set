import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ReaderInputError } from "../shared/reader-tools.js";
import { STUDY_TABLES } from "../shared/study-store.js";
import { STUDY_SNAPSHOT_MAX_BYTES, type StudySnapshot } from "../shared/study-snapshot.js";
import type { ReadingSnapshot } from "../shared/reading-snapshot.js";

export const PORTABLE_STUDY_FILE = ".study.json";
export const studyRecordCount = (data: StudySnapshot) => data.connectionEvidence.length + STUDY_TABLES.reduce((sum, { name }) => sum + data.tables[name].length, 0);
export function readPortableStudyData(staging: string | null): unknown | null {
  if (!staging) return null;
  const path = join(staging, PORTABLE_STUDY_FILE); if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > STUDY_SNAPSHOT_MAX_BYTES) throw new ReaderInputError("研究暂存文件无效。");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path))); }
  catch { throw new ReaderInputError("研究暂存文件无效。"); }
}
const stableId = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
function localTag(sql: DatabaseSync, documentId: string, tag: string) {
  sql.prepare("INSERT INTO tags(name) VALUES(?) ON CONFLICT(name) DO NOTHING").run(tag);
  sql.prepare("INSERT OR IGNORE INTO document_tags(document_id,tag_id) SELECT ?,id FROM tags WHERE name=? COLLATE NOCASE").run(documentId, tag);
}
export function restoreLocalStudyTags(sql: DatabaseSync) {
  for (const row of sql.prepare("SELECT document_id,tag FROM study_document_tags").all()) localTag(sql, String(row.document_id), String(row.tag));
  sql.exec("DELETE FROM study_document_tags");
}

export function applyPortableStudyData(sql: DatabaseSync, data: StudySnapshot, reading: ReadingSnapshot, maps: { documents: Map<string, string>; annotations: Map<string, string>; connections: Map<string, string>; strategy: string; batchId: string }) {
  const document = (value: unknown) => {
    const id = maps.documents.get(String(value));
    const row = id ? sql.prepare("SELECT id,revision,deleted_at FROM documents WHERE id=?").get(id) : null;
    if (!row || row.deleted_at) throw new ReaderInputError("研究资料导入失败或已进入回收站，请选择更新或复制后重试。");
    return { id: String(row.id), revision: Number(row.revision) };
  };
  const annotation = (value: unknown) => { const id = maps.annotations.get(String(value)); if (!id || !sql.prepare("SELECT 1 FROM reading_annotations WHERE id=?").get(id)) throw new ReaderInputError("研究摘录未能完整导入，请选择更新或复制后重试。"); return id; };
  const topics = new Map<string, string>(), existingTopics = new Set<string>(), changedTopics = new Set<string>();
  for (const row of data.tables.study_topics) {
    const members = data.tables.study_topic_documents.filter((member) => member.topic_id === row.id).map((member) => [String(member.document_id), document(member.document_id).id] as const);
    const sameDocuments = members.every(([old, current]) => old === current);
    const existing = sql.prepare("SELECT id FROM study_topics WHERE id=?").get(String(row.id));
    const id = !members.length && maps.strategy === "copy" && existing ? stableId("study-topic-copy", row.id, maps.batchId) : sameDocuments ? String(row.id) : stableId("study-topic", row.id, members.slice().sort((a, b) => a[0].localeCompare(b[0])));
    topics.set(String(row.id), id); if (sql.prepare("SELECT 1 FROM study_topics WHERE id=?").get(id)) existingTopics.add(id);
    sql.prepare("INSERT OR IGNORE INTO study_topics(id,name,note,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, String(row.name), String(row.note), Number(row.revision), String(row.created_at), String(row.updated_at));
  }
  const topic = (value: unknown) => { const id = topics.get(String(value)); if (!id) throw new ReaderInputError("专题导入引用无效。"); return id; };
  for (const row of data.tables.study_topic_documents) {
    const id = topic(row.topic_id), result = sql.prepare("INSERT OR IGNORE INTO study_topic_documents VALUES(?,?)").run(id, document(row.document_id).id);
    if (result.changes) changedTopics.add(id);
  }
  for (const row of data.tables.study_topic_annotations) {
    const id = topic(row.topic_id), result = sql.prepare("INSERT OR IGNORE INTO study_topic_annotations VALUES(?,?)").run(id, annotation(row.annotation_id));
    if (result.changes) changedTopics.add(id);
  }
  for (const id of topics.values()) {
    const counts = sql.prepare("SELECT (SELECT COUNT(*) FROM study_topic_documents WHERE topic_id=?) AS documents,(SELECT COUNT(*) FROM study_topic_annotations WHERE topic_id=?) AS annotations").get(id, id)!;
    if (Number(counts.documents) > 100 || Number(counts.annotations) > 200) throw new ReaderInputError("合并导入后的专题超过成员上限，请复制为新专题。");
    if (existingTopics.has(id) && changedTopics.has(id)) sql.prepare("UPDATE study_topics SET revision=revision+1,updated_at=? WHERE id=?").run(new Date().toISOString(), id);
  }
  for (const row of data.tables.study_progress) { const doc = document(row.document_id); sql.prepare("INSERT OR IGNORE INTO study_progress VALUES(?,?,?,?,?,?,?)").run(doc.id, doc.revision, Number(row.revision), Number(row.fraction), row.anchor_json == null ? null : String(row.anchor_json), Number(row.is_read), String(row.updated_at)); }
  for (const row of data.tables.study_reviews) sql.prepare("INSERT OR IGNORE INTO study_reviews VALUES(?,?,?,?,?)").run(annotation(row.annotation_id), String(row.due_at), Number(row.interval_days), Number(row.repetitions), Number(row.revision));
  for (const row of data.tables.study_document_tags) localTag(sql, document(row.document_id).id, String(row.tag));
  for (const row of data.connectionEvidence) {
    const connectionId = maps.connections.get(row.connectionId), original = reading.connections.find((connection) => connection.id === row.connectionId);
    const connection = connectionId ? sql.prepare("SELECT source_id,target_id FROM document_connections WHERE id=?").get(connectionId) : null;
    if (!connection || !original) throw new ReaderInputError("研究关系未能完整导入，请选择更新或复制后重试。");
    const source = row.sourceAnnotationId == null ? null : annotation(row.sourceAnnotationId), target = row.targetAnnotationId == null ? null : annotation(row.targetAnnotationId);
    const flipped = String(connection.source_id) !== document(original.sourceId).id;
    sql.prepare("INSERT OR IGNORE INTO reading_connection_evidence VALUES(?,?,?,?,?,?)").run(connectionId!, flipped ? target : source, flipped ? source : target, row.relationType, row.revision, row.updatedAt);
  }
}
