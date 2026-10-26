import { semanticHash, extractSemanticMarkdown, SEMANTIC_FORMAT_VERSION } from "./semantic.js";
import { readerRevision, readerText, ReaderInputError, type SourceAnchor } from "./reader-tools.js";
import { ReadingDataError, annotationColumns, annotationFromRow } from "./reading-data.js";
import type { QuestionCitation, StudyAdapter, StudyDocument } from "./study-types.js";
import { backfillAnn, searchAnn, type AnnDiagnostics } from "./semantic-ann.js";

export type RelationType = "semantic" | "manual" | "folder" | "tag" | "citation" | "lexical";
export interface RelationReason { type: RelationType; label: string; score?: number; annotationIds?: string[]; connectionId?: string }
export interface RelatedEvidence extends QuestionCitation { basis: "term-overlap" | "context" }
export interface RelatedItem { document: StudyDocument; reasons: RelationReason[]; evidence: RelatedEvidence[]; score: number }
export interface RelatedResult { sourceId: string; sourceRevision: number; items: RelatedItem[]; scannedDocuments: number; truncated: boolean; nextCursor: string | null; search?: AnnDiagnostics }
export interface RelatedOptions { limit?: number; cursor?: string; types?: RelationType[] }

export const CONNECTION_EVIDENCE_SCHEMA = `CREATE TABLE reading_connection_evidence (
 connection_id TEXT PRIMARY KEY REFERENCES document_connections(id) ON DELETE CASCADE,
 source_annotation_id TEXT REFERENCES reading_annotations(id) ON DELETE SET NULL,
 target_annotation_id TEXT REFERENCES reading_annotations(id) ON DELETE SET NULL,
 relation_type TEXT NOT NULL CHECK(relation_type IN ('manual','citation')),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);`;
export const connectionEvidenceColumns = "connection_id AS connectionId, source_annotation_id AS sourceAnnotationId, target_annotation_id AS targetAnnotationId, relation_type AS relationType, revision, updated_at AS updatedAt";
export interface ConnectionEvidence { connectionId: string; sourceAnnotationId: string | null; targetAnnotationId: string | null; relationType: "manual" | "citation"; revision: number; updatedAt: string }
export const connectionEvidenceFromRow = (row: Record<string, unknown>): ConnectionEvidence => ({ connectionId: String(row.connectionId), sourceAnnotationId: row.sourceAnnotationId == null ? null : String(row.sourceAnnotationId), targetAnnotationId: row.targetAnnotationId == null ? null : String(row.targetAnnotationId), relationType: row.relationType === "citation" ? "citation" : "manual", revision: Number(row.revision), updatedAt: String(row.updatedAt) });

