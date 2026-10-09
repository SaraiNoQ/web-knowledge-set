import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordReleaseExit } from "../scripts/record-release-exit.mjs";
import { assertBindings, assertCurrentSource, checkBoundarySmoke, currentVersion, expectedBindings, pendingMigrations, publishPair, rollbackAllowed } from "../scripts/cloudflare-delivery.mjs";

test("uses newest single-version deployment regardless of API ordering", () => {
  const id = "a".repeat(8) + "-" + "b".repeat(4) + "-" + "c".repeat(4) + "-" + "d".repeat(4) + "-" + "e".repeat(12);
  assert.equal(currentVersion([{ created_on: "2026-02", versions: [{ version_id: id, percentage: 100 }] }, { created_on: "2026-01", versions: [] }]), id);
  assert.throws(() => currentVersion([{ created_on: "2026-02", versions: [{ version_id: id, percentage: 50 }] }]));
});
test("migration approval cannot bypass unknown or missing published migrations", () => {
  const migrations = [{ name: "old", policy: "published" }, { name: "add", policy: "compatible" }, { name: "remove", policy: "manual" }];
  assert.throws(() => pendingMigrations(migrations, ["old"], false));
  assert.equal(pendingMigrations(migrations, ["old"], true).length, 2);
  assert.throws(() => pendingMigrations(migrations, [], true));
  assert.throws(() => pendingMigrations(migrations, ["old", "unknown"], true));
});
test("stale source is rejected before production writes", () => {
  assertCurrentSource("a".repeat(40), "a".repeat(40));
  assert.throws(() => assertCurrentSource("a".repeat(40), "b".repeat(40)), /Stale/);
  assert.throws(() => assertCurrentSource("main", "a".repeat(40)));
});
test("binding identity matters, ordering does not", () => {
  assertBindings([{ name: "DB", type: "d1", database_id: "expected" }], [{ name: "DB", type: "d1", resource: "expected" }]);
  assert.throws(() => assertBindings([{ name: "DB", type: "d1", database_id: "other" }], [{ name: "DB", type: "d1", resource: "expected" }]));
  const config = JSON.parse(readFileSync(new URL('../cloud/wrangler.web.jsonc', import.meta.url)));
  // Captured from production `wrangler versions view --json`, not a generated mirror of the normalizer.
  assertBindings([
    { name: 'ASSETS', type: 'assets' },
    { bucket_name: 'zhiye-cloud-backups', name: 'BACKUPS', type: 'r2_bucket' },
    { name: 'BROWSER', type: 'browser', version: 2 },
    { name: 'CAPTURE_QUEUE', queue_name: 'zhiye-cloud-capture', type: 'queue' },
    { database_id: 'b3ac6ecc-dcf1-4bc7-a269-35c889b2ebe6', id: 'b3ac6ecc-dcf1-4bc7-a269-35c889b2ebe6', name: 'DB', type: 'd1' },
    { bucket_name: 'zhiye-cloud-images', name: 'IMAGES', type: 'r2_bucket' },
  ], expectedBindings(config));
});

function harness({ failClip = false, failSmoke = false, canRollback = true, failRecovery = false } = {}) {
  const live = { web: "old-web", clip: "old-clip" };
  const events = [];
  const options = {
    before: { ...live }, canRollback,
    version: (worker) => live[worker],
    deploy: (worker) => { live[worker] = `new-${worker}`; if (worker === "clip" && failClip) throw new Error("clip failed after upload"); },
    rollback: (worker, id) => { if (failRecovery) throw new Error("rollback failed"); live[worker] = id; },
    verify: () => { if (failSmoke) throw new Error("smoke failed"); },
    record: (record) => events.push(structuredClone(record)),
  };
  return { live, events, options };
}
test("successful pair is recorded only after verification", async () => {
  const h = harness();
  const result = await publishPair(h.options);
  assert.deepEqual(result.after, { web: "new-web", clip: "new-clip" });
  assert.equal(h.events.at(-1).recovery, "not-needed");
});
test("second Worker failure restores actual partial state, including uploaded-but-failed version", async () => {
  const h = harness({ failClip: true });
  await assert.rejects(publishPair(h.options), /previous-pair-restored/);
  assert.deepEqual(h.live, { web: "old-web", clip: "old-clip" });
  assert.equal(h.events.at(-1).error, "clip failed after upload");
});
test("migration failure never publishes or attempts a Worker rollback", async () => {
  const h = harness();
  h.options.migrate = () => { throw new Error("migration failed"); };
  h.options.rollback = () => { assert.fail("No Worker rollback after migration failure"); };
  await assert.rejects(publishPair(h.options), /migration failed/);
  assert.deepEqual(h.live, { web: "old-web", clip: "old-clip" });
  assert.equal(h.events.at(-1).status, "migration-failed");
});
test("smoke failure restores compatible pair; incompatible schema never auto-rolls back", async () => {
  const safe = harness({ failSmoke: true });
  await assert.rejects(publishPair(safe.options), /previous-pair-restored/);
  const unsafe = harness({ failClip: true, canRollback: false });
  await assert.rejects(publishPair(unsafe.options), /manual-required/);
  assert.equal(unsafe.live.web, "new-web");
});
test("failed rollback remains an explicit recovery failure", async () => {
  const h = harness({ failClip: true, failRecovery: true });
  await assert.rejects(publishPair(h.options), /manual-required.*rollback failed/);
  assert.equal(h.events.at(-1).recoveryError, "rollback failed");
});
test("manual-schema risk persists even when a retry has no pending migrations", async () => {
  assert(!rollbackAllowed([{ policy: "manual" }], null));
  assert(!rollbackAllowed([], { sha: "already-applied-manual" }));
  const retry = harness({ failClip: true, canRollback: rollbackAllowed([], { sha: "already-applied-manual" }) });
  await assert.rejects(publishPair(retry.options), /manual-required/);
  assert.equal(retry.live.web, "new-web");
});
test("early gate failures get evidence and existing recovery evidence is retained", () => {
  const temporary = mkdtempSync(join(tmpdir(), "zhiye-release-evidence-"));
  const directory = join(temporary, "a".repeat(40), "123", "1");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "evidence.json");
  try {
    recordReleaseExit(directory, "starting", null);
    recordReleaseExit(directory, "install", 1);
    assert.equal(JSON.parse(readFileSync(path)).status, "gate-failed");
    assert.equal(JSON.parse(readFileSync(path)).stage, "install");
    writeFileSync(path, JSON.stringify({ status: "failed", recovery: "previous-pair-restored" }));
    recordReleaseExit(directory, "publish", 1);
    assert.equal(JSON.parse(readFileSync(path)).recovery, "previous-pair-restored");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
test("boundary smoke does not claim authenticated business acceptance", async () => {
  let transientFailures = 2;
  const fake = async (url, options) => {
    if (url.endsWith("/health") && transientFailures > 0) { transientFailures--; throw new TypeError("fetch failed"); }
    return url.includes("zhiye.sarainoq.cn")
      ? new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } })
      : new Response("{}", { status: options.headers.Origin ? 401 : 403 });
  };
  const result = await checkBoundarySmoke(fake);
  assert.equal(transientFailures, 0);
  assert.equal(result.authenticatedBusinessAcceptance, "not-verified");
  await assert.rejects(checkBoundarySmoke(async () => { throw new TypeError("fetch failed"); }), /Access smoke failed for \/: fetch failed/u);
  await assert.rejects(checkBoundarySmoke(async () => new Response("public", { status: 200 })));
});
