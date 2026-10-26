import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { annSignatureBits, ANN_VERSION, SEMANTIC_ANN_SCHEMA, annInsert, backfillAnn, encodeAnnVector, searchAnn } from "../shared/semantic-ann.js";
import type { StudyAdapter } from "../shared/study-types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/db.js";

function fixture(cloud = false) {
  const sql = new DatabaseSync(":memory:"); sql.exec("PRAGMA foreign_keys=ON");
  const docs = cloud ? "cloud_documents" : "documents", indexes = cloud ? "cloud_semantic_indexes" : "semantic_indexes", ann = cloud ? "cloud_semantic_ann" : "semantic_ann";
  sql.exec(`CREATE TABLE ${docs}(id TEXT PRIMARY KEY,status TEXT DEFAULT 'ready',deleted_at TEXT); CREATE TABLE ${indexes}(document_id TEXT PRIMARY KEY REFERENCES ${docs}(id) ON DELETE CASCADE,source_hash TEXT,model TEXT,format_version TEXT,state TEXT,vector_json TEXT);`);
  sql.exec(SEMANTIC_ANN_SCHEMA.replaceAll("semantic_ann", ann).replaceAll("semantic_indexes", indexes));
  let before: (() => void) | undefined;
  const adapter: Pick<StudyAdapter, "documentsTable" | "all" | "batch"> = { documentsTable: docs,
    all: async (query, values) => sql.prepare(query).all(...values as never[]),
    batch: async (statements) => { before?.(); before = undefined; sql.exec("BEGIN IMMEDIATE"); try { for (const statement of statements) sql.prepare(statement.sql).run(...statement.values as never[]); sql.exec("COMMIT"); } catch (error) { sql.exec("ROLLBACK"); throw error; } },
  };
  const add = (id: string, vector: number[], indexed = true, model = "model") => {
    sql.prepare(`INSERT INTO ${docs}(id) VALUES(?)`).run(id); sql.prepare(`INSERT INTO ${indexes} VALUES(?,? ,?,'semantic-text-v1','ready',?)`).run(id, "f".repeat(64), model, JSON.stringify(vector));
    const insert = indexed && annInsert(docs, id, "f".repeat(64), model, "semantic-text-v1", vector); if (insert) sql.prepare(insert.sql).run(...insert.values as never[]);
  };
  return { sql, docs, indexes, ann, adapter, add, race(callback: () => void) { before = callback; } };
}
const source = { id: "source", model: "model", format: "semantic-text-v1", vector: [1, 0, 0, 0] };

test("ANN compression rejects invalid/unsupported vectors and keeps deterministic bounded encodings", () => {
  const first = encodeAnnVector([1, -.5, .2]); assert.deepEqual(first, encodeAnnVector([1, -.5, .2])); assert.equal(first?.signature.length, 4 * Math.ceil(annSignatureBits(3) / 8 / 3));
  for (const vector of [[], [0, 0], [1, NaN], [Number.MAX_VALUE, Number.MAX_VALUE], Array<number>(1025).fill(1)]) assert.equal(encodeAnnVector(vector), null);
});

test("schema21 upgrades without changing research notes or original semantic vectors", () => {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-ann-upgrade-")); let db = openDatabase(directory);
  try {
    const document = db.createArticle("Existing research");
    db.sql.prepare("INSERT INTO study_topics VALUES('topic','Existing topic','retain synthesis',3,'now','now')").run();
    db.sql.prepare("INSERT INTO semantic_indexes(document_id,source_hash,model,format_version,state,vector_json,updated_at) VALUES(?,?,'model','semantic-text-v1','ready','[1,0]','now')").run(document.id, "f".repeat(64));
    db.sql.exec("DROP TABLE semantic_ann; DELETE FROM schema_migrations WHERE version=22;"); db.close(); db = openDatabase(directory);
    assert.equal(db.getDocument(document.id)?.title, "Existing research"); assert.equal(db.sql.prepare("SELECT note FROM study_topics").get()?.note, "retain synthesis");
    assert.equal(db.sql.prepare("SELECT vector_json FROM semantic_indexes").get()?.vector_json, "[1,0]"); assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM semantic_ann").get()?.n, 0);
    assert.deepEqual(db.sql.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const cloud of [false, true]) test(`ANN backfill is bounded, rejects races and cascades invalidation (${cloud ? "D1" : "local"})`, async () => {
  const f = fixture(cloud);
  try {
    f.add("a", [1, 0], false); f.add("b", [0, 1], false); f.add("c", [-1, 0], false);
    assert.equal(await backfillAnn(f.adapter, 1), 1); assert.equal(f.sql.prepare(`SELECT COUNT(*) AS n FROM ${f.ann}`).get()?.n, 1);
    f.race(() => f.sql.prepare(`UPDATE ${f.indexes} SET vector_json='[1,1]' WHERE document_id='b'`).run());
    assert.equal(await backfillAnn(f.adapter, 1), 1); assert.equal(f.sql.prepare(`SELECT COUNT(*) AS n FROM ${f.ann}`).get()?.n, 1);
    await backfillAnn(f.adapter); assert.equal(f.sql.prepare(`SELECT COUNT(*) AS n FROM ${f.ann}`).get()?.n, 3);
    f.sql.prepare(`DELETE FROM ${f.indexes} WHERE document_id='a'`).run(); assert.equal(f.sql.prepare(`SELECT COUNT(*) AS n FROM ${f.ann}`).get()?.n, 2);
    f.sql.prepare(`DELETE FROM ${f.docs} WHERE id='b'`).run(); assert.equal(f.sql.prepare(`SELECT COUNT(*) AS n FROM ${f.ann}`).get()?.n, 1);
  } finally { f.sql.close(); }
});

test("a complete ANN cache checks metadata without parsing original vectors again", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 10; index++) f.add(String(index), [1, .5]);
    let parsed = 0;
    f.sql.function("json_array_length", (value) => { parsed++; return (JSON.parse(String(value)) as unknown[]).length; });
    assert.equal(await backfillAnn(f.adapter), 0); assert.equal(parsed, 0);
    f.add("new", [1, .25], false); assert.equal(await backfillAnn(f.adapter), 1); assert.equal(parsed, 1);
  } finally { f.sql.close(); }
});

