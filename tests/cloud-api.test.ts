import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { unzipSync } from "fflate";

import { handleRequest, type CloudEnv } from "../cloud/worker.js";
import {
  CloudHttpError,
  epochGuardedDatabase,
  recoverExpiredRestore,
  updateDocument,
  type D1Database,
  type D1Result,
  type D1Statement,
} from "../cloud/extension.js";
import { completePaper, completePaperImages, handleAiApi } from "../cloud/ai.js";
import { PaperBatchError, paperBatchInstruction, runPaperBatches } from "../shared/paper.js";
import { handleClipRequest } from "../cloud/clip.js";
import { createCapture, handleCaptureQueue } from "../cloud/capture.js";
import type { DerivedPreview } from "../shared/types.js";

const rows = new Map<string, { value: string; revision: number }>([
  ["data_epoch", { value: "cloud-test", revision: 0 }],
  ["onboarding", { value: '{"completed":true}', revision: 2 }],
  ["recent_filters", { value: "[]", revision: 3 }],
  ["llm_settings", { value: '{"enabled":false,"target":"remote","remote":{"endpointUrl":"https://api.openai.com/v1/chat/completions","model":""},"local":{"endpointUrl":"","model":"","trusted":false}}', revision: 0 }],
]);
let preparedSql: string[] = [];
let lastBackup = "";

class SqliteD1Statement implements D1Statement {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string,
    private readonly values: unknown[] = [],
    private readonly shouldFail?: (sql: string) => boolean,
  ) {}

  bind(...values: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, values, this.shouldFail);
  }

  async first<T>() {
    return (this.database.prepare(this.sql).get(...this.values as never[]) ?? null) as T | null;
  }

  async all<T>() {
    return { results: this.database.prepare(this.sql).all(...this.values as never[]) as T[], meta: { changes: 0 } };
  }

  async run<T>() {
    if (this.shouldFail?.(this.sql)) throw new Error("injected D1 failure");
    const result = this.database.prepare(this.sql).run(...this.values as never[]);
    return { results: [] as T[], meta: { changes: Number(result.changes) } };
  }

  async execute(): Promise<D1Result> {
    return /^\s*(?:SELECT|PRAGMA|WITH)\b/iu.test(this.sql) ? await this.all() : await this.run();
  }
}

class SqliteD1Database implements D1Database {
  failBatchOn: RegExp | null = null;

  constructor(readonly sqlite: DatabaseSync) {}

  prepare(sql: string) {
    return new SqliteD1Statement(this.sqlite, sql, [], (candidate) => Boolean(this.failBatchOn?.test(candidate)));
  }

  async batch(statements: D1Statement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result[] = [];
      for (const statement of statements) results.push(await (statement as SqliteD1Statement).execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function migratedCloudDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (let version = 1; version <= 10; version += 1) {
    sqlite.exec(readFileSync(new URL(`../cloud/migrations/${String(version).padStart(4, "0")}_${[
      "cloud_core", "browser_extension", "cloud_ai", "cloud_backups", "cloud_capture", "cloud_folders", "cloud_trash", "cloud_favorites",
      "cloud_papers", "cloud_paper_content_mode",
    ][version - 1]}.sql`, import.meta.url), "utf8"));
  }
  return new SqliteD1Database(sqlite);
}

function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
    objects,
    async put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, {
        bytes: typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value),
        contentType: options?.httpMetadata?.contentType,
      });
    },
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      const response = new Response(object.bytes);
      return {
        body: response.body!, size: object.bytes.byteLength, httpEtag: `"${key}"`,
        httpMetadata: object.contentType ? { contentType: object.contentType } : undefined,
        async arrayBuffer() { return await response.arrayBuffer(); },
      };
    },
    async head(key: string) {
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength, httpMetadata: object.contentType ? { contentType: object.contentType } : undefined } : null;
    },
    async delete(key: string | string[]) {
      for (const value of Array.isArray(key) ? key : [key]) objects.delete(value);
    },
    async list(options?: { prefix?: string; cursor?: string }) {
      const prefix = options?.prefix ?? "";
      return {
        objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key })),
        truncated: false,
      };
    },
  };
}

function environment(): CloudEnv {
  return {
    ASSETS: { fetch: async () => new Response("<main>cloud</main>", { headers: { "Content-Type": "text/html" } }) },
    BACKUPS: {
      async put(_key: string, value: string | ArrayBuffer | Uint8Array) {
        lastBackup = typeof value === "string" ? value : new TextDecoder().decode(value instanceof Uint8Array ? value : new Uint8Array(value));
        return {};
      },
      async get() { return null; },
      async head() { return null; },
      async delete() {},
    },
    IMAGES: memoryBucket(),
    CAPTURE_QUEUE: { async send() {} },
    BROWSER: { async quickAction() { return new Response('{"success":true,"result":"# captured"}'); } },
    DB: {
      prepare(sql: string) {
        preparedSql.push(sql);
        let key = sql.includes("data_epoch") ? "data_epoch" : sql.includes("llm_settings") ? "llm_settings" : "";
        const statement = {
          sql,
          bind(value: unknown) {
            key = String(value);
            return statement;
          },
          async first<T>() {
            return (rows.get(key) ?? null) as T | null;
          },
          async all<T>() {
            return { results: [] as T[], meta: { changes: 0 } };
          },
          async run<T>() {
            return { results: [] as T[], meta: { changes: 1 } };
          },
        };
        return statement;
      },
      async batch(statements) {
        return statements.map((statement) => ({
          results: (statement as unknown as { sql: string }).sql.includes("llm_settings") ? [rows.get("llm_settings")!] : [],
          meta: { changes: 0 },
        }));
      },
    },
  };
}

function sqliteEnvironment(db = migratedCloudDatabase(), bucket = memoryBucket(), imagesBucket = memoryBucket()) {
  const env: CloudEnv = {
    ASSETS: { fetch: async () => new Response("<main>cloud</main>", { headers: { "Content-Type": "text/html" } }) },
    BACKUPS: bucket,
    IMAGES: imagesBucket,
    CAPTURE_QUEUE: { async send() {} },
    BROWSER: { async quickAction() { return new Response('{"success":true,"result":"# captured"}'); } },
    DB: db,
  };
  return { env, db, bucket, imagesBucket };
}

test("cloud core serves the existing empty-library startup contract", async () => {
  const health = await handleRequest(new Request("https://app.example.com/health"), environment());
  assert.deepEqual(await health.json(), { ok: true, mode: "cloud-core" });

  const expected = new Map<string, unknown>([
    ["/api/settings/onboarding", { completed: true, revision: 2 }],
    ["/api/data-safety", {
      mode: "ready", maintenance: false, recoveryError: null, backups: [], settings: { automaticRetentionCount: 7 },
      health: {
        database: { integrityCheck: ["ok"], foreignKeyViolations: [], referencedSnapshotPaths: [], referencedAssetPaths: [], pendingFileDeletions: [], recentErrors: [] },
        missingSnapshots: [], orphanSnapshots: [], unsafeSnapshotEntries: [], missingAssets: [], orphanAssets: [], unsafeAssetEntries: [], storageBytes: 0, recentBackup: null,
      },
    }],
    ["/api/settings/recent-filters", { filters: [], revision: 3 }],
    ["/api/capture-queue", { paused: false, active: 0, queued: 0 }],
    ["/api/folders", []],
    ["/api/collections", []],
    ["/api/documents?sort=updated&page=1", { items: [], page: 1, pageSize: 30, total: 0 }],
    ["/api/tags", []],
    ["/api/settings/llm", { enabled: false, target: "remote", remote: { endpointUrl: "https://api.openai.com/v1/chat/completions", model: "" }, local: { endpointUrl: "", model: "", trusted: false }, revision: 0, apiKeyConfigured: false }],
  ]);

  for (const [path, body] of expected) {
    const response = await handleRequest(new Request(`https://app.example.com${path}`), environment());
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("X-Zhiye-Data-Epoch"), "cloud-test", path);
    assert.deepEqual(await response.json(), body, path);
  }

  const pending = await handleRequest(new Request("https://app.example.com/api/collections", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": "cloud-test" }, body: "{}",
  }), environment());
  assert.equal(pending.status, 501);
  assert.equal((await pending.json() as { error: { code: string } }).error.code, "CLOUD_FEATURE_PENDING");

  const pairingCode = await handleRequest(new Request("https://app.example.com/api/settings/browser-extension/pairing-code", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": "cloud-test" },
    body: "{}",
  }), environment());
  assert.equal(pairingCode.status, 201);
  assert.match((await pairingCode.json() as { code: string }).code, /^[A-Z2-9]{10}$/u);

  const backup = await handleRequest(new Request("https://app.example.com/api/data-safety/backups", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": "cloud-test" },
    body: "{}",
  }), environment());
  assert.equal(backup.status, 201);
  assert.equal((await backup.json() as { status: string }).status, "verified");
  const backupArchive = JSON.parse(lastBackup) as { format: string; version: number; folders: unknown[] };
  assert.deepEqual({ format: backupArchive.format, version: backupArchive.version, folders: backupArchive.folders }, {
    format: "zhiye-cloud-backup", version: 5, folders: [],
  });

  const deleted = await handleRequest(new Request("https://app.example.com/api/data-safety/backups/invalid", {
    method: "DELETE", headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": "cloud-test" }, body: "{}",
  }), environment());
  assert.equal(deleted.status, 404);

  preparedSql = [];
  const scopedSearch = await handleRequest(
    new Request("https://app.example.com/api/documents?q=needle&scope=body&page=1"), environment(),
  );
  assert.equal(scopedSearch.status, 200);
  assert.ok(preparedSql.some((sql) => sql.includes("markdown LIKE ?") && !sql.includes("title LIKE ?")));
  const invalidRange = await handleRequest(
    new Request("https://app.example.com/api/documents?from=2026-08-20&to=2026-08-10&page=1"), environment(),
  );
  assert.equal(invalidRange.status, 400);
  assert.equal((await invalidRange.json() as { error: { code: string } }).error.code, "INVALID_DATE_RANGE");
  const invalidFolderFilter = await handleRequest(
    new Request("https://app.example.com/api/documents?folderId=folder-1&unfiled=true"), environment(),
  );
  assert.equal(invalidFolderFilter.status, 400);
  assert.equal((await invalidFolderFilter.json() as { error: { code: string } }).error.code, "INVALID_FILTER");
  preparedSql = [];
  const filed = await handleRequest(new Request("https://app.example.com/api/documents?unfiled=false"), environment());
  assert.equal(filed.status, 200);
  assert.ok(preparedSql.some((sql) => sql.includes("cloud_documents") && sql.includes("folder_id IS NOT NULL")));
  assert.ok(preparedSql.some((sql) => sql.includes("cloud_capture_jobs") && sql.includes("folder_id IS NOT NULL")));

  preparedSql = [];
  const papersOnly = await handleRequest(new Request("https://app.example.com/api/documents?kind=paper&page=1"), environment());
  assert.equal(papersOnly.status, 200);
  assert.ok(preparedSql.some((sql) => sql.includes("kind = ?")));
  // Pending captures are articles, so a paper view must not merge them in.
  assert.ok(!preparedSql.some((sql) => sql.includes("cloud_capture_jobs")));
  // An article view is the mirror image: the local service lists a queued
  // capture as an article-kind document, so the cloud has to merge it too.
  preparedSql = [];
  const articlesOnly = await handleRequest(new Request("https://app.example.com/api/documents?kind=article&page=1"), environment());
  assert.equal(articlesOnly.status, 200);
  assert.ok(preparedSql.some((sql) => sql.includes("cloud_capture_jobs")));
  const invalidKind = await handleRequest(new Request("https://app.example.com/api/documents?kind=book"), environment());
  assert.equal(invalidKind.status, 400);
  assert.equal((await invalidKind.json() as { error: { code: string } }).error.code, "INVALID_FILTER");

  const asset = await handleRequest(new Request("https://app.example.com/"), environment());
  assert.equal(asset.headers.get("X-Frame-Options"), "DENY");
});

