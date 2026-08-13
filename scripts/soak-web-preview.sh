#!/bin/sh
set -eu

NODE=/opt/zhiye-preview/current/node

[ "$(id -u)" -eq 0 ] || { echo "run as root to inspect the non-root service" >&2; exit 1; }
[ -x "$NODE" ] || { echo "zhiye preview runtime is not installed" >&2; exit 1; }
[ "$#" -ge 1 ] && [ "$#" -le 3 ] || {
  echo "usage: $0 RECORD_NAME [DURATION_SECONDS [INTERVAL_SECONDS]] | $0 --verify-restart RECORD_NAME" >&2
  exit 2
}

exec "$NODE" - "$@" <<'NODE'
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SERVICE = "zhiye-preview.service";
const SERVICE_USER = "zhiye-preview";
const CURRENT = "/opt/zhiye-preview/current";
const EVIDENCE_ROOT = "/var/lib/zhiye-preview-evidence";
const PORT = 4301;
const MAX_HTTP_BYTES = 8 * 1024 * 1024;
const MAX_TEMP_ENTRIES = 100_000;
const args = process.argv.slice(2);

function positiveInteger(value, fallback) {
  const text = value ?? String(fallback);
  if (!/^[1-9][0-9]*$/u.test(text)) throw new Error("INVALID_ARGUMENT");
  const result = Number(text);
  if (!Number.isSafeInteger(result)) throw new Error("INVALID_ARGUMENT");
  return result;
}

function recordDirectory(name, create) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) {
    throw new Error("INVALID_RECORD_NAME");
  }
  if (create) {
    try {
      fs.mkdirSync(EVIDENCE_ROOT, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  strictRootDirectory(EVIDENCE_ROOT);
  const directory = path.join(EVIDENCE_ROOT, name);
  if (create) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  strictRootDirectory(directory);
  return directory;
}

function strictRootDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o7777) !== 0o700) {
    throw new Error("UNSAFE_EVIDENCE_DIRECTORY");
  }
}

function get(pathname, cookie) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "127.0.0.1",
      port: PORT,
      path: pathname,
      headers: cookie ? { Cookie: cookie } : undefined,
      timeout: 5_000,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_HTTP_BYTES) request.destroy(new Error("HTTP_TOO_LARGE"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("timeout", () => request.destroy(new Error("HTTP_TIMEOUT")));
    request.on("error", reject);
  });
}

function json(response) {
  if (response.status !== 200) throw new Error("HTTP_STATUS");
  return JSON.parse(response.body);
}

async function webMetrics(errors) {
  const result = {
    healthOk: false,
    mode: "unavailable",
    maintenance: null,
    integrity: "unavailable",
    foreignKeyViolations: null,
    missingSnapshots: null,
    missingAssets: null,
    unsafeSnapshots: null,
    unsafeAssets: null,
  };
  try {
    result.healthOk = json(await get("/health")).ok === true;
    if (!result.healthOk) errors.push("HEALTH_UNAVAILABLE");
  } catch {
    errors.push("HEALTH_UNAVAILABLE");
  }
  try {
    const launch = await get("/");
    const setCookie = Array.isArray(launch.headers["set-cookie"])
      ? launch.headers["set-cookie"][0]
      : launch.headers["set-cookie"];
    const cookie = typeof setCookie === "string" ? setCookie.split(";", 1)[0] : "";
    if (launch.status !== 302 || !cookie) throw new Error("SESSION_UNAVAILABLE");
    const status = json(await get("/api/data-safety", cookie));
    const health = status.health;
    result.mode = status.mode === "ready" || status.mode === "recovery" ? status.mode : "unavailable";
    result.maintenance = typeof status.maintenance === "boolean" ? status.maintenance : null;
    if (!health) throw new Error("DATA_SAFETY_NOT_READY");
    result.integrity = health.database?.integrityCheck?.length === 1 && health.database.integrityCheck[0] === "ok"
      ? "ok"
      : "failed";
    result.foreignKeyViolations = Array.isArray(health.database?.foreignKeyViolations)
      ? health.database.foreignKeyViolations.length
      : null;
    result.missingSnapshots = Array.isArray(health.missingSnapshots) ? health.missingSnapshots.length : null;
    result.missingAssets = Array.isArray(health.missingAssets) ? health.missingAssets.length : null;
    result.unsafeSnapshots = Array.isArray(health.unsafeSnapshotEntries) ? health.unsafeSnapshotEntries.length : null;
    result.unsafeAssets = Array.isArray(health.unsafeAssetEntries) ? health.unsafeAssetEntries.length : null;
    if (result.mode !== "ready" || result.maintenance !== false) errors.push("DATA_SAFETY_NOT_READY");
  } catch {
    errors.push("DATA_SAFETY_UNAVAILABLE");
  }
  return result;
}

