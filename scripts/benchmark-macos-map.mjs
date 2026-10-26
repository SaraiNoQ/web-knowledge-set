// Mac acceptance uses a temporary Tauri build and synthetic data. It never opens the installed library.
// Usage: Node24 benchmark-macos-map.mjs --dependencies <existing node_modules> --three <existing three package> [--output <directory>]
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { arch, cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.equal(process.platform, "darwin", "Run acceptance on the target Mac");
assert.equal(process.versions.node, "24.19.0", "Reuse Node 24.19.0 (the installed app bundles it)");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2), option = (key, fallback = "") => { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1]; };
const dependencies = resolve(option("--dependencies")), three = resolve(option("--three"));
assert(existsSync(join(dependencies, "vite/package.json")) && existsSync(join(three, "package.json")), "Pass existing locked dependency caches; this runner never installs packages");
assert.equal(JSON.parse(readFileSync(join(three, "package.json"))).version, "0.186.1");
const root = option("--prepared") ? resolve(option("--prepared")) : mkdtempSync("/private/tmp/zhiye-mac-map-");
assert(root.startsWith("/private/tmp/zhiye-mac-map-"));
const source = join(root, "source"), output = resolve(option("--output", join(root, "results"))), engines = option("--engines", "tauri,chromium,firefox").split(",");
mkdirSync(output, { recursive: true });
const run = (command, argv, options = {}) => execFileSync(command, argv, { cwd: root, stdio: "inherit", ...options });
const text = (command, argv) => execFileSync(command, argv, { cwd: repo, encoding: "utf8" }).trim();
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sourcePaths = ["src/components/KnowledgeMap.tsx", "src/components/KnowledgeMap3D.tsx", "src/graph-layout-3d.ts", "src/semantic-graph-worker.ts", "shared/semantic-graph.ts", "src-tauri/Cargo.lock"];
const report = { startedAt: new Date().toISOString(), sourceSha: text("git", ["rev-parse", "HEAD"]), sourceFiles: Object.fromEntries(sourcePaths.map((path) => [path, hash(join(repo, path))])), hardware: { cpu: cpus()[0].model, memoryBytes: totalmem(), arch: arch(), macOS: text("sw_vers", ["-productVersion"]), build: text("sw_vers", ["-buildVersion"]) }, node: process.version, methodology: { documents: [1000, 10000], dimensions: 1024, folders: 20, toggleCycles: 30, interactionInput: "synthetic DOM pointer/wheel events; trusted canvas picking requires separate browser regression", memory: "RSS of native host, sidecar and newly launched WebKit processes; no forced GC", nativeChanges: "temporary data-directory/keychain/bundle identifiers only; production renderer source unchanged", thresholds: { nominal60HzFps: 59.5, frameP95Ms: 33, detailP95Ms: 100, postWarmupRssGrowthMiB: 32, postWarmupRssSlopeMiBPerCycle: 1 } }, engines: {} };

