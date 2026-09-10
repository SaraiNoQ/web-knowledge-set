import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGeneratedTitle, titleSource, TITLE_SOURCE_CHARS } from "../shared/title.js";

test("generated titles are accepted only as short single-line text", () => {
  assert.equal(normalizeGeneratedTitle("马斯克发布新模型"), "马斯克发布新模型");
  assert.equal(normalizeGeneratedTitle("  「新模型发布」  "), "新模型发布");
  assert.equal(normalizeGeneratedTitle("\"GPT-5 正式发布\""), "GPT-5 正式发布");
  assert.equal(normalizeGeneratedTitle("新模型发布。"), "新模型发布");
  assert.equal(normalizeGeneratedTitle("# 新模型发布"), "新模型发布");
  assert.equal(normalizeGeneratedTitle("新模型\n发布"), "新模型 发布");
  assert.equal(normalizeGeneratedTitle("新模型 发布！"), "新模型 发布");
  assert.equal(normalizeGeneratedTitle("一".repeat(20)), "一".repeat(20));
});

test("unusable title replies fall back instead of being written to a document", () => {
  assert.equal(normalizeGeneratedTitle("一".repeat(21)), null);
  assert.equal(normalizeGeneratedTitle(""), null);
  assert.equal(normalizeGeneratedTitle("   "), null);
  assert.equal(normalizeGeneratedTitle("。"), null);
  assert.equal(normalizeGeneratedTitle("这是一个解释：标题应该是这样的，但模型没有只返回标题"), null);
  assert.equal(normalizeGeneratedTitle(undefined), null);
  assert.equal(normalizeGeneratedTitle(null), null);
  assert.equal(normalizeGeneratedTitle(42), null);
});

test("title length is counted in code points rather than UTF-16 units", () => {
  assert.equal([..."😀".repeat(20)].length, 20);
  assert.equal(normalizeGeneratedTitle("😀".repeat(20)), "😀".repeat(20));
  assert.equal(normalizeGeneratedTitle("😀".repeat(21)), null);
});

test("title source keeps short documents intact and truncates long ones", () => {
  assert.equal(titleSource("  # 正文  "), "# 正文");
  const long = "文".repeat(TITLE_SOURCE_CHARS + 500);
  const sent = titleSource(long);
  assert.equal(sent.startsWith("文".repeat(TITLE_SOURCE_CHARS)), true);
  assert.match(sent, /the document continues/u);
  assert.equal(sent.includes("文".repeat(TITLE_SOURCE_CHARS + 1)), false);
});
