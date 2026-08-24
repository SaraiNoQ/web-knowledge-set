import assert from "node:assert/strict";
import test from "node:test";

import { assetHashFromUri, markdownUrlTransform } from "../src/markdown-url.js";

test("Markdown preview preserves only valid Zhiye asset URLs", () => {
  const hash = "a".repeat(64);
  const asset = `zhiye://asset/${hash}`;

  assert.equal(markdownUrlTransform(asset), asset);
  assert.equal(assetHashFromUri(asset), hash);
  assert.equal(markdownUrlTransform("javascript:alert(1)"), "");
  assert.equal(markdownUrlTransform("zhiye://article/00000000-0000-0000-0000-000000000000"), "");
  assert.equal(markdownUrlTransform("https://example.com/image.png"), "https://example.com/image.png");
});
