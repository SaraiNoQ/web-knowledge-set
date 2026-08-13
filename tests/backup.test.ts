import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

import {
  BackupError,
  cleanupIncompleteBackups,
  createBackup,
  createBackupArchive,
  deleteBackup,
  importBackupArchive,
  MAX_BACKUP_ARCHIVE_BYTES,
  recoverInterruptedRestore,
  restoreBackup,
  verifyBackup,
  type BackupManifest,
} from "../server/backup.js";
import { derivedInputHash, openDatabase, type KnowledgeDatabase } from "../server/db.js";
import {
  createRecordedBackup,
  importRecordedBackup,
  pruneAutomaticBackups,
  reconcileBackupRecords,
} from "../server/data-safety.js";
import { acquireDataLock } from "../server/lock.js";

const mutableFs = createRequire(import.meta.url)("node:fs") as {
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
};

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "zhiye-backup-"));
  const dataDir = join(root, "data");
  const backupRoot = join(root, "backups");
  const db = openDatabase(dataDir);
  return { root, dataDir, backupRoot, db };
}

function capturedDocument(db: KnowledgeDatabase, dataDir: string) {
  const created = db.createOrGetDocument("https://example.com/backed-up").document;
  const job = db.claimNextCapture();
  assert.ok(job);
  const snapshotPath = `snapshots/${job.captureId}.html.gz`;
  writeFileSync(join(dataDir, snapshotPath), "compressed-html", { mode: 0o600 });
  const ready = db.completeCapture(
    job,
    {
      title: "Captured title",
      author: "Ada",
      publishedAt: "2026-08-10",
      finalUrl: created.sourceUrl,
      canonicalUrl: created.sourceUrl,
      markdown: "Captured body",
      mode: "http",
      warning: null,
      httpStatus: 200,
    },
    snapshotPath,
  );
  const updated = db.updateDocument(ready.id, ready.revision, {
    title: "Saved title",
    markdown: "Saved body",
    tags: ["Backup", "Local"],
  });
  assert.equal(updated.kind, "updated");
  if (updated.kind !== "updated") throw new Error("Document update failed");
  const assetSource = "https://example.com/backup-image.png";
  const assetBody = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const assetHash = createHash("sha256").update(assetBody).digest("hex");
  assert.equal(db.prepareDocumentAssets(ready.id, [assetSource]), true);
  assert.equal(db.markAssetFetching(ready.id, assetSource), true);
  writeFileSync(db.assetFilePath(assetHash), assetBody, { mode: 0o600 });
  assert.equal(db.completeAsset(ready.id, assetSource, assetHash, "image/png", assetBody.length), true);
  return { document: updated.document, snapshotPath, assetPath: `assets/${assetHash}` };
}

