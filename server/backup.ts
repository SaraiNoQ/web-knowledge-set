import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const FORMAT = "zhiye-backup";
const FORMAT_VERSION = 1;
const DATABASE_FILE = "database.sqlite3";
const LIVE_DATABASE_FILE = "zhiye.sqlite3";
const MANIFEST_FILE = "manifest.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FILES = 100_001;
const SNAPSHOT_PATH = /^snapshots\/[a-zA-Z0-9-]+\.html\.gz$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const BACKUP_DIRECTORY = /^backup-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const reasons = new Set<BackupReason>(["manual", "automatic", "pre-migration", "pre-restore"]);

export type BackupReason = "manual" | "automatic" | "pre-migration" | "pre-restore";

export interface BackupFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  format: typeof FORMAT;
  version: typeof FORMAT_VERSION;
  createdAt: string;
  reason: BackupReason;
  schemaVersion: number;
  totalBytes: number;
  files: BackupFile[];
}

export interface VerifiedBackup {
  path: string;
  manifest: BackupManifest;
}

export class BackupError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "BackupError";
    this.code = code;
    if (cause !== undefined) Object.defineProperty(this, "cause", { value: cause });
  }
}

export interface CreateBackupOptions {
  dataDir: string;
  backupRoot: string;
  database: DatabaseSync;
  reason?: BackupReason;
}

export interface RestoreBackupOptions {
  dataDir: string;
  backupRoot: string;
  backupPath: string;
  supportedSchemaVersion: number;
  prepareStaging: (stagingDataDir: string) => void | Promise<void>;
  allowQuarantine?: boolean;
}

export interface RestoreResult {
  backup: VerifiedBackup;
  preRestoreBackup: VerifiedBackup | null;
  quarantinedDataPath: string | null;
  cleanupPending: boolean;
}

interface RestoreState {
  format: "zhiye-restore-state";
  version: 1;
  target: string;
  operation: string;
  staging: string;
  previous: string;
  preservePrevious: boolean;
  stagingDevice: string;
  stagingInode: string;
  previousDevice: string;
  previousInode: string;
}

interface DirectoryIdentity {
  device: string;
  inode: string;
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new BackupError(code, message, cause);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isInside(parent: string, child: string) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function ensureDirectory(path: string, code = "UNSAFE_PATH") {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    fail(code, `Directory is not accessible: ${path}`, error);
  }
  if (!stat.isDirectory()) fail(code, `Path must be a real directory: ${path}`);
}

function dataTarget(input: string) {
  const requested = resolve(input);
  const name = basename(requested);
  const requestedParent = dirname(requested);
  if (!name || requestedParent === requested) fail("UNSAFE_PATH", "Data directory must have a parent");
  ensureDirectory(requestedParent);
  const target = join(realpathSync(requestedParent), name);
  if (existsSync(target)) {
    ensureDirectory(target);
    if (realpathSync(target) !== target) fail("UNSAFE_PATH", "Data directory must not be a symbolic link");
  }
  return target;
}

function directoryIdentity(path: string, code = "RESTORE_STATE_INVALID"): DirectoryIdentity {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    fail(code, `Directory is not accessible: ${path}`, error);
  }
  if (!stat.isDirectory()) fail(code, `Path must be a real directory: ${path}`);
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity) {
  return left.device === right.device && left.inode === right.inode;
}

function ensureRegularFile(path: string, code = "INVALID_BACKUP") {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    fail(code, `File is not accessible: ${path}`, error);
  }
  if (!stat.isFile()) fail(code, `Path must be a regular file: ${path}`);
  return stat;
}

