import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validSha, writeJsonAtomic } from "./delivery-policy.mjs";

export function recordReleaseExit(directory, stage, exitCode) {
  const [sha, runId, attempt] = directory.split("/").slice(-3);
  if (!validSha(sha) || !/^\d+$/u.test(runId) || !/^\d+$/u.test(attempt)) throw new Error("Invalid release evidence directory");
  const path = resolve(directory, "evidence.json");
  const evidence = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { sha, run: `${runId}/${attempt}`, authenticatedBusinessAcceptance: "not-verified" };
  if (exitCode !== null && exitCode !== 0) {
    if (evidence.status === "success") evidence.status = "published-state-update-failed";
    else if (!["failed", "migration-failed"].includes(evidence.status)) evidence.status = "gate-failed";
  }
  evidence.status ??= "checking";
  writeJsonAtomic(path, { ...evidence, stage, exitCode });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  recordReleaseExit(dirname(resolve(process.argv[2])), process.env.RELEASE_STAGE ?? "starting",
    process.env.RELEASE_EXIT_CODE === undefined ? null : Number(process.env.RELEASE_EXIT_CODE));
}
