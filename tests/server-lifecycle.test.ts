import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { openDatabase } from "../server/db.js";

function startService(dataDir: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: resolve("."),
    env: {
      ...process.env,
      KB_DATA_DIR: dataDir,
      KB_DESKTOP: "1",
      KB_STATIC_DIR: resolve("dist"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ready = new Promise<void>((resolveReady, reject) => {
    let stdout = "";
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
      if (stdout.includes("ZHIYE_READY ")) {
        clearTimeout(timeout);
        child.off("exit", exited);
        resolveReady();
      }
    });
    child.once("error", failed);
    child.once("exit", exited);
  });
  return { child, ready, stderr: () => stderr };
}

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
