import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { openDatabase } from "../server/db.js";

test("desktop stdin shutdown closes SQLite and releases the data lock", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "zhiye-desktop-close-"));
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
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    await new Promise<void>((resolveReady, reject) => {
      let stdout = "";
      const exited = (code: number | null) => reject(new Error(`service exited early (${code}): ${stderr}`));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("ZHIYE_READY ")) {
          child.off("exit", exited);
          resolveReady();
        }
      });
      child.once("error", reject);
      child.once("exit", exited);
    });
    const exited = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    child.stdin.write("ZHIYE_SHUTDOWN\n");
    const code = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(existsSync(join(dataDir, ".zhiye.lock")), false);
    const reopened = openDatabase(dataDir);
    reopened.close();
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
