import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const tauri = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
const workflow = readFileSync(".github/workflows/macos-release.yml", "utf8");
const updateCapability = JSON.parse(readFileSync("src-tauri/capabilities/updates.json", "utf8"));
const cargoVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1];
const versions = [packageJson.version, tauri.version, cargoVersion];

if (new Set(versions).size !== 1) throw new Error(`Release versions differ: ${versions.join(", ")}`);
if (tauri.bundle?.macOS?.minimumSystemVersion !== "13.5") {
  throw new Error("macOS minimumSystemVersion must match bundled Node 24 support (13.5)");
}
if (tauri.bundle?.macOS?.entitlements !== "entitlements.chromium.plist") {
  throw new Error("Tauri must preserve the Node V8 JIT entitlement while re-signing externalBin");
}
if (workflow.includes("tauri-action")) throw new Error("The release must use the locked Tauri CLI directly");
if (workflow.slice(0, workflow.indexOf("    steps:")).includes("secrets.")) {
  throw new Error("Release secrets must be scoped to the steps that consume them");
}
if (!workflow.includes("'\u007b\"build\":\u007b\"beforeBuildCommand\":\"\"\u007d\u007d'")) {
  throw new Error("The release build must not overwrite the pre-signed desktop runtime");
}
if (!workflow.includes('ZHIYE_SIGN_RELEASE: "1"')) throw new Error("Nested release signing is not enabled");
if (tauri.plugins?.updater || tauri.bundle?.createUpdaterArtifacts) {
  throw new Error("Updater credentials and endpoints must only enter the temporary release config");
}
if (JSON.stringify(updateCapability.permissions) !== JSON.stringify([
  "updater:allow-check",
  "updater:allow-download-and-install",
  "allow-restart-after-update",
])) throw new Error("Updater capability must expose only the approved update and safe restart commands");
for (const required of [
  "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
  "TAURI_UPDATER_ENDPOINT: ${{ vars.TAURI_UPDATER_ENDPOINT }}",
  "TAURI_UPDATER_PUBKEY: ${{ vars.TAURI_UPDATER_PUBKEY }}",
  "createUpdaterArtifacts:true",
  '"darwin-aarch64":{signature,url}',
  "release-assets/latest.json",
  "--example verify_updater",
  "verified-updater",
]) {
  if (!workflow.includes(required)) throw new Error(`Missing signed updater release step: ${required}`);
}
if (!workflow.includes('ditto "$APP" verified-artifact/Zhiye.app')) {
  throw new Error("Release verification must use the app shipped inside the DMG");
}
if (workflow.split("\n").some((line) => line.includes("codesign") && line.includes("--deep") && /(?:^|\s)(?:--sign|-s)(?:\s|$)/.test(line))) {
  throw new Error("codesign --deep must never be used for signing");
}

if (process.argv.includes("--self-check")) {
  console.log(`macOS release configuration self-check passed (${versions[0]})`);
  process.exit(0);
}

const tag = process.env.GITHUB_REF_NAME ?? "";
const sha = process.env.GITHUB_SHA ?? "";
const approvedSha = process.env.APPROVED_RC_SHA ?? "";
if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
  throw new Error(`Only stable vMAJOR.MINOR.PATCH tags may release: ${tag}`);
}
if (!/^[0-9a-f]{40}$/.test(sha) || approvedSha !== sha) {
  throw new Error("macos-production APPROVED_RC_SHA must exactly approve this release commit");
}
if (tag.slice(1) !== versions[0]) throw new Error(`Tag ${tag} does not match application version ${versions[0]}`);
if (tauri.identifier === "dev.local.zhiye" || !/^[a-z0-9]+(?:[.-][a-z0-9]+){2,}$/.test(tauri.identifier)) {
  throw new Error(`A confirmed production reverse-DNS identifier is required: ${tauri.identifier}`);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (process.env.GITHUB_REPOSITORY !== "SaraiNoQ/web-knowledge-set") throw new Error("Not the canonical repository");
if (git("rev-parse", `refs/tags/${tag}^{commit}`) !== sha) throw new Error("Tag does not resolve to GITHUB_SHA");
if (git("rev-parse", "refs/remotes/origin/main") !== sha) throw new Error("Release commit is not the current origin/main tip");
if (git("status", "--porcelain")) throw new Error("Release checkout is dirty");
console.log(`Release gate passed for ${tag} at ${sha}`);
