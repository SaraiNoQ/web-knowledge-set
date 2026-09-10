import assert from "node:assert/strict";
import test from "node:test";

import { browserLaunchOptions } from "../server/browser.js";

test("browser launch options keep the sandbox on for a non-root process", () => {
  const options = browserLaunchOptions("http://127.0.0.1:4321", false);
  assert.equal(options.chromiumSandbox, true);
  assert.ok(!options.args.includes("--no-sandbox"));
});

test("browser launch options disable the sandbox when running as root", () => {
  const options = browserLaunchOptions("http://127.0.0.1:4321", true);
  assert.equal(options.chromiumSandbox, false);
  assert.ok(options.args.includes("--no-sandbox"));
});
