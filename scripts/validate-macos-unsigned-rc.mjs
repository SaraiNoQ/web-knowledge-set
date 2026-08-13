import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const version = "0.9.2-rc.1";
const tag = `v${version}`;
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const tauri = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
const workflow = readFileSync(".github/workflows/macos-unsigned-rc.yml", "utf8");
const rcInfo = readFileSync("src-tauri/Info.rc.plist", "utf8");
const cargoVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1];

const fail = (message) => {
  throw new Error(message);
};

if ([packageJson.version, tauri.version, cargoVersion].some((value) => value !== version)) {
  fail(`Unsigned RC versions must all be ${version}`);
}
if (tauri.identifier !== "io.github.sarainoq.zhiye") fail("Unexpected bundle identifier");
if (tauri.bundle?.macOS?.minimumSystemVersion !== "13.5") fail("Unsigned RC must require macOS 13.5");
if (tauri.plugins?.updater || tauri.bundle?.createUpdaterArtifacts) {
  fail("The base configuration must not enable an update channel");
}
if (!workflow.includes(`tags: ["${tag}"]`) || !workflow.includes("workflow_dispatch:")) {
  fail("Unsigned RC workflow must accept only its exact tag plus manual rehearsal");
}
if (!workflow.includes("if: github.event_name == 'push' && github.ref == 'refs/tags/v0.9.2-rc.1'") ||
    !workflow.includes("gh release create") ||
    !workflow.includes("--draft --prerelease") ||
    !workflow.includes("--verify-tag")) {
  fail("Only the exact tag path may create a draft prerelease");
}
if (!workflow.includes("gh release download") ||
    !workflow.includes("cmp release-assets/SHA256SUMS downloaded-assets/SHA256SUMS") ||
    !workflow.includes("sha256sum -c SHA256SUMS")) {
  fail("Published assets must be downloaded and hash-verified before disclosure");
}
if (!workflow.includes("--draft=false --prerelease") || !workflow.includes("isDraft,isImmutable,isPrerelease")) {
  fail("Verified RC must be published only as a prerelease");
}
for (const required of [
  "pnpm verify",
  "cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings",
  "pnpm tauri build --ci --no-sign",
  '\"infoPlist\":\"Info.rc.plist\",\"bundleVersion\":\"90201\"',
  "scripts/macos-desktop-smoke.sh \"$VERIFIED_APP\" release",
  "scripts/macos-browser-security-smoke.mjs",
  "test \"$(uname -m)\" = arm64",
  "hdiutil attach -readonly -nobrowse",
  "codesign -dv --verbose=4",
  "BUNDLE_IDENTITY=$(codesign -dv --verbose=4 \"$VERIFIED_APP\"",
  "codesign --verify --strict --verbose=2 \"$DMG_PATH\"",
  "spctl --assess --type execute --verbose=2",
  "xcrun stapler validate",
  "source.cdx.json",
  "macos-app.cdx.json",
  "Zhiye_0.9.2-rc.1_aarch64_unsigned.dmg",
  "SHA256SUMS",
  "RELEASE_NOTES.md",
  "--latest=false",
  'repos/$GITHUB_REPOSITORY/commits/$GITHUB_REF_NAME',
  'repos/$GITHUB_REPOSITORY/commits/main',
  'repos/$GITHUB_REPOSITORY/immutable-releases',
  "isDraft,isImmutable,isPrerelease",
]) {
  if (!workflow.includes(required)) fail(`Unsigned RC workflow is missing: ${required}`);
}
if (workflow.split('repos/$GITHUB_REPOSITORY/commits/$GITHUB_REF_NAME').length !== 3 ||
    workflow.split('repos/$GITHUB_REPOSITORY/commits/main').length !== 3) {
  fail("Remote tag and main must be verified before both draft creation and public disclosure");
}
if (!readFileSync("docs/RELEASE_EVIDENCE.md", "utf8").includes("预先启用 immutable releases")) {
  fail("Release evidence must require repository immutable releases before tagging");
}
if (!rcInfo.includes("<key>CFBundleShortVersionString</key>") || !rcInfo.includes("<string>0.9.2</string>")) {
  fail("RC Info.plist must use Apple's numeric short version 0.9.2");
}
for (const forbidden of [
  "secrets.",
  "APPLE_CERTIFICATE",
  "APPLE_API_",
  "APPLE_SIGNING_IDENTITY",
  "TAURI_SIGNING_",
  "TAURI_UPDATER_",
  "ZHIYE_SIGN_RELEASE",
  "createUpdaterArtifacts",
  "notarytool",
  "macos-sign-nested.sh",
]) {
  if (workflow.includes(forbidden)) fail(`Unsigned RC workflow contains forbidden release material: ${forbidden}`);
}
if (workflow.split("\n").some((line) => line.includes("codesign") && /(?:^|\s)(?:--sign|-s)(?:\s|$)/.test(line))) {
  fail("Unsigned RC workflow must never sign code");
}

if (process.argv.includes("--self-check")) {
  console.log(`Unsigned macOS RC configuration self-check passed (${version})`);
  process.exit(0);
}

const event = process.env.GITHUB_EVENT_NAME ?? "";
const ref = process.env.GITHUB_REF ?? "";
const sha = process.env.GITHUB_SHA ?? "";
const approvedSha = process.env.APPROVED_SHA ?? "";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

if (process.env.GITHUB_REPOSITORY !== "SaraiNoQ/web-knowledge-set") fail("Not the canonical repository");
if (!/^[0-9a-f]{40}$/.test(sha) || git("rev-parse", "HEAD") !== sha) fail("Checkout does not match GITHUB_SHA");
if (git("rev-parse", "refs/remotes/origin/main") !== sha) fail("RC commit is not the current origin/main tip");
if (git("status", "--porcelain")) fail("RC checkout is dirty");

if (event === "workflow_dispatch") {
  if (ref !== "refs/heads/main" || approvedSha !== sha) fail("Manual rehearsal requires the current full main SHA");
} else if (event === "push") {
  if (ref !== `refs/tags/${tag}` || git("rev-parse", `refs/tags/${tag}^{commit}`) !== sha) {
    fail(`Release must be triggered by the immutable ${tag} tag`);
  }
} else {
  fail(`Unsupported event: ${event}`);
}

console.log(`Unsigned RC source gate passed for ${sha}`);
