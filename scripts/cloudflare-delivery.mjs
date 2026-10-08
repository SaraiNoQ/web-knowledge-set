import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMigrations, validSha, writeJsonAtomic } from "./delivery-policy.mjs";

const workers = ["web", "clip"];
export function currentVersion(deployments) {
  const current = [...deployments].sort((a, b) => a.created_on.localeCompare(b.created_on)).at(-1);
  assert(current?.versions?.length === 1 && current.versions[0].percentage === 100, "Refuse unknown/split production deployment");
  const id = current.versions[0].version_id;
  assert(/^[a-f0-9-]{36}$/u.test(id), "Invalid Worker version");
  return id;
}
export function assertCurrentSource(expected, actual) {
  assert(validSha(expected) && validSha(actual), "Invalid release/main SHA");
  assert.equal(actual, expected, "Stale release: main advanced");
}

export function expectedBindings(config) {
  return [
    ...config.d1_databases.map((b) => ({ name: b.binding, type: "d1", resource: b.database_id })),
    ...config.r2_buckets.map((b) => ({ name: b.binding, type: "r2_bucket", resource: b.bucket_name })),
    ...(config.assets ? [{ name: config.assets.binding, type: "assets", resource: "" }] : []),
    ...(config.browser ? [{ name: config.browser.binding, type: "browser", resource: "" }] : []),
    ...(config.queues?.producers ?? []).map((b) => ({ name: b.binding, type: "queue", resource: b.queue })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}
export function assertBindings(actual, expected) {
  const normalized = actual.map((b) => ({ name: b.name, type: b.type,
    resource: b.database_id ?? b.bucket_name ?? b.queue_name ?? "" })).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(normalized, expected, "Production bindings differ from reviewed config");
}

export function pendingMigrations(migrations, applied, approvedManual) {
  assert(applied.every((name) => migrations.some((m) => m.name === name)), "Production has migrations absent from this source");
  const pending = migrations.filter((m) => !applied.includes(m.name));
  assert(!pending.some((m) => m.policy === "published"), "Previously published migration missing from production; reconcile explicitly");
  assert(approvedManual || !pending.some((m) => m.policy === "manual"), "Manual migration requires protected approval for this SHA");
  return pending;
}
export const rollbackAllowed = (pending, schemaRisk) => !schemaRisk && !pending.some((m) => m.policy === "manual");

export async function publishPair({ before, migrate, deploy, rollback, version, verify, record, canRollback }) {
  const evidence = { before, after: {}, recovery: "not-needed" };
  if (migrate) {
    record({ ...evidence, status: "applying-migrations" });
    try { await migrate(); }
    catch (error) {
      record({ ...evidence, status: "migration-failed", error: error.message, recovery: "manual-required" });
      throw error;
    }
  }
  try {
    for (const worker of workers) {
      record({ ...evidence, publishing: worker });
      await deploy(worker);
      evidence.after[worker] = await version(worker);
      assert.notEqual(evidence.after[worker], before[worker], "Deploy did not create a new Worker version");
    }
    await verify(evidence.after);
    record(evidence);
    return evidence;
  } catch (error) {
    evidence.error = error.message;
    evidence.recovery = "manual-required";
    if (canRollback) {
      try {
        // Read actual state even when deploy failed after publishing its version.
        for (const worker of workers) {
          if (await version(worker) !== before[worker]) await rollback(worker, before[worker]);
        }
        for (const worker of workers) assert.equal(await version(worker), before[worker], "Previous Worker pair was not restored");
        evidence.recovery = "previous-pair-restored";
      } catch (recoveryError) { evidence.recoveryError = recoveryError.message; }
    }
    record(evidence);
    throw new Error(`${evidence.error}; recovery: ${evidence.recovery}${evidence.recoveryError ? ` (${evidence.recoveryError})` : ""}`);
  }
}

export async function checkBoundarySmoke(fetcher = fetch) {
  const evidence = [];
  const get = async (url, options = {}) => {
    let failure;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await fetcher(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(20_000) }); }
      catch (error) { failure = error; }
    }
    throw failure;
  };
  for (const path of ["/", "/api/documents", "/health", "/health", "/extensions/zhiye-clipper-firefox.xpi"]) {
    const response = await get(`https://zhiye.sarainoq.cn${path}`);
    const location = response.headers.get("location");
    assert(response.status === 302 && location && new URL(location).hostname.endsWith(".cloudflareaccess.com"), `Access boundary changed: ${path} (${response.status})`);
    evidence.push({ path, status: response.status });
  }
  const url = "https://clip.sarainoq.cn/api/browser-extension/clips";
  for (const [headers, expected] of [[{}, 403], [{ Origin: "moz-extension://00000000-0000-4000-8000-000000000000" }, 401]]) {
    const response = await get(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, expected, "Extension origin/token boundary changed");
    evidence.push({ path: "/api/browser-extension/clips", status: response.status });
  }
  return { boundaries: evidence, authenticatedBusinessAcceptance: "not-verified" };
}

