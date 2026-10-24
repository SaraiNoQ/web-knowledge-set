import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";

test("only existing hashed build assets receive immutable private caching", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-static-cache-"));
  const dataDir = join(root, "data");
  const staticDir = join(root, "static");
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>cache test</title>");
  writeFileSync(join(staticDir, "assets", "index-AbCd1234.js"), "export const version = 1;");
  writeFileSync(join(staticDir, "assets", "index-ZyXw9876.js"), "export const version = 2;");
  writeFileSync(join(staticDir, "assets", "unversioned.js"), "export {};");
  const app = createApp({ dataDir, database: openDatabase(dataDir), staticDir, bootstrapToken: "cache-test", startWorker: false });
  const server = createServer((request, response) => void app.handler(request, response));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const launch = await fetch(`${base}/launch?token=cache-test`, { redirect: "manual" });
    const Cookie = (launch.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
    assert.ok(Cookie);
    for (const name of ["index-AbCd1234.js", "index-ZyXw9876.js"]) {
      const response = await fetch(`${base}/assets/${name}`, { headers: { Cookie } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, max-age=31536000, immutable");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(await response.text(), /export const version/);
    }
    for (const path of ["/", "/index.html", "/assets/unversioned.js", "/assets/missing-AbCd1234.js", "/another-route"]) {
      const response = await fetch(`${base}${path}`, { headers: { Cookie } });
      assert.equal(response.headers.get("cache-control"), "no-store", path);
      await response.arrayBuffer();
    }
    const head = await fetch(`${base}/assets/index-AbCd1234.js`, { method: "HEAD", headers: { Cookie } });
    assert.equal(head.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.equal(await head.text(), "");
    // Static application code is public already; user data must still require auth.
    const unauthenticated = await fetch(`${base}/api/documents`, { redirect: "manual" });
    assert.equal(unauthenticated.status, 401);
    assert.notEqual(unauthenticated.headers.get("cache-control"), "private, max-age=31536000, immutable");
    await unauthenticated.arrayBuffer();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
