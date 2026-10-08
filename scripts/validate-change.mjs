import { execFileSync } from "node:child_process";
import { validationPlan } from "./delivery-policy.mjs";

// CI passes a plan derived from the exact changed paths; server callers may pass paths directly.
if (!process.env.VALIDATION_PLAN && !process.env.VALIDATION_PATHS_JSON && process.env.FULL_VALIDATION !== "true") throw new Error("Pass a validation plan/changed paths, or explicitly request FULL_VALIDATION=true");
const plan = process.env.VALIDATION_PLAN ? JSON.parse(process.env.VALIDATION_PLAN)
  : validationPlan(JSON.parse(process.env.VALIDATION_PATHS_JSON ?? "[]"), process.env.FULL_VALIDATION === "true");
console.log(`Validation: ${plan.full ? "full release" : "targeted"}; ${JSON.stringify(plan)}`);
const pnpm = (...args) => execFileSync("pnpm", args, { stdio: "inherit" });
if (!plan.runtime) process.exit(0);
if (plan.audit) pnpm("audit", "--registry=https://registry.npmjs.org", "--audit-level", "high");
if (plan.typeProjects.includes("all")) pnpm("check");
else for (const project of plan.typeProjects) pnpm("exec", "tsc", "--noEmit", "-p", project);
if (plan.full || plan.e2eTests.length || plan.nodeTests.includes("tests/capture.test.ts")) {
  const firefox = plan.full || plan.e2eTests.some((path) => /firefox|extension-popup|extension-x-article/u.test(path));
  pnpm("exec", "playwright", "install", ...(process.env.GITHUB_ACTIONS === "true" ? ["--with-deps"] : []), "chromium", ...(firefox ? ["firefox"] : []), "--only-shell");
}
if (plan.full) pnpm("test");
else if (plan.nodeTests.length) pnpm("exec", "tsx", "--test", ...plan.nodeTests);
if (plan.build) pnpm("build");
if (plan.cloud) pnpm("cloud:bundle");
if (plan.notices) pnpm("notices:check");
if (plan.extension) pnpm("firefox:amo");
if (plan.full || plan.e2eTests.length) {
  const selected = plan.full ? [] : plan.e2eTests;
  if (process.env.GITHUB_ACTIONS === "true") pnpm("exec", "playwright", "test", ...selected);
  else execFileSync("bash", ["scripts/run-server-e2e.sh", ...selected], { stdio: "inherit" });
}