test("cloud folders create, rename, move documents and jobs, then delete to unfiled", async () => {
  const { env, db } = sqliteEnvironment();
  const now = "2026-08-18T00:00:00.000Z";
  db.sqlite.prepare(`INSERT INTO cloud_documents(
    id, source_url, final_url, canonical_url, title, author, published_at, markdown, status, source_note,
    revision, created_at, updated_at, folder_id
  ) VALUES (?, ?, NULL, NULL, ?, NULL, NULL, ?, 'ready', '', 1, ?, ?, NULL)`)
    .run("document-1", "https://example.com/document", "Document", "# Document", now, now);
  db.sqlite.prepare(`INSERT INTO cloud_capture_jobs(
    id, url, status, error_code, created_at, updated_at, folder_id, revision
  ) VALUES (?, ?, 'queued', NULL, ?, ?, NULL, 1)`)
    .run("job-1", "https://example.com/job", now, now);
  const headers = { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": "cloud-1" };
  const createdResponse = await handleRequest(new Request("https://app.example.com/api/folders", {
    method: "POST", headers, body: JSON.stringify({ name: "Research" }),
  }), env);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { id: string };
  const renamedResponse = await handleRequest(new Request(`https://app.example.com/api/folders/${created.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ name: "Reading" }),
  }), env);
  assert.equal(renamedResponse.status, 200);
  assert.equal((await renamedResponse.json() as { name: string }).name, "Reading");
  for (const id of ["document-1", "job-1"]) {
    const moved = await handleRequest(new Request(`https://app.example.com/api/documents/${id}`, {
      method: "PATCH", headers, body: JSON.stringify({ revision: 1, folderId: created.id }),
    }), env);
    assert.equal(moved.status, 200);
    assert.equal((await moved.json() as { folderId: string }).folderId, created.id);
  }
  const folders = await handleRequest(new Request("https://app.example.com/api/folders"), env);
  assert.equal((await folders.json() as Array<{ documentCount: number }>)[0]?.documentCount, 2);
  const deleted = await handleRequest(new Request(`https://app.example.com/api/folders/${created.id}`, {
    method: "DELETE", headers, body: "{}",
  }), env);
  assert.deepEqual(await deleted.json(), { deleted: true, affectedDocuments: 2 });
  const document = db.sqlite.prepare("SELECT folder_id, revision FROM cloud_documents WHERE id = 'document-1'").get() as
    { folder_id: string | null; revision: number };
  const job = db.sqlite.prepare("SELECT folder_id, revision FROM cloud_capture_jobs WHERE id = 'job-1'").get() as
    { folder_id: string | null; revision: number };
  assert.deepEqual({ ...document }, { folder_id: null, revision: 3 });
  assert.deepEqual({ ...job }, { folder_id: null, revision: 3 });
});

test("cloud creates a ready blank article in the top level", async () => {
  const { env } = sqliteEnvironment();
  const response = await handleRequest(new Request("https://app.example.com/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": "cloud-1" },
    body: JSON.stringify({ title: "未命名文章" }),
  }), env);
  assert.equal(response.status, 201);
  const article = (await response.json() as { document: { status: string; folderId: string | null; sourceUrl: string } }).document;
  assert.equal(article.status, "ready");
  assert.equal(article.folderId, null);
  assert.match(article.sourceUrl, /^zhiye:\/\/article\//u);
});

test("cloud stores paper PDFs as a separate paper item", async () => {
  const { env, db, bucket, imagesBucket } = sqliteEnvironment();
  const pdf = Buffer.from("%PDF-1.7\ncloud paper\n", "ascii");
  const response = await handleRequest(new Request("https://app.example.com/api/papers/upload", {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "Content-Length": String(pdf.length), "X-Filename": "cloud-paper.pdf", "X-Zhiye-Data-Epoch": "cloud-test" },
    body: pdf,
  }), env);
  assert.equal(response.status, 201);
  const body = await response.json() as { paper: { id: string; kind: string; sourceKind: string; originalFileName: string; sourceHash: string } };
  assert.deepEqual({ kind: body.paper.kind, sourceKind: body.paper.sourceKind, originalFileName: body.paper.originalFileName }, { kind: "paper", sourceKind: "pdf", originalFileName: "cloud-paper.pdf" });
  assert.equal((await imagesBucket.head(`paper/${body.paper.sourceHash}`))?.size, pdf.length);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM cloud_papers").get() as { count: number }).count, 1);
  const failedExtractionId = "paper-error-task";
  const failedAt = new Date().toISOString();
  db.sqlite.prepare(`INSERT INTO cloud_paper_extractions(
    id, paper_id, status, source_hash, error_code, error_message, created_at, finished_at
  ) VALUES (?, ?, 'failed', ?, ?, ?, ?, ?)`).run(
    failedExtractionId, body.paper.id, body.paper.sourceHash, "PAPER_PDF_UNSUPPORTED", "当前模型不支持论文 PDF 输入", failedAt, failedAt,
  );
  db.sqlite.prepare("UPDATE cloud_papers SET status = 'failed', extraction_id = ? WHERE id = ?").run(failedExtractionId, body.paper.id);
  const failedPaper = await handleRequest(new Request(`https://app.example.com/api/papers/${body.paper.id}`), env);
  const failedPaperBody = await failedPaper.json() as { errorCode: string; errorMessage: string };
  assert.deepEqual({ code: failedPaperBody.errorCode, message: failedPaperBody.errorMessage }, { code: "PAPER_PDF_UNSUPPORTED", message: "当前模型不支持论文 PDF 输入" });
  const backup = await handleRequest(new Request("https://app.example.com/api/data-safety/backups", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": String((db.sqlite.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").get() as { value: string }).value) }, body: "{}",
  }), env);
  assert.equal(backup.status, 201, await backup.clone().text());
  const backupId = (await backup.json() as { id: string }).id;
  const manifest = JSON.parse(new TextDecoder().decode(bucket.objects.get(`backups/${backupId}.zhiye-cloud-backup`)!.bytes)) as { version: number; papers: unknown[]; paperFiles: unknown[] };
  assert.equal(manifest.version, 6);
  assert.equal(manifest.papers.length, 1);
  assert.equal(manifest.paperFiles.length, 1);
});

test("cloud permanently deletes trashed papers and only removes a shared PDF last", async () => {
  const { env, db, imagesBucket } = sqliteEnvironment();
  const pdf = Buffer.from("%PDF-1.7\ncloud delete fixture\n", "ascii");
  const headers = { "Content-Type": "application/pdf", "Content-Length": String(pdf.length), "X-Filename": "delete.pdf", "X-Zhiye-Data-Epoch": "cloud-test" };
  const upload = async (fileName: string) => {
    const response = await handleRequest(new Request("https://app.example.com/api/papers/upload", { method: "POST", headers: { ...headers, "X-Filename": fileName }, body: pdf }), env);
    assert.equal(response.status, 201);
    return (await response.json() as { paper: { id: string; sourceHash: string; revision: number } }).paper;
  };
  const remove = async (paper: { id: string; revision: number }) => {
    const epoch = (db.sqlite.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").get() as { value: string }).value;
    const trash = await handleRequest(new Request(`https://app.example.com/api/documents/${paper.id}`, {
      method: "DELETE", headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": epoch }, body: JSON.stringify({ revision: paper.revision }),
    }), env);
    assert.equal(trash.status, 200, await trash.clone().text());
    const deleted = (await trash.json() as { revision: number }).revision;
    const permanent = await handleRequest(new Request(`https://app.example.com/api/documents/${paper.id}/permanent`, {
      method: "DELETE", headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": epoch }, body: JSON.stringify({ revision: deleted, draftRevision: null }),
    }), env);
    assert.equal(permanent.status, 204, await permanent.clone().text());
  };
  const first = await upload("first.pdf");
  const second = await upload("second.pdf");
  await remove(first);
  assert.equal(await imagesBucket.head(`paper/${first.sourceHash}`) !== null, true);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM cloud_documents WHERE id = ?").get(first.id) as { count: number }).count, 0);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM cloud_papers WHERE id = ?").get(first.id) as { count: number }).count, 0);
  await remove(second);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM cloud_paper_files WHERE hash = ?").get(first.sourceHash) as { count: number }).count, 0);
  assert.equal(await imagesBucket.head(`paper/${first.sourceHash}`), null);
});

test("cloud paper calls report a rejected content part as its own failure", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "this model does not support file input" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await assert.rejects(
      () => completePaper(
        "https://api.deepseek.com/chat/completions",
        "deepseek-flash",
        "paper-secret",
        "paper",
        new Uint8Array(Buffer.from("%PDF-1.7\nfixture\n", "ascii")),
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "PAPER_PDF_UNSUPPORTED");
        assert.match((error as Error).message, /does not support file input/u);
        return true;
      },
    );
    await assert.rejects(
      () => completePaperImages(
        "https://api.deepseek.com/chat/completions",
        "deepseek-chat",
        "paper-secret",
        "paper",
        [{ pageNumber: 1, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }],
        "Transcribe page 1.",
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "PAPER_MODEL_NO_VISION");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 2);
});