const stopWords = new Set(["the", "and", "this", "that", "with", "from", "what", "which", "where", "when", "does", "have", "into", "about", "could", "would", "should", "their", "there", "these", "those", "were", "your", "they", "how", "why", "are", "for", "article", "paper", "document", "documents", "notes", "什么", "么是", "如何", "为什", "为什么", "请问", "哪些", "以及", "这个", "关于", "内容", "资料", "可以", "怎样", "是否", "多少", "我们"]);
export function evidenceTerms(text: string) {
  const value = text.normalize("NFKC").toLocaleLowerCase();
  const result = new Set((value.match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 2 && !stopWords.has(word)));
  for (const match of value.matchAll(/[\u3400-\u9fff]{2,}/gu)) { const chars = Array.from(match[0]); for (let index = 0; index < chars.length - 1; index++) { const term = chars[index]! + chars[index + 1]!; if (!stopWords.has(term)) result.add(term); } }
  return [...result].slice(0, 80);
}
const sections = (doc: StudyDocument): Array<{ text: string; source: SourceAnchor["source"]; pageNumber?: number; blockId?: string }> => doc.kind === "article" ? [{ text: doc.markdown, source: "editor" }] : (doc.sections ?? []).filter((section) => section.source === "paper-original");
export async function documentSemanticHash(doc: StudyDocument) {
  const texts = doc.kind === "article" ? [{ pageNumber: null, text: extractSemanticMarkdown(doc.markdown) }].filter(({ text }) => text.trim()) : [...new Set(sections(doc).map((section) => section.pageNumber ?? null))].map((pageNumber) => ({ pageNumber, text: sections(doc).filter((section) => (section.pageNumber ?? null) === pageNumber).map((section) => section.text).filter(Boolean).join("\n") })).filter(({ text }) => text.trim());
  return semanticHash(JSON.stringify([doc.title, texts.map((section) => [section.pageNumber, section.text])]));
}
function overlap(text: string, terms: string[]) { const lower = text.normalize("NFKC").toLocaleLowerCase(); return terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0); }
function passages(doc: StudyDocument, query: string) {
  const terms = evidenceTerms(query), found: Array<{ anchor: SourceAnchor; score: number }> = [];
  for (const section of sections(doc)) {
    // Keep offsets against the original section; no model-generated text becomes an anchor.
    const pattern = /[^\n]+(?:\n(?!\n)[^\n]+)*/gu;
    for (const match of section.text.matchAll(pattern)) {
      for (let offset = 0; offset < match[0].length;) {
        let end = Math.min(offset + 450, match[0].length);
        if (end < match[0].length && /[\ud800-\udbff]/u.test(match[0][end - 1]!)) end--;
        const start = match.index! + offset, quote = match[0].slice(offset, end).trim(); offset = end;
        if (!quote) continue;
        const exactStart = section.text.indexOf(quote, start);
        const score = overlap(quote, terms);
        if (!score && found.length >= 2) continue;
        found.push({ score, anchor: { quote, prefix: section.text.slice(Math.max(0, exactStart - 80), exactStart), suffix: section.text.slice(exactStart + quote.length, exactStart + quote.length + 80), source: section.source, ...(section.pageNumber ? { pageNumber: section.pageNumber } : {}), ...(section.blockId ? { blockId: section.blockId } : {}) } });
        if (found.length > 64) { found.sort((a, b) => b.score - a.score); found.length = 64; }
      }
    }
  }
  return found.sort((a, b) => b.score - a.score);
}
function citation(doc: StudyDocument, anchor: SourceAnchor, index: number): QuestionCitation { return { id: `${doc.id}:${index}`, documentId: doc.id, documentRevision: doc.revision, title: doc.title, anchor }; }
export async function retrieveEvidence(db: StudyAdapter, question: string, documentIds: string[]): Promise<QuestionCitation[]> {
  const query = readerText(question, 2000, true);
  if (!Array.isArray(documentIds) || documentIds.length > 100 || new Set(documentIds).size !== documentIds.length) throw new ReaderInputError("Invalid question document scope");
  const ids = documentIds.map((id) => readerText(id, 200, true));
  const readable = new Set((await db.all(`SELECT id FROM ${db.documentsTable} WHERE id IN (SELECT value FROM json_each(?)) AND status='ready' AND deleted_at IS NULL`, [JSON.stringify(ids)])).map((row) => String(row.id)));
  const pool: Array<{ citation: QuestionCitation; score: number }> = [];
  for (const id of ids) {
    if (!readable.has(id)) continue;
    const doc = await db.document(id);
    if (!doc || doc.deletedAt) continue;
    for (const [index, passage] of passages(doc, query).slice(0, 3).entries()) if (passage.score > 0) pool.push({ citation: citation(doc, passage.anchor, index + 1), score: passage.score });
  }
  const selected = pool.sort((a, b) => b.score - a.score || a.citation.documentId.localeCompare(b.citation.documentId)).slice(0, 8);
  return selected.map((entry) => entry.citation);
}
function vector(value: unknown) { try { const result = JSON.parse(String(value)); return Array.isArray(result) && result.length > 0 && result.length <= 4096 && result.every((entry) => typeof entry === "number" && Number.isFinite(entry)) ? result as number[] : null; } catch { return null; } }
function cosine(first: number[], second: number[]) { if (first.length !== second.length) return 0; let dot = 0, left = 0, right = 0; for (let index = 0; index < first.length; index++) { dot += first[index]! * second[index]!; left += first[index]! ** 2; right += second[index]! ** 2; } return left && right ? dot / Math.sqrt(left * right) : 0; }
function relationWeight(reason: RelationReason) { return reason.type === "manual" ? 2 : reason.type === "citation" ? 1.5 : reason.type === "semantic" ? reason.score ?? 0 : reason.type === "tag" ? .4 : reason.type === "folder" ? .2 : .1; }
function referenceTargets(doc: StudyDocument) {
  const targets = new Map<string, string>();
  for (const section of sections(doc)) for (const match of section.text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`/gu, "").matchAll(/https?:\/\/[^\s<>"')\]]+/gu)) {
    const value = match[0]!.replace(/[.,;。；，]+$/u, "");
    try { targets.set(new URL(value).href, value); } catch {}
  }
  return targets;
}
function references(doc: StudyDocument, url: string): string | null { if (!/^https?:\/\//u.test(url)) return null; try { return referenceTargets(doc).get(new URL(url).href) ?? null; } catch { return null; } }

export async function getRelated(db: StudyAdapter, documentId: string, options: RelatedOptions = {}): Promise<RelatedResult> {
  const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new ReaderInputError("Related limit must be between 1 and 20");
  const cursor = options.cursor === undefined ? "" : readerText(options.cursor, 200);
  const types = options.types;
  if (types && (!Array.isArray(types) || types.some((type) => !["semantic", "manual", "folder", "tag", "citation", "lexical"].includes(type)))) throw new ReaderInputError("Invalid relation types");
  const source = await db.document(readerText(documentId, 200, true));
  if (!source || source.deletedAt) throw new ReadingDataError(404, "DOCUMENT_NOT_FOUND");
  const guardSource = async () => { const current = (await db.all(`SELECT revision,status,deleted_at AS deletedAt FROM ${db.documentsTable} WHERE id=?`, [documentId]))[0]; if (!current || current.deletedAt || current.status !== "ready" || current.revision !== source.revision) throw new ReadingDataError(409, "REVISION_CONFLICT"); };
  await guardSource();
  const semanticTable = db.documentsTable === "documents" ? "semantic_indexes" : "cloud_semantic_indexes";
  const sourceIndex = (await db.all(`SELECT source_hash,model,format_version,CASE WHEN length(vector_json)<=131072 THEN vector_json ELSE NULL END AS vector_json FROM ${semanticTable} WHERE document_id=? AND state='ready'`, [documentId]))[0];
  const sourceVector = sourceIndex?.format_version === SEMANTIC_FORMAT_VERSION && sourceIndex.source_hash === await documentSemanticHash(source) ? vector(sourceIndex.vector_json) : null;
  const links = await db.all(`SELECT c.id,c.source_id AS sourceId,c.target_id AS targetId,c.note,e.source_annotation_id AS sourceAnnotationId,e.target_annotation_id AS targetAnnotationId,e.relation_type AS relationType
    FROM document_connections c LEFT JOIN reading_connection_evidence e ON e.connection_id=c.id WHERE c.source_id=? OR c.target_id=? ORDER BY c.id LIMIT 100`, [documentId, documentId]);
  const manual = new Map(links.map((row) => [row.sourceId === documentId ? String(row.targetId) : String(row.sourceId), row]));
  type Candidate = { id: string; rank: number; reasons: RelationReason[]; sourceHash?: unknown; model?: unknown; format?: unknown; semanticScore?: number };
  const candidates = new Map<string, Candidate>();
  let search: AnnDiagnostics | undefined;
  if (sourceVector && (!types || types.includes("semantic"))) {
    await backfillAnn(db);
    const result = await searchAnn(db, { id: source.id, model: String(sourceIndex!.model), format: String(sourceIndex!.format_version), vector: sourceVector }, limit, cursor);
    search = result.diagnostics;
    for (const entry of result.entries) if (entry.score >= .3) candidates.set(entry.id, { id: entry.id, rank: entry.score, reasons: [{ type: "semantic", label: "正文向量相近", score: entry.score }], sourceHash: entry.sourceHash, model: entry.model, format: entry.format, semanticScore: entry.score });
  }
  let last = cursor, scannedDocuments = 0, bytes = 0, more = false;
  const queryTerms = evidenceTerms(source.title + " " + sections(source).map((section) => section.text).join(" ").slice(0, 12_000));
  const sourceTags = source.tags.map((tag) => tag.toLocaleLowerCase());
  const sourceReferences = referenceTargets(source);
  const paperTable = db.documentsTable === "documents" ? "papers" : "cloud_papers", pageTable = db.documentsTable === "documents" ? "paper_pages" : "cloud_paper_pages";
  const sourceUrl = /^https?:\/\//u.test(source.sourceUrl) ? source.sourceUrl : "";
  const tagsSql = db.documentsTable === "documents"
    ? "SELECT tag FROM study_document_tags WHERE document_id=d.id UNION SELECT t.name AS tag FROM tags t JOIN document_tags dt ON dt.tag_id=t.id WHERE dt.document_id=d.id"
    : "SELECT tag FROM study_document_tags WHERE document_id=d.id";
  while (scannedDocuments < 1000 && bytes < 8 * 1024 * 1024) {
    const rows = await db.all(`SELECT d.id,d.title,d.source_url AS sourceUrl,d.folder_id AS folderId,
      (SELECT json_group_array(tag) FROM (${tagsSql})) AS tagsJson,
      i.source_hash AS sourceHash,i.model,i.format_version AS format,${search?.mode === "ann" ? "NULL" : "CASE WHEN length(i.vector_json)<=131072 THEN i.vector_json ELSE NULL END"} AS vectorJson,
      CASE WHEN ?='' THEN 0 WHEN d.kind='article' THEN instr(d.markdown,?) ELSE EXISTS(SELECT 1 FROM ${pageTable} pp JOIN ${paperTable} p ON p.id=pp.paper_id AND p.extraction_id=pp.extraction_id WHERE p.id=d.id AND instr(pp.original_json,?)>0) END AS inboundHint
      FROM ${db.documentsTable} d LEFT JOIN ${semanticTable} i ON i.document_id=d.id AND i.state='ready'
      WHERE d.deleted_at IS NULL AND d.status='ready' AND d.id>? AND d.id<>? ORDER BY d.id LIMIT 100`, [sourceUrl, sourceUrl, sourceUrl, last, documentId]);
    if (!rows.length) { more = false; break; }
    let stopped = false;
    for (const row of rows) {
      const vectorBytes = String(row.vectorJson ?? "").length;
      if (scannedDocuments && bytes + vectorBytes > 8 * 1024 * 1024) { more = true; stopped = true; break; }
      const id = String(row.id); last = id; scannedDocuments++; bytes += vectorBytes;
      const prior = candidates.get(id), reasons: RelationReason[] = prior ? [...prior.reasons] : [], link = manual.get(id);
      let rank = prior?.rank ?? 0;
      if (link) { reasons.push({ type: link.relationType === "citation" ? "citation" : "manual", label: String(link.note || "你建立的双向关联"), connectionId: String(link.id), annotationIds: [link.sourceAnnotationId, link.targetAnnotationId].filter((value): value is string => typeof value === "string") }); rank += 2; }
      if (source.folderId && row.folderId === source.folderId) { reasons.push({ type: "folder", label: "来自同一分组" }); rank += .2; }
      let tags: string[] = []; try { tags = JSON.parse(String(row.tagsJson ?? "[]")); } catch {}
      const sharedTags = tags.filter((tag) => sourceTags.includes(tag.toLocaleLowerCase()));
      if (sharedTags.length) { reasons.push({ type: "tag", label: `共同标签：${sharedTags.slice(0, 5).join("、")}` }); rank += .4; }
      if (sourceReferences.has(String(row.sourceUrl))) { reasons.push({ type: "citation", label: "当前资料的正文包含该资料来源链接" }); rank += 1.5; }
      if (Number(row.inboundHint) > 0) rank += 1.5;
      let semanticScore = prior?.semanticScore;
      if (search?.mode !== "ann" && sourceVector && row.model === sourceIndex?.model && row.format === sourceIndex?.format_version) { const target = vector(row.vectorJson); const score = target ? cosine(sourceVector, target) : 0; if (score >= .3) { semanticScore = score; rank += score; reasons.push({ type: "semantic", label: "正文向量相近", score }); } }
      const matches = overlap(String(row.title), queryTerms);
      if (matches && semanticScore === undefined) { reasons.push({ type: "lexical", label: "标题具有共同词项" }); rank += Math.min(.3, matches / Math.max(1, queryTerms.length)); }
      const admitted = types ? reasons.filter((reason) => types.includes(reason.type)) : reasons;
      const inbound = Number(row.inboundHint) > 0 && (!types || types.includes("citation"));
      if (types) rank = admitted.reduce((sum, reason) => sum + relationWeight(reason), 0) + (inbound ? 1.5 : 0);
      if (admitted.length || inbound) candidates.set(id, { id, rank, reasons, sourceHash: row.sourceHash, model: row.model, format: row.format, semanticScore });
      if (scannedDocuments >= 1000) { more = true; stopped = true; break; }
    }
    if (stopped) break;
    more = rows.length === 100;
    if (!more) break;
  }
  // Keep only lightweight metadata during the scan; fetch bodies for the small resulting neighborhood.
  const ranked = [...candidates.values()].sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  const items: RelatedItem[] = [];
  for (const candidate of ranked.slice(0, limit)) {
    if (items.length >= limit) break;
    const doc = await db.document(candidate.id);
    if (!doc || doc.deletedAt) continue;
    const reasons = candidate.reasons.filter((reason) => reason.type !== "semantic");
    if (candidate.semanticScore !== undefined && candidate.sourceHash === await documentSemanticHash(doc)) reasons.push({ type: "semantic", label: "正文向量相近", score: candidate.semanticScore });
    if (references(doc, source.sourceUrl) && !reasons.some((reason) => reason.type === "citation")) reasons.push({ type: "citation", label: "该资料的正文包含当前资料来源链接" });
    const shared = doc.tags.filter((tag) => sourceTags.includes(tag.toLocaleLowerCase()));
    if (shared.length && !reasons.some((reason) => reason.type === "tag")) reasons.push({ type: "tag", label: `共同标签：${shared.slice(0, 5).join("、")}` });
    const filtered = types ? reasons.filter((reason) => types.includes(reason.type)) : reasons;
    if (!filtered.length) continue;
    const evidence = passages(doc, source.title + " " + queryTerms.join(" ")).slice(0, 2).map((passage, index) => ({ ...citation(doc, passage.anchor, index + 1), basis: passage.score > 0 ? "term-overlap" as const : "context" as const }));
    const reference = sourceReferences.get(doc.sourceUrl);
    const referencePassage = reference ? passages(source, reference).find((passage) => passage.anchor.quote.includes(reference)) : null;
    if (referencePassage) evidence.unshift({ ...citation(source, referencePassage.anchor, 0), basis: "context" });
    const link = manual.get(doc.id), annotationId = link?.sourceId === doc.id ? link.sourceAnnotationId : link?.targetAnnotationId;
    if (typeof annotationId === "string") {
      const row = (await db.all(`SELECT ${annotationColumns} FROM reading_annotations WHERE id=? AND document_id=? AND source_revision=?`, [annotationId, doc.id, doc.revision]))[0];
      if (row) { const note = annotationFromRow(row); evidence.unshift({ ...citation(doc, note.anchor, 0), basis: "context" }); }
    }
    evidence.splice(3);
    items.push({ document: { ...doc, markdown: "", sections: undefined }, reasons: filtered, evidence, score: filtered.reduce((sum, reason) => sum + relationWeight(reason), 0) });
  }
  await guardSource();
  return { sourceId: source.id, sourceRevision: source.revision, items: items.sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id)), scannedDocuments, truncated: more, nextCursor: more ? last : null, ...(search ? { search } : {}) };
}

export async function getConnectionEvidence(db: StudyAdapter, connectionId: string): Promise<ConnectionEvidence | null> {
  const row = (await db.all(`SELECT ${connectionEvidenceColumns} FROM reading_connection_evidence WHERE connection_id=?`, [readerText(connectionId, 200, true)]))[0];
  return row ? connectionEvidenceFromRow(row) : null;
}
export async function setConnectionEvidence(db: StudyAdapter, documentId: string, connectionId: string, value: unknown): Promise<ConnectionEvidence> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReaderInputError("Invalid connection evidence");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["revision", "sourceAnnotationId", "targetAnnotationId", "relationType"].includes(key)) || !["manual", "citation"].includes(String(input.relationType))) throw new ReaderInputError("Invalid connection evidence");
  const revision = readerRevision(input.revision);
  const row = (await db.all("SELECT source_id AS sourceId,target_id AS targetId,revision FROM document_connections WHERE id=? AND (source_id=? OR target_id=?)", [connectionId, documentId, documentId]))[0];
  if (!row) throw new ReadingDataError(404, "CONNECTION_NOT_FOUND");
  if (row.revision !== revision) throw new ReadingDataError(409, "CONNECTION_CONFLICT");
  const ids: Array<string | null> = [], revisions: number[] = [];
  for (const [name, docId] of [["sourceAnnotationId", row.sourceId], ["targetAnnotationId", row.targetId]] as const) {
    const doc = await db.document(String(docId)); if (!doc || doc.deletedAt) throw new ReadingDataError(409, "CONNECTION_CONFLICT");
    revisions.push(doc.revision);
    if (input[name] == null || input[name] === "") { ids.push(null); continue; }
    const id = readerText(input[name], 200, true);
    const annotation = (await db.all("SELECT document_id AS documentId,source_revision AS sourceRevision FROM reading_annotations WHERE id=?", [id]))[0];
    if (!annotation || annotation.documentId !== docId || annotation.sourceRevision !== doc.revision) throw new ReaderInputError("Evidence annotation must belong to the current connection endpoint version");
    ids.push(id);
  }
  if (input.relationType === "citation" && !ids.some(Boolean)) throw new ReaderInputError("Confirm a citation with at least one source excerpt");
  const docs = db.documentsTable;
  await db.batch([
    { sql: `SELECT CASE WHEN EXISTS(SELECT 1 FROM document_connections c JOIN ${docs} s ON s.id=c.source_id JOIN ${docs} t ON t.id=c.target_id WHERE c.id=? AND c.revision=? AND s.deleted_at IS NULL AND t.deleted_at IS NULL AND s.revision=? AND t.revision=? AND (? IS NULL OR EXISTS(SELECT 1 FROM reading_annotations a WHERE a.id=? AND a.document_id=s.id AND a.source_revision=s.revision)) AND (? IS NULL OR EXISTS(SELECT 1 FROM reading_annotations a WHERE a.id=? AND a.document_id=t.id AND a.source_revision=t.revision))) THEN 1 ELSE json('CONNECTION_CONFLICT') END`, values: [connectionId, revision, revisions[0], revisions[1], ids[0], ids[0], ids[1], ids[1]] },
    { sql: "INSERT INTO reading_connection_evidence(connection_id,source_annotation_id,target_annotation_id,relation_type,revision,updated_at) VALUES(?,?,?,?,1,?) ON CONFLICT(connection_id) DO UPDATE SET source_annotation_id=excluded.source_annotation_id,target_annotation_id=excluded.target_annotation_id,relation_type=excluded.relation_type,revision=reading_connection_evidence.revision+1,updated_at=excluded.updated_at", values: [connectionId, ids[0], ids[1], input.relationType, new Date().toISOString()] },
    { sql: "UPDATE document_connections SET revision=revision+1 WHERE id=? AND revision=?", values: [connectionId, revision] },
  ]);
  return (await getConnectionEvidence(db, connectionId))!;
}
