import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../server/app.js";
import { SESSION_COOKIE } from "../server/auth.js";
import { openDatabase } from "../server/db.js";

test("appearance settings validate authenticated mutations and survive a new server origin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-appearance-"));
  const start = async (port = 0) => {
    const app = createApp({ dataDir: directory, database: openDatabase(directory), sessionToken: "appearance-test", startWorker: false });
    const server = createServer((request, response) => void app.handler(request, response));
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return { app, server, base: `http://127.0.0.1:${address.port}`, port: address.port };
  };
  let running = await start();
  const stop = async () => {
    await new Promise<void>((resolve) => running.server.close(() => resolve()));
    await running.app.close();
  };
  const headers = { Cookie: `${SESSION_COOKIE}=appearance-test` };
  try {
    const path = "/api/settings/appearance";
    assert.equal((await fetch(running.base + path)).status, 401);
    const initial = await fetch(running.base + path, { headers });
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { immersiveMode: false });
    const jsonHeaders = { ...headers, Origin: running.base, "Content-Type": "application/json", "X-Zhiye-Data-Epoch": initial.headers.get("x-zhiye-data-epoch")! };
    assert.equal((await fetch(running.base + path, { method: "PUT", headers: { ...jsonHeaders, Cookie: "" }, body: '{"immersiveMode":true}' })).status, 401);
    assert.equal((await fetch(running.base + path, { method: "PUT", headers: { ...jsonHeaders, Origin: "https://other.example" }, body: '{"immersiveMode":true}' })).status, 403);
    assert.equal((await fetch(running.base + path, { method: "PUT", headers: { ...jsonHeaders, "X-Zhiye-Data-Epoch": "stale" }, body: '{"immersiveMode":true}' })).status, 409);
    assert.equal((await fetch(running.base + path + "?extra=1", { headers })).status, 400);
    for (const body of [{}, { immersiveMode: "true" }, { immersiveMode: 1 }, { immersiveMode: null }, { immersiveMode: true, extra: true }]) {
      const invalid = await fetch(running.base + path, { method: "PUT", headers: jsonHeaders, body: JSON.stringify(body) });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, "INVALID_APPEARANCE");
    }
    const saved = await fetch(running.base + path, { method: "PUT", headers: jsonHeaders, body: '{"immersiveMode":true}' });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { immersiveMode: true });
    const previousPort = running.port;
    await stop();
    // Hold the previous port so the reopened service must have a new origin.
    const reserved = createServer();
    await new Promise<void>((resolve) => reserved.listen(previousPort, "127.0.0.1", resolve));
    try { running = await start(); }
    finally { await new Promise<void>((resolve) => reserved.close(() => resolve())); }
    assert.notEqual(running.port, previousPort);
    const reopened = await fetch(running.base + path, { headers });
    assert.deepEqual(await reopened.json(), { immersiveMode: true });
    const reset = await fetch(running.base + path, {
      method: "PUT", headers: { ...jsonHeaders, Origin: running.base, "X-Zhiye-Data-Epoch": reopened.headers.get("x-zhiye-data-epoch")! }, body: '{"immersiveMode":false}',
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { immersiveMode: false });
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