test("cloud paper extraction drives page images when the endpoint cannot take the PDF", async () => {
  const originalFetch = globalThis.fetch;
  const { env, db, imagesBucket } = sqliteEnvironment();
  const epoch = (db.sqlite.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").get() as { value: string }).value;
  db.sqlite.prepare("UPDATE app_settings SET value = ?, revision = revision + 1 WHERE key = 'llm_settings'").run(JSON.stringify({
    enabled: true,
    target: "remote",
    remote: { endpointUrl: "https://api.deepseek.com/chat/completions", model: "deepseek-flash" },
    local: { endpointUrl: "", model: "", trusted: false },
  }));
  const pdf = Buffer.from("%PDF-1.7\ncloud paper\n", "ascii");
  const upload = await handleRequest(new Request("https://app.example.com/api/papers/upload", {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "Content-Length": String(pdf.length), "X-Filename": "paged.pdf", "X-Zhiye-Data-Epoch": epoch },
    body: pdf,
  }), env);
  const paper = (await upload.json() as { paper: { id: string; sourceHash: string } }).paper;
  const extractionRequest = () => new Request(`https://app.example.com/api/papers/${paper.id}/extractions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": epoch, "X-Zhiye-LLM-Key": "page-scoped-key" },
    body: "{}",
  });

  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { headers: { "Content-Type": "application/json" } }); };
  try {
    const plan = await handleRequest(new Request(`https://app.example.com/api/papers/${paper.id}/extraction-plan`), env);
    assert.deepEqual(await plan.json(), { contentMode: "image", pageCount: null, rendered: [] });

    // Without the page count the image path stops before spending a request.
    const early = await handleRequest(extractionRequest(), env);
    assert.equal(early.status, 409);
    assert.equal(((await early.json()) as { error: { code: string } }).error.code, "PAPER_PAGE_COUNT_REQUIRED");
    assert.equal(calls, 0);

    const renders = await handleRequest(new Request(`https://app.example.com/api/papers/${paper.id}/page-renders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": epoch },
      body: JSON.stringify({ pageCount: 1 }),
    }), env);
    assert.deepEqual(await renders.json(), { pageCount: 1, rendered: [] });

    // Page images are JPEG only, and the stored key is derived from the PDF hash.
    const notJpeg = await handleRequest(new Request(`https://app.example.com/api/papers/${paper.id}/pages/1/image`, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg", "Content-Length": "4", "X-Zhiye-Data-Epoch": epoch },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    }), env);
    assert.equal(notJpeg.status, 415);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    const stored = await handleRequest(new Request(`https://app.example.com/api/papers/${paper.id}/pages/1/image`, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg", "Content-Length": String(jpeg.length), "X-Zhiye-Data-Epoch": epoch },
      body: jpeg,
    }), env);
    assert.equal(stored.status, 200);
    assert.equal((await imagesBucket.head(`paper-pages/${paper.sourceHash}/0001.jpg`))?.size, jpeg.length);

    // The plan now knows the page, so a retry never re-renders it.
    const replanned = await handleRequest(new Request(`https://app.example.com/api/papers/${paper.id}/extraction-plan`), env);
    assert.deepEqual(await replanned.json(), { contentMode: "image", pageCount: 1, rendered: [1] });

    let sent: { maxTokens: number; system: string; parts: Array<{ type: string; image_url?: { url: string; detail: string } }> } | null = null;
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { max_tokens: number; messages: Array<{ content: unknown }> };
      sent = {
        maxTokens: body.max_tokens,
        system: String(body.messages[0]!.content),
        parts: body.messages[1]!.content as Array<{ type: string; image_url?: { url: string; detail: string } }>,
      };
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              paper: { title: "页图论文", authors: ["甲"] },
              pages: [{ pageNumber: 1, blocks: [{ id: "p1-b1", type: "paragraph", original: "From the page image.", translation: "来自页图。", assetIds: [] }] }],
            }),
          },
        }],
      }), { headers: { "Content-Type": "application/json" } });
    };

    const started = await handleRequest(extractionRequest(), env);
    assert.equal(started.status, 202);
    const task = await started.json() as { id: string; status: string; contentMode: string; pageCount: number | null };
    assert.deepEqual({ status: task.status, contentMode: task.contentMode, pageCount: task.pageCount }, { status: "running", contentMode: "image", pageCount: 1 });

    const stepRequest = (headers: Record<string, string> = {}) => new Request(`https://app.example.com/api/paper-tasks/${task.id}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": epoch, "X-Zhiye-LLM-Key": "page-scoped-key", ...headers },
      body: "{}",
    });

    // Every batch carries the page-scoped key, so a batch without one is
    // refused instead of being sent to the provider unauthenticated.
    const noKey = await handleRequest(stepRequest({ "X-Zhiye-LLM-Key": "" }), env);
    assert.equal(noKey.status, 409);
    assert.equal(((await noKey.json()) as { error: { code: string } }).error.code, "LLM_KEY_MISSING");

    const step = await handleRequest(stepRequest(), env);
    assert.equal(step.status, 202);
    const done = await step.json() as { status: string; completedPages: number; pageCount: number; contentMode: string };
    assert.deepEqual({ status: done.status, completedPages: done.completedPages, pageCount: done.pageCount }, { status: "succeeded", completedPages: 1, pageCount: 1 });
    assert.deepEqual(sent!.parts.map((part) => part.type), ["text", "image_url"]);
    assert.equal(sent!.parts[1]!.image_url!.url, `data:image/jpeg;base64,${jpeg.toString("base64")}`);
    assert.equal(sent!.parts[1]!.image_url!.detail, "high");
    assert.match(sent!.system, /page images in ascending page order/u);
    assert.equal(sent!.maxTokens, 12_000);

    // A finished task is not advanced again: the client loop stops here.
    const again = await handleRequest(stepRequest(), env);
    assert.equal((await again.json() as { status: string }).status, "succeeded");

    const paperBody = await (await handleRequest(new Request(`https://app.example.com/api/papers/${paper.id}`), env)).json() as {
      status: string; title: string; pageCount: number; pages: Array<{ translationBlocks: Array<{ translation: string }> }>;
    };
    assert.equal(paperBody.status, "ready");
    assert.equal(paperBody.title, "页图论文");
    assert.equal(paperBody.pageCount, 1);
    assert.equal(paperBody.pages[0]!.translationBlocks[0]!.translation, "来自页图。");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloud paper page updates return the server document revision", async () => {
  const { env, db } = sqliteEnvironment();
  const pdf = Buffer.from("%PDF-1.7\ncloud page revision\n", "ascii");
  const upload = await handleRequest(new Request("https://app.example.com/api/papers/upload", {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "Content-Length": String(pdf.length), "X-Filename": "page.pdf", "X-Zhiye-Data-Epoch": "cloud-test" },
    body: pdf,
  }), env);
  const paper = (await upload.json() as { paper: { id: string; sourceHash: string; revision: number } }).paper;
  const extractionId = `extraction-${paper.id}`;
  const now = new Date().toISOString();
  const block = JSON.stringify([{ id: "p1-b1", type: "paragraph", original: "Original", translation: "译文", assetIds: [] }]);
  db.sqlite.prepare(`INSERT INTO cloud_paper_extractions(id, paper_id, status, source_hash, page_count, completed_pages, created_at, finished_at)
    VALUES (?, ?, 'succeeded', ?, 1, 1, ?, ?)`).run(extractionId, paper.id, paper.sourceHash, now, now);
  db.sqlite.prepare("UPDATE cloud_papers SET status = 'ready', extraction_id = ?, page_count = 1 WHERE id = ?").run(extractionId, paper.id);
  db.sqlite.prepare(`INSERT INTO cloud_paper_pages(paper_id, extraction_id, page_number, original_json, translation_json, revision, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?, 1, ?, ?)`).run(paper.id, extractionId, block, block, now, now);
  const epoch = (db.sqlite.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").get() as { value: string }).value;
  const response = await handleRequest(new Request(`https://app.example.com/api/papers/${paper.id}/pages/1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": epoch },
    body: JSON.stringify({ revision: 1, translationBlocks: [{ id: "p1-b1", type: "paragraph", original: "Original", translation: "更新译文", assetIds: [] }] }),
  }), env);
  assert.equal(response.status, 200, await response.clone().text());
  const page = await response.json() as { revision: number; documentRevision: number; translationBlocks: Array<{ translation: string }> };
  assert.deepEqual({ revision: page.revision, documentRevision: page.documentRevision, translation: page.translationBlocks[0]?.translation }, { revision: 2, documentRevision: paper.revision, translation: "更新译文" });
});

test("cloud favorites documents with revision guards and list filters", async () => {
  const { env } = sqliteEnvironment();
  const headers = { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": "cloud-1" };
  const created = await handleRequest(new Request("https://app.example.com/api/documents", {
    method: "POST", headers, body: JSON.stringify({ title: "Favorite" }),
  }), env);
  const document = (await created.json() as { document: { id: string; revision: number } }).document;
  const favorited = await handleRequest(new Request(`https://app.example.com/api/documents/${document.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ revision: document.revision, favorite: true }),
  }), env);
  assert.equal(favorited.status, 200);
  assert.deepEqual(
    (({ favorite, revision }) => ({ favorite, revision }))(await favorited.json() as { favorite: boolean; revision: number }),
    { favorite: true, revision: 2 },
  );
  const favorites = await handleRequest(new Request("https://app.example.com/api/documents?favorite=true&page=1"), env);
  const favoritesBody = await favorites.json() as { items: Array<{ id: string; favorite: boolean }>; total: number };
  assert.equal(favoritesBody.total, 1);
  assert.deepEqual(favoritesBody.items.map(({ id, favorite }) => ({ id, favorite })), [{ id: document.id, favorite: true }]);
  const others = await handleRequest(new Request("https://app.example.com/api/documents?favorite=false&page=1"), env);
  assert.equal((await others.json() as { total: number }).total, 0);
  const stale = await handleRequest(new Request(`https://app.example.com/api/documents/${document.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ revision: 1, favorite: false }),
  }), env);
  assert.equal(stale.status, 409);
});

test("cloud documents and capture jobs round-trip through trash with revision guards", async () => {
  const { env, db } = sqliteEnvironment();
  let queuedMessages = 0;
  env.CAPTURE_QUEUE = { async send() { queuedMessages += 1; } };
  const now = "2026-08-18T00:00:00.000Z";
  db.sqlite.prepare(`INSERT INTO cloud_documents(
    id, source_url, final_url, canonical_url, title, author, published_at, markdown, status, source_note,
    revision, created_at, updated_at, folder_id
  ) VALUES ('trash-document', 'https://example.com/document', NULL, NULL, 'Document', NULL, NULL, '# Document', 'ready', '', 1, ?, ?, NULL)`)
    .run(now, now);
  db.sqlite.prepare(`INSERT INTO cloud_capture_jobs(
    id, url, status, error_code, created_at, updated_at, folder_id, revision
  ) VALUES ('trash-job', 'https://example.com/job', 'queued', NULL, ?, ?, NULL, 1)`).run(now, now);
  const headers = { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": "cloud-1" };
  const mutate = (id: string, method: string, suffix = "", revision = 1) => handleRequest(new Request(
    `https://app.example.com/api/documents/${id}${suffix}`,
    { method, headers, body: JSON.stringify(suffix === "/permanent" ? { revision, draftRevision: null } : { revision }) },
  ), env);

  for (const id of ["trash-document", "trash-job"]) {
    const deleted = await mutate(id, "DELETE");
    assert.equal(deleted.status, 200);
    const body = await deleted.json() as { deletedAt: string | null; revision: number };
    assert.ok(body.deletedAt);
    assert.equal(body.revision, 2);
    const stale = await mutate(id, "DELETE");
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { error: { document: { revision: number } } }).error.document.revision, 2);
  }
  const active = await handleRequest(new Request("https://app.example.com/api/documents?page=1"), env);
  assert.deepEqual(await active.json(), { items: [], page: 1, pageSize: 30, total: 0 });
  const invalidTrash = await handleRequest(new Request("https://app.example.com/api/documents?trash=bad&page=1"), env);
  assert.equal(invalidTrash.status, 400);
  assert.equal((await invalidTrash.json() as { error: { code: string } }).error.code, "INVALID_TRASH_FILTER");
  const trash = await handleRequest(new Request("https://app.example.com/api/documents?trash=only&page=1"), env);
  const trashBody = await trash.json() as { items: Array<{ id: string }>; total: number };
  assert.deepEqual(trashBody.items.map(({ id }) => id).sort(), ["trash-document", "trash-job"]);
  assert.equal(trashBody.total, 2);
  const retryDeleted = await handleRequest(new Request("https://app.example.com/api/documents/trash-job/retry", {
    method: "POST", headers, body: "{}",
  }), env);
  assert.equal(retryDeleted.status, 409);
  assert.equal((await retryDeleted.json() as { error: { code: string } }).error.code, "DOCUMENT_DELETED");
  assert.equal(queuedMessages, 0);
  const invalidPath = await handleRequest(new Request("https://app.example.com/api/documents/%E0%A4%A/restore", {
    method: "POST", headers, body: JSON.stringify({ revision: 1 }),
  }), env);
  assert.equal(invalidPath.status, 400);
  assert.equal((await invalidPath.json() as { error: { code: string } }).error.code, "INVALID_PATH");

  for (const id of ["trash-document", "trash-job"]) {
    const restored = await mutate(id, "POST", "/restore", 2);
    assert.equal(restored.status, 200);
    assert.equal((await restored.json() as { deletedAt: string | null; revision: number }).deletedAt, null);
    assert.equal((await mutate(id, "DELETE", "", 3)).status, 200);
    assert.equal((await mutate(id, "DELETE", "/permanent", 4)).status, 204);
  }
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM cloud_documents").get() as { count: number }).count, 0);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM cloud_capture_jobs").get() as { count: number }).count, 0);
});

