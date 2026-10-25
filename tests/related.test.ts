import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { READING_DATA_SCHEMA } from "../shared/reading-data.js";
import { CONNECTION_EVIDENCE_SCHEMA, documentSemanticHash, getRelated, retrieveEvidence, setConnectionEvidence } from "../shared/related.js";
import type { StudyAdapter, StudyDocument } from "../shared/study-types.js";

function fixture() {
  const sql = new DatabaseSync(":memory:"); sql.exec("PRAGMA foreign_keys=ON");
  sql.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT,source_url TEXT,markdown TEXT,kind TEXT DEFAULT 'article',status TEXT DEFAULT 'ready',revision INTEGER DEFAULT 3,deleted_at TEXT,folder_id TEXT);
    CREATE TABLE tags(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE document_tags(document_id TEXT,tag_id TEXT);
    CREATE TABLE study_document_tags(document_id TEXT,tag TEXT);
    CREATE TABLE papers(id TEXT,extraction_id TEXT); CREATE TABLE paper_pages(paper_id TEXT,extraction_id TEXT,original_json TEXT);
    CREATE TABLE semantic_indexes(document_id TEXT PRIMARY KEY,source_hash TEXT,model TEXT,format_version TEXT,vector_json TEXT,state TEXT);`);
  sql.exec(READING_DATA_SCHEMA + CONNECTION_EVIDENCE_SCHEMA);
  let beforeBatch: (() => void) | null = null;
  const db: StudyAdapter = { documentsTable: "documents",
    async all(query, values) { return sql.prepare(query).all(...values as never[]); },
    async run(query, values) { return Number(sql.prepare(query).run(...values as never[]).changes); },
    async batch(statements) { beforeBatch?.(); beforeBatch = null; sql.exec("BEGIN IMMEDIATE"); try { for (const statement of statements) sql.prepare(statement.sql).run(...statement.values as never[]); sql.exec("COMMIT"); } catch (error) { sql.exec("ROLLBACK"); throw error; } },
    async document(id) { const row = sql.prepare("SELECT id,title,source_url AS sourceUrl,markdown,kind,revision,deleted_at AS deletedAt,folder_id AS folderId FROM documents WHERE id=?").get(id); if (!row) return null; const tags = sql.prepare("SELECT tag FROM study_document_tags WHERE document_id=? UNION SELECT t.name AS tag FROM tags t JOIN document_tags dt ON dt.tag_id=t.id WHERE dt.document_id=?").all(id, id).map((row) => String(row.tag)); return { ...row, tags } as unknown as StudyDocument; },
  };
  const add = (id: string, text: string, title = id, folderId: string | null = null) => sql.prepare("INSERT INTO documents(id,title,source_url,markdown,folder_id) VALUES(?,?,?,?,?)").run(id, title, `https://example.com/${id}`, text, folderId);
  const index = async (id: string, vector: number[], sourceHash?: string) => sql.prepare("INSERT INTO semantic_indexes VALUES(?,?,?,'semantic-text-v1',?,'ready')").run(id, sourceHash ?? await documentSemanticHash((await db.document(id))!), "model", JSON.stringify(vector));
  return { sql, db, add, index, race(action: () => void) { beforeBatch = action; } };
}

test("related documents report real relation sources and reject stale semantic indexes", async () => {
  const f = fixture();
  try {
    f.add("a", "Graph learning evidence. [Reference](https://example.com/cite).", "Graph", "research");
    f.add("b", "Graph learning is a useful technique.", "Vector neighbor", "research");
    f.add("stale", "Unrelated updated content", "Stale neighbor");
    f.add("tagged", "Independent body", "Shared tag"); f.add("cite", "A cited original paragraph.", "Citation target");
    f.add("inbound", "[Read the original](https://example.com/a)", "Unrelated title");
    f.sql.exec("INSERT INTO tags VALUES('t','Research'); INSERT INTO document_tags VALUES('a','t'),('tagged','t');");
    await f.index("a", [1, 0]); await f.index("b", [1, 0]); await f.index("stale", [1, 0], "0".repeat(64));
    const result = await getRelated(f.db, "a", { limit: 10 });
    assert.equal(result.sourceRevision, 3); assert.equal(result.truncated, false);
    assert.ok(result.items.find((item) => item.document.id === "b")?.reasons.some((reason) => reason.type === "semantic"));
    assert.ok(!result.items.some((item) => item.document.id === "stale"));
    assert.ok(result.items.find((item) => item.document.id === "tagged")?.reasons.some((reason) => reason.type === "tag"));
    assert.ok(result.items.find((item) => item.document.id === "cite")?.reasons.some((reason) => reason.type === "citation"));
    assert.ok(result.items.find((item) => item.document.id === "inbound")?.reasons.some((reason) => reason.type === "citation"));
    for (const item of result.items) { assert.equal(item.document.markdown, ""); for (const evidence of item.evidence) { const doc = await f.db.document(evidence.documentId); assert.ok(doc!.markdown.includes(evidence.anchor.quote)); assert.equal(evidence.documentRevision, doc!.revision); } }
    f.sql.exec("UPDATE documents SET deleted_at='2026-10-26' WHERE id='b'");
    assert.ok(!(await getRelated(f.db, "a")).items.some((item) => item.document.id === "b"));
  } finally { f.sql.close(); }
});

