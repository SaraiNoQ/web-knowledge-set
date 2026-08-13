import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";

test("browser extension pairs once, creates copies, has no read scope, and revokes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-extension-"));
  const app = createApp({ dataDir: directory, database: openDatabase(directory), dev: true, startWorker: false });
  const server = createServer((request, response) => void app.handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const webHeaders = { Origin: base, "Content-Type": "application/json" };
  const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  try {
    const epoch = (await fetch(`${base}/api/capture-queue`)).headers.get("x-zhiye-data-epoch");
    assert.ok(epoch);
    const codeResponse = await fetch(`${base}/api/settings/browser-extension/pairing-code`, {
      method: "POST", headers: { ...webHeaders, "X-Zhiye-Data-Epoch": epoch }, body: "{}",
    });
    assert.equal(codeResponse.status, 201);
    const { code } = await codeResponse.json() as { code: string };
    const pair = await fetch(`${base}/api/browser-extension/pair`, {
      method: "POST", headers: { Origin: extensionOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ code, browser: "chrome" }),
    });
    assert.equal(pair.status, 201);
    const paired = await pair.json() as { token: string; pairing: { id: string } };
    assert.equal((await fetch(`${base}/api/browser-extension/pair`, {
      method: "POST", headers: { Origin: extensionOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ code, browser: "chrome" }),
    })).status, 401);
    assert.equal((await fetch(`${base}/api/documents`, { headers: {
      Origin: extensionOrigin, Authorization: `Bearer ${paired.token}`,
    } })).status, 403);

    const clip = { sourceUrl: "https://example.com/private", title: "Private page", author: null, publishedAt: null, markdown: "# Private\n\n![image](https://example.com/a.png)" };
    const save = () => fetch(`${base}/api/browser-extension/clips`, {
      method: "POST",
      headers: { Origin: extensionOrigin, Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(clip),
    });
    assert.equal((await save()).status, 201);
    assert.equal((await save()).status, 201);
    assert.equal(app.db.listDocuments({}).total, 2);

    assert.equal((await fetch(`${base}/api/settings/browser-extension/pairings/${paired.pairing.id}`, {
      method: "DELETE", headers: { ...webHeaders, "X-Zhiye-Data-Epoch": epoch }, body: "{}",
    })).status, 204);
    assert.equal((await save()).status, 401);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
