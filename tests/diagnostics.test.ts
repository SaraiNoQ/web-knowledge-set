import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { unzipSync } from "fflate";

import { createApp } from "../server/app.js";
import { createBackup, recoverInterruptedRestore } from "../server/backup.js";
import { openDatabase } from "../server/db.js";
import { DiagnosticsLogger } from "../server/diagnostics.js";

test("diagnostic logs stay bounded, expire, and reject symlink targets", () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-diagnostics-log-"));
  try {
    const dataDir = join(root, "data");
    const logger = new DiagnosticsLogger(dataDir);
    const firstLine = `${JSON.stringify({ timestamp: new Date().toISOString(), level: "info", event: "service_starting" })}\n`;
    writeFileSync(logger.activePath, Buffer.concat([Buffer.from(firstLine), Buffer.alloc(1024 * 1024 - Buffer.byteLength(firstLine))]));
    assert.equal(logger.log({ level: "info", event: "service_ready", mode: "web" }), true);
    assert.equal(readdirSync(logger.directory).length, 2);
    assert.equal(statSync(logger.directory).mode & 0o777, 0o700);
    assert.equal(statSync(logger.activePath).mode & 0o777, 0o600);

    const expiredDir = join(root, "expired");
    const expiredLogger = new DiagnosticsLogger(expiredDir);
    const expiredActive = expiredLogger.activePath;
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    writeFileSync(expiredActive, `${JSON.stringify({ timestamp: old.toISOString(), level: "info", event: "service_ready" })}\n`);
    utimesSync(expiredActive, old, old);
    new DiagnosticsLogger(expiredDir);
    assert.equal(existsSync(expiredActive), false);

    const linkedDir = join(root, "linked");
    const outside = join(root, "outside.txt");
    const linked = new DiagnosticsLogger(linkedDir);
    writeFileSync(outside, "unchanged");
    symlinkSync(outside, linked.activePath);
    assert.equal(linked.log({ level: "error", event: "server_error", code: "INTERNAL_ERROR" }), false);
    assert.equal(readFileSync(outside, "utf8"), "unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostic storage stays outside backup and interrupted-restore targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-diagnostics-layout-"));
  const dataDir = join(root, "data");
  try {
    const beforeData = new DiagnosticsLogger(dataDir);
    assert.equal(existsSync(dataDir), false);
    assert.equal(dirname(beforeData.directory), root);
    assert.notEqual(beforeData.directory, dataDir);

    const database = openDatabase(dataDir);
    const backupRoot = join(root, "backups");
    const backup = await createBackup({ dataDir, backupRoot, database: database.sql, reason: "manual" });
    assert.equal(existsSync(join(backup.path, "manifest.json")), true);
    database.close();

    const operation = "11111111-1111-4111-8111-111111111111";
    const target = basename(dataDir);
    const previous = join(root, `.${target}.previous-${operation}`);
    const staging = join(root, `.${target}.restore-${operation}`);
    mkdirSync(staging);
    renameSync(dataDir, previous);
    writeFileSync(join(previous, "sentinel"), "original");
    writeFileSync(join(staging, "partial"), "incomplete");
    const stagingStat = statSync(staging, { bigint: true });
    const previousStat = statSync(previous, { bigint: true });
    writeFileSync(join(root, `.${target}.restore.json`), JSON.stringify({
      format: "zhiye-restore-state",
      version: 1,
      target,
      operation,
      staging: basename(staging),
      previous: basename(previous),
      preservePrevious: false,
      stagingDevice: stagingStat.dev.toString(),
      stagingInode: stagingStat.ino.toString(),
      previousDevice: previousStat.dev.toString(),
      previousInode: previousStat.ino.toString(),
    }));

    new DiagnosticsLogger(dataDir);
    assert.equal(existsSync(dataDir), false);
    assert.equal(recoverInterruptedRestore(dataDir), "rolled-back");
    assert.equal(readFileSync(join(dataDir, "sentinel"), "utf8"), "original");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostic API is authenticated, rejects queries, and exports only allowlisted fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-diagnostics-api-"));
  const dataDir = join(root, "data");
  const database = openDatabase(dataDir);
  const sentinel = "SECRET-SENTINEL-ARTICLE-BODY";
  const sourceUrl = "https://example.com/private?token=SECRET-QUERY-SENTINEL";
  database.createOrGetDocument(sourceUrl);
  const job = database.claimNextCapture();
  assert.ok(job);
  database.failCapture(job, "HTTP_ERROR", sentinel);
  database.sql.prepare("UPDATE captures SET error_code = 'SECRET_TOKEN_SENTINEL' WHERE id = ?").run(job.captureId);
  const diagnostics = new DiagnosticsLogger(dataDir);
  diagnostics.log({ level: "info", event: "service_ready", mode: "web" });
  const app = createApp({
    dataDir,
    database,
    startWorker: false,
    bootstrapToken: "bootstrap-test-token",
    sessionToken: "session-test-token",
    appVersion: "0.9.0-test",
    diagnostics,
  });
  const server = createServer((request, response) => void app.handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Cookie: "zhiye_session=session-test-token" };
  try {
    assert.equal((await fetch(`${base}/api/diagnostics`)).status, 401);
    assert.equal((await fetch(`${base}/api/diagnostics?detail=all`, { headers })).status, 400);
    const reportResponse = await fetch(`${base}/api/diagnostics`, { headers });
    assert.equal(reportResponse.status, 200);
    const reportText = await reportResponse.text();
    assert.match(reportText, /"format":"zhiye-diagnostics"/u);
    assert.match(reportText, /"code":"UNKNOWN_ERROR"/u);
    assert.doesNotMatch(reportText, /SECRET-/u);

    const exportResponse = await fetch(`${base}/api/diagnostics/export.zip`, { headers });
    assert.equal(exportResponse.status, 200);
    assert.equal(exportResponse.headers.get("content-type"), "application/zip");
    const files = unzipSync(new Uint8Array(await exportResponse.arrayBuffer()));
    assert.deepEqual(Object.keys(files).sort(), ["README.txt", "diagnostics.json", "logs.jsonl"]);
    const contents = Object.values(files).map((value) => Buffer.from(value).toString("utf8")).join("\n");
    assert.match(contents, /service_ready/u);
    assert.match(contents, /UNKNOWN_ERROR/u);
    assert.doesNotMatch(contents, /SECRET-SENTINEL|SECRET-QUERY|example\.com|private\?/u);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
