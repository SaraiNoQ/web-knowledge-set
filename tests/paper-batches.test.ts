import assert from "node:assert/strict";
import test from "node:test";

import {
  PaperBatchError,
  PAPER_BATCH_PAGES,
  paperBatchReasonMessage,
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

test("a batch reply is accepted when its page numbers match, whatever shape they arrive in", () => {
  const block = [{ id: "p9-b1", type: "paragraph", original: "o", translation: "t", assetIds: [] }];

  // A one-image request can come back as a bare page rather than a pages array.
  const bare = parsePaperBatch(JSON.stringify({ pageNumber: 9, blocks: block }), [9], false);
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.ok && bare.pages.map((page) => page.pageNumber), [9]);

  // Pages keyed by number, and a page number sent as a string.
  const keyed = parsePaperBatch(JSON.stringify({ pages: { "9": { pageNumber: "9", blocks: block } } }), [9], false);
  assert.equal(keyed.ok, true);
  assert.deepEqual(keyed.ok && keyed.pages.map((page) => page.pageNumber), [9]);

  // Arriving out of order is not a content problem: the pages are placed by the
  // number they carry.
  const shuffled = parsePaperBatch(JSON.stringify({ pages: [{ pageNumber: 11, blocks: block }, { pageNumber: 10, blocks: block }] }), [10, 11], false);
  assert.equal(shuffled.ok, true);
  assert.deepEqual(shuffled.ok && shuffled.pages.map((page) => page.pageNumber), [10, 11]);
});

test("an image with nothing transcribable keeps its page instead of failing the paper", () => {
  // A full-page figure or a blank page can legitimately produce no pages.
  const empty = parsePaperBatch(JSON.stringify({ pages: [] }), [7], false);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.ok && empty.pages, [{ pageNumber: 7, originalBlocks: [] }]);

  // For a wider range an empty reply is still a mismatch: it says nothing about
  // which of the requested pages it covered.
  assert.deepEqual(parsePaperBatch(JSON.stringify({ pages: [] }), [7, 8], false), { ok: false, reason: "pages" });
  assert.deepEqual(parsePaperBatch(JSON.stringify({ paper: { title: "x" } }), [7], false), { ok: false, reason: "pages" });
});

test("a rejected batch reports what the model actually returned", () => {
  const message = paperBatchReasonMessage("pages", JSON.stringify({ pages: [{ pageNumber: "seven", blocks: [] }] }));
  assert.match(message, /页码与请求不一致/u);
  assert.match(message, /模型返回：\{"pages":\[\{"pageNumber":"seven","blocks":\[\]\}\]\}/u);
  // Without a reply there is nothing to append.
  assert.equal(paperBatchReasonMessage("blocks"), "论文模型返回的内容块无效");
  // A long reply is bounded so an error message stays readable.
  const long = paperBatchReasonMessage("json", "x".repeat(500));
  assert.ok(long.length < 400, `message was ${long.length} characters`);
  assert.match(long, /…）/u);
});
