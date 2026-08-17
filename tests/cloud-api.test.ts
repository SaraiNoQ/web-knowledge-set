import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest, type CloudEnv } from "../cloud/worker.js";
import { CloudHttpError, updateDocument } from "../cloud/extension.js";
import { handleAiApi } from "../cloud/ai.js";
import { createCapture } from "../cloud/capture.js";

const rows = new Map<string, { value: string; revision: number }>([
  ["data_epoch", { value: "cloud-test", revision: 0 }],
  ["onboarding", { value: '{"completed":true}', revision: 2 }],
  ["recent_filters", { value: "[]", revision: 3 }],
  ["llm_settings", { value: '{"enabled":false,"target":"remote","remote":{"endpointUrl":"https://api.openai.com/v1/chat/completions","model":""},"local":{"endpointUrl":"","model":"","trusted":false}}', revision: 0 }],
]);
let preparedSql: string[] = [];
let lastBackup = "";

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
  assert.equal((JSON.parse(lastBackup) as { format: string }).format, "zhiye-cloud-backup");

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

  const asset = await handleRequest(new Request("https://app.example.com/"), environment());
  assert.equal(asset.headers.get("X-Frame-Options"), "DENY");
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
    const result = await createCapture(request, env);
    assert.equal(result.created, true);
    assert.equal(result.document.status, "queued");
    assert.deepEqual(queued, { id: result.document.id, url: "https://example.com/article", epoch: "cloud-test" });
  } finally { globalThis.fetch = originalFetch; }
});

test("cloud editing increments revision and rejects a stale writer", async () => {
  let row = {
    id: "doc-1", sourceUrl: "https://example.com/", finalUrl: "https://example.com/", canonicalUrl: "https://example.com/",
    title: "Old", author: null, status: "ready" as const, revision: 1, createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z", publishedAt: null, markdown: "Old body", sourceNote: "clip",
  };
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { bound = values; return statement; },
        async first<T>() { return row as T; },
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
});
