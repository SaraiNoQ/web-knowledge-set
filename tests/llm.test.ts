import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";
import {
  applyMarkdownTranslation,
  createDerivedTasks,
  markdownTranslationInput,
  resolveLlmTarget,
} from "../server/llm.js";
import type { DerivedPreview, DerivedResultType, DerivedTask, LlmSettings } from "../shared/types.js";

test("LLM API requires preview confirmation, reuses results, cancels, and disables atomically", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-llm-"));
  let calls = 0;
  let localAuthorization: string | undefined;
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const provider = createServer(async (request, response) => {
    calls += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    localAuthorization = request.headers.authorization;
    if (body.includes("CANCEL-ME")) await slow;
    response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "identity" });
    response.end(JSON.stringify({
      choices: [{ message: { content: body.includes("ECHO-SECRET")
        ? "test-key-not-persisted"
        : "## Safe summary\n\nGrounded output." } }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress !== "string");

  const database = openDatabase(join(root, "data"));
  const created = database.createOrGetDocument("https://example.com/llm").document;
  const longBody = `FRONT\n\n${"甲。\n\n".repeat(7_000)}MIDDLE\n\n${"B.\n\n".repeat(7_000)}TAIL`;
  const updated = database.updateDocument(created.id, created.revision, { title: "Long article", markdown: longBody });
  assert.equal(updated.kind, "updated");
  if (updated.kind !== "updated") return;

  const app = createApp({
    dataDir: join(root, "data"),
    database,
    bootstrapToken: "llm-bootstrap",
    sessionToken: "llm-session",
    llmApiKey: "test-key-not-persisted",
    startWorker: false,
  });
  const server = createServer((request, response) => void app.handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const launch = await fetch(`${base}/launch?token=llm-bootstrap`, { redirect: "manual" });
    const cookie = (launch.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const initial = await fetch(`${base}/api/settings/llm`, { headers: { Cookie: cookie } });
    const epoch = initial.headers.get("x-zhiye-data-epoch");
    assert.ok(epoch);
    assert.equal(((await initial.json()) as LlmSettings).enabled, false);
    const headers = {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
      "X-Zhiye-Data-Epoch": epoch,
    };
    const settingsResponse = await fetch(`${base}/api/settings/llm`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        enabled: true,
        target: "local",
        remote: { endpointUrl: "", model: "" },
        local: {
          endpointUrl: `http://127.0.0.1:${providerAddress.port}/v1/chat/completions`,
          model: "fake-model",
          trusted: true,
        },
        revision: 0,
      }),
    });
    assert.equal(settingsResponse.status, 200);
    const settings = (await settingsResponse.json()) as LlmSettings;
    assert.equal(settings.apiKeyConfigured, true);
    assert.equal(JSON.stringify(settings).includes("test-key-not-persisted"), false);

    const previewResponse = await fetch(`${base}/api/documents/${created.id}/derived-preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "summary", revision: updated.document.revision }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as DerivedPreview;
    assert.equal(preview.coverage.truncated, true);
    assert.ok(preview.coverage.sentChars < preview.coverage.sourceChars);
    assert.ok(preview.sentText.includes("FRONT"));
    assert.ok(preview.sentText.includes("MIDDLE"));
    assert.ok(preview.sentText.includes("TAIL"));
    assert.equal(preview.sentText.includes("\ud800") || preview.sentText.includes("\udfff"), false);

    const startBody = JSON.stringify({
      type: preview.type,
      revision: preview.revision,
      inputHash: preview.inputHash,
      settingsRevision: preview.settingsRevision,
    });
    assert.equal((await fetch(`${base}/api/documents/${created.id}/derived-task`, {
      method: "POST", headers, body: JSON.stringify({ ...JSON.parse(startBody), inputHash: "0".repeat(64) }),
    })).status, 409);
    const startedResponse = await fetch(`${base}/api/documents/${created.id}/derived-task`, {
      method: "POST", headers, body: startBody,
    });
    assert.equal(startedResponse.status, 202);
    const started = (await startedResponse.json()) as DerivedTask;
    const completed = await waitForTask(base, cookie, started.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.result?.usage?.totalTokens, 16);
    assert.equal(calls, 1);
    assert.equal(localAuthorization, undefined);

    const cachedResponse = await fetch(`${base}/api/documents/${created.id}/derived-task`, {
      method: "POST", headers, body: startBody,
    });
    assert.equal(cachedResponse.status, 200);
    const cachedTask = (await cachedResponse.json()) as DerivedTask;
    assert.equal(cachedTask.status, "succeeded");
    assert.equal(calls, 1);
    const deletedResult = await fetch(
      `${base}/api/documents/${created.id}/derived-results/${cachedTask.result!.id}`,
      { method: "DELETE", headers, body: "{}" },
    );
    assert.equal(deletedResult.status, 204);
    assert.equal((await fetch(`${base}/api/derived-tasks/${cachedTask.id}`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal(await (await fetch(`${base}/api/documents/${created.id}/derived-task`, { headers: { Cookie: cookie } })).json(), null);
    const regenerated = (await (await fetch(`${base}/api/documents/${created.id}/derived-task`, {
      method: "POST", headers, body: startBody,
    })).json()) as DerivedTask;
    assert.equal((await waitForTask(base, cookie, regenerated.id)).status, "succeeded");
    assert.equal(calls, 2);

    const current = database.getDocument(created.id)!;
    const echoed = database.updateDocument(created.id, current.revision, { markdown: "ECHO-SECRET" });
    assert.equal(echoed.kind, "updated");
    if (echoed.kind !== "updated") return;
    const echoPreview = (await (await fetch(`${base}/api/documents/${created.id}/derived-preview`, {
      method: "POST", headers,
      body: JSON.stringify({ type: "summary", revision: echoed.document.revision }),
    })).json()) as DerivedPreview;
    const echoTask = (await (await fetch(`${base}/api/documents/${created.id}/derived-task`, {
      method: "POST", headers,
      body: JSON.stringify({
        type: echoPreview.type, revision: echoPreview.revision, inputHash: echoPreview.inputHash,
        settingsRevision: echoPreview.settingsRevision,
      }),
    })).json()) as DerivedTask;
    const echoFailed = await waitForTask(base, cookie, echoTask.id);
    assert.equal(echoFailed.error?.code, "LLM_SECRET_ECHO");
    assert.equal(JSON.stringify(echoFailed).includes("test-key-not-persisted"), false);
    assert.equal(database.listDerivedResults(created.id)?.total, 1);

    const changed = database.updateDocument(created.id, echoed.document.revision, { markdown: "CANCEL-ME" });
    assert.equal(changed.kind, "updated");
    if (changed.kind !== "updated") return;
    const cancelPreview = (await (await fetch(`${base}/api/documents/${created.id}/derived-preview`, {
      method: "POST", headers,
      body: JSON.stringify({ type: "summary", revision: changed.document.revision }),
    })).json()) as DerivedPreview;
    const cancelling = (await (await fetch(`${base}/api/documents/${created.id}/derived-task`, {
      method: "POST", headers,
      body: JSON.stringify({
        type: cancelPreview.type,
        revision: cancelPreview.revision,
        inputHash: cancelPreview.inputHash,
        settingsRevision: cancelPreview.settingsRevision,
      }),
    })).json()) as DerivedTask;
    while (calls < 4) await new Promise((resolve) => setTimeout(resolve, 5));
    const cancelledResponse = await fetch(`${base}/api/derived-tasks/${cancelling.id}`, {
      method: "DELETE", headers, body: "{}",
    });
    releaseSlow();
    assert.equal(cancelledResponse.status, 200);
    assert.equal(((await cancelledResponse.json()) as DerivedTask).status, "cancelled");

    const disabledResponse = await fetch(`${base}/api/settings/llm/disable`, {
      method: "POST", headers,
      body: JSON.stringify({ revision: settings.revision, deleteResults: true }),
    });
    assert.equal(disabledResponse.status, 200);
    const disabled = await disabledResponse.json() as { settings: LlmSettings; deletedResults: number };
    assert.equal(disabled.settings.enabled, false);
    assert.equal(disabled.deletedResults, 1);
    assert.equal(database.listDerivedResults(created.id)?.total, 0);
    assert.equal((await fetch(`${base}/api/derived-tasks/${cancelling.id}`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal(await (await fetch(`${base}/api/documents/${created.id}/derived-task`, { headers: { Cookie: cookie } })).json(), null);
    database.sql.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const path of [join(root, "data", "zhiye.sqlite3"), join(root, "data", "zhiye.sqlite3-wal")]) {
      if (existsSync(path)) assert.equal(readFileSync(path).includes(Buffer.from("test-key-not-persisted")), false);
    }
  } finally {
    releaseSlow();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("LLM runner rejects unsafe provider behavior without saving partial results", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-llm-errors-"));
  let calls = 0;
  const provider = createServer(async (request, response) => {
    calls += 1;
    for await (const _chunk of request) { /* drain request */ }
    const path = request.url ?? "";
    if (path === "/redirect") return void response.writeHead(302, { Location: "/ok", "Content-Type": "application/json" }).end("{}");
    if (path === "/auth") return void response.writeHead(401, { "Content-Type": "application/json" }).end("{}");
    if (path === "/rate") return void response.writeHead(429, { "Content-Type": "application/json" }).end("{}");
    if (path === "/compressed") {
      return void response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" }).end("not-gzip");
    }
    if (path === "/large") {
      const body = "x".repeat(256 * 1024 + 1);
      return void response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length) }).end(body);
    }
    if (path === "/interrupted") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"choices":[');
      return void response.destroy();
    }
    if (path === "/timeout") {
      response.writeHead(200, { "Content-Type": "application/json" });
      const timer = setInterval(() => response.write(" "), 5);
      response.once("close", () => clearInterval(timer));
      return;
    }
    const content = path === "/malformed" ? "not an array" : "Safe";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const db = openDatabase(join(root, "data"));
  const created = db.createOrGetDocument("https://example.com/provider-errors").document;
  const edited = db.updateDocument(created.id, created.revision, { markdown: "Provider boundary test" });
  assert.equal(edited.kind, "updated");
  if (edited.kind !== "updated") return;
  const manager = createDerivedTasks({ database: () => db, requestTimeoutMs: 40 });
  try {
    assert.throws(() => manager.preview(created.id, "summary", edited.document.revision), /disabled/u);
    assert.equal(calls, 0);
    const cases: Array<{ path: string; code: string; type?: DerivedResultType }> = [
      { path: "redirect", code: "LLM_REDIRECT_REJECTED" },
      { path: "auth", code: "LLM_AUTH_FAILED" },
      { path: "rate", code: "LLM_RATE_LIMITED" },
      { path: "compressed", code: "LLM_COMPRESSION_REJECTED" },
      { path: "large", code: "LLM_RESPONSE_TOO_LARGE" },
      { path: "interrupted", code: "LLM_NETWORK_ERROR" },
      { path: "malformed", code: "LLM_INVALID_RESPONSE", type: "keywords" },
      { path: "timeout", code: "LLM_TIMEOUT" },
    ];
    for (const item of cases) {
      const current = db.getLlmSettings();
      const saved = db.setLlmSettings({
        enabled: true,
        target: "local",
        remote: { endpointUrl: "", model: "" },
        local: {
          endpointUrl: `http://127.0.0.1:${address.port}/${item.path}`,
          model: "fake",
          trusted: true,
        },
      }, current.revision);
      assert.equal(saved.kind, "updated");
      const preview = manager.preview(created.id, item.type ?? "summary", edited.document.revision);
      const started = manager.start(created.id, {
        type: preview.type,
        revision: preview.revision,
        inputHash: preview.inputHash,
        settingsRevision: preview.settingsRevision,
      }).task;
      const finished = await waitForMemoryTask(manager, started.id);
      assert.equal(finished.status, "failed", item.path);
      assert.equal(finished.error?.code, item.code, item.path);
      assert.equal(db.listDerivedResults(created.id)?.total, 0);
    }
    const beforeRestart = db.getLlmSettings();
    assert.equal(db.setLlmSettings({
      enabled: true,
      target: "local",
      remote: { endpointUrl: "", model: "" },
      local: { endpointUrl: `http://127.0.0.1:${address.port}/timeout`, model: "fake", trusted: true },
    }, beforeRestart.revision).kind, "updated");
    const restartPreview = manager.preview(created.id, "outline", edited.document.revision);
    const unfinished = manager.start(created.id, {
      type: restartPreview.type,
      revision: restartPreview.revision,
      inputHash: restartPreview.inputHash,
      settingsRevision: restartPreview.settingsRevision,
    }).task;
    await new Promise((resolve) => setImmediate(resolve));
    await manager.stop();
    assert.equal(manager.get(unfinished.id)?.status, "cancelled");
    const restarted = createDerivedTasks({ database: () => db, requestTimeoutMs: 40 });
    assert.equal(restarted.getForDocument(created.id), null);
    assert.equal(db.listDerivedResults(created.id)?.total, 0);
    await restarted.stop();
  } finally {
    await manager.stop();
    db.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("Markdown translation preserves structure and rejects changed segment identifiers", () => {
  const markdown = [
    "---",
    "title: Keep this metadata",
    "---",
    "# Hello *world*",
    "",
    "[Read this](https://example.com/path?q=1) and <https://example.com/bare>.",
    "Visit www.example.com/path?q=1 without changing the address.",
    "",
    "![Do not translate alt](https://example.com/image.png)",
    "",
    "<aside>Keep raw HTML</aside>",
    "",
    "`const inline = true`",
    "",
    "```js",
    "console.log('keep code')",
    "```",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| One | Two |",
    "",
    "Footnote text[^1].",
    "",
    "[^1]: Footnote detail.",
  ].join("\n");
  const input = markdownTranslationInput(markdown);
  const segments = JSON.parse(input.sentText) as Array<{ id: string; text: string }>;
  assert.ok(segments.some(({ text }) => text === "Read this"));
  assert.equal(segments.some(({ text }) => text.includes("https://")), false);
  assert.equal(segments.some(({ text }) => text.includes("www.example.com")), false);
  assert.equal(segments.some(({ text }) => text.includes("Keep this metadata")), false);
  assert.equal(segments.some(({ text }) => text.includes("Do not translate alt")), false);
  assert.equal(segments.some(({ text }) => text.includes("Keep raw HTML")), false);
  assert.equal(segments.some(({ text }) => text.includes("keep code")), false);

  const translated = applyMarkdownTranslation(markdown, JSON.stringify(
    segments.map(({ id }, index) => ({ id, text: `Translated ${index + 1}` })),
  ));
  assert.match(translated, /^---\ntitle: Keep this metadata\n---\n/u);
  assert.match(translated, /# Translated 1 \*Translated 2\*/u);
  assert.match(translated, /\[Translated 3\]\(https:\/\/example\.com\/path\?q=1\)/u);
  assert.match(translated, /<https:\/\/example\.com\/bare>/u);
  assert.match(translated, /www\.example\.com\/path\?q=1/u);
  assert.match(translated, /!\[Do not translate alt\]\(https:\/\/example\.com\/image\.png\)/u);
  assert.match(translated, /<aside>Keep raw HTML<\/aside>/u);
  assert.match(translated, /`const inline = true`/u);
  assert.match(translated, /console\.log\('keep code'\)/u);
  assert.match(translated, /\| --- \| --- \|/u);
  assert.match(translated, /\[\^1\]:/u);
  assert.throws(
    () => applyMarkdownTranslation(markdown, JSON.stringify(
      segments.map(({ id }, index) => ({ id: index ? id : "changed", text: "Unsafe" })),
    )),
    (error: unknown) => error instanceof Error && error.message.includes("identifier"),
  );
  assert.throws(() => markdownTranslationInput("x".repeat(40_001)), /complete document/u);
});

test("LLM target validation separates remote public HTTPS from explicit loopback", async () => {
  await assert.rejects(resolveLlmTarget("remote", "http://127.0.0.1/v1/chat/completions"), /HTTPS/u);
  await assert.rejects(resolveLlmTarget("local", "https://example.com/v1/chat/completions"), /loopback/u);
  await assert.rejects(resolveLlmTarget("local", "http://127.0.0.1/v1/chat/completions?secret=x"), /query/u);
  await assert.rejects(resolveLlmTarget("remote", "https://127.0.0.1/v1/chat/completions"), /blocked/u);
  await assert.rejects(resolveLlmTarget("remote", "https://mixed.example/v1/chat/completions", async () => [
    { address: "8.8.8.8", family: 4 as const },
    { address: "127.0.0.1", family: 4 as const },
  ]), /blocked/u);
});

test("LLM resolver timeout, nested pauses, and permanent stop cannot strand a task", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-llm-control-"));
  const db = openDatabase(join(root, "data"));
  const created = db.createOrGetDocument("https://example.com/control").document;
  const edited = db.updateDocument(created.id, created.revision, { markdown: "Control flow" });
  assert.equal(edited.kind, "updated");
  if (edited.kind !== "updated") return;
  assert.equal(db.setLlmSettings({
    enabled: true,
    target: "local",
    remote: { endpointUrl: "", model: "" },
    local: { endpointUrl: "http://127.0.0.1:9/v1/chat/completions", model: "fake", trusted: true },
  }, 0).kind, "updated");
  const neverResolve = async () => new Promise<never>(() => undefined);
  const inputFor = (manager: ReturnType<typeof createDerivedTasks>, type: DerivedResultType) => {
    const preview = manager.preview(created.id, type, edited.document.revision);
    return {
      type: preview.type,
      revision: preview.revision,
      inputHash: preview.inputHash,
      settingsRevision: preview.settingsRevision,
    };
  };
  try {
    const timed = createDerivedTasks({ database: () => db, resolveTarget: neverResolve, requestTimeoutMs: 10 });
    const timedTask = timed.start(created.id, inputFor(timed, "summary")).task;
    assert.equal((await waitForMemoryTask(timed, timedTask.id)).error?.code, "LLM_TIMEOUT");
    await timed.stop();

    const stoppable = createDerivedTasks({ database: () => db, resolveTarget: neverResolve });
    const stoppedTask = stoppable.start(created.id, inputFor(stoppable, "outline")).task;
    await Promise.race([
      stoppable.stop(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("stop did not return")), 200)),
    ]);
    assert.equal(stoppable.get(stoppedTask.id)?.status, "cancelled");

    const paused = createDerivedTasks({ database: () => db, resolveTarget: neverResolve });
    const preview = paused.preview(created.id, "translation", edited.document.revision, "zh-CN");
    const input = {
      type: preview.type,
      targetLanguage: preview.targetLanguage!,
      revision: preview.revision,
      inputHash: preview.inputHash,
      settingsRevision: preview.settingsRevision,
    };
    await paused.pause();
    await paused.pause();
    paused.resume();
    assert.throws(() => paused.start(created.id, input), /temporarily unavailable/u);
    paused.resume();
    const accepted = paused.start(created.id, input).task;
    assert.equal((await paused.cancel(accepted.id))?.status, "cancelled");
    await paused.stop();
    paused.resume();
    assert.throws(() => paused.start(created.id, input), /temporarily unavailable/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForTask(base: string, cookie: string, id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = (await (await fetch(`${base}/api/derived-tasks/${id}`, { headers: { Cookie: cookie } })).json()) as DerivedTask;
    if (task.status !== "running") return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("LLM task did not finish");
}

async function waitForMemoryTask(manager: ReturnType<typeof createDerivedTasks>, id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = manager.get(id);
    if (task?.status !== "running") return task!;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("In-memory LLM task did not finish");
}
