import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";
import type { PaperBlock, PaperExtractionTask } from "../shared/types.js";

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

  const failedTask = database.createPaperExtraction(created.paper.id, "pdf", null);
  assert.equal(failedTask.kind, "created");
  if (failedTask.kind !== "created") throw new Error("paper failure fixture was not created");
  database.failPaperExtraction(failedTask.task.id, "PAPER_PDF_UNSUPPORTED", "当前模型不支持论文 PDF 输入");
  assert.deepEqual(
    { code: database.getPaper(created.paper.id)?.errorCode, message: database.getPaper(created.paper.id)?.errorMessage },
    { code: "PAPER_PDF_UNSUPPORTED", message: "当前模型不支持论文 PDF 输入" },
  );

  const task = database.createPaperExtraction(created.paper.id, "pdf", null);
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
    const task = database.createPaperExtraction(created.paper.id, "pdf", null);
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

test("page images are keyed by PDF hash, drive batch progress, and leave with the last paper", () => {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-paper-images-"));
  const database = openDatabase(directory);
  const pdf = Buffer.from("%PDF-1.7\nimages fixture\n", "ascii");
  const hash = createHash("sha256").update(pdf).digest("hex");
  try {
    const created = database.createPaper({ sourceKind: "pdf", sourceUrl: null, originalFileName: "images.pdf", hash, content: pdf });
    if (!created.created) throw new Error("paper fixture was unexpectedly deduplicated");
    const id = created.paper.id;
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    assert.equal(database.savePaperPageImage(id, 1, jpeg), true);
    assert.equal(database.savePaperPageImage(id, 2, jpeg), true);
    assert.deepEqual(database.paperPageImages(id), [1, 2]);
    const firstPath = database.paperPageImagePath(id, 1);
    assert.ok(firstPath);
    assert.equal(readFileSync(firstPath).length, jpeg.length);
    assert.equal(database.paperPageImagePath(id, 0), null);
    assert.equal(database.paperPageImagePath(id, 1_000), null);

    database.setPaperPageCount(id, 3);
    const task = database.createPaperExtraction(id, "image", 3);
    if (task.kind !== "created") throw new Error("image task was not created");
    assert.deepEqual({ mode: task.task.contentMode, pageCount: task.task.pageCount }, { mode: "image", pageCount: 3 });
    assert.equal(database.startPaperExtraction(task.task.id), true);
    const block: PaperBlock = { id: "p1-b1", type: "paragraph", original: "Original", translation: "译文", assetIds: [] };
    const page = (pageNumber: number) => ({ pageNumber, originalBlocks: [block], translationBlocks: [{ ...block }] });

    // The title is known from the first batch and saved before the paper ends.
    assert.deepEqual(database.appendPaperPages(task.task.id, [page(1)], "页图论文", "甲"), { kind: "progress", completedPages: 1, pageCount: 3 });
    assert.equal(database.getPaper(id)?.title, "页图论文");
    assert.equal(database.getPaper(id)?.status, "extracting");
    assert.equal(database.appendPaperPages(task.task.id, [page(2), page(3)], null, null).kind, "completed");
    const finished = database.getPaper(id);
    assert.deepEqual({ status: finished?.status, pageCount: finished?.pageCount, pages: finished?.pages.length }, { status: "ready", pageCount: 3, pages: 3 });
    assert.equal(database.getPaperExtraction(task.task.id)?.status, "succeeded");
    assert.deepEqual(
      { mode: database.latestPaperExtraction(id)?.contentMode, completed: database.latestPaperExtraction(id)?.completedPages },
      { mode: "image", completed: 3 },
    );

    const trashed = database.softDeleteDocument(id, database.getDocument(id)!.revision);
    if (trashed.kind !== "deleted") throw new Error("paper was not trashed");
    assert.equal(database.permanentlyDeleteDocument(id, trashed.document.revision, null).kind, "deleted");
    assert.equal(existsSync(firstPath), false);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the local service fails over from the PDF to page images through its own API", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-paper-images-api-"));
  const dataDir = join(root, "data");
  const database = openDatabase(dataDir);
  const requests: Array<{ parts: string[]; system: string }> = [];
  // The endpoint takes images but refuses the whole document, which is exactly
  // the endpoint this failover exists for.
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ content: unknown }> };
    const content = body.messages[1]!.content;
    const parts = Array.isArray(content) ? (content as Array<{ type?: string }>).map((part) => String(part?.type)) : [];
    requests.push({ parts, system: String(body.messages[0]!.content) });
    if (!parts.includes("image_url")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "this endpoint does not accept pdf input" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            paper: { title: "本地页图论文", authors: ["甲"] },
            pages: [{ pageNumber: 1, blocks: [{ id: "p1-b1", type: "paragraph", original: "From image.", translation: "来自页图。", assetIds: [] }] }],
          }),
        },
      }],
    }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  database.setLlmSettings({
    enabled: true,
    target: "local",
    remote: { endpointUrl: "https://api.openai.com/v1/chat/completions", model: "" },
    local: { endpointUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`, model: "paper-fixture", trusted: true },
  }, 0, false);
  const app = createApp({
    dataDir,
    database,
    bootstrapToken: "paper-bootstrap",
    sessionToken: "paper-session",
    startWorker: false,
    resolveLlmTarget: async () => ({ url: new URL(`http://127.0.0.1:${address.port}/v1/chat/completions`), address: "127.0.0.1", family: 4 }),
  });
  const server = createServer((request, response) => void app.handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const listenAddress = server.address();
  assert.ok(listenAddress && typeof listenAddress !== "string");
  const base = `http://127.0.0.1:${listenAddress.port}`;
  try {
    const launch = await fetch(`${base}/launch?token=paper-bootstrap`, { redirect: "manual" });
    const cookie = (launch.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const settings = await fetch(`${base}/api/settings/llm`, { headers: { Cookie: cookie } });
    const epoch = settings.headers.get("x-zhiye-data-epoch");
    assert.ok(epoch);
    const headers = { Cookie: cookie, Origin: base, "X-Zhiye-Data-Epoch": epoch };
    const json = { ...headers, "Content-Type": "application/json" };
    const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { ...json, ...(init.headers as Record<string, string> | undefined) } });

    const pdf = Buffer.from("%PDF-1.7\nlocal fixture\n", "ascii");
    const upload = await fetch(`${base}/api/papers/upload`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/pdf", "X-Filename": "local.pdf" },
      body: pdf,
    });
    assert.equal(upload.status, 201);
    const paperId = (await upload.json() as { paper: { id: string } }).paper.id;

    // The local endpoint accepts PDFs in principle, so the first attempt sends
    // the whole document; the run is answered as running before it finishes.
    const started = await call(`/api/papers/${paperId}/extractions`, { method: "POST", body: "{}" });
    assert.equal(started.status, 202);
    const first = await started.json() as PaperExtractionTask;
    assert.deepEqual({ status: first.status, contentMode: first.contentMode }, { status: "running", contentMode: "pdf" });
    let polled: PaperExtractionTask = first;
    for (let attempt = 0; attempt < 100 && polled.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      polled = await (await call(`/api/paper-tasks/${first.id}`)).json() as PaperExtractionTask;
    }
    assert.deepEqual({ status: polled.status, code: polled.error?.code }, { status: "failed", code: "PAPER_PAGE_IMAGES_REQUIRED" });
    assert.deepEqual(requests.map((entry) => entry.parts), [["text", "file"]]);

    // The refusal commits the paper to page images, so the next plan says so and
    // the retry does not repeat the PDF request.
    const plan = await call(`/api/papers/${paperId}/extraction-plan`);
    assert.deepEqual(await plan.json(), { contentMode: "image", pageCount: null, rendered: [] });

    const early = await call(`/api/papers/${paperId}/extractions`, { method: "POST", body: "{}" });
    assert.equal(early.status, 409);
    assert.equal(((await early.json()) as { error: { code: string } }).error.code, "PAPER_PAGE_COUNT_REQUIRED");

    const renders = await call(`/api/papers/${paperId}/page-renders`, { method: "POST", body: JSON.stringify({ pageCount: 1 }) });
    assert.deepEqual(await renders.json(), { pageCount: 1, rendered: [] });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    const stored = await fetch(`${base}/api/papers/${paperId}/pages/1/image`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "image/jpeg" },
      body: jpeg,
    });
    assert.deepEqual(await stored.json(), { pageNumber: 1, bytes: jpeg.length });
    assert.equal(existsSync(database.paperPageImagePath(paperId, 1)!), true);
    // A non-JPEG body is refused rather than stored as a page image.
    const png = await fetch(`${base}/api/papers/${paperId}/pages/2/image`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "image/jpeg" },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    assert.equal(png.status, 415);

    const imageRun = await call(`/api/papers/${paperId}/extractions`, { method: "POST", body: "{}" });
    const imageTask = await imageRun.json() as PaperExtractionTask;
    assert.deepEqual({ status: imageTask.status, contentMode: imageTask.contentMode, pageCount: imageTask.pageCount }, { status: "running", contentMode: "image", pageCount: 1 });

    const step = await call(`/api/paper-tasks/${imageTask.id}/pages`, { method: "POST", body: "{}" });
    assert.equal(step.status, 202);
    const done = await step.json() as PaperExtractionTask;
    assert.deepEqual({ status: done.status, completedPages: done.completedPages, pageCount: done.pageCount }, { status: "succeeded", completedPages: 1, pageCount: 1 });
    assert.deepEqual(requests.map((entry) => entry.parts), [["text", "file"], ["text", "image_url"]]);
    assert.match(requests[1]!.system, /page images in ascending page order/u);

    const paper = await (await call(`/api/papers/${paperId}`)).json() as { status: string; title: string; pages: Array<{ translationBlocks: Array<{ translation: string }> }> };
    assert.equal(paper.status, "ready");
    assert.equal(paper.title, "本地页图论文");
    assert.equal(paper.pages[0]!.translationBlocks[0]!.translation, "来自页图。");

    // A finished task is not advanced again.
    const again = await (await call(`/api/paper-tasks/${imageTask.id}/pages`, { method: "POST", body: "{}" })).json() as PaperExtractionTask;
    assert.equal(again.status, "succeeded");
    assert.equal(requests.length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    // The app owns the database it was handed, so closing it is enough.
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
