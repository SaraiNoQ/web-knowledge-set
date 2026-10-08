import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const validSha = (value) => /^[a-f0-9]{40}$/u.test(value ?? "");

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
  return paths.some((path) => !/^(?:docs\/|AGENTS\.md$|CLAUDE\.md$|README\.md$|e2e\/|tests\/|cloud\/migrations\/published\.json$|\.github\/pull_request_template\.md$)/u.test(path));
}

export function needsDesktopCheck(paths) {
  return paths.some((path) => /^(?:src\/|server\/|shared\/|src-tauri\/|scripts\/|\.github\/workflows\/|package\.json$|pnpm-|\.node-version$|rust-toolchain|vite\.config|tsconfig|index\.html$|public\/|licenses\/|THIRD_PARTY)/u.test(path));
}

export function ciPassed(results, desktopRequired) {
  return results.policy === "success" && results.linux === "success"
    && results.desktop === (desktopRequired ? "success" : "skipped");
}