test("related keyset pages can reach documents beyond the first scan budget", async () => {
  const f = fixture();
  try {
    f.add("source", "Only an original passage", "Source", "research");
    for (let index = 0; index < 1005; index++) f.add(`d${String(index).padStart(5, "0")}`, "Independent note", "Document");
    f.add("zz-last", "A remote manual note", "Last document", "research");
    const first = await getRelated(f.db, "source"); assert.equal(first.scannedDocuments, 1000); assert.equal(first.truncated, true); assert.ok(first.nextCursor);
    const second = await getRelated(f.db, "source", { cursor: first.nextCursor! }); assert.ok(second.items.some((item) => item.document.id === "zz-last")); assert.equal(second.truncated, false);
  } finally { f.sql.close(); }
});

test("question retrieval returns source quotes in scope and refuses unmatched questions", async () => {
  const f = fixture();
  try {
    f.add("a", "Quantum effects govern these observations.\n\nAnother paragraph.", "Quantum notes"); f.add("b", "Private outside-scope content.");
    const result = await retrieveEvidence(f.db, "quantum observations", ["a"]); assert.ok(result.length > 0); assert.ok(result.every((entry) => entry.documentId === "a" && entry.documentRevision === 3));
    assert.ok(result.every((entry) => "Quantum effects govern these observations.\n\nAnother paragraph.".includes(entry.anchor.quote)));
    assert.deepEqual(await retrieveEvidence(f.db, "irrelevant astrophysics", ["a"]), []);
    f.add("unicode", "x".repeat(449) + "🙂 quantum evidence.");
    const unicode = await retrieveEvidence(f.db, "quantum", ["unicode"]);
    assert.ok(unicode.length > 0); for (const entry of unicode) assert.equal(new TextDecoder().decode(new TextEncoder().encode(entry.anchor.quote)), entry.anchor.quote);
    f.sql.exec("UPDATE documents SET deleted_at='2026-10-26' WHERE id='a'"); assert.deepEqual(await retrieveEvidence(f.db, "quantum", ["a"]), []);
  } finally { f.sql.close(); }
});

test("connection evidence verifies endpoint ownership, source versions and atomic races", async () => {
  const f = fixture(), stamp = "2026-10-26T00:00:00.000Z";
  try {
    f.add("a", "Original A"); f.add("b", "Original B");
    f.sql.prepare("INSERT INTO document_connections VALUES('c','a','b','supports',1,?,?)").run(stamp, stamp);
    const anchor = JSON.stringify({ quote: "Original B", prefix: "", suffix: "", source: "editor" });
    f.sql.prepare("INSERT INTO reading_annotations VALUES('n','b',3,?,'','',1,?,?)").run(anchor, stamp, stamp);
    await assert.rejects(setConnectionEvidence(f.db, "a", "c", { revision: 1, relationType: "citation", sourceAnnotationId: "n" }), /endpoint/u);
    const saved = await setConnectionEvidence(f.db, "a", "c", { revision: 1, relationType: "citation", targetAnnotationId: "n" }); assert.equal(saved.targetAnnotationId, "n");
    await assert.rejects(setConnectionEvidence(f.db, "a", "c", { revision: 1, relationType: "manual" }), /CONNECTION_CONFLICT/u);
    f.race(() => f.sql.exec("UPDATE documents SET revision=4 WHERE id='b'"));
    await assert.rejects(setConnectionEvidence(f.db, "a", "c", { revision: 2, relationType: "citation", targetAnnotationId: "n" }), /JSON/u);
    assert.equal(f.sql.prepare("SELECT target_annotation_id FROM reading_connection_evidence").get()?.target_annotation_id, "n");
    assert.equal(f.sql.prepare("SELECT revision FROM document_connections").get()?.revision, 2);
  } finally { f.sql.close(); }
});
