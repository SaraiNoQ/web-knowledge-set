import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "../server/db.js";
import { localHome, localHomeCover, uploadHomeCover } from "../server/home.js";
import { handleHome } from "../cloud/home.js";
import type { D1Database, D1Result, D1Statement } from "../cloud/extension.js";
import type { R2Bucket } from "../cloud/backup.js";
import { createHomeRepository, HOME_SCHEMA, HOME_MAX_IMAGE_BYTES, homePresentation, parseHomeSnapshot, validateCover, type HomePage, type HomePresentation } from "../shared/home.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGN4dmnVfwAIZgNiqZBFKAAAAABJRU5ErkJggg==", "base64");
const url = (query = "") => new URL(`http://localhost/api/home${query}`);
const presentation = (documentId: string, position = 0, extra: Partial<HomePresentation> = {}): HomePresentation => ({ documentId, featured: true, position, coverHash: null, color: "sage", shortTitle: "", fit: "contain", ...extra });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-home-")), db = openDatabase(directory);
  return { db, repo: localHome(db, () => {}), close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("home folders include only selected articles and follow folder moves, trash and restoration", async () => {
  const f = fixture();
  try {
    const first = f.db.createArticle("精选文章"), hidden = f.db.createArticle("不展示"), unfiled = f.db.createArticle("未分组精选");
    const folder = f.db.createFolder("研究").folder!, emptyFolder = f.db.createFolder("空分类").folder!;
    f.db.updateDocument(first.id, first.revision, { folderId: folder.id });
    f.db.updateDocument(hidden.id, hidden.revision, { folderId: emptyFolder.id });
    await f.repo.save({ revision: 1, changes: [presentation(first.id), presentation(unfiled.id, 1), presentation(hidden.id, 2, { featured: false })] });
    assert.deepEqual((await f.repo.list(url())).folders, [{ id: folder.id, name: "研究" }, { id: "unfiled", name: "未分组" }]);
    assert.deepEqual((await f.repo.list(url(`?folder=${folder.id}`))).items.map(item => item.documentId), [first.id]);
    assert.equal((await f.repo.list(url(`?folder=${emptyFolder.id}`))).total, 0);
    assert.equal((await f.repo.list(url("?manage=true"))).total, 3);
    f.db.sql.prepare("UPDATE documents SET deleted_at=? WHERE id=?").run("2026-10-30T00:00:00.000Z", first.id);
    assert.equal((await f.repo.list(url())).total, 1);
    assert.equal((await f.repo.list(url())).folders.some(row => row.id === folder.id), false);
    f.db.sql.prepare("UPDATE documents SET deleted_at=NULL,folder_id=NULL WHERE id=?").run(first.id);
    assert.equal((await f.repo.list(url("?folder=unfiled"))).total, 2);
    assert.equal(f.db.sql.prepare("SELECT featured FROM home_presentations WHERE document_id=?").get(first.id)?.featured, 1);
  } finally { f.close(); }
});

test("home pagination and literal search are bounded and never return article bodies", async () => {
  const f = fixture();
  try {
    const entries = Array.from({ length: 27 }, (_, index) => presentation(f.db.createArticle(`书架 ${index === 26 ? "100%_special" : String(index).padStart(2, "0")}`).id, index));
    await f.repo.save({ revision: 1, changes: entries });
    const first = await f.repo.list(url()), second = await f.repo.list(url("?page=2"));
    assert.equal(first.items.length, 24); assert.equal(second.items.length, 3); assert.equal(first.total, 27);
    assert.equal(new Set([...first.items, ...second.items].map(row => row.documentId)).size, 27);
    assert.ok(first.items.every(row => !("markdown" in row)));
    assert.deepEqual((await f.repo.list(url("?q=100%25_special"))).items.map(row => row.documentId), [entries[26]!.documentId]);
    await assert.rejects(f.repo.list(url("?page=0")), /查询/);
    await assert.rejects(f.repo.list(url("?page=1.5")), /查询/);
  } finally { f.close(); }
});

test("home saves preserve document content and revision, and conflicts roll back every change", async () => {
  const f = fixture();
  try {
    const article = f.db.createArticle("原始标题"), initial = f.db.getDocument(article.id)!;
    await f.repo.save({ revision: 1, changes: [presentation(article.id, 7, { shortTitle: "封面短标题" })] });
    assert.deepEqual(f.db.getDocument(article.id), initial);
    await assert.rejects(f.repo.save({ revision: 1, changes: [presentation(article.id, 1)] }), /其他页面/);
    await assert.rejects(f.repo.save({ revision: 2, changes: [presentation(article.id, 1), presentation("missing-document")] }));
    assert.equal((await f.repo.list(url())).revision, 2);
    assert.equal((await f.repo.list(url())).items[0]!.position, 7);
    await assert.rejects(f.repo.save({ revision: 2, changes: [presentation(article.id, 1, { coverHash: "f".repeat(64) })] }));
    assert.equal((await f.repo.list(url())).items[0]!.coverHash, null);
    await assert.rejects(f.repo.save({ revision: 2, changes: [presentation(article.id), presentation(article.id)] }), /重复/);
    const guarded = localHome(f.db, () => { throw new Error("epoch changed"); });
    await assert.rejects(guarded.save({ revision: 2, changes: [presentation(article.id)] }), /epoch changed/);
    assert.equal((await f.repo.list(url())).revision, 2);
  } finally { f.close(); }
});

test("home list never attaches a newer revision to stale presentation rows", async () => {
  const f = fixture();
  try {
    await f.repo.save({ revision: 1, changes: [] });
    let changed = false;
    const repo = createHomeRepository({ documents: "documents", folders: "folders", batch: async () => {}, all: async (sql, values) => {
      const rows = f.db.sql.prepare(sql).all(...values as never[]);
      if (!changed && sql.includes("d.id AS documentId")) { changed = true; f.db.sql.prepare("UPDATE home_settings SET revision=revision+1 WHERE id=1").run(); }
      return rows;
    } });
    await assert.rejects(repo.list(url()), error => typeof error === "object" && error !== null && "status" in error && error.status === 409);
  } finally { f.close(); }
});

test("cover uploads validate PNG content, stay document-independent, and are retrievable by hash", () => {
  const f = fixture();
  try {
    const article = f.db.createArticle("封面测试"), before = f.db.getDocument(article.id);
    const saved = uploadHomeCover(f.db, { image: png.toString("base64") });
    assert.match(saved.hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(localHomeCover(f.db, saved.hash), png);
    assert.deepEqual(uploadHomeCover(f.db, { image: png.toString("base64") }), saved);
    assert.equal(f.db.sql.prepare("SELECT COUNT(*) AS count FROM home_covers").get()?.count, 1);
    assert.deepEqual(f.db.getDocument(article.id), before);
    assert.throws(() => localHomeCover(f.db, "../secrets"));
    assert.throws(() => localHomeCover(f.db, "0".repeat(64)));
    assert.throws(() => uploadHomeCover(f.db, { image: "<svg onload='evil()'>" }));
    assert.throws(() => uploadHomeCover(f.db, { image: png.toString("base64"), unknown: true }));
    assert.throws(() => validateCover(new Uint8Array(HOME_MAX_IMAGE_BYTES + 1)));
    const large = Buffer.from(png); large.writeUInt32BE(1601, 16);
    assert.throws(() => validateCover(large));
    const truncated = Buffer.from(png); truncated[44] ^= 1;
    assert.throws(() => validateCover(truncated), "a corrupt PNG must not pass signature-only validation");
    const noPixels = Buffer.concat([png.subarray(0, 33), png.subarray(-12)]);
    assert.throws(() => validateCover(noPixels), "IHDR plus IEND without image data is not an image");
    assert.throws(() => homePresentation({ ...presentation(article.id), featured: 1 }));
    assert.throws(() => parseHomeSnapshot({ presentations: [presentation(article.id, 0, { coverHash: saved.hash })], covers: [] }, new Set([article.id])));
  } finally { f.close(); }
});

class SqliteStatement implements D1Statement {
  constructor(private sqlite: DatabaseSync, private sql: string, private values: unknown[] = []) {}
  bind(...values: unknown[]) { return new SqliteStatement(this.sqlite, this.sql, values); }
  async first<T>() { return (this.sqlite.prepare(this.sql).get(...this.values as never[]) ?? null) as T | null; }
  async all<T>() { return { results: this.sqlite.prepare(this.sql).all(...this.values as never[]) as T[], meta: { changes: 0 } }; }
  async run<T>() { return { results: [] as T[], meta: { changes: Number(this.sqlite.prepare(this.sql).run(...this.values as never[]).changes) } }; }
  async execute(): Promise<D1Result> { return /^\s*SELECT/i.test(this.sql) ? this.all() : this.run(); }
}
function cloudFixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON; CREATE TABLE cloud_folders(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE cloud_documents(id TEXT PRIMARY KEY,title TEXT,kind TEXT,status TEXT,deleted_at TEXT,folder_id TEXT,created_at TEXT);");
  sqlite.exec(HOME_SCHEMA.replace("REFERENCES documents(", "REFERENCES cloud_documents("));
  const db: D1Database = { prepare: sql => new SqliteStatement(sqlite, sql), batch: async statements => {
    sqlite.exec("BEGIN IMMEDIATE");
    try { const results = []; for (const statement of statements) results.push(await (statement as SqliteStatement).execute()); sqlite.exec("COMMIT"); return results; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } };
  const objects = new Map<string, Uint8Array>();
  const images: R2Bucket = {
    async put(key, value) { assert.ok(value instanceof Uint8Array); objects.set(key, Uint8Array.from(value)); },
    async get(key) { const value = objects.get(key); return value ? { body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(value); controller.close(); } }), size: value.length, httpEtag: key, httpMetadata: { contentType: "image/png" }, async arrayBuffer() { return Uint8Array.from(value).buffer; } } : null; },
    async head(key) { const value = objects.get(key); return value ? { size: value.length, httpMetadata: { contentType: "image/png" } } : null; },
    async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
    async list() { return { objects: [...objects.keys()].map(key => ({ key })), truncated: false }; },
  };
  const call = (path: string, method = "GET", body?: unknown) => {
    const request = new Request(`https://app.example.com${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return handleHome(request, new URL(request.url), db, images);
  };
  return { sqlite, call, objects };
}

test("cloud home maps validation errors, stores uploaded covers and atomically guards saves", async () => {
  const f = cloudFixture();
  try {
    f.sqlite.exec("INSERT INTO cloud_documents VALUES('article','Cloud title','article','ready',NULL,NULL,'2026-10-30T00:00:00.000Z')");
    await assert.rejects(f.call("/api/home?page=0"), error => typeof error === "object" && error !== null && "status" in error && error.status === 400 && "code" in error && error.code === "HOME_ERROR");
    const cover = await f.call("/api/home/covers", "POST", { image: png.toString("base64") }) as { hash: string };
    assert.equal(f.objects.size, 1);
    await f.call("/api/home", "PUT", { revision: 1, changes: [presentation("article", 0, { coverHash: cover.hash })] });
    const page = await f.call("/api/home") as HomePage;
    assert.equal(page.items[0]!.coverHash, cover.hash);
    assert.equal(page.revision, 2);
    const response = await f.call(`/api/home/covers/${cover.hash}`) as Response;
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    await assert.rejects(f.call("/api/home", "PUT", { revision: 1, changes: [presentation("article", 5)] }));
    await assert.rejects(f.call("/api/home", "PUT", { revision: 2, changes: [presentation("article", 5), presentation("missing")] }));
    assert.equal((await f.call("/api/home") as HomePage).items[0]!.position, 0);
    assert.equal((await f.call("/api/home") as HomePage).revision, 2);
    await assert.rejects(f.call("/api/home/covers", "POST", { image: "AAAA" }));
    assert.equal(f.objects.size, 1);
  } finally { f.sqlite.close(); }
});