function cleanup(root: string, db?: KnowledgeDatabase) {
  try {
    db?.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function refreshDatabaseManifest(backupPath: string, schemaVersion?: number) {
  const databasePath = join(backupPath, "database.sqlite3");
  const manifestPath = join(backupPath, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  const database = manifest.files.find(({ path }) => path === "database.sqlite3");
  assert.ok(database);
  const previousBytes = database.bytes;
  const bytes = readFileSync(databasePath);
  database.bytes = bytes.length;
  database.sha256 = createHash("sha256").update(bytes).digest("hex");
  manifest.totalBytes += database.bytes - previousBytes;
  if (schemaVersion !== undefined) manifest.schemaVersion = schemaVersion;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function directoryIdentity(path: string) {
  const stat = statSync(path, { bigint: true });
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

function prepareStaging() {}

function writeRestoreMarker(
  dataDir: string,
  operation: string,
  staging: string,
  previous: string,
  preservePrevious = false,
) {
  const target = basename(dataDir);
  const stagingIdentity = directoryIdentity(staging);
  const previousIdentity = directoryIdentity(previous);
  const marker = join(dirname(dataDir), `.${target}.restore.json`);
  writeFileSync(marker, JSON.stringify({
    format: "zhiye-restore-state",
    version: 1,
    target,
    operation,
    staging: basename(staging),
    previous: basename(previous),
    preservePrevious,
    stagingDevice: stagingIdentity.device,
    stagingInode: stagingIdentity.inode,
    previousDevice: previousIdentity.device,
    previousInode: previousIdentity.inode,
  }));
  return marker;
}

test("creates a consistent, owner-only backup and verifies every file", async () => {
  const fixture = workspace();
  try {
    const saved = capturedDocument(fixture.db, fixture.dataDir);
    const importSentinel = "TEMPORARY-IMPORT-SECRET-DO-NOT-BACK-UP-7c94e3f6";
    fixture.db.createImportBatch("urls", [{
      label: importSentinel,
      sourceUrl: "https://example.com/temporary-preview",
      warnings: [],
      error: null,
      payload: { type: "url", url: "https://example.com/temporary-preview" },
    }]);
    writeFileSync(join(fixture.dataDir, "assets/.asset-00000000-0000-4000-8000-000000000000.tmp"), "interrupted");
    mkdirSync(fixture.backupRoot, { mode: 0o777 });
    const result = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
    });

    assert.equal(result.manifest.format, "zhiye-backup");
    assert.equal(result.manifest.version, 2);
    assert.equal(
      result.manifest.schemaVersion,
      (fixture.db.sql.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number })
        .version,
    );
    assert.equal(result.manifest.reason, "manual");
    assert.deepEqual(
      result.manifest.files.map(({ path }) => path),
      ["database.sqlite3", saved.snapshotPath, saved.assetPath],
    );
    assert.equal(statSync(fixture.backupRoot).mode & 0o777, 0o700);
    assert.equal(statSync(result.path).mode & 0o777, 0o700);
    assert.equal(statSync(join(result.path, "manifest.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(result.path, "database.sqlite3")).mode & 0o777, 0o600);
    assert.equal(statSync(join(result.path, saved.snapshotPath)).mode & 0o777, 0o600);
    assert.equal(statSync(join(result.path, saved.assetPath)).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(result.path, "database.sqlite3")).includes(Buffer.from(importSentinel)), false);
    assert.equal(existsSync(join(result.path, "database.sqlite3-wal")), false);
    assert.equal(existsSync(join(result.path, "database.sqlite3-shm")), false);
    assert.equal(readdirSync(fixture.backupRoot).some((name) => name.startsWith(".zhiye-backup-")), false);
    assert.deepEqual(await verifyBackup(result.path), result);

    const copy = new DatabaseSync(join(result.path, "database.sqlite3"), { readOnly: true });
    try {
      const row = copy.prepare("SELECT title, markdown, revision FROM documents WHERE id = ?").get(
        saved.document.id,
      ) as { title: string; markdown: string; revision: number };
      assert.deepEqual({ ...row }, {
        title: saved.document.title,
        markdown: saved.document.markdown,
        revision: saved.document.revision,
      });
      assert.equal((copy.prepare("SELECT count(*) AS total FROM import_batches").get() as { total: number }).total, 0);
      assert.equal((copy.prepare("SELECT count(*) AS total FROM import_items").get() as { total: number }).total, 0);
    } finally {
      copy.close();
    }
    assert.equal((fixture.db.sql.prepare("SELECT count(*) AS total FROM import_batches").get() as { total: number }).total, 1);
  } finally {
    cleanup(fixture.root, fixture.db);
  }
});

test("rejects an asset whose content no longer matches its hash path", async () => {
  const fixture = workspace();
  try {
    const saved = capturedDocument(fixture.db, fixture.dataDir);
    const backupValue = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
    });
    const asset = join(backupValue.path, saved.assetPath);
    const body = readFileSync(asset);
    body[body.length - 1] ^= 1;
    writeFileSync(asset, body);
    const manifestPath = join(backupValue.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
    const entry = manifest.files.find(({ path }) => path === saved.assetPath);
    assert.ok(entry);
    entry.sha256 = createHash("sha256").update(body).digest("hex");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      verifyBackup(backupValue.path),
      (error: unknown) => error instanceof BackupError && error.code === "CHECKSUM_MISMATCH",
    );
  } finally {
    cleanup(fixture.root, fixture.db);
  }
});

test("verifies and restores legacy format v1 backups without an assets directory", async () => {
  const fixture = workspace();
  try {
    const document = fixture.db.createOrGetDocument("https://example.com/legacy-v1").document;
    const backupValue = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
    });
    const manifestPath = join(backupValue.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
    manifest.version = 1;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(join(backupValue.path, "assets"), { recursive: true });
    const legacy = await verifyBackup(backupValue.path);
    assert.equal(legacy.manifest.version, 1);

    fixture.db.close();
    await restoreBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      backupPath: legacy.path,
      supportedSchemaVersion: legacy.manifest.schemaVersion,
      prepareStaging(staging) {
        openDatabase(staging).close();
      },
    });
    const restored = openDatabase(fixture.dataDir);
    try {
      assert.equal(restored.getDocument(document.id)?.sourceUrl, document.sourceUrl);
      assert.equal(existsSync(restored.assetsDir), true);
    } finally {
      restored.close();
    }
  } finally {
    cleanup(fixture.root);
  }
});

test("backup deletion is verified and confined to one real direct child", async () => {
  const fixture = workspace();
  try {
    capturedDocument(fixture.db, fixture.dataDir);
    const backupValue = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
    });
    await assert.rejects(
      deleteBackup(fixture.backupRoot, `../${basename(backupValue.path)}`),
      (error: unknown) => error instanceof BackupError && error.code === "UNSAFE_PATH",
    );
    const linkName = "backup-20260810T000000000Z-33333333-3333-4333-8333-333333333333";
    const link = join(fixture.backupRoot, linkName);
    symlinkSync(backupValue.path, link, "dir");
    await assert.rejects(
      deleteBackup(fixture.backupRoot, linkName),
      (error: unknown) => error instanceof BackupError && error.code === "UNSAFE_PATH",
    );
    assert.equal(existsSync(backupValue.path), true);
    assert.equal(existsSync(link), true);
    rmSync(link);
    assert.deepEqual(await deleteBackup(fixture.backupRoot, basename(backupValue.path)), backupValue);
    assert.equal(existsSync(backupValue.path), false);
  } finally {
    cleanup(fixture.root, fixture.db);
  }
});