function prepareBackupRoot(input: string, dataDir: string) {
  const requested = resolve(input);
  const name = basename(requested);
  const parent = dirname(requested);
  if (!name || parent === requested) fail("UNSAFE_PATH", "Backup directory must have a parent");
  ensureDirectory(parent);
  const realParent = realpathSync(parent);
  const requestedRoot = join(realParent, name);
  const overlaps = (path: string) => isInside(dataDir, path) || isInside(path, dataDir);
  if (overlaps(requestedRoot)) {
    fail("UNSAFE_PATH", "Backup directory overlaps protected data");
  }
  if (existsSync(requestedRoot)) {
    ensureDirectory(requestedRoot);
    const root = realpathSync(requestedRoot);
    if (overlaps(root)) fail("UNSAFE_PATH", "Backup directory overlaps protected data");
    chmodSync(root, 0o700);
    return root;
  }
  mkdirSync(requestedRoot, { mode: 0o700 });
  chmodSync(requestedRoot, 0o700);
  syncPath(realParent);
  const root = realpathSync(requestedRoot);
  if (overlaps(root)) fail("UNSAFE_PATH", "Backup directory overlaps protected data");
  return root;
}

/** Call only while no backup operation is running. */
export function cleanupIncompleteBackups(backupRoot: string, dataDir: string) {
  if (!existsSync(backupRoot)) return 0;
  ensureDirectory(backupRoot);
  const root = realpathSync(backupRoot);
  chmodSync(root, 0o700);
  const target = dataTarget(dataDir);
  if (isInside(root, target) || isInside(target, root)) {
    fail("UNSAFE_PATH", "Backup directory overlaps protected data");
  }
  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!/^\.zhiye-backup-[a-zA-Z0-9]{6}$/u.test(entry.name)) continue;
    if (!entry.isDirectory()) fail("UNSAFE_PATH", `Incomplete backup entry is not a directory: ${entry.name}`);
    rmSync(join(root, entry.name), { recursive: true });
    removed += 1;
  }
  if (removed) syncPath(root);
  return removed;
}

/** Call only while no backup operation is running. */
export async function deleteBackup(backupRoot: string, directoryName: string) {
  if (typeof directoryName !== "string" || !BACKUP_DIRECTORY.test(directoryName)) {
    fail("UNSAFE_PATH", "Backup deletion requires a valid direct child directory name");
  }
  let root = resolve(backupRoot);
  ensureDirectory(root);
  root = realpathSync(root);
  const path = join(root, directoryName);
  const identity = directoryIdentity(path, "UNSAFE_PATH");
  const verified = await verifyBackup(path);
  if (verified.path !== path || !sameDirectory(directoryIdentity(path, "UNSAFE_PATH"), identity)) {
    fail("UNSAFE_PATH", "Backup directory changed during deletion");
  }
  rmSync(path, { recursive: true });
  syncPath(root);
  return verified;
}

function backupFilePath(root: string, path: string) {
  if (path !== DATABASE_FILE && !SNAPSHOT_PATH.test(path)) {
    fail("UNSAFE_PATH", `Backup contains an unsafe path: ${path}`);
  }
  return join(root, ...path.split("/"));
}

function sourceSnapshotPath(dataDir: string, path: string) {
  if (!SNAPSHOT_PATH.test(path)) fail("UNSAFE_PATH", `Database contains an unsafe snapshot path: ${path}`);
  const root = join(resolve(dataDir), "snapshots");
  ensureDirectory(root);
  return join(root, basename(path));
}

function sourceSnapshots(dataDir: string, required: string[]) {
  const root = join(resolve(dataDir), "snapshots");
  ensureDirectory(root);
  const paths = readdirSync(root, { withFileTypes: true }).map((entry) => {
    const path = `snapshots/${entry.name}`;
    if (!entry.isFile() || !SNAPSHOT_PATH.test(path)) {
      fail("UNSAFE_PATH", `Snapshot directory contains an unsupported entry: ${entry.name}`);
    }
    return path;
  });
  const present = new Set(paths);
  if (required.some((path) => !present.has(path))) fail("MISSING_SNAPSHOT", "A database snapshot is missing");
  return paths.sort();
}

function ensureSupportedDataLayout(dataDir: string) {
  const allowed = new Set([
    ".zhiye.lock",
    "snapshots",
    LIVE_DATABASE_FILE,
    `${LIVE_DATABASE_FILE}-shm`,
    `${LIVE_DATABASE_FILE}-wal`,
  ]);
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (!allowed.has(entry.name)) {
      fail("UNSUPPORTED_DATA", `Data directory contains an unsupported entry: ${entry.name}`);
    }
    if (entry.name === "snapshots" ? !entry.isDirectory() : !entry.isFile()) {
      fail("UNSAFE_PATH", `Data directory entry has the wrong type: ${entry.name}`);
    }
  }
}

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function syncPath(path: string) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function availableBytes(path: string) {
  const stat = statfsSync(path, { bigint: true });
  return stat.bavail * stat.bsize;
}

