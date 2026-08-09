import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp, type CaptureFunction } from "../server/app.js";
import type { KnowledgeDocument } from "../shared/types.js";

async function waitFor(base: string, cookie: string, id: string, status: KnowledgeDocument["status"]) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/api/documents/${id}`, { headers: { Cookie: cookie } });
    const document = (await response.json()) as KnowledgeDocument;
    if (document.status === status) return document;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Document ${id} did not reach ${status}`);
}

test("local API authenticates, captures, edits, exports, deduplicates, and retries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-api-"));
  const attempts = new Map<string, number>();
  const capture: CaptureFunction = async (url) => {
    const attempt = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, attempt);
    if (url.includes("retry") && attempt === 1) {
      throw Object.assign(new Error("temporary failure"), { code: "HTTP_ERROR" });
    }
    return {
      title: "Captured article",
      author: "Author",
      publishedAt: null,
      finalUrl: url,
      canonicalUrl: url,
      markdown: "# Captured\n\nKnowledge body",
      mode: "http",
      warning: null,
      rawHtml: "<article>Knowledge body</article>",
      httpStatus: 200,
    };
  };
  const app = createApp({
    dataDir: directory,
    bootstrapToken: "bootstrap-test-token",
    sessionToken: "session-test-token",
    capture,
  });
  const server = createServer((request, response) => void app.handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
    assert.equal((await fetch(`${base}/api/documents`)).status, 401);
    const launch = await fetch(`${base}/launch?token=bootstrap-test-token`, { redirect: "manual" });
    assert.equal(launch.status, 302);
    assert.match(launch.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict; Path=\//u);
    assert.equal(
      (await fetch(`${base}/launch?token=bootstrap-test-token`, { redirect: "manual" })).status,
      401,
    );
    const cookie = (launch.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const jsonHeaders = { Cookie: cookie, Origin: base, "Content-Type": "application/json" };

    const crossOrigin = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: { ...jsonHeaders, Origin: "https://evil.example" },
      body: JSON.stringify({ url: "https://example.com/blocked" }),
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(
      (
        await fetch(`${base}/api/documents`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: base },
          body: JSON.stringify({ url: "https://example.com/no-json-header" }),
        })
      ).status,
      415,
    );

    const createdResponse = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ url: "https://example.com/article#fragment" }),
    });
    assert.equal(createdResponse.status, 202);
    const created = (await createdResponse.json()) as KnowledgeDocument;
    const ready = await waitFor(base, cookie, created.id, "ready");
    assert.equal(ready.sourceUrl, "https://example.com/article");

    const duplicate = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ url: "https://example.com/article" }),
    });
    assert.equal(duplicate.status, 200);
    assert.equal(((await duplicate.json()) as KnowledgeDocument).id, ready.id);

    const editedResponse = await fetch(`${base}/api/documents/${ready.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ revision: ready.revision, markdown: "# Human edit", tags: ["Inbox"] }),
    });
    assert.equal(editedResponse.status, 200);
    const edited = (await editedResponse.json()) as KnowledgeDocument;
    assert.deepEqual(edited.tags, ["Inbox"]);

    const conflict = await fetch(`${base}/api/documents/${ready.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ revision: ready.revision, title: "Stale" }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: { document: KnowledgeDocument } }).error.document.revision, edited.revision);

    const exported = await fetch(`${base}/api/documents/${ready.id}/export.md`, {
      headers: { Cookie: cookie },
    });
    assert.equal(exported.status, 200);
    const exportedText = await exported.text();
    assert.match(exportedText, /^---\ntitle: "Captured article"\nsource: "https:\/\/example\.com\/article"/u);
    assert.match(exportedText, /tags: \["Inbox"\]\n---\n\n# Human edit\n$/u);

    const failedCreate = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ url: "https://example.com/retry" }),
    });
    const failedId = ((await failedCreate.json()) as KnowledgeDocument).id;
    await waitFor(base, cookie, failedId, "failed");
    const retry = await fetch(`${base}/api/documents/${failedId}/retry`, {
      method: "POST",
      headers: jsonHeaders,
    });
    assert.equal(retry.status, 202);
    await waitFor(base, cookie, failedId, "ready");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
