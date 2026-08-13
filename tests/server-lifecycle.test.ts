import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { openDatabase } from "../server/db.js";

function startService(dataDir?: string, home?: string, overrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KB_DESKTOP: "1",
    KB_TRUST_LOCALHOST: "0",
    KB_STATIC_DIR: resolve("dist"),
    ...overrides,
  };
  if (dataDir) env.KB_DATA_DIR = dataDir;
  else delete env.KB_DATA_DIR;
  if (home) env.HOME = home;
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: resolve("."),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let stdout = "";
  const ready = new Promise<string>((resolveReady, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`service did not become ready: ${stderr}`));
    }, 10_000);
    const exited = (code: number | null) => {
      clearTimeout(timeout);
      reject(new Error(`service exited early (${code}): ${stderr}`));
    };
    const failed = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const match = /ZHIYE_READY (\S+)/u.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        child.off("exit", exited);
        resolveReady(match[1]!);
      }
    });
    child.once("error", failed);
    child.once("exit", exited);
  });
  return { child, ready, stderr: () => stderr, stdout: () => stdout };
}

test("trusted localhost is production-Web-only and reports the bare root URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-trusted-localhost-"));
  const staticDir = join(root, "static");
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>trusted</title>");

  for (const invalid of [
    { KB_DESKTOP: "1", KB_DEV: "0", NODE_ENV: "production" },
    { KB_DESKTOP: "0", KB_DEV: "1", NODE_ENV: "production" },
    { KB_DESKTOP: "0", KB_DEV: "0", NODE_ENV: "development" },
  ]) {
    const service = startService(join(root, "invalid-data"), undefined, {
      ...invalid,
      KB_TRUST_LOCALHOST: "1",
      KB_STATIC_DIR: staticDir,
    });
    await assert.rejects(service.ready, /KB_TRUST_LOCALHOST=1 requires production Web mode/u);
    if (service.child.exitCode === null) service.child.kill("SIGKILL");
  }

  const service = startService(join(root, "data"), undefined, {
    KB_DESKTOP: "0",
    KB_DEV: "0",
    KB_TRUST_LOCALHOST: "1",
    KB_STATIC_DIR: staticDir,
    NODE_ENV: "production",
  });
  const timeout = setTimeout(() => service.child.kill("SIGKILL"), 15_000);
  try {
    const readyUrl = await service.ready;
    assert.match(readyUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/u);
    assert.doesNotMatch(service.stdout(), /\/launch\?token=/u);
    assert.equal((await fetch(`${readyUrl}api/documents`)).status, 401);
    assert.equal((await fetch(readyUrl, { redirect: "manual" })).status, 302);

    const exited = new Promise<number | null>((resolveExit) => service.child.once("exit", resolveExit));
    service.child.kill("SIGTERM");
    assert.equal(await exited, 0, service.stderr());
  } finally {
    clearTimeout(timeout);
    if (service.child.exitCode === null) service.child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("formal default identity reuses one legacy Web library and rejects two", async () => {
  const home = mkdtempSync(join(tmpdir(), "zhiye-default-identity-"));
  const parent = process.platform === "darwin"
    ? join(home, "Library", "Application Support")
    : join(home, ".local", "share");
  const legacy = join(parent, "dev.local.zhiye");
  const current = join(parent, "io.github.sarainoq.zhiye");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "legacy-marker"), "legacy");
  const first = startService(undefined, home);
  const timeout = setTimeout(() => first.child.kill("SIGKILL"), 15_000);
  let conflict: ReturnType<typeof startService> | undefined;
  try {
    await first.ready;
    assert.equal(existsSync(join(legacy, "zhiye.sqlite3")), true);
    assert.equal(existsSync(current), false);
    const exited = new Promise<number | null>((resolveExit) => first.child.once("exit", resolveExit));
    first.child.stdin.write("ZHIYE_SHUTDOWN\n");
    assert.equal(await exited, 0, first.stderr());

    mkdirSync(current);
    writeFileSync(join(current, "formal-marker"), "formal");
    conflict = startService(undefined, home);
    await assert.rejects(conflict.ready, /Both legacy and formal knowledge bases exist/u);
    if (conflict.child.exitCode === null) conflict.child.kill("SIGKILL");
  } finally {
    clearTimeout(timeout);
    if (first.child.exitCode === null) first.child.kill("SIGKILL");
    if (conflict && conflict.child.exitCode === null) conflict.child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});