test("restore round-trips data and keeps a verified pre-restore backup", async () => {
  const fixture = workspace();
  let releaseLock: (() => void) | undefined;
  try {
    const saved = capturedDocument(fixture.db, fixture.dataDir);
    assert.equal(fixture.db.saveDerivedResult({
      documentId: saved.document.id,
      type: "summary",
      model: "backup-test",
      endpointId: "local-test",
      promptVersion: "summary-v1",
      inputHash: derivedInputHash(saved.document.title, saved.document.markdown),
      output: "Summary retained only by full backup",
      durationMs: 1,
      sourceChars: saved.document.title.length + saved.document.markdown.length,
      sentChars: saved.document.title.length + saved.document.markdown.length,
      truncated: false,
    }).kind, "saved");
    writeFileSync(join(fixture.dataDir, "snapshots/orphan.html.gz"), "recoverable orphan", { mode: 0o600 });
    const original = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
    });
    const changed = fixture.db.updateDocument(saved.document.id, saved.document.revision, {
      title: "Changed after backup",
      markdown: "Changed after backup",
      tags: ["Changed"],
    });
    assert.equal(changed.kind, "updated");
    fixture.db.createOrGetDocument("https://example.com/created-later");
    fixture.db.sql.prepare("DELETE FROM schema_migrations WHERE version = ?").run(original.manifest.schemaVersion);
    fixture.db.close();
    releaseLock = acquireDataLock(fixture.dataDir);
    const lockPath = join(dirname(fixture.dataDir), `.${basename(fixture.dataDir)}.zhiye.lock`);
    assert.equal(existsSync(lockPath), true);

    const restored = await restoreBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      backupPath: original.path,
      supportedSchemaVersion: original.manifest.schemaVersion,
      prepareStaging,
    });
    const preRestoreBackup = restored.preRestoreBackup;
    assert.ok(preRestoreBackup);
    assert.equal(preRestoreBackup.manifest.reason, "pre-restore");
    await verifyBackup(preRestoreBackup.path);
    assert.equal(restored.quarantinedDataPath, null);
    assert.equal(restored.cleanupPending, false);
    assert.equal(existsSync(lockPath), true);
    assert.equal(existsSync(join(fixture.dataDir, ".zhiye.lock")), false);
    releaseLock();
    releaseLock = undefined;
    assert.equal(existsSync(lockPath), false);

    const current = openDatabase(fixture.dataDir);
    try {
      const document = current.getDocument(saved.document.id);
      assert.ok(document);
      assert.equal(document.title, saved.document.title);
      assert.equal(document.markdown, saved.document.markdown);
      assert.equal(document.revision, saved.document.revision);
      assert.deepEqual(document.tags, saved.document.tags);
      assert.equal(current.listDerivedResults(document.id)?.items[0]?.output, "Summary retained only by full backup");
      assert.equal(current.listDocuments().total, 1);
      assert.equal(readFileSync(join(fixture.dataDir, saved.snapshotPath), "utf8"), "compressed-html");
      assert.deepEqual(readFileSync(join(fixture.dataDir, saved.assetPath)), readFileSync(join(original.path, saved.assetPath)));
      assert.equal(readFileSync(join(fixture.dataDir, "snapshots/orphan.html.gz"), "utf8"), "recoverable orphan");
    } finally {
      current.close();
    }

    const preRestore = new DatabaseSync(join(preRestoreBackup.path, "database.sqlite3"), {
      readOnly: true,
    });
    try {
      assert.equal(
        (preRestore.prepare("SELECT title FROM documents WHERE id = ?").get(saved.document.id) as { title: string })
          .title,
        "Changed after backup",
      );
      assert.equal((preRestore.prepare("SELECT count(*) AS count FROM documents").get() as { count: number }).count, 2);
    } finally {
      preRestore.close();
    }
    assert.equal(
      readdirSync(dirname(fixture.dataDir)).some((name) =>
        name.startsWith(`.${basename(fixture.dataDir)}.previous-`),
      ),
      false,
    );
  } finally {
    releaseLock?.();
    cleanup(fixture.root);
  }
});

