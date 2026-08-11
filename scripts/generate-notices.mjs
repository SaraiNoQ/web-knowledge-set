import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "THIRD_PARTY_NOTICES.md");
const licensesPath = resolve(root, "THIRD_PARTY_LICENSES.txt");
const check = process.argv.includes("--check");
const pnpm = process.env.npm_execpath
  ? [process.execPath, process.env.npm_execpath]
  : ["pnpm"];

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw result.error || new Error(result.stderr || `${command} failed`);
  return JSON.parse(result.stdout);
}

function license(value, name) {
  if (!value || /unknown|unlicensed|see license/i.test(value)) {
    throw new Error(`Unknown license for ${name}`);
  }
  return value;
}

const cell = (value) => String(value).replace(/\s+/g, " ").replaceAll("|", "\\|");

function texts(directory) {
  return readdirSync(directory)
    .filter((name) => /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(name))
    .flatMap((name) => {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return [];
      const text = readFileSync(path, "utf8").trim();
      return text && !text.includes("\0") ? [text] : [];
    });
}

const licenseTexts = new Map();
const missingTexts = [];
function collectText(item, text) {
  const hash = createHash("sha256").update(text).digest("hex");
  const entry = licenseTexts.get(hash) ?? { hash, text, packages: new Set() };
  entry.packages.add(`${item.name}@${item.version}`);
  licenseTexts.set(hash, entry);
}
function collectTexts(item, directory) {
  const found = texts(directory);
  if (found.length === 0) missingTexts.push(item);
  found.forEach((text) => collectText(item, text));
}

const jsGroups = run(pnpm[0], [...pnpm.slice(1), "licenses", "list", "--prod", "--long", "--json"]);
const javascript = Object.values(jsGroups)
  .flat()
  .flatMap((item) => item.paths.map((path) => {
    const manifest = JSON.parse(readFileSync(resolve(path, "package.json"), "utf8"));
    const dependency = {
      name: item.name,
      version: manifest.version,
      license: license(item.license, item.name),
      attribution: typeof item.author === "string" ? item.author : "—",
      source: item.homepage || `https://www.npmjs.com/package/${item.name}`,
    };
    collectTexts(dependency, path);
    return dependency;
  }))
  .filter((item, index, items) => index === items.findIndex((other) => other.name === item.name && other.version === item.version))
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"));

const rustupCargo = join(homedir(), ".cargo", "bin", "cargo");
const cargo = run(process.env.CARGO || (existsSync(rustupCargo) ? rustupCargo : "cargo"), [
  "metadata",
  "--locked",
  "--format-version",
  "1",
  "--filter-platform",
  "aarch64-apple-darwin",
], resolve(root, "src-tauri"));
const rust = cargo.packages
  .filter((item) => item.source)
  .map((item) => {
    const dependency = {
      name: item.name,
      version: item.version,
      license: license(item.license, item.name),
      attribution: item.authors.join(", ") || "—",
      source: item.repository || `https://crates.io/crates/${item.name}`,
    };
    collectTexts(dependency, dirname(item.manifest_path));
    return dependency;
  })
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"));

