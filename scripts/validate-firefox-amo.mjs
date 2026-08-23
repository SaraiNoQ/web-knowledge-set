import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "dist", "extensions");
const installPath = join(output, "zhiye-clipper-firefox.zip");
const sourcePath = join(output, "zhiye-clipper-firefox-source.zip");
const install = unzipSync(readFileSync(installPath));
const source = unzipSync(readFileSync(sourcePath));
const expected = ["content.js", "icon.png", "manifest.json", "popup.css", "popup.html", "popup.js"];
const requireEntries = (archive, names) => names.forEach((name) => { if (!archive[name]) throw new Error(`Missing ${name}`); });

if (JSON.stringify(Object.keys(install).sort()) !== JSON.stringify(expected)) throw new Error("Unexpected Firefox package contents");
const manifest = JSON.parse(strFromU8(install["manifest.json"]));
const gecko = manifest.browser_specific_settings?.gecko;
const geckoAndroid = manifest.browser_specific_settings?.gecko_android;
if (manifest.manifest_version !== 3 || gecko?.id !== "clipper@zhiye.sarainoq.cn" || gecko?.strict_min_version !== "140.0" || geckoAndroid?.strict_min_version !== "142.0") throw new Error("Invalid Firefox identity or compatibility");
if (JSON.stringify(gecko.data_collection_permissions?.required) !== JSON.stringify(["authenticationInfo", "browsingActivity", "websiteContent", "personalCommunications"])) throw new Error("Invalid Firefox data disclosure");
if (/<script[^>]+src=["']https?:/iu.test(strFromU8(install["popup.html"]))) throw new Error("Remote scripts are not allowed");
for (const name of ["content.js", "popup.js"]) if (/\beval\s*\(|\bnew\s+Function\b/u.test(strFromU8(install[name]))) throw new Error(`Dynamic code in ${name}`);
requireEntries(source, ["README.txt", ".node-version", "LICENSE", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.extension.json", "scripts/build-extension.mjs", "shared/rendered-math.ts", "extension/content.ts", "extension/popup.ts", "extension/manifest.firefox.json"]);
for (const path of [installPath, sourcePath]) if (statSync(path).size > 200 * 1024 * 1024) throw new Error(`${path} exceeds AMO's 200 MB limit`);
const lint = spawnSync("npm", ["exec", "--yes", "--package=web-ext@10.6.0", "--", "web-ext", "lint", "--source-dir", join(output, "zhiye-clipper-firefox"), "--output", "json"], { encoding: "utf8" });
if (lint.error || lint.status !== 0) throw lint.error ?? new Error(lint.stderr || "web-ext lint failed");
const report = JSON.parse(lint.stdout.trim().split("\n").at(-1));
if (report.summary?.errors !== 0 || report.summary?.notices !== 0 || report.summary?.warnings !== 3 || report.warnings?.some((warning) => warning.code !== "UNSAFE_VAR_ASSIGNMENT" || warning.file !== "content.js")) throw new Error("Unexpected web-ext lint result");
console.log(`Firefox AMO package validated: ${manifest.version}`);