test("post-switch cleanup failure reports an active restore and remains recoverable", async () => {
  const fixture = workspace();
  try {
    capturedDocument(fixture.db, fixture.dataDir);
    const backupValue = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
    });
    fixture.db.close();

    const originalRmSync = mutableFs.rmSync;
    mutableFs.rmSync = ((...args: Parameters<typeof rmSync>) => {
      if (basename(String(args[0])).startsWith(`.${basename(fixture.dataDir)}.previous-`)) {
        throw new Error("simulated old-data cleanup failure");
      }
      return originalRmSync(...args);
    }) as typeof rmSync;
    syncBuiltinESMExports();
    const restored = await (async () => {
      try {
        return await restoreBackup({
          dataDir: fixture.dataDir,
          backupRoot: fixture.backupRoot,
          backupPath: backupValue.path,
          supportedSchemaVersion: backupValue.manifest.schemaVersion,
          prepareStaging,
        });
      } finally {
        mutableFs.rmSync = originalRmSync;
        syncBuiltinESMExports();
      }
    })();

    assert.equal(restored.cleanupPending, true);
    assert.equal(existsSync(join(fixture.dataDir, "zhiye.sqlite3")), true);
    assert.equal(recoverInterruptedRestore(fixture.dataDir), "kept-current");
    assert.equal(
      readdirSync(dirname(fixture.dataDir)).some((name) =>
        name.startsWith(`.${basename(fixture.dataDir)}.previous-`),
      ),
      false,
    );
  } finally {
    cleanup(fixture.root);
  }
});

test("unsafe backup paths and checksum failure abort restore before current data is changed", async () => {
  const fixture = workspace();
  try {
    const saved = capturedDocument(fixture.db, fixture.dataDir);
    const backupValue = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
    });
    const changed = fixture.db.updateDocument(saved.document.id, saved.document.revision, {
      title: "Must survive failed restore",
    });
    assert.equal(changed.kind, "updated");
    fixture.db.close();

    const traversedPath = `${fixture.backupRoot}/nested/../${basename(backupValue.path)}`;
    await assert.rejects(
      restoreBackup({
        dataDir: fixture.dataDir,
        backupRoot: fixture.backupRoot,
        backupPath: traversedPath,
        supportedSchemaVersion: backupValue.manifest.schemaVersion,
        prepareStaging,
      }),
      (error: unknown) => error instanceof BackupError && error.code === "UNSAFE_PATH",
    );
    const invalidNamePath = join(fixture.backupRoot, "imported-backup");
    renameSync(backupValue.path, invalidNamePath);
    try {
      await assert.rejects(
        restoreBackup({
          dataDir: fixture.dataDir,
          backupRoot: fixture.backupRoot,
          backupPath: invalidNamePath,
          supportedSchemaVersion: backupValue.manifest.schemaVersion,
          prepareStaging,
        }),
        (error: unknown) => error instanceof BackupError && error.code === "UNSAFE_PATH",
      );
    } finally {
      renameSync(invalidNamePath, backupValue.path);
    }
    const outsidePath = join(fixture.root, basename(backupValue.path));
    renameSync(backupValue.path, outsidePath);
    try {
      await assert.rejects(
        restoreBackup({
          dataDir: fixture.dataDir,
          backupRoot: fixture.backupRoot,
          backupPath: outsidePath,
          supportedSchemaVersion: backupValue.manifest.schemaVersion,
          prepareStaging,
        }),
        (error: unknown) => error instanceof BackupError && error.code === "UNSAFE_PATH",
      );
    } finally {
      renameSync(outsidePath, backupValue.path);
    }

    writeFileSync(join(backupValue.path, saved.snapshotPath), "tampered");

    await assert.rejects(
      restoreBackup({
        dataDir: fixture.dataDir,
        backupRoot: fixture.backupRoot,
        backupPath: backupValue.path,
        supportedSchemaVersion: backupValue.manifest.schemaVersion,
        prepareStaging,
      }),
      (error: unknown) => error instanceof BackupError && error.code === "CHECKSUM_MISMATCH",
    );
    const current = openDatabase(fixture.dataDir);
    try {
      assert.equal(current.getDocument(saved.document.id)?.title, "Must survive failed restore");
    } finally {
      current.close();
    }
    assert.equal(readdirSync(fixture.backupRoot).length, 1);
  } finally {
    cleanup(fixture.root);
  }
});

test("unsupported current data requires quarantine confirmation", async () => {
  const fixture = workspace();
  try {
    capturedDocument(fixture.db, fixture.dataDir);
    const backupValue = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
    });
    fixture.db.close();
    const unknown = join(fixture.dataDir, "future-data.bin");
    writeFileSync(unknown, "must not be deleted");

    await assert.rejects(
      restoreBackup({
        dataDir: fixture.dataDir,
        backupRoot: fixture.backupRoot,
        backupPath: backupValue.path,
        supportedSchemaVersion: backupValue.manifest.schemaVersion,
        prepareStaging,
      }),
      (error: unknown) => error instanceof BackupError && error.code === "QUARANTINE_REQUIRED",
    );
    assert.equal(readFileSync(unknown, "utf8"), "must not be deleted");
    assert.equal(existsSync(join(fixture.dataDir, "zhiye.sqlite3")), true);
  } finally {
    cleanup(fixture.root);
  }
});

