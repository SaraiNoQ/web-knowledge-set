import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { openDatabase, CURRENT_SCHEMA_VERSION } from "../server/db.js";
import { createBackup, verifyBackup } from "../server/backup.js";
import { createPortableBundle, stagePortableBundle } from "../server/portable.js";
import { createDerivedTasks, LlmError } from "../server/llm.js";
import { createReadingRepository, annotationColumns, annotationFromRow, connectionColumns, connectionFromRow } from "../shared/reading-data.js";
import { parseReadingSnapshot, insertAnnotationSql, annotationValues, insertConnectionSql, connectionValues } from "../shared/reading-snapshot.js";
import { consumeCompletionStream, readableChunks } from "../shared/llm-stream.js";
import { parseSelectionTranslation, sourceAnchorRange, type SourceAnchor } from "../shared/reader-tools.js";

const anchor: SourceAnchor = { quote: "selected words", prefix: "before ", suffix: " after", source: "preview" };
const stamp = "2026-10-25T00:00:00.000Z";
function fixture(table: "documents" | "cloud_documents") {
  const sql = new DatabaseSync(":memory:"); sql.exec("PRAGMA foreign_keys=ON");
  sql.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, title TEXT, kind TEXT, revision INTEGER, deleted_at TEXT)`);
  sql.exec(readFileSync(new URL("../cloud/migrations/0013_reading_data.sql", import.meta.url), "utf8").replaceAll("cloud_documents", table));
  for (const id of ["a", "b"]) sql.prepare(`INSERT INTO ${table} VALUES (?, ?, 'article', 3, NULL)`).run(id, id);
  let beforeRun: (() => void) | null = null;
  const repo = createReadingRepository({ documentsTable: table,
    async all(query, values) { return sql.prepare(query).all(...values as never[]); },
    async run(query, values) { beforeRun?.(); beforeRun = null; return Number(sql.prepare(query).run(...values as never[]).changes); },
    async document(id) { return sql.prepare(`SELECT id, revision, deleted_at AS deletedAt FROM ${table} WHERE id=?`).get(id) as { id: string; revision: number; deletedAt: string | null } ?? null; },
  });
  return { sql, repo, race(action: () => void) { beforeRun = action; } };
}
for (const table of ["documents", "cloud_documents"] as const) test(`reading data CAS, trash, recovery and archive validation (${table})`, async () => {
  const { sql, repo, race } = fixture(table);
  try {
    await assert.rejects(repo.createAnnotation("a", { anchor }), /Invalid/u);
    await assert.rejects(repo.connect("a", { targetId: "b" }), /Invalid/u);
    await assert.rejects(repo.createAnnotation("a", { revision: 2, anchor }), /REVISION_CONFLICT/u);
    const note = await repo.createAnnotation("a", { revision: 3, anchor, note: "evidence", translation: "选中文字" });
    const link = await repo.connect("a", { revision: 3, targetId: "b", note: "supports" });
    assert.equal((await repo.connect("b", { revision: 3, targetId: "a", note: "duplicate" })).created, false);
    assert.equal((await repo.list("b")).connections[0]?.peer.id, "a");
    const archived = parseReadingSnapshot({ annotations: (await repo.list("a")).annotations, connections: [link.connection] }, new Set(["a", "b"]));
    assert.throws(() => parseReadingSnapshot(archived, new Set(["a"])), /Missing/u);
    assert.throws(() => parseReadingSnapshot({ ...archived, annotations: [note, note] }, new Set(["a", "b"])), /Duplicate/u);
    race(() => sql.prepare(`UPDATE ${table} SET deleted_at=? WHERE id='a'`).run(stamp));
    await assert.rejects(repo.deleteAnnotation("a", note.id, { revision: 1 }), /ANNOTATION_CONFLICT/u);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM reading_annotations").get()?.n, 1);
    assert.equal((await repo.list("b")).connections.length, 0);
    sql.prepare(`UPDATE ${table} SET deleted_at=NULL WHERE id='a'`).run();
    assert.equal((await repo.list("b")).connections.length, 1);
    const updated = await repo.updateAnnotation("a", note.id, { revision: 1, note: "updated" });
    await assert.rejects(repo.updateAnnotation("a", note.id, { revision: 1, note: "stale" }), /ANNOTATION_CONFLICT/u);
    assert.equal(updated.revision, 2);
    // Execute the proposed restore order in a transaction before wiring it to any restore route.
    const snapshot = parseReadingSnapshot({ annotations: [updated], connections: [link.connection] }, new Set(["a", "b"]));
    sql.exec("BEGIN; DELETE FROM reading_annotations; DELETE FROM document_connections;");
    for (const row of snapshot.annotations) sql.prepare(insertAnnotationSql).run(...annotationValues(row));
    for (const row of snapshot.connections) sql.prepare(insertConnectionSql).run(...connectionValues(row));
    sql.exec("COMMIT");
    assert.deepEqual(sql.prepare(`SELECT ${annotationColumns} FROM reading_annotations`).all().map(annotationFromRow), snapshot.annotations);
    assert.deepEqual(sql.prepare(`SELECT ${connectionColumns} FROM document_connections`).all().map(connectionFromRow), snapshot.connections);
    sql.exec("BEGIN; DELETE FROM reading_annotations; DELETE FROM document_connections;");
    assert.throws(() => sql.prepare(insertConnectionSql).run(...connectionValues({ ...link.connection, targetId: "missing" })), /FOREIGN KEY/u);
    sql.exec("ROLLBACK");
    assert.equal((await repo.list("a")).annotations[0]?.note, "updated");
    sql.prepare(`DELETE FROM ${table} WHERE id='a'`).run();
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM reading_annotations").get()?.n, 0);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM document_connections").get()?.n, 0);
  } finally { sql.close(); }
});

test("reading schema upgrades existing libraries and full SQLite backups preserve records", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-reader-backup-")), dataDir = join(root, "data");
  let db = openDatabase(dataDir);
  try {
    const doc = db.createOrGetDocument("https://example.com/reader-backup").document;
    db.sql.exec("PRAGMA foreign_keys=OFF; DROP TABLE semantic_ann; DROP TABLE reading_connection_evidence; DROP TABLE study_topic_annotations; DROP TABLE study_topic_documents; DROP TABLE study_topics; DROP TABLE study_progress; DROP TABLE study_reviews; DROP TABLE study_document_tags; DROP TABLE study_source_checks; DROP TABLE study_merge_history; DROP TABLE study_fingerprints; DROP TABLE document_connections; DROP TABLE reading_annotations; PRAGMA foreign_keys=ON;");
    db.sql.prepare("DELETE FROM schema_migrations WHERE version>=?").run(20);
    db.close(); db = openDatabase(dataDir);
    assert.equal(db.getDocument(doc.id)?.sourceUrl, doc.sourceUrl);
    const row = { id: "excerpt", documentId: doc.id, sourceRevision: doc.revision, anchor, note: "retain", translation: "译文", revision: 1, createdAt: stamp, updatedAt: stamp };
    db.sql.prepare(insertAnnotationSql).run(...annotationValues(row));
    const backup = await createBackup({ dataDir, backupRoot: join(root, "backups"), database: db.sql });
    await verifyBackup(backup.path);
    const copy = new DatabaseSync(join(backup.path, "database.sqlite3"));
    try { assert.deepEqual(copy.prepare(`SELECT ${annotationColumns} FROM reading_annotations`).all().map(annotationFromRow), [row]); assert.deepEqual(copy.prepare("PRAGMA foreign_key_check").all(), []); } finally { copy.close(); }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("selection boundaries and source anchor normalization reject ambiguous references", () => {
  assert.throws(() => parseSelectionTranslation({ text: "x", language: "zh-CN", revision: 1, settingsRevision: 0, wholeDocument: "secret" }));
  assert.throws(() => parseSelectionTranslation({ text: "x".repeat(6001), language: "zh-CN", revision: 1, settingsRevision: 0 }));
  assert.deepEqual(sourceAnchorRange("before selected\n words after", anchor), { from: 7, to: 22 });
  assert.equal(sourceAnchorRange("selected words selected words", { ...anchor, prefix: "", suffix: "" }), null);
});

test("portable reading records map document IDs atomically, retry without duplication, and retain existing notes", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-reader-portable-"));
  const source = openDatabase(join(root, "source")), target = openDatabase(join(root, "target")), trashed = openDatabase(join(root, "trashed"));
  try {
    const first = source.createArticle("Source A"), second = source.createArticle("Source B");
    const row = { id: "excerpt", documentId: first.id, sourceRevision: first.revision, anchor, note: "retain", translation: "译文", revision: 1, createdAt: stamp, updatedAt: stamp };
    const edge = { id: "connection", sourceId: [first.id, second.id].sort()[0]!, targetId: [first.id, second.id].sort()[1]!, note: "supports", revision: 1, createdAt: stamp, updatedAt: stamp };
    source.sql.prepare(insertAnnotationSql).run(...annotationValues(row)); source.sql.prepare(insertConnectionSql).run(...connectionValues(edge));
    const self = await stagePortableBundle(source, await createPortableBundle(source, [first.id, second.id])); source.applyImportBatch(self.id, "update");
    assert.equal(source.sql.prepare("SELECT COUNT(*) AS n FROM reading_annotations").get()?.n, 1);
    assert.equal(source.sql.prepare("SELECT COUNT(*) AS n FROM document_connections").get()?.n, 1);
    const bytes = await createPortableBundle(source, [first.id, second.id]);
    const peerOnly = await stagePortableBundle(trashed, await createPortableBundle(source, [second.id]));
    const peerImport = trashed.applyImportBatch(peerOnly.id, "copy")!;
    const pending = await stagePortableBundle(trashed, bytes);
    trashed.sql.prepare("UPDATE documents SET deleted_at=?, revision=revision+1 WHERE id=?").run(stamp, peerImport.items[0]!.documentId!);
    assert.throws(() => trashed.applyImportBatch(pending.id, "skip"), /回收站/u);
    assert.equal(trashed.sql.prepare("SELECT COUNT(*) AS n FROM documents").get()?.n, 1);
    assert.equal(trashed.sql.prepare("SELECT status FROM import_batches WHERE id=?").get(pending.id)?.status, "preview");
    const preview = await stagePortableBundle(target, bytes);
    target.sql.exec("CREATE TRIGGER reject_reading BEFORE INSERT ON reading_annotations BEGIN SELECT RAISE(ABORT, 'injected reading failure'); END");
    assert.throws(() => target.applyImportBatch(preview.id, "copy"), /injected reading failure/u);
    assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM documents").get()?.n, 0);
    assert.equal(target.sql.prepare("SELECT status FROM import_batches WHERE id=?").get(preview.id)?.status, "preview");
    assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM import_items WHERE result_status IS NOT NULL").get()?.n, 0);
    target.sql.exec("DROP TRIGGER reject_reading");
    const imported = target.applyImportBatch(preview.id, "copy")!;
    assert.equal(imported.counts.created, 2);
    const notes = target.sql.prepare(`SELECT ${annotationColumns} FROM reading_annotations`).all().map(annotationFromRow);
    const links = target.sql.prepare(`SELECT ${connectionColumns} FROM document_connections`).all().map(connectionFromRow);
    assert.equal(notes.length, 1); assert.equal(notes[0]?.note, "retain"); assert.notEqual(notes[0]?.documentId, first.id);
    assert.equal(links.length, 1); assert.ok(imported.items.some((item) => item.documentId === links[0]?.sourceId)); assert.ok(imported.items.some((item) => item.documentId === links[0]?.targetId));
    target.applyImportBatch(preview.id, "copy");
    const again = await stagePortableBundle(target, bytes); target.applyImportBatch(again.id, "update");
    const roundTrip = await stagePortableBundle(target, await createPortableBundle(target)); target.applyImportBatch(roundTrip.id, "update");
    assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM reading_annotations").get()?.n, 1);
    assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM document_connections").get()?.n, 1);
    const subset = await createPortableBundle(source, [first.id]);
    const isolated = await stagePortableBundle(target, subset); target.applyImportBatch(isolated.id, "copy");
    assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM document_connections").get()?.n, 1);
  } finally { source.close(); target.close(); trashed.close(); rmSync(root, { recursive: true, force: true }); }
});

const event = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
async function* pieces(text: string) { const bytes = new TextEncoder().encode(text); for (const byte of bytes) yield new Uint8Array([byte]); }
test("streaming completion handles split UTF-8, redacts split secrets, and rejects truncated output", async () => {
  const signal = new AbortController().signal;
  let output = "";
  assert.equal(await consumeCompletionStream(pieces(event("你好🙂") + "data: [DONE]\n\n"), "", (text) => { output += text; }, signal), "你好🙂");
  assert.equal(output, "你好🙂"); output = "";
  await assert.rejects(consumeCompletionStream(pieces(event("safe sec") + event("ret-key") + "data: [DONE]\n\n"), "secret-key", (text) => { output += text; }, signal), /LLM_SECRET_ECHO/u);
  assert.ok(!output.includes("secret-key"));
  await assert.rejects(consumeCompletionStream(pieces(event("partial")), "", () => {}, signal), /LLM_INVALID_RESPONSE/u);
  await assert.rejects(consumeCompletionStream(pieces(event("partial") + 'data: {"choices":[{"finish_reason":"length"}]}\n'), "", () => {}, signal), /LLM_RESPONSE_TOO_LARGE/u);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(consumeCompletionStream(pieces(event("aborted")), "", () => {}, controller.signal), { name: "AbortError" });
});
test("DONE finishes without waiting for an open upstream connection and cancels its reader", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(event("finished") + "data: [DONE]\n\n")); }, cancel() { cancelled = true; } });
  assert.equal(await consumeCompletionStream(readableChunks(stream), "", () => {}, AbortSignal.timeout(1000)), "finished");
  assert.equal(cancelled, true);
});

test("local selected-text translation uses only the selection and rejects incomplete JSON fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-reader-llm-")), db = openDatabase(join(root, "data"));
  const requests: string[] = [];
  let finish = "length";
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); requests.push(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ choices: [{ message: { content: "selected translation" }, finish_reason: finish }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); assert.ok(address && typeof address !== "string");
  const doc = db.createArticle("secret title"); db.updateDocument(doc.id, doc.revision, { markdown: "whole-document-secret" });
  const revision = db.getDocument(doc.id)!.revision;
  db.setLlmSettings({ enabled: true, target: "local", remote: { endpointUrl: "", model: "" }, local: { endpointUrl: `http://127.0.0.1:${address.port}/v1`, model: "test", trusted: true } }, db.getLlmSettings().revision);
  const tasks = createDerivedTasks({ database: () => db });
  const input = { text: "selected words", language: "zh-CN" as const, revision, settingsRevision: db.getLlmSettings().revision };
  let output = "";
  try {
    await assert.rejects(tasks.translateSelection(doc.id, input, (text) => { output += text; }, new AbortController().signal, () => true), (error) => error instanceof LlmError && error.code === "LLM_RESPONSE_TOO_LARGE");
    assert.equal(output, ""); finish = "stop";
    await tasks.translateSelection(doc.id, input, (text) => { output += text; }, new AbortController().signal, () => true);
    assert.equal(output, "selected translation");
    for (const text of requests) { const body = JSON.parse(text); assert.equal(body.stream, true); assert.equal(body.messages[1].content, "selected words"); assert.ok(!text.includes("whole-document-secret")); assert.ok(!text.includes("secret title")); }
    await assert.rejects(tasks.translateSelection(doc.id, { ...input, revision: revision - 1 }, () => {}, new AbortController().signal, () => true), (error) => error instanceof LlmError && error.code === "REVISION_CONFLICT");
    assert.equal(requests.length, 2);
  } finally { await tasks.stop(); provider.closeAllConnections(); await new Promise<void>((resolve) => provider.close(() => resolve())); db.close(); rmSync(root, { recursive: true, force: true }); }
});
