import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "../server/db.js";
import { acquireDataLock } from "../server/lock.js";

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

test("manual revisions can be restored and trash deletion removes tracked snapshots", () => {
  const fixture = database();
  try {
    const created = fixture.db.createOrGetDocument("https://example.com/history").document;
    const job = fixture.db.claimNextCapture();
    assert.ok(job);
    const ready = fixture.db.completeCapture(job, {
      title: "Captured title",
      author: null,
      publishedAt: null,
      finalUrl: created.sourceUrl,
      canonicalUrl: created.sourceUrl,
      markdown: "Captured body",
      mode: "http",
      warning: null,
      httpStatus: 200,
    }, "snapshots/history.html.gz");
    const snapshot = join(fixture.directory, "snapshots/history.html.gz");
    writeFileSync(snapshot, "snapshot");

    const first = fixture.db.updateDocument(ready.id, ready.revision, {
      title: "First edit",
      markdown: "First body",
      tags: ["One"],
    });
    assert.equal(first.kind, "updated");
    if (first.kind !== "updated") return;
    const second = fixture.db.updateDocument(first.document.id, first.document.revision, {
      title: "Second edit",
      markdown: "Second body",
      tags: ["Two"],
    });
    assert.equal(second.kind, "updated");
    if (second.kind !== "updated") return;
    assert.deepEqual(fixture.db.listTags(), ["Two"]);

    assert.deepEqual(
      fixture.db.listDocumentRevisions(ready.id)?.map(({ revision, title, markdown, tags }) => ({
        revision,
        title,
        markdown,
        tags,
      })),
      [
        { revision: second.document.revision, title: "Second edit", markdown: "Second body", tags: ["Two"] },
        { revision: first.document.revision, title: "First edit", markdown: "First body", tags: ["One"] },
        { revision: ready.revision, title: "Captured title", markdown: "Captured body", tags: [] },
      ],
    );
    assert.equal(
      fixture.db.restoreDocumentRevision(ready.id, first.document.revision, first.document.revision).kind,
      "conflict",
    );
    const revisionRestore = fixture.db.restoreDocumentRevision(
      ready.id,
      first.document.revision,
      second.document.revision,
    );
    assert.equal(revisionRestore.kind, "restored");
    if (revisionRestore.kind !== "restored") return;
    assert.equal(revisionRestore.document.title, "First edit");
    assert.equal(revisionRestore.document.markdown, "First body");
    assert.deepEqual(revisionRestore.document.tags, ["One"]);
    const restoredHistory = fixture.db.listDocumentRevisions(ready.id)!;
    assert.deepEqual(restoredHistory.map(({ revision }) => revision), [
      revisionRestore.document.revision,
      second.document.revision,
      first.document.revision,
      ready.revision,
    ]);
    assert.equal(
      restoredHistory.find(({ revision }) => revision === first.document.revision)?.markdown,
      "First body",
    );

    const trashed = fixture.db.softDeleteDocument(ready.id);
    assert.equal(trashed.kind, "deleted");
    assert.deepEqual(fixture.db.listTags(), []);
    assert.equal(fixture.db.listDocuments().total, 0);
    assert.equal(fixture.db.listDocuments({ q: "First", trash: "only" }).total, 1);
    assert.ok(fixture.db.listDocuments({ trash: "only" }).items[0]?.deletedAt);
    assert.equal(
      fixture.db.updateDocument(ready.id, revisionRestore.document.revision, { title: "Hidden edit" }).kind,
      "deleted",
    );

    const restored = fixture.db.restoreDocument(ready.id);
    assert.equal(restored.kind, "restored");
    assert.deepEqual(fixture.db.listTags(), ["One"]);
    assert.equal(fixture.db.listDocuments().total, 1);
    const deletedAgain = fixture.db.softDeleteDocument(ready.id);
    assert.equal(deletedAgain.kind, "deleted");
    if (deletedAgain.kind !== "deleted") return;
    assert.equal(fixture.db.permanentlyDeleteDocument(ready.id, deletedAgain.document.revision - 1).kind, "conflict");
    assert.equal(fixture.db.permanentlyDeleteDocument(ready.id, deletedAgain.document.revision).kind, "deleted");
    assert.equal(existsSync(snapshot), false);
    assert.equal(
      (fixture.db.sql.prepare("SELECT count(*) AS total FROM file_deletions").get() as { total: number }).total,
      0,
    );
    assert.equal(fixture.db.getDocument(ready.id), null);
    assert.equal(fixture.db.listDocumentRevisions(ready.id), null);
  } finally {
    fixture.close();
  }
});

