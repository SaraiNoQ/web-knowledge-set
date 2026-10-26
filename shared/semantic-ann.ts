import type { StudyAdapter } from "./study-types.js";

export const ANN_VERSION = "binary-sq8-v1";
export const ANN_BITS = 2048;
export const annSignatureBits = (dimension: number) => dimension <= 256 ? 512 : ANN_BITS;
export const ANN_MAX_DIMENSION = 1024;
// shortcut: scan at most 10k compressed records per page; larger libraries continue by keyset.
export const ANN_SCAN_LIMIT = 10000;
export const ANN_SIGNATURE_BYTES = 8 * 1024 * 1024;
export const ANN_QUANTIZED_BYTES = 8 * 1024 * 1024;
export const ANN_VECTOR_BYTES = 8 * 1024 * 1024;
export const SEMANTIC_ANN_SCHEMA = `CREATE TABLE semantic_ann (
 document_id TEXT PRIMARY KEY REFERENCES semantic_indexes(document_id) ON DELETE CASCADE,
 source_hash TEXT NOT NULL,model TEXT NOT NULL,format_version TEXT NOT NULL,
 ann_version TEXT NOT NULL,dimension INTEGER NOT NULL,signature TEXT NOT NULL,quantized TEXT NOT NULL
);`;
export const annTable = (docs: StudyAdapter["documentsTable"]) => docs === "documents" ? "semantic_ann" : "cloud_semantic_ann";
export const semanticTable = (docs: StudyAdapter["documentsTable"]) => docs === "documents" ? "semantic_indexes" : "cloud_semantic_indexes";
export interface AnnEntry { id: string; sourceHash: string; model: string; format: string; score: number }
export interface AnnDiagnostics { mode: "ann" | "exact"; indexedDocuments: number; missingDocuments: number; signatureRows: number; candidates: number; vectorRows: number; readBytes: number; partial: boolean; }
const projectionCache = new Map<number, Float32Array>();
function projections(dimension: number) {
  const cached = projectionCache.get(dimension); if (cached) return cached;
  const values = new Float32Array(annSignatureBits(dimension) * dimension); let seed = 0x51ed270b;
  for (let index = 0; index < values.length; index++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; values[index] = (seed >>> 0) / 0x80000000 - 1; }
  projectionCache.clear(); projectionCache.set(dimension, values); return values;
}
function base64(bytes: Uint8Array) { let raw = ""; for (let index = 0; index < bytes.length; index++) raw += String.fromCharCode(bytes[index]!); return btoa(raw); }
export function parseAnnVector(value: unknown): number[] | null {
  try { const result = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(result) && result.length > 0 && result.length <= 4096 && result.every((entry) => typeof entry === "number" && Number.isFinite(entry)) ? result as number[] : null; } catch { return null; }
}
export function annCosine(first: ArrayLike<number>, second: ArrayLike<number>) { if (first.length !== second.length) return 0; let dot = 0, left = 0, right = 0; for (let index = 0; index < first.length; index++) { dot += first[index]! * second[index]!; left += first[index]! ** 2; right += second[index]! ** 2; } return left && right ? dot / Math.sqrt(left * right) : 0; }
export function encodeAnnVector(vector: number[]) {
  if (!vector.length || vector.length > ANN_MAX_DIMENSION || vector.some((value) => !Number.isFinite(value))) return null;
  const magnitude = Math.hypot(...vector); if (!Number.isFinite(magnitude) || !magnitude) return null;
  const normalized = vector.map((value) => value / magnitude), max = Math.max(...normalized.map(Math.abs));
  const quantized = Uint8Array.from(normalized, (value) => Math.round(value / max * 127) + 128), signature = new Uint8Array(annSignatureBits(vector.length) / 8), planes = projections(vector.length);
  for (let bit = 0; bit < annSignatureBits(vector.length); bit++) { let sum = 0, offset = bit * vector.length; for (let axis = 0; axis < vector.length; axis++) sum += normalized[axis]! * planes[offset + axis]!; if (sum >= 0) signature[bit >>> 3]! |= 1 << (bit & 7); }
  return { dimension: vector.length, signature: base64(signature), quantized: base64(quantized) };
}
export function annInsert(docs: StudyAdapter["documentsTable"], id: string, sourceHash: string, model: string, format: string, vector: number[]) {
  const encoded = encodeAnnVector(vector); if (!encoded) return null;
  const table = annTable(docs), indexes = semanticTable(docs);
  return { sql: `INSERT INTO ${table}(document_id,source_hash,model,format_version,ann_version,dimension,signature,quantized) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ${indexes} i JOIN ${docs} d ON d.id=i.document_id WHERE i.document_id=? AND i.source_hash=? AND i.model=? AND i.format_version=? AND i.state='ready' AND i.vector_json=? AND d.deleted_at IS NULL AND d.status='ready') ON CONFLICT(document_id) DO UPDATE SET source_hash=excluded.source_hash,model=excluded.model,format_version=excluded.format_version,ann_version=excluded.ann_version,dimension=excluded.dimension,signature=excluded.signature,quantized=excluded.quantized`, values: [id, sourceHash, model, format, ANN_VERSION, encoded.dimension, encoded.signature, encoded.quantized, id, sourceHash, model, format, JSON.stringify(vector)] };
}
export async function backfillAnn(db: Pick<StudyAdapter, "all" | "batch" | "documentsTable">, limit = 16) {
  const table = annTable(db.documentsTable), indexes = semanticTable(db.documentsTable);
  const rows = await db.all(`SELECT i.document_id AS id,i.source_hash AS sourceHash,i.model,i.format_version AS format,i.vector_json AS vectorJson FROM ${indexes} i JOIN ${db.documentsTable} d ON d.id=i.document_id LEFT JOIN ${table} a ON a.document_id=i.document_id AND a.source_hash=i.source_hash AND a.model=i.model AND a.format_version=i.format_version AND a.ann_version=? AND a.dimension BETWEEN 1 AND 1024 AND length(a.signature)=CASE WHEN a.dimension<=256 THEN 88 ELSE 344 END AND length(a.quantized)=4*((a.dimension+2)/3) WHERE i.state='ready' AND d.deleted_at IS NULL AND d.status='ready' AND CASE WHEN a.document_id IS NULL THEN json_array_length(i.vector_json) BETWEEN 1 AND ? AND length(i.vector_json)<=131072 ELSE 0 END ORDER BY i.document_id LIMIT ?`, [ANN_VERSION, ANN_MAX_DIMENSION, limit]);
  const statements = rows.flatMap((row) => { const vector = parseAnnVector(row.vectorJson); const insert = vector && annInsert(db.documentsTable, String(row.id), String(row.sourceHash), String(row.model), String(row.format), vector); return insert ? [insert] : []; });
  if (statements.length) await db.batch(statements); return statements.length;
}
function popcount(value: number) { value -= (value >>> 1) & 0x55; value = (value & 0x33) + ((value >>> 2) & 0x33); return (value + (value >>> 4)) & 15; }
const base64Values = new Int16Array(128).fill(-1);
for (const [index, character] of Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/").entries()) base64Values[character.charCodeAt(0)] = index;
const hammingWeights = Uint8Array.from({ length: 64 }, (_, value) => popcount(value));
function signatureDistance(first: string, second: unknown) {
  if (typeof second !== "string" || first.length !== second.length) return null;
  const tail = base64Values[second.charCodeAt(second.length - 3)]; if (tail === undefined || tail < 0 || (tail & 15) !== 0) return null;
  let score = 0;
  for (let index = 0; index < first.length; index++) {
    if (first[index] === "=") { if (second[index] !== "=") return null; continue; }
    const left = base64Values[first.charCodeAt(index)], right = base64Values[second.charCodeAt(index)];
    if (left === undefined || right === undefined || left < 0 || right < 0) return null;
    score += hammingWeights[left ^ right]!;
  }
  return score;
}
function quantizedCosine(query: number[], encoded: unknown) {
  if (typeof encoded !== "string") return null;
  let raw: string; try { raw = atob(encoded); } catch { return null; }
  if (raw.length !== query.length) return null;
  let dot = 0, left = 0, right = 0;
  for (let axis = 0; axis < query.length; axis++) { const value = raw.charCodeAt(axis) - 128; dot += query[axis]! * value; left += query[axis]! ** 2; right += value ** 2; }
  return left && right ? dot / Math.sqrt(left * right) : null;
}
export async function searchAnn(db: Pick<StudyAdapter, "all" | "batch" | "documentsTable">, source: { id: string; model: string; format: string; vector: number[] }, limit: number, cursor = "") {
  const diagnostics: AnnDiagnostics = { mode: "exact", indexedDocuments: 0, missingDocuments: 0, signatureRows: 0, candidates: 0, vectorRows: 0, readBytes: 0, partial: false };
  const encoded = encodeAnnVector(source.vector); if (!encoded) return { entries: [] as AnnEntry[], diagnostics };
  const table = annTable(db.documentsTable), indexes = semanticTable(db.documentsTable);
  const eligible = `FROM ${indexes} i JOIN ${db.documentsTable} d ON d.id=i.document_id LEFT JOIN ${table} a ON a.document_id=i.document_id AND a.source_hash=i.source_hash AND a.model=i.model AND a.format_version=i.format_version AND a.ann_version=? AND a.dimension=? AND length(a.signature)=? AND length(a.quantized)=? WHERE i.state='ready' AND i.model=? AND i.format_version=? AND d.deleted_at IS NULL AND d.status='ready' AND i.document_id<>? AND i.document_id>?`;
  const values = [ANN_VERSION, source.vector.length, encoded.signature.length, encoded.quantized.length, source.model, source.format, source.id, cursor];
  const count = (await db.all(`SELECT COUNT(*) AS total,COUNT(a.document_id) AS indexed ${eligible}`, values))[0];
  const total = Number(count?.total ?? 0); diagnostics.indexedDocuments = Number(count?.indexed ?? 0); diagnostics.missingDocuments = total - diagnostics.indexedDocuments;
  // Small or incomplete indexes retain the exact, paged route until backfill finishes.
  if (total <= 1000 || diagnostics.missingDocuments) return { entries: [] as AnnEntry[], diagnostics };
  diagnostics.mode = "ann";
  const corrupt: Array<{ id: string; column: "signature" | "quantized"; value: string }> = [];
  const damaged = (id: string, column: "signature" | "quantized", value: unknown) => { diagnostics.partial = true; if (corrupt.length < 16 && typeof value === "string") corrupt.push({ id, column, value }); };
  const rows = await db.all(`SELECT i.document_id AS id,CASE WHEN length(a.signature)=? THEN a.signature ELSE NULL END AS signature ${eligible} ORDER BY i.document_id LIMIT ?`, [4 * Math.ceil(annSignatureBits(source.vector.length) / 8 / 3), ...values, ANN_SCAN_LIMIT + 1]);
  const ranked: Array<{ id: string; distance: number }> = [];
  for (const row of rows) {
    const bytes = String(row.signature ?? "").length + String(row.id).length;
    if (diagnostics.signatureRows >= ANN_SCAN_LIMIT || diagnostics.readBytes + bytes > ANN_SIGNATURE_BYTES) { diagnostics.partial = true; break; }
    diagnostics.signatureRows++; diagnostics.readBytes += bytes; const distance = signatureDistance(encoded.signature, row.signature); if (distance !== null) ranked.push({ id: String(row.id), distance }); else damaged(String(row.id), "signature", row.signature);
  }
  rows.length = 0;
  const budget = Math.min(source.vector.length > 256 ? 6000 : 1024, Math.floor(ANN_QUANTIZED_BYTES / (4 * Math.ceil(source.vector.length / 3))));
  const shortlist = ranked.sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id)).slice(0, budget);
  const quantized = await db.all(`SELECT document_id AS id,CASE WHEN length(quantized)=? THEN quantized ELSE NULL END AS quantized FROM ${table} WHERE document_id IN(SELECT value FROM json_each(?)) AND ann_version=? AND dimension=?`, [4 * Math.ceil(source.vector.length / 3), JSON.stringify(shortlist.map((row) => row.id)), ANN_VERSION, source.vector.length]);
  const approximate: Array<{ id: string; score: number }> = []; let quantizedBytes = 0;
  for (const row of quantized) {
    const bytes = String(row.quantized ?? "").length; if (quantizedBytes + bytes > ANN_QUANTIZED_BYTES) { diagnostics.partial = true; break; } quantizedBytes += bytes;
    const score = quantizedCosine(source.vector, row.quantized); if (score !== null) approximate.push({ id: String(row.id), score }); else damaged(String(row.id), "quantized", row.quantized);
  }
  quantized.length = 0;
  diagnostics.candidates = approximate.length; diagnostics.readBytes += quantizedBytes;
  const finalists = approximate.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, Math.min(64, Math.max(40, limit * 4)));
  const vectors = await db.all(`SELECT i.document_id AS id,i.source_hash AS sourceHash,i.model,i.format_version AS format,CASE WHEN length(i.vector_json)<=131072 THEN i.vector_json ELSE NULL END AS vectorJson FROM ${indexes} i JOIN ${db.documentsTable} d ON d.id=i.document_id JOIN ${table} a ON a.document_id=i.document_id AND a.source_hash=i.source_hash AND a.model=i.model AND a.format_version=i.format_version WHERE i.document_id IN(SELECT value FROM json_each(?)) AND i.state='ready' AND i.model=? AND i.format_version=? AND d.deleted_at IS NULL AND d.status='ready'`, [JSON.stringify(finalists.map((row) => row.id)), source.model, source.format]);
  const entries: AnnEntry[] = []; let vectorBytes = 0;
  for (const row of vectors) {
    const bytes = String(row.vectorJson ?? "").length; if (vectorBytes + bytes > ANN_VECTOR_BYTES) { diagnostics.partial = true; break; } vectorBytes += bytes; diagnostics.vectorRows++;
    const vector = parseAnnVector(row.vectorJson); if (vector) entries.push({ id: String(row.id), sourceHash: String(row.sourceHash), model: String(row.model), format: String(row.format), score: annCosine(source.vector, vector) });
  }
  diagnostics.readBytes += vectorBytes;
  if (corrupt.length) await db.batch(corrupt.map((row) => ({ sql: `DELETE FROM ${table} WHERE document_id=? AND ann_version=? AND ${row.column}=?`, values: [row.id, ANN_VERSION, row.value] })));
  return { entries: entries.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)), diagnostics };
}
