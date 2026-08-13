import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { strToU8, zipSync } from "fflate";

import type {
  CaptureQueueStatus,
  DataSafetyHealth,
  DiagnosticLogEntry,
  DiagnosticLogEvent,
  DiagnosticLogLevel,
  DiagnosticReport,
} from "../shared/types.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 8;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_FILE = "diagnostics.jsonl";
const ROTATED_FILE = /^diagnostics-[0-9]{8}T[0-9]{9}Z-[a-f0-9-]{36}\.jsonl$/u;
const diagnosticCodes = new Set([
  "INTERNAL_ERROR",
  "UNKNOWN_ERROR",
  "INVALID_URL",
  "BLOCKED_ADDRESS",
  "FETCH_TIMEOUT",
  "RESPONSE_TOO_LARGE",
  "UNSUPPORTED_CONTENT_TYPE",
  "HTTP_ERROR",
  "EXTRACTION_EMPTY",
  "BROWSER_FAILED",
  "CAPTURE_CANCELLED",
  "ASSET_CACHE_FAILED",
  "ASSET_MAPPING_CHANGED",
  "ASSET_PATH_UNSAFE",
  "INTERRUPTED",
  "BACKUP_FAILED",
  "BACKUP_TOO_LARGE",
  "BACKUP_MISSING",
  "CHECKSUM_MISMATCH",
  "INSUFFICIENT_SPACE",
  "INVALID_BACKUP",
  "INVALID_DATABASE",
  "MISSING_ASSET",
  "MISSING_SNAPSHOT",
  "QUARANTINE_REQUIRED",
  "RESTORE_CLEANUP_FAILED",
  "RESTORE_FAILED",
  "RESTORE_RECOVERY_CONFLICT",
  "RESTORE_RECOVERY_FAILED",
  "RESTORE_STATE_INVALID",
  "SPACE_CHECK_FAILED",
  "STAGING_SCHEMA_MISMATCH",
  "UNSAFE_PATH",
  "UNSUPPORTED_CURRENT_SCHEMA",
  "UNSUPPORTED_DATA",
  "UNSUPPORTED_FORMAT",
  "UNSUPPORTED_SCHEMA",
  "FUTURE_SCHEMA",
  "NON_CONTIGUOUS_MIGRATIONS",
  "FILE_DELETE_FAILED",
]);
const levels = new Set<DiagnosticLogLevel>(["info", "warning", "error"]);
const events = new Set<DiagnosticLogEvent>([
  "service_starting",
  "service_ready",
  "service_stopping",
  "backup_cleanup_failed",
  "backup_reconciliation_failed",
  "automatic_backup_failed",
  "asset_cache_failed",
  "capture_failed",
  "restore_reconciliation_failed",
  "unexpected_api_error",
  "server_error",
]);
const modes = new Set<NonNullable<DiagnosticLogEntry["mode"]>>([
  "web",
  "desktop",
  "http",
  "browser",
  "recovery",
]);
const inputKeys = new Set(["level", "event", "code", "durationMs", "count", "mode"]);
const storedKeys = new Set(["timestamp", ...inputKeys]);

export type DiagnosticLogInput = Omit<DiagnosticLogEntry, "timestamp">;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000;
}

function validEntry(value: unknown, stored: boolean): value is DiagnosticLogEntry | DiagnosticLogInput {
  if (!record(value) || Object.keys(value).some((key) => !(stored ? storedKeys : inputKeys).has(key))) return false;
  if (!levels.has(value.level as DiagnosticLogLevel) || !events.has(value.event as DiagnosticLogEvent)) return false;
  if (stored && (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp)))) return false;
  if (value.code !== undefined && (typeof value.code !== "string" || !diagnosticCodes.has(value.code))) return false;
  if (value.durationMs !== undefined && !boundedInteger(value.durationMs)) return false;
  if (value.count !== undefined && !boundedInteger(value.count)) return false;
  return value.mode === undefined || modes.has(value.mode as NonNullable<DiagnosticLogEntry["mode"]>);
}