test("snapshot deletion failure keeps the trashed document tracked", () => {
  const fixture = database();
  try {
    const created = fixture.db.createOrGetDocument("https://example.com/undeletable").document;
    const job = fixture.db.claimNextCapture();
    assert.ok(job);
    fixture.db.completeCapture(job, {
      title: "Undeletable snapshot",
      author: null,
      publishedAt: null,
      finalUrl: created.sourceUrl,
      canonicalUrl: null,
      markdown: "Body",
      mode: "http",
      warning: null,
      httpStatus: 200,
    }, "snapshots/not-a-file.html.gz");
    mkdirSync(join(fixture.directory, "snapshots/not-a-file.html.gz"));
    const deleted = fixture.db.softDeleteDocument(created.id);
    assert.equal(deleted.kind, "deleted");
    if (deleted.kind !== "deleted") return;
    assert.equal(fixture.db.permanentlyDeleteDocument(created.id, deleted.document.revision).kind, "snapshot_failed");
    assert.ok(fixture.db.getDocument(created.id)?.deletedAt);
  } finally {
    fixture.close();
  }
});

test("snapshot cleanup rejects traversal and symbolic links", () => {
  const fixture = database();
  try {
    const outside = join(fixture.directory, "outside");
    mkdirSync(outside);
    const victim = join(outside, "victim.html.gz");
    writeFileSync(victim, "must survive");
    symlinkSync(victim, join(fixture.directory, "snapshots/final-link.html.gz"));
    symlinkSync(outside, join(fixture.directory, "snapshots/parent-link"));

    for (const [index, snapshotPath] of [
      "snapshots/../outside.html.gz",
      "snapshots/final-link.html.gz",
      "snapshots/parent-link/victim.html.gz",
    ].entries()) {
      const created = fixture.db.createOrGetDocument(`https://example.com/unsafe-${index}`).document;
      const job = fixture.db.claimNextCapture();
      assert.ok(job);
      fixture.db.completeCapture(job, {
        title: "Unsafe path",
        author: null,
        publishedAt: null,
        finalUrl: created.sourceUrl,
        canonicalUrl: null,
        markdown: "Body",
        mode: "http",
        warning: null,
        httpStatus: 200,
      }, snapshotPath);
      const deleted = fixture.db.softDeleteDocument(created.id);
      assert.equal(deleted.kind, "deleted");
      if (deleted.kind !== "deleted") continue;
      assert.equal(fixture.db.permanentlyDeleteDocument(created.id, deleted.document.revision).kind, "snapshot_failed");
      assert.ok(fixture.db.getDocument(created.id)?.deletedAt);
    }
    assert.equal(existsSync(victim), true);
  } finally {
    fixture.close();
  }
});

test("a database failure cannot delete a document snapshot first", () => {
  const fixture = database();
  try {
    const created = fixture.db.createOrGetDocument("https://example.com/atomic-delete").document;
    const job = fixture.db.claimNextCapture();
    assert.ok(job);
    fixture.db.completeCapture(job, {
      title: "Atomic delete",
      author: null,
      publishedAt: null,
      finalUrl: created.sourceUrl,
      canonicalUrl: null,
      markdown: "Body",
      mode: "http",
      warning: null,
      httpStatus: 200,
    }, "snapshots/atomic.html.gz");
    const snapshot = join(fixture.directory, "snapshots/atomic.html.gz");
    writeFileSync(snapshot, "snapshot");
    const deleted = fixture.db.softDeleteDocument(created.id);
    assert.equal(deleted.kind, "deleted");
    if (deleted.kind !== "deleted") return;
    fixture.db.sql.exec(`
      CREATE TRIGGER block_document_delete BEFORE DELETE ON documents BEGIN
        SELECT RAISE(ABORT, 'simulated database failure');
      END;
    `);

    assert.throws(
      () => fixture.db.permanentlyDeleteDocument(created.id, deleted.document.revision),
      /simulated database failure/u,
    );
    assert.equal(existsSync(snapshot), true);
    assert.ok(fixture.db.getDocument(created.id)?.deletedAt);
    assert.equal(
      (fixture.db.sql.prepare("SELECT count(*) AS total FROM file_deletions").get() as { total: number }).total,
      0,
    );
  } finally {
    fixture.close();
  }
});

