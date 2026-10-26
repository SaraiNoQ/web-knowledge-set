import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { ANN_BITS, ANN_SCAN_LIMIT, ANN_VERSION, SEMANTIC_ANN_SCHEMA, annCosine, annInsert, searchAnn } from "../shared/semantic-ann.js";
import type { StudyAdapter } from "../shared/study-types.js";

let seed = 0x73e2c761;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000; };
const normalize = (vector: number[]) => { const norm = Math.hypot(...vector); return vector.map((value) => Number((value / norm).toFixed(6))); };
const randomVector = (dimension: number) => normalize(Array.from({ length: dimension }, () => random() * 2 - 1));
const percentile = (items: number[], quantile: number) => [...items].sort((left, right) => left - right)[Math.min(items.length - 1, Math.floor(items.length * quantile))]!;
interface Measurement { count: number; dimension: number; corpus: string; buildMs: number; recallAt10: number; minimumRecallAt10: number; annP50Ms: number; annP95Ms: number; exactP50Ms: number; exactP95Ms: number; meanReadBytes: number; exactReadBytes: number; meanOriginalVectorRows: number; totalReadByteRatio: number; }
const measurements: Measurement[] = [];

for (const dimension of [128, 1024]) for (const count of [1000, 10000]) for (const clustered of [false, true]) {
  const sql = new DatabaseSync(":memory:"); sql.exec("PRAGMA foreign_keys=ON");
  sql.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,status TEXT DEFAULT 'ready',deleted_at TEXT); CREATE TABLE semantic_indexes(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,source_hash TEXT,model TEXT,format_version TEXT,state TEXT,vector_json TEXT);"); sql.exec(SEMANTIC_ANN_SCHEMA);
  const adapter: Pick<StudyAdapter, "documentsTable" | "all" | "batch"> = { documentsTable: "documents", all: async (query, values) => sql.prepare(query).all(...values as never[]), batch: async (statements) => { for (const statement of statements) sql.prepare(statement.sql).run(...statement.values as never[]); } };
  const clusters = Array.from({ length: 32 }, () => randomVector(dimension));
  const vector = () => clustered ? normalize(clusters[Math.floor(random() * clusters.length)]!.map((value) => value + (random() * 2 - 1) * .6 / Math.sqrt(dimension))) : randomVector(dimension);
  let exactBytes = 0;
  const buildStart = performance.now();
  sql.exec("BEGIN");
  for (let index = 0; index < count; index++) {
    const id = `d${String(index).padStart(5, "0")}`, values = vector(), json = JSON.stringify(values); exactBytes += json.length;
    sql.prepare("INSERT INTO documents(id) VALUES(?)").run(id); sql.prepare("INSERT INTO semantic_indexes VALUES(?,?,'benchmark','semantic-text-v1','ready',?)").run(id, "a".repeat(64), json);
    const insertion = annInsert("documents", id, "a".repeat(64), "benchmark", "semantic-text-v1", values)!; sql.prepare(insertion.sql).run(...insertion.values as never[]);
  }
  sql.exec("COMMIT"); const buildMs = performance.now() - buildStart;
  const annTimes: number[] = [], exactTimes: number[] = [], recalls: number[] = [], readBytes: number[] = [], vectorRows: number[] = [];
  for (let query = 0; query < 20; query++) {
    const values = vector(); let exactStart = performance.now(); const exact: Array<{ id: string; score: number }> = [];
    for (const row of sql.prepare("SELECT document_id AS id,vector_json AS vector FROM semantic_indexes").iterate()) {
      exact.push({ id: String(row.id), score: annCosine(values, JSON.parse(String(row.vector)) as number[]) });
    }
    exact.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)); exactTimes.push(performance.now() - exactStart);
    const annStart = performance.now(); const result = await searchAnn(adapter, { id: "query", model: "benchmark", format: "semantic-text-v1", vector: values }, 10); annTimes.push(performance.now() - annStart);
    // Small libraries deliberately use the exact route; benchmark that route without labelling it ANN.
    if (result.diagnostics.mode === "exact") { recalls.push(1); readBytes.push(exactBytes); vectorRows.push(count); annTimes[annTimes.length - 1] += exactTimes[exactTimes.length - 1]!; continue; }
    assert.equal(result.diagnostics.partial, false); const expected = new Set(exact.slice(0, 10).map((entry) => entry.id));
    recalls.push(result.entries.slice(0, 10).filter((entry) => expected.has(entry.id)).length / 10); readBytes.push(result.diagnostics.readBytes); vectorRows.push(result.diagnostics.vectorRows);
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const result = { count, dimension, corpus: clustered ? "32-cluster" : "isotropic", buildMs, recallAt10: mean(recalls), minimumRecallAt10: Math.min(...recalls), annP50Ms: percentile(annTimes, .5), annP95Ms: percentile(annTimes, .95), exactP50Ms: percentile(exactTimes, .5), exactP95Ms: percentile(exactTimes, .95), meanReadBytes: mean(readBytes), exactReadBytes: exactBytes, meanOriginalVectorRows: mean(vectorRows), totalReadByteRatio: mean(readBytes) / exactBytes };
  measurements.push(result); console.error(JSON.stringify(result)); sql.close();
}
console.log(JSON.stringify({ indexVersion: ANN_VERSION, maximumBits: ANN_BITS, scanLimit: ANN_SCAN_LIMIT, engine: "bounded compressed binary + SQ8 scan, exact original-vector rerank", context: "Synthetic deterministic vectors; 20 queries per case; warm in-memory SQLite; D1 network latency and billed rows not measured", node: process.version, platform: process.platform, architecture: process.arch, measurements }, null, 2));
assert.ok(measurements.every((row) => row.recallAt10 >= .95), "ANN recall@10 must reach95% against exact search on every deterministic corpus");
assert.ok(measurements.filter((row) => row.count === 10000).every((row) => row.totalReadByteRatio < .25), "ANN must read less than25% of full-vector bytes at10k");
assert.ok(measurements.filter((row) => row.count === 10000).every((row) => row.annP50Ms < row.exactP50Ms), "ANN median query time must improve over exact search at10k");