const donor = {
  "alloc-stdlib@0.2.4": ["alloc-no-stdlib@2.0.4"],
  "defmt-parser@1.0.0": ["defmt@1.1.1"],
  "selectors@0.36.1": ["cssparser@0.36.0"],
  "tauri-plugin@2.6.3": ["tauri-build@2.6.3"],
};
const override = new Map([
  [["block2@0.6.2", "dispatch2@0.3.1", "objc2@0.6.4", "objc2-app-kit@0.3.2", "objc2-core-foundation@0.3.2", "objc2-core-graphics@0.3.2", "objc2-encode@4.1.0", "objc2-exception-helper@0.1.1", "objc2-foundation@0.3.2", "objc2-io-surface@0.3.2", "objc2-web-kit@0.3.2"], "objc2-LICENSE.md"],
  [["sigchld@0.2.4"], "sigchld-LICENSE-MIT.txt"],
  [["selectors@0.36.1"], "selectors-NOTICE-MPL-2.0.txt"],
  [["unic-char-property@0.9.0", "unic-char-range@0.9.0", "unic-common@0.9.0", "unic-ucd-ident@0.9.0", "unic-ucd-version@0.9.0"], "rust-unic-NOTICE.txt"],
].flatMap(([packages, file]) => packages.map((name) => [name, file])));
const overrideHashes = {
  "objc2-LICENSE.md": "d2acb74dfbf5e6a9f80a7431925da31f4ea29e59d4b6dedec5cb39acc48e435a",
  "rust-unic-NOTICE.txt": "ad68113eef6907387d6095debdd4b1a12a38bbc3533b65e434d501a996f6336d",
  "selectors-NOTICE-MPL-2.0.txt": "c80bb752cdf998c673781daf9830e1e96f641ae6b43c886daa68de63c59b945f",
  "sigchld-LICENSE-MIT.txt": "f427674c31022b54bb6aaa28135efa4f026fd08d63c318411e0380be942e51ce",
};
for (const item of missingTexts) {
  const name = `${item.name}@${item.version}`;
  if (donor[name]) {
    const entries = [...licenseTexts.values()].filter((entry) => donor[name].some((source) => entry.packages.has(source)));
    if (entries.length === 0) throw new Error(`Missing license donor for ${name}`);
    entries.forEach((entry) => entry.packages.add(name));
  }
  if (override.has(name)) {
    const file = override.get(name);
    const text = readFileSync(resolve(root, "licenses", "overrides", file), "utf8").trim();
    if (createHash("sha256").update(`${text}\n`).digest("hex") !== overrideHashes[file]) {
      throw new Error(`License override changed: ${file}`);
    }
    collectText(item, text);
  }
}
const uncovered = missingTexts.filter((item) => {
  const name = `${item.name}@${item.version}`;
  return !donor[name] && !override.has(name);
});
if (uncovered.length > 0) {
  throw new Error(`Missing license text for ${uncovered.map((item) => `${item.name}@${item.version}`).join(", ")}`);
}

const table = (items) => items
  .map((item) => `| ${cell(item.name)} | ${cell(item.version)} | ${cell(item.license)} | ${cell(item.attribution)} | ${cell(item.source)} |`)
  .join("\n");
const output = `# Third-Party Notices

This inventory is generated from the locked production dependency metadata. Bundled package and browser directories retain their upstream license files.

## Bundled runtimes

| Component | Version | License | Source |
| --- | --- | --- | --- |
| Node.js | 24.19.0 | MIT | https://nodejs.org/ |
| Chromium headless shell | Playwright 1.62.1 revision | BSD-3-Clause and component licenses | https://www.chromium.org/ |

## JavaScript production dependencies

| Package | Version | License | Attribution | Source |
| --- | --- | --- | --- | --- |
${table(javascript)}

## Rust dependencies

| Crate | Version | License | Attribution | Source |
| --- | --- | --- | --- | --- |
${table(rust)}
`;
const licenses = `Third-Party License and Notice Texts

This file is generated from the license, copying, and notice files shipped with the locked dependencies. Identical texts are stored once.

${[...licenseTexts.values()]
  .sort((a, b) => a.hash.localeCompare(b.hash, "en"))
  .map((entry) => `${"=".repeat(80)}
SHA-256: ${entry.hash}
Provided by: ${[...entry.packages].sort((a, b) => a.localeCompare(b, "en")).join(", ")}
${"-".repeat(80)}
${entry.text}`)
  .join("\n\n")}
`;

if (check) {
  if (readFileSync(outputPath, "utf8") !== output) throw new Error("THIRD_PARTY_NOTICES.md is stale");
  if (readFileSync(licensesPath, "utf8") !== licenses) throw new Error("THIRD_PARTY_LICENSES.txt is stale");
} else {
  writeFileSync(outputPath, output);
  writeFileSync(licensesPath, licenses);
}
