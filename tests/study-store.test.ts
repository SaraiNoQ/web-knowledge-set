import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { READING_DATA_SCHEMA } from "../shared/reading-data.js";
import { CONNECTION_EVIDENCE_SCHEMA } from "../shared/related.js";
import { createStudyStore, STUDY_SCHEMA } from "../shared/study-store.js";
import type { StudyAdapter, StudyDocument } from "../shared/study-types.js";

const stamp = "2026-10-26T00:00:00.000Z";
function fixture(documentsTable: StudyAdapter["documentsTable"]) {
  const sql = new DatabaseSync(":memory:"); sql.exec("PRAGMA foreign_keys=ON");
  sql.exec(`CREATE TABLE ${documentsTable}(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'article',source_url TEXT NOT NULL,markdown TEXT NOT NULL,${documentsTable === "documents" ? "markdown_edited INTEGER NOT NULL DEFAULT 0," : ""}folder_id TEXT,deleted_at TEXT,status TEXT NOT NULL DEFAULT 'ready',revision INTEGER NOT NULL DEFAULT 3,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  sql.exec(`CREATE TABLE ${documentsTable === "documents" ? "papers" : "cloud_papers"}(id TEXT PRIMARY KEY REFERENCES ${documentsTable}(id) ON DELETE CASCADE,status TEXT NOT NULL);`);
  if (documentsTable === "documents") sql.exec("CREATE TABLE tags(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL COLLATE NOCASE UNIQUE); CREATE TABLE document_tags(document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,tag_id INTEGER NOT NULL REFERENCES tags(id),PRIMARY KEY(document_id,tag_id));");
  sql.exec((READING_DATA_SCHEMA + CONNECTION_EVIDENCE_SCHEMA + STUDY_SCHEMA).replaceAll("REFERENCES documents(", `REFERENCES ${documentsTable}(`));
  const index = documentsTable === "documents" ? "semantic_indexes" : "cloud_semantic_indexes";
  sql.exec(`CREATE TABLE ${index}(document_id TEXT PRIMARY KEY REFERENCES ${documentsTable}(id) ON DELETE CASCADE);`);
  let beforeBatch: (() => void) | undefined, failOn: RegExp | null = null;
  const adapter: StudyAdapter = {
    documentsTable,
    async all(query, values) { return sql.prepare(query).all(...values as never[]); },
    async run(query, values) { return Number(sql.prepare(query).run(...values as never[]).changes); },
    async batch(statements) {
      beforeBatch?.(); beforeBatch = undefined;
      sql.exec("BEGIN IMMEDIATE");
      try { for (const statement of statements) { if (failOn?.test(statement.sql)) throw new Error("injected mutation failure"); if (/^\s*SELECT\b/iu.test(statement.sql)) sql.prepare(statement.sql).all(...statement.values as never[]); else sql.prepare(statement.sql).run(...statement.values as never[]); } sql.exec("COMMIT"); }
      catch (cause) { sql.exec("ROLLBACK"); throw cause; }
    },
    async document(id) {
      const row = sql.prepare(`SELECT id,title,kind,source_url AS sourceUrl,markdown,folder_id AS folderId,deleted_at AS deletedAt,revision FROM ${documentsTable} WHERE id=?`).get(id);
      return row ? { ...row, ...(documentsTable === "documents" ? { markdownEdited: sql.prepare(`SELECT markdown_edited FROM ${documentsTable} WHERE id=?`).get(id)?.markdown_edited === 1 } : {}), tags: sql.prepare("SELECT tag FROM study_document_tags WHERE document_id=? ORDER BY tag").all(id).map((item) => String(item.tag)) } as unknown as StudyDocument : null;
    },
  };
  const add = (id: string, markdown = `Original paragraph for ${id}.`) => sql.prepare(`INSERT INTO ${documentsTable}(id,title,source_url,markdown,created_at,updated_at) VALUES(?,?,?,?,?,?)`).run(id, `Title ${id}`, `https://example.com/${id}`, markdown, stamp, stamp);
  const annotate = (id: string, documentId: string) => sql.prepare("INSERT INTO reading_annotations VALUES(?,?,3,?,'retained note','retained translation',1,?,?)").run(id, documentId, JSON.stringify({ quote: `Original paragraph for ${documentId}.`, prefix: "", suffix: "", source: "preview" }), stamp, stamp);
  add("a"); add("b"); annotate("note-a", "a"); annotate("note-b", "b");
  return { sql, store: createStudyStore(adapter), add, annotate, race(action: () => void) { beforeBatch = action; }, fail(pattern: RegExp | null) { failOn = pattern; } };
}

for (const table of ["documents", "cloud_documents"] as const) {
  test(`study topics enforce CAS and keep linked excerpts through trash and restore (${table})`, async () => {
    const f = fixture(table);
    try {
      const empty = await f.store.createTopic({ name: "Evidence topic" });
      const first = await f.store.updateTopic(empty.id, { revision: empty.revision, documentId: "a", note: "my synthesis" });
      await assert.rejects(f.store.updateTopic(empty.id, { revision: empty.revision, note: "stale overwrite" }), /REVISION_CONFLICT/u);
      assert.equal((await f.store.topic(empty.id)).note, "my synthesis");
      const linked = await f.store.updateTopic(first.id, { revision: first.revision, annotationId: "note-b" });
      assert.deepEqual(linked.documentIds.sort(), ["a", "b"]); assert.deepEqual(linked.annotationIds, ["note-b"]);
      f.sql.prepare(`UPDATE ${table} SET deleted_at=? WHERE id='b'`).run(stamp);
      const hidden = await f.store.topic(first.id); assert.deepEqual(hidden.documentIds, ["a"]); assert.equal(hidden.annotations.length, 0);
      assert.equal((await f.store.listTopics())[0]?.annotationIds.length, 0);
      assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM study_topic_annotations").get()?.n, 1);
      f.sql.exec(`UPDATE ${table} SET deleted_at=NULL WHERE id='b'`);
      assert.equal((await f.store.topic(first.id)).annotations[0]?.note, "retained note");
      await assert.rejects(f.store.updateTopic(first.id, { revision: linked.revision, annotationId: "missing" }), /ANNOTATION_NOT_FOUND/u);
      f.race(() => f.sql.prepare("UPDATE study_topics SET revision=revision+1,note='concurrent' WHERE id=?").run(first.id));
      await assert.rejects(f.store.updateTopic(first.id, { revision: linked.revision, note: "late note" }), /REVISION_CONFLICT/u);
      assert.equal((await f.store.topic(first.id)).note, "concurrent");
      assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { f.sql.close(); }
  });

  test(`topic limits also cover excerpt-added documents and concurrent membership changes (${table})`, async () => {
    const f = fixture(table);
    try {
      const topic = await f.store.createTopic({ name: "Bounded topic" });
      for (let index = 0; index < 100; index++) { const id = `member-${index}`; f.add(id); f.sql.prepare("INSERT INTO study_topic_documents VALUES(?,?)").run(topic.id, id); }
      await assert.rejects(f.store.updateTopic(topic.id, { revision: topic.revision, annotationId: "note-a" }));
      assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM study_topic_documents WHERE topic_id=?").get(topic.id)?.n, 100);
      assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM study_topic_annotations WHERE topic_id=?").get(topic.id)?.n, 0);
      f.sql.prepare("DELETE FROM study_topic_documents WHERE topic_id=? AND document_id='member-99'").run(topic.id);
      f.race(() => f.sql.prepare("INSERT INTO study_topic_documents VALUES(?,?)").run(topic.id, "member-99"));
      await assert.rejects(f.store.updateTopic(topic.id, { revision: topic.revision, annotationId: "note-a" }));
      assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM study_topic_documents WHERE topic_id=?").get(topic.id)?.n, 100);
      const notes = await f.store.createTopic({ name: "Bounded excerpts" });
      f.sql.prepare("INSERT INTO study_topic_documents VALUES(?,?)").run(notes.id, "a");
      for (let index = 0; index < 200; index++) { const id = `many-${index}`; f.annotate(id, "a"); f.sql.prepare("INSERT INTO study_topic_annotations VALUES(?,?)").run(notes.id, id); }
      await assert.rejects(f.store.updateTopic(notes.id, { revision: notes.revision, annotationId: "note-a" }));
      assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM study_topic_annotations WHERE topic_id=?").get(notes.id)?.n, 200);
      assert.equal((await f.store.topic(notes.id)).revision, notes.revision);
    } finally { f.sql.close(); }
  });

  test(`reading progress has its own CAS and unread filtering never erases saved records (${table})`, async () => {
    const f = fixture(table);
    try {
      assert.equal(await f.store.progress("a"), null);
      const saved = await f.store.saveProgress("a", { documentRevision: 3, revision: 0, fraction: .6, anchor: null, read: false });
      assert.equal(saved?.revision, 1); assert.equal(saved?.fraction, .6);
      await assert.rejects(f.store.saveProgress("a", { documentRevision: 3, revision: 0, fraction: .1, anchor: null, read: true }), /REVISION_CONFLICT/u);
      await assert.rejects(f.store.saveProgress("a", { documentRevision: 2, revision: 1, fraction: .1, anchor: null, read: true }), /REVISION_CONFLICT/u);
      const read = await f.store.saveProgress("a", { documentRevision: 3, revision: 1, fraction: .6, anchor: null, read: true });
      assert.equal(read?.read, true); assert.ok(!(await f.store.documents({ unread: true })).items.some((item) => item.id === "a"));
      await f.store.saveProgress("a", { documentRevision: 3, revision: 2, fraction: .6, anchor: null, read: false });
      assert.ok((await f.store.documents({ unread: true })).items.some((item) => item.id === "a"));
      f.sql.prepare(`UPDATE ${table} SET deleted_at=? WHERE id='a'`).run(stamp);
      await assert.rejects(f.store.saveProgress("a", { documentRevision: 3, revision: 3, fraction: 1, anchor: null, read: true }), /DOCUMENT_NOT_FOUND/u);
      assert.equal(f.sql.prepare("SELECT fraction FROM study_progress WHERE document_id='a'").get()?.fraction, .6);
    } finally { f.sql.close(); }
  });

  test(`theme tags reject old document versions and clearing them has one authoritative source (${table})`, async () => {
    const f = fixture(table);
    try {
      if (table === "documents") f.sql.exec("INSERT INTO tags(name) VALUES('Legacy'); INSERT INTO document_tags SELECT 'a',id FROM tags WHERE name='Legacy';");
      else f.sql.exec("INSERT INTO study_document_tags VALUES('a','Legacy');");
      await f.store.tags("a", { revision: 3, tags: ["Graph", "Research"] });
      await assert.rejects(f.store.tags("a", { revision: 3, tags: ["old window"] }), /REVISION_CONFLICT/u);
      assert.deepEqual((await f.store.documents()).items.find((item) => item.id === "a")?.tags.sort(), ["Graph", "Research"]);
      await f.store.tags("a", { revision: 4, tags: [] });
      assert.deepEqual((await f.store.documents()).items.find((item) => item.id === "a")?.tags, []);
      assert.equal(f.sql.prepare(`SELECT revision FROM ${table} WHERE id='a'`).get()?.revision, 5);
    } finally { f.sql.close(); }
  });

  test(`review scheduling preserves excerpts and refuses stale grades or trashed sources (${table})`, async () => {
    const f = fixture(table);
    try {
      assert.equal((await f.store.reviews()).length, 0);
      assert.equal((await f.store.reviews(true)).filter((item) => item.dueAt === null).length, 2);
      await f.store.scheduleReview("note-a");
      const due = (await f.store.reviews())[0]!; assert.equal(due.annotation.id, "note-a"); assert.equal(due.revision, 1);
      const before = Date.now(); await f.store.gradeReview("note-a", { revision: 1, grade: "good" });
      const good = (await f.store.reviews(true)).find((item) => item.annotation.id === "note-a")!;
      assert.ok(good.intervalDays >= 1); assert.ok(Date.parse(good.dueAt!) > before); assert.equal(good.repetitions, 1);
      await assert.rejects(f.store.gradeReview("note-a", { revision: 1, grade: "easy" }), /REVISION_CONFLICT/u);
      await f.store.gradeReview("note-a", { revision: good.revision, grade: "again" });
      const again = (await f.store.reviews(true)).find((item) => item.annotation.id === "note-a")!;
      assert.equal(again.intervalDays, 0); assert.equal(again.repetitions, 2); assert.ok(Date.parse(again.dueAt!) > before && Date.parse(again.dueAt!) < Date.now() + 3600000);
      f.sql.prepare(`UPDATE ${table} SET deleted_at=? WHERE id='a'`).run(stamp);
      assert.ok(!(await f.store.reviews(true)).some((item) => item.annotation.id === "note-a"));
      await assert.rejects(f.store.gradeReview("note-a", { revision: again.revision, grade: "good" }), /DOCUMENT_NOT_FOUND/u);
      assert.equal(f.sql.prepare("SELECT note FROM reading_annotations WHERE id='note-a'").get()?.note, "retained note");
    } finally { f.sql.close(); }
  });

  test(`manual merge keeps originals and annotations, supports undo, and rolls back atomically (${table})`, async () => {
    const f = fixture(table);
    try {
      f.race(() => f.sql.exec(`UPDATE ${table} SET status='fetching' WHERE id='b'`));
      await assert.rejects(f.store.merge({ keepId: "a", sourceId: "b", keepRevision: 3, sourceRevision: 3 }), /REVISION_CONFLICT/u);
      assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM study_merge_history").get()?.n, 0);
      f.sql.exec(`UPDATE ${table} SET status='ready' WHERE id='b'`);
      f.sql.prepare(`INSERT INTO ${table === "documents" ? "semantic_indexes" : "cloud_semantic_indexes"} VALUES(?)`).run("a");
      f.fail(new RegExp(`UPDATE ${table} SET deleted_at`, "u"));
      await assert.rejects(f.store.merge({ keepId: "a", sourceId: "b", keepRevision: 3, sourceRevision: 3 }), /injected mutation failure/u);
      assert.equal(f.sql.prepare(`SELECT markdown FROM ${table} WHERE id='a'`).get()?.markdown, "Original paragraph for a.");
      assert.equal(f.sql.prepare(`SELECT deleted_at FROM ${table} WHERE id='b'`).get()?.deleted_at, null);
      assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM study_merge_history").get()?.n, 0);
      f.fail(null);
      const merged = await f.store.merge({ keepId: "a", sourceId: "b", keepRevision: 3, sourceRevision: 3 });
      const kept = f.sql.prepare(`SELECT * FROM ${table} WHERE id='a'`).get()!, source = f.sql.prepare(`SELECT * FROM ${table} WHERE id='b'`).get()!;
      if (table === "documents") assert.equal(kept.markdown_edited, 1);
      assert.ok(String(kept.markdown).includes("Original paragraph for a.")); assert.ok(String(kept.markdown).includes("Original paragraph for b.")); assert.ok(String(kept.markdown).includes("https://example.com/b"));
      assert.equal(source.markdown, "Original paragraph for b."); assert.ok(source.deleted_at); assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM reading_annotations").get()?.n, 2);
      const snapshots = f.sql.prepare("SELECT before_keep_json,before_source_json FROM study_merge_history WHERE id=?").get(merged.id)!;
      assert.equal(JSON.parse(String(snapshots.before_keep_json)).markdown, "Original paragraph for a."); assert.equal(JSON.parse(String(snapshots.before_source_json)).markdown, "Original paragraph for b.");
      await f.store.undoMerge(merged.id);
      if (table === "documents") assert.equal(f.sql.prepare("SELECT markdown_edited FROM documents WHERE id='a'").get()?.markdown_edited, 0);
      assert.equal(f.sql.prepare(`SELECT markdown FROM ${table} WHERE id='a'`).get()?.markdown, "Original paragraph for a."); assert.equal(f.sql.prepare(`SELECT deleted_at FROM ${table} WHERE id='b'`).get()?.deleted_at, null);
      assert.equal((await f.store.mergeHistory())[0]?.undone, true); await assert.rejects(f.store.undoMerge(merged.id), /REVISION_CONFLICT/u);
      const second = await f.store.merge({ keepId: "a", sourceId: "b", keepRevision: 5, sourceRevision: 5 });
      f.sql.exec(`UPDATE ${table} SET markdown=markdown||' later edit',revision=revision+1 WHERE id='a'`);
      await assert.rejects(f.store.undoMerge(second.id), /REVISION_CONFLICT/u);
      assert.ok(String(f.sql.prepare(`SELECT markdown FROM ${table} WHERE id='a'`).get()?.markdown).endsWith(" later edit"));
      assert.ok(f.sql.prepare(`SELECT deleted_at FROM ${table} WHERE id='b'`).get()?.deleted_at);
      assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { f.sql.close(); }
  });

  test(`merge rejects a history row beyond the backup budget before changing originals (${table})`, async () => {
    const f=fixture(table),body='"'.repeat(250000);
    try {
      f.sql.prepare(`UPDATE ${table} SET markdown=?`).run(body);
      await assert.rejects(f.store.merge({keepId:"a",sourceId:"b",keepRevision:3,sourceRevision:3}),/可完整备份/u);
      assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM study_merge_history").get()?.n,0);
      for(const id of ["a","b"]){const row=f.sql.prepare(`SELECT markdown,revision,deleted_at FROM ${table} WHERE id=?`).get(id)!;assert.equal(row.markdown,body);assert.equal(row.revision,3);assert.equal(row.deleted_at,null);}
    } finally {f.sql.close();}
  });

  test(`paper merge archives the duplicate without rewriting either original (${table})`, async () => {
    const f = fixture(table);
    try {
      f.sql.exec(`UPDATE ${table} SET kind='paper'`);
      f.sql.exec(`INSERT INTO ${table === "documents" ? "papers" : "cloud_papers"} VALUES('a','ready'),('b','ready')`);
      const merged = await f.store.merge({ keepId: "a", sourceId: "b", keepRevision: 3, sourceRevision: 3 });
      assert.equal(f.sql.prepare(`SELECT markdown FROM ${table} WHERE id='a'`).get()?.markdown, "Original paragraph for a.");
      assert.equal(f.sql.prepare(`SELECT markdown FROM ${table} WHERE id='b'`).get()?.markdown, "Original paragraph for b.");
      assert.ok(f.sql.prepare(`SELECT deleted_at FROM ${table} WHERE id='b'`).get()?.deleted_at);
      await f.store.undoMerge(merged.id);
      assert.equal(f.sql.prepare(`SELECT deleted_at FROM ${table} WHERE id='b'`).get()?.deleted_at, null);
      assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM reading_annotations").get()?.n, 2);
    } finally { f.sql.close(); }
  });
}