test("failed file cleanup stays queued for a later retry", () => {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-pending-cleanup-"));
  let db = openDatabase(directory);
  try {
    const relativePath = "snapshots/pending-directory.html.gz";
    const path = join(directory, relativePath);
    mkdirSync(path);
    db.sql
      .prepare("INSERT INTO file_deletions(path, created_at, updated_at) VALUES (?, ?, ?)")
      .run(relativePath, new Date().toISOString(), new Date().toISOString());

    db.processPendingFileDeletions();
    assert.equal(
      (db.sql.prepare("SELECT attempts FROM file_deletions WHERE path = ?").get(relativePath) as {
        attempts: number;
      }).attempts,
      1,
    );
    db.close();
    rmSync(path, { recursive: true });
    db = openDatabase(directory);
    assert.equal(db.sql.prepare("SELECT path FROM file_deletions WHERE path = ?").get(relativePath), undefined);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a shared snapshot is deleted only after its last document", () => {
  const fixture = database();
  try {
    const snapshotPath = "snapshots/shared.html.gz";
    const absolutePath = join(fixture.directory, snapshotPath);
    writeFileSync(absolutePath, "shared snapshot");
    const documents = ["first", "second"].map((slug) => {
      const created = fixture.db.createOrGetDocument(`https://example.com/${slug}`).document;
      const job = fixture.db.claimNextCapture();
      assert.ok(job);
      return fixture.db.completeCapture(job, {
        title: slug,
        author: null,
        publishedAt: null,
        finalUrl: created.sourceUrl,
        canonicalUrl: null,
        markdown: slug,
        mode: "http",
        warning: null,
        httpStatus: 200,
      }, snapshotPath);
    });

    const first = fixture.db.softDeleteDocument(documents[0].id);
    assert.equal(first.kind, "deleted");
    if (first.kind !== "deleted") return;
    assert.equal(fixture.db.permanentlyDeleteDocument(documents[0].id, first.document.revision).kind, "deleted");
    assert.equal(existsSync(absolutePath), true);

    const second = fixture.db.softDeleteDocument(documents[1].id);
    assert.equal(second.kind, "deleted");
    if (second.kind !== "deleted") return;
    assert.equal(fixture.db.permanentlyDeleteDocument(documents[1].id, second.document.revision).kind, "deleted");
    assert.equal(existsSync(absolutePath), false);
  } finally {
    fixture.close();
  }
});

test("a planned snapshot remains tracked after an interrupted capture", () => {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-planned-snapshot-"));
  let db = openDatabase(directory);
  try {
    const created = db.createOrGetDocument("https://example.com/interrupted-snapshot").document;
    const job = db.claimNextCapture();
    assert.ok(job);
    const snapshotPath = `snapshots/${job.captureId}.html.gz`;
    db.planCaptureSnapshot(job, snapshotPath);
    const absolutePath = join(directory, snapshotPath);
    writeFileSync(absolutePath, "partial but tracked");
    db.close();

    db = openDatabase(directory);
    assert.equal(
      (db.sql.prepare("SELECT snapshot_path FROM captures WHERE id = ?").get(job.captureId) as {
        snapshot_path: string;
      }).snapshot_path,
      snapshotPath,
    );
    const recovered = db.getDocument(created.id)!;
    assert.equal(recovered.status, "queued");
    const deleted = db.softDeleteDocument(created.id);
    assert.equal(deleted.kind, "deleted");
    if (deleted.kind !== "deleted") return;
    assert.equal(db.permanentlyDeleteDocument(created.id, deleted.document.revision).kind, "deleted");
    assert.equal(existsSync(absolutePath), false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local data files use owner-only permissions", () => {
  const parent = mkdtempSync(join(tmpdir(), "zhiye-permissions-"));
  const directory = join(parent, "data");
  mkdirSync(directory, { mode: 0o755 });
  const legacy = openDatabase(directory);
  legacy.close();
  chmodSync(directory, 0o755);
  const releaseLock = acquireDataLock(directory);
  const db = openDatabase(directory);
  try {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, "snapshots")).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, "zhiye.sqlite3")).mode & 0o777, 0o600);
  } finally {
    db.close();
    releaseLock();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the data lock does not chmod a shared directory", () => {
  const parent = mkdtempSync(join(tmpdir(), "zhiye-shared-permissions-"));
  const directory = join(parent, "shared");
  mkdirSync(join(directory, "snapshots"), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "zhiye.sqlite3"), "not opened by this test");
  writeFileSync(join(directory, "unrelated"), "must remain shared");
  chmodSync(directory, 0o755);
  const releaseLock = acquireDataLock(directory);
  try {
    assert.equal(statSync(directory).mode & 0o777, 0o755);
  } finally {
    releaseLock();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("global tags are not limited to the first document page", () => {
  const fixture = database();
  try {
    let lastId = "";
    for (let index = 0; index < 31; index += 1) {
      const document = fixture.db.createOrGetDocument(`https://example.com/page-${index}`).document;
      lastId = document.id;
      if (index === 0 || index === 30) {
        const updated = fixture.db.updateDocument(document.id, document.revision, {
          tags: [index === 0 ? "First" : "Overflow"],
        });
        assert.equal(updated.kind, "updated");
      }
    }
    assert.equal(fixture.db.listDocuments().items.length, 30);
    assert.equal(fixture.db.listDocuments().total, 31);
    assert.deepEqual(fixture.db.listTags(), ["First", "Overflow"]);
    assert.equal(fixture.db.softDeleteDocument(lastId).kind, "deleted");
    assert.deepEqual(fixture.db.listTags(), ["First"]);
    assert.deepEqual(fixture.db.listTags("only"), ["Overflow"]);
  } finally {
    fixture.close();
  }
});

test("v5 lifecycle migrations upgrade an existing v3 database", () => {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-v3-upgrade-"));
  const path = join(directory, "zhiye.sqlite3");
  const documentId = "legacy-document";
  const legacyRevision = 3;
  const legacyUpdatedAt = "2026-08-01T02:03:04.000Z";
  try {
    const v3 = new DatabaseSync(path);
    v3.exec(readFileSync(new URL("./fixtures/schema-v3.sql", import.meta.url), "utf8"));
    v3.close();

    const upgraded = openDatabase(directory);
    try {
      assert.equal(upgraded.getDocument(documentId)?.markdown, "Legacy edited body");
      assert.deepEqual(upgraded.getDocument(documentId)?.tags, ["Legacy"]);
      assert.deepEqual(upgraded.listDocumentRevisions(documentId)?.[0], {
        revision: legacyRevision,
        title: "Legacy title",
        markdown: "Legacy edited body",
        tags: ["Legacy"],
        createdAt: legacyUpdatedAt,
      });
      const edited = upgraded.updateDocument(documentId, legacyRevision, { markdown: "Migrated edit" });
      assert.equal(edited.kind, "updated");
      assert.equal(upgraded.listDocumentRevisions(documentId)?.[0]?.markdown, "Migrated edit");
      assert.equal(upgraded.listDocumentRevisions(documentId)?.[1]?.revision, legacyRevision);
      assert.equal(
        (upgraded.sql.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number })
          .version,
        5,
      );
    } finally {
      upgraded.close();
    }
    const repeated = openDatabase(directory);
    try {
      assert.equal(
        (repeated.sql.prepare("SELECT count(*) AS total FROM schema_migrations").get() as { total: number }).total,
        5,
      );
      assert.equal(repeated.listDocumentRevisions(documentId)?.length, 2);
    } finally {
      repeated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