function ensureSpace(path: string, payloadBytes: bigint) {
  const reserve = payloadBytes / 20n > 1024n * 1024n ? payloadBytes / 20n : 1024n * 1024n;
  const required = payloadBytes + reserve;
  let available: bigint;
  try {
    available = availableBytes(path);
  } catch (error) {
    fail("SPACE_CHECK_FAILED", `Could not check free space at ${path}`, error);
  }
  if (available < required) {
    fail(
      "INSUFFICIENT_SPACE",
      `Not enough free space: ${required.toString()} bytes required, ${available.toString()} available`,
    );
  }
}

function databaseContents(database: DatabaseSync) {
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      fail("INVALID_DATABASE", "SQLite integrity_check failed");
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length) {
      fail("INVALID_DATABASE", "SQLite foreign_key_check failed");
    }
    const migrations = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    if (!migrations.length || migrations.some(({ version }, index) => version !== index + 1)) {
      fail("INVALID_DATABASE", "SQLite migrations are missing or non-contiguous");
    }
    const snapshots = (
      database
        .prepare(
          `SELECT DISTINCT snapshot_path AS path FROM captures
           WHERE snapshot_path IS NOT NULL ORDER BY snapshot_path`,
        )
        .all() as Array<{ path: string }>
    ).map(({ path }) => {
      if (!SNAPSHOT_PATH.test(path)) fail("UNSAFE_PATH", `Database contains an unsafe snapshot path: ${path}`);
      return path;
    });
    return { schemaVersion: migrations.length, snapshots };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail("INVALID_DATABASE", "Backup database could not be validated", error);
  }
}

