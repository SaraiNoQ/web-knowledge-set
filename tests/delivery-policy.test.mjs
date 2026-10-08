import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ciPassed, checkMigrations, checkMigrationData, migrationPolicy, needsCloudRelease, needsDesktopCheck, validSha, validationPlan } from "../scripts/delivery-policy.mjs";

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
  assert(!needsDesktopCheck([".github/workflows/ci.yml", "src/App.tsx", "src/ui-system.css", "src-tauri/icons/zhiye.svg"]));
  assert(needsDesktopCheck(["src-tauri/src/lib.rs"]));
  assert(!needsDesktopCheck(["docs/README.md", "cloud/worker.ts"]));
});
test("documentation/workflow edits skip product jobs without weakening required checks", () => {
  const plan = validationPlan(["AGENTS.md", "CLAUDE.md", "docs/DEVELOPMENT_WORKFLOW.md", ".github/workflows/ci.yml", "scripts/validate-change.mjs"]);
  assert(!plan.runtime && !plan.desktop && !plan.build);
  assert(ciPassed({ policy: "success", linux: "skipped", desktop: "skipped" }, false, false));
  assert(!ciPassed({ policy: "failure", linux: "skipped", desktop: "skipped" }, false, false));
});
test("small CSS fix runs bounded UI regression without full unrelated suites", () => {
  const plan = validationPlan(["src/ui-system.css"]);
  assert(plan.runtime && plan.build);
  assert(!plan.full && !plan.typecheck && !plan.desktop && !plan.cloud && !plan.extension && !plan.audit);
  assert.deepEqual(plan.nodeTests, []);
  assert.deepEqual(plan.e2eTests, ["e2e/markdown-layout.spec.ts"]);
});
test("small TypeScript/service/cloud changes select their affected checks", () => {
  const ui = validationPlan(["src/App.tsx"]);
  assert(ui.typecheck && !ui.desktop && !ui.full);
  assert.deepEqual(ui.typeProjects, ["tsconfig.json"]);
  const service = validationPlan(["server/title.ts"]);
  assert.deepEqual(service.nodeTests, ["tests/title.test.ts"]);
  assert(!service.cloud && !service.extension && !service.full);
  const cloud = validationPlan(["cloud/worker.ts"]);
  assert(cloud.cloud && cloud.build && !cloud.desktop && !cloud.full);
  assert.deepEqual(cloud.nodeTests, ["tests/cloud-api.test.ts"]);
});
test("complete validation is explicitly opt-in", () => {
  const release = validationPlan(["docs/README.md"], true);
  for (const key of ["full", "runtime", "desktop", "typecheck", "build", "cloud", "extension", "audit", "notices"]) assert(release[key]);
  assert(!validationPlan(["src/App.tsx", "server/app.ts", "cloud/worker.ts", "extension/popup.ts"]).full);
  assert(validationPlan(["unclassified-build-input.js"]).build);
});
test("test-only browser PR builds its required artifacts without widening suites", () => {
  const plan = validationPlan(["e2e/markdown-layout.spec.ts"]);
  assert(plan.build && !plan.full && !plan.desktop && !plan.cloud && !plan.extension);
  assert.deepEqual(plan.e2eTests, ["e2e/markdown-layout.spec.ts"]);
});
test("cloud module and extension validator edits run the actual affected checks", () => {
  const cloud = validationPlan(["cloud/assets.ts"]);
  assert.deepEqual(cloud.nodeTests, ["tests/cloud-api.test.ts", "tests/cloud-assets.test.ts"]);
  const extension = validationPlan(["scripts/validate-firefox-amo.mjs"]);
  assert(extension.extension && !extension.full && !extension.desktop);
  const browser = validationPlan(["server/browser.ts"]);
  assert(browser.nodeTests.includes("tests/capture.test.ts"));
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