test("insufficient space stops before a backup is published", async () => {
  const fixture = workspace();
  try {
    const saved = capturedDocument(fixture.db, fixture.dataDir);
    const space = statfsSync(fixture.root, { bigint: true });
    const oversized = space.bavail * space.bsize + 2n * 1024n * 1024n;
    assert.ok(oversized < BigInt(Number.MAX_SAFE_INTEGER));
    truncateSync(join(fixture.dataDir, saved.snapshotPath), Number(oversized));

    await assert.rejects(
      createBackup({
        dataDir: fixture.dataDir,
        backupRoot: fixture.backupRoot,
        database: fixture.db.sql,
      }),
      (error: unknown) => error instanceof BackupError && error.code === "INSUFFICIENT_SPACE",
    );
    assert.deepEqual(readdirSync(fixture.backupRoot), []);
    assert.ok(fixture.db.getDocument(saved.document.id));
  } finally {
    cleanup(fixture.root, fixture.db);
  }
});

test("backup root cannot overlap or contain the data directory", async () => {
  const fixture = workspace();
  try {
    capturedDocument(fixture.db, fixture.dataDir);
    assert.throws(
      () => cleanupIncompleteBackups(fixture.root, fixture.dataDir),
      (error: unknown) => error instanceof BackupError && error.code === "UNSAFE_PATH",
    );
    await assert.rejects(
      createBackup({
        dataDir: fixture.dataDir,
        backupRoot: fixture.root,
        database: fixture.db.sql,
      }),
      (error: unknown) => error instanceof BackupError && error.code === "UNSAFE_PATH",
    );
    const alias = join(fixture.root, "data-alias");
    symlinkSync(fixture.dataDir, alias, "dir");
    const escapedRoot = join(alias, "snapshots", "backups");

    await assert.rejects(
      createBackup({
        dataDir: fixture.dataDir,
        backupRoot: escapedRoot,
        database: fixture.db.sql,
      }),
      (error: unknown) => error instanceof BackupError && error.code === "UNSAFE_PATH",
    );
    assert.equal(existsSync(join(fixture.dataDir, "snapshots", "backups")), false);
  } finally {
    cleanup(fixture.root, fixture.db);
  }
});

test("a checksummed but corrupt SQLite copy is rejected", async () => {
  const fixture = workspace();
  try {
    capturedDocument(fixture.db, fixture.dataDir);
    const backupValue = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
    });
    const databasePath = join(backupValue.path, "database.sqlite3");
    const bytes = readFileSync(databasePath);
    bytes[0] = bytes[0]! ^ 0xff;
    writeFileSync(databasePath, bytes);
    refreshDatabaseManifest(backupValue.path);

    await assert.rejects(
      verifyBackup(backupValue.path),
      (error: unknown) => error instanceof BackupError && error.code === "INVALID_DATABASE",
    );
  } finally {
    cleanup(fixture.root, fixture.db);
  }
});

test("restore rejects non-contiguous and future migration histories", async () => {
  const fixture = workspace();
  try {
    capturedDocument(fixture.db, fixture.dataDir);
    const missing = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
    });
    const future = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
    });

    const missingDb = new DatabaseSync(join(missing.path, "database.sqlite3"));
    missingDb.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    missingDb.close();
    refreshDatabaseManifest(missing.path);
    await assert.rejects(
      verifyBackup(missing.path),
      (error: unknown) => error instanceof BackupError && error.code === "INVALID_DATABASE",
    );

    const currentVersion = future.manifest.schemaVersion;
    const futureDb = new DatabaseSync(join(future.path, "database.sqlite3"));
    futureDb
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(currentVersion + 1, new Date().toISOString());
    futureDb.close();
    refreshDatabaseManifest(future.path, currentVersion + 1);
    await verifyBackup(future.path);
    fixture.db.close();
    await assert.rejects(
      restoreBackup({
        dataDir: fixture.dataDir,
        backupRoot: fixture.backupRoot,
        backupPath: future.path,
        supportedSchemaVersion: currentVersion,
        prepareStaging,
      }),
      (error: unknown) => error instanceof BackupError && error.code === "UNSUPPORTED_SCHEMA",
    );
    assert.equal(existsSync(join(fixture.dataDir, "zhiye.sqlite3")), true);
  } finally {
    cleanup(fixture.root);
  }
});

test("startup recovery rolls an interrupted directory switch back", () => {
  const fixture = workspace();
  try {
    fixture.db.close();
    const parent = dirname(fixture.dataDir);
    const operation = "11111111-1111-4111-8111-111111111111";
    const target = basename(fixture.dataDir);
    const previous = join(parent, `.${target}.previous-${operation}`);
    const staging = join(parent, `.${target}.restore-${operation}`);
    mkdirSync(staging);
    renameSync(fixture.dataDir, previous);
    writeFileSync(join(previous, "sentinel"), "original");
    writeFileSync(join(staging, "partial"), "incomplete restore");
    const marker = writeRestoreMarker(fixture.dataDir, operation, staging, previous);

    assert.equal(recoverInterruptedRestore(fixture.dataDir), "rolled-back");
    assert.equal(readFileSync(join(fixture.dataDir, "sentinel"), "utf8"), "original");
    assert.equal(existsSync(staging), false);
    assert.equal(existsSync(marker), false);
  } finally {
    cleanup(fixture.root);
  }
});

