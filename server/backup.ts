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
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { crc32 } from "node:zlib";

import { Zip, ZipPassThrough } from "fflate";

const FORMAT = "zhiye-backup";
const FORMAT_VERSION = 2;
const DATABASE_FILE = "database.sqlite3";
const LIVE_DATABASE_FILE = "zhiye.sqlite3";
const MANIFEST_FILE = "manifest.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FILES = 200_001;
export const BACKUP_ARCHIVE_MIME = "application/vnd.zhiye.backup+zip";
export const MAX_BACKUP_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_BACKUP_ARCHIVE_FILES = 50_000;
const BACKUP_ARCHIVE_TEMP = /^\.zhiye-backup-(?:export|import)-[a-f0-9-]{36}\.tmp$/u;
const SNAPSHOT_PATH = /^snapshots\/[a-zA-Z0-9-]+\.html\.gz$/u;
const ASSET_PATH = /^assets\/[a-f0-9]{64}$/u;
const ASSET_TEMPORARY = /^\.asset-[a-f0-9-]{36}\.tmp$/u;
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
  version: 1 | typeof FORMAT_VERSION;
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

export interface BackupArchive {
  path: string;
  filename: string;
  bytes: number;
}

export interface ExportBackupArchiveOptions {
  dataDir: string;
  backupRoot: string;
  backupPath: string;
  signal?: AbortSignal;
}

export interface ImportBackupArchiveOptions {
  dataDir: string;
  backupRoot: string;
  source: AsyncIterable<string | Uint8Array>;
  declaredBytes?: number | null;
  supportedSchemaVersion: number;
  signal?: AbortSignal;
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

function existingBackupRoot(input: string, dataDir: string) {
  const target = dataTarget(dataDir);
  if (!existsSync(input)) return prepareBackupRoot(input, target);
  const requested = resolve(input);
  ensureDirectory(requested);
  const root = realpathSync(requested);
  if (isInside(root, target) || isInside(target, root)) fail("UNSAFE_PATH", "Backup directory overlaps protected data");
  chmodSync(root, 0o700);
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
    if (/^\.zhiye-backup-[a-zA-Z0-9]{6}$/u.test(entry.name)) {
      if (!entry.isDirectory()) fail("UNSAFE_PATH", `Incomplete backup entry is not a directory: ${entry.name}`);
      rmSync(join(root, entry.name), { recursive: true });
    } else if (BACKUP_ARCHIVE_TEMP.test(entry.name)) {
      if (!entry.isFile()) fail("UNSAFE_PATH", `Incomplete backup archive is not a file: ${entry.name}`);
      unlinkSync(join(root, entry.name));
    } else {
      continue;
    }
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
  if (path !== DATABASE_FILE && !SNAPSHOT_PATH.test(path) && !ASSET_PATH.test(path)) {
    fail("UNSAFE_PATH", `Backup contains an unsafe path: ${path}`);
  }
  return join(root, ...path.split("/"));
}

function sourceAssetPath(dataDir: string, path: string) {
  if (!ASSET_PATH.test(path)) fail("UNSAFE_PATH", `Database contains an unsafe asset path: ${path}`);
  const root = join(resolve(dataDir), "assets");
  ensureDirectory(root);
  return join(root, basename(path));
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

function sourceAssets(dataDir: string, required: string[]) {
  const root = join(resolve(dataDir), "assets");
  ensureDirectory(root);
  const paths = readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isFile() && ASSET_TEMPORARY.test(entry.name)) return [];
    const path = `assets/${entry.name}`;
    if (!entry.isFile() || !ASSET_PATH.test(path)) {
      fail("UNSAFE_PATH", `Asset directory contains an unsupported entry: ${entry.name}`);
    }
    return [path];
  });
  const present = new Set(paths);
  if (required.some((path) => !present.has(path))) fail("MISSING_ASSET", "A database asset is missing");
  return [...new Set(required)].sort();
}

function ensureSupportedDataLayout(dataDir: string) {
  const allowed = new Set([
    ".zhiye.lock",
    "snapshots",
    "assets",
    "import-staging",
    LIVE_DATABASE_FILE,
    `${LIVE_DATABASE_FILE}-shm`,
    `${LIVE_DATABASE_FILE}-wal`,
  ]);
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (!allowed.has(entry.name)) {
      fail("UNSUPPORTED_DATA", `Data directory contains an unsupported entry: ${entry.name}`);
    }
    if (["snapshots", "assets", "import-staging"].includes(entry.name) ? !entry.isDirectory() : !entry.isFile()) {
      fail("UNSAFE_PATH", `Data directory entry has the wrong type: ${entry.name}`);
    }
  }
}