if (!option("--prepared")) {
  mkdirSync(source);
  for (const name of ["src", "shared", "server", "src-tauri", "public", "scripts"]) cpSync(join(repo, name), join(source, name), { recursive: true, filter: (path) => !/\/(?:target|binaries|node_modules)(?:\/|$)/u.test(path) });
  for (const entry of readdirSync(repo, { withFileTypes: true })) if (entry.isFile() && (/\.(?:json|ts|html|yaml)$/u.test(entry.name) || ["LICENSE", "THIRD_PARTY_LICENSES.txt"].includes(entry.name))) copyFileSync(join(repo, entry.name), join(source, entry.name));
  mkdirSync(join(source, "node_modules"));
  for (const name of readdirSync(dependencies)) if (![".bin", ".pnpm", "three"].includes(name) && existsSync(join(dependencies, name))) symlinkSync(join(dependencies, name), join(source, "node_modules", name));
  symlinkSync(three, join(source, "node_modules/three"));
  if (!existsSync(join(source, "node_modules/d3-force-3d"))) symlinkSync(join(dependencies, ".pnpm/d3-force-3d@3.0.6/node_modules/d3-force-3d"), join(source, "node_modules/d3-force-3d"));
  run(process.execPath, [join(dependencies, "typescript/bin/tsc"), "-p", join(source, "tsconfig.server.json")]);
  run(process.execPath, [join(dependencies, "vite/bin/vite.js"), "build", source]);
  const confPath = join(source, "src-tauri/tauri.conf.json"), conf = JSON.parse(readFileSync(confPath));
  conf.identifier = `io.github.sarainoq.zhiye-map-performance-${Date.now()}`; conf.productName = "织页性能验收"; conf.build.beforeBuildCommand = ""; conf.build.beforeDevCommand = "";
  writeFileSync(confPath, JSON.stringify(conf));
  const launcher = join(source, "src-tauri/src/launcher.rs");
  writeFileSync(launcher, readFileSync(launcher, "utf8").replaceAll("dev.local.zhiye", conf.identifier + ".legacy").replace("pub fn data_directory(app: &AppHandle, default: PathBuf) -> Result<PathBuf, String> {", `pub fn data_directory(app: &AppHandle, default: PathBuf) -> Result<PathBuf, String> {\n return Ok(PathBuf::from(${JSON.stringify(join(root, "data"))}));\n #[allow(unreachable_code)]`));
  const keychain = join(source, "src-tauri/src/keychain.rs");
  writeFileSync(keychain, readFileSync(keychain, "utf8").replaceAll("io.github.sarainoq.zhiye.llm", conf.identifier + ".llm").replaceAll("dev.local.zhiye.llm", conf.identifier + ".legacy.llm"));
  mkdirSync(join(source, "src-tauri/binaries"), { recursive: true });
  copyFileSync(process.execPath, join(source, `src-tauri/binaries/node-${arch() === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`));
  mkdirSync(join(source, "desktop-resources"));
  symlinkSync("/Applications/织页.app/Contents/Resources/runtime", join(source, "desktop-resources/runtime"));
  run("cargo", ["build", "--release", "--offline", "--locked", "--manifest-path", join(source, "src-tauri/Cargo.toml"), "--target-dir", join(root, "target")]);
}
const conf = JSON.parse(readFileSync(join(source, "src-tauri/tauri.conf.json")));
assert(conf.identifier.includes("zhiye-map-performance"));
const inputs = [];
const collect = (directory) => { for (const entry of readdirSync(join(source, directory), { withFileTypes: true })) { const path = `${directory}/${entry.name}`; if (entry.isDirectory()) collect(path); else if (entry.isFile()) inputs.push(path); } };
for (const directory of ["src", "shared", "server"]) collect(directory);
report.builtInputDigest = createHash("sha256").update(inputs.sort().map((path) => `${path}:${hash(join(source, path))}`).join("\n")).digest("hex");
report.productionAssetHashes = Object.fromEntries(readdirSync(join(source, "dist/assets")).filter((name) => /\.(?:js|css)$/u.test(name)).sort().map((name) => [name, hash(join(source, "dist/assets", name))]));
report.nativeConfiguration = { identifier: conf.identifier, dataDirectory: join(root, "data"), temporaryLauncherHash: hash(join(source, "src-tauri/src/launcher.rs")), temporaryKeychainHash: hash(join(source, "src-tauri/src/keychain.rs")) };
const launcherText = readFileSync(join(source, "src-tauri/src/launcher.rs"), "utf8"), keychainText = readFileSync(join(source, "src-tauri/src/keychain.rs"), "utf8");
assert(launcherText.includes(JSON.stringify(join(root, "data"))), "Native launcher must force the temporary data directory");
assert(!keychainText.includes('"io.github.sarainoq.zhiye.llm"') && !keychainText.includes('"dev.local.zhiye.llm"'), "Never read personal keychain services");
const page = join(source, "dist/index.html");
const waves = Number(option("--waves", "1")); assert([0, 1, 2, 3].includes(waves));
const instrumentation = `<script src="/map-performance-browser.js?dwell=${Number(option("--dwell-ms", "250"))}&waves=${waves}"></script>`;
writeFileSync(page, readFileSync(page, "utf8").replace(/<script src="\/map-performance-browser\.js[^"\n]*"><\/script>/u, "").replace("<head>", `<head>\n${instrumentation}`));
copyFileSync(join(repo, "scripts/map-performance-browser.js"), join(source, "dist/map-performance-browser.js"));
const app = join(root, "织页性能验收.app"), contents = join(app, "Contents"), macos = join(contents, "MacOS");
mkdirSync(macos, { recursive: true }); mkdirSync(join(contents, "Resources/runtime/dist-server/server"), { recursive: true });
copyFileSync(join(root, "target/release/zhiye"), join(macos, "zhiye")); copyFileSync(process.execPath, join(macos, "node"));
const plist = { CFBundleIdentifier: conf.identifier, CFBundleName: "织页性能验收", CFBundleDisplayName: "织页性能验收", CFBundleExecutable: "zhiye", CFBundlePackageType: "APPL", CFBundleVersion: "1", CFBundleShortVersionString: "1.0.9", NSHighResolutionCapable: true, LSMinimumSystemVersion: "13.5" };
const plistPath = join(contents, "Info.plist"); writeFileSync(plistPath, JSON.stringify(plist)); run("plutil", ["-convert", "xml1", plistPath]);
writeFileSync(join(contents, "Resources/runtime/package.json"), '{"type":"module"}');
writeFileSync(join(contents, "Resources/runtime/dist-server/server/index.js"), `await import(${JSON.stringify(pathToFileURL(join(repo, "scripts/map-performance-server.mjs")).href)});\n`);
for (const name of ["dist", "node_modules"]) if (!existsSync(join(contents, "Resources/runtime", name))) symlinkSync(join(source, name), join(contents, "Resources/runtime", name));
run("codesign", ["--force", "--sign", "-", join(macos, "zhiye")]);
const processRows = () => text("ps", ["-A", "-o", "pid=,comm="]).split("\n");
const initialWebkit = () => processRows().filter((line) => line.includes("com.apple.WebKit.")).map((line) => Number(line.trim().split(/\s+/u)[0]));
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const waitFile = async (path, milliseconds = 240000) => { const begin = Date.now(); while (!existsSync(path)) { if (Date.now() - begin > milliseconds) throw new Error(`Timed out waiting for ${path}`); await delay(250); } return readFileSync(path, "utf8"); };

for (const engine of engines) {
  assert(["tauri", "chromium", "firefox"].includes(engine));
  for (const extension of ["events.jsonl", "finished.json", "url.txt"]) rmSync(join(root, `${engine}-${extension}`), { force: true });
  const log = openSync(join(root, `${engine}-run.log`), "w"), env = { ...process.env, ZHIYE_MAP_BENCH_ROOT: root, ZHIYE_MAP_BENCH_INITIAL_WEBKIT: JSON.stringify(initialWebkit()), ZHIYE_MAP_BENCH_ENGINE: engine, KB_DATA_DIR: join(root, "data") };
  const child = engine === "tauri" ? spawn(join(macos, "zhiye"), [], { env, stdio: ["ignore", log, log], detached: true }) : spawn(process.execPath, [join(repo, "scripts/map-performance-server.mjs")], { env, stdio: ["ignore", log, log], detached: true });
  closeSync(log); let browser;
  try {
    const launch = await waitFile(join(root, `${engine}-url.txt`), 30000);
    if (engine !== "tauri") {
      const playwright = await import(pathToFileURL(join(dependencies, "playwright/index.mjs")));
      const executable = option(`--${engine}`, engine === "chromium" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "");
      browser = await playwright[engine].launch({ headless: false, ...(executable ? { executablePath: executable } : {}) });
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      const tab = await context.newPage();
      if (engine === "firefox" && executable.includes("Nightly.app/")) run("osascript", ["-e", `tell application ${JSON.stringify(executable.slice(0, executable.indexOf(".app/") + 4))} to activate`]);
      await tab.bringToFront(); await tab.goto(launch);
    }
    const finished = JSON.parse(await waitFile(join(root, `${engine}-finished.json`)));
    assert.equal(finished.stage, "complete", finished.error || "Benchmark did not complete");
    const events = readFileSync(join(root, `${engine}-events.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const loaded = events.find((event) => event.stage === "loaded" && event.count === 1000), interaction = events.find((event) => event.stage === "interactions"), allToggles = events.filter((event) => event.stage === "toggle" && event.phase === "2D"), toggles = allToggles.filter((event) => event.wave === 1), large = events.find((event) => event.stage === "large-library"), probe = events.find((event) => event.stage === "plugin-isolation");
    const warm = toggles.slice(5), first = warm.slice(0, 5).map((event) => event.memory.totalRssKiB).toSorted((a, b) => a - b)[2], last = warm.slice(-5).map((event) => event.memory.totalRssKiB).toSorted((a, b) => a - b)[2];
    const xMean = warm.reduce((sum, event) => sum + event.cycle, 0) / warm.length, yMean = warm.reduce((sum, event) => sum + event.memory.totalRssKiB, 0) / warm.length;
    const slope = warm.reduce((sum, event) => sum + (event.cycle - xMean) * (event.memory.totalRssKiB - yMean), 0) / warm.reduce((sum, event) => sum + (event.cycle - xMean) ** 2, 0);
    const memory = waves ? { samples: toggles, postWarmupGrowthMiB: (last - first) / 1024, postWarmupSlopeMiBPerCycle: slope / 1024 } : null;
    report.engines[engine] = { loaded, interaction, large, memory, pluginIsolation: probe, cooldown: events.filter((event) => event.stage === "cooldown"), allToggleSamples: allToggles, checks: { actualTauri: engine !== "tauri" || loaded.tauri, thousandNodes: loaded.nodes3D >= 1000, nominal60Hz: interaction.interactions.every((result) => result.fps >= 59.5), frameP95: interaction.interactions.every((result) => result.p95Ms <= 33), dragging: interaction.interactions.some((result) => result.kind === "drag" && result.nodeMoved && result.cameraStable && result.nodes >= 1000), detailP95: interaction.detail.p95Ms <= 100, thirtyCyclesReleased: waves ? allToggles.length === 30 * waves && allToggles.every((event) => event.buffers === 0 && event.contextsCreated === event.contextsReleased) : "not-run", memoryStable: waves ? (last - first) / 1024 <= 32 && slope / 1024 <= 1 : "not-run", largeAggregated: large.aggregateNodes <= 21 && large.listRows === 50 && large.localNodes <= 1000, pluginIsolation: Boolean(probe?.probe) && Object.values(probe.probe.blocked).every(Boolean) && probe.probe.dom.every((value) => value === "undefined") && probe.probe.native === "undefined" && probe.probe.remoteImport === "blocked" && !probe.probe.evaluate } };
    copyFileSync(join(root, `${engine}-events.jsonl`), join(output, `${engine}-events.jsonl`));
  } catch (error) { report.engines[engine] = { error: error.stack || error.message }; }
  finally { await browser?.close(); try { process.kill(-child.pid, "SIGTERM"); } catch {} }
  writeFileSync(join(output, "mac-map-acceptance.json"), JSON.stringify(report, null, 2));
}
report.completedAt = new Date().toISOString(); writeFileSync(join(output, "mac-map-acceptance.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, engines: Object.fromEntries(Object.entries(report.engines).map(([engine, value]) => [engine, value.checks || value.error])) }, null, 2));
if (Object.values(report.engines).some((value) => value.error || Object.values(value.checks).some((passed) => passed === false))) process.exitCode = 1;
