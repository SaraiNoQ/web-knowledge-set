import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { duplicateCandidates } from "../shared/study-analysis.js";
import type { StudyAdapter, StudyDocument } from "../shared/study-types.js";

function fixture() {
  const sql = new DatabaseSync(":memory:"); sql.exec("PRAGMA foreign_keys=ON");
  sql.exec(`CREATE TABLE cloud_documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,source_url TEXT NOT NULL,markdown TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,deleted_at TEXT,status TEXT NOT NULL DEFAULT 'ready');
    CREATE TABLE study_fingerprints(document_id TEXT PRIMARY KEY REFERENCES cloud_documents(id) ON DELETE CASCADE,source_revision INTEGER NOT NULL,fingerprint_json TEXT NOT NULL CHECK(json_valid(fingerprint_json)));`);
  const writes: string[] = [];
  const db: StudyAdapter = { documentsTable: "cloud_documents",
    async all(query, values) { return sql.prepare(query).all(...values as never[]); },
    async run(query, values) { writes.push(query); return Number(sql.prepare(query).run(...values as never[]).changes); },
    async batch(statements) { sql.exec("BEGIN"); try { for (const { sql: query, values } of statements) sql.prepare(query).run(...values as never[]); sql.exec("COMMIT"); } catch (error) { sql.exec("ROLLBACK"); throw error; } },
    async document(id) { const row = sql.prepare("SELECT id,title,source_url AS sourceUrl,markdown,revision,deleted_at AS deletedAt FROM cloud_documents WHERE id=?").get(id); return row ? { ...row, kind: "article", folderId: null, tags: [] } as StudyDocument : null; },
  };
  const add = (id: string, markdown: string) => sql.prepare("INSERT INTO cloud_documents(id,title,source_url,markdown) VALUES(?,?,?,?)").run(id, id, `https://example.com/${id}`, markdown);
  return { sql, db, writes, add };
}
const prose = Array.from({ length: 100 }, (_, index) => `researchword${index}`).join(" ");
const containsPair = (items: Awaited<ReturnType<typeof duplicateCandidates>>["items"], first: string, second: string) => items.some((item) => [item.source.id, item.target.id].sort().join(":") === [first, second].sort().join(":"));

test("duplicate candidates compare against earlier keyset pages and never merge or remove documents", async () => {
  const f = fixture();
  try {
    f.add("a-original", prose);
    for (let index = 0; index < 9; index++) f.add(`m-${index}`, Array.from({ length: 60 }, (_, word) => `independent${index}token${word}`).join(" "));
    f.add("z-near", prose + " additional context");
    const first = await duplicateCandidates(f.db); assert.equal(first.scanned, 10); assert.ok(first.nextCursor); assert.ok(!containsPair(first.items, "a-original", "z-near"));
    const second = await duplicateCandidates(f.db, first.nextCursor!); assert.equal(second.scanned, 1); assert.equal(second.nextCursor, null);
    assert.ok(containsPair(second.items, "a-original", "z-near"));
    assert.ok(second.items.every((item) => item.reason.includes("候选") && item.reason.includes("核对")));
    assert.ok(second.items.every((item) => item.source.markdown === "" && item.target.markdown === ""));
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM cloud_documents WHERE deleted_at IS NULL").get()?.n, 11);
    assert.equal(f.sql.prepare("SELECT markdown FROM cloud_documents WHERE id='a-original'").get()?.markdown, prose);
    assert.ok(f.writes.every((query) => query.startsWith("INSERT INTO study_fingerprints")));
  } finally { f.sql.close(); }
});

test("duplicate detection excludes stale fingerprints and trashed documents", async () => {
  const f = fixture();
  try {
    f.add("a-original", prose);
    for (let index = 0; index < 9; index++) f.add(`m-${index}`, `short unrelated ${index}`);
    f.add("z-near", prose);
    const first = await duplicateCandidates(f.db);
    f.sql.prepare("UPDATE cloud_documents SET markdown='Changed unrelated text',revision=2 WHERE id='a-original'").run();
    assert.ok(!containsPair((await duplicateCandidates(f.db, first.nextCursor!)).items, "a-original", "z-near"));
    f.sql.prepare("UPDATE cloud_documents SET markdown=?,revision=3 WHERE id='a-original'").run(prose);
    await duplicateCandidates(f.db);
    f.sql.exec("UPDATE cloud_documents SET deleted_at='2026-10-26' WHERE id='a-original'");
    assert.ok(!containsPair((await duplicateCandidates(f.db, first.nextCursor!)).items, "a-original", "z-near"));
  } finally { f.sql.close(); }
});

test("long English text uses bounded sampled fingerprints and remains a manual candidate", async () => {
  const f = fixture();
  try {
    const original = (prose + " ").repeat(150);
    assert.ok(original.length > 100_000);
    const changed = original.slice(0, 30_000) + "q".repeat(10_000) + original.slice(40_000);
    f.add("a-long", original); f.add("b-long", changed);
    const result = await duplicateCandidates(f.db);
    const rows = f.sql.prepare("SELECT fingerprint_json FROM study_fingerprints ORDER BY document_id").all();
    for (const row of rows) { const hashes = JSON.parse(String(row.fingerprint_json)); assert.ok(hashes.length > 0 && hashes.length <= 64); assert.ok(hashes.every(Number.isInteger)); }
    assert.equal(rows[0]?.fingerprint_json, rows[1]?.fingerprint_json);
    assert.ok(containsPair(result.items, "a-long", "b-long"));
    assert.notEqual(original, changed); assert.equal(f.sql.prepare("SELECT markdown FROM cloud_documents WHERE id='b-long'").get()?.markdown, changed);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM cloud_documents WHERE deleted_at IS NULL").get()?.n, 2);
  } finally { f.sql.close(); }
});
