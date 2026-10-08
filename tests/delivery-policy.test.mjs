import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ciPassed, checkMigrations, checkMigrationData, migrationPolicy, needsCloudRelease, needsDesktopCheck, validSha } from "../scripts/delivery-policy.mjs";

test("required CI rejects failures, cancellations and unexpected skips", () => {
  const passing = { policy: "success", linux: "success", desktop: "success" };
  assert(ciPassed(passing, true));
  for (const key of Object.keys(passing)) for (const status of ["failure", "cancelled", "skipped", ""]) assert(!ciPassed({ ...passing, [key]: status }, true));
  assert(ciPassed({ ...passing, desktop: "skipped" }, false));
  assert(!ciPassed(passing, false));
});
test("release checks include cumulative unknown/runtime changes but skip evidence", () => {
  assert(!needsCloudRelease(["docs/CLOUDFLARE.md", "CLAUDE.md"]));
  assert(needsCloudRelease(["docs/CLOUDFLARE.md", "src/App.tsx"]));
  assert(needsCloudRelease(["unknown-file"]));
  assert(needsDesktopCheck([".github/workflows/ci.yml"]));
  assert(!needsDesktopCheck(["docs/README.md", "cloud/worker.ts"]));
});
test("migration classification defaults closed and only accepts conservative additions", () => {
  assert.equal(migrationPolicy("-- deployment: compatible\nCREATE TABLE sample (id TEXT PRIMARY KEY); CREATE INDEX sample_id ON sample(id);"), "compatible");
  assert.equal(migrationPolicy("-- deployment: compatible\nALTER TABLE sample ADD COLUMN label TEXT;"), "compatible");
  assert.equal(migrationPolicy("-- deployment: manual\nDELETE FROM sample;"), "manual");
  for (const sql of ["CREATE TABLE a(id TEXT);", "-- deployment: compatible\nDROP TABLE sample;", "-- deployment: compatible\nCREATE TABLE a(id TEXT); DELETE FROM sample;", "-- deployment: compatible\nALTER TABLE sample ADD COLUMN x TEXT NOT NULL;"]) assert.throws(() => migrationPolicy(sql));
  assert.throws(() => migrationPolicy("-- deployment: compatible\nCREATE TABLE a(value TEXT DEFAULT '--'); DELETE FROM sample;"));
});
test("source SHA cannot be a moving ref or shell input", () => {
  assert(validSha("a".repeat(40)));
  for (const value of ["main", "a".repeat(39), "$(id)", undefined]) assert(!validSha(value));
});
test("sync refuses server parent directories before invoking rsync", () => {
  for (const directory of ["/", "/root", "/home", "/root/dev", "/root/dev/zhiye", "/srv/zhiye-delivery", "/srv/zhiye-delivery/runs", "/root/dev/zhiye-x/../other"]) {
    assert.notEqual(spawnSync("sh", ["scripts/sync-to-campus.sh", "root@example.test", directory]).status, 0, directory);
  }
});
test("compatible migration compares against data after preceding manual migrations", () => {
  const migrations = checkMigrations(resolve(import.meta.dirname, ".."));
  checkMigrationData([...migrations,
    { name: "manual", policy: "manual", sql: "UPDATE cloud_documents SET title='reviewed update'" },
    { name: "compatible", policy: "compatible", sql: "ALTER TABLE cloud_documents ADD COLUMN delivery_note TEXT" },
  ]);
  checkMigrationData([...migrations,
    { name: "manual-empty", policy: "manual", sql: "DELETE FROM cloud_documents" },
    { name: "compatible-empty", policy: "compatible", sql: "ALTER TABLE cloud_documents ADD COLUMN empty_note TEXT" },
  ]);
  assert.throws(() => checkMigrationData([...migrations, { name: "bad-compatible", policy: "compatible", sql: "DELETE FROM cloud_documents" }]));
});