async function sha256File(path: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) {
    checkArchiveAbort(signal);
    hash.update(chunk as Buffer);
  }
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
    const hasAssets = Boolean(
      database
        .prepare("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'assets'")
        .get(),
    );
    const assets = hasAssets
      ? (
          database.prepare(
            `SELECT DISTINCT 'assets/' || a.hash AS path
             FROM assets a JOIN document_assets da ON da.asset_hash = a.hash
             WHERE da.status = 'ready' ORDER BY path`,
          ).all() as Array<{
            path: string;
          }>
        ).map(({ path }) => {
          if (!ASSET_PATH.test(path)) fail("UNSAFE_PATH", `Database contains an unsafe asset path: ${path}`);
          return path;
        })
      : [];
    return { schemaVersion: migrations.length, snapshots, assets };
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
    database.exec("PRAGMA secure_delete = ON");
    const hasImports = database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'import_batches'")
      .get();
    if (hasImports) {
      database.exec("BEGIN; DELETE FROM import_items; DELETE FROM import_batches; COMMIT");
      database.exec("VACUUM");
    }
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
  const contents = databaseContents(database);
  for (const path of sourceSnapshots(dataDir, contents.snapshots)) {
    bytes += BigInt(ensureRegularFile(sourceSnapshotPath(dataDir, path), "MISSING_SNAPSHOT").size);
  }
  if (contents.assets.length) {
    for (const path of sourceAssets(dataDir, contents.assets)) {
      bytes += BigInt(ensureRegularFile(sourceAssetPath(dataDir, path), "MISSING_ASSET").size);
    }
  }
  return bytes;
}

function validateDataDirectory(dataDir: string) {
  ensureSupportedDataLayout(dataDir);
  const contents = inspectDatabase(join(dataDir, LIVE_DATABASE_FILE));
  sourceSnapshots(dataDir, contents.snapshots);
  if (contents.assets.length) sourceAssets(dataDir, contents.assets);
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
  if (value.version !== 1 && value.version !== FORMAT_VERSION) {
    fail("UNSUPPORTED_FORMAT", "Unsupported backup format version");
  }
  const version = value.version as 1 | typeof FORMAT_VERSION;
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
      (item.path !== DATABASE_FILE &&
        !SNAPSHOT_PATH.test(item.path) &&
        (version === 1 || !ASSET_PATH.test(item.path))) ||
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
    version,
    createdAt: value.createdAt,
    reason: value.reason as BackupReason,
    schemaVersion: Number(value.schemaVersion),
    totalBytes,
    files,
  };
}

function verifyLayout(root: string, manifest: BackupManifest) {
  const expectedRoot = new Set([DATABASE_FILE, MANIFEST_FILE, "snapshots"]);
  if (manifest.version >= 2) expectedRoot.add("assets");
  const expectedSnapshots = new Set(
    manifest.files.filter(({ path }) => SNAPSHOT_PATH.test(path)).map(({ path }) => basename(path)),
  );
  const expectedAssets = new Set(
    manifest.files.filter(({ path }) => ASSET_PATH.test(path)).map(({ path }) => basename(path)),
  );
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!expectedRoot.has(entry.name)) fail("INVALID_BACKUP", `Unexpected backup entry: ${entry.name}`);
    if ((entry.name === "snapshots" || entry.name === "assets") ? !entry.isDirectory() : !entry.isFile()) {
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
  if (manifest.version >= 2) {
    const assets = join(root, "assets");
    ensureDirectory(assets, "INVALID_BACKUP");
    for (const entry of readdirSync(assets, { withFileTypes: true })) {
      if (!entry.isFile() || !expectedAssets.delete(entry.name)) {
        fail("INVALID_BACKUP", `Unexpected asset entry: ${entry.name}`);
      }
    }
    if (expectedAssets.size) fail("INVALID_BACKUP", "Backup assets are missing");
  }
}

