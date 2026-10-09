import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const validSha = (value) => /^[a-f0-9]{40}$/u.test(value ?? "");
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}

export function migrationPolicy(sql) {
  const policy = /^-- deployment: (compatible|manual)\r?$/mu.exec(sql)?.[1];
  if (!policy) throw new Error("New migration requires -- deployment: compatible or manual");
  if (policy === "compatible") {
    // ponytail: conservative additive subset; complex SQL uses explicit manual approval.
    const statements = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\/\*[\s\S]*?\*\/|--[^\n]*/gu,
      (token) => token.startsWith("--") || token.startsWith("/*") ? "" : token).split(";").map((s) => s.trim()).filter(Boolean);
    if (!statements.length || statements.some((s) => !/^CREATE (?:TABLE|INDEX)\s/iu.test(s)
      && !(/^ALTER TABLE \w+ ADD COLUMN \w+ (?:TEXT|INTEGER|REAL|BLOB)\s*$/iu.test(s)))) {
      throw new Error("Compatible migration must only add tables/indexes or nullable columns; use manual for other SQL");
    }
  }
  return policy;
}

export function checkMigrations(root) {
  const directory = join(root, "cloud/migrations");
  const published = JSON.parse(readFileSync(join(directory, "published.json"), "utf8"));
  for (const [name, digest] of Object.entries(published)) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/u.test(name) || !/^[a-f0-9]{64}$/u.test(digest)
      || sha256(readFileSync(join(directory, name))) !== digest) throw new Error(`Published migration changed: ${name}`);
  }
  const names = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  const last = Math.max(...Object.keys(published).map((name) => Number(name.slice(0, 4))));
  const ids = new Set();
  return names.map((name) => {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/u.test(name) || ids.has(name.slice(0, 4))) throw new Error(`Invalid/duplicate migration: ${name}`);
    ids.add(name.slice(0, 4));
    const sql = readFileSync(join(directory, name), "utf8");
    if (!published[name] && Number(name.slice(0, 4)) <= last) throw new Error(`Migration must append: ${name}`);
    return { name, sql, policy: published[name] ? "published" : migrationPolicy(sql) };
  });
}