test("cloud document and capture job pagination never skips mixed rows", async () => {
  const { env, db } = sqliteEnvironment();
  const base = Date.parse("2026-08-18T00:00:00.000Z");
  for (let index = 0; index < 31; index += 1) {
    const timestamp = new Date(base + index * 1_000).toISOString();
    const title = ["世界", "😀", "Alpha", "alpha"][index] ?? `Document ${index}`;
    db.sqlite.prepare(`INSERT INTO cloud_documents(
      id, source_url, final_url, canonical_url, title, author, published_at, markdown, status, source_note,
      revision, created_at, updated_at, folder_id
    ) VALUES (?, ?, NULL, NULL, ?, NULL, NULL, ?, 'ready', '', 1, ?, ?, NULL)`)
      .run(`document-${String(index).padStart(2, "0")}`, `https://example.com/${index}`, title, `# ${index}`, timestamp, timestamp);
  }
  const jobTimestamp = new Date(base + 100_000).toISOString();
  db.sqlite.prepare(`INSERT INTO cloud_capture_jobs(
    id, url, status, error_code, created_at, updated_at, folder_id, revision
  ) VALUES ('job-latest', 'https://example.com/job', 'queued', NULL, ?, ?, NULL, 1)`).run(jobTimestamp, jobTimestamp);
  for (const sort of ["updated", "title"]) {
    const pages = await Promise.all([1, 2].map(async (page) => {
      const response = await handleRequest(new Request(`https://app.example.com/api/documents?page=${page}&sort=${sort}`), env);
      assert.equal(response.status, 200);
      return await response.json() as { items: Array<{ id: string }>; total: number };
    }));
    assert.deepEqual(pages.map(({ items }) => items.length), [30, 2]);
    assert.deepEqual(pages.map(({ total }) => total), [32, 32]);
    const ids = pages.flatMap(({ items }) => items.map(({ id }) => id));
    assert.equal(new Set(ids).size, 32);
    assert.ok(ids.includes("document-00"));
    assert.ok(ids.includes("job-latest"));
  }
});

