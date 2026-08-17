import assert from "node:assert/strict";
import test from "node:test";

import {
  cloudLlmCredentialHeaders,
  cloudLlmCredentialMatches,
  deleteCloudLlmCredential,
  loadCloudLlmCredential,
  saveCloudLlmCredential,
} from "../src/cloud-llm-credential.js";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

test("cloud AI credential survives reload, stays endpoint-bound, and deletes", () => {
  const siteStorage = storage();
  saveCloudLlmCredential(siteStorage, " test-key ", "https://API.DEEPSEEK.com:443/chat/completions");
  const restored = loadCloudLlmCredential(siteStorage);
  assert.deepEqual(restored, { apiKey: "test-key", endpointUrl: "https://api.deepseek.com/chat/completions" });
  assert.equal(cloudLlmCredentialMatches(restored, "https://api.deepseek.com/chat/completions"), true);
  assert.deepEqual(cloudLlmCredentialHeaders(restored, "https://api.deepseek.com/chat/completions"), { "X-Zhiye-LLM-Key": "test-key" });
  assert.equal(cloudLlmCredentialMatches(restored, "https://api.openai.com/v1/chat/completions"), false);
  assert.deepEqual(cloudLlmCredentialHeaders(restored, "https://api.openai.com/v1/chat/completions"), {});

  saveCloudLlmCredential(siteStorage, "new-key", "https://api.openai.com/v1/chat/completions");
  const replaced = loadCloudLlmCredential(siteStorage);
  assert.deepEqual(cloudLlmCredentialHeaders(replaced, "https://api.deepseek.com/chat/completions"), {});
  assert.deepEqual(cloudLlmCredentialHeaders(replaced, "https://api.openai.com/v1/chat/completions"), { "X-Zhiye-LLM-Key": "new-key" });
  deleteCloudLlmCredential(siteStorage);
  assert.equal(loadCloudLlmCredential(siteStorage), null);

  siteStorage.setItem("zhiye.cloud.llm-credential.v1", "not-json");
  assert.equal(loadCloudLlmCredential(siteStorage), null);
  assert.equal(siteStorage.length, 0);
  assert.throws(() => saveCloudLlmCredential(siteStorage, "line\nbreak", "https://api.deepseek.com/chat/completions"));
});