function serviceProperties() {
  const output = execFileSync("/usr/bin/systemctl", [
    "show", SERVICE,
    "--property=ActiveState",
    "--property=ControlGroup",
    "--property=MainPID",
    "--property=User",
  ], { encoding: "utf8", timeout: 5_000 });
  return Object.fromEntries(output.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function processCgroup(pid) {
  for (const line of fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("\n")) {
    const parts = line.split(":");
    if (parts[1] === "" || parts[1].split(",").includes("name=systemd")) return parts[2];
  }
  return "";
}

function belongsToCgroup(pid, cgroup) {
  const value = processCgroup(pid);
  return Boolean(cgroup && (value === cgroup || value.startsWith(`${cgroup}/`)));
}

function scanTemporaryFiles(mainPid) {
  const seenRoots = new Set();
  const stack = [`/proc/${mainPid}/root/tmp`, `/proc/${mainPid}/root/var/tmp`].filter((value) => {
    try {
      const stat = fs.statSync(value);
      const key = `${stat.dev}:${stat.ino}`;
      if (seenRoots.has(key)) return false;
      seenRoots.add(key);
      return true;
    } catch {
      return false;
    }
  });
  let entries = 0;
  let files = 0;
  let bytes = 0;
  let truncated = false;
  while (stack.length) {
    const directory = stack.pop();
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      entries += 1;
      if (entries > MAX_TEMP_ENTRIES) {
        truncated = true;
        stack.length = 0;
        break;
      }
      const entry = path.join(directory, name);
      try {
        const stat = fs.lstatSync(entry);
        if (stat.isDirectory()) stack.push(entry);
        else if (stat.isFile()) {
          files += 1;
          bytes += stat.size;
        }
      } catch {
        // A concurrently removed entry is not evidence of persistent growth.
      }
    }
  }
  return { temporaryFiles: files, temporaryBytes: bytes, temporaryScanTruncated: truncated };
}

function scanRuntimeProcesses(runtimeRoots, cgroup) {
  let runtimeProcesses = 0;
  let runtimeOrphans = 0;
  for (const name of fs.readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/u.test(name)) continue;
    if (Number(name) === process.pid) continue;
    try {
      const executable = fs.realpathSync(`/proc/${name}/exe`);
      const sameRuntime = [...runtimeRoots].some((root) => executable === root || executable.startsWith(`${root}/`));
      if (!sameRuntime) continue;
      runtimeProcesses += 1;
      if (!belongsToCgroup(name, cgroup)) runtimeOrphans += 1;
    } catch {
      // Processes may exit while /proc is scanned.
    }
  }
  return { runtimeProcesses, runtimeOrphans };
}