test("cloud backup restores v4 favorites and trash, maps v1 documents to defaults, and rolls back failures", async () => {
  const { env, db, bucket } = sqliteEnvironment();
  const now = "2026-08-18T00:00:00.000Z";
  db.sqlite.prepare("INSERT INTO cloud_folders(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("folder-v2", "Research", now, now);
  db.sqlite.prepare(`INSERT INTO cloud_documents(
    id, source_url, final_url, canonical_url, title, author, published_at, markdown, status, source_note,
    revision, created_at, updated_at, folder_id
  ) VALUES (?, ?, NULL, NULL, ?, NULL, NULL, ?, 'ready', '', 1, ?, ?, ?)`)
    .run("document-v2", "https://example.com/v2", "V2", "# V2", now, now, "folder-v2");
  db.sqlite.prepare("UPDATE cloud_documents SET deleted_at = ? WHERE id = 'document-v2'").run(now);
  db.sqlite.prepare("UPDATE cloud_documents SET favorite = 1 WHERE id = 'document-v2'").run();
  const epochHeader = () => ({
    "Content-Type": "application/json",
    "X-Zhiye-Data-Epoch": String((db.sqlite.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").get() as { value: string }).value),
  });
  const created = await handleRequest(new Request("https://app.example.com/api/data-safety/backups", {
    method: "POST", headers: epochHeader(), body: "{}",
  }), env);
  assert.equal(created.status, 201);
  const v2BackupId = (await created.json() as { id: string }).id;
  const exported = await handleRequest(new Request(`https://app.example.com/api/data-safety/backups/${v2BackupId}/export.zhiye-backup`), env);
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("Content-Type"), "application/vnd.zhiye.cloud-backup+zip");
  const unpacked = unzipSync(new Uint8Array(await exported.arrayBuffer()));
  assert.equal((JSON.parse(new TextDecoder().decode(unpacked["manifest.json"]!)) as { version: number }).version, 5);
  db.sqlite.exec("DELETE FROM cloud_documents; DELETE FROM cloud_folders;");
  db.sqlite.prepare(`INSERT INTO cloud_documents(
    id, source_url, final_url, canonical_url, title, author, published_at, markdown, status, source_note,
    revision, created_at, updated_at, folder_id
  ) VALUES ('sentinel', 'https://example.com/sentinel', NULL, NULL, 'Sentinel', NULL, NULL, '# Sentinel', 'ready', '', 1, ?, ?, NULL)`)
    .run(now, now);
  const restored = await handleRequest(new Request(`https://app.example.com/api/data-safety/backups/${v2BackupId}/restore`, {
    method: "POST", headers: epochHeader(), body: "{}",
  }), env);
  assert.equal(restored.status, 200);
  assert.match(restored.headers.get("X-Zhiye-Data-Epoch") || "", /^cloud-/u);
  assert.deepEqual(
    db.sqlite.prepare("SELECT id, folder_id, favorite, deleted_at FROM cloud_documents ORDER BY id").all().map((row) => ({ ...row })),
    [{ id: "document-v2", folder_id: "folder-v2", favorite: 1, deleted_at: now }],
  );
  assert.deepEqual(db.sqlite.prepare("SELECT id, name FROM cloud_folders").all().map((row) => ({ ...row })), [{ id: "folder-v2", name: "Research" }]);

  const v1Document = {
    id: "document-v1", source_url: "https://example.com/v1", final_url: null, canonical_url: null,
    title: "V1", author: null, published_at: null, markdown: "# V1", status: "ready", source_note: "",
    revision: 1, created_at: now, updated_at: now,
  };
  const imported = await handleRequest(new Request("https://app.example.com/api/data-safety/backups/import", {
    method: "POST",
    headers: { ...epochHeader(), "Content-Type": "application/vnd.zhiye.cloud-backup+json" },
    body: JSON.stringify({
      format: "zhiye-cloud-backup", version: 1, createdAt: now,
      documents: [v1Document], derivedResults: [], llmSettings: null,
    }),
  }), env);
  assert.equal(imported.status, 201);
  const v1BackupId = (await imported.json() as { id: string }).id;
  const restoredV1 = await handleRequest(new Request(`https://app.example.com/api/data-safety/backups/${v1BackupId}/restore`, {
    method: "POST", headers: epochHeader(), body: "{}",
  }), env);
  assert.equal(restoredV1.status, 200);
  assert.deepEqual(
    db.sqlite.prepare("SELECT id, folder_id FROM cloud_documents").all().map((row) => ({ ...row })),
    [{ id: "document-v1", folder_id: null }],
  );
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM cloud_folders").get() as { count: number }).count, 0);

  const rollbackTarget = await handleRequest(new Request("https://app.example.com/api/data-safety/backups", {
    method: "POST", headers: epochHeader(), body: "{}",
  }), env);
  const rollbackId = (await rollbackTarget.json() as { id: string }).id;
  db.sqlite.prepare("UPDATE cloud_documents SET title = 'Current state'").run();
  db.failBatchOn = /^\s*INSERT INTO cloud_documents/iu;
  const failed = await handleRequest(new Request(`https://app.example.com/api/data-safety/backups/${rollbackId}/restore`, {
    method: "POST", headers: epochHeader(), body: "{}",
  }), env);
  db.failBatchOn = null;
  assert.equal(failed.status, 500);
  assert.equal((db.sqlite.prepare("SELECT title FROM cloud_documents").get() as { title: string }).title, "Current state");

  const deletable = await handleRequest(new Request("https://app.example.com/api/data-safety/backups", {
    method: "POST", headers: epochHeader(), body: "{}",
  }), env);
  const deletableId = (await deletable.json() as { id: string }).id;
  const originalDelete = env.BACKUPS.delete;
  env.BACKUPS.delete = async () => { throw new Error("injected R2 delete failure"); };
  const failedDelete = await handleRequest(new Request(`https://app.example.com/api/data-safety/backups/${deletableId}`, {
    method: "DELETE", headers: epochHeader(), body: "{}",
  }), env);
  assert.equal(failedDelete.status, 500);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM cloud_backups WHERE id = ?").get(deletableId) as { count: number }).count, 1);
  assert.equal((db.sqlite.prepare("SELECT status, error_code FROM cloud_backups WHERE id = ?").get(deletableId) as { status: string; error_code: string }).status, "missing");
  assert.equal(bucket.objects.has(`backups/${deletableId}.zhiye-cloud-backup`), true);
  env.BACKUPS.delete = originalDelete;
  const deleted = await handleRequest(new Request(`https://app.example.com/api/data-safety/backups/${deletableId}`, {
    method: "DELETE", headers: epochHeader(), body: "{}",
  }), env);
  assert.equal(deleted.status, 204);
  assert.equal(bucket.objects.has(`backups/${deletableId}.zhiye-cloud-backup`), false);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM cloud_backups WHERE id = ?").get(deletableId) as { count: number }).count, 0);
  assert.doesNotMatch(String((db.sqlite.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").get() as { value: string }).value), /^restore:/u);
});

test("cloud AI probe uses a page-scoped key without echoing it", async () => {
  const secret = "cloud-page-secret";
  const originalFetch = globalThis.fetch;
  let authorization = "";
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("Authorization") || "";
    return new Response(JSON.stringify({ choices: [{ message: { content: "Connection is working." } }] }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const db = {
    prepare() {
      return {
        bind() { return this; },
        async first<T>() { return rows.get("llm_settings") as T; },
        async all<T>() { return { results: [] as T[], meta: { changes: 0 } }; },
        async run<T>() { return { results: [] as T[], meta: { changes: 0 } }; },
      };
    },
  };
  try {
    const request = new Request("https://app.example.com/api/settings/llm/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Zhiye-LLM-Key": secret },
      body: JSON.stringify({ target: "remote", endpointUrl: "https://api.openai.com/v1/chat/completions", model: "probe-model" }),
    });
    const reply = await handleAiApi(request, db, new URL(request.url));
    assert.equal(reply?.status, undefined);
    assert.equal((reply?.body as { ok: boolean }).ok, true);
    assert.equal(authorization, `Bearer ${secret}`);
    assert.equal(JSON.stringify(reply).includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloud AI accepts a confirmed free-form analysis prompt", async () => {
  const originalFetch = globalThis.fetch;
  const settings = {
    value: JSON.stringify({ enabled: true, target: "remote", remote: { endpointUrl: "https://api.openai.com/v1/chat/completions", model: "analysis-model" }, local: { endpointUrl: "", model: "", trusted: false } }),
    revision: 3,
  };
  const document = {
    id: "custom-doc", sourceUrl: "https://example.com/", finalUrl: "https://example.com/", canonicalUrl: "https://example.com/",
    title: "Scaling", author: null, status: "ready", revision: 2, createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z", publishedAt: null, markdown: "# Evidence\n\nA claim and its assumptions.", sourceNote: "test",
  };
  const db = {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first<T>() {
          if (sql.includes("llm_settings")) return settings as T;
          if (sql.includes("cloud_documents")) return document as T;
          if (sql.includes("data_epoch")) return { value: "cloud-test" } as T;
          return null;
        },
        async all<T>() { return { results: [] as T[], meta: { changes: 0 } }; },
        async run<T>() { return { results: [] as T[], meta: { changes: 1 } }; },
      };
    },
  };
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "## Analysis\n\nThe assumption is weak." } }] }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const prompt = "Identify the weakest assumption and explain why.";
    const maximumPromptRequest = new Request("https://app.example.com/api/documents/custom-doc/derived-preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "summary", revision: 2, customPrompt: "界".repeat(4_000) }),
    });
    assert.equal(((await handleAiApi(maximumPromptRequest, db, new URL(maximumPromptRequest.url)))?.body as DerivedPreview).customPrompt?.length, 4_000);
    const invalidPromptRequest = new Request("https://app.example.com/api/documents/custom-doc/derived-preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "summary", revision: 2, customPrompt: `bad\u0085prompt` }),
    });
    await assert.rejects(handleAiApi(invalidPromptRequest, db, new URL(invalidPromptRequest.url)), /4000 characters/u);
    const invalidLanguageRequest = new Request("https://app.example.com/api/documents/custom-doc/derived-preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "summary", revision: 2, targetLanguage: "zh-CN" }),
    });
    await assert.rejects(handleAiApi(invalidLanguageRequest, db, new URL(invalidLanguageRequest.url)), /only for translation/u);
    const previewRequest = new Request("https://app.example.com/api/documents/custom-doc/derived-preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "summary", revision: 2, customPrompt: prompt }),
    });
    const preview = (await handleAiApi(previewRequest, db, new URL(previewRequest.url)))?.body as DerivedPreview;
    assert.equal(preview.customPrompt, prompt);
    assert.match(preview.promptVersion, /^cloud-custom-v1-[a-f0-9]{64}-p40000$/u);
    assert.equal(preview.coverage.sourceChars, preview.coverage.sentChars);
    const staleTaskRequest = new Request("https://app.example.com/api/documents/custom-doc/derived-task", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Zhiye-LLM-Key": "test-key" },
      body: JSON.stringify({ type: "summary", customPrompt: `${prompt} Changed`, revision: 2, inputHash: preview.inputHash, sendHash: preview.sendHash, settingsRevision: 3 }),
    });
    await assert.rejects(handleAiApi(staleTaskRequest, db, new URL(staleTaskRequest.url)), /stale/u);
    const taskRequest = new Request("https://app.example.com/api/documents/custom-doc/derived-task", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Zhiye-LLM-Key": "test-key" },
      body: JSON.stringify({ type: "summary", customPrompt: prompt, revision: 2, inputHash: preview.inputHash, sendHash: preview.sendHash, settingsRevision: 3 }),
    });
    const result = await handleAiApi(taskRequest, db, new URL(taskRequest.url));
    assert.equal(result?.status, 201);
    const messages = requestBody.messages as Array<{ content: string }>;
    assert.match(messages[0]!.content, /weakest assumption/u);
    assert.match(messages[1]!.content, /A claim and its assumptions/u);
    const saved = (result?.body as { result: Record<string, unknown> }).result;
    assert.match(String(saved.promptVersion), /^cloud-custom-v1-/u);
    assert.equal(JSON.stringify(saved).includes(prompt), false);
    const pinRow = { ...saved, usageJson: null, pinned: 0, sourceRevision: 2 };
    let pinBatchSize = 0;
    const pinDb = {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first<T>() {
            if (sql.includes("llm_settings")) return settings as T;
            if (sql.includes("cloud_documents")) return document as T;
            if (sql.includes("cloud_derived_results")) return pinRow as T;
            return null;
          },
          async all<T>() { return { results: [] as T[], meta: { changes: 0 } }; },
          async run<T>() { return { results: [] as T[], meta: { changes: 1 } }; },
        };
      },
      async batch(statements: D1Statement[]) { pinBatchSize = statements.length; pinRow.pinned = 1; return []; },
    };
    const pinRequest = new Request(`https://app.example.com/api/documents/custom-doc/derived-results/${saved.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: true }),
    });
    await assert.rejects(handleAiApi(pinRequest, pinDb, new URL(pinRequest.url)), /Only predefined summaries/u);
    pinRow.promptVersion = "cloud-summary-v1-p40000";
    const pinPresetRequest = new Request(`https://app.example.com/api/documents/custom-doc/derived-results/${saved.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: true }),
    });
    const pinned = await handleAiApi(pinPresetRequest, pinDb, new URL(pinPresetRequest.url));
    assert.equal(pinBatchSize, 2);
    assert.equal((pinned?.body as { pinned: boolean }).pinned, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloud translation disables DeepSeek thinking and reserves a complete output budget", async () => {
  const originalFetch = globalThis.fetch;
  const settings = {
    value: JSON.stringify({ enabled: true, target: "remote", remote: { endpointUrl: "https://api.deepseek.com/chat/completions", model: "deepseek-v4-flash" }, local: { endpointUrl: "", model: "", trusted: false } }),
    revision: 4,
  };
  const document = {
    id: "translation-doc", sourceUrl: "https://example.com/", finalUrl: "https://example.com/", canonicalUrl: "https://example.com/",
    title: "Hello", author: null, status: "ready", revision: 2, createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z", publishedAt: null, markdown: "# Hello\n\nRead [the docs](https://example.com/docs).", sourceNote: "test",
  };
  const db = {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first<T>() {
          if (sql.includes("llm_settings")) return settings as T;
          if (sql.includes("cloud_documents")) return document as T;
          if (sql.includes("data_epoch")) return { value: "cloud-test" } as T;
          return null;
        },
        async all<T>() { return { results: [] as T[], meta: { changes: 0 } }; },
        async run<T>() { return { results: [] as T[], meta: { changes: 1 } }; },
      };
    },
  };
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const messages = requestBody.messages as Array<{ content: string }>;
    const pieces = JSON.parse(messages[1]!.content) as Array<{ id: string; text: string }>;
    const content = JSON.stringify(pieces.map(({ id, text }) => ({ id, text: `译${text}` })));
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const previewRequest = new Request("https://app.example.com/api/documents/translation-doc/derived-preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "translation", revision: 2, targetLanguage: "zh-CN" }),
    });
    const preview = (await handleAiApi(previewRequest, db, new URL(previewRequest.url)))?.body as Record<string, unknown>;
    const taskRequest = new Request("https://app.example.com/api/documents/translation-doc/derived-task", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Zhiye-LLM-Key": "test-key" },
      body: JSON.stringify({ type: "translation", revision: 2, targetLanguage: "zh-CN", inputHash: preview.inputHash, sendHash: preview.sendHash, settingsRevision: 4 }),
    });
    const result = await handleAiApi(taskRequest, db, new URL(taskRequest.url));
    assert.equal(result?.status, 201);
    assert.match(String((result?.body as { result: { output: string } }).result.output), /^# 译Hello/mu);
    assert.match(String((result?.body as { result: { output: string } }).result.output), /\]\(https:\/\/example\.com\/docs\)/u);
    assert.equal(requestBody.max_tokens, 16_384);
    assert.deepEqual(requestBody.thinking, { type: "disabled" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloud capture resolves a public target before queueing", async () => {
  const originalFetch = globalThis.fetch;
  let queued: unknown = null;
  globalThis.fetch = async () => new Response(JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }));
  const env = environment();
  env.CAPTURE_QUEUE = { async send(value) { queued = value; } };
  try {
    const request = new Request("https://app.example.com/api/documents", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: '{"url":"https://example.com/article"}',
    });
    const result = await createCapture(await request.json() as Record<string, unknown>, env, "cloud-test");
    assert.equal(result.created, true);
    assert.equal(result.document.status, "queued");
    assert.deepEqual(queued, { id: result.document.id, url: "https://example.com/article", epoch: "cloud-test" });
  } finally { globalThis.fetch = originalFetch; }
});

