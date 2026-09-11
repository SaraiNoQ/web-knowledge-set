import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../server/db.js";
import type { PaperBlock } from "../shared/types.js";

test("papers keep an immutable PDF source and revision-guarded translation pages", () => {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-paper-"));
  const database = openDatabase(directory);
  const pdf = Buffer.from("%PDF-1.7\nfixture\n", "ascii");
  const hash = createHash("sha256").update(pdf).digest("hex");
  const created = database.createPaper({ sourceKind: "pdf", sourceUrl: null, originalFileName: "fixture.pdf", hash, content: pdf });
  assert.equal(created.created, true);
  if (!created.created) throw new Error("paper fixture was unexpectedly deduplicated");
  assert.equal(created.paper.kind, "paper");
  assert.equal(created.paper.originalFileName, "fixture.pdf");

  const task = database.createPaperExtraction(created.paper.id);
  assert.equal(task.kind, "created");
  if (task.kind !== "created") throw new Error("paper extraction task was not created");
  const block: PaperBlock = { id: "p1-b1", type: "paragraph", original: "Original", translation: "译文", assetIds: [] };
  const completed = database.completePaperExtraction(task.task.id, [{ pageNumber: 1, originalBlocks: [block], translationBlocks: [{ ...block }] }], "测试论文", "测试作者");
  assert.equal(completed.kind, "completed");
  assert.equal(database.getPaper(created.paper.id)?.pages[0]?.translationBlocks[0]?.translation, "译文");

  const saved = database.updatePaperPage(created.paper.id, 1, 1, [{ ...block, translation: "修改后的译文" }]);
  assert.equal(saved.kind, "saved");
  assert.equal(database.updatePaperPage(created.paper.id, 1, 1, [{ ...block, translation: "过期修改" }]).kind, "conflict");
  assert.equal(database.getPaper(created.paper.id)?.pages[0]?.translationBlocks[0]?.translation, "修改后的译文");
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