function processMetrics(errors, runtimeRoots) {
  const result = {
    serviceActive: false,
    serviceUserValid: false,
    mainPid: null,
    rssKiB: null,
    fdCount: null,
    temporaryFiles: null,
    temporaryBytes: null,
    temporaryScanTruncated: null,
    runtimeProcesses: null,
    runtimeOrphans: null,
  };
  try {
    const properties = serviceProperties();
    const mainPid = Number(properties.MainPID);
    result.serviceActive = properties.ActiveState === "active";
    result.mainPid = Number.isSafeInteger(mainPid) && mainPid > 0 ? mainPid : null;
    if (!result.serviceActive || !result.mainPid) throw new Error("SERVICE_INACTIVE");
    const expectedUid = Number(execFileSync("/usr/bin/id", ["-u", SERVICE_USER], { encoding: "utf8" }).trim());
    result.serviceUserValid = properties.User === SERVICE_USER && fs.statSync(`/proc/${mainPid}`).uid === expectedUid;
    if (!result.serviceUserValid) errors.push("SERVICE_USER_INVALID");
    const status = fs.readFileSync(`/proc/${mainPid}/status`, "utf8");
    const rss = /^VmRSS:\s+([0-9]+)\s+kB$/mu.exec(status);
    result.rssKiB = rss ? Number(rss[1]) : null;
    result.fdCount = fs.readdirSync(`/proc/${mainPid}/fd`).length;
    Object.assign(result, scanTemporaryFiles(mainPid));
    if (result.temporaryScanTruncated) errors.push("TEMP_SCAN_TRUNCATED");
    runtimeRoots.add(fs.realpathSync(CURRENT));
    Object.assign(result, scanRuntimeProcesses(runtimeRoots, properties.ControlGroup));
  } catch {
    errors.push("PROCESS_UNAVAILABLE");
  }
  return result;
}

function maximum(current, value) {
  return typeof value === "number" ? Math.max(current, value) : current;
}

async function collectSample(sequence, runtimeRoots) {
  const errors = [];
  return {
    format: "zhiye-web-soak-sample",
    formatVersion: 1,
    sequence,
    at: new Date().toISOString(),
    ...await webMetrics(errors),
    ...processMetrics(errors, runtimeRoots),
    errors: [...new Set(errors)],
  };
}

function healthy(sample) {
  return sample.errors.length === 0 && sample.healthOk && sample.mode === "ready" &&
    sample.maintenance === false && sample.integrity === "ok" &&
    sample.foreignKeyViolations === 0 && sample.missingSnapshots === 0 &&
    sample.missingAssets === 0 && sample.unsafeSnapshots === 0 &&
    sample.unsafeAssets === 0 && sample.serviceActive && sample.serviceUserValid &&
    Number.isSafeInteger(sample.rssKiB) && Number.isSafeInteger(sample.fdCount) &&
    Number.isSafeInteger(sample.temporaryFiles) && Number.isSafeInteger(sample.temporaryBytes) &&
    sample.temporaryScanTruncated === false && Number.isSafeInteger(sample.runtimeProcesses) &&
    sample.runtimeOrphans === 0;
}

