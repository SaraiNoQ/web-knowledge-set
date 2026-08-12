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
  llmConnectionTestInput,
  llmNetworkError,
  markdownTranslationInput,
  resolveLlmTarget,
} from "../server/llm.js";
import type {
  DerivedPreview,
  DerivedResultType,
  DerivedTask,
  LlmConnectionTestResult,
  LlmSettings,
} from "../shared/types.js";

test("LLM network failures distinguish rejected TLS certificates", () => {
  assert.equal(llmNetworkError(Object.assign(new Error("certificate"), { code: "SELF_SIGNED_CERT_IN_CHAIN" })).code, "LLM_TLS_ERROR");
  assert.equal(llmNetworkError(Object.assign(new Error("socket"), { code: "ECONNRESET" })).code, "LLM_NETWORK_ERROR");
});

test("LLM connection probe is strict, document-free, endpoint-bound, and redacted", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-llm-probe-"));
  const db = openDatabase(join(root, "data"));
  const secret = "probe-api-secret";
  const documentSecret = "DOCUMENT-CONTENT-MUST-NOT-BE-SENT";
  const remoteEndpoint = "https://probe.example/v1/chat/completions";
  const otherRemoteEndpoint = "https://other.example/v1/chat/completions";
  const requests: Array<{ authorization: string | undefined; body: string }> = [];
  let reply = "ZHIYE_OK";
  let providerStatus = 200;
  let providerError: Record<string, unknown> | null = null;
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ authorization: request.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(providerStatus, providerStatus === 200 || providerError ? { "Content-Type": "application/json" } : {});
    response.end(JSON.stringify(providerError ?? { choices: [{ message: { content: reply } }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress !== "string");
  const document = db.createOrGetDocument("https://example.com/probe-document").document;
  assert.equal(db.updateDocument(document.id, document.revision, { markdown: documentSecret }).kind, "updated");
  const app = createApp({
    dataDir: join(root, "data"),
    database: db,
    bootstrapToken: "probe-bootstrap",
    sessionToken: "probe-session",
    startWorker: false,
    resolveLlmTarget: async () => ({
      url: new URL(`http://127.0.0.1:${providerAddress.port}/v1/chat/completions`),
      address: "127.0.0.1",
      family: 4,
    }),
  });
  const server = createServer((request, response) => void app.handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.throws(
      () => llmConnectionTestInput({ target: "remote", endpointUrl: remoteEndpoint, model: "fake", trusted: true }),
      /invalid/u,
    );
    assert.throws(
      () => llmConnectionTestInput({ target: "local", endpointUrl: "http://127.0.0.1:9/v1", model: "fake", trusted: false }),
      /invalid/u,
    );
    const launch = await fetch(`${base}/launch?token=probe-bootstrap`, { redirect: "manual" });
    const cookie = (launch.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const settings = await fetch(`${base}/api/settings/llm`, { headers: { Cookie: cookie } });
    const epoch = settings.headers.get("x-zhiye-data-epoch");
    assert.ok(epoch);
    const headers = {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
      "X-Zhiye-Data-Epoch": epoch,
    };
    const localEndpoint = `http://127.0.0.1:${providerAddress.port}/v1/chat/completions`;
    const queryResponse = await fetch(`${base}/api/settings/llm/test?unexpected=1`, {
      method: "POST", headers,
      body: JSON.stringify({ target: "local", endpointUrl: localEndpoint, model: "probe-model", trusted: true }),
    });
    assert.equal(queryResponse.status, 400);
    assert.equal(requests.length, 0);
    const localResponse = await fetch(`${base}/api/settings/llm/test`, {
      method: "POST", headers,
      body: JSON.stringify({ target: "local", endpointUrl: localEndpoint, model: "probe-model", trusted: true }),
    });
    assert.equal(localResponse.status, 200);
    const localResult = await localResponse.json() as LlmConnectionTestResult;
    assert.deepEqual(Object.keys(localResult).sort(), ["durationMs", "endpointId", "model", "ok", "target"]);
    assert.equal(localResult.ok, true);
    assert.equal(localResult.target, "local");
    assert.equal(localResult.model, "probe-model");
    assert.equal(JSON.stringify(localResult).includes(localEndpoint), false);
    assert.equal(requests[0]?.authorization, undefined);
    assert.equal(requests[0]?.body.includes(documentSecret), false);
    assert.deepEqual(JSON.parse(requests[0]!.body), {
      model: "probe-model",
      temperature: 0,
      max_tokens: 16,
      messages: [
        { role: "system", content: "This is a connection test. Reply with exactly ZHIYE_OK and nothing else." },
        { role: "user", content: "Reply with exactly ZHIYE_OK." },
      ],
    });

    assert.equal((await fetch(`${base}/api/settings/llm/key`, {
      method: "PUT", headers,
      body: JSON.stringify({ apiKey: secret, endpointUrl: remoteEndpoint }),
    })).status, 200);
    const wrongEndpoint = await fetch(`${base}/api/settings/llm/test`, {
      method: "POST", headers,
      body: JSON.stringify({ target: "remote", endpointUrl: otherRemoteEndpoint, model: "remote-model" }),
    });
    assert.equal(wrongEndpoint.status, 409);
    assert.equal(requests.length, 1);
    const remoteResponse = await fetch(`${base}/api/settings/llm/test`, {
      method: "POST", headers,
      body: JSON.stringify({ target: "remote", endpointUrl: remoteEndpoint, model: "remote-model" }),
    });
    assert.equal(remoteResponse.status, 200);
    const remoteText = await remoteResponse.text();
    assert.equal(remoteText.includes(secret), false);
    assert.equal(remoteText.includes(remoteEndpoint), false);
    assert.equal(requests[1]?.authorization, `Bearer ${secret}`);

    reply = "ZHIYE_OK\n";
    const inexact = await fetch(`${base}/api/settings/llm/test`, {
      method: "POST", headers,
      body: JSON.stringify({ target: "local", endpointUrl: localEndpoint, model: "probe-model", trusted: true }),
    });
    assert.equal(inexact.status, 502);
    assert.equal((await inexact.json() as { error: { code: string } }).error.code, "LLM_INVALID_PROBE");

    reply = "ZHIYE_OK";
    for (const [status, code] of [[401, "LLM_AUTH_FAILED"], [429, "LLM_RATE_LIMITED"], [404, "LLM_REQUEST_REJECTED"]] as const) {
      providerStatus = status;
      const rejected = await fetch(`${base}/api/settings/llm/test`, {
        method: "POST", headers,
        body: JSON.stringify({ target: "local", endpointUrl: localEndpoint, model: "missing-model", trusted: true }),
      });
      assert.equal(rejected.status, status === 429 ? 429 : 502);
      assert.equal((await rejected.json() as { error: { code: string } }).error.code, code);
    }
    providerError = { error: { message: "unknown model", param: "model", code: "model_not_found" } };
    const rejectedModel = await fetch(`${base}/api/settings/llm/test`, {
      method: "POST", headers,
      body: JSON.stringify({ target: "local", endpointUrl: localEndpoint, model: "missing-model", trusted: true }),
    });
    assert.equal(rejectedModel.status, 502);
    assert.equal((await rejectedModel.json() as { error: { code: string } }).error.code, "LLM_MODEL_REJECTED");
    assert.equal(db.getDocument(document.id)?.markdown, documentSecret);
    assert.equal(db.listDerivedResults(document.id)?.total, 0);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("LLM connection probe is rejected while the knowledge base is in recovery mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-llm-probe-recovery-"));
  let resolutions = 0;
  const app = createApp({
    dataDir: join(root, "data"),
    database: null,
    recoveryError: new Error("recovery required"),
    bootstrapToken: "recovery-bootstrap",
    sessionToken: "recovery-session",
    resolveLlmTarget: async () => {
      resolutions += 1;
      throw new Error("must not resolve");
    },
    startWorker: false,
  });
  const server = createServer((request, response) => void app.handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const launch = await fetch(`${base}/launch?token=recovery-bootstrap`, { redirect: "manual" });
    const cookie = (launch.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const unavailable = await fetch(`${base}/api/settings/llm`, { headers: { Cookie: cookie } });
    const epoch = unavailable.headers.get("x-zhiye-data-epoch");
    assert.ok(epoch);
    const response = await fetch(`${base}/api/settings/llm/test`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: base,
        "Content-Type": "application/json",
        "X-Zhiye-Data-Epoch": epoch,
      },
      body: JSON.stringify({
        target: "local",
        endpointUrl: "http://127.0.0.1:9/v1/chat/completions",
        model: "fake",
        trusted: true,
      }),
    });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "DATA_UNAVAILABLE");
    assert.equal(resolutions, 0);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("LLM probe HTTP route aborts disconnected clients and pauses before key updates", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-llm-probe-route-"));
  const db = openDatabase(join(root, "data"));
  const deferred = () => {
    let resolve!: () => void;
    return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
  };
  const first = { arrived: deferred(), closed: deferred() };
  const second = { arrived: deferred(), closed: deferred() };
  let providerCalls = 0;
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    providerCalls += 1;
    const hanging = providerCalls === 1 ? first : providerCalls === 3 ? second : null;
    if (hanging) {
      response.once("close", hanging.closed.resolve);
      hanging.arrived.resolve();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ZHIYE_OK" } }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress !== "string");
  const app = createApp({
    dataDir: join(root, "data"),
    database: db,
    bootstrapToken: "probe-route-bootstrap",
    sessionToken: "probe-route-session",
    startWorker: false,
  });
  const server = createServer((request, response) => void app.handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const launch = await fetch(`${base}/launch?token=probe-route-bootstrap`, { redirect: "manual" });
    const cookie = (launch.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const settings = await fetch(`${base}/api/settings/llm`, { headers: { Cookie: cookie } });
    const epoch = settings.headers.get("x-zhiye-data-epoch");
    assert.ok(epoch);
    const headers = {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
      "X-Zhiye-Data-Epoch": epoch,
    };
    const body = JSON.stringify({
      target: "local",
      endpointUrl: `http://127.0.0.1:${providerAddress.port}/v1/chat/completions`,
      model: "probe-model",
      trusted: true,
    });

    const controller = new AbortController();
    let receivedLateSuccess = false;
    const disconnected = fetch(`${base}/api/settings/llm/test`, {
      method: "POST", headers, body, signal: controller.signal,
    }).then(
      (response) => { receivedLateSuccess = response.ok; return null; },
      (error: unknown) => error,
    );
    await first.arrived.promise;
    controller.abort();
    const disconnectError = await disconnected;
    assert.equal(disconnectError instanceof Error && disconnectError.name, "AbortError");
    await first.closed.promise;
    assert.equal(receivedLateSuccess, false);
    const retry = await fetch(`${base}/api/settings/llm/test`, { method: "POST", headers, body });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as LlmConnectionTestResult).ok, true);
    assert.equal(receivedLateSuccess, false);

    const hangingProbe = fetch(`${base}/api/settings/llm/test`, { method: "POST", headers, body });
    await second.arrived.promise;
    const remoteEndpoint = "https://probe-key.example/v1/chat/completions";
    const keyResponse = await fetch(`${base}/api/settings/llm/key`, {
      method: "PUT", headers,
      body: JSON.stringify({ apiKey: "probe-key", endpointUrl: remoteEndpoint }),
    });
    assert.equal(keyResponse.status, 200);
    await second.closed.promise;
    assert.deepEqual(await keyResponse.json(), { configured: true, endpointUrl: remoteEndpoint });
    const cancelled = await hangingProbe;
    assert.equal(cancelled.status, 409);
    assert.equal(((await cancelled.json()) as { error: { code: string } }).error.code, "LLM_CANCELLED");
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

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
      choices: [{ message: { content: "## Safe summary\n\nGrounded output." } }],
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
    assert.equal(settings.apiKeyConfigured, false);

    const previewResponse = await fetch(`${base}/api/documents/${created.id}/derived-preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "summary", revision: updated.document.revision }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as DerivedPreview;
    assert.equal(preview.coverage.truncated, true);
    assert.ok(preview.coverage.sentChars < preview.coverage.sourceChars);
    assert.ok(preview.sentTexts[0]!.includes("FRONT"));
    assert.ok(preview.sentTexts[0]!.includes("MIDDLE"));
    assert.ok(preview.sentTexts[0]!.includes("TAIL"));
    assert.equal(preview.sentTexts[0]!.includes("\ud800") || preview.sentTexts[0]!.includes("\udfff"), false);

    const startBody = JSON.stringify({
      type: preview.type,
      revision: preview.revision,
      inputHash: preview.inputHash,
      sendHash: preview.sendHash,
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
    assert.equal("sentTexts" in started.preview, false);
    assert.deepEqual(started.progress, { completedBatches: 0, totalBatches: 1 });
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
    const changed = database.updateDocument(created.id, current.revision, { markdown: "CANCEL-ME" });
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
        sendHash: cancelPreview.sendHash,
        settingsRevision: cancelPreview.settingsRevision,
      }),
    })).json()) as DerivedTask;
    while (calls < 3) await new Promise((resolve) => setTimeout(resolve, 5));
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
  } finally {
    releaseSlow();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("LLM API keys stay bound to one normalized remote endpoint and never persist", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-llm-key-"));
  const database = openDatabase(join(root, "data"));
  const endpointA = "https://provider-a.example/v1/chat/completions";
  const endpointB = "https://provider-b.example/v1/chat/completions";
  const secretA = "endpoint-a-secret";
  const secretB = "endpoint-b-secret";
  const orphanSecret = "unbound-startup-secret";
  const document = database.createOrGetDocument("https://example.com/key-binding").document;
  const stored = database.setLlmSettings({
    enabled: false,
    target: "remote",
    remote: { endpointUrl: endpointA, model: "fake-model" },
    local: { endpointUrl: "", model: "", trusted: false },
  }, 0);
  assert.equal(stored.kind, "updated");
  if (stored.kind !== "updated") return;

  const startupBound = createDerivedTasks({
    database: () => database,
    apiKey: "paired-startup-secret",
    apiKeyEndpoint: " https://PROVIDER-A.EXAMPLE:443/v1/chat/completions ",
  });
  assert.equal(startupBound.settings().apiKeyConfigured, true);
  await startupBound.stop();

  const requests: Array<{ path: string; authorization: string | undefined }> = [];
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
    const content = request.url === "/a" ? secretA : "Safe endpoint B result";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress !== "string");
  const app = createApp({
    dataDir: join(root, "data"),
    database,
    bootstrapToken: "key-bootstrap",
    sessionToken: "key-session",
    llmApiKey: orphanSecret,
    resolveLlmTarget: async (_kind, input) => ({
      url: new URL(`http://127.0.0.1:${providerAddress.port}/${new URL(input).hostname === "provider-a.example" ? "a" : "b"}`),
      address: "127.0.0.1",
      family: 4,
    }),
    startWorker: false,
  });
  const server = createServer((request, response) => void app.handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const launch = await fetch(`${base}/launch?token=key-bootstrap`, { redirect: "manual" });
    const cookie = (launch.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const initial = await fetch(`${base}/api/settings/llm`, { headers: { Cookie: cookie } });
    const epoch = initial.headers.get("x-zhiye-data-epoch");
    assert.ok(epoch);
    assert.equal(((await initial.json()) as LlmSettings).apiKeyConfigured, false);
    const headers = {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
      "X-Zhiye-Data-Epoch": epoch,
    };
    const putA = await fetch(`${base}/api/settings/llm/key`, {
      method: "PUT", headers, body: JSON.stringify({ apiKey: `  ${secretA}  `, endpointUrl: endpointA }),
    });
    assert.equal(putA.status, 200);
    assert.equal((await putA.text()).includes(secretA), false);
    const configured = await fetch(`${base}/api/settings/llm`, { headers: { Cookie: cookie } });
    const configuredBody = await configured.text();
    assert.equal(JSON.parse(configuredBody).apiKeyConfigured, true);
    assert.equal(configuredBody.includes(secretA), false);
    const keyStatusA = await fetch(`${base}/api/settings/llm/key`, { headers: { Cookie: cookie } });
    assert.deepEqual(await keyStatusA.json(), { configured: true, endpointUrl: endpointA });
    assert.equal((await fetch(`${base}/api/settings/llm/key?unexpected=1`, {
      headers: { Cookie: cookie },
    })).status, 400);

    const enabledAResponse = await fetch(`${base}/api/settings/llm`, {
      method: "PUT", headers,
      body: JSON.stringify({
        enabled: true,
        target: "remote",
        remote: { endpointUrl: endpointA, model: "fake-model" },
        local: { endpointUrl: "", model: "", trusted: false },
        revision: stored.settings.revision,
      }),
    });
    assert.equal(enabledAResponse.status, 200);
    const enabledA = await enabledAResponse.json() as LlmSettings;
    const previewA = await (await fetch(`${base}/api/documents/${document.id}/derived-preview`, {
      method: "POST", headers, body: JSON.stringify({ type: "summary", revision: document.revision }),
    })).json() as DerivedPreview;
    const taskA = await (await fetch(`${base}/api/documents/${document.id}/derived-task`, {
      method: "POST", headers,
      body: JSON.stringify({
        type: previewA.type, revision: previewA.revision, inputHash: previewA.inputHash,
        sendHash: previewA.sendHash,
        settingsRevision: previewA.settingsRevision,
      }),
    })).json() as DerivedTask;
    const failedA = await waitForTask(base, cookie, taskA.id);
    assert.equal(failedA.error?.code, "LLM_SECRET_ECHO");
    assert.equal(JSON.stringify(failedA).includes(secretA), false);
    assert.deepEqual(requests, [{ path: "/a", authorization: `Bearer ${secretA}` }]);

    const switchedResponse = await fetch(`${base}/api/settings/llm`, {
      method: "PUT", headers,
      body: JSON.stringify({
        enabled: false,
        target: "remote",
        remote: { endpointUrl: endpointB, model: "fake-model" },
        local: { endpointUrl: "", model: "", trusted: false },
        revision: enabledA.revision,
      }),
    });
    assert.equal(switchedResponse.status, 200);
    const switched = await switchedResponse.json() as LlmSettings;
    assert.equal(switched.apiKeyConfigured, false);
    assert.deepEqual(await (await fetch(`${base}/api/settings/llm/key`, {
      headers: { Cookie: cookie },
    })).json(), { configured: true, endpointUrl: endpointA });
    const forcedEnabledB = database.setLlmSettings({
      enabled: true,
      target: "remote",
      remote: { endpointUrl: endpointB, model: "fake-model" },
      local: { endpointUrl: "", model: "", trusted: false },
    }, switched.revision, false);
    assert.equal(forcedEnabledB.kind, "updated");
    const blockedPreview = await fetch(`${base}/api/documents/${document.id}/derived-preview`, {
      method: "POST", headers, body: JSON.stringify({ type: "summary", revision: document.revision }),
    });
    assert.equal(blockedPreview.status, 409);
    assert.equal(((await blockedPreview.json()) as { error: { code: string } }).error.code, "LLM_KEY_MISSING");
    assert.equal(requests.length, 1);

    const putB = await fetch(`${base}/api/settings/llm/key`, {
      method: "PUT", headers, body: JSON.stringify({ apiKey: secretB, endpointUrl: endpointB }),
    });
    assert.equal(putB.status, 200);
    assert.equal((await putB.text()).includes(secretB), false);
    assert.equal(((await (await fetch(`${base}/api/settings/llm`, {
      headers: { Cookie: cookie },
    })).json()) as LlmSettings).apiKeyConfigured, true);
    const previewB = await (await fetch(`${base}/api/documents/${document.id}/derived-preview`, {
      method: "POST", headers, body: JSON.stringify({ type: "summary", revision: document.revision }),
    })).json() as DerivedPreview;
    const taskB = await (await fetch(`${base}/api/documents/${document.id}/derived-task`, {
      method: "POST", headers,
      body: JSON.stringify({
        type: previewB.type, revision: previewB.revision, inputHash: previewB.inputHash,
        sendHash: previewB.sendHash,
        settingsRevision: previewB.settingsRevision,
      }),
    })).json() as DerivedTask;
    assert.equal((await waitForTask(base, cookie, taskB.id)).status, "succeeded");
    assert.deepEqual(requests[1], { path: "/b", authorization: `Bearer ${secretB}` });
    assert.equal(requests.some(({ path, authorization }) => path === "/b" && authorization?.includes(secretA)), false);

    for (const body of [
      { apiKey: "", endpointUrl: endpointB },
      { apiKey: "line\nbreak", endpointUrl: endpointB },
      { apiKey: "x".repeat(16 * 1024 + 1), endpointUrl: endpointB },
      { apiKey: "valid", endpointUrl: "http://provider-b.example/v1/chat/completions" },
      { apiKey: "valid" },
    ]) {
      const invalid = await fetch(`${base}/api/settings/llm/key`, {
        method: "PUT", headers, body: JSON.stringify(body),
      });
      assert.equal(invalid.status, 400);
    }
    assert.equal((await fetch(`${base}/api/settings/llm/key`, {
      method: "DELETE", headers, body: "{}",
    })).status, 200);
    assert.equal(((await (await fetch(`${base}/api/settings/llm`, {
      headers: { Cookie: cookie },
    })).json()) as LlmSettings).apiKeyConfigured, false);
    assert.deepEqual(await (await fetch(`${base}/api/settings/llm/key`, {
      headers: { Cookie: cookie },
    })).json(), { configured: false, endpointUrl: null });
    database.sql.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const path of [join(root, "data", "zhiye.sqlite3"), join(root, "data", "zhiye.sqlite3-wal")]) {
      if (!existsSync(path)) continue;
      const contents = readFileSync(path);
      for (const secret of [secretA, secretB, orphanSecret, "paired-startup-secret"]) {
        assert.equal(contents.includes(Buffer.from(secret)), false);
      }
    }
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
        sendHash: preview.sendHash,
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
      sendHash: restartPreview.sendHash,
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
    "Before <span>keep inline HTML text</span> after.",
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
  const segments = JSON.parse(input.sentTexts[0]!) as Array<{ id: string; text: string }>;
  assert.ok(segments.some(({ text }) => text === "Read this"));
  assert.equal(segments.some(({ text }) => text.includes("https://")), false);
  assert.equal(segments.some(({ text }) => text.includes("www.example.com")), false);
  assert.equal(segments.some(({ text }) => text.includes("Keep this metadata")), false);
  assert.equal(segments.some(({ text }) => text.includes("Do not translate alt")), false);
  assert.equal(segments.some(({ text }) => text.includes("Keep raw HTML")), false);
  assert.equal(segments.some(({ text }) => text.includes("keep inline HTML text")), false);
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
  assert.match(translated, /<span>keep inline HTML text<\/span>/u);
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
  assert.throws(() => markdownTranslationInput("x".repeat(1_000_001)), /1000000/u);
});

test("Markdown translation batches long Unicode input within every request boundary", () => {
  const markdown = [
    "---",
    "title: Keep metadata",
    "---",
    "# Long source",
    "",
    `${"😀 multilingual words ".repeat(12_000)}tail`,
    "",
    "[Keep destination](https://example.com/a?q=1)",
    "",
    "<aside>Keep raw HTML</aside>",
    "",
    "```js",
    "console.log('keep code')",
    "```",
  ].join("\n");
  const input = markdownTranslationInput(markdown);
  assert.ok(input.sentTexts.length > 1);
  assert.ok(input.sentTexts.length <= 64);
  const records = input.sentTexts.flatMap((sentText) => {
    assert.ok(sentText.length <= 40_000);
    assert.ok(Buffer.byteLength(sentText, "utf8") <= 128 * 1024);
    return JSON.parse(sentText) as Array<{ id: string; text: string }>;
  });
  assert.ok(records.length <= 5_000);
  assert.deepEqual(records.map(({ id }) => id), records.map((_record, index) => `s${index + 1}`));
  for (const { text } of records) {
    assert.ok(text.length <= 12_000);
    for (let index = 0; index < text.length; index += 1) {
      const value = text.charCodeAt(index);
      if (value >= 0xd800 && value <= 0xdbff) {
        const next = text.charCodeAt(++index);
        assert.ok(next >= 0xdc00 && next <= 0xdfff);
      } else {
        assert.ok(value < 0xdc00 || value > 0xdfff);
      }
    }
  }
  const responses = input.sentTexts.map((sentText) => JSON.stringify(
    (JSON.parse(sentText) as Array<{ id: string }>).map(({ id }) => ({ id, text: `Translated ${id}` })),
  ));
  const translated = applyMarkdownTranslation(markdown, responses);
  assert.match(translated, /^---\ntitle: Keep metadata\n---\n/u);
  assert.match(translated, /\]\(https:\/\/example\.com\/a\?q=1\)/u);
  assert.match(translated, /<aside>Keep raw HTML<\/aside>/u);
  assert.match(translated, /console\.log\('keep code'\)/u);
  assert.throws(
    () => markdownTranslationInput(Array.from({ length: 5_001 }, (_value, index) => `piece ${index}`).join("\n\n")),
    /too many translation segments/u,
  );
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
      sendHash: preview.sendHash,
      settingsRevision: preview.settingsRevision,
    };
  };
  const probeInput = {
    target: "local" as const,
    endpointUrl: "http://127.0.0.1:9/v1/chat/completions",
    model: "fake",
    trusted: true as const,
  };
  try {
    const timed = createDerivedTasks({ database: () => db, resolveTarget: neverResolve, requestTimeoutMs: 10 });
    await assert.rejects(timed.testConnection(probeInput, new AbortController().signal), /timed out/u);
    const timedTask = timed.start(created.id, inputFor(timed, "summary")).task;
    assert.equal((await waitForMemoryTask(timed, timedTask.id)).error?.code, "LLM_TIMEOUT");
    await timed.stop();

    const stoppable = createDerivedTasks({ database: () => db, resolveTarget: neverResolve });
    const stoppedTask = stoppable.start(created.id, inputFor(stoppable, "outline")).task;
    await assert.rejects(stoppable.testConnection(probeInput, new AbortController().signal), /already running/u);
    await Promise.race([
      stoppable.stop(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("stop did not return")), 200)),
    ]);
    assert.equal(stoppable.get(stoppedTask.id)?.status, "cancelled");

    const abortable = createDerivedTasks({ database: () => db, resolveTarget: neverResolve });
    const clientController = new AbortController();
    const clientProbe = abortable.testConnection(probeInput, clientController.signal);
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => abortable.start(created.id, inputFor(abortable, "summary")), /already running/u);
    clientController.abort();
    await assert.rejects(clientProbe, /cancelled/u);
    const stoppedProbe = abortable.testConnection(probeInput, new AbortController().signal);
    const stoppedProbeRejection = assert.rejects(stoppedProbe, /cancelled/u);
    await abortable.stop();
    await stoppedProbeRejection;
    await assert.rejects(abortable.testConnection(probeInput, new AbortController().signal), /temporarily unavailable/u);

    const paused = createDerivedTasks({ database: () => db, resolveTarget: neverResolve });
    const preview = paused.preview(created.id, "translation", edited.document.revision, "zh-CN");
    const input = {
      type: preview.type,
      targetLanguage: preview.targetLanguage!,
      revision: preview.revision,
      inputHash: preview.inputHash,
      sendHash: preview.sendHash,
      settingsRevision: preview.settingsRevision,
    };
    const maintenanceProbe = paused.testConnection(probeInput, new AbortController().signal);
    const maintenanceProbeRejection = assert.rejects(maintenanceProbe, /cancelled/u);
    await paused.pause();
    await maintenanceProbeRejection;
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