test("restore preserves recovery state when the directory switch loses a safe rollback", async () => {
  for (const scenario of ["recreated-target", "missing-original", "all-three-missing"] as const) {
    const fixture = workspace();
    try {
      capturedDocument(fixture.db, fixture.dataDir);
      const backupValue = await createBackup({
        dataDir: fixture.dataDir,
        backupRoot: fixture.backupRoot,
        database: fixture.db.sql,
      });
      fixture.db.close();
      const parent = dirname(fixture.dataDir);
      const target = basename(fixture.dataDir);
      const marker = join(parent, `.${target}.restore.json`);
      const originalRenameSync = mutableFs.renameSync;
      mutableFs.renameSync = ((...args: Parameters<typeof renameSync>) => {
        originalRenameSync(...args);
        if (
          String(args[0]) === fixture.dataDir &&
          basename(String(args[1])).startsWith(`.${target}.previous-`)
        ) {
          if (scenario === "recreated-target") {
            mkdirSync(fixture.dataDir);
            writeFileSync(join(fixture.dataDir, ".zhiye.lock"), "new lock");
          } else {
            rmSync(String(args[1]), { recursive: true });
            if (scenario === "all-three-missing") {
              const stagingName = readdirSync(parent).find((name) => name.startsWith(`.${target}.restore-`));
              if (!stagingName) throw new Error("restore staging was missing before fault injection");
              rmSync(join(parent, stagingName), { recursive: true });
            }
            throw new Error("simulated loss of original data after directory switch");
          }
        }
      }) as typeof renameSync;
      syncBuiltinESMExports();

      await assert.rejects(
        (async () => {
          try {
            await restoreBackup({
              dataDir: fixture.dataDir,
              backupRoot: fixture.backupRoot,
              backupPath: backupValue.path,
              supportedSchemaVersion: backupValue.manifest.schemaVersion,
              prepareStaging,
            });
          } finally {
            mutableFs.renameSync = originalRenameSync;
            syncBuiltinESMExports();
          }
        })(),
        (error: unknown) => error instanceof BackupError && error.code === "RESTORE_CLEANUP_FAILED",
      );

      const previousName = readdirSync(parent).find((name) => name.startsWith(`.${target}.previous-`));
      const stagingName = readdirSync(parent).find((name) => name.startsWith(`.${target}.restore-`));

      if (scenario === "recreated-target") {
        assert.ok(previousName);
        assert.throws(
          () => recoverInterruptedRestore(fixture.dataDir),
          (error: unknown) => error instanceof BackupError && error.code === "RESTORE_RECOVERY_CONFLICT",
        );
        assert.equal(existsSync(join(parent, previousName, "zhiye.sqlite3")), true);
        assert.equal(readFileSync(join(fixture.dataDir, ".zhiye.lock"), "utf8"), "new lock");
        const alias = join(fixture.root, "data-alias");
        symlinkSync(fixture.dataDir, alias, "dir");
        assert.throws(
          () => recoverInterruptedRestore(alias),
          (error: unknown) => error instanceof BackupError && error.code === "UNSAFE_PATH",
        );
      } else {
        assert.equal(previousName, undefined);
        assert.equal(existsSync(fixture.dataDir), false);
        assert.throws(
          () => recoverInterruptedRestore(fixture.dataDir),
          (error: unknown) => error instanceof BackupError && error.code === "RESTORE_RECOVERY_FAILED",
        );
      }
      if (scenario === "all-three-missing") {
        assert.equal(stagingName, undefined);
      } else {
        assert.ok(stagingName);
        assert.equal(existsSync(join(parent, stagingName, "zhiye.sqlite3")), true);
      }
      assert.equal(existsSync(marker), true);
    } finally {
      cleanup(fixture.root);
    }
  }
});

test("an unmigrated staging database is rejected before switching live data", async () => {
  const fixture = workspace();
  try {
    const saved = capturedDocument(fixture.db, fixture.dataDir);
    const backupValue = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
    });
    const supportedSchemaVersion = backupValue.manifest.schemaVersion;
    const backupDatabase = new DatabaseSync(join(backupValue.path, "database.sqlite3"));
    backupDatabase.prepare("DELETE FROM schema_migrations WHERE version = ?").run(supportedSchemaVersion);
    backupDatabase.close();
    refreshDatabaseManifest(backupValue.path, supportedSchemaVersion - 1);
    const changed = fixture.db.updateDocument(saved.document.id, saved.document.revision, {
      title: "Live data must remain",
    });
    assert.equal(changed.kind, "updated");
    fixture.db.close();
    let prepared = false;

    await assert.rejects(
      restoreBackup({
        dataDir: fixture.dataDir,
        backupRoot: fixture.backupRoot,
        backupPath: backupValue.path,
        supportedSchemaVersion,
        prepareStaging(staging) {
          prepared = true;
          assert.equal(existsSync(join(staging, "zhiye.sqlite3")), true);
        },
      }),
      (error: unknown) => error instanceof BackupError && error.code === "STAGING_SCHEMA_MISMATCH",
    );
    assert.equal(prepared, true);
    const current = openDatabase(fixture.dataDir);
    try {
      assert.equal(current.getDocument(saved.document.id)?.title, "Live data must remain");
    } finally {
      current.close();
    }
    assert.equal(
      readdirSync(dirname(fixture.dataDir)).some((name) =>
        name.startsWith(`.${basename(fixture.dataDir)}.restore-`),
      ),
      false,
    );
  } finally {
    cleanup(fixture.root);
  }
});

