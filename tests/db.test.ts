import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../server/db.js";

function database() {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-db-"));
  return {
    directory,
    db: openDatabase(directory),
    close() {
      this.db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("documents are queued once, indexed, tagged, and revision guarded", () => {
  const fixture = database();
  try {
    const created = fixture.db.createOrGetDocument("https://example.com/article");
    assert.equal(created.created, true);
    assert.equal(created.document.status, "queued");
    assert.equal(fixture.db.createOrGetDocument("https://example.com/article").created, false);

    const job = fixture.db.claimNextCapture();
    assert.ok(job);
    fixture.db.markExtracting(job, "http", 200);
    const ready = fixture.db.completeCapture(
      job,
      {
        title: "A durable local article",
        author: "Ada",
        publishedAt: "2026-08-09",
        finalUrl: "https://example.com/final-article",
        canonicalUrl: "https://example.com/article",
        markdown: "Local knowledge has a uniquely searchable phrase. 本地知识库。",
        mode: "http",
        warning: null,
        httpStatus: 200,
      },
      "snapshots/test.html.gz",
    );
    assert.equal(ready.status, "ready");
    assert.equal(ready.finalUrl, "https://example.com/final-article");
    const capture = fixture.db.sql.prepare(
      "SELECT request_url, final_url, extracted_title, extracted_markdown FROM captures WHERE id = ?",
    ).get(job.captureId) as Record<string, string>;
    assert.equal(capture.request_url, "https://example.com/article");
    assert.equal(capture.final_url, "https://example.com/final-article");
    assert.equal(capture.extracted_title, "A durable local article");
    assert.match(capture.extracted_markdown, /uniquely searchable/u);

    const updated = fixture.db.updateDocument(ready.id, ready.revision, {
      title: "Edited title",
      tags: ["Research", "Local"],
    });
    assert.equal(updated.kind, "updated");
    if (updated.kind !== "updated") return;
    assert.deepEqual(updated.document.tags, ["Local", "Research"]);

    const stale = fixture.db.updateDocument(ready.id, ready.revision, { title: "Stale edit" });
    assert.equal(stale.kind, "conflict");
    assert.equal(fixture.db.listDocuments({ q: "uniquely searchable", tag: "research" }).total, 1);
    assert.equal(fixture.db.listDocuments({ q: "知识" }).total, 1);
    assert.equal(fixture.db.listDocuments({ q: "example.com" }).total, 1);
    assert.equal(fixture.db.listDocuments().pageSize, 30);
  } finally {
    fixture.close();
  }
});

test("failed capture stays durable until an explicit retry", () => {
  const fixture = database();
  try {
    const created = fixture.db.createOrGetDocument("https://example.com/failure").document;
    const first = fixture.db.claimNextCapture();
    assert.ok(first);
    const failed = fixture.db.failCapture(first, "HTTP_ERROR", "upstream unavailable");
    assert.equal(failed.status, "failed");
    assert.equal(fixture.db.claimNextCapture(), null);

    const edited = fixture.db.updateDocument(failed.id, failed.revision, {
      title: "人工标题",
      markdown: "# 人工保留内容",
    });
    assert.equal(edited.kind, "updated");

    const retried = fixture.db.retryDocument(created.id);
    assert.equal(retried.kind, "queued");
    const second = fixture.db.claimNextCapture();
    assert.ok(second);
    assert.notEqual(second.captureId, first.captureId);
    const ready = fixture.db.completeCapture(second, {
      title: "机器标题",
      author: null,
      publishedAt: null,
      finalUrl: "https://example.com/failure",
      canonicalUrl: "https://example.com/failure",
      markdown: "机器重新抓取的正文",
      mode: "http",
      warning: null,
      httpStatus: 200,
    }, null);
    assert.equal(ready.title, "人工标题");
    assert.equal(ready.markdown, "# 人工保留内容");
  } finally {
    fixture.close();
  }
});
