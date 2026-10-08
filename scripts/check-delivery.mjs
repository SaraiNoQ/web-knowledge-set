import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { checkMigrations, checkMigrationData, desktopReleaseVersion, sha256, validSha } from "./delivery-policy.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (name) => readFileSync(resolve(root, name), "utf8");
assert.equal(read("AGENTS.md"), read("CLAUDE.md"), "Contributor files must be mirrored");
const pkg = JSON.parse(read("package.json"));
assert.equal(pkg.engines.node, "24.19.0");
assert.equal(pkg.packageManager, "pnpm@11.7.0");
assert.equal(read(".node-version").trim(), pkg.engines.node);
desktopReleaseVersion({ version: pkg.version, cargo: read("src-tauri/Cargo.toml"), tauri: JSON.parse(read("src-tauri/tauri.conf.json")), info: read("src-tauri/Info.rc.plist"), lock: read("src-tauri/Cargo.lock") },
  /^refs\/tags\/v\d+\.\d+\.\d+$/u.test(process.env.GITHUB_REF ?? "") ? process.env.GITHUB_REF_NAME : undefined);
const firefox = JSON.parse(read("extension/manifest.firefox.json"));
assert.equal(firefox.version, JSON.parse(read("extension/manifest.chrome.json")).version, "Extension versions must match");
const signed = JSON.parse(read("extension/amo/signed-release.json"));
assert.equal(signed.version, firefox.version, "Signed release metadata must match manifest");
assert(/^[a-zA-Z0-9._-]+\.xpi$/u.test(signed.filename) && /^[a-f0-9]{64}$/u.test(signed.sha256), "Invalid signed XPI metadata");
for (const name of readdirSync(resolve(root, ".github/workflows"))) {
  const workflow = read(`.github/workflows/${name}`);
  assert(!/^\s*pull_request_target:/mu.test(workflow), "Never execute PR code with privileged trigger");
  for (const [, action] of workflow.matchAll(/^\s*(?:- )?uses: (\S+)/gmu)) {
    assert(action.startsWith("./") || /@[a-f0-9]{40}$/u.test(action), `Unpinned Action: ${action}`);
  }
}
const base = process.env.BASE_SHA;
if (base && !/^0+$/u.test(base)) {
  assert(validSha(base), "Invalid BASE_SHA");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const names = git("ls-tree", "-r", "--name-only", base, "cloud/migrations").trim().split("\n").filter(Boolean);
  for (const name of names.filter((name) => name.endsWith(".sql"))) assert.equal(read(name), git("show", `${base}:${name}`), `Existing migration history changed: ${name}`);
  if (names.includes("cloud/migrations/published.json")) {
    const previous = JSON.parse(git("show", `${base}:cloud/migrations/published.json`));
    const current = JSON.parse(read("cloud/migrations/published.json"));
    for (const [name, digest] of Object.entries(previous)) assert.equal(current[name], digest, `Published digest changed: ${name}`);
    for (const [name, digest] of Object.entries(current)) {
      if (!(name in previous)) assert.equal(digest, sha256(git("show", `${base}:cloud/migrations/${name}`)), "Only previously merged SQL may be recorded as published");
    }
  }
}
checkMigrationData(checkMigrations(root));
console.log("Delivery policy, immutable migrations and populated old-data check passed");
