import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

  const failedTask = database.createPaperExtraction(created.paper.id);
  assert.equal(failedTask.kind, "created");
  if (failedTask.kind !== "created") throw new Error("paper failure fixture was not created");
  database.failPaperExtraction(failedTask.task.id, "PAPER_PDF_UNSUPPORTED", "当前模型不支持论文 PDF 输入");
  assert.deepEqual(
    { code: database.getPaper(created.paper.id)?.errorCode, message: database.getPaper(created.paper.id)?.errorMessage },
    { code: "PAPER_PDF_UNSUPPORTED", message: "当前模型不支持论文 PDF 输入" },
  );

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

test("permanently deleting a trashed paper removes its extraction and PDF file", () => {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-paper-delete-"));
  const database = openDatabase(directory);
  const pdf = Buffer.from("%PDF-1.7\ndelete fixture\n", "ascii");
  const hash = createHash("sha256").update(pdf).digest("hex");
  try {
    const created = database.createPaper({ sourceKind: "pdf", sourceUrl: null, originalFileName: "delete.pdf", hash, content: pdf });
    if (!created.created) throw new Error("paper fixture was unexpectedly deduplicated");
    const task = database.createPaperExtraction(created.paper.id);
    if (task.kind !== "created") throw new Error("paper extraction task was not created");
    const block: PaperBlock = { id: "p1-b1", type: "paragraph", original: "Original", translation: "译文", assetIds: [] };
    database.completePaperExtraction(task.task.id, [{ pageNumber: 1, originalBlocks: [block], translationBlocks: [{ ...block }] }]);
    const trashed = database.softDeleteDocument(created.paper.id, database.getDocument(created.paper.id)!.revision);
    assert.equal(trashed.kind, "deleted");
    if (trashed.kind !== "deleted") return;
    assert.equal(database.permanentlyDeleteDocument(created.paper.id, trashed.document.revision, null).kind, "deleted");
    assert.equal(database.getDocument(created.paper.id), null);
    assert.equal((database.sql.prepare("SELECT COUNT(*) AS count FROM papers WHERE id = ?").get(created.paper.id) as { count: number }).count, 0);
    assert.equal((database.sql.prepare("SELECT COUNT(*) AS count FROM paper_extractions WHERE paper_id = ?").get(created.paper.id) as { count: number }).count, 0);
    assert.equal((database.sql.prepare("SELECT COUNT(*) AS count FROM paper_pages WHERE paper_id = ?").get(created.paper.id) as { count: number }).count, 0);
    assert.equal((database.sql.prepare("SELECT COUNT(*) AS count FROM paper_files WHERE hash = ?").get(hash) as { count: number }).count, 0);
    assert.equal(database.sql.prepare("SELECT 1 FROM file_deletions WHERE path = ?").get(`assets/${hash}`), undefined);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared paper PDFs remain until the last paper is permanently deleted", () => {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-paper-shared-delete-"));
  const database = openDatabase(directory);
  const pdf = Buffer.from("%PDF-1.7\nshared fixture\n", "ascii");
  const hash = createHash("sha256").update(pdf).digest("hex");
  try {
    const first = database.createPaper({ sourceKind: "pdf", sourceUrl: null, originalFileName: "first.pdf", hash, content: pdf });
    const second = database.createPaper({ sourceKind: "pdf", sourceUrl: null, originalFileName: "second.pdf", hash, content: pdf });
    if (!first.created || !second.created) throw new Error("shared paper fixtures were unexpectedly deduplicated");
    const firstTrash = database.softDeleteDocument(first.paper.id, database.getDocument(first.paper.id)!.revision);
    assert.equal(firstTrash.kind, "deleted");
    if (firstTrash.kind !== "deleted") return;
    assert.equal(database.permanentlyDeleteDocument(first.paper.id, firstTrash.document.revision, null).kind, "deleted");
    assert.equal(existsSync(database.assetFilePath(hash)), true);
    assert.equal((database.sql.prepare("SELECT COUNT(*) AS count FROM paper_files WHERE hash = ?").get(hash) as { count: number }).count, 1);

    const secondTrash = database.softDeleteDocument(second.paper.id, database.getDocument(second.paper.id)!.revision);
    assert.equal(secondTrash.kind, "deleted");
    if (secondTrash.kind !== "deleted") return;
    assert.equal(database.permanentlyDeleteDocument(second.paper.id, secondTrash.document.revision, null).kind, "deleted");
    assert.equal(existsSync(database.assetFilePath(hash)), false);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