for (const cloud of [false, true]) test(`ANN uses current vectors only and reports incomplete coverage instead of approximating it (${cloud ? "D1" : "local"})`, async () => {
  const f = fixture(cloud);
  try {
    f.add(source.id, source.vector);
    for (let index = 0; index < 1100; index++) f.add(`d${String(index).padStart(4, "0")}`, [1, index / 1000, 0, 0]);
    f.add("z-nearest", [1, 0, .00001, 0]);
    const result = await searchAnn(f.adapter, source, 10);
    assert.equal(result.diagnostics.mode, "ann"); assert.equal(result.entries[0]?.id, "d0000"); assert.ok(result.entries.some((entry) => entry.id === "z-nearest"));
    assert.ok(result.diagnostics.vectorRows <= 64); assert.ok(result.diagnostics.candidates <= 1024); assert.equal(result.diagnostics.partial, false);
    f.sql.prepare(`UPDATE ${f.docs} SET deleted_at='2026-10-26' WHERE id='d0000'`).run(); f.sql.prepare(`UPDATE ${f.indexes} SET model='other' WHERE document_id='z-nearest'`).run();
    const changed = await searchAnn(f.adapter, source, 10); assert.ok(!changed.entries.some((entry) => ["d0000", "z-nearest"].includes(entry.id)));
    f.add("missing", [1, 0, 0, 0], false);
    const incomplete = await searchAnn(f.adapter, source, 10); assert.equal(incomplete.diagnostics.mode, "exact"); assert.equal(incomplete.diagnostics.missingDocuments, 1); assert.equal(incomplete.entries.length, 0);
    await backfillAnn(f.adapter); assert.equal((await searchAnn(f.adapter, source, 10)).diagnostics.mode, "ann");
    const signature = String(f.sql.prepare(`SELECT signature FROM ${f.ann} WHERE document_id='missing'`).get()?.signature);
    f.sql.prepare(`UPDATE ${f.ann} SET signature=? WHERE document_id='missing'`).run("!" + signature.slice(1));
    assert.equal((await searchAnn(f.adapter, source, 10)).diagnostics.partial, true);
    assert.equal(f.sql.prepare(`SELECT COUNT(*) AS n FROM ${f.ann} WHERE document_id='missing'`).get()?.n, 0);
    assert.equal(f.sql.prepare(`SELECT vector_json FROM ${f.indexes} WHERE document_id='missing'`).get()?.vector_json, JSON.stringify(source.vector));
    await backfillAnn(f.adapter); assert.equal((await searchAnn(f.adapter, source, 10)).diagnostics.partial, false);
    const quantized = String(f.sql.prepare(`SELECT quantized FROM ${f.ann} WHERE document_id='missing'`).get()?.quantized);
    f.sql.prepare(`UPDATE ${f.ann} SET quantized=? WHERE document_id='missing'`).run("!" + quantized.slice(1));
    assert.equal((await searchAnn(f.adapter, source, 10)).diagnostics.partial, true);
    assert.equal(f.sql.prepare(`SELECT COUNT(*) AS n FROM ${f.ann} WHERE document_id='missing'`).get()?.n, 0);
    await backfillAnn(f.adapter); assert.equal((await searchAnn(f.adapter, source, 10)).diagnostics.partial, false);
    f.sql.prepare(`UPDATE ${f.ann} SET signature='' WHERE document_id='missing'`).run(); assert.equal((await searchAnn(f.adapter, source, 10)).diagnostics.mode, "exact");
    await backfillAnn(f.adapter); assert.equal((await searchAnn(f.adapter, source, 10)).diagnostics.mode, "ann");
    f.sql.prepare(`UPDATE ${f.ann} SET ann_version='future' WHERE document_id='missing'`).run(); assert.equal((await searchAnn(f.adapter, source, 10)).diagnostics.mode, "exact");
    assert.equal(ANN_VERSION, "binary-sq8-v1");
  } finally { f.sql.close(); }
});

test("ANN marks a bounded scan partial and can continue beyond that window", async () => {
  const f = fixture();
  try {
    f.add(source.id, source.vector);
    for (let index = 0; index < 10002; index++) f.add(`d${String(index).padStart(5, "0")}`, [0, 1, 0, 0]);
    f.add("zz-nearest", source.vector);
    const first = await searchAnn(f.adapter, source, 10); assert.equal(first.diagnostics.partial, true); assert.equal(first.diagnostics.signatureRows, 10000);
    const second = await searchAnn(f.adapter, source, 10, "d05000"); assert.equal(second.diagnostics.partial, false); assert.equal(second.entries[0]?.id, "zz-nearest");
  } finally { f.sql.close(); }
});