export async function verifyBackup(path: string, signal?: AbortSignal): Promise<VerifiedBackup> {
  checkArchiveAbort(signal);
  let root = resolve(path);
  ensureDirectory(root, "INVALID_BACKUP");
  root = realpathSync(root);
  const manifest = parseManifest(join(root, MANIFEST_FILE));
  verifyLayout(root, manifest);
  for (const file of manifest.files) {
    checkArchiveAbort(signal);
    const filePath = backupFilePath(root, file.path);
    const stat = ensureRegularFile(filePath);
    if (stat.size !== file.bytes) fail("CHECKSUM_MISMATCH", `Backup file size changed: ${file.path}`);
    const actualHash = await sha256File(filePath, signal);
    if (actualHash !== file.sha256) {
      fail("CHECKSUM_MISMATCH", `Backup file checksum changed: ${file.path}`);
    }
    if (ASSET_PATH.test(file.path) && actualHash !== basename(file.path)) {
      fail("CHECKSUM_MISMATCH", `Backup asset hash does not match its path: ${file.path}`);
    }
  }
  checkArchiveAbort(signal);
  const contents = inspectDatabase(join(root, DATABASE_FILE));
  if (contents.schemaVersion !== manifest.schemaVersion) {
    fail("INVALID_BACKUP", "Backup schema version does not match its manifest");
  }
  const expected = new Set([DATABASE_FILE, ...contents.snapshots, ...contents.assets]);
  for (const file of manifest.files) expected.delete(file.path);
  if (expected.size) fail("INVALID_BACKUP", "Backup is missing files referenced by the database");
  return { path: root, manifest };
}

interface StoredArchiveEntry {
  path: string;
  crc: number;
  bytes: number;
  dataOffset: number;
  intervalStart: number;
  intervalEnd: number;
}

function checkArchiveAbort(signal?: AbortSignal) {
  if (signal?.aborted) fail("REQUEST_ABORTED", "Backup archive operation was aborted");
}

function writeAll(descriptor: number, value: Uint8Array) {
  let offset = 0;
  while (offset < value.length) offset += writeSync(descriptor, value, offset, value.length - offset);
}

function readExactly(descriptor: number, bytes: number, position: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(position) || position < 0) {
    fail("INVALID_BACKUP_ARCHIVE", "Backup archive contains unsafe offsets");
  }
  const value = Buffer.allocUnsafe(bytes);
  let offset = 0;
  while (offset < bytes) {
    const count = readSync(descriptor, value, offset, bytes - offset, position + offset);
    if (!count) fail("INVALID_BACKUP_ARCHIVE", "Backup archive ended unexpectedly");
    offset += count;
  }
  return value;
}

function archiveEntryPath(path: string) {
  return path === MANIFEST_FILE || path === DATABASE_FILE || SNAPSHOT_PATH.test(path) || ASSET_PATH.test(path);
}

function temporaryArchivePath(root: string, kind: "export" | "import") {
  return join(root, `.zhiye-backup-${kind}-${randomUUID()}.tmp`);
}

function zipEntrySize(path: string, bytes: number) {
  return bytes + 92 + Buffer.byteLength(path) * 2;
}