test("corrupt current data requires confirmation and is preserved by quarantine restore", async () => {
  const fixture = workspace();
  try {
    const saved = capturedDocument(fixture.db, fixture.dataDir);
    const backupValue = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
    });
    fixture.db.close();
    const databasePath = join(fixture.dataDir, "zhiye.sqlite3");
    const corrupt = readFileSync(databasePath);
    corrupt[0] = corrupt[0]! ^ 0xff;
    writeFileSync(databasePath, corrupt);

    await assert.rejects(
      restoreBackup({
        dataDir: fixture.dataDir,
        backupRoot: fixture.backupRoot,
        backupPath: backupValue.path,
        supportedSchemaVersion: backupValue.manifest.schemaVersion,
        prepareStaging,
      }),
      (error: unknown) => error instanceof BackupError && error.code === "QUARANTINE_REQUIRED",
    );
    assert.deepEqual(readFileSync(databasePath), corrupt);
    const unsupportedPath = join(fixture.dataDir, "unsupported.bin");
    writeFileSync(unsupportedPath, "preserve all current data");

    const restored = await restoreBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      backupPath: backupValue.path,
      supportedSchemaVersion: backupValue.manifest.schemaVersion,
      prepareStaging,
      allowQuarantine: true,
    });
    assert.equal(restored.preRestoreBackup, null);
    const quarantinedDataPath = restored.quarantinedDataPath;
    assert.ok(quarantinedDataPath);
    assert.equal(restored.cleanupPending, false);
    assert.deepEqual(readFileSync(join(quarantinedDataPath, "zhiye.sqlite3")), corrupt);
    assert.equal(readFileSync(join(quarantinedDataPath, "unsupported.bin"), "utf8"), "preserve all current data");
    const current = openDatabase(fixture.dataDir);
    try {
      assert.equal(current.getDocument(saved.document.id)?.title, saved.document.title);
    } finally {
      current.close();
    }
  } finally {
    cleanup(fixture.root);
  }
});

test("full backup archives round-trip without restoring until explicitly requested", async () => {
  const fixture = workspace();
  let current: KnowledgeDatabase | undefined = fixture.db;
  try {
    const saved = capturedDocument(fixture.db, fixture.dataDir);
    const original = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
      reason: "manual",
    });
    const changed = fixture.db.updateDocument(saved.document.id, saved.document.revision, {
      title: "Changed after archive export",
    });
    assert.equal(changed.kind, "updated");

    const archive = await createBackupArchive({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      backupPath: original.path,
    });
    assert.match(archive.filename, /^backup-.+\.zhiye-backup$/u);
    assert.equal(statSync(archive.path).mode & 0o777, 0o600);
    assert.equal(statSync(archive.path).size, archive.bytes);

    const imported = await importBackupArchive({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      source: createReadStream(archive.path),
      declaredBytes: archive.bytes,
      supportedSchemaVersion: original.manifest.schemaVersion,
    });
    assert.notEqual(imported.path, original.path);
    assert.deepEqual(imported.manifest, original.manifest);
    assert.equal(fixture.db.getDocument(saved.document.id)?.title, "Changed after archive export");

    fixture.db.close();
    current = undefined;
    await restoreBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      backupPath: imported.path,
      supportedSchemaVersion: imported.manifest.schemaVersion,
      prepareStaging,
    });
    current = openDatabase(fixture.dataDir);
    assert.equal(current.getDocument(saved.document.id)?.title, saved.document.title);
    assert.equal(readFileSync(join(fixture.dataDir, saved.snapshotPath), "utf8"), "compressed-html");
    assert.equal(existsSync(join(fixture.dataDir, saved.assetPath)), true);
  } finally {
    cleanup(fixture.root, current);
  }
});

