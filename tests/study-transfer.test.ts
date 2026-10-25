import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { strToU8, strFromU8, unzipSync, zipSync } from "fflate";
import { openDatabase, CURRENT_SCHEMA_VERSION, type KnowledgeDatabase } from "../server/db.js";
import { createPortableBundle, stagePortableBundle, promotePortableAssets } from "../server/portable.js";
import { importCloudJsonBackup } from "../server/cloud-backup.js";
import { createReadingRepository, annotationColumns, annotationFromRow, connectionColumns, connectionFromRow } from "../shared/reading-data.js";
import { studyAdapter } from "../shared/study-adapter.js";
import { createStudyStore } from "../shared/study-store.js";
import { setConnectionEvidence } from "../shared/related.js";
import { captureStudySnapshot, parseStudySnapshot, studyRestoreStatements } from "../shared/study-snapshot.js";
import type { ReadingAnnotation } from "../shared/reader-tools.js";

function adapter(db: KnowledgeDatabase) {
  return studyAdapter({ documentsTable: "documents", async all(sql, values) { return db.sql.prepare(sql).all(...values as never[]); }, async run(sql, values) { return Number(db.sql.prepare(sql).run(...values as never[]).changes); }, async batch(statements) { db.sql.exec("BEGIN IMMEDIATE"); try { for (const statement of statements) { if (/^\s*SELECT\b/iu.test(statement.sql)) db.sql.prepare(statement.sql).all(...statement.values as never[]); else db.sql.prepare(statement.sql).run(...statement.values as never[]); } db.sql.exec("COMMIT"); } catch (cause) { db.sql.exec("ROLLBACK"); throw cause; } } });
}
function reading(db: KnowledgeDatabase) { return { annotations: db.sql.prepare(`SELECT ${annotationColumns} FROM reading_annotations`).all().map(annotationFromRow), connections: db.sql.prepare(`SELECT ${connectionColumns} FROM document_connections`).all().map(connectionFromRow) }; }
async function seed(db: KnowledgeDatabase) {
  const first = db.createArticle("Alpha research"), second = db.createArticle("Beta research");
  db.updateDocument(first.id, first.revision, { markdown: "Alpha article evidence." }); db.updateDocument(second.id, second.revision, { markdown: "Beta article evidence." });
  const a = adapter(db), store = createStudyStore(a);
  await store.tags(first.id, { revision: db.getDocument(first.id)!.revision, tags: ["Graph"] });
  const merged = await store.merge({ keepId: first.id, sourceId: second.id, keepRevision: db.getDocument(first.id)!.revision, sourceRevision: db.getDocument(second.id)!.revision }); await store.undoMerge(merged.id);
  db.sql.prepare("INSERT INTO study_document_tags VALUES(?,?)").run(second.id, "FromCloud");
  const repo = createReadingRepository(a), notes: ReadingAnnotation[] = [];
  for (const id of [first.id, second.id]) { const doc = db.getDocument(id)!; notes.push(await repo.createAnnotation(id, { revision: doc.revision, anchor: { quote: doc.markdown, prefix: "", suffix: "", source: "preview" }, note: `my note for ${doc.title}` })); }
  const connection = (await repo.connect(first.id, { revision: db.getDocument(first.id)!.revision, targetId: second.id, note: "compare evidence" })).connection;
  await setConnectionEvidence(a, first.id, connection.id, { revision: connection.revision, relationType: "citation", sourceAnnotationId: notes.find((note) => note.documentId === connection.sourceId)!.id, targetAnnotationId: notes.find((note) => note.documentId === connection.targetId)!.id });
  let topic = await store.createTopic({ name: "Research topic" }); topic = await store.updateTopic(topic.id, { revision: topic.revision, annotationId: notes[0]!.id, note: "Confidential comparison with Beta evidence." }); topic = await store.updateTopic(topic.id, { revision: topic.revision, annotationId: notes[1]!.id });
  let empty = await store.createTopic({ name: "Empty topic" }); empty = await store.updateTopic(empty.id, { revision: empty.revision, note: "Standalone confidential note" });
  await store.saveProgress(first.id, { documentRevision: db.getDocument(first.id)!.revision, revision: 0, fraction: .4, anchor: null, read: false }); await store.scheduleReview(notes[0]!.id);
  db.sql.prepare("INSERT INTO study_source_checks VALUES(?,?,?,?,?,?,?)").run(first.id, db.getDocument(first.id)!.revision, db.getDocument(first.id)!.sourceUrl, "unknown", null, new Date().toISOString(), "Local source");
  return { first: db.getDocument(first.id)!, second: db.getDocument(second.id)!, topic, empty, notes, store };
}