test("cloud capture publishes the document and removes its job in one D1 batch", async () => {
  const originalFetch = globalThis.fetch;
  const runtime = globalThis as typeof globalThis & { HTMLRewriter?: new () => {
    on(...args: unknown[]): unknown;
    transform(response: Response): Response;
  } };
  const originalRewriter = runtime.HTMLRewriter;
  runtime.HTMLRewriter = class {
    on() { return this; }
    transform(response: Response) { return response; }
  };
  globalThis.fetch = async (input) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return target.startsWith("https://cloudflare-dns.com/")
      ? new Response(JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }))
      : new Response("<h1>Captured</h1>", { headers: { "Content-Type": "text/html" } });
  };
  let batchSql: string[] = [];
  let acked = false;
  let jobDeleted = false;
  const env = environment();
  env.DB = {
    prepare(sql: string) {
      const statement = {
        sql,
        bind() { return statement; },
        async first<T>() {
          return (sql.includes("data_epoch") ? { value: "cloud-test" } : sql.includes("FROM cloud_capture_jobs WHERE id") ? {
            id: "job-1", url: "https://example.com/article", status: "queued", errorCode: null, folderId: null,
            revision: 1, deletedAt: jobDeleted ? "2026-08-18T00:00:00.000Z" : null,
            createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z",
          } : null) as T | null;
        },
        async all<T>() { return { results: [] as T[], meta: { changes: 0 } }; },
        async run<T>() {
          assert.doesNotMatch(sql, /INSERT INTO cloud_documents|DELETE FROM cloud_capture_jobs/u);
          return { results: [] as T[], meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(statements) {
      batchSql = statements.map((statement) => (statement as unknown as { sql: string }).sql);
      return statements.map(() => ({ results: [], meta: { changes: 1 } }));
    },
  };
  env.BROWSER = { async quickAction() { return new Response(JSON.stringify({ success: true, result: "# Captured" })); } };
  try {
    await handleCaptureQueue({ messages: [{
      body: { id: "job-1", url: "https://example.com/article", epoch: "cloud-test" },
      ack() { acked = true; }, retry() {},
    }] }, env);
    assert.equal(acked, true);
    assert.equal(batchSql.length, 3);
    assert.match(batchSql[0]!, /data_epoch/u);
    assert.match(batchSql[1]!, /INSERT INTO cloud_documents/u);
    assert.match(batchSql[1]!, /job\.revision \+ 1/u);
    assert.match(batchSql[2]!, /DELETE FROM cloud_capture_jobs/u);
    jobDeleted = true;
    batchSql = [];
    acked = false;
    await handleCaptureQueue({ messages: [{
      body: { id: "job-1", url: "https://example.com/article", epoch: "cloud-test" },
      ack() { acked = true; }, retry() {},
    }] }, env);
    assert.equal(acked, true);
    assert.deepEqual(batchSql, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRewriter) runtime.HTMLRewriter = originalRewriter;
    else delete runtime.HTMLRewriter;
  }
});

test("cloud capture consumes a publisher Markdown alternate before Browser Run", async () => {
  const originalFetch = globalThis.fetch;
  const envData = sqliteEnvironment();
  const { env, db } = envData;
  const id = "markdown-job";
  db.sqlite.prepare(`INSERT INTO cloud_capture_jobs(
    id, url, status, error_code, folder_id, revision, created_at, updated_at
  ) VALUES (?, ?, 'queued', NULL, NULL, 1, ?, ?)`)
    .run(id, "https://example.com/article", "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
  env.BROWSER = { async quickAction() { throw new Error("Browser Run should not be called"); } };
  let acked = false;
  globalThis.fetch = async (input) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (target.startsWith("https://cloudflare-dns.com/")) {
      return new Response(JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }));
    }
    if (target === "https://example.com/article") {
      return new Response('<link rel="alternate" type="text/markdown" href="/article.md">', { headers: { "Content-Type": "text/html" } });
    }
    if (target === "https://example.com/article.md") {
      return new Response("# Markdown source\n\nDirect publisher Markdown.", { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  try {
    await handleCaptureQueue({ messages: [{
      body: { id, url: "https://example.com/article", epoch: "cloud-1" },
      ack() { acked = true; },
      retry() { throw new Error("capture should not retry"); },
    }] }, env);
    assert.equal(acked, true);
    const document = db.sqlite.prepare("SELECT title, markdown, source_note, final_url FROM cloud_documents WHERE id = ?").get(id) as {
      title: string; markdown: string; source_note: string; final_url: string;
    };
    assert.equal(document.title, "Markdown source");
    assert.match(document.markdown, /Direct publisher Markdown/u);
    assert.equal(document.source_note, "Cloudflare Markdown");
    assert.equal(document.final_url, "https://example.com/article");
  } finally {
    globalThis.fetch = originalFetch;
    db.sqlite.close();
  }
});

test("cloud capture accepts a direct Markdown response", async () => {
  const originalFetch = globalThis.fetch;
  const { env, db } = sqliteEnvironment();
  const id = "direct-markdown-job";
  db.sqlite.prepare(`INSERT INTO cloud_capture_jobs(
    id, url, status, error_code, folder_id, revision, created_at, updated_at
  ) VALUES (?, ?, 'queued', NULL, NULL, 1, ?, ?)`)
    .run(id, "https://example.com/article.md", "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
  env.BROWSER = { async quickAction() { throw new Error("Browser Run should not be called"); } };
  let acked = false;
  globalThis.fetch = async (input) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (target.startsWith("https://cloudflare-dns.com/")) {
      return new Response(JSON.stringify({ Answer: [{ type: 1, data: "93.184.216.34" }] }));
    }
    if (target === "https://example.com/article.md") {
      return new Response("# Direct Markdown\n\nNo Browser Run needed.", { headers: { "Content-Type": "text/markdown" } });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  try {
    await handleCaptureQueue({ messages: [{
      body: { id, url: "https://example.com/article.md", epoch: "cloud-1" },
      ack() { acked = true; },
      retry() { throw new Error("capture should not retry"); },
    }] }, env);
    assert.equal(acked, true);
    const document = db.sqlite.prepare("SELECT title, markdown, source_note FROM cloud_documents WHERE id = ?").get(id) as {
      title: string; markdown: string; source_note: string;
    };
    assert.equal(document.title, "Direct Markdown");
    assert.match(document.markdown, /No Browser Run needed/u);
    assert.equal(document.source_note, "Cloudflare Markdown");
  } finally {
    globalThis.fetch = originalFetch;
    db.sqlite.close();
  }
});

test("cloud editing increments revision and rejects a stale writer", async () => {
  let row = {
    id: "doc-1", sourceUrl: "https://example.com/", finalUrl: "https://example.com/", canonicalUrl: "https://example.com/",
    title: "Old", author: null, status: "ready" as const, folderId: null, revision: 1, createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z", publishedAt: null, markdown: "Old body", sourceNote: "clip",
  };
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { bound = values; return statement; },
        async first<T>() { return (sql.includes("cloud_folders") ? null : row) as T | null; },
        async all<T>() { return { results: [] as T[], meta: { changes: 0 } }; },
        async run<T>() {
          if (sql.startsWith("UPDATE cloud_documents") && bound[3] === row.id && bound[4] === row.revision) {
            row = { ...row, title: String(bound[0]), markdown: String(bound[1]), updatedAt: String(bound[2]), revision: row.revision + 1 };
            return { results: [] as T[], meta: { changes: 1 } };
          }
          return { results: [] as T[], meta: { changes: 0 } };
        },
      };
      return statement;
    },
  };
  const updated = await updateDocument(db, row.id, { title: "New", markdown: "New body", revision: 1 });
  assert.equal(updated?.revision, 2);
  assert.equal(updated?.markdown, "New body");
  await assert.rejects(
    updateDocument(db, row.id, { title: "Stale", markdown: "Lost", revision: 1 }),
    (error: unknown) => error instanceof CloudHttpError && error.code === "DOCUMENT_CONFLICT" && error.document !== undefined,
  );
  await assert.rejects(
    updateDocument(db, row.id, { folderId: "missing-folder", revision: row.revision }),
    (error: unknown) => error instanceof CloudHttpError && error.code === "INVALID_FOLDER_ID",
  );
});

test("cloud folder movement reports revision conflicts before a missing target", async () => {
  const row = {
    id: "doc-conflict", sourceUrl: "https://example.com/", finalUrl: null, canonicalUrl: null,
    title: "Current", author: null, status: "ready" as const, folderId: null, revision: 2,
    createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z",
    publishedAt: null, markdown: "Current", sourceNote: "test",
  };
  const db = {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first<T>() {
          if (sql.includes("FROM cloud_folders f WHERE")) return null;
          if (sql.includes("cloud_documents")) return row as T;
          return null;
        },
        async all<T>() { return { results: [] as T[], meta: { changes: 0 } }; },
        async run<T>() { return { results: [] as T[], meta: { changes: 0 } }; },
      };
    },
  };
  await assert.rejects(
    updateDocument(db, row.id, { revision: 1, folderId: "missing" }),
    (error: unknown) => error instanceof CloudHttpError && error.code === "DOCUMENT_CONFLICT" && error.document !== undefined,
  );
  await assert.rejects(
    updateDocument(db, row.id, { revision: 2, folderId: "missing" }),
    (error: unknown) => error instanceof CloudHttpError && error.code === "INVALID_FOLDER_ID",
  );
});

test("cloud writes bind their epoch check to the same D1 batch", async () => {
  let epoch = "cloud-old";
  let writes = 0;
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        sql,
        get bound() { return bound; },
        bind(...values: unknown[]) { bound = values; return statement; },
        async first<T>() { return (sql.includes("data_epoch") ? { value: epoch } : null) as T | null; },
        async all<T>() { return { results: [] as T[], meta: { changes: 0 } }; },
        async run<T>() { writes += 1; return { results: [] as T[], meta: { changes: 1 } }; },
      };
      return statement;
    },
    async batch(statements: Array<{ sql: string; bound: unknown[] }>) {
      if (statements[0]?.bound[0] !== epoch) throw new Error("invalid epoch");
      for (const statement of statements.slice(1)) {
        if (/^(?:INSERT|UPDATE|DELETE)/u.test(statement.sql.trim())) writes += 1;
      }
      return statements.map(() => ({ results: [], meta: { changes: 1 } }));
    },
  };
  const guarded = epochGuardedDatabase(db, "cloud-old");
  epoch = "cloud-new";
  await assert.rejects(
    guarded.prepare("UPDATE cloud_documents SET title = title").run(),
    (error: unknown) => error instanceof CloudHttpError && error.code === "STALE_DATA_EPOCH",
  );
  assert.equal(writes, 0);
  epoch = "cloud-old";
  await guarded.prepare("UPDATE cloud_documents SET title = title").run();
  assert.equal(writes, 1);
});

