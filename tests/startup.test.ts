import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireDataLock } from "../server/lock.js";
import { runStartup, type SchemaInspection, type StartupOptions } from "../server/startup.js";

function startupOptions(
  dataDir: string,
  events: string[],
  inspection: SchemaInspection = { currentVersion: 3, pending: true },
): StartupOptions<string, string> {
  return {
    dataDir,
    supportedSchemaVersion: 6,
    recoverInterruptedRestore() {
      events.push("recover");
    },
    cleanupIncompleteBackups() {
      events.push("cleanup");
    },
    inspectSchema() {
      events.push("inspect");
      return inspection;
    },
    createPreMigrationBackup() {
      events.push("backup");
      return "backup-id";
    },
    verifyPreMigrationBackup(backup) {
      assert.equal(backup, "backup-id");
      events.push("verify");
    },
    applyMigrations() {
      events.push("migrate");
    },
    open() {
      events.push("open");
      return "database";
    },
    afterOpen() {
      events.push("after-open");
    },
    closeOnError() {
      events.push("close");
    },
  };
}

test("the sibling data lock neither creates nor moves with the data directory", () => {
  const parent = mkdtempSync(join(tmpdir(), "zhiye-startup-lock-"));
  const dataDir = join(parent, "data");
  const previous = join(parent, ".data.previous-test");
  mkdirSync(previous, { mode: 0o700 });
  writeFileSync(join(previous, "marker"), "original");
  const lock = join(parent, ".data.zhiye.lock");
  const release = acquireDataLock(dataDir);
  try {
    assert.equal(existsSync(dataDir), false);
    assert.equal(statSync(lock).mode & 0o777, 0o600);
    assert.throws(() => acquireDataLock(dataDir), /already open/u);

    renameSync(previous, dataDir);
    assert.equal(existsSync(join(dataDir, "marker")), true);
    assert.throws(() => acquireDataLock(dataDir), /already open/u);
  } finally {
    release();
  }
  const releaseAfterSwitch = acquireDataLock(dataDir);
  releaseAfterSwitch();
  rmSync(parent, { recursive: true, force: true });
});

test("the data lock creates a missing custom parent but not the data directory", () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-startup-parent-"));
  const parent = join(root, "custom", "nested");
  const dataDir = join(parent, "data");
  const release = acquireDataLock(dataDir);
  try {
    assert.equal(statSync(parent).mode & 0o777, 0o700);
    assert.equal(existsSync(dataDir), false);
    assert.equal(existsSync(join(parent, ".data.zhiye.lock")), true);
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh incomplete lock is protected while an old malformed lock is recoverable", () => {
  const parent = mkdtempSync(join(tmpdir(), "zhiye-startup-incomplete-lock-"));
  const dataDir = join(parent, "data");
  const lock = join(parent, ".data.zhiye.lock");
  try {
    writeFileSync(lock, "", { mode: 0o600 });
    assert.throws(() => acquireDataLock(dataDir), /already opening/u);
    assert.equal(existsSync(lock), true);

    const old = new Date(Date.now() - 31_000);
    utimesSync(lock, old, old);
    const release = acquireDataLock(dataDir);
    release();
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("startup holds the lock through recovery, verified migration backup, and open hooks", async () => {
  const parent = mkdtempSync(join(tmpdir(), "zhiye-startup-order-"));
  const dataDir = join(parent, "data");
  const events: string[] = [];
  try {
    const handle = await runStartup(startupOptions(dataDir, events));
    assert.equal(handle.value, "database");
    assert.deepEqual(events, ["recover", "cleanup", "inspect", "backup", "verify", "migrate", "open", "after-open"]);
    assert.throws(() => acquireDataLock(dataDir), /already open/u);
    handle.releaseLock();
    const release = acquireDataLock(dataDir);
    release();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a failed pre-migration verification prevents migration and releases the lock", async () => {
  const parent = mkdtempSync(join(tmpdir(), "zhiye-startup-backup-failure-"));
  const dataDir = join(parent, "data");
  const events: string[] = [];
  try {
    const options = startupOptions(dataDir, events);
    options.verifyPreMigrationBackup = () => {
      events.push("verify");
      throw new Error("invalid backup");
    };
    await assert.rejects(runStartup(options), /invalid backup/u);
    assert.deepEqual(events, ["recover", "cleanup", "inspect", "backup", "verify"]);
    const release = acquireDataLock(dataDir);
    release();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a future schema is blocked before backup, migration, or open", async () => {
  const parent = mkdtempSync(join(tmpdir(), "zhiye-startup-future-"));
  const dataDir = join(parent, "data");
  const events: string[] = [];
  try {
    await assert.rejects(
      runStartup(startupOptions(dataDir, events, { currentVersion: 7, pending: false })),
      /newer than supported/u,
    );
    assert.deepEqual(events, ["recover", "cleanup", "inspect"]);
    const release = acquireDataLock(dataDir);
    release();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an after-open failure closes the opened value before releasing the lock", async () => {
  const parent = mkdtempSync(join(tmpdir(), "zhiye-startup-open-failure-"));
  const dataDir = join(parent, "data");
  const events: string[] = [];
  try {
    const options = startupOptions(dataDir, events, { currentVersion: 6, pending: false });
    options.afterOpen = () => {
      events.push("after-open");
      throw new Error("daily backup failed");
    };
    await assert.rejects(runStartup(options), /daily backup failed/u);
    assert.deepEqual(events, ["recover", "cleanup", "inspect", "open", "after-open", "close"]);
    const release = acquireDataLock(dataDir);
    release();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("startup can keep the lock while serving recovery mode", async () => {
  const parent = mkdtempSync(join(tmpdir(), "zhiye-startup-recovery-"));
  const dataDir = join(parent, "data");
  const events: string[] = [];
  try {
    const options = startupOptions(dataDir, events);
    options.inspectSchema = () => {
      events.push("inspect");
      throw new Error("corrupt database");
    };
    options.recoverOnError = (error) => {
      assert.match((error as Error).message, /corrupt database/u);
      events.push("recovery");
      return "recovery-mode";
    };
    const handle = await runStartup(options);
    assert.equal(handle.value, "recovery-mode");
    assert.deepEqual(events, ["recover", "cleanup", "inspect", "recovery"]);
    assert.throws(() => acquireDataLock(dataDir), /already open/u);
    handle.releaseLock();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
