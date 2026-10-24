import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zhiye-startup-maintenance-"));
  const db = openDatabase(join(root, "data"));
  const app = createApp({ dataDir: db.dataDir, database: db, sessionToken: "startup-session", startWorker: false });
  const server = createServer((request, response) => void app.handler(request, response));
  return {
    root, db, app, server,
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      return `http://127.0.0.1:${address.port}`;
    },
    async cleanup() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const headers = { Cookie: "zhiye_session=startup-session" };

test("startup maintenance is visible before listening, blocks mutations, and keeps health responsive", async () => {
  const value = await fixture();
  const release = deferred();
  const entered = deferred();
  const work = value.app.startStartupMaintenance(async (database) => {
    entered.resolve();
    await release.promise;
    assert.equal(database.sql.prepare("SELECT 1 AS alive").get()?.alive, 1);
  });
  try {
    const base = await value.listen();
    await entered.promise;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const status = await fetch(`${base}/api/startup-status`, { headers });
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { maintenance: boolean }).maintenance, true);
    const read = await fetch(`${base}/api/documents`, { headers });
    assert.equal(read.status, 503);
    assert.equal((await read.json() as { error: { code: string } }).error.code, "MAINTENANCE");
    const write = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: { ...headers, Origin: base, "Content-Type": "application/json", "X-Zhiye-Data-Epoch": read.headers.get("x-zhiye-data-epoch")! },
      body: JSON.stringify({ url: "https://example.com/must-not-write" }),
    });
    assert.equal(write.status, 503);
    assert.equal((await write.json() as { error: { code: string } }).error.code, "MAINTENANCE");
    release.resolve();
    await work;
    const ready = await fetch(`${base}/api/documents`, { headers });
    assert.equal(ready.status, 200);
    await ready.arrayBuffer();
    await value.app.startStartupMaintenance(async () => { assert.fail("startup maintenance ran twice"); });
  } finally {
    release.resolve();
    await work;
    await value.cleanup();
  }
});

test("closing waits for startup maintenance before closing SQLite", async () => {
  const value = await fixture();
  const release = deferred();
  const entered = deferred();
  const work = value.app.startStartupMaintenance(async (database) => {
    entered.resolve();
    await release.promise;
    assert.equal(database.sql.prepare("SELECT 1 AS alive").get()?.alive, 1);
  });
  try {
    await value.listen();
    await entered.promise;
    let closed = false;
    const close = value.app.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    release.resolve();
    await work;
    await close;
    assert.throws(() => value.db.sql.prepare("SELECT 1"), /not open|closed/u);
  } finally {
    release.resolve();
    await work;
    await value.cleanup();
  }
});

test("failed startup maintenance releases the gate without disabling the database", async () => {
  const value = await fixture();
  try {
    const base = await value.listen();
    await assert.rejects(value.app.startStartupMaintenance(async () => { throw new Error("backup failed"); }), /backup failed/u);
    const status = await fetch(`${base}/api/startup-status`, { headers });
    assert.equal((await status.json() as { maintenance: boolean }).maintenance, false);
    const read = await fetch(`${base}/api/documents`, { headers });
    assert.equal(read.status, 200);
    await read.arrayBuffer();
  } finally {
    await value.cleanup();
  }
});

for (const draining of [false, true]) {
  test(`shutdown during startup maintenance does not start queued captures (${draining ? "HTTP draining" : "app close"})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "zhiye-startup-shutdown-"));
    const db = openDatabase(join(root, "data"));
    const queued = db.createOrGetDocument("https://example.com/still-queued").document;
    let captures = 0;
    const app = createApp({
      dataDir: db.dataDir,
      database: db,
      capture: async () => { captures += 1; throw new Error("capture must not start during shutdown"); },
    });
    const release = deferred();
    const entered = deferred();
    // Reserve maintenance in the same turn as createApp, before worker wake.
    const work = app.startStartupMaintenance(async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;
      assert.equal(captures, 0);
      let close: Promise<void> | undefined;
      if (draining) app.beginShutdown();
      else close = app.close();
      release.resolve();
      await work;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(captures, 0);
      if (draining) {
        assert.equal(db.getDocument(queued.id)?.status, "queued");
        close = app.close();
      }
      await close;
      const reopened = openDatabase(join(root, "data"));
      try { assert.equal(reopened.getDocument(queued.id)?.status, "queued"); }
      finally { reopened.close(); }
    } finally {
      release.resolve();
      await work;
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}


test("startup status requires authentication and never runs full data diagnostics", async () => {
  const value = await fixture();
  try {
    const base = await value.listen();
    const unauthorized = await fetch(`${base}/api/startup-status`);
    assert.equal(unauthorized.status, 401);
    await unauthorized.arrayBuffer();
    value.db.getDatabaseHealth = () => { throw new Error("startup gate must not scan SQLite or storage"); };
    const status = await fetch(`${base}/api/startup-status`, { headers });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { mode: "ready", maintenance: false });
    // The explicitly requested full safety panel still uses the full diagnostic path.
    const diagnostics = await fetch(`${base}/api/data-safety`, { headers });
    assert.equal(diagnostics.status, 500);
    await diagnostics.arrayBuffer();
  } finally {
    await value.cleanup();
  }
});