test("portable v3 maps research data, preserves existing notes, and round-trips its own IDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-study-transfer-")), source = openDatabase(join(root, "source")), target = openDatabase(join(root, "target")), legacy = openDatabase(join(root, "legacy"));
  try {
    const seeded = await seed(source), bytes = await createPortableBundle(source), files = unzipSync(bytes), manifest = JSON.parse(strFromU8(files["manifest.json"]!));
    assert.equal(manifest.version, 3); assert.equal(manifest.studyData.tables.study_source_checks.length, 0); assert.equal(manifest.studyData.tables.study_merge_history.length, 0); assert.equal(manifest.studyData.tables.study_topics.length, 2);
    const preview = await stagePortableBundle(target, bytes); assert.ok(Number(preview.studyRecords) > 0); assert.deepEqual(promotePortableAssets(target, preview.id), []);
    const applied = target.applyImportBatch(preview.id, "copy")!; assert.equal(applied.counts.created, 2);
    const topics = await createStudyStore(adapter(target)).listTopics(), topic = topics.find((item) => item.name === seeded.topic.name)!;
    assert.equal(topics.length, 2); assert.equal(topic.note, seeded.topic.note); assert.equal(topic.documentIds.length, 2); assert.equal(topic.annotationIds.length, 2);
    assert.ok(topic.documentIds.every((id) => applied.items.some((item) => item.documentId === id))); assert.ok(!topic.documentIds.includes(seeded.first.id));
    assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM study_progress").get()?.n, 1); assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM study_reviews").get()?.n, 1); assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM reading_connection_evidence").get()?.n, 1);
    assert.ok([...target.documentsForPortableExport()].find((document) => document.title === seeded.second.title)?.tags.includes("FromCloud"));
    target.sql.prepare("UPDATE study_topics SET note='local edited synthesis',revision=revision+1 WHERE id=?").run(topic.id);
    const update = await stagePortableBundle(target, bytes); target.applyImportBatch(update.id, "update");
    assert.equal(target.sql.prepare("SELECT note FROM study_topics WHERE id=?").get(topic.id)?.note, "local edited synthesis");
    const own = await stagePortableBundle(target, await createPortableBundle(target)); target.applyImportBatch(own.id, "update");
    assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM study_topics").get()?.n, 2); assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM reading_annotations").get()?.n, 2); assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM reading_connection_evidence").get()?.n, 1);
    assert.deepEqual(target.sql.prepare("PRAGMA foreign_key_check").all(), []);
    const old = { ...manifest, version: 2 }; delete old.studyData; files["manifest.json"] = strToU8(JSON.stringify(old));
    const oldPreview = await stagePortableBundle(legacy, zipSync(files)); legacy.applyImportBatch(oldPreview.id, "copy"); assert.equal(legacy.sql.prepare("SELECT COUNT(*) AS n FROM study_topics").get()?.n, 0); assert.equal(legacy.sql.prepare("SELECT COUNT(*) AS n FROM reading_annotations").get()?.n, 2);
  } finally { source.close(); target.close(); legacy.close(); rmSync(root, { recursive: true, force: true }); }
});

