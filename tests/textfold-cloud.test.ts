import assert from "node:assert/strict";
import test from "node:test";
import { handleAiApi } from "../cloud/ai.js";
import { FOLD_REQUEST, readFold } from "../shared/textfold.js";
import type { DerivedPreview, DerivedTask } from "../shared/types.js";

test("cloud folding covers long articles and never saves invalid or stale evidence", async () => {
  const originalFetch = globalThis.fetch;
  const document = { id: "fold-doc", title: "Evidence", revision: 2, status: "ready", sourceUrl: "https://example.com/", markdown: Array.from({ length: 100 }, (_, i) => `## ${i}\n\n${"This is a carefully qualified result that still needs validation. ".repeat(8)}`).join("\n\n") };
  const settings = { value: JSON.stringify({ enabled: true, target: "remote", remote: { endpointUrl: "https://api.deepseek.com/chat/completions", model: "fold-test" }, local: { endpointUrl: "", model: "", trusted: false } }), revision: 3 };
  let inserted = 0, calls = 0, invalid = false, change = false, truncated = false;
  const db = { prepare(sql: string) { return {
    bind(..._values: unknown[]) { return this; },
    async first<T>() { return (sql.includes("llm_settings") ? settings : sql.includes("cloud_documents") ? document : sql.includes("data_epoch") ? { value: "test" } : null) as T | null; },
    async all<T>() { return { results: [] as T[], meta: { changes: 0 } }; },
    async run<T>() { inserted++; return { results: [] as T[], meta: { changes: 1 } }; },
  }; } };
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.match(body.messages[0].content, /untrusted data/);
    assert.equal(body.max_tokens, 8192);
    assert.deepEqual(body.thinking, { type: "disabled" });
    const units = JSON.parse(body.messages[1].content) as Array<{ id: string }>;
    if (change) { document.revision++; change = false; }
    return new Response(JSON.stringify({ choices: [{ finish_reason: truncated ? "length" : "stop", message: { content: JSON.stringify(units.map(({id}) => ({ id, evidence: [invalid ? 999 : 0], takeaway: "Result needs validation.", reason: "Evidence is limited.", topic: "Validation" }))) } }] }));
  };
  const preview = async () => {
    const request = new Request("https://app.example.com/api/documents/fold-doc/derived-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "summary", revision: document.revision, customPrompt: FOLD_REQUEST }) });
    return (await handleAiApi(request, db, new URL(request.url)))!.body as DerivedPreview;
  };
  const run = async () => {
    const p = await preview();
    assert.equal(p.coverage.truncated, false);
    assert.equal(p.coverage.sentChars, document.markdown.length);
    const request = new Request("https://app.example.com/api/documents/fold-doc/derived-task", { method: "POST", headers: { "Content-Type": "application/json", "X-Zhiye-LLM-Key": "test-key" }, body: JSON.stringify({ type: "summary", revision: document.revision, customPrompt: FOLD_REQUEST, settingsRevision: 3, inputHash: p.inputHash, sendHash: p.sendHash }) });
    return (await handleAiApi(request, db, new URL(request.url)))!.body as DerivedTask;
  };
  try {
    const task = await run();
    assert.ok(calls > 1);
    assert.equal(readFold(document.markdown, task.result!.output)!.entries.length, 100);
    assert.equal(inserted, 1);
    invalid = true;
    await assert.rejects(run(), /原句编号/);
    assert.equal(inserted, 1);
    invalid = false; truncated = true;
    await assert.rejects(run(), /output limit/);
    assert.equal(inserted, 1);
    truncated = false; change = true;
    await assert.rejects(run(), /Document changed/);
    assert.equal(inserted, 1);
  } finally { globalThis.fetch = originalFetch; }
});
