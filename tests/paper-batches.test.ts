import assert from "node:assert/strict";
import test from "node:test";

import {
  PaperBatchError,
  PAPER_BATCH_PAGES,
  paperContentMode,
  parsePaperBatch,
  runPaperBatches,
} from "../shared/paper.js";

function pageResponse(pageNumbers: number[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    ...extra,
    pages: pageNumbers.map((pageNumber) => ({
      pageNumber,
      blocks: [{ id: `p${pageNumber}-b1`, type: "paragraph", original: `original ${pageNumber}`, translation: `译文 ${pageNumber}`, assetIds: [] }],
    })),
  });
}

test("paper content mode sends DeepSeek to page images and everything else to the PDF", () => {
  assert.equal(paperContentMode("https://api.deepseek.com/chat/completions"), "image");
  assert.equal(paperContentMode("https://api.openai.com/v1/chat/completions"), "pdf");
  assert.equal(paperContentMode("https://api.deepseek.com/beta/chat/completions"), "pdf");
});

test("a batch reply must match the requested page numbers exactly", () => {
  const accepted = parsePaperBatch(pageResponse([3, 4]), [3, 4], false);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.ok && accepted.pages.map((page) => page.pageNumber), [3, 4]);
  assert.equal(accepted.ok && accepted.pages[0]!.originalBlocks[0]!.translation, "译文 3");

  // Renumbering is the failure that matters: a page attached to the wrong
  // number puts another page's text beside the original.
  const renumbered = parsePaperBatch(pageResponse([1, 2]), [3, 4], false);
  assert.deepEqual(renumbered, { ok: false, reason: "pages" });
  assert.deepEqual(parsePaperBatch(pageResponse([3]), [3, 4], false), { ok: false, reason: "pages" });
  assert.deepEqual(parsePaperBatch("not json", [1], false), { ok: false, reason: "json" });
  assert.deepEqual(
    parsePaperBatch(JSON.stringify({ pages: [{ pageNumber: 1, blocks: [{ id: "a", type: "paragraph", original: "x", translation: "y", assetIds: [1] }] }] }), [1], false),
    { ok: false, reason: "blocks" },
  );
});

test("the first batch is the only one asked for the paper metadata", () => {
  const first = parsePaperBatch(pageResponse([1], { paper: { title: "论文标题", authors: ["甲", "乙"] } }), [1], true);
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.title, "论文标题");
  assert.equal(first.ok && first.authors, "甲, 乙");

  const later = parsePaperBatch(pageResponse([2], { paper: { title: "不该出现", authors: [] } }), [2], false);
  assert.equal(later.ok, true);
  assert.equal(later.ok && later.title, null);
});

test("a truncated batch is narrowed instead of failing the paper", async () => {
  const asked: string[] = [];
  const outcome = await runPaperBatches(
    [{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }, { pageNumber: 4 }],
    true,
    async (batch, first, last) => {
      asked.push(`${first}-${last}`);
      // Only the narrow ranges fit the response budget.
      return last - first > 1
        ? { output: "", finishReason: "length" }
        : { output: pageResponse([first]), finishReason: "stop" };
    },
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(asked, ["1-4", "1-2", "1-1", "2-2", "3-4", "3-3", "4-4"]);
  assert.deepEqual(outcome.ok && outcome.pages.map((page) => page.pageNumber), [1, 2, 3, 4]);
});

test("a batch reply that cannot be parsed is narrowed too, and a single dense page is reported", async () => {
  const outcome = await runPaperBatches(
    [{ pageNumber: 1 }, { pageNumber: 2 }],
    false,
    async (batch, first) => ({ output: batch.length > 1 ? "garbage" : pageResponse([first]), finishReason: "stop" }),
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ok && outcome.pages.map((page) => page.pageNumber), [1, 2]);

  const overflow = await runPaperBatches(
    [{ pageNumber: 7 }],
    false,
    async () => ({ output: "", finishReason: "length" }),
  );
  assert.deepEqual(overflow, { ok: false, code: "PAPER_PAGE_OVERFLOW", message: "第 7 页的内容超出单次回答上限，无法分页提取" });
});

test("a runtime failure keeps its own code and stops the batches", async () => {
  let calls = 0;
  const outcome = await runPaperBatches(
    [{ pageNumber: 1 }, { pageNumber: 2 }],
    false,
    async () => {
      calls += 1;
      throw new PaperBatchError("PAPER_MODEL_NO_VISION", "当前模型不接受图片输入");
    },
  );
  assert.deepEqual(outcome, { ok: false, code: "PAPER_MODEL_NO_VISION", message: "当前模型不接受图片输入" });
  assert.equal(calls, 1);
  assert.equal(PAPER_BATCH_PAGES, 4);
});