test("expired cloud restore recovery releases the epoch and fails pending capture jobs", async () => {
  let batchSql: string[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        sql,
        bind() { return statement; },
        async first<T>() { return null as T | null; },
        async all<T>() { return { results: [] as T[], meta: { changes: 0 } }; },
        async run<T>() { return { results: [] as T[], meta: { changes: 0 } }; },
      };
      return statement;
    },
    async batch(statements: Array<{ sql: string }>) {
      batchSql = statements.map(({ sql }) => sql);
      return statements.map((_, index) => ({ results: [], meta: { changes: index === 1 ? 1 : 2 } }));
    },
  };
  const recovered = await recoverExpiredRestore(db, `restore:${Date.now() - 1}:crashed`);
  assert.match(String(recovered), /^cloud-/u);
  assert.match(batchSql[0]!, /status IN \('queued', 'fetching'\)/u);
  assert.match(batchSql[0]!, /RESTORE_INTERRUPTED/u);
  assert.match(batchSql[1]!, /value = \?/u);
});

test("cloud backup reader accepts strict v1 through v4 archives and rejects extra fields", async () => {
  const base = { format: "zhiye-cloud-backup", createdAt: "2026-08-18T00:00:00.000Z", documents: [], derivedResults: [], llmSettings: null };
  for (const archive of [{ ...base, version: 1 }, { ...base, version: 2, folders: [] }, { ...base, version: 3, folders: [] }, { ...base, version: 4, folders: [] }]) {
    const response = await handleRequest(new Request("https://app.example.com/api/data-safety/backups/import", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.zhiye.cloud-backup+json", "X-Zhiye-Data-Epoch": "cloud-test" },
      body: JSON.stringify(archive),
    }), environment());
    assert.equal(response.status, 201);
  }
  const folder = { id: "folder-1", name: "Research", created_at: "2026-08-18T00:00:00.000Z", updated_at: "2026-08-18T00:00:00.000Z" };
  const document = {
    id: "document-1", source_url: "https://example.com/article", final_url: null, canonical_url: null,
    title: "Article", author: null, published_at: null, markdown: "# Article", status: "ready",
    source_note: "clip", folder_id: folder.id, revision: 1,
    created_at: "2026-08-18T00:00:00.000Z", updated_at: "2026-08-18T00:00:00.000Z",
  };
  const populated = await handleRequest(new Request("https://app.example.com/api/data-safety/backups/import", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.zhiye.cloud-backup+json", "X-Zhiye-Data-Epoch": "cloud-test" },
    body: JSON.stringify({ ...base, version: 2, folders: [folder], documents: [document] }),
  }), environment());
  assert.equal(populated.status, 201);
  const populatedV3 = await handleRequest(new Request("https://app.example.com/api/data-safety/backups/import", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.zhiye.cloud-backup+json", "X-Zhiye-Data-Epoch": "cloud-test" },
    body: JSON.stringify({ ...base, version: 3, folders: [folder], documents: [{ ...document, deleted_at: "2026-08-18T00:00:00.000Z" }] }),
  }), environment());
  assert.equal(populatedV3.status, 201);
  const populatedV4 = await handleRequest(new Request("https://app.example.com/api/data-safety/backups/import", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.zhiye.cloud-backup+json", "X-Zhiye-Data-Epoch": "cloud-test" },
    body: JSON.stringify({ ...base, version: 4, folders: [folder], documents: [{ ...document, deleted_at: null, favorite: 1 }] }),
  }), environment());
  assert.equal(populatedV4.status, 201);
  const invalid = await handleRequest(new Request("https://app.example.com/api/data-safety/backups/import", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.zhiye.cloud-backup+json", "X-Zhiye-Data-Epoch": "cloud-test" },
    body: JSON.stringify({ ...base, version: 2, folders: [], unexpected: true }),
  }), environment());
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { error: { code: string } }).error.code, "INVALID_BACKUP_ARCHIVE");
  const invalidRow = await handleRequest(new Request("https://app.example.com/api/data-safety/backups/import", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.zhiye.cloud-backup+json", "X-Zhiye-Data-Epoch": "cloud-test" },
    body: JSON.stringify({ ...base, version: 2, folders: [null] }),
  }), environment());
  assert.equal(invalidRow.status, 400);
  assert.equal((await invalidRow.json() as { error: { code: string } }).error.code, "INVALID_BACKUP_ARCHIVE");
  for (const invalidDocument of [
    { ...document, folder_id: "missing" },
    { ...document, revision: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const response = await handleRequest(new Request("https://app.example.com/api/data-safety/backups/import", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.zhiye.cloud-backup+json", "X-Zhiye-Data-Epoch": "cloud-test" },
      body: JSON.stringify({ ...base, version: 2, folders: [folder], documents: [invalidDocument] }),
    }), environment());
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "INVALID_BACKUP_ARCHIVE");
  }
  const invalidDeletedAt = await handleRequest(new Request("https://app.example.com/api/data-safety/backups/import", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.zhiye.cloud-backup+json", "X-Zhiye-Data-Epoch": "cloud-test" },
    body: JSON.stringify({ ...base, version: 3, folders: [folder], documents: [{ ...document, deleted_at: "yesterday" }] }),
  }), environment());
  assert.equal(invalidDeletedAt.status, 400);
});

test("cloud backup export carries referenced images and import stages them back", async () => {
  const { env, db, bucket, imagesBucket } = sqliteEnvironment();
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const hash = createHash("sha256").update(png).digest("hex");
  const now = "2026-08-18T00:00:00.000Z";
  db.sqlite.prepare(`INSERT INTO cloud_documents(
    id, source_url, final_url, canonical_url, title, author, published_at, markdown, status, source_note,
    revision, created_at, updated_at, folder_id
  ) VALUES (?, ?, NULL, NULL, ?, NULL, NULL, ?, 'ready', '', 1, ?, ?, NULL)`)
    .run("doc-img", "https://example.com/img", "Img", `# Img\n\n![pic](zhiye://asset/${hash})`, now, now);
  db.sqlite.prepare(`INSERT INTO cloud_documents(
    id, source_url, final_url, canonical_url, title, author, published_at, markdown, status, source_note,
    revision, created_at, updated_at, folder_id
  ) VALUES (?, ?, NULL, NULL, ?, NULL, NULL, ?, 'ready', '', 1, ?, ?, NULL)`)
    .run("doc-img-copy", "https://example.com/img", "Img copy", "# Img copy", now, now);
  await imagesBucket.put(hash, png, { httpMetadata: { contentType: "image/png" } });
  const epoch = String((db.sqlite.prepare("SELECT value FROM app_settings WHERE key = 'data_epoch'").get() as { value: string }).value);

  const created = await handleRequest(new Request("https://app.example.com/api/data-safety/backups", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": epoch }, body: "{}",
  }), env);
  assert.equal(created.status, 201);
  const backupId = (await created.json() as { id: string }).id;
  const stored = JSON.parse(new TextDecoder().decode(bucket.objects.get(`backups/${backupId}.zhiye-cloud-backup`)!.bytes)) as {
    documents: Array<{ source_url: string }>;
  };
  assert.equal(new Set(stored.documents.map(({ source_url }) => source_url)).size, 1);

  const exported = await handleRequest(new Request(`https://app.example.com/api/data-safety/backups/${backupId}/export.zhiye-backup`), env);
  assert.equal(exported.status, 200);
  const exportedBytes = new Uint8Array(await exported.arrayBuffer());
  const unpacked = unzipSync(exportedBytes);
  const manifest = JSON.parse(new TextDecoder().decode(unpacked["manifest.json"]!)) as {
    version: number;
    assets: Array<{ hash: string; mime: string; bytes: number }>;
    documents: Array<{ source_url: string }>;
  };
  assert.equal(manifest.version, 5);
  assert.deepEqual(manifest.assets, [{ hash, mime: "image/png", bytes: png.byteLength }]);
  assert.equal(new Set(manifest.documents.map(({ source_url }) => source_url)).size, 2);
  assert.ok(manifest.documents.some(({ source_url }) => source_url.includes("#zhiye-cloud-copy-doc-img-copy")));
  assert.deepEqual(unpacked[`assets/${hash}`], png);

  // Import must stage the asset bytes back into the image store.
  imagesBucket.objects.delete(hash);
  assert.equal(imagesBucket.objects.has(hash), false);
  const imported = await handleRequest(new Request("https://app.example.com/api/data-safety/backups/import", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.zhiye.cloud-backup+zip", "X-Zhiye-Data-Epoch": epoch },
    body: exportedBytes,
  }), env);
  assert.equal(imported.status, 201);
  assert.ok(imagesBucket.objects.has(hash), "import staged the referenced image back into R2");
});

function insertCapturedDocument(database: ReturnType<typeof sqliteEnvironment>["db"], id: string, title: string, markdown: string) {
  database.sqlite.prepare(`INSERT INTO cloud_documents(
    id, source_url, final_url, canonical_url, title, author, published_at, markdown, status, source_note, revision, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 'ready', '测试', 1, ?, ?)`).run(
    id, "https://x.com/i/status/1", "https://x.com/i/status/1", "https://x.com/i/status/1", title, markdown,
    "2026-09-10T00:00:00.000Z", "2026-09-10T00:00:00.000Z",
  );
}