test("selected portable exports redact unselected topic notes and invalid research references fail before writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-study-scope-")), source = openDatabase(join(root, "source")), target = openDatabase(join(root, "target"));
  try {
    const seeded = await seed(source), bytes = await createPortableBundle(source, [seeded.first.id]), files = unzipSync(bytes), manifest = JSON.parse(strFromU8(files["manifest.json"]!));
    assert.equal(manifest.studyData.tables.study_topics.length, 1); assert.equal(manifest.studyData.tables.study_topics[0].note, "");
    assert.ok(!JSON.stringify(manifest).includes(seeded.second.id)); assert.ok(!JSON.stringify(manifest).includes("Standalone confidential note")); assert.ok(!JSON.stringify(manifest).includes("Confidential comparison"));
    const bad = structuredClone(manifest); bad.studyData.tables.study_progress[0].document_id = "missing"; files["manifest.json"] = strToU8(JSON.stringify(bad));
    await assert.rejects(stagePortableBundle(target, zipSync(files)), /Research records/u); assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM documents").get()?.n, 0); assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM import_batches").get()?.n, 0);
    const full = await captureStudySnapshot(adapter(source).all); const snapshot = parseStudySnapshot(full, new Set([seeded.first.id, seeded.second.id]), reading(source));
    source.sql.exec("BEGIN; DELETE FROM study_topics;");
    assert.throws(() => { const broken = structuredClone(snapshot); broken.tables.study_topic_documents[0]!.document_id = "missing"; parseStudySnapshot(broken, new Set([seeded.first.id, seeded.second.id]), reading(source)); });
    source.sql.exec("ROLLBACK"); assert.equal((await seeded.store.listTopics()).length, 2);
    assert.ok(studyRestoreStatements(snapshot).length < 20);
  } finally { source.close(); target.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an empty library can share standalone topic notes without creating fake documents", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-empty-study-")), source = openDatabase(join(root, "source")), target = openDatabase(join(root, "target"));
  try {
    const store = createStudyStore(adapter(source)), topic = await store.createTopic({ name: "Standalone" }); await store.updateTopic(topic.id, { revision: topic.revision, note: "A genuine standalone research note" });
    const bytes = await createPortableBundle(source), preview = await stagePortableBundle(target, bytes); assert.equal(preview.counts.total, 0); assert.ok(Number(preview.studyRecords) > 0); target.applyImportBatch(preview.id, "update");
    assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM documents").get()?.n, 0); assert.equal((await createStudyStore(adapter(target)).listTopics())[0]?.note, "A genuine standalone research note");
  } finally { source.close(); target.close(); rmSync(root, { recursive: true, force: true }); }
});

test("cloud v8 conversion retains research history and evidence, and rejects invalid FK without touching the open library", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-study-cloud-conversion-")), source = openDatabase(join(root, "source")), target = openDatabase(join(root, "target"));
  try {
    const seeded = await seed(source), readingData = reading(source), studyData = parseStudySnapshot(await captureStudySnapshot(adapter(source).all), new Set([seeded.first.id, seeded.second.id]), readingData);
    const now = new Date().toISOString(), archive = { format: "zhiye-cloud-backup", version: 8, createdAt: now, folders: [], documents: [seeded.first, seeded.second].map((document) => ({ id: document.id, source_url: document.sourceUrl, final_url: null, canonical_url: null, title: document.title, author: null, published_at: null, markdown: document.markdown, status: "ready", source_note: "", revision: document.revision, created_at: now, updated_at: now, folder_id: null, deleted_at: null, favorite: 0 })), derivedResults: [], llmSettings: null, assets: [], papers: [], paperExtractions: [], paperPages: [], paperFiles: [], readingData, studyData };
    const imported = await importCloudJsonBackup(target, join(root, "target"), join(root, "backups"), strToU8(JSON.stringify(archive)), CURRENT_SCHEMA_VERSION);
    const copy = new DatabaseSync(join(root, "backups", imported.directoryName!, "database.sqlite3"), { readOnly: true });
    try { assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM study_topics").get()?.n, 2); assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM study_merge_history").get()?.n, 1); assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM study_source_checks").get()?.n, 1); assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM reading_connection_evidence").get()?.n, 1); assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM document_tags dt JOIN tags t ON t.id=dt.tag_id WHERE t.name='FromCloud'").get()?.n, 1); assert.deepEqual(copy.prepare("PRAGMA foreign_key_check").all(), []); } finally { copy.close(); }
    const bad = structuredClone(archive); bad.studyData.tables.study_topic_annotations[0]!.annotation_id = "missing";
    await assert.rejects(importCloudJsonBackup(target, join(root, "target"), join(root, "backups"), strToU8(JSON.stringify(bad)), CURRENT_SCHEMA_VERSION), /research data/u);
    assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM documents").get()?.n, 0); assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM study_topics").get()?.n, 0);
  } finally { source.close(); target.close(); rmSync(root, { recursive: true, force: true }); }
});
