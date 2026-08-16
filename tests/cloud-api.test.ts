import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest, type CloudEnv } from "../cloud/worker.js";

const rows = new Map<string, { value: string; revision: number }>([
  ["data_epoch", { value: "cloud-test", revision: 0 }],
  ["onboarding", { value: '{"completed":true}', revision: 2 }],
  ["recent_filters", { value: "[]", revision: 3 }],
]);
let preparedSql: string[] = [];

function environment(): CloudEnv {
  return {
    ASSETS: { fetch: async () => new Response("<main>cloud</main>", { headers: { "Content-Type": "text/html" } }) },
    DB: {
      prepare(sql: string) {
        preparedSql.push(sql);
        let key = sql.includes("data_epoch") ? "data_epoch" : "";
        const statement = {
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
    },
  };
}

test("cloud core serves the existing empty-library startup contract", async () => {
  const health = await handleRequest(new Request("https://app.example.com/health"), environment());
  assert.deepEqual(await health.json(), { ok: true, mode: "cloud-core" });

  const expected = new Map<string, unknown>([
    ["/api/settings/onboarding", { completed: true, revision: 2 }],
    ["/api/data-safety", { mode: "ready", maintenance: false, recoveryError: null, health: null, backups: [], settings: null }],
    ["/api/settings/recent-filters", { filters: [], revision: 3 }],
    ["/api/capture-queue", { paused: false, active: 0, queued: 0 }],
    ["/api/collections", []],
    ["/api/documents?sort=updated&page=1", { items: [], page: 1, pageSize: 30, total: 0 }],
    ["/api/tags", []],
  ]);

  for (const [path, body] of expected) {
    const response = await handleRequest(new Request(`https://app.example.com${path}`), environment());
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("X-Zhiye-Data-Epoch"), "cloud-test", path);
    assert.deepEqual(await response.json(), body, path);
  }

  const pending = await handleRequest(new Request("https://app.example.com/api/documents", { method: "POST" }), environment());
  assert.equal(pending.status, 501);
  assert.equal((await pending.json() as { error: { code: string } }).error.code, "CLOUD_FEATURE_PENDING");

  const pairingCode = await handleRequest(new Request("https://app.example.com/api/settings/browser-extension/pairing-code", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": "cloud-test" },
    body: "{}",
  }), environment());
  assert.equal(pairingCode.status, 201);
  assert.match((await pairingCode.json() as { code: string }).code, /^[A-Z2-9]{10}$/u);

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
