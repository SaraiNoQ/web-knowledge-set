import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../server/db.js";
import { studyAdapter } from "../shared/study-adapter.js";
import { createStudyStore } from "../shared/study-store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zhiye-study-collections-")), database = openDatabase(join(root, "data")), sql = database.sql;
  let beforeBatch: (() => void) | null = null;
  const adapter = studyAdapter({ documentsTable: "documents",
    async all(query, values) { return sql.prepare(query).all(...values as never[]); },
    async run(query, values) { return Number(sql.prepare(query).run(...values as never[]).changes); },
    async batch(statements) {
      beforeBatch?.(); beforeBatch = null;
      sql.exec("BEGIN IMMEDIATE");
      try { for (const statement of statements) { const query = sql.prepare(statement.sql); if (/^\s*SELECT\b/iu.test(statement.sql)) query.all(...statement.values as never[]); else query.run(...statement.values as never[]); } sql.exec("COMMIT"); }
      catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  });
  const store = createStudyStore(adapter);
  const legacy = () => ({
    collections: sql.prepare("SELECT * FROM collections ORDER BY id").all().map((row) => ({ ...row })),
    members: sql.prepare("SELECT * FROM document_collections ORDER BY collection_id,document_id").all().map((row) => ({ ...row })),
    documents: sql.prepare("SELECT * FROM documents ORDER BY id").all().map((row) => ({ ...row })),
    revisions: sql.prepare("SELECT * FROM document_revisions ORDER BY document_id,revision").all().map((row) => ({ ...row })),
  });
  const collection = database.createCollection("Existing collection").collection;
  const first = database.createArticle("Original source A"), second = database.createArticle("Original source B");
  assert.equal(database.updateDocument(first.id, first.revision, { markdown: "First original text.", collectionIds: [collection.id] }).kind, "updated");
  assert.equal(database.updateDocument(second.id, second.revision, { markdown: "Second original text.", collectionIds: [collection.id] }).kind, "updated");
  return { root, database, sql, store, collection, first, second, legacy,
    race(action: () => void) { beforeBatch = action; },
    close() { database.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("a user can explicitly copy an existing collection into an independent research topic without changing legacy data", async () => {
  const f = fixture();
  try {
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM study_topics").get()?.n, 0);
    const before = f.legacy(), source = (await f.store.sourceCollections()).find((entry) => entry.id === f.collection.id)!;
    assert.equal(source.documents.length, 2); assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM study_topics").get()?.n, 0);
    const copied = await f.store.fromCollection({ collectionId: source.id, updatedAt: source.updatedAt, documents: source.documents.map(({ id, revision }) => ({ id, revision })) });
    assert.notEqual(copied.id, f.collection.id);
    assert.deepEqual([...copied.documentIds].sort(), [f.first.id, f.second.id].sort());
    assert.ok(copied.note.includes("复制")); assert.ok(copied.note.includes(f.collection.name));
    assert.deepEqual(f.legacy(), before);

    const current = f.database.getDocument(f.first.id)!;
    assert.equal(f.database.updateDocument(current.id, current.revision, { collectionIds: [] }).kind, "updated");
    const third = f.database.createArticle("Later collection member");
    assert.equal(f.database.updateDocument(third.id, third.revision, { collectionIds: [f.collection.id] }).kind, "updated");
    f.database.renameCollection(f.collection.id, "Renamed legacy collection");
    const retained = await f.store.topic(copied.id);
    assert.deepEqual([...retained.documentIds].sort(), [f.first.id, f.second.id].sort());
    assert.equal(retained.name, source.name); assert.equal(retained.revision, copied.revision);
    const changedLegacy = f.legacy();
    await f.store.deleteTopic(copied.id, { revision: retained.revision });
    assert.deepEqual(f.legacy(), changedLegacy);
    assert.ok(f.database.getCollection(f.collection.id)); assert.ok(f.database.getDocument(f.first.id));
  } finally { f.close(); }
});

for (const change of ["membership", "revision"] as const) test(`collection-copy scope changes reject the whole copy after preview (${change})`, async () => {
  const f = fixture();
  try {
    const source = (await f.store.sourceCollections()).find((entry) => entry.id === f.collection.id)!;
    let afterConcurrentChange: ReturnType<typeof f.legacy> | undefined;
    f.race(() => {
      const current = f.database.getDocument(f.first.id)!;
      assert.equal(f.database.updateDocument(current.id, current.revision, change === "membership" ? { collectionIds: [] } : { markdown: "Updated after copy preview." }).kind, "updated");
      afterConcurrentChange = f.legacy();
    });
    await assert.rejects(f.store.fromCollection({ collectionId: source.id, updatedAt: source.updatedAt, documents: source.documents.map(({ id, revision }) => ({ id, revision })) }), /REVISION_CONFLICT/u);
    assert.ok(afterConcurrentChange);
    assert.deepEqual(f.legacy(), afterConcurrentChange);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM study_topics").get()?.n, 0);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM study_topic_documents").get()?.n, 0);
  } finally { f.close(); }
});

test("collection copies reject more than 100 members instead of silently taking a prefix", async () => {
  const f = fixture();
  try {
    const stamp = "2026-10-26T00:00:00.000Z";
    f.sql.exec("BEGIN IMMEDIATE");
    try {
      const insert = f.sql.prepare("INSERT INTO documents(id,source_url,title,markdown,status,created_at,updated_at) VALUES(?,?,?,'Overflow original','ready',?,?)"), member = f.sql.prepare("INSERT INTO document_collections VALUES(?,?)");
      for (let index = 0; index < 99; index++) { const id = `overflow-${index}`; insert.run(id, `https://example.com/${id}`, id, stamp, stamp); member.run(id, f.collection.id); }
      f.sql.exec("COMMIT");
    } catch (error) { f.sql.exec("ROLLBACK"); throw error; }
    const source = (await f.store.sourceCollections()).find((entry) => entry.id === f.collection.id)!, before = f.legacy();
    assert.equal(source.documents.length, 101);
    await assert.rejects(f.store.fromCollection({ collectionId: source.id, updatedAt: source.updatedAt, documents: source.documents.map(({ id, revision }) => ({ id, revision })) }), /100/u);
    assert.deepEqual(f.legacy(), before);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM study_topics").get()?.n, 0);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM study_topic_documents").get()?.n, 0);
  } finally { f.close(); }
});
