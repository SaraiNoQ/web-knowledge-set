import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaperDocument } from "../shared/types";
import { paperTranslationMarkdown } from "../src/paper-translation";

test("collects every saved translation in page order without original text", () => {
  const paper = { status: "ready", pageCount: 12, pages: Array.from({ length: 12 }, (_, i) => ({ pageNumber: i + 1, translationBlocks: [{ type: i === 0 ? "heading" : "paragraph", translation: `中文${i + 1}`, original: "English" }] })).reverse() } as PaperDocument;
  const markdown = paperTranslationMarkdown(paper);
  assert.equal((markdown.match(/^## 第 /gm) || []).length, 12);
  assert(markdown.indexOf("中文2") < markdown.indexOf("中文12"));
  assert(markdown.includes("### 中文1"));
  assert(!markdown.includes("English"));
  assert.throws(() => paperTranslationMarkdown({ ...paper, pages: paper.pages.slice(1) }), /尚不完整/);
  assert.throws(() => paperTranslationMarkdown({ ...paper, status: "extracting" }), /尚不完整/);
  assert.throws(() => paperTranslationMarkdown({ ...paper, pages: paper.pages.map((page) => ({ ...page, translationBlocks: [] })) }), /尚不完整/);
});