export function checkMigrationData(migrations) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    for (const migration of migrations.filter((m) => m.policy === "published")) db.exec(migration.sql);
    db.prepare("INSERT INTO cloud_documents(id,source_url,title,markdown,status,source_note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("delivery-fixture", "https://example.com", "old title", "old content", "ready", "fixture", "2026-01-01", "2026-01-01");
    for (const migration of migrations.filter((m) => m.policy !== "published")) {
      const before = migration.policy === "compatible" ? {
        rows: db.prepare("SELECT * FROM cloud_documents ORDER BY id").all(),
        columns: db.prepare("PRAGMA table_info(cloud_documents)").all().map((c) => c.name),
      } : null;
      db.exec("BEGIN");
      try { db.exec(migration.sql); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
      if (before) {
        const after = db.prepare(`SELECT ${before.columns.map((c) => `"${c.replaceAll('"', '""')}"`).join(",")} FROM cloud_documents ORDER BY id`).all();
        assert.deepEqual(after, before.rows, `Old readers/data changed: ${migration.name}`);
      }
    }
  } finally { db.close(); }
}

export function needsCloudRelease(paths) {
  return paths.some((path) => !/^(?:docs\/|AGENTS\.md$|CLAUDE\.md$|README(?:\.en)?\.md$|e2e\/|tests\/|cloud\/migrations\/published\.json$|\.github\/pull_request_template\.md$|\.github\/workflows\/(?:ci|cloudflare-deploy|macos[^/]*|deepseek-acceptance)\.yml$|scripts\/(?:delivery-policy|check-delivery|check-workflows|validate-change|cloudflare-delivery|server-release|record-release-exit|run-server-e2e|sync-to-campus)\.(?:mjs|sh)$)/u.test(path));
}

export function needsDesktopCheck(paths) {
  return paths.some((path) => /^(?:src-tauri\/(?:src\/|Cargo\.(?:toml|lock)$|tauri\.conf\.json$|capabilities\/|build\.rs$|entitlements[^/]*\.plist$)|rust-toolchain)/u.test(path));
}

export function ciPassed(results, desktopRequired, runtimeRequired = true) {
  return results.policy === "success" && results.linux === (runtimeRequired ? "success" : "skipped")
    && results.desktop === (desktopRequired ? "success" : "skipped");
}

export function validationPlan(paths, full = false) {
  const policyOnly = /^(?:docs\/|(?:AGENTS|CLAUDE|README(?:\.en)?)\.md$|\.gitignore$|\.github\/|scripts\/(?:delivery-policy|check-delivery|check-workflows|cloudflare-delivery|server-release|record-release-exit|run-server-e2e|sync-to-campus|validate-change)\.(?:mjs|sh)$|tests\/(?:delivery-policy|cloudflare-delivery)\.test\.mjs$|cloud\/migrations\/published\.json$|extension\/amo\/signed-release\.json$)/u;
  const code = paths.filter((path) => !policyOnly.test(path));
  const ui = code.some((path) => /^(?:src\/|public\/|index\.html$)/u.test(path));
  const cloud = code.some((path) => /^(?:cloud\/|shared\/)/u.test(path));
  const extension = code.some((path) => /^(?:extension\/|shared\/rendered-math\.ts$|scripts\/(?:build-extension|validate-firefox-amo)\.mjs$)/u.test(path));
  const dependencies = code.some((path) => /^(?:package\.json$|pnpm-|\.node-version$)/u.test(path));
  const nodeTests = new Set(code.filter((path) => /^tests\/[^/]+\.test\.(?:ts|mjs)$/u.test(path)));
  const unknown = code.some((path) => !/^(?:src\/|server\/|shared\/|cloud\/|extension\/|src-tauri\/|e2e\/|tests\/|public\/|package\.json$|pnpm-|\.node-version$|rust-toolchain|index\.html$)/u.test(path));
  for (const path of code.filter((path) => /^(?:src|server|shared)\/.*\.ts$/u.test(path))) {
    const candidate = `tests/${path.split("/").at(-1).replace(/\.ts$/u, ".test.ts")}`;
    if (existsSync(candidate)) nodeTests.add(candidate);
    else if (path.startsWith("server/")) nodeTests.add("tests/api.test.ts");
  }
  for (const path of code.filter((path) => /^cloud\/.*\.ts$/u.test(path))) {
    const candidate = `tests/cloud-${path.split("/").at(-1).replace(/\.ts$/u, ".test.ts")}`;
    if (existsSync(candidate)) nodeTests.add(candidate);
  }
  if (code.some((path) => /^server\/(?:browser|capture|safe-proxy)\.ts$/u.test(path))) {
    nodeTests.add("tests/browser-options.test.ts");
    nodeTests.add("tests/capture.test.ts");
  }
  if (cloud) nodeTests.add("tests/cloud-api.test.ts");
  if (extension) nodeTests.add("tests/extension.test.ts");
  const e2eTests = [...new Set(code.filter((path) => /^e2e\/[^/]+\.spec\.ts$/u.test(path)))];
  if (ui && !e2eTests.length) e2eTests.push("e2e/markdown-layout.spec.ts");
  const typeProjects = new Set();
  if (full || dependencies || unknown) typeProjects.add("all");
  else for (const path of code.filter((p) => /\.tsx?$/u.test(p))) {
    if (path.startsWith("src/")) typeProjects.add("tsconfig.json");
    else if (path.startsWith("server/")) typeProjects.add("tsconfig.server.json");
    else if (path.startsWith("cloud/")) typeProjects.add("tsconfig.cloud.json");
    else if (path.startsWith("extension/")) typeProjects.add("tsconfig.extension.json");
    else if (path.startsWith("tests/")) typeProjects.add("tsconfig.test.json");
    else typeProjects.add("all");
  }
  return { full, runtime: full || code.length > 0, desktop: full || needsDesktopCheck(paths),
    typecheck: typeProjects.size > 0, typeProjects: [...typeProjects],
    build: full || ui || cloud || extension || dependencies || unknown || e2eTests.length > 0 || needsDesktopCheck(paths),
    nodeTests: [...nodeTests].sort(), e2eTests, cloud: full || cloud, extension: full || extension,
    audit: full || dependencies, notices: full || dependencies };
}

export function desktopReleaseVersion({ version, cargo, tauri, info, lock }, tag) {
  assert(/^\d+\.\d+\.\d+$/u.test(version), "Stable desktop version required");
  const versions = [cargo.match(/^version\s*=\s*"([^"]+)"/mu)?.[1], tauri.version,
    info.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u)?.[1],
    lock.match(/\[\[package\]\]\s+name = "zhiye"\s+version = "([^"]+)"/u)?.[1]];
  assert(versions.every((value) => value === version), "Package/Cargo/Tauri/Info.plist/Cargo.lock versions must match");
  if (tag) assert.equal(tag, `v${version}`, "Release tag differs from source version");
  const [major, minor, patch] = version.split(".").map(Number);
  // ponytail: existing base-100 bundle numbering; revise when minor/patch reaches 100.
  assert(minor < 100 && patch < 100 && Number.isSafeInteger(major * 10_000 + minor * 100 + patch), "Revise bundle numbering before minor/patch reaches 100");
  return { version, bundleVersion: String(major * 10_000 + minor * 100 + patch) };
}
