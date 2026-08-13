import { acquireDataLock } from "./lock.js";

type MaybePromise<T> = T | Promise<T>;

export interface SchemaInspection {
  /** null means no database exists; the inspector must reject corrupt or non-contiguous histories. */
  currentVersion: number | null;
  pending: boolean;
}

export interface StartupOptions<T, B> {
  dataDir: string;
  supportedSchemaVersion: number;
  recoverInterruptedRestore: (dataDir: string) => MaybePromise<unknown>;
  cleanupIncompleteBackups: () => MaybePromise<unknown>;
  inspectSchema: (dataDir: string) => MaybePromise<SchemaInspection>;
  createPreMigrationBackup: (dataDir: string, currentVersion: number) => MaybePromise<B>;
  verifyPreMigrationBackup: (backup: B) => MaybePromise<unknown>;
  applyMigrations: (
    dataDir: string,
    currentVersion: number | null,
    supportedSchemaVersion: number,
  ) => MaybePromise<unknown>;
  open: (dataDir: string) => MaybePromise<T>;
  afterOpen?: (value: T) => MaybePromise<unknown>;
  closeOnError?: (value: T) => MaybePromise<unknown>;
  recoverOnError?: (error: unknown) => MaybePromise<T>;
}

export interface StartupHandle<T> {
  value: T;
  releaseLock: () => void;
}

function validateInspection(inspection: SchemaInspection, supportedVersion: number) {
  const { currentVersion, pending } = inspection;
  if (
    (currentVersion !== null && (!Number.isSafeInteger(currentVersion) || currentVersion < 0)) ||
    typeof pending !== "boolean"
  ) {
    throw new Error("Schema inspection returned an invalid version");
  }
  if (currentVersion !== null && currentVersion > supportedVersion) {
    throw new Error(
      `Knowledge base schema ${currentVersion} is newer than supported schema ${supportedVersion}`,
    );
  }
  if (pending !== (currentVersion === null || currentVersion < supportedVersion)) {
    throw new Error("Schema inspection returned an inconsistent migration state");
  }
}

export async function runStartup<T, B>(options: StartupOptions<T, B>): Promise<StartupHandle<T>> {
  if (!Number.isSafeInteger(options.supportedSchemaVersion) || options.supportedSchemaVersion < 1) {
    throw new Error("Supported schema version must be a positive integer");
  }
  if (options.afterOpen && !options.closeOnError) {
    throw new Error("closeOnError is required when afterOpen is configured");
  }

  const releaseLock = acquireDataLock(options.dataDir);
  let opened = false;
  let value: T;
  try {
    await options.recoverInterruptedRestore(options.dataDir);
    await options.cleanupIncompleteBackups();
    const inspection = await options.inspectSchema(options.dataDir);
    validateInspection(inspection, options.supportedSchemaVersion);
    if (inspection.pending) {
      if (inspection.currentVersion !== null) {
        const backup = await options.createPreMigrationBackup(options.dataDir, inspection.currentVersion);
        await options.verifyPreMigrationBackup(backup);
      }
      await options.applyMigrations(
        options.dataDir,
        inspection.currentVersion,
        options.supportedSchemaVersion,
      );
    }
    value = await options.open(options.dataDir);
    opened = true;
    await options.afterOpen?.(value);
    return { value, releaseLock };
  } catch (error) {
    let cleanupError: unknown;
    try {
      if (opened) await options.closeOnError?.(value!);
    } catch (cause) {
      cleanupError = cause;
    }
    if (!cleanupError && options.recoverOnError) {
      try {
        value = await options.recoverOnError(error);
        return { value, releaseLock };
      } catch (recoveryError) {
        cleanupError = new AggregateError([error, recoveryError], "Startup recovery mode failed");
      }
    }
    try {
      releaseLock();
    } catch (cause) {
      cleanupError = cleanupError ? new AggregateError([cleanupError, cause]) : cause;
    }
    if (cleanupError) throw new AggregateError([error, cleanupError], "Startup and cleanup both failed");
    throw error;
  }
}