export async function createBackupArchive(options: ExportBackupArchiveOptions): Promise<BackupArchive> {
  checkArchiveAbort(options.signal);
  const root = existingBackupRoot(options.backupRoot, options.dataDir);
  const backupName = typeof options.backupPath === "string" ? basename(options.backupPath) : "";
  if (!BACKUP_DIRECTORY.test(backupName) || options.backupPath !== join(root, backupName)) {
    fail("UNSAFE_PATH", "Backup export requires a canonical backup directory inside the backup root");
  }
  const verified = await verifyBackup(options.backupPath, options.signal);
  if (verified.path !== options.backupPath) fail("UNSAFE_PATH", "Backup export path changed during verification");
  if (verified.manifest.files.length + 1 > MAX_BACKUP_ARCHIVE_FILES) {
    fail("BACKUP_ARCHIVE_TOO_LARGE", "Backup archive contains too many files");
  }

  const manifest = Buffer.from(`${JSON.stringify(verified.manifest, null, 2)}\n`);
  let expectedBytes = 22 + zipEntrySize(MANIFEST_FILE, manifest.length);
  for (const file of verified.manifest.files) expectedBytes += zipEntrySize(file.path, file.bytes);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_BACKUP_ARCHIVE_BYTES) {
    fail("BACKUP_ARCHIVE_TOO_LARGE", "Backup archive exceeds 2 GiB");
  }
  ensureSpace(root, BigInt(expectedBytes));

  const temporary = temporaryArchivePath(root, "export");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    chmodSync(temporary, 0o600);
    let written = 0;
    let failed: unknown;
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;
    const done = new Promise<void>((resolveDoneValue, rejectDoneValue) => {
      resolveDone = resolveDoneValue;
      rejectDone = rejectDoneValue;
    });
    void done.catch(() => undefined);
    const archive = new Zip((error, chunk, final) => {
      if (failed) return;
      if (error) {
        failed = error;
        rejectDone(error);
        return;
      }
      try {
        if (written + chunk.length > MAX_BACKUP_ARCHIVE_BYTES) {
          fail("BACKUP_ARCHIVE_TOO_LARGE", "Backup archive exceeds 2 GiB");
        }
        writeAll(descriptor!, chunk);
        written += chunk.length;
        if (final) resolveDone();
      } catch (writeError) {
        failed = writeError;
        rejectDone(writeError);
      }
    });
    const add = async (path: string, body: Uint8Array | BackupFile) => {
      checkArchiveAbort(options.signal);
      const stream = new ZipPassThrough(path);
      stream.os = 3;
      stream.attrs = 0o100600 * 0x1_0000;
      stream.mtime = new Date("1980-01-01T00:00:00.000Z");
      archive.add(stream);
      if (body instanceof Uint8Array) {
        stream.push(body, true);
        if (failed) throw failed;
        return;
      }
      const hash = createHash("sha256");
      let size = 0;
      const sourcePath = backupFilePath(verified.path, body.path);
      const sourceDescriptor = openSync(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      for await (const chunk of createReadStream(sourcePath, {
        fd: sourceDescriptor,
        autoClose: true,
        signal: options.signal,
      })) {
        checkArchiveAbort(options.signal);
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += value.length;
        if (size > body.bytes) fail("CHECKSUM_MISMATCH", `Backup file size changed: ${body.path}`);
        hash.update(value);
        stream.push(value);
        if (failed) throw failed;
      }
      if (size !== body.bytes || hash.digest("hex") !== body.sha256) {
        fail("CHECKSUM_MISMATCH", `Backup file changed during export: ${body.path}`);
      }
      stream.push(new Uint8Array(), true);
      if (failed) throw failed;
    };
    try {
      await add(MANIFEST_FILE, manifest);
      for (const file of verified.manifest.files) await add(file.path, file);
      checkArchiveAbort(options.signal);
      archive.end();
      await done;
    } catch (error) {
      archive.terminate();
      throw failed ?? error;
    }
    if (written !== expectedBytes) fail("BACKUP_EXPORT_FAILED", "Backup archive size was not deterministic");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    syncPath(root);
    return { path: temporary, filename: `${backupName}.zhiye-backup`, bytes: written };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    if (options.signal?.aborted) fail("REQUEST_ABORTED", "Backup archive export was aborted", error);
    if (error instanceof BackupError) throw error;
    fail("BACKUP_EXPORT_FAILED", "Backup archive could not be created", error);
  }
}

