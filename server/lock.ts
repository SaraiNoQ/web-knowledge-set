import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface LockContents {
  pid: number;
  token: string;
}

function readLock(path: string): LockContents | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockContents>;
    return typeof value.pid === "number" && typeof value.token === "string"
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

export function acquireDataLock(dataDir: string) {
  const existed = existsSync(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const entries = readdirSync(dataDir);
  const appEntries = new Set([
    ".zhiye.lock",
    "snapshots",
    "zhiye.sqlite3",
    "zhiye.sqlite3-shm",
    "zhiye.sqlite3-wal",
  ]);
  if (!existed || entries.every((entry) => appEntries.has(entry))) {
    chmodSync(dataDir, 0o700);
  }
  const path = join(dataDir, ".zhiye.lock");
  const contents: LockContents = { pid: process.pid, token: randomUUID() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, "wx", 0o600);
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
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLock(path);
      if (existing && processExists(existing.pid)) {
        throw new Error(`Knowledge base is already open by process ${existing.pid}`);
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
