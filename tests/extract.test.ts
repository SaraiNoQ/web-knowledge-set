import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { extractHtml } from "../server/extract.js";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("extracts an English article with GFM and editable math source", async () => {
  const result = await extractHtml(await fixture("article.html"), "https://example.com/original");
  assert.equal(result.title, "Building a Local-First Knowledge Base");
  assert.equal(result.author, "Ada Example");
  assert.equal(result.canonicalUrl, "https://example.com/articles/local-knowledge");
  assert.match(result.markdown, /A reliable local knowledge base/);
  assert.match(result.markdown, /~~A cloud-only archive~~/);
  assert.match(result.markdown, /\|\s*Field\s*\|\s*Purpose\s*\|/);
  assert.match(result.markdown, /\$E = mc\^2\$/);
  assert.ok(result.markdown.includes("$$\\\\sum\\_{i=1}^{n} i = n(n+1)/2$$"));
  assert.match(result.markdown, /```(?:js|javascript)/);
  assert.doesNotMatch(result.markdown, /Home Articles About/);
});

test("handles malformed HTML without retaining executable scripts", async () => {
  const result = await extractHtml(await fixture("malicious.html"), "https://example.com/safe");
  assert.match(result.markdown, /useful article text/);
  assert.match(result.markdown, /Malformed section/);
  assert.match(result.markdown, /markup remains readable/);
  assert.match(result.markdown, /Trailing article content remains/);
  assert.doesNotMatch(result.markdown, /globalThis\.pwned|<script/i);
});