function inspectDatabase(path: string) {
  ensureRegularFile(path);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA query_only = ON");
    return databaseContents(database);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail("INVALID_DATABASE", "Backup database could not be opened", error);
  } finally {
    database?.close();
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${path}${suffix}`;
      if (existsSync(sidecar)) {
        ensureRegularFile(sidecar);
        unlinkSync(sidecar);
      }
    }
  }
}

function normalizeDatabaseCopy(path: string) {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA journal_mode = DELETE");
  } finally {
    database.close();
  }
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${path}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
}

function sourceSize(database: DatabaseSync, dataDir: string) {
  const pageCount = database.prepare("PRAGMA page_count").get() as { page_count: number };
  const pageSize = database.prepare("PRAGMA page_size").get() as { page_size: number };
  let bytes = BigInt(pageCount.page_count) * BigInt(pageSize.page_size);
  const required = databaseContents(database).snapshots;
  for (const path of sourceSnapshots(dataDir, required)) {
    bytes += BigInt(ensureRegularFile(sourceSnapshotPath(dataDir, path), "MISSING_SNAPSHOT").size);
  }
  return bytes;
}

function validateDataDirectory(dataDir: string) {
  ensureSupportedDataLayout(dataDir);
  const contents = inspectDatabase(join(dataDir, LIVE_DATABASE_FILE));
  sourceSnapshots(dataDir, contents.snapshots);
  return contents;
}

function parseManifest(path: string): BackupManifest {
  const stat = ensureRegularFile(path);
  if (stat.size > MAX_MANIFEST_BYTES) fail("INVALID_BACKUP", "Backup manifest is too large");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("INVALID_BACKUP", "Backup manifest is not valid JSON", error);
  }
  if (!record(value) || value.format !== FORMAT) fail("INVALID_BACKUP", "Unknown backup format");
  if (value.version !== FORMAT_VERSION) fail("UNSUPPORTED_FORMAT", "Unsupported backup format version");
  if (
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    typeof value.reason !== "string" ||
    !reasons.has(value.reason as BackupReason) ||
    !Number.isInteger(value.schemaVersion) ||
    Number(value.schemaVersion) < 1 ||
    !Number.isSafeInteger(value.totalBytes) ||
    Number(value.totalBytes) < 1 ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > MAX_FILES
  ) {
    fail("INVALID_BACKUP", "Backup manifest fields are invalid");
  }
  const seen = new Set<string>();
  const files = value.files.map((item) => {
    if (
      !record(item) ||
      typeof item.path !== "string" ||
      (item.path !== DATABASE_FILE && !SNAPSHOT_PATH.test(item.path)) ||
      !Number.isSafeInteger(item.bytes) ||
      Number(item.bytes) < 0 ||
      typeof item.sha256 !== "string" ||
      !SHA256.test(item.sha256) ||
      seen.has(item.path)
    ) {
      fail("INVALID_BACKUP", "Backup manifest contains an invalid file entry");
    }
    seen.add(item.path);
    return { path: item.path, bytes: Number(item.bytes), sha256: item.sha256 };
  });
  if (!seen.has(DATABASE_FILE)) fail("INVALID_BACKUP", "Backup database is missing from the manifest");
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes !== value.totalBytes) {
    fail("INVALID_BACKUP", "Backup manifest size does not match its files");
  }
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    createdAt: value.createdAt,
    reason: value.reason as BackupReason,
    schemaVersion: Number(value.schemaVersion),
    totalBytes,
    files,
  };
}

function verifyLayout(root: string, manifest: BackupManifest) {
  const expectedRoot = new Set([DATABASE_FILE, MANIFEST_FILE, "snapshots"]);
  const expectedSnapshots = new Set(
    manifest.files.filter(({ path }) => path !== DATABASE_FILE).map(({ path }) => basename(path)),
  );
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!expectedRoot.has(entry.name)) fail("INVALID_BACKUP", `Unexpected backup entry: ${entry.name}`);
    if (entry.name === "snapshots" ? !entry.isDirectory() : !entry.isFile()) {
      fail("INVALID_BACKUP", `Backup entry has the wrong type: ${entry.name}`);
    }
  }
  const snapshots = join(root, "snapshots");
  ensureDirectory(snapshots, "INVALID_BACKUP");
  for (const entry of readdirSync(snapshots, { withFileTypes: true })) {
    if (!entry.isFile() || !expectedSnapshots.delete(entry.name)) {
      fail("INVALID_BACKUP", `Unexpected snapshot entry: ${entry.name}`);
    }
  }
  if (expectedSnapshots.size) fail("INVALID_BACKUP", "Backup snapshots are missing");
}

export async function verifyBackup(path: string): Promise<VerifiedBackup> {
  let root = resolve(path);
  ensureDirectory(root, "INVALID_BACKUP");
  root = realpathSync(root);
  const manifest = parseManifest(join(root, MANIFEST_FILE));
  verifyLayout(root, manifest);
  for (const file of manifest.files) {
    const filePath = backupFilePath(root, file.path);
    const stat = ensureRegularFile(filePath);
    if (stat.size !== file.bytes) fail("CHECKSUM_MISMATCH", `Backup file size changed: ${file.path}`);
    if ((await sha256File(filePath)) !== file.sha256) {
      fail("CHECKSUM_MISMATCH", `Backup file checksum changed: ${file.path}`);
    }
  }
  const contents = inspectDatabase(join(root, DATABASE_FILE));
  if (contents.schemaVersion !== manifest.schemaVersion) {
    fail("INVALID_BACKUP", "Backup schema version does not match its manifest");
  }
  const expected = new Set([DATABASE_FILE, ...contents.snapshots]);
  for (const file of manifest.files) expected.delete(file.path);
  if (expected.size) fail("INVALID_BACKUP", "Backup is missing snapshots referenced by the database");
  return { path: root, manifest };
}

/** The caller must pause capture and application writes for the duration of this operation. */
export async function createBackup(options: CreateBackupOptions): Promise<VerifiedBackup> {
  let dataDir = resolve(options.dataDir);
  ensureDirectory(dataDir);
  ensureSupportedDataLayout(dataDir);
  dataDir = realpathSync(dataDir);
  const backupRoot = prepareBackupRoot(options.backupRoot, dataDir);
  ensureSpace(backupRoot, sourceSize(options.database, dataDir));

  const createdAt = new Date().toISOString();
  const id = randomUUID();
  const finalPath = join(backupRoot, `backup-${createdAt.replaceAll(/[-:.]/gu, "")}-${id}`);
  const temporaryPath = mkdtempSync(join(backupRoot, ".zhiye-backup-"));
  chmodSync(temporaryPath, 0o700);
  try {
    const databasePath = join(temporaryPath, DATABASE_FILE);
    await backup(options.database, databasePath);
    normalizeDatabaseCopy(databasePath);
    chmodSync(databasePath, 0o600);
    syncPath(databasePath);
    const contents = inspectDatabase(databasePath);

    const snapshotsDir = join(temporaryPath, "snapshots");
    mkdirSync(snapshotsDir, { mode: 0o700 });
    const files: BackupFile[] = [];
    const databaseStat = ensureRegularFile(databasePath);
    files.push({ path: DATABASE_FILE, bytes: databaseStat.size, sha256: await sha256File(databasePath) });
    for (const path of sourceSnapshots(dataDir, contents.snapshots)) {
      const source = sourceSnapshotPath(dataDir, path);
      const destination = backupFilePath(temporaryPath, path);
      ensureRegularFile(source, "MISSING_SNAPSHOT");
      copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
      chmodSync(destination, 0o600);
      syncPath(destination);
      const stat = ensureRegularFile(destination);
      files.push({ path, bytes: stat.size, sha256: await sha256File(destination) });
    }
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    if (!Number.isSafeInteger(totalBytes)) fail("BACKUP_TOO_LARGE", "Backup is too large to describe safely");
    const manifest: BackupManifest = {
      format: FORMAT,
      version: FORMAT_VERSION,
      createdAt,
      reason: options.reason ?? "manual",
      schemaVersion: contents.schemaVersion,
      totalBytes,
      files,
    };
    const manifestPath = join(temporaryPath, MANIFEST_FILE);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    syncPath(manifestPath);
    syncPath(snapshotsDir);
    syncPath(temporaryPath);
    const verified = await verifyBackup(temporaryPath);
    renameSync(temporaryPath, finalPath);
    syncPath(backupRoot);
    return { ...verified, path: finalPath };
  } catch (error) {
    rmSync(temporaryPath, { recursive: true, force: true });
    if (error instanceof BackupError) throw error;
    fail("BACKUP_FAILED", "Backup could not be created", error);
  }
}

function restoreStatePath(dataDir: string) {
  const target = dataTarget(dataDir);
  return join(dirname(target), `.${basename(target)}.restore.json`);
}

function readRestoreState(dataDir: string): RestoreState | null {
  const path = restoreStatePath(dataDir);
  if (!existsSync(path)) return null;
  const stat = ensureRegularFile(path, "RESTORE_STATE_INVALID");
  if (stat.size > 64 * 1024) fail("RESTORE_STATE_INVALID", "Restore state is too large");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("RESTORE_STATE_INVALID", "Restore state is not valid JSON", error);
  }
  const target = basename(dataTarget(dataDir));
  const operation = record(value) && typeof value.operation === "string" ? value.operation : "";
  const preservePrevious = record(value) && value.preservePrevious === true;
  const decimal = (field: unknown) => typeof field === "string" && /^[0-9]+$/u.test(field);
  if (
    !record(value) ||
    value.format !== "zhiye-restore-state" ||
    value.version !== 1 ||
    value.target !== target ||
    !UUID.test(operation) ||
    value.staging !== `.${target}.restore-${operation}` ||
    value.previous !== `.${target}.${preservePrevious ? "quarantine" : "previous"}-${operation}` ||
    typeof value.preservePrevious !== "boolean" ||
    !decimal(value.stagingDevice) ||
    !decimal(value.stagingInode) ||
    !decimal(value.previousDevice) ||
    !decimal(value.previousInode)
  ) {
    fail("RESTORE_STATE_INVALID", "Restore state contains unsafe paths");
  }
  return value as unknown as RestoreState;
}

function writeRestoreState(dataDir: string, state: RestoreState) {
  const path = restoreStatePath(dataDir);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    syncPath(temporary);
    renameSync(temporary, path);
    syncPath(dirname(path));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function removeStateDirectory(path: string, expected: DirectoryIdentity) {
  if (!existsSync(path)) return;
  if (!sameDirectory(directoryIdentity(path), expected)) {
    fail("RESTORE_STATE_INVALID", `Restore directory identity changed: ${path}`);
  }
  rmSync(path, { recursive: true });
}

export function recoverInterruptedRestore(dataDir: string): "none" | "kept-current" | "rolled-back" {
  const target = dataTarget(dataDir);
  const state = readRestoreState(target);
  if (!state) return "none";
  const parent = dirname(target);
  const staging = join(parent, state.staging);
  const previous = join(parent, state.previous);
  const expectedStaging = { device: state.stagingDevice, inode: state.stagingInode };
  const expectedPrevious = { device: state.previousDevice, inode: state.previousInode };
  const targetIdentity = existsSync(target) ? directoryIdentity(target) : null;
  const stagingIdentity = existsSync(staging) ? directoryIdentity(staging) : null;
  const previousIdentity = existsSync(previous) ? directoryIdentity(previous) : null;

  if (stagingIdentity && !sameDirectory(stagingIdentity, expectedStaging)) {
    fail("RESTORE_STATE_INVALID", "Restore staging directory identity changed");
  }
  if (previousIdentity && !sameDirectory(previousIdentity, expectedPrevious)) {
    fail("RESTORE_STATE_INVALID", "Previous data directory identity changed");
  }
  if (targetIdentity && sameDirectory(targetIdentity, expectedStaging)) {
    if (stagingIdentity) fail("RESTORE_STATE_INVALID", "Restored data exists at two paths");
    try {
      validateDataDirectory(target);
    } catch (error) {
      fail("RESTORE_RECOVERY_CONFLICT", "Activated restore data could not be validated", error);
    }
    if (previousIdentity && !state.preservePrevious) removeStateDirectory(previous, expectedPrevious);
    syncPath(parent);
    unlinkSync(restoreStatePath(target));
    syncPath(parent);
    return "kept-current";
  }
  if (targetIdentity) {
    if (!sameDirectory(targetIdentity, expectedPrevious) || previousIdentity) {
      fail("RESTORE_RECOVERY_CONFLICT", "An unexpected data directory appeared during restore recovery");
    }
    if (stagingIdentity) removeStateDirectory(staging, expectedStaging);
    syncPath(parent);
    unlinkSync(restoreStatePath(target));
    syncPath(parent);
    return "kept-current";
  }
  if (!previousIdentity) {
    fail("RESTORE_RECOVERY_FAILED", "Original data is missing; staged data was left untouched");
  }
  renameSync(previous, target);
  syncPath(parent);
  if (stagingIdentity) removeStateDirectory(staging, expectedStaging);
  unlinkSync(restoreStatePath(target));
  syncPath(parent);
  return "rolled-back";
}

async function copyBackupToStaging(backupValue: VerifiedBackup, staging: string) {
  const snapshots = join(staging, "snapshots");
  mkdirSync(snapshots, { mode: 0o700 });
  for (const file of backupValue.manifest.files) {
    const source = backupFilePath(backupValue.path, file.path);
    const destination =
      file.path === DATABASE_FILE ? join(staging, LIVE_DATABASE_FILE) : join(snapshots, basename(file.path));
    copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
    chmodSync(destination, 0o600);
    syncPath(destination);
    const stat = ensureRegularFile(destination);
    if (stat.size !== file.bytes || (await sha256File(destination)) !== file.sha256) {
      fail("CHECKSUM_MISMATCH", `Restored staging file failed verification: ${file.path}`);
    }
  }
  const contents = inspectDatabase(join(staging, LIVE_DATABASE_FILE));
  if (contents.schemaVersion !== backupValue.manifest.schemaVersion) {
    fail("INVALID_DATABASE", "Restored staging database has the wrong schema version");
  }
  syncPath(snapshots);
  syncPath(staging);
}

function validatePreparedStaging(staging: string, supportedSchemaVersion: number) {
  ensureSupportedDataLayout(staging);
  normalizeDatabaseCopy(join(staging, LIVE_DATABASE_FILE));
  ensureSupportedDataLayout(staging);
  const contents = inspectDatabase(join(staging, LIVE_DATABASE_FILE));
  if (contents.schemaVersion !== supportedSchemaVersion) {
    fail("STAGING_SCHEMA_MISMATCH", "Staging preparation did not produce the supported schema version");
  }
  chmodSync(staging, 0o700);
  chmodSync(join(staging, "snapshots"), 0o700);
  chmodSync(join(staging, LIVE_DATABASE_FILE), 0o600);
  syncPath(join(staging, LIVE_DATABASE_FILE));
  for (const path of sourceSnapshots(staging, contents.snapshots)) {
    const snapshot = sourceSnapshotPath(staging, path);
    chmodSync(snapshot, 0o600);
    syncPath(snapshot);
  }
  syncPath(join(staging, "snapshots"));
  syncPath(staging);
}

/** The caller must hold exclusive maintenance access and close the application's database connection first. */
export async function restoreBackup(options: RestoreBackupOptions): Promise<RestoreResult> {
  if (!Number.isSafeInteger(options.supportedSchemaVersion) || options.supportedSchemaVersion < 1) {
    fail("INVALID_SUPPORTED_SCHEMA", "supportedSchemaVersion must be a positive safe integer");
  }
  if (options.allowQuarantine !== undefined && typeof options.allowQuarantine !== "boolean") {
    fail("INVALID_QUARANTINE_OPTION", "allowQuarantine must be a boolean");
  }
  if (typeof options.prepareStaging !== "function") {
    fail("INVALID_STAGING_PREPARER", "prepareStaging must migrate and validate restored data");
  }
  let dataDir = dataTarget(options.dataDir);
  recoverInterruptedRestore(dataDir);
  dataDir = dataTarget(dataDir);
  ensureDirectory(dataDir);
  dataDir = realpathSync(dataDir);
  const backupRoot = prepareBackupRoot(options.backupRoot, dataDir);
  const backupName = typeof options.backupPath === "string" ? basename(options.backupPath) : "";
  if (!BACKUP_DIRECTORY.test(backupName) || options.backupPath !== join(backupRoot, backupName)) {
    fail("UNSAFE_PATH", "Restore requires a canonical backup directory directly inside the backup root");
  }
  const backupValue = await verifyBackup(options.backupPath);
  if (backupValue.path !== options.backupPath) {
    fail("UNSAFE_PATH", "Restore backup must be a real directory directly inside the backup root");
  }
  if (backupValue.manifest.schemaVersion > options.supportedSchemaVersion) {
    fail("UNSUPPORTED_SCHEMA", "Backup was created by a newer version of Zhiye");
  }
  const parent = dirname(dataDir);
  ensureDirectory(parent);
  ensureSpace(parent, BigInt(backupValue.manifest.totalBytes));

  let preRestoreBackup: VerifiedBackup | null = null;
  let current: DatabaseSync | undefined;
  try {
    ensureSupportedDataLayout(dataDir);
    current = new DatabaseSync(join(dataDir, LIVE_DATABASE_FILE), { readOnly: true });
    current.exec("PRAGMA query_only = ON");
    const currentContents = databaseContents(current);
    if (currentContents.schemaVersion > options.supportedSchemaVersion) {
      fail("UNSUPPORTED_CURRENT_SCHEMA", "Current data was created by a newer version of Zhiye");
    }
    preRestoreBackup = await createBackup({
      dataDir,
      backupRoot,
      database: current,
      reason: "pre-restore",
    });
  } catch (error) {
    if (options.allowQuarantine !== true) {
      fail(
        "QUARANTINE_REQUIRED",
        "Current data could not be validated and fully backed up; confirm quarantine before restoring",
        error,
      );
    }
    preRestoreBackup = null;
  } finally {
    current?.close();
  }

  ensureSpace(parent, BigInt(backupValue.manifest.totalBytes));
  const operation = randomUUID();
  const targetName = basename(dataDir);
  const staging = join(parent, `.${targetName}.restore-${operation}`);
  mkdirSync(staging, { mode: 0o700 });
  chmodSync(staging, 0o700);
  const preservePrevious = preRestoreBackup === null;
  const previous = join(parent, `.${targetName}.${preservePrevious ? "quarantine" : "previous"}-${operation}`);
  const createdStaging = directoryIdentity(staging);
  let state: RestoreState | undefined;
  let switched = false;
  try {
    await copyBackupToStaging(backupValue, staging);
    await options.prepareStaging(staging);
    if (!sameDirectory(directoryIdentity(staging), createdStaging)) {
      fail("RESTORE_STATE_INVALID", "Staging preparation replaced the restore directory");
    }
    validatePreparedStaging(staging, options.supportedSchemaVersion);
    const previousIdentity = directoryIdentity(dataDir);
    state = {
      format: "zhiye-restore-state",
      version: 1,
      target: targetName,
      operation,
      staging: basename(staging),
      previous: basename(previous),
      preservePrevious,
      stagingDevice: createdStaging.device,
      stagingInode: createdStaging.inode,
      previousDevice: previousIdentity.device,
      previousInode: previousIdentity.inode,
    };
    writeRestoreState(dataDir, state);
    renameSync(dataDir, previous);
    syncPath(parent);
    renameSync(staging, dataDir);
    switched = true;
    syncPath(parent);
    if (!preservePrevious) removeStateDirectory(previous, previousIdentity);
    syncPath(parent);
    unlinkSync(restoreStatePath(dataDir));
    syncPath(parent);
    return {
      backup: backupValue,
      preRestoreBackup,
      quarantinedDataPath: preservePrevious ? previous : null,
      cleanupPending: false,
    };
  } catch (error) {
    if (switched) {
      try {
        if (!sameDirectory(directoryIdentity(dataDir), createdStaging)) {
          fail("RESTORE_ACTIVE_UNCONFIRMED", "Restored data directory identity changed after activation");
        }
        validateDataDirectory(dataDir);
      } catch (confirmationError) {
        if (confirmationError instanceof BackupError && confirmationError.code === "RESTORE_ACTIVE_UNCONFIRMED") {
          throw confirmationError;
        }
        fail("RESTORE_ACTIVE_UNCONFIRMED", "Restore switched but the active data could not be confirmed", confirmationError);
      }
      return {
        backup: backupValue,
        preRestoreBackup,
        quarantinedDataPath: preservePrevious ? previous : null,
        cleanupPending: true,
      };
    }
    if (state && existsSync(previous) && existsSync(dataDir)) {
      fail(
        "RESTORE_CLEANUP_FAILED",
        "Restore failed and an unexpected data directory blocks rollback; startup recovery is required",
        error,
      );
    }
    if (state && !existsSync(dataDir) && !existsSync(previous)) {
      fail(
        "RESTORE_CLEANUP_FAILED",
        "Restore failed after original data disappeared; restore state was preserved for recovery",
        error,
      );
    }
    try {
      if (!existsSync(dataDir) && existsSync(previous) && state) {
        if (
          !sameDirectory(directoryIdentity(previous), {
            device: state.previousDevice,
            inode: state.previousInode,
          })
        ) {
          fail("RESTORE_STATE_INVALID", "Previous data directory identity changed during rollback");
        }
        renameSync(previous, dataDir);
        syncPath(parent);
      }
      removeStateDirectory(staging, createdStaging);
      if (existsSync(restoreStatePath(dataDir))) unlinkSync(restoreStatePath(dataDir));
      syncPath(parent);
    } catch (cleanupError) {
      fail("RESTORE_CLEANUP_FAILED", "Restore failed and rollback cleanup needs startup recovery", cleanupError);
    }
    if (error instanceof BackupError) throw error;
    fail("RESTORE_FAILED", "Restore failed; original data was kept", error);
  }
}
