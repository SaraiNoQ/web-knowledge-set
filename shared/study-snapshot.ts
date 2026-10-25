import { ReaderInputError, parseSourceAnchor, readerRevision, readerText } from "./reader-tools.js";
import { STUDY_TABLES } from "./study-store.js";
import { connectionEvidenceColumns, connectionEvidenceFromRow, type ConnectionEvidence } from "./related.js";
import type { ReadingSnapshot } from "./reading-snapshot.js";

type Row = Record<string, unknown>;
export type StudyTable = typeof STUDY_TABLES[number]["name"];
export interface StudySnapshot { version: 1; tables: Record<StudyTable, Row[]>; connectionEvidence: ConnectionEvidence[] }
export const STUDY_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const STUDY_SNAPSHOT_MAX_RECORDS = 20_000;
const maxRowBytes = 1_800_000;
const encoder = new TextEncoder();
export const studyRawBytesExpression = [...STUDY_TABLES, { name: "reading_connection_evidence", columns: ["connection_id", "source_annotation_id", "target_annotation_id", "relation_type", "revision", "updated_at"] }].map(({ name, columns }) => `(SELECT COALESCE(SUM(${columns.map((column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join("+")}),0) FROM ${name})`).join("+");
export const emptyStudySnapshot = (): StudySnapshot => ({ version: 1, tables: Object.fromEntries(STUDY_TABLES.map(({ name }) => [name, [] as Row[]])) as StudySnapshot["tables"], connectionEvidence: [] });
export const hasStudyData = (snapshot: StudySnapshot) => snapshot.connectionEvidence.length > 0 || STUDY_TABLES.some(({ name }) => snapshot.tables[name].length > 0);
function exact(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new ReaderInputError("研究快照字段无效。");
  return value as Row;
}
const id = (value: unknown) => readerText(value, 200, true);
const timestamp = (value: unknown) => { const text = readerText(value, 50, true); if (!Number.isFinite(Date.parse(text))) throw new ReaderInputError("研究快照日期无效。"); return text; };
const integer = (value: unknown, min: number, max: number) => { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new ReaderInputError("研究快照数值无效。"); return Number(value); };
function sourceUrl(value: unknown) { const text = readerText(value, 8192, true); try { const url = new URL(text); if (!["http:", "https:", "zhiye:"].includes(url.protocol) || url.username || url.password) throw new Error(); } catch { throw new ReaderInputError("研究快照来源无效。"); } return text; }
function savedDocument(value: unknown, expectedId: string) {
  let raw: unknown; try { raw = JSON.parse(readerText(value, maxRowBytes, true)); } catch { throw new ReaderInputError("合并历史原文无效。"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ReaderInputError("合并历史原文无效。");
  const row = raw as Row;
  const required = ["id", "title", "sourceUrl", "kind", "revision", "deletedAt", "folderId", "markdown", "tags"];
  if (required.some((key) => !(key in row)) || Object.keys(row).some((key) => ![...required, "sections", "markdownEdited"].includes(key)) || row.id !== expectedId || !["article", "paper"].includes(String(row.kind))) throw new ReaderInputError("合并历史归属无效。");
  readerText(row.title, 1000, true); sourceUrl(row.sourceUrl); readerRevision(row.revision); readerText(row.markdown, 1_500_000);
  if (row.deletedAt !== null) timestamp(row.deletedAt); if (row.folderId !== null) id(row.folderId);
  if (row.markdownEdited !== undefined && typeof row.markdownEdited !== "boolean") throw new ReaderInputError("合并历史编辑标记无效。");
  if (!Array.isArray(row.tags) || row.tags.length > 100) throw new ReaderInputError("合并历史标签无效。"); for (const tag of row.tags) readerText(tag, 100, true);
  if (row.sections !== undefined) {
    if (!Array.isArray(row.sections) || row.sections.length > 2000) throw new ReaderInputError("合并历史段落无效。");
    for (const section of row.sections) {
      if (!section || typeof section !== "object" || Array.isArray(section) || Object.keys(section).some((key) => !["text", "source", "pageNumber", "blockId"].includes(key))) throw new ReaderInputError("合并历史段落无效。");
      const item = section as Row; readerText(item.text, 1_500_000); if (!["preview", "editor", "paper-original", "paper-translation"].includes(String(item.source))) throw new ReaderInputError("合并历史段落无效。");
      if (item.pageNumber !== undefined) integer(item.pageNumber, 1, 500); if (item.blockId !== undefined) id(item.blockId);
    }
  }
  return row;
}

export function parseStudySnapshot(value: unknown, documents: Set<string>, reading: ReadingSnapshot): StudySnapshot {
  const root = exact(value, ["version", "tables", "connectionEvidence"]);
  if (root.version !== 1) throw new ReaderInputError("研究快照版本不受支持。");
  const tables = exact(root.tables, STUDY_TABLES.map(({ name }) => name));
  if (!Array.isArray(root.connectionEvidence)) throw new ReaderInputError("研究证据快照无效。");
  const size = encoder.encode(JSON.stringify(value)).byteLength;
  if (size > STUDY_SNAPSHOT_MAX_BYTES) throw new ReaderInputError("研究快照超过 4 MiB 上限。");
  let count = root.connectionEvidence.length;
  for (const spec of STUDY_TABLES) { if (!Array.isArray(tables[spec.name])) throw new ReaderInputError("研究快照表无效。"); count += (tables[spec.name] as unknown[]).length; }
  if (count > STUDY_SNAPSHOT_MAX_RECORDS) throw new ReaderInputError("研究快照记录过多。");
  const result = emptyStudySnapshot(), topics = new Set<string>(), memberships = new Set<string>();
  const annotations = new Map(reading.annotations.map((row) => [row.id, row])), connections = new Map(reading.connections.map((row) => [row.id, row]));
  const document = (value: unknown) => { const key = id(value); if (!documents.has(key)) throw new ReaderInputError("研究快照引用了缺失资料。"); return key; };
  const annotation = (value: unknown) => { const key = id(value); if (!annotations.has(key)) throw new ReaderInputError("研究快照引用了缺失摘录。"); return key; };
  for (const spec of STUDY_TABLES) {
    const seen = new Set<string>();
    for (const value of tables[spec.name] as unknown[]) {
      const row = exact(value, spec.columns);
      if (encoder.encode(JSON.stringify(row)).byteLength > maxRowBytes) throw new ReaderInputError("单条研究快照过大。");
      let key: string;
      switch (spec.name) {
        case "study_topics":
          key = id(row.id); readerText(row.name, 100, true); readerText(row.note, 40000); readerRevision(row.revision); timestamp(row.created_at); timestamp(row.updated_at); topics.add(key); break;
        case "study_topic_documents": {
          const topic = id(row.topic_id), doc = document(row.document_id); if (!topics.has(topic)) throw new ReaderInputError("专题成员引用无效。"); key = JSON.stringify([topic, doc]); memberships.add(key); break;
        }
        case "study_topic_annotations": {
          const topic = id(row.topic_id), aid = annotation(row.annotation_id); if (!topics.has(topic) || !memberships.has(JSON.stringify([topic, annotations.get(aid)!.documentId]))) throw new ReaderInputError("专题摘录归属无效。"); key = JSON.stringify([topic, aid]); break;
        }
        case "study_progress":
          key = document(row.document_id); readerRevision(row.document_revision); readerRevision(row.revision); if (typeof row.fraction !== "number" || !Number.isFinite(row.fraction) || row.fraction < 0 || row.fraction > 1) throw new ReaderInputError("阅读位置无效。"); if (row.anchor_json !== null) parseSourceAnchor(JSON.parse(readerText(row.anchor_json, 24000, true))); integer(row.is_read, 0, 1); timestamp(row.updated_at); break;
        case "study_reviews":
          key = annotation(row.annotation_id); timestamp(row.due_at); integer(row.interval_days, 0, 365); integer(row.repetitions, 0, Number.MAX_SAFE_INTEGER); readerRevision(row.revision); break;
        case "study_document_tags": {
          const doc = document(row.document_id), tag = readerText(row.tag, 60, true); if (tag !== tag.normalize("NFKC").trim()) throw new ReaderInputError("研究标签格式无效。"); key = JSON.stringify([doc, tag]); break;
        }
        case "study_source_checks":
          key = document(row.document_id); readerRevision(row.source_revision); sourceUrl(row.url); if (!["ok", "unavailable", "restricted", "unknown"].includes(String(row.state))) throw new ReaderInputError("来源检查状态无效。"); if (row.status !== null) integer(row.status, 100, 599); timestamp(row.checked_at); readerText(row.message, 2000); break;
        case "study_merge_history": {
          key = id(row.id); const keep = document(row.keep_id), source = document(row.source_id); if (keep === source) throw new ReaderInputError("合并历史资料不能相同。"); const beforeKeep = savedDocument(row.before_keep_json, keep), beforeSource = savedDocument(row.before_source_json, source);
          if (beforeKeep.kind !== beforeSource.kind || Number(beforeKeep.revision) + 1 !== readerRevision(row.after_keep_revision) || Number(beforeSource.revision) + 1 !== readerRevision(row.after_source_revision)) throw new ReaderInputError("合并历史版本无效。"); integer(row.undone, 0, 1); timestamp(row.created_at); break;
        }
      }
      if (seen.has(key!)) throw new ReaderInputError("研究快照记录重复。"); seen.add(key!); result.tables[spec.name].push(row);
    }
  }
  for (const topic of topics) {
    if (result.tables.study_topic_documents.filter((row) => row.topic_id === topic).length > 100 || result.tables.study_topic_annotations.filter((row) => row.topic_id === topic).length > 200) throw new ReaderInputError("研究快照专题超过成员上限。");
  }
  const evidenceIds = new Set<string>();
  result.connectionEvidence = root.connectionEvidence.map((value) => {
    const row = exact(value, ["connectionId", "sourceAnnotationId", "targetAnnotationId", "relationType", "revision", "updatedAt"]), key = id(row.connectionId), connection = connections.get(key);
    if (!connection || evidenceIds.has(key)) throw new ReaderInputError("关系证据引用无效。"); evidenceIds.add(key);
    const source = row.sourceAnnotationId === null ? null : annotation(row.sourceAnnotationId), target = row.targetAnnotationId === null ? null : annotation(row.targetAnnotationId);
    if ((source && annotations.get(source)!.documentId !== connection.sourceId) || (target && annotations.get(target)!.documentId !== connection.targetId) || !["manual", "citation"].includes(String(row.relationType))) throw new ReaderInputError("关系证据摘录归属无效。");
    return { connectionId: key, sourceAnnotationId: source, targetAnnotationId: target, relationType: row.relationType as "manual" | "citation", revision: readerRevision(row.revision), updatedAt: timestamp(row.updatedAt) };
  });
  return result;
}

export async function captureStudySnapshot(all: (sql: string, values: unknown[]) => Promise<Row[]>, scope?: { documents: Set<string>; portable: boolean; includeEmptyTopics: boolean }): Promise<StudySnapshot> {
  const snapshot = emptyStudySnapshot();
  if (scope) {
    let bytes = 1024, records = 0;
    const load = async (columns: readonly string[], query: string, values: unknown[]) => {
      const fields = columns.flatMap((column) => [`'${column}'`, `q.${column}`]).join(",");
      const stats = (await all(`SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(json_object(${fields}) AS BLOB))),0) AS bytes FROM (${query}) q`, values))[0];
      records += Number(stats?.n ?? 0); bytes += Number(stats?.bytes ?? 0) + Number(stats?.n ?? 0);
      if (records > STUDY_SNAPSHOT_MAX_RECORDS || bytes > STUDY_SNAPSHOT_MAX_BYTES) throw new ReaderInputError("研究快照超过导出预算。");
      return all(query, values);
    };
    const selected = JSON.stringify([...scope.documents]);
    const inScope = "SELECT value FROM json_each(?)";
    const included = `EXISTS(SELECT 1 FROM study_topic_documents m WHERE m.topic_id=t.id AND m.document_id IN (${inScope})) OR EXISTS(SELECT 1 FROM study_topic_annotations m JOIN reading_annotations a ON a.id=m.annotation_id WHERE m.topic_id=t.id AND a.document_id IN (${inScope}))${scope.includeEmptyTopics ? " OR (NOT EXISTS(SELECT 1 FROM study_topic_documents m WHERE m.topic_id=t.id) AND NOT EXISTS(SELECT 1 FROM study_topic_annotations m WHERE m.topic_id=t.id))" : ""}`;
    const complete = `NOT EXISTS(SELECT 1 FROM study_topic_documents m WHERE m.topic_id=t.id AND m.document_id NOT IN (${inScope})) AND NOT EXISTS(SELECT 1 FROM study_topic_annotations m JOIN reading_annotations a ON a.id=m.annotation_id WHERE m.topic_id=t.id AND a.document_id NOT IN (${inScope}))`;
    snapshot.tables.study_topics = await load(STUDY_TABLES[0].columns, `SELECT t.id,t.name,CASE WHEN ${complete} THEN t.note ELSE '' END AS note,t.revision,t.created_at,t.updated_at FROM study_topics t WHERE ${included} LIMIT ?`, [selected, selected, selected, selected, STUDY_SNAPSHOT_MAX_RECORDS + 1]);
    const topics = JSON.stringify(snapshot.tables.study_topics.map((row) => row.id));
    snapshot.tables.study_topic_documents = await load(STUDY_TABLES[1].columns, `SELECT topic_id,document_id FROM study_topic_documents WHERE topic_id IN (${inScope}) AND document_id IN (${inScope}) LIMIT ?`, [topics, selected, STUDY_SNAPSHOT_MAX_RECORDS + 1]);
    snapshot.tables.study_topic_annotations = await load(STUDY_TABLES[2].columns, `SELECT m.topic_id,m.annotation_id FROM study_topic_annotations m JOIN reading_annotations a ON a.id=m.annotation_id WHERE m.topic_id IN (${inScope}) AND a.document_id IN (${inScope}) LIMIT ?`, [topics, selected, STUDY_SNAPSHOT_MAX_RECORDS + 1]);
    for (const name of ["study_progress", "study_document_tags", "study_source_checks"] as const) {
      if (scope.portable && name === "study_source_checks") continue;
      const spec = STUDY_TABLES.find((item) => item.name === name)!;
      snapshot.tables[name] = await load(spec.columns, `SELECT ${spec.columns.join(",")} FROM ${name} WHERE document_id IN (${inScope}) LIMIT ?`, [selected, STUDY_SNAPSHOT_MAX_RECORDS + 1]);
    }
    snapshot.tables.study_reviews = await load(STUDY_TABLES[4].columns, `SELECT r.annotation_id,r.due_at,r.interval_days,r.repetitions,r.revision FROM study_reviews r JOIN reading_annotations a ON a.id=r.annotation_id WHERE a.document_id IN (${inScope}) LIMIT ?`, [selected, STUDY_SNAPSHOT_MAX_RECORDS + 1]);
    if (!scope.portable) {
      const spec = STUDY_TABLES.find((item) => item.name === "study_merge_history")!;
      snapshot.tables.study_merge_history = await load(spec.columns, `SELECT ${spec.columns.join(",")} FROM study_merge_history WHERE keep_id IN (${inScope}) AND source_id IN (${inScope}) LIMIT ?`, [selected, selected, STUDY_SNAPSHOT_MAX_RECORDS + 1]);
    }
    snapshot.connectionEvidence = (await load(["connectionId", "sourceAnnotationId", "targetAnnotationId", "relationType", "revision", "updatedAt"], `SELECT e.connection_id AS connectionId,e.source_annotation_id AS sourceAnnotationId,e.target_annotation_id AS targetAnnotationId,e.relation_type AS relationType,e.revision,e.updated_at AS updatedAt FROM reading_connection_evidence e JOIN document_connections c ON c.id=e.connection_id WHERE c.source_id IN (${inScope}) AND c.target_id IN (${inScope}) LIMIT ?`, [selected, selected, STUDY_SNAPSHOT_MAX_RECORDS + 1])).map(connectionEvidenceFromRow);
    return snapshot;
  }
  const count = (await all(`SELECT ${[...STUDY_TABLES.map(({ name }) => name), "reading_connection_evidence"].map((name) => `(SELECT COUNT(*) FROM ${name})`).join("+")} AS total,${studyRawBytesExpression} AS bytes`, []))[0];
  if (Number(count?.total ?? 0) > STUDY_SNAPSHOT_MAX_RECORDS || Number(count?.bytes ?? 0) > STUDY_SNAPSHOT_MAX_BYTES) throw new ReaderInputError("研究快照超过备份预算。");
  for (const spec of STUDY_TABLES) {
    const rows = await all(`SELECT ${spec.columns.join(",")} FROM ${spec.name} LIMIT ?`, [STUDY_SNAPSHOT_MAX_RECORDS + 1]); snapshot.tables[spec.name] = rows;
    if (rows.length > STUDY_SNAPSHOT_MAX_RECORDS) throw new ReaderInputError("研究快照记录过多。");
  }
  snapshot.connectionEvidence = (await all(`SELECT ${connectionEvidenceColumns} FROM reading_connection_evidence LIMIT ?`, [STUDY_SNAPSHOT_MAX_RECORDS + 1])).map(connectionEvidenceFromRow);
  return snapshot;
}

export function studyRestoreStatements(snapshot: StudySnapshot): Array<{ sql: string; values: unknown[] }> {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const add = (name: string, columns: readonly string[], rows: Row[]) => {
    let chunk: Row[] = [], bytes = 2;
    const flush = () => { if (chunk.length) statements.push({ sql: `INSERT INTO ${name}(${columns.join(",")}) SELECT ${columns.map((column) => `json_extract(value,'$.${column}')`).join(",")} FROM json_each(?)`, values: [JSON.stringify(chunk)] }); chunk = []; bytes = 2; };
    for (const row of rows) { const size = encoder.encode(JSON.stringify(row)).byteLength + 1; if (bytes + size > 256 * 1024) flush(); chunk.push(row); bytes += size; } flush();
  };
  for (const spec of STUDY_TABLES) add(spec.name, spec.columns, snapshot.tables[spec.name]);
  add("reading_connection_evidence", ["connection_id", "source_annotation_id", "target_annotation_id", "relation_type", "revision", "updated_at"], snapshot.connectionEvidence.map((row) => ({ connection_id: row.connectionId, source_annotation_id: row.sourceAnnotationId, target_annotation_id: row.targetAnnotationId, relation_type: row.relationType, revision: row.revision, updated_at: row.updatedAt })));
  return statements;
}
