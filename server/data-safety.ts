import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type {
  BackupReason,
  BackupRecord,
  DataSafetyHealth,
  DatabaseHealth,
} from "../shared/types.js";
import {
  createBackup,
  deleteBackup,
  verifyBackup,
  type VerifiedBackup,
} from "./backup.js";
import type { KnowledgeDatabase } from "./db.js";

const backupDirectory = /^backup-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const snapshotPath = /^snapshots\/[a-zA-Z0-9-]+\.html\.gz$/u;
const assetPath = /^assets\/[a-f0-9]{64}$/u;

export class DataSafetyError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DataSafetyError";
    this.status = status;
    this.code = code;
  }
}

export function defaultBackupRoot(dataDir: string) {
  const target = resolve(dataDir);
  return join(dirname(target), `${basename(target)}-backups`);
}

export function errorDetails(error: unknown) {
  return {
    code:
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "INTERNAL_ERROR",
    message: (error instanceof Error ? error.message : "Operation failed").slice(0, 2000),
  };
}

function verifiedRecord(
  backupValue: VerifiedBackup,
  existing?: BackupRecord | null,
): BackupRecord {
  const directoryName = basename(backupValue.path);
  const timestamp = new Date().toISOString();
  return {
    id: existing?.id ?? directoryName,
    directoryName,
    reason: backupValue.manifest.reason,
    status: "verified",
    createdAt: backupValue.manifest.createdAt,
    finishedAt: existing?.finishedAt ?? timestamp,
    verifiedAt: timestamp,
    totalBytes: backupValue.manifest.totalBytes,
    schemaVersion: backupValue.manifest.schemaVersion,
    errorCode: null,
    errorMessage: null,
  };
}

function failedRecord(reason: BackupReason, error: unknown): BackupRecord {
  const timestamp = new Date().toISOString();
  const details = errorDetails(error);
  return {
    id: randomUUID(),
    directoryName: null,
    reason,
    status: "failed",
    createdAt: timestamp,
    finishedAt: timestamp,
    verifiedAt: null,
    totalBytes: null,
    schemaVersion: null,
    errorCode: details.code,
    errorMessage: details.message,
  };
}

