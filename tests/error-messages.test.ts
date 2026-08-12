import assert from "node:assert/strict";
import test from "node:test";

import { isAbortError, userErrorFrom, userErrorMessage } from "../src/error-messages.js";

test("stable and family error codes produce actionable Chinese", () => {
  assert.match(userErrorMessage("LLM_AUTH_FAILED"), /密钥/u);
  assert.match(userErrorMessage("BLOCKED_ADDRESS"), /阻止/u);
  assert.match(userErrorMessage("WIDGET_NOT_FOUND"), /不存在/u);
  assert.match(userErrorMessage("INVALID_FUTURE_FIELD"), /无效/u);
  assert.match(userErrorMessage("WIDGET_TOO_LARGE"), /超出/u);
});

test("unknown codes stay Chinese, retain safe diagnostics, and discard raw details", () => {
  const message = userErrorMessage("SOME_NEW_CODE", 418);
  assert.match(message, /操作未完成/u);
  assert.match(message, /SOME_NEW_CODE/u);
  assert.match(message, /HTTP 418/u);
  assert.equal(message.includes("upstream exploded"), false);
  assert.match(userErrorMessage("../../provider secret", 500), /UNKNOWN_ERROR/u);
});

test("native errors use a Chinese fallback while aborts remain distinguishable", () => {
  const fallback = "无法连接本地服务，请重试。";
  assert.equal(userErrorFrom(new TypeError("Failed to fetch provider secret"), fallback), fallback);
  assert.equal(userErrorFrom({ code: "LLM_TIMEOUT", message: "provider detail" }, fallback), userErrorMessage("LLM_TIMEOUT"));
  assert.equal(isAbortError(Object.assign(new Error("aborted"), { name: "AbortError" })), true);
  assert.equal(isAbortError(new Error("aborted")), false);
});
