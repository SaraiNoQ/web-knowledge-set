import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseHTML } from "linkedom";

import { extractHtml } from "../server/extract.js";
import { protectRenderedMath, restoreProtectedMath } from "../shared/rendered-math.js";

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
  assert.ok(result.markdown.includes("$\\pi(a \\mid o, l)$"));
  assert.ok(result.markdown.includes("$$\n观察 o_t \\to 策略 \\pi \\to 动作 a_t \\to 环境 \\to o_{t+1}\n$$"));
  assert.doesNotMatch(result.markdown, /visual (?:inline|display) duplicate/);
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

test("protects exact alternate math source without colliding with page attributes", () => {
  const { document } = parseHTML(`<!doctype html><body>
    <a href="https://example.com/ZHIYERENDEREDMATHTOKEN0X">existing token</a>
    <span class="katex"><math><semantics><annotation encoding="application/x-tex">  \\pi(x)  </annotation></semantics></math></span>
    <div class="MathJax_Display"><math display="block" alttext="  x + y  "></math></div>
  </body>`);
  const values = protectRenderedMath(document as unknown as Document);
  assert.equal(values.length, 2);
  assert.notEqual(values[0].token, "ZHIYERENDEREDMATHTOKEN0X");
  assert.equal(restoreProtectedMath(`${values[0].token}|${values[1].token}`, values), "$  \\pi(x)  $|\n\n$$\n  x + y  \n$$\n\n");
});

test("leaves delimiter-breaking math safe and ignores detached duplicate annotations", () => {
  const { document } = parseHTML(`<!doctype html><body>
    <span class="katex"><math><semantics>
      <annotation encoding="application/x-tex">x + y</annotation>
      <annotation encoding="application/x-tex">duplicate</annotation>
    </semantics></math></span>
    <span class="katex"><math><annotation encoding="application/x-tex">x $ ![outside](https://example.com/pixel.png)</annotation></math></span>
  </body>`);
  const values = protectRenderedMath(document as unknown as Document);
  assert.equal(values.length, 1);
  const unsafe = [...document.querySelectorAll("annotation")].find((annotation) => annotation.textContent?.includes("outside"));
  assert.ok(unsafe && document.documentElement.contains(unsafe));
});