function backupEntries(backupRoot: string) {
  if (!existsSync(backupRoot)) return [];
  if (!lstatSync(backupRoot).isDirectory()) {
    throw new DataSafetyError(500, "UNSAFE_BACKUP_ROOT", "Backup storage is not a real directory");
  }
  chmodSync(backupRoot, 0o700);
  return readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && backupDirectory.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function reconcileBackupRecords(db: KnowledgeDatabase, backupRoot: string) {
  const seen = new Set<string>();
  for (const directoryName of backupEntries(backupRoot)) {
    seen.add(directoryName);
    const existing = db.getBackupRecordByDirectoryName(directoryName);
    try {
      const backupValue = await verifyBackup(join(backupRoot, directoryName));
      db.upsertBackupRecord(verifiedRecord(backupValue, existing));
    } catch (error) {
      const details = errorDetails(error);
      const timestamp = new Date().toISOString();
      db.upsertBackupRecord({
        id: existing?.id ?? directoryName,
        directoryName,
        reason: existing?.reason ?? "manual",
        status: "invalid",
        createdAt: existing?.createdAt ?? timestamp,
        finishedAt: existing?.finishedAt ?? timestamp,
        verifiedAt: existing?.verifiedAt ?? null,
        totalBytes: existing?.totalBytes ?? null,
        schemaVersion: existing?.schemaVersion ?? null,
        errorCode: details.code,
        errorMessage: details.message,
      });
    }
  }
  for (const record of db.listBackupRecords()) {
    if (!record.directoryName || seen.has(record.directoryName)) continue;
    db.upsertBackupRecord({
      ...record,
      status: "missing",
      errorCode: "BACKUP_MISSING",
      errorMessage: "Backup directory is missing",
    });
  }
  return db.listBackupRecords();
}

export async function listRecoveryBackups(backupRoot: string) {
  const records: BackupRecord[] = [];
  for (const directoryName of backupEntries(backupRoot)) {
    try {
      records.push(verifiedRecord(await verifyBackup(join(backupRoot, directoryName))));
    } catch (error) {
      const details = errorDetails(error);
      const timestamp = new Date().toISOString();
      records.push({
        id: directoryName,
        directoryName,
        reason: "manual",
        status: "invalid",
        createdAt: timestamp,
        finishedAt: timestamp,
        verifiedAt: null,
        totalBytes: null,
        schemaVersion: null,
        errorCode: details.code,
        errorMessage: details.message,
      });
    }
  }
  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function createRecordedBackup(
  db: KnowledgeDatabase,
  dataDir: string,
  backupRoot: string,
  reason: BackupReason,
) {
  try {
    const backupValue = await createBackup({ dataDir, backupRoot, database: db.sql, reason });
    return db.upsertBackupRecord(
      verifiedRecord(backupValue, db.getBackupRecordByDirectoryName(basename(backupValue.path))),
    );
  } catch (error) {
    db.upsertBackupRecord(failedRecord(reason, error));
    throw error;
  }
}

async function recordAndBackup(
  db: KnowledgeDatabase | null,
  backupRoot: string,
  id: string,
) {
  if (typeof id !== "string" || id.length < 1 || id.length > 300) {
    throw new DataSafetyError(400, "INVALID_BACKUP_ID", "Backup record ID is invalid");
  }
  const record = db
    ? db.getBackupRecord(id)
    : (await listRecoveryBackups(backupRoot)).find((candidate) => candidate.id === id) ?? null;
  if (!record?.directoryName) {
    throw new DataSafetyError(404, "BACKUP_NOT_FOUND", "Backup record not found");
  }
  if (!backupDirectory.test(record.directoryName)) {
    throw new DataSafetyError(500, "UNSAFE_BACKUP_RECORD", "Backup record contains an unsafe directory name");
  }
  const path = join(backupRoot, record.directoryName);
  try {
    const backupValue = await verifyBackup(path);
    const verified = verifiedRecord(backupValue, record);
    db?.upsertBackupRecord(verified);
    return { record: verified, backupValue };
  } catch (error) {
    if (db) {
      const details = errorDetails(error);
      db.upsertBackupRecord({
        ...record,
        status: existsSync(path) ? "invalid" : "missing",
        errorCode: details.code,
        errorMessage: details.message,
      });
    }
    throw error;
  }
}

export async function verifyBackupRecord(db: KnowledgeDatabase, backupRoot: string, id: string) {
  return (await recordAndBackup(db, backupRoot, id)).record;
}

export async function resolveBackupRecord(
  db: KnowledgeDatabase | null,
  backupRoot: string,
  id: string,
) {
  return recordAndBackup(db, backupRoot, id);
}

function localDayRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return [start.toISOString(), next.toISOString()] as const;
}

export async function pruneAutomaticBackups(db: KnowledgeDatabase, backupRoot: string) {
  for (const record of db.listExpiredAutomaticBackups()) {
    if (!record.directoryName) continue;
    await deleteBackup(backupRoot, record.directoryName);
    db.deleteAutomaticBackupRecord(record.id);
  }
}

export async function ensureDailyAutomaticBackup(
  db: KnowledgeDatabase,
  dataDir: string,
  backupRoot: string,
) {
  const [start, next] = localDayRange();
  if (!db.hasAutomaticBackupForDay(start, next)) {
    await createRecordedBackup(db, dataDir, backupRoot, "automatic");
  }
  await pruneAutomaticBackups(db, backupRoot);
}

function snapshotInventory(
  db: KnowledgeDatabase,
  referencedPaths = db.getDatabaseHealth().referencedSnapshotPaths,
) {
  const referenced = new Set(referencedPaths);
  const present = new Set<string>();
  const unsafeSnapshotEntries: string[] = [];
  if (!existsSync(db.snapshotsDir) || !lstatSync(db.snapshotsDir).isDirectory()) {
    unsafeSnapshotEntries.push("snapshots");
  } else {
    for (const entry of readdirSync(db.snapshotsDir, { withFileTypes: true })) {
      const path = `snapshots/${entry.name}`;
      if (!entry.isFile() || !snapshotPath.test(path)) unsafeSnapshotEntries.push(path);
      else present.add(path);
    }
  }
  return {
    missingSnapshots: [...referenced].filter((path) => !present.has(path)).sort(),
    orphanSnapshots: [...present].filter((path) => !referenced.has(path)).sort(),
    unsafeSnapshotEntries: unsafeSnapshotEntries.sort(),
  };
}

function assetInventory(
  db: KnowledgeDatabase,
  referencedPaths = db.getDatabaseHealth().referencedAssetPaths,
) {
  const referenced = new Set(referencedPaths);
  const present = new Set<string>();
  const unsafeAssetEntries: string[] = [];
  if (!existsSync(db.assetsDir) || !lstatSync(db.assetsDir).isDirectory()) {
    unsafeAssetEntries.push("assets");
  } else {
    for (const entry of readdirSync(db.assetsDir, { withFileTypes: true })) {
      const path = `assets/${entry.name}`;
      if (!entry.isFile() || !assetPath.test(path)) unsafeAssetEntries.push(path);
      else present.add(path);
    }
  }
  return {
    missingAssets: [...referenced].filter((path) => !present.has(path)).sort(),
    orphanAssets: [...present].filter((path) => !referenced.has(path)).sort(),
    unsafeAssetEntries: unsafeAssetEntries.sort(),
  };
}

function storageBytes(db: KnowledgeDatabase) {
  let total = 0;
  for (const path of [
    join(db.dataDir, "zhiye.sqlite3"),
    join(db.dataDir, "zhiye.sqlite3-wal"),
    join(db.dataDir, "zhiye.sqlite3-shm"),
  ]) {
    if (existsSync(path) && lstatSync(path).isFile()) total += lstatSync(path).size;
  }
  if (existsSync(db.snapshotsDir) && lstatSync(db.snapshotsDir).isDirectory()) {
    for (const entry of readdirSync(db.snapshotsDir, { withFileTypes: true })) {
      if (entry.isFile()) total += lstatSync(join(db.snapshotsDir, entry.name)).size;
    }
  }
  if (existsSync(db.assetsDir) && lstatSync(db.assetsDir).isDirectory()) {
    for (const entry of readdirSync(db.assetsDir, { withFileTypes: true })) {
      if (entry.isFile()) total += lstatSync(join(db.assetsDir, entry.name)).size;
    }
  }
  return total;
}

export function dataSafetyHealth(db: KnowledgeDatabase): DataSafetyHealth {
  const database: DatabaseHealth = db.getDatabaseHealth();
  return {
    database,
    ...snapshotInventory(db, database.referencedSnapshotPaths),
    ...assetInventory(db, database.referencedAssetPaths),
    storageBytes: storageBytes(db),
    recentBackup: db.listBackupRecords().find((record) => record.status === "verified") ?? null,
  };
}

export function cleanupOrphanSnapshots(db: KnowledgeDatabase) {
  const snapshots = snapshotInventory(db);
  const assets = assetInventory(db);
  const queued = db.queueFileDeletions([...snapshots.orphanSnapshots, ...assets.orphanAssets]);
  db.processPendingFileDeletions();
  return {
    ...queued,
    deleted: queued.queued.filter((path) => !existsSync(join(db.dataDir, path))),
    unsafeSnapshotEntries: snapshots.unsafeSnapshotEntries,
    unsafeAssetEntries: assets.unsafeAssetEntries,
  };
}
