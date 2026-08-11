import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface LockContents {
  pid: number;
  token: string;
}

const LOCK_INITIALIZATION_GRACE_MS = 30_000;

function readLock(path: string): LockContents | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4096) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockContents>;
    return typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.token === "string"
      ? { pid: value.pid, token: value.token }
      : null;
  } catch {
    return null;
  }
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function dataTarget(dataDir: string) {
  const requested = resolve(dataDir);
  const name = basename(requested);
  const requestedParent = dirname(requested);
  if (!name || requestedParent === requested) throw new Error("Knowledge-base data path must have a parent");
  const createdParent = !existsSync(requestedParent);
  if (createdParent) mkdirSync(requestedParent, { recursive: true, mode: 0o700 });
  if (!lstatSync(requestedParent).isDirectory()) {
    throw new Error("Knowledge-base parent is not a directory");
  }
  if (createdParent) chmodSync(requestedParent, 0o700);
  const parent = realpathSync(requestedParent);
  const target = join(parent, name);
  if (existsSync(target) && !lstatSync(target).isDirectory()) {
    throw new Error("Knowledge-base data path is not a real directory");
  }
  return existsSync(target) ? realpathSync(target) : target;
}

function lockPath(dataDir: string) {
  const target = dataTarget(dataDir);
  return join(dirname(target), `.${basename(target)}.zhiye.lock`);
}

function protectExistingDataDirectory(dataDir: string) {
  const target = dataTarget(dataDir);
  if (!existsSync(target) || !lstatSync(target).isDirectory() || realpathSync(target) !== target) return;
  const appEntries = new Set([
    "assets",
    "import-staging",
    "snapshots",
    "zhiye.sqlite3",
    "zhiye.sqlite3-shm",
    "zhiye.sqlite3-wal",
  ]);
  if (readdirSync(target).every((entry) => appEntries.has(entry))) chmodSync(target, 0o700);
}

export function acquireDataLock(dataDir: string) {
  const path = lockPath(dataDir);
  protectExistingDataDirectory(dataDir);
  const contents: LockContents = { pid: process.pid, token: randomUUID() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | undefined;
    let created = false;
    try {
      descriptor = openSync(path, "wx", 0o600);
      created = true;
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, JSON.stringify(contents));
      closeSync(descriptor);
      descriptor = undefined;
      return () => {
        const current = readLock(path);
        if (current?.token === contents.token) {
          try {
            unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (created) {
        try {
          unlinkSync(path);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let lockStat;
      try {
        lockStat = lstatSync(path);
        if (!lockStat.isFile()) throw new Error("Knowledge-base lock path is not a regular file");
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      const existing = readLock(path);
      if (existing && processExists(existing.pid)) {
        throw new Error(`Knowledge base is already open by process ${existing.pid}`);
      }
      if (!existing && Date.now() - lockStat.mtimeMs <= LOCK_INITIALIZATION_GRACE_MS) {
        throw new Error("Knowledge base is already opening in another process");
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error("Could not acquire knowledge-base lock");
}
