import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

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
import { handleAiApi } from "../cloud/ai.js";
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
  for (let version = 1; version <= 7; version += 1) {
    sqlite.exec(readFileSync(new URL(`../cloud/migrations/${String(version).padStart(4, "0")}_${[
      "cloud_core", "browser_extension", "cloud_ai", "cloud_backups", "cloud_capture", "cloud_folders", "cloud_trash",
    ][version - 1]}.sql`, import.meta.url), "utf8"));
  }
  return new SqliteD1Database(sqlite);
}

function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key: string, value: ArrayBuffer | Uint8Array | string) {
      objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value));
    },
    async get(key: string) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      const response = new Response(bytes);
      return {
        body: response.body!, size: bytes.byteLength, httpEtag: `"${key}"`,
        async arrayBuffer() { return await response.arrayBuffer(); },
      };
    },
    async head(key: string) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.byteLength } : null;
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
    },
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

function sqliteEnvironment(db = migratedCloudDatabase(), bucket = memoryBucket()) {
  const env: CloudEnv = {
    ASSETS: { fetch: async () => new Response("<main>cloud</main>", { headers: { "Content-Type": "text/html" } }) },
    BACKUPS: bucket,
    CAPTURE_QUEUE: { async send() {} },
    BROWSER: { async quickAction() { return new Response('{"success":true,"result":"# captured"}'); } },
    DB: db,
  };
  return { env, db, bucket };
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
    format: "zhiye-cloud-backup", version: 3, folders: [],
  });

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

test("cloud backup restores v3 trash, maps v1 documents to active unfiled, and rolls back failures", async () => {
  const { env, db } = sqliteEnvironment();
  const now = "2026-08-18T00:00:00.000Z";
  db.sqlite.prepare("INSERT INTO cloud_folders(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("folder-v2", "Research", now, now);
  db.sqlite.prepare(`INSERT INTO cloud_documents(
    id, source_url, final_url, canonical_url, title, author, published_at, markdown, status, source_note,
    revision, created_at, updated_at, folder_id
  ) VALUES (?, ?, NULL, NULL, ?, NULL, NULL, ?, 'ready', '', 1, ?, ?, ?)`)
    .run("document-v2", "https://example.com/v2", "V2", "# V2", now, now, "folder-v2");
  db.sqlite.prepare("UPDATE cloud_documents SET deleted_at = ? WHERE id = 'document-v2'").run(now);
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
  assert.equal((await exported.json() as { version: number }).version, 3);
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
    db.sqlite.prepare("SELECT id, folder_id, deleted_at FROM cloud_documents ORDER BY id").all().map((row) => ({ ...row })),
    [{ id: "document-v2", folder_id: "folder-v2", deleted_at: now }],
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
    const result = await createCapture(request, env, "cloud-test");
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

test("cloud backup reader accepts strict v1, v2 and v3 archives and rejects extra fields", async () => {
  const base = { format: "zhiye-cloud-backup", createdAt: "2026-08-18T00:00:00.000Z", documents: [], derivedResults: [], llmSettings: null };
  for (const archive of [{ ...base, version: 1 }, { ...base, version: 2, folders: [] }, { ...base, version: 3, folders: [] }]) {
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