async function main() {
  const [operation, requestPath] = process.argv.slice(2);
  assert(["plan", "publish"].includes(operation), "Use plan or publish with private request file");
  const root = resolve(import.meta.dirname, "..");
  const runDirectory = dirname(root);
  assert(/^\/srv\/zhiye-delivery\/runs\/[a-f0-9]{40}\/\d+\/\d+$/u.test(runDirectory), "Production must run in an isolated non-root mirror");
  assert(process.getuid() !== 0, "Do not deploy as root");
  assert.equal(resolve(requestPath), resolve(runDirectory, "request.json"));
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  assert(validSha(request.sha) && root.includes(`/${request.sha}/`), "Invalid source SHA/mirror");
  const statePath = "/srv/zhiye-delivery/state/last-success.json";
  const riskPath = "/srv/zhiye-delivery/state/schema-risk.json";
  const schemaRisk = existsSync(riskPath) ? JSON.parse(readFileSync(riskPath, "utf8")) : null;
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  assert.equal(state?.sha ?? null, request.previousSha, "Deployment baseline advanced; prepare a fresh run");
  assert(state || request.bootstrap === true, "Automatic deployment has not been bootstrapped");
  assert(request.githubToken && request.cloudflareToken, "Missing production credentials");
  const configs = Object.fromEntries(workers.map((worker) => [worker, JSON.parse(readFileSync(resolve(root, `cloud/wrangler.${worker}.jsonc`), "utf8"))]));
  const account = configs.web.account_id;
  assert(/^[a-f0-9]{32}$/u.test(account) && configs.clip.account_id === account, "Mismatched production accounts");
  const wrangler = (...args) => execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: root, encoding: "utf8", timeout: 600_000,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: request.cloudflareToken, CLOUDFLARE_ACCOUNT_ID: account, CI: "true" },
    maxBuffer: 16 * 1024 * 1024,
  });
  const cf = async (path, options = {}) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...options,
      headers: { Authorization: `Bearer ${request.cloudflareToken}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000) });
    const body = await response.json();
    assert(response.ok && body.success, `Cloudflare API ${response.status}: ${JSON.stringify(body.errors)}`);
    return body.result;
  };
  const assertLatest = async () => {
    const response = await fetch("https://api.github.com/repos/SaraiNoQ/web-knowledge-set/git/ref/heads/main", {
      headers: { Authorization: `Bearer ${request.githubToken}`, "X-GitHub-Api-Version": "2022-11-28" }, signal: AbortSignal.timeout(30_000) });
    assert(response.ok, `Cannot confirm main: ${response.status}`);
    assertCurrentSource(request.sha, (await response.json()).object.sha);
  };
  const version = (worker) => currentVersion(JSON.parse(wrangler("deployments", "list", "--config", `cloud/wrangler.${worker}.jsonc`, "--json")));
  const bindings = (worker, id) => JSON.parse(wrangler("versions", "view", id, "--config", `cloud/wrangler.${worker}.jsonc`, "--json")).resources.bindings;
  const migrations = checkMigrations(root);
  const appliedResult = await cf(`/accounts/${account}/d1/database/${configs.web.d1_databases[0].database_id}/query`, {
    method: "POST", body: JSON.stringify({ sql: "SELECT name FROM d1_migrations ORDER BY name", params: [] }),
  });
  const pending = pendingMigrations(migrations, appliedResult[0].results.map((row) => row.name), request.approvedManual === true);
  assert(!schemaRisk || request.approvedManual === true, "Unreleased manual-schema risk requires protected approval for this SHA");
  await assertLatest();
  const before = Object.fromEntries(workers.map((worker) => [worker, version(worker)]));
  if (state) assert.deepEqual(before, state.versions, "Production drifted from last successful release; reconcile explicitly");
  else assert.deepEqual(before, request.bootstrapVersions, "Production changed since bootstrap preparation");
  for (const worker of workers) assertBindings(bindings(worker, before[worker]), expectedBindings(configs[worker]));
  const evidencePath = resolve(runDirectory, "evidence.json");
  const save = (extra) => writeJsonAtomic(evidencePath, { sha: request.sha, run: request.run,
    previousSha: request.previousSha, migrations: pending.map((m) => ({ name: m.name, policy: m.policy })),
    authenticatedBusinessAcceptance: "not-verified", ...extra });
  save({ status: "prepared", before });
  if (operation === "plan") return;
  await assertLatest();
  let smoke;
  const result = await publishPair({ before, version,
    migrate: async () => {
      // Wrangler tracks applied migration names and applies each remaining file once.
      if (pending.some((m) => m.policy === "manual")) writeJsonAtomic(riskPath, {
        sha: request.sha, previousSha: request.previousSha, migrations: pending.filter((m) => m.policy === "manual").map((m) => m.name),
      });
      if (pending.length) console.log(wrangler("d1", "migrations", "apply", "zhiye-cloud", "--remote", "--config", "cloud/wrangler.web.jsonc"));
      await assertLatest();
    },
    deploy: (worker) => console.log(wrangler("deploy", "--config", `cloud/wrangler.${worker}.jsonc`, "--tag", request.sha, "--message", `GitHub ${request.run}`)),
    rollback: (worker, id) => console.log(wrangler("rollback", id, "--config", `cloud/wrangler.${worker}.jsonc`, "--message", `Restore before ${request.run}`)),
    canRollback: rollbackAllowed(pending, schemaRisk),
    verify: async (after) => {
      for (const worker of workers) assertBindings(bindings(worker, after[worker]), expectedBindings(configs[worker]));
      smoke = await checkBoundarySmoke();
    },
    record: (record) => save({ status: record.error ? "failed" : "publishing", ...record }),
  });
  save({ status: "success", ...result, smoke });
  writeJsonAtomic(statePath, { sha: request.sha, versions: result.after, run: request.run });
  rmSync(riskPath, { force: true });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