function inspectBackupArchive(path: string) {
  const stat = ensureRegularFile(path, "INVALID_BACKUP_ARCHIVE");
  if (stat.size < 22) fail("INVALID_BACKUP_ARCHIVE", "Backup archive is incomplete");
  if (stat.size > MAX_BACKUP_ARCHIVE_BYTES) fail("BACKUP_ARCHIVE_TOO_LARGE", "Backup archive exceeds 2 GiB");
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const eocdOffset = stat.size - 22;
    const eocd = readExactly(descriptor, 22, eocdOffset);
    const entryCount = eocd.readUInt16LE(10);
    const centralBytes = eocd.readUInt32LE(12);
    const centralOffset = eocd.readUInt32LE(16);
    if (
      eocd.readUInt32LE(0) !== 0x06054b50 || eocd.readUInt16LE(4) !== 0 || eocd.readUInt16LE(6) !== 0 ||
      entryCount !== eocd.readUInt16LE(8) || entryCount < 1 || entryCount > MAX_BACKUP_ARCHIVE_FILES ||
      entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff ||
      eocd.readUInt16LE(20) !== 0 || centralOffset + centralBytes !== eocdOffset
    ) {
      fail("INVALID_BACKUP_ARCHIVE", "Backup archive uses an unsupported ZIP structure");
    }

    const entries: StoredArchiveEntry[] = [];
    const names = new Set<string>();
    let totalBytes = 0;
    let offset = centralOffset;
    for (let index = 0; index < entryCount; index += 1) {
      const central = readExactly(descriptor, 46, offset);
      if (central.readUInt32LE(0) !== 0x02014b50) {
        fail("INVALID_BACKUP_ARCHIVE", "Backup archive central directory is invalid");
      }
      const madeBy = central.readUInt16LE(4);
      const version = central.readUInt16LE(6);
      const flags = central.readUInt16LE(8);
      const method = central.readUInt16LE(10);
      const crc = central.readUInt32LE(16);
      const compressed = central.readUInt32LE(20);
      const bytes = central.readUInt32LE(24);
      const nameBytes = central.readUInt16LE(28);
      const extraBytes = central.readUInt16LE(30);
      const commentBytes = central.readUInt16LE(32);
      const disk = central.readUInt16LE(34);
      const external = central.readUInt32LE(38);
      const localOffset = central.readUInt32LE(42);
      if (
        version > 20 || (flags & ~0x0808) !== 0 || method !== 0 || compressed !== bytes ||
        [compressed, bytes, localOffset].includes(0xffffffff) || nameBytes < 1 || nameBytes > 1_024 ||
        extraBytes !== 0 || commentBytes !== 0 || disk !== 0
      ) {
        fail("INVALID_BACKUP_ARCHIVE", "Backup archive contains an unsupported ZIP entry");
      }
      const host = madeBy >>> 8;
      const fileType = (external >>> 16) & 0o170000;
      if ((external & 0x10) !== 0 || ([3, 19].includes(host) && fileType !== 0 && fileType !== 0o100000)) {
        fail("ZIP_SYMLINK", "Backup archive links and non-regular entries are not allowed");
      }
      const nameBuffer = readExactly(descriptor, nameBytes, offset + 46);
      let name: string;
      try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(nameBuffer);
      } catch {
        fail("INVALID_BACKUP_ARCHIVE", "Backup archive path is not valid UTF-8");
      }
      if (!archiveEntryPath(name!) || names.has(name!)) {
        fail(names.has(name!) ? "DUPLICATE_ZIP_PATH" : "UNEXPECTED_ZIP_ENTRY", "Backup archive contains an unexpected or duplicate path");
      }
      names.add(name!);
      if (name === MANIFEST_FILE && bytes > MAX_MANIFEST_BYTES) {
        fail("INVALID_BACKUP_ARCHIVE", "Backup archive manifest is too large");
      }
      totalBytes += bytes;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BACKUP_ARCHIVE_BYTES) {
        fail("BACKUP_ARCHIVE_TOO_LARGE", "Backup archive payload exceeds 2 GiB");
      }

      const local = readExactly(descriptor, 30, localOffset);
      if (
        local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(4) > 20 ||
        local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method ||
        local.readUInt16LE(26) !== nameBytes || local.readUInt16LE(28) !== 0 ||
        !readExactly(descriptor, nameBytes, localOffset + 30).equals(nameBuffer)
      ) {
        fail("INVALID_BACKUP_ARCHIVE", "Backup archive local and central entries disagree");
      }
      const descriptorUsed = (flags & 0x0008) !== 0;
      const localCrc = local.readUInt32LE(14);
      const localCompressed = local.readUInt32LE(18);
      const localBytes = local.readUInt32LE(22);
      if (
        descriptorUsed
          ? !(
            (localCrc === 0 && localCompressed === 0 && localBytes === 0) ||
            (localCrc === crc && localCompressed === compressed && localBytes === bytes)
          )
          : localCrc !== crc || localCompressed !== compressed || localBytes !== bytes
      ) {
        fail("INVALID_BACKUP_ARCHIVE", "Backup archive local entry metadata is invalid");
      }
      const dataOffset = localOffset + 30 + nameBytes;
      let intervalEnd = dataOffset + compressed;
      if (intervalEnd > centralOffset) fail("INVALID_BACKUP_ARCHIVE", "Backup archive entry exceeds its data area");
      if (descriptorUsed) {
        const possibleSignature = readExactly(descriptor, 4, intervalEnd).readUInt32LE(0);
        const descriptorOffset = possibleSignature === 0x08074b50 ? intervalEnd + 4 : intervalEnd;
        const dataDescriptor = readExactly(descriptor, 12, descriptorOffset);
        if (
          dataDescriptor.readUInt32LE(0) !== crc || dataDescriptor.readUInt32LE(4) !== compressed ||
          dataDescriptor.readUInt32LE(8) !== bytes
        ) {
          fail("INVALID_BACKUP_ARCHIVE", "Backup archive data descriptor is invalid");
        }
        intervalEnd = descriptorOffset + 12;
      }
      entries.push({ path: name!, crc, bytes, dataOffset, intervalStart: localOffset, intervalEnd });
      offset += 46 + nameBytes;
    }
    if (offset !== eocdOffset) fail("INVALID_BACKUP_ARCHIVE", "Backup archive central directory length is invalid");
    const intervals = [...entries].sort((left, right) => left.intervalStart - right.intervalStart);
    if (
      intervals[0]?.intervalStart !== 0 || intervals.at(-1)?.intervalEnd !== centralOffset ||
      intervals.some((entry, index) => index > 0 && entry.intervalStart !== intervals[index - 1]!.intervalEnd)
    ) {
      fail("INVALID_BACKUP_ARCHIVE", "Backup archive entries overlap or contain hidden data");
    }
    return { entries, totalBytes };
  } finally {
    closeSync(descriptor);
  }
}

