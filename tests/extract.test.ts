import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { extractHtml } from "../server/extract.js";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("extracts article metadata and Markdown", async () => {
  const result = await extractHtml(await fixture("article.html"), "https://example.com/original");
  assert.equal(result.title, "本地知识库实践");
  assert.equal(result.author, "测试作者");
  assert.equal(result.canonicalUrl, "https://example.com/articles/local-knowledge");
  assert.match(result.markdown, /一个可靠的本地知识库/);
  assert.match(result.markdown, /```(?:js|javascript)/);
  assert.match(result.markdown, /\|\s*markdown\s*\|/);
  assert.doesNotMatch(result.markdown, /首页 文章 关于/);
});

test("does not retain executable script elements", async () => {
  const result = await extractHtml(await fixture("malicious.html"), "https://example.com/safe");
  assert.match(result.markdown, /useful article text/);
  assert.doesNotMatch(result.markdown, /globalThis\.pwned|<script/i);
});
