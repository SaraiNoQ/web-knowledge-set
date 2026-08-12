import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

import { createApp } from "./app.js";
import {
  cleanupIncompleteBackups,
  createBackup,
  recoverInterruptedRestore,
  verifyBackup,
  type VerifiedBackup,
} from "./backup.js";
import {
  defaultBackupRoot,
  ensureDailyAutomaticBackup,
  reconcileBackupRecords,
} from "./data-safety.js";
import {
  CURRENT_SCHEMA_VERSION,
  DatabaseSchemaError,
  inspectDatabaseSchema,
  migrateDatabase,
  openDatabase,
  type KnowledgeDatabase,
} from "./db.js";
import { diagnosticCode, DiagnosticsLogger } from "./diagnostics.js";
import { runStartup } from "./startup.js";

const IDENTIFIER = "io.github.sarainoq.zhiye";
const LEGACY_IDENTIFIER = "dev.local.zhiye";

function directoryHasEntries(path: string) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe knowledge-base path: ${path}`);
    return readdirSync(path).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function regularFileExists(path: string) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe knowledge-base lock path: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function defaultState(path: string) {
  const parent = dirname(path);
  const name = basename(path);
  const data = directoryHasEntries(path);
  const backups = directoryHasEntries(join(parent, `${name}-backups`));
  const diagnostics = directoryHasEntries(join(parent, `${name}-diagnostics`));
  const lock = regularFileExists(join(parent, `.${name}.zhiye.lock`));
  const companions = backups || diagnostics || lock;
  if (!data && companions) {
    throw new Error("Knowledge-base backups, diagnostics, or lock exist without their data directory; set KB_DATA_DIR explicitly");
  }
  return data;
}

function defaultDataDirectory(home = homedir(), platform = process.platform) {
  const parent = platform === "darwin"
    ? join(home, "Library", "Application Support")
    : join(home, ".local", "share");
  const current = join(parent, IDENTIFIER);
  const legacy = join(parent, LEGACY_IDENTIFIER);
  const currentExists = defaultState(current);
  const legacyExists = defaultState(legacy);
  if (currentExists && legacyExists) {
    throw new Error("Both legacy and formal knowledge bases exist; set KB_DATA_DIR explicitly");
  }
  return legacyExists ? legacy : current;
}

const dataDir = resolve(
  process.env.KB_DATA_DIR || defaultDataDirectory(),
);
const staticDir = resolve(process.env.KB_STATIC_DIR ?? join(process.cwd(), "dist"));
const backupRoot = defaultBackupRoot(dataDir);
const requestedPort = Number(process.env.KB_PORT ?? 0);
function packageVersion() {
  for (const path of [new URL("../package.json", import.meta.url), new URL("../../package.json", import.meta.url)]) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
      if (typeof value.version === "string" && value.version.length <= 100) return value.version;
    } catch {
      // Source and compiled entry points have different package-relative locations.
    }
  }
  throw new Error("Application package version is unavailable");
}
const appVersion = packageVersion();
const diagnostics = new DiagnosticsLogger(dataDir);
const llmApiKey = process.env.ZHIYE_LLM_API_KEY?.trim() ?? "";
const llmApiKeyEndpoint = process.env.ZHIYE_LLM_API_ENDPOINT?.trim() ?? "";
delete process.env.ZHIYE_LLM_API_KEY;
delete process.env.ZHIYE_LLM_API_ENDPOINT;
if (process.env.ZHIYE_DESKTOP_SMOKE === "1") {
  writeFileSync(join(dataDir, ".desktop-smoke-llm"), llmApiKey && llmApiKeyEndpoint ? "configured" : "missing", { mode: 0o600 });
}
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
  throw new Error("KB_PORT must be an integer from 0 to 65535");
}
diagnostics.log({ level: "info", event: "service_starting", mode: process.env.KB_DESKTOP === "1" ? "desktop" : "web" });

interface StartupValue {
  database: KnowledgeDatabase | null;
  recoveryError: unknown | null;
}

const startup = await runStartup<StartupValue, VerifiedBackup>({
  dataDir,
  supportedSchemaVersion: CURRENT_SCHEMA_VERSION,
  recoverInterruptedRestore,
  cleanupIncompleteBackups() {
    try {
      return cleanupIncompleteBackups(backupRoot, dataDir);
    } catch (error) {
      diagnostics.log({ level: "error", event: "backup_cleanup_failed", code: diagnosticCode(error) });
      return 0;
    }
  },
  inspectSchema(path) {
    const inspection = inspectDatabaseSchema(path);
    if (inspection.status === "future" || inspection.status === "non-contiguous") {
      throw new DatabaseSchemaError(inspection);
    }
    return {
      currentVersion: inspection.status === "empty" ? null : inspection.currentVersion,
      pending: inspection.status === "empty" || inspection.status === "pending",
    };
  },
  async createPreMigrationBackup(path) {
    const database = new DatabaseSync(join(path, "zhiye.sqlite3"), { readOnly: true });
    try {
      database.exec("PRAGMA query_only = ON");
      return await createBackup({
        dataDir: path,
        backupRoot,
        database,
        reason: "pre-migration",
      });
    } finally {
      database.close();
    }
  },
  verifyPreMigrationBackup: (backup) => verifyBackup(backup.path),
  applyMigrations: (path) => migrateDatabase(path),
  open: (path) => ({ database: openDatabase(path), recoveryError: null }),
  async afterOpen(value) {
    if (!value.database) return;
    try {
      await reconcileBackupRecords(value.database, backupRoot);
    } catch (error) {
      diagnostics.log({ level: "error", event: "backup_reconciliation_failed", code: diagnosticCode(error) });
    }
    try {
      await ensureDailyAutomaticBackup(value.database, dataDir, backupRoot);
    } catch (error) {
      diagnostics.log({ level: "error", event: "automatic_backup_failed", code: diagnosticCode(error) });
    }
  },
  closeOnError: (value) => value.database?.close(),
  recoverOnError: (error) => ({ database: null, recoveryError: error }),
});
const releaseLock = startup.releaseLock;
const dev = process.env.KB_DEV === "1";
const desktop = process.env.KB_DESKTOP === "1";
const app = createApp({
  dataDir,
  database: startup.value.database,
  recoveryError: startup.value.recoveryError,
  backupRoot,
  staticDir,
  dev,
  llmApiKey,
  llmApiKeyEndpoint,
  appVersion,
  diagnostics,
  onDesktopCloseReady: desktop ? (attemptId) => console.log(`ZHIYE_CLOSE_READY ${attemptId}`) : undefined,
});
const vite = dev
  ? await (await import("vite")).createServer({ server: { middlewareMode: true }, appType: "spa" })
  : null;
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (vite && pathname !== "/health" && pathname !== "/launch" && !pathname.startsWith("/api/")) {
    vite.middlewares(request, response, () => void app.handler(request, response));
  } else {
    void app.handler(request, response);
  }
});

let closing = false;
const desktopInput = desktop ? createInterface({ input: process.stdin }) : null;
async function close(exitCode = 0) {
  if (closing) return;
  closing = true;
  diagnostics.log({ level: "info", event: "service_stopping", count: exitCode });
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await vite?.close();
  await app.close();
  desktopInput?.close();
  releaseLock();
  process.exitCode = exitCode;
}

desktopInput?.on("line", (line) => {
  if (line === "ZHIYE_SHUTDOWN") void close();
});
desktopInput?.once("close", () => void close());

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
server.once("error", (error) => {
  diagnostics.log({ level: "error", event: "server_error", code: diagnosticCode(error) });
  void close(1);
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
  const launchUrl = `http://127.0.0.1:${address.port}/launch?token=${encodeURIComponent(app.bootstrapToken)}`;
  diagnostics.log({ level: "info", event: "service_ready", mode: desktop ? "desktop" : "web" });
  console.log(`ZHIYE_READY ${launchUrl}`);
});