async function verifyRestart(outputDirectory) {
  process.umask(0o077);
  const soak = JSON.parse(fs.readFileSync(path.join(outputDirectory, "summary.json"), "utf8"));
  if (soak.format !== "zhiye-web-soak-summary") throw new Error("INVALID_SOAK_SUMMARY");
  const samples = fs.readFileSync(path.join(outputDirectory, "samples.jsonl"), "utf8").trim().split("\n");
  const previous = JSON.parse(samples.at(-1));
  if (previous.format !== "zhiye-web-soak-sample" || !Number.isSafeInteger(previous.mainPid) || previous.mainPid <= 0) {
    throw new Error("INVALID_SOAK_SAMPLE");
  }
  let current;
  let attempts = 0;
  do {
    attempts += 1;
    current = await collectSample(previous.sequence + 1, new Set());
    if (current.mainPid !== previous.mainPid && healthy(current)) break;
    if (attempts < 30) await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (attempts < 30);
  const result = {
    format: "zhiye-web-soak-restart-verification",
    formatVersion: 1,
    at: current.at,
    previousMainPid: previous.mainPid,
    currentMainPid: current.mainPid,
    attempts,
    soakComplete: soak.complete === true,
    soakPass: soak.pass === true,
    restartObserved: Number.isSafeInteger(current.mainPid) && current.mainPid > 0 && current.mainPid !== previous.mainPid,
    healthOk: current.healthOk,
    mode: current.mode,
    maintenance: current.maintenance,
    integrity: current.integrity,
    foreignKeyViolations: current.foreignKeyViolations,
    missingSnapshots: current.missingSnapshots,
    missingAssets: current.missingAssets,
    unsafeSnapshots: current.unsafeSnapshots,
    unsafeAssets: current.unsafeAssets,
    serviceActive: current.serviceActive,
    serviceUserValid: current.serviceUserValid,
    rssKiB: current.rssKiB,
    fdCount: current.fdCount,
    temporaryFiles: current.temporaryFiles,
    temporaryBytes: current.temporaryBytes,
    temporaryScanTruncated: current.temporaryScanTruncated,
    runtimeProcesses: current.runtimeProcesses,
    runtimeOrphans: current.runtimeOrphans,
    errors: current.errors,
  };
  result.pass = result.soakComplete && result.soakPass && result.restartObserved && healthy(current);
  const fd = fs.openSync(path.join(outputDirectory, "restart-verification.json"), "wx", 0o600);
  fs.writeSync(fd, `${JSON.stringify(result, null, 2)}\n`);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  console.log(`restart verification finished: ${result.pass ? "pass" : "fail"}`);
  process.exitCode = result.pass ? 0 : 1;
}

async function main() {
  process.umask(0o077);
  const outputDirectory = recordDirectory(args[0], true);
  const durationSeconds = positiveInteger(args[1], 86_400);
  const intervalSeconds = positiveInteger(args[2], 300);
  const sampleLimit = Math.ceil(durationSeconds / intervalSeconds) + 1;
  if (durationSeconds > 604_800 || sampleLimit > 10_000) throw new Error("UNBOUNDED_RUN");
  const samplesFd = fs.openSync(path.join(outputDirectory, "samples.jsonl"), "wx", 0o600);
  const runtimeRoots = new Set();
  const started = Date.now();
  const deadline = started + durationSeconds * 1_000;
  let stopSignal = null;
  let wake = null;
  for (const [signal, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]) {
    process.once(signal, () => {
      stopSignal = { signal, code };
      wake?.();
    });
  }
  const stats = {
    samples: 0,
    sampleFailures: 0,
    healthFailures: 0,
    integrityFailures: 0,
    maxForeignKeyViolations: 0,
    maxMissingSnapshots: 0,
    maxMissingAssets: 0,
    maxUnsafeSnapshots: 0,
    maxUnsafeAssets: 0,
    maxRuntimeOrphans: 0,
    maxRssKiB: 0,
    maxFdCount: 0,
    maxTemporaryFiles: 0,
    maxTemporaryBytes: 0,
    mainPidChanges: 0,
    firstRssKiB: null,
    lastRssKiB: null,
    firstFdCount: null,
    lastFdCount: null,
    firstTemporaryFiles: null,
    lastTemporaryFiles: null,
    firstTemporaryBytes: null,
    lastTemporaryBytes: null,
    longestTemporaryGrowthRun: 0,
  };
  let previousPid = null;
  let previousTemporaryBytes = null;
  let temporaryGrowthRun = 0;

  console.log("soak recorder started");
  while (!stopSignal && stats.samples < sampleLimit) {
    const sample = await collectSample(stats.samples + 1, runtimeRoots);
    fs.writeSync(samplesFd, `${JSON.stringify(sample)}\n`);
    fs.fsyncSync(samplesFd);
    stats.samples += 1;
    if (!healthy(sample)) stats.sampleFailures += 1;
    if (!sample.healthOk) stats.healthFailures += 1;
    if (sample.integrity !== "ok") stats.integrityFailures += 1;
    stats.maxForeignKeyViolations = maximum(stats.maxForeignKeyViolations, sample.foreignKeyViolations);
    stats.maxMissingSnapshots = maximum(stats.maxMissingSnapshots, sample.missingSnapshots);
    stats.maxMissingAssets = maximum(stats.maxMissingAssets, sample.missingAssets);
    stats.maxUnsafeSnapshots = maximum(stats.maxUnsafeSnapshots, sample.unsafeSnapshots);
    stats.maxUnsafeAssets = maximum(stats.maxUnsafeAssets, sample.unsafeAssets);
    stats.maxRuntimeOrphans = maximum(stats.maxRuntimeOrphans, sample.runtimeOrphans);
    stats.maxRssKiB = maximum(stats.maxRssKiB, sample.rssKiB);
    stats.maxFdCount = maximum(stats.maxFdCount, sample.fdCount);
    stats.maxTemporaryFiles = maximum(stats.maxTemporaryFiles, sample.temporaryFiles);
    stats.maxTemporaryBytes = maximum(stats.maxTemporaryBytes, sample.temporaryBytes);
    if (typeof sample.mainPid === "number" && previousPid !== null && sample.mainPid !== previousPid) stats.mainPidChanges += 1;
    if (typeof sample.mainPid === "number") previousPid = sample.mainPid;
    if (typeof sample.rssKiB === "number") {
      stats.firstRssKiB ??= sample.rssKiB;
      stats.lastRssKiB = sample.rssKiB;
    }
    if (typeof sample.fdCount === "number") {
      stats.firstFdCount ??= sample.fdCount;
      stats.lastFdCount = sample.fdCount;
    }
    if (typeof sample.temporaryFiles === "number") {
      stats.firstTemporaryFiles ??= sample.temporaryFiles;
      stats.lastTemporaryFiles = sample.temporaryFiles;
    }
    if (typeof sample.temporaryBytes === "number") {
      stats.firstTemporaryBytes ??= sample.temporaryBytes;
      stats.lastTemporaryBytes = sample.temporaryBytes;
      temporaryGrowthRun = previousTemporaryBytes !== null && sample.temporaryBytes > previousTemporaryBytes
        ? temporaryGrowthRun + 1
        : 0;
      stats.longestTemporaryGrowthRun = Math.max(stats.longestTemporaryGrowthRun, temporaryGrowthRun);
      previousTemporaryBytes = sample.temporaryBytes;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.min(intervalSeconds * 1_000, deadline - Date.now()));
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = null;
  }
  fs.closeSync(samplesFd);
  const finished = Date.now();
  const complete = !stopSignal && finished >= deadline;
  const summary = {
    format: "zhiye-web-soak-summary",
    formatVersion: 1,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    targetDurationSeconds: durationSeconds,
    intervalSeconds,
    elapsedSeconds: Math.floor((finished - started) / 1_000),
    complete,
    interrupted: stopSignal?.signal ?? null,
    ...stats,
    rssDeltaKiB: stats.firstRssKiB === null || stats.lastRssKiB === null ? null : stats.lastRssKiB - stats.firstRssKiB,
    fdDelta: stats.firstFdCount === null || stats.lastFdCount === null ? null : stats.lastFdCount - stats.firstFdCount,
    temporaryFilesDelta: stats.firstTemporaryFiles === null || stats.lastTemporaryFiles === null ? null : stats.lastTemporaryFiles - stats.firstTemporaryFiles,
    temporaryBytesDelta: stats.firstTemporaryBytes === null || stats.lastTemporaryBytes === null ? null : stats.lastTemporaryBytes - stats.firstTemporaryBytes,
  };
  summary.temporaryGrowthSuspected = summary.temporaryBytesDelta > 0 &&
    stats.longestTemporaryGrowthRun * intervalSeconds >= 3_600;
  summary.pass = complete && stats.sampleFailures === 0 && stats.healthFailures === 0 &&
    stats.integrityFailures === 0 && stats.maxForeignKeyViolations === 0 &&
    stats.maxMissingSnapshots === 0 && stats.maxMissingAssets === 0 &&
    stats.maxUnsafeSnapshots === 0 && stats.maxUnsafeAssets === 0 && stats.maxRuntimeOrphans === 0 &&
    stats.mainPidChanges === 0 && !summary.temporaryGrowthSuspected;
  const summaryFd = fs.openSync(path.join(outputDirectory, "summary.json"), "wx", 0o600);
  fs.writeSync(summaryFd, `${JSON.stringify(summary, null, 2)}\n`);
  fs.fsyncSync(summaryFd);
  fs.closeSync(summaryFd);
  console.log(`soak recorder finished: ${summary.pass ? "pass" : "fail"}`);
  process.exitCode = stopSignal?.code ?? (summary.pass ? 0 : 1);
}

const operation = args[0] === "--verify-restart"
  ? args.length === 2 ? verifyRestart(recordDirectory(args[1], false)) : Promise.reject(new Error("INVALID_ARGUMENT"))
  : main();

operation.catch(() => {
  console.error("soak recorder failed");
  process.exitCode = 1;
});
NODE