test("full backup archive import rejects unsupported ZIP metadata and cleans staging", async () => {
  const fixture = workspace();
  try {
    capturedDocument(fixture.db, fixture.dataDir);
    const backupValue = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
    });
    const archive = await createBackupArchive({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      backupPath: backupValue.path,
    });
    const valid = readFileSync(archive.path);
    const central = valid.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const eocd = valid.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(central > 0 && eocd > central);

    const encrypted = Buffer.from(valid);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6);
    const symlink = Buffer.from(valid);
    symlink.writeUInt16LE((3 << 8) | (symlink.readUInt16LE(central + 4) & 0xff), central + 4);
    symlink.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    const zip64 = Buffer.from(valid);
    zip64.writeUInt16LE(0xffff, eocd + 8);
    zip64.writeUInt16LE(0xffff, eocd + 10);
    const corrupt = Buffer.from(valid);
    const firstData = 30 + corrupt.readUInt16LE(26) + corrupt.readUInt16LE(28);
    corrupt[firstData] = corrupt[firstData]! ^ 1;
    const unknown = Buffer.from(zipSync({ "unknown.txt": strToU8("not a backup") }, { level: 0 }));

    for (const [body, code] of [
      [encrypted, "INVALID_BACKUP_ARCHIVE"],
      [symlink, "ZIP_SYMLINK"],
      [zip64, "INVALID_BACKUP_ARCHIVE"],
      [corrupt, "CHECKSUM_MISMATCH"],
      [unknown, "UNEXPECTED_ZIP_ENTRY"],
    ] as const) {
      await assert.rejects(
        importBackupArchive({
          dataDir: fixture.dataDir,
          backupRoot: fixture.backupRoot,
          source: (async function* () { yield body; })(),
          declaredBytes: body.length,
          supportedSchemaVersion: backupValue.manifest.schemaVersion,
        }),
        (error: unknown) => error instanceof BackupError && error.code === code,
      );
      assert.equal(
        readdirSync(fixture.backupRoot).some((entry) =>
          /^\.zhiye-backup-(?:import-[a-f0-9-]{36}\.tmp|[a-zA-Z0-9]{6})$/u.test(entry)
        ),
        false,
      );
    }
    await assert.rejects(
      importBackupArchive({
        dataDir: fixture.dataDir,
        backupRoot: fixture.backupRoot,
        source: (async function* () {})(),
        declaredBytes: MAX_BACKUP_ARCHIVE_BYTES + 1,
        supportedSchemaVersion: backupValue.manifest.schemaVersion,
      }),
      (error: unknown) => error instanceof BackupError && error.code === "BACKUP_ARCHIVE_TOO_LARGE",
    );

    const controller = new AbortController();
    await assert.rejects(
      importBackupArchive({
        dataDir: fixture.dataDir,
        backupRoot: fixture.backupRoot,
        source: (async function* () {
          yield valid.subarray(0, Math.min(valid.length, 64));
          controller.abort();
          yield valid.subarray(64);
        })(),
        declaredBytes: valid.length,
        supportedSchemaVersion: backupValue.manifest.schemaVersion,
        signal: controller.signal,
      }),
      (error: unknown) => error instanceof BackupError && error.code === "REQUEST_ABORTED",
    );
    assert.equal(
      readdirSync(fixture.backupRoot).some((entry) => entry.startsWith(".zhiye-backup-import-")),
      false,
    );
  } finally {
    cleanup(fixture.root, fixture.db);
  }
});

test("imported automatic archives become manual records and survive retention", async () => {
  const fixture = workspace();
  try {
    capturedDocument(fixture.db, fixture.dataDir);
    const automatic = await createBackup({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      database: fixture.db.sql,
      reason: "automatic",
    });
    const archive = await createBackupArchive({
      dataDir: fixture.dataDir,
      backupRoot: fixture.backupRoot,
      backupPath: automatic.path,
    });
    const imported = await importRecordedBackup(
      fixture.db,
      fixture.dataDir,
      fixture.backupRoot,
      createReadStream(archive.path),
      archive.bytes,
      automatic.manifest.schemaVersion,
    );
    assert.equal(imported.reason, "manual");
    await reconcileBackupRecords(fixture.db, fixture.backupRoot);
    assert.equal(fixture.db.getBackupRecord(imported.id)?.reason, "manual");
    fixture.db.setAutomaticRetentionCount(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    await createRecordedBackup(fixture.db, fixture.dataDir, fixture.backupRoot, "automatic");
    await pruneAutomaticBackups(fixture.db, fixture.backupRoot);
    assert.equal(existsSync(join(fixture.backupRoot, imported.directoryName!)), true);
  } finally {
    cleanup(fixture.root, fixture.db);
  }
});

test("cleanup removes only incomplete backup directories and archives", () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-backup-cleanup-"));
  try {
    const backupRoot = join(root, "backups");
    mkdirSync(backupRoot, { mode: 0o777 });
    const incomplete = mkdtempSync(join(backupRoot, ".zhiye-backup-"));
    const incompleteArchive = join(backupRoot, ".zhiye-backup-import-11111111-1111-4111-8111-111111111111.tmp");
    const complete = join(backupRoot, "backup-complete");
    const unrelated = join(backupRoot, ".zhiye-backup-not-six-characters");
    mkdirSync(complete);
    writeFileSync(incompleteArchive, "incomplete", { mode: 0o600 });
    writeFileSync(unrelated, "keep");

    assert.equal(cleanupIncompleteBackups(backupRoot, join(root, "data")), 2);
    assert.equal(statSync(backupRoot).mode & 0o777, 0o700);
    assert.equal(existsSync(incomplete), false);
    assert.equal(existsSync(incompleteArchive), false);
    assert.equal(existsSync(complete), true);
    assert.equal(readFileSync(unrelated, "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