test("desktop stdin shutdown closes SQLite and releases the data lock", async () => {
  const parent = mkdtempSync(join(tmpdir(), "zhiye-desktop-close-"));
  const dataDir = join(parent, "data");
  const service = startService(dataDir);
  const timeout = setTimeout(() => service.child.kill(), 10_000);
  try {
    await service.ready;
    const exited = new Promise<number | null>((resolveExit) => service.child.once("exit", resolveExit));
    service.child.stdin.write("ZHIYE_SHUTDOWN\n");
    const code = await exited;
    assert.equal(code, 0, service.stderr());
    assert.equal(existsSync(join(parent, ".data.zhiye.lock")), false);
    const reopened = openDatabase(dataDir);
    reopened.close();
  } finally {
    clearTimeout(timeout);
    if (service.child.exitCode === null) service.child.kill();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("SIGKILL leaves a restartable database and interrupted capture", { skip: process.platform === "win32" }, async () => {
  const parent = mkdtempSync(join(tmpdir(), "zhiye-desktop-crash-"));
  const dataDir = join(parent, "data");
  const first = startService(dataDir);
  const timeout = setTimeout(() => first.child.kill("SIGKILL"), 20_000);
  let second: ReturnType<typeof startService> | undefined;
  try {
    await first.ready;
    const timestamp = new Date().toISOString();
    const sql = first.child.exitCode === null ? openDatabase(dataDir).sql : null;
    assert.ok(sql);
    sql.exec("BEGIN IMMEDIATE");
    try {
      sql.prepare(
        `INSERT INTO documents(id, source_url, title, status, created_at, updated_at)
         VALUES ('crash-document', 'https://example.com/crash', 'Crash fixture', 'fetching', ?, ?)`,
      ).run(timestamp, timestamp);
      const job = sql.prepare(
        `INSERT INTO capture_jobs(document_id, status, attempts, available_at, created_at, updated_at)
         VALUES ('crash-document', 'running', 1, ?, ?, ?)`,
      ).run(timestamp, timestamp, timestamp);
      sql.prepare(
        `INSERT INTO captures(id, document_id, job_id, request_url, status, started_at)
         VALUES ('crash-capture', 'crash-document', ?, 'https://example.com/crash', 'fetching', ?)`,
      ).run(job.lastInsertRowid, timestamp);
      sql.exec("COMMIT");
    } catch (error) {
      sql.exec("ROLLBACK");
      throw error;
    } finally {
      sql.close();
    }

    const killed = new Promise<void>((resolveExit) => first.child.once("exit", () => resolveExit()));
    first.child.kill("SIGKILL");
    await killed;
    assert.equal(existsSync(join(parent, ".data.zhiye.lock")), true);

    const recovered = openDatabase(dataDir);
    try {
      assert.equal(
        (recovered.sql.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
        "ok",
      );
      assert.deepEqual(
        { ...recovered.sql.prepare("SELECT status, last_error FROM capture_jobs WHERE document_id = 'crash-document'").get() },
        { status: "queued", last_error: "Interrupted by application restart" },
      );
      assert.deepEqual(
        { ...recovered.sql.prepare("SELECT status, error_code FROM captures WHERE id = 'crash-capture'").get() },
        { status: "failed", error_code: "INTERNAL_ERROR" },
      );
      assert.equal(recovered.getDocument("crash-document")?.status, "queued");
    } finally {
      recovered.close();
    }

    second = startService(dataDir);
    await second.ready;
    const exited = new Promise<number | null>((resolveExit) => second!.child.once("exit", resolveExit));
    const shutdownTimeout = setTimeout(() => second!.child.kill("SIGKILL"), 10_000);
    second.child.stdin.write("ZHIYE_SHUTDOWN\n");
    const code = await exited;
    clearTimeout(shutdownTimeout);
    assert.equal(code, 0, second.stderr());
    assert.equal(existsSync(join(parent, ".data.zhiye.lock")), false);
  } finally {
    clearTimeout(timeout);
    if (first.child.exitCode === null) first.child.kill("SIGKILL");
    if (second?.child.exitCode === null) second.child.kill();
    rmSync(parent, { recursive: true, force: true });
  }
});