function setCloudAiEnabled(database: ReturnType<typeof sqliteEnvironment>["db"], enabled: boolean) {
  database.sqlite.prepare("UPDATE app_settings SET value = ?, revision = revision + 1 WHERE key = 'llm_settings'").run(JSON.stringify({
    enabled,
    target: "remote",
    remote: { endpointUrl: "https://api.openai.com/v1/chat/completions", model: "title-model" },
    local: { endpointUrl: "", model: "", trusted: false },
  }));
}

function autoTitleRequest(id: string, headers: Record<string, string> = {}) {
  return new Request(`https://app.example.com/api/documents/${id}/auto-title`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": "cloud-1", "X-Zhiye-LLM-Key": "page-scoped-key", ...headers },
    body: JSON.stringify({ revision: 1 }),
  });
}

function titleReply(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), {
    headers: { "Content-Type": "application/json" },
  });
}

test("cloud auto-title replaces a captured title through the configured model", async () => {
  const originalFetch = globalThis.fetch;
  const { env, db } = sqliteEnvironment();
  setCloudAiEnabled(db, true);
  insertCapturedDocument(db, "tweet-doc", "Post by @MaxForAI on X", "# Post by @MaxForAI on X\n\n新模型发布了。");
  let sentPrompt = "";
  let authorization = "";
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("Authorization") || "";
    sentPrompt = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[1]!.content;
    return titleReply("「新模型发布」");
  };
  try {
    const response = await handleRequest(autoTitleRequest("tweet-doc"), env);
    assert.equal(response.status, 200);
    const body = await response.json() as { title: string; revision: number };
    assert.equal(body.title, "新模型发布");
    assert.equal(body.revision, 2);
    assert.equal(authorization, "Bearer page-scoped-key");
    assert.match(sentPrompt, /新模型发布了/u);
    const stored = db.sqlite.prepare("SELECT title, revision FROM cloud_documents WHERE id = ?").get("tweet-doc") as { title: string; revision: number };
    assert.equal(stored.title, "新模型发布");
    assert.equal(stored.revision, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloud auto-title asks the model to redo a reply that missed the cap", async () => {
  const originalFetch = globalThis.fetch;
  const { env, db } = sqliteEnvironment();
  setCloudAiEnabled(db, true);
  insertCapturedDocument(db, "chatty-doc", "Post by @MaxForAI on X", "# Post by @MaxForAI on X\n\n新模型发布了。");
  const replies = ["这一篇文章主要介绍了某个模型的最新进展和相关讨论", "新模型发布"];
  const sent: Array<{ system: string; user: string }> = [];
  globalThis.fetch = async (_input, init) => {
    const messages = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages;
    sent.push({ system: messages[0]!.content, user: messages[1]!.content });
    return titleReply(replies.shift()!);
  };
  try {
    const response = await handleRequest(autoTitleRequest("chatty-doc"), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { title: string }).title, "新模型发布");
    assert.equal(sent.length, 2);
    assert.match(sent[1]!.system, /上一次的回答不能直接用作标题/u);
    assert.match(sent[1]!.user, /这一篇文章主要介绍了某个模型的最新进展和相关讨论/u);
    assert.match(sent[1]!.user, /新模型发布了/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloud auto-title stays inert while cloud AI is disabled", async () => {
  const originalFetch = globalThis.fetch;
  const { env, db } = sqliteEnvironment();
  insertCapturedDocument(db, "quiet-doc", "Post by @MaxForAI on X", "# Post by @MaxForAI on X");
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return titleReply("不应出现"); };
  try {
    const response = await handleRequest(autoTitleRequest("quiet-doc"), env);
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "LLM_DISABLED");
    assert.equal(calls, 0);
    assert.equal((db.sqlite.prepare("SELECT title FROM cloud_documents WHERE id = ?").get("quiet-doc") as { title: string }).title, "Post by @MaxForAI on X");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function pairedClipRequest(token: string, markdown: string, llmKey?: string) {
  return new Request("https://clip.example.com/api/browser-extension/clips", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": `chrome-extension://${"a".repeat(32)}`,
      "Authorization": `Bearer ${token}`,
      ...(llmKey ? { "X-Zhiye-LLM-Key": llmKey } : {}),
    },
    body: JSON.stringify({ sourceUrl: "https://x.com/i/status/1", title: "Post by @MaxForAI on X", markdown }),
  });
}

function pairExtension(database: ReturnType<typeof sqliteEnvironment>["db"], token: string) {
  database.sqlite.prepare("INSERT INTO browser_extension_pairings(id, browser, token_hash, created_at) VALUES (?, ?, ?, ?)").run(
    "pair-1", "chrome", createHash("sha256").update(token, "utf8").digest("hex"), "2026-09-10T00:00:00.000Z",
  );
}

test("clip auto-title uses the key the extension opted into", async () => {
  const originalFetch = globalThis.fetch;
  const { env, db } = sqliteEnvironment();
  setCloudAiEnabled(db, true);
  const token = "A".repeat(43);
  pairExtension(db, token);
  let authorization = "";
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("Authorization") || "";
    return titleReply("新模型发布");
  };
  try {
    const response = await handleClipRequest(pairedClipRequest(token, "# Post by @MaxForAI on X\n\n新模型发布了。", "extension-key"), env);
    assert.equal(response.status, 201);
    const { documentId, aiTitleError } = await response.json() as { documentId: string; aiTitleError: string | null };
    assert.equal(aiTitleError, null);
    assert.equal(authorization, "Bearer extension-key");
    assert.equal((db.sqlite.prepare("SELECT title FROM cloud_documents WHERE id = ?").get(documentId) as { title: string }).title, "新模型发布");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clip reports a title it could not generate and keeps the captured one", async () => {
  const originalFetch = globalThis.fetch;
  const { env, db } = sqliteEnvironment();
  setCloudAiEnabled(db, true);
  const token = "A".repeat(43);
  pairExtension(db, token);
  globalThis.fetch = async () => titleReply("AI Weekly Roundup");
  try {
    const response = await handleClipRequest(pairedClipRequest(token, "# Post by @MaxForAI on X", "extension-key"), env);
    assert.equal(response.status, 201);
    const { documentId, aiTitleError } = await response.json() as { documentId: string; aiTitleError: string | null };
    assert.equal(aiTitleError, "TITLE_UNUSABLE");
    assert.equal((db.sqlite.prepare("SELECT title FROM cloud_documents WHERE id = ?").get(documentId) as { title: string }).title, "Post by @MaxForAI on X");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clip reports an unusable AI key instead of claiming the title succeeded", async () => {
  const originalFetch = globalThis.fetch;
  const { env, db } = sqliteEnvironment();
  setCloudAiEnabled(db, true);
  const token = "A".repeat(43);
  pairExtension(db, token);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return titleReply("新模型发布"); };
  try {
    const response = await handleClipRequest(pairedClipRequest(token, "# Post by @MaxForAI on X", "k".repeat(17_000)), env);
    assert.equal(response.status, 201);
    const { documentId, aiTitleError } = await response.json() as { documentId: string; aiTitleError: string | null };
    assert.equal(aiTitleError, "LLM_KEY_INVALID");
    assert.equal(calls, 0);
    assert.equal((db.sqlite.prepare("SELECT title FROM cloud_documents WHERE id = ?").get(documentId) as { title: string }).title, "Post by @MaxForAI on X");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clip rejects an unpaired token before spending a provider request", async () => {
  const originalFetch = globalThis.fetch;
  const { env, db } = sqliteEnvironment();
  setCloudAiEnabled(db, true);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return titleReply("不应出现"); };
  try {
    const response = await handleClipRequest(pairedClipRequest("B".repeat(43), "# Post by @MaxForAI on X", "extension-key"), env);
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
    assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM cloud_documents").get() as { count: number }).count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clip without an AI key never calls the model and keeps the captured title", async () => {
  const originalFetch = globalThis.fetch;
  const { env, db } = sqliteEnvironment();
  setCloudAiEnabled(db, true);
  const token = "A".repeat(43);
  pairExtension(db, token);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return titleReply("不应出现"); };
  try {
    const response = await handleClipRequest(pairedClipRequest(token, "# Post by @MaxForAI on X"), env);
    assert.equal(response.status, 201);
    const { documentId } = await response.json() as { documentId: string };
    assert.equal(calls, 0);
    assert.equal((db.sqlite.prepare("SELECT title FROM cloud_documents WHERE id = ?").get(documentId) as { title: string }).title, "Post by @MaxForAI on X");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloud paper batches narrow a reply that ran out of budget before writing anything", async () => {
  const originalFetch = globalThis.fetch;
  const sent: Array<{ images: number; page: number; thinking: unknown }> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { thinking?: unknown; messages: Array<{ content: unknown }> };
    const parts = body.messages[1]!.content as Array<{ type: string; text?: string }>;
    const instruction = String(parts[0]!.text);
    const range = /pages? (\d+)(?: to (\d+))?/u.exec(instruction)!;
    const page = Number(range[1]);
    const images = parts.filter((part) => part.type === "image_url").length;
    sent.push({ images, page, thinking: body.thinking ?? null });
    // A multi-page batch exhausts the output budget before emitting content; the
    // narrower range that the driver retries with fits.
    if (images > 1) {
      return new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "" } }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            pages: [{ pageNumber: page, blocks: [{ id: `p${page}-b1`, type: "paragraph", original: `original ${page}`, translation: `译文 ${page}`, assetIds: [] }] }],
          }),
        },
      }],
    }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const pages = [1, 2, 3, 4].map((pageNumber) => ({ pageNumber, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }));
    const outcome = await runPaperBatches(pages, false, async (batch, first, last, includeMetadata) => {
      try {
        return await completePaperImages(
          "https://api.deepseek.com/chat/completions",
          "deepseek-flash",
          "paper-secret",
          "system",
          batch,
          paperBatchInstruction(first, last, includeMetadata),
        );
      } catch (error) {
        // The driver only narrows when the runtime reports the failure code.
        throw new PaperBatchError(
          error instanceof CloudHttpError ? error.code : "PAPER_PROCESSING_FAILED",
          error instanceof Error ? error.message : "Paper extraction failed",
        );
      }
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.ok && outcome.pages.map((page) => page.pageNumber), [1, 2, 3, 4]);
    assert.deepEqual(sent.map((entry) => entry.images), [4, 2, 1, 1, 2, 1, 1]);
    // DeepSeek is asked not to spend the budget on reasoning before the JSON.
    assert.deepEqual(sent.map((entry) => entry.thinking), [
      { type: "disabled" }, { type: "disabled" }, { type: "disabled" }, { type: "disabled" },
      { type: "disabled" }, { type: "disabled" }, { type: "disabled" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