function rotatedName(date = new Date()) {
  return `diagnostics-${date.toISOString().replaceAll(/[-:.]/gu, "")}-${randomUUID()}.jsonl`;
}

function activeExpired(path: string, cutoff: number) {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return true;
  }
  try {
    const bytes = Buffer.alloc(1024);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    const firstLine = bytes.subarray(0, length).toString("utf8").split("\n", 1)[0];
    const value: unknown = JSON.parse(firstLine);
    return !validEntry(value, true) || Date.parse((value as DiagnosticLogEntry).timestamp) < cutoff;
  } catch {
    return true;
  } finally {
    closeSync(descriptor);
  }
}

export class DiagnosticsLogger {
  readonly directory: string;
  readonly activePath: string;
  #enabled = true;

  constructor(dataDir: string) {
    const target = resolve(dataDir);
    this.directory = join(dirname(target), `${basename(target)}-diagnostics`);
    this.activePath = join(this.directory, ACTIVE_FILE);
    try {
      if (!existsSync(this.directory)) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(this.directory).isDirectory()) throw new Error("Diagnostics log path is unsafe");
      chmodSync(this.directory, 0o700);
      this.#prune();
    } catch {
      this.#enabled = false;
    }
  }

  log(input: DiagnosticLogInput) {
    if (!this.#enabled || !validEntry(input, false)) return false;
    try {
      const entry: DiagnosticLogEntry = { timestamp: new Date().toISOString(), ...input };
      const line = `${JSON.stringify(entry)}\n`;
      if (existsSync(this.activePath)) {
        if (!lstatSync(this.activePath).isFile()) return false;
        if (activeExpired(this.activePath, Date.now() - RETENTION_MS)) {
          rmSync(this.activePath, { force: true });
        }
      }
      let descriptor = openSync(
        this.activePath,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile()) return false;
        if (stat.size + Buffer.byteLength(line) > MAX_FILE_BYTES) {
          closeSync(descriptor);
          descriptor = -1;
          renameSync(this.activePath, join(this.directory, rotatedName()));
          this.#prune();
          descriptor = openSync(
            this.activePath,
            constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          );
        }
        fchmodSync(descriptor, 0o600);
        writeSync(descriptor, line, undefined, "utf8");
      } finally {
        if (descriptor >= 0) closeSync(descriptor);
      }
      return true;
    } catch {
      return false;
    }
  }

  entries() {
    if (!this.#enabled) return [];
    try {
      const names = readdirSync(this.directory)
        .filter((name) => name === ACTIVE_FILE || ROTATED_FILE.test(name))
        .sort();
      const entries: DiagnosticLogEntry[] = [];
      for (const name of names) {
        const path = join(this.directory, name);
        let descriptor: number;
        try {
          descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch {
          continue;
        }
        let contents = "";
        try {
          const stat = fstatSync(descriptor);
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES + 1024) continue;
          contents = readFileSync(descriptor, "utf8");
        } finally {
          closeSync(descriptor);
        }
        for (const line of contents.split("\n")) {
          if (!line) continue;
          try {
            const value: unknown = JSON.parse(line);
            if (validEntry(value, true)) entries.push(value as DiagnosticLogEntry);
          } catch {
            // Ignore partial or externally modified diagnostic records.
          }
        }
      }
      return entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp)).slice(-10_000);
    } catch {
      return [];
    }
  }

  #prune() {
    const cutoff = Date.now() - RETENTION_MS;
    if (existsSync(this.activePath)) {
      const active = lstatSync(this.activePath);
      if (!active.isFile()) throw new Error("Diagnostics active log is unsafe");
      if (activeExpired(this.activePath, cutoff)) rmSync(this.activePath, { force: true });
    }
    const rotated = readdirSync(this.directory)
      .filter((name) => ROTATED_FILE.test(name))
      .map((name) => ({ name, stat: lstatSync(join(this.directory, name)) }))
      .filter(({ stat }) => stat.isFile())
      .map(({ name, stat }) => ({ name, modified: stat.mtimeMs }))
      .sort((left, right) => right.modified - left.modified);
    for (const [index, file] of rotated.entries()) {
      if (file.modified < cutoff || index >= MAX_FILES - 1) {
        rmSync(join(this.directory, file.name), { force: true });
      }
    }
  }
}