async function extractBackupArchive(path: string, staging: string, entries: StoredArchiveEntry[], signal?: AbortSignal) {
  const snapshots = join(staging, "snapshots");
  const assets = join(staging, "assets");
  mkdirSync(snapshots, { mode: 0o700 });
  let assetsCreated = false;
  for (const entry of entries) {
    checkArchiveAbort(signal);
    if (ASSET_PATH.test(entry.path) && !assetsCreated) {
      mkdirSync(assets, { mode: 0o700 });
      assetsCreated = true;
    }
    const destination = entry.path === MANIFEST_FILE || entry.path === DATABASE_FILE
      ? join(staging, entry.path)
      : join(staging, ...entry.path.split("/"));
    const descriptor = openSync(
      destination,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    let checksum = 0;
    try {
      if (entry.bytes) {
        for await (const chunk of createReadStream(path, {
          start: entry.dataOffset,
          end: entry.dataOffset + entry.bytes - 1,
          signal,
        })) {
          checkArchiveAbort(signal);
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          checksum = crc32(value, checksum);
          writeAll(descriptor, value);
        }
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(destination, 0o600);
    if ((checksum >>> 0) !== entry.crc) fail("CHECKSUM_MISMATCH", `Backup archive CRC mismatch: ${entry.path}`);
  }
  const manifest = parseManifest(join(staging, MANIFEST_FILE));
  if (manifest.version >= 2 && !assetsCreated) {
    mkdirSync(assets, { mode: 0o700 });
    assetsCreated = true;
  }
  syncPath(snapshots);
  if (assetsCreated) syncPath(assets);
  syncPath(staging);
}

export async function importBackupArchive(options: ImportBackupArchiveOptions): Promise<VerifiedBackup> {
  if (!Number.isSafeInteger(options.supportedSchemaVersion) || options.supportedSchemaVersion < 1) {
    fail("INVALID_SUPPORTED_SCHEMA", "supportedSchemaVersion must be a positive safe integer");
  }
  if (
    options.declaredBytes !== undefined && options.declaredBytes !== null &&
    (!Number.isSafeInteger(options.declaredBytes) || options.declaredBytes < 1 || options.declaredBytes > MAX_BACKUP_ARCHIVE_BYTES)
  ) {
    fail("BACKUP_ARCHIVE_TOO_LARGE", "Backup archive Content-Length is invalid or exceeds 2 GiB");
  }
  checkArchiveAbort(options.signal);
  const root = prepareBackupRoot(options.backupRoot, dataTarget(options.dataDir));
  if (options.declaredBytes) ensureSpace(root, BigInt(options.declaredBytes));
  const temporary = temporaryArchivePath(root, "import");
  let staging: string | undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    chmodSync(temporary, 0o600);
    let archiveBytes = 0;
    for await (const chunk of options.source) {
      checkArchiveAbort(options.signal);
      const value = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      archiveBytes += value.length;
      if (archiveBytes > MAX_BACKUP_ARCHIVE_BYTES) fail("BACKUP_ARCHIVE_TOO_LARGE", "Backup archive exceeds 2 GiB");
      writeAll(descriptor, value);
    }
    if (!archiveBytes) fail("INVALID_BACKUP_ARCHIVE", "Backup archive is empty");
    if (options.declaredBytes && archiveBytes !== options.declaredBytes) {
      fail("INVALID_BACKUP_ARCHIVE", "Backup archive length does not match Content-Length");
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    syncPath(root);

    const inspected = inspectBackupArchive(temporary);
    ensureSpace(root, BigInt(inspected.totalBytes));
    staging = mkdtempSync(join(root, ".zhiye-backup-"));
    chmodSync(staging, 0o700);
    await extractBackupArchive(temporary, staging, inspected.entries, options.signal);
    const importedManifest = parseManifest(join(staging, MANIFEST_FILE));
    if (importedManifest.reason !== "manual") {
      writeFileSync(join(staging, MANIFEST_FILE), `${JSON.stringify({ ...importedManifest, reason: "manual" }, null, 2)}\n`, {
        mode: 0o600,
      });
      syncPath(join(staging, MANIFEST_FILE));
      syncPath(staging);
    }
    const verified = await verifyBackup(staging, options.signal);
    if (verified.manifest.schemaVersion > options.supportedSchemaVersion) {
      fail("UNSUPPORTED_SCHEMA", "Backup archive was created by a newer version of Zhiye");
    }
    const finalPath = join(
      root,
      `backup-${new Date().toISOString().replaceAll(/[-:.]/gu, "")}-${randomUUID()}`,
    );
    renameSync(staging, finalPath);
    staging = undefined;
    syncPath(root);
    return { ...verified, path: finalPath };
  } catch (error) {
    if (options.signal?.aborted && !(error instanceof BackupError)) {
      throw new BackupError("REQUEST_ABORTED", "Backup archive import was aborted", error);
    }
    if (error instanceof BackupError) throw error;
    throw new BackupError("BACKUP_IMPORT_FAILED", "Backup archive could not be imported", error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (staging) rmSync(staging, { recursive: true, force: true });
    rmSync(temporary, { force: true });
  }
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
    const assetsDir = join(temporaryPath, "assets");
    mkdirSync(snapshotsDir, { mode: 0o700 });
    mkdirSync(assetsDir, { mode: 0o700 });
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
    if (contents.assets.length) {
      for (const path of sourceAssets(dataDir, contents.assets)) {
        const source = sourceAssetPath(dataDir, path);
        const destination = backupFilePath(temporaryPath, path);
        ensureRegularFile(source, "MISSING_ASSET");
        copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
        chmodSync(destination, 0o600);
        syncPath(destination);
        const stat = ensureRegularFile(destination);
        files.push({ path, bytes: stat.size, sha256: await sha256File(destination) });
      }
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
    syncPath(assetsDir);
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
  const assets = join(staging, "assets");
  mkdirSync(snapshots, { mode: 0o700 });
  if (backupValue.manifest.version >= 2) mkdirSync(assets, { mode: 0o700 });
  for (const file of backupValue.manifest.files) {
    const source = backupFilePath(backupValue.path, file.path);
    const destination =
      file.path === DATABASE_FILE
        ? join(staging, LIVE_DATABASE_FILE)
        : ASSET_PATH.test(file.path)
          ? join(assets, basename(file.path))
          : join(snapshots, basename(file.path));
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
  if (backupValue.manifest.version >= 2) syncPath(assets);
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
  if (contents.schemaVersion >= 9) chmodSync(join(staging, "assets"), 0o700);
  chmodSync(join(staging, LIVE_DATABASE_FILE), 0o600);
  syncPath(join(staging, LIVE_DATABASE_FILE));
  for (const path of sourceSnapshots(staging, contents.snapshots)) {
    const snapshot = sourceSnapshotPath(staging, path);
    chmodSync(snapshot, 0o600);
    syncPath(snapshot);
  }
  if (contents.schemaVersion >= 9) {
    for (const path of sourceAssets(staging, contents.assets)) {
      const asset = sourceAssetPath(staging, path);
      chmodSync(asset, 0o600);
      syncPath(asset);
    }
  }
  syncPath(join(staging, "snapshots"));
  if (contents.schemaVersion >= 9) syncPath(join(staging, "assets"));
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