export function diagnosticCode(error: unknown, fallback = "INTERNAL_ERROR") {
  const value = record(error) && typeof error.code === "string" ? error.code : fallback;
  return diagnosticCodes.has(value) ? value : diagnosticCodes.has(fallback) ? fallback : "INTERNAL_ERROR";
}

export function createDiagnosticReport(options: {
  appVersion: string;
  desktop: boolean;
  supportedSchema: number;
  currentSchema: number | null;
  queue: CaptureQueueStatus | null;
  health: DataSafetyHealth | null;
  recoveryCode?: string | null;
  logs: DiagnosticLogEntry[];
}): DiagnosticReport {
  const health = options.health;
  const recentErrors: DiagnosticReport["recentErrors"] = health
    ? health.database.recentErrors.map(({ source, code, occurredAt }) => ({
        source,
        code: code && diagnosticCodes.has(code) ? code : "UNKNOWN_ERROR",
        occurredAt,
      }))
    : [];
  if (options.recoveryCode) {
    recentErrors.unshift({
      source: "startup",
      code: diagnosticCodes.has(options.recoveryCode) ? options.recoveryCode : "INTERNAL_ERROR",
      occurredAt: new Date().toISOString(),
    });
  }
  return {
    format: "zhiye-diagnostics",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    application: {
      version: options.appVersion.slice(0, 100),
      nodeVersion: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      desktop: options.desktop,
    },
    schema: {
      current: options.currentSchema,
      supported: options.supportedSchema,
      status: options.currentSchema === null ? "unavailable" : "current",
    },
    queue: options.queue,
    health: health ? {
      databaseIntegrity:
        health.database.integrityCheck.length === 1 && health.database.integrityCheck[0] === "ok"
          ? "ok"
          : "failed",
      foreignKeyViolations: health.database.foreignKeyViolations.length,
      missingSnapshots: health.missingSnapshots.length,
      orphanSnapshots: health.orphanSnapshots.length,
      unsafeSnapshotEntries: health.unsafeSnapshotEntries.length,
      missingAssets: health.missingAssets.length,
      orphanAssets: health.orphanAssets.length,
      unsafeAssetEntries: health.unsafeAssetEntries.length,
      pendingFileDeletions: health.database.pendingFileDeletions.length,
      storageBytes: health.storageBytes,
      recentBackup: health.recentBackup ? {
        reason: health.recentBackup.reason,
        status: health.recentBackup.status,
        createdAt: health.recentBackup.createdAt,
        schemaVersion: health.recentBackup.schemaVersion,
        totalBytes: health.recentBackup.totalBytes,
      } : null,
    } : null,
    recentErrors: recentErrors.slice(0, 20),
    logs: options.logs.filter((entry) => validEntry(entry, true)).slice(-10_000),
  };
}

export function createDiagnosticBundle(report: DiagnosticReport) {
  const logs = report.logs.map((entry) => JSON.stringify(entry)).join("\n");
  const notice = [
    "Zhiye diagnostic bundle",
    "",
    "This archive is built from an explicit allowlist and does not include article text, URLs,",
    "cookies, API keys, HTML snapshots, model input/output, or absolute file paths.",
    "Inspect the files before sharing them.",
    "",
  ].join("\n");
  return Buffer.from(zipSync({
    "diagnostics.json": strToU8(JSON.stringify(report, null, 2)),
    "logs.jsonl": strToU8(logs ? `${logs}\n` : ""),
    "README.txt": strToU8(notice),
  }, { level: 6 }));
}
