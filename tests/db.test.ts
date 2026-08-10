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

import {
  CURRENT_SCHEMA_VERSION,
  DatabaseSchemaError,
  inspectDatabaseSchema,
  migrateDatabase,
  openDatabase,
} from "../server/db.js";
import type { BackupRecord } from "../shared/types.js";
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
    writeFileSync(join(fixture.directory, "snapshots/test.html.gz"), "snapshot");
    const ready = fixture.db.completeCapture(
      job,
      {
        extractorVersion: "defuddle@0.19.2",
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
      "SELECT request_url, final_url, extracted_title, extracted_markdown, extractor_version FROM captures WHERE id = ?",
    ).get(job.captureId) as Record<string, string>;
    assert.equal(capture.request_url, "https://example.com/article");
    assert.equal(capture.final_url, "https://example.com/final-article");
    assert.equal(capture.extracted_title, "A durable local article");
    assert.match(capture.extracted_markdown, /uniquely searchable/u);
    assert.equal(capture.extractor_version, "defuddle@0.19.2");
    const history = fixture.db.listCaptureHistory(ready.id);
    assert.deepEqual(
      history?.map(({ status, snapshotStored, extractorVersion }) => ({ status, snapshotStored, extractorVersion })),
      [{ status: "ready", snapshotStored: "available", extractorVersion: "defuddle@0.19.2" }],
    );
    assert.ok((history?.[0]?.durationMs ?? -1) >= 0);

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

test("collections and document metadata update atomically without losing manual source fields", () => {
  const fixture = database();
  try {
    const created = fixture.db.createOrGetDocument("https://example.com/organized").document;
    const collectionResult = fixture.db.createCollection("Projects");
    assert.equal(collectionResult.kind, "created");
    const collection = collectionResult.collection;
    assert.equal(fixture.db.createCollection("projects").kind, "duplicate");

    const organized = fixture.db.updateDocument(created.id, created.revision, {
      author: "Manual author",
      publishedAt: "2026-08-10",
      sourceNote: "Useful primary source.",
      favorite: true,
      archived: true,
      collectionIds: [collection.id],
    });
    assert.equal(organized.kind, "updated");
    if (organized.kind !== "updated") return;
    assert.equal(organized.document.favorite, true);
    assert.ok(organized.document.archivedAt);
    assert.equal(organized.document.sourceNote, "Useful primary source.");
    assert.deepEqual(organized.document.collections, [{ id: collection.id, name: "Projects" }]);
    assert.equal(fixture.db.listCollections()[0]?.documentCount, 1);

    const job = fixture.db.claimNextCapture();
    assert.ok(job);
    const ready = fixture.db.completeCapture(job, {
      title: "Captured title",
      author: "Captured author",
      publishedAt: "2020-01-01",
      finalUrl: created.sourceUrl,
      canonicalUrl: null,
      markdown: "Captured body",
      mode: "http",
      warning: null,
      httpStatus: 200,
    }, null);
    assert.equal(ready.author, "Manual author");
    assert.equal(ready.publishedAt, "2026-08-10");

    const invalid = fixture.db.updateDocument(ready.id, ready.revision, {
      favorite: false,
      collectionIds: ["missing"],
    });
    assert.equal(invalid.kind, "invalid_collections");
    assert.equal(fixture.db.getDocument(ready.id)?.revision, ready.revision);
    assert.equal(fixture.db.getDocument(ready.id)?.favorite, true);

    const renamed = fixture.db.renameCollection(collection.id, "Reading list");
    assert.equal(renamed.kind, "renamed");
    assert.deepEqual(fixture.db.getDocument(ready.id)?.collections, [{ id: collection.id, name: "Reading list" }]);
    const beforeDeleteRevision = fixture.db.getDocument(ready.id)!.revision;
    const deleted = fixture.db.deleteCollection(collection.id);
    assert.deepEqual(deleted, { kind: "deleted", affectedDocuments: 1 });
    const afterDelete = fixture.db.getDocument(ready.id)!;
    assert.equal(afterDelete.revision, beforeDeleteRevision + 1);
    assert.deepEqual(afterDelete.collections, []);
    assert.equal(fixture.db.getCollection(collection.id), null);

    const summary = fixture.db.listDocuments().items[0]!;
    assert.equal(summary.favorite, true);
    assert.ok(summary.archivedAt);
    assert.equal("sourceNote" in summary, false);
  } finally {
    fixture.close();
  }
});

test("composable filters and organization batches stay transactional", () => {
  const fixture = database();
  try {
    const capture = (url: string, title: string, markdown: string) => {
      const document = fixture.db.createOrGetDocument(url).document;
      const job = fixture.db.claimNextCapture();
      assert.ok(job);
      return fixture.db.completeCapture(job, {
        title,
        author: "Source author",
        publishedAt: "2026-08-10",
        finalUrl: `${url}/final`,
        canonicalUrl: null,
        markdown,
        mode: "http",
        warning: null,
        httpStatus: 200,
      }, null);
    };
    const alpha = capture("https://alpha.example/article", "Title needle", "First body");
    const beta = capture("https://beta.example/article", "Second title", "Body needle");
    const plain = capture("https://plain.example/article", "Unsorted", "Plain body");
    const firstCollection = fixture.db.createCollection("First").collection;
    const secondCollection = fixture.db.createCollection("Second").collection;
    const organizedAlpha = fixture.db.updateDocument(alpha.id, alpha.revision, {
      tags: ["Alpha", "Shared"],
      collectionIds: [firstCollection.id, secondCollection.id],
      favorite: true,
      archived: true,
    });
    const organizedBeta = fixture.db.updateDocument(beta.id, beta.revision, {
      tags: ["Beta", "Shared"],
      collectionIds: [firstCollection.id],
    });
    assert.equal(organizedAlpha.kind, "updated");
    assert.equal(organizedBeta.kind, "updated");
    assert.equal(fixture.db.listDocuments({ q: "needle", scope: "title" }).total, 1);
    assert.equal(fixture.db.listDocuments({ q: "needle", scope: "body" }).total, 1);
    assert.equal(fixture.db.listDocuments({ q: "alpha.example", scope: "source" }).total, 1);
    assert.equal(fixture.db.listDocuments({ unorganized: true }).items[0]?.id, plain.id);
    assert.equal(fixture.db.listDocuments({
      tag: "shared",
      collectionId: firstCollection.id,
      status: "ready",
      favorite: true,
      archived: true,
      captureMode: "http",
      from: "2020-01-01T00:00:00.000Z",
      to: "2030-01-01T00:00:00.000Z",
    }).total, 1);
    assert.deepEqual(
      fixture.db.listDocuments({ sort: "title" }).items.map(({ title }) => title),
      ["Second title", "Title needle", "Unsorted"],
    );
    assert.deepEqual(
      fixture.db.listManagedTags().map(({ name, documentCount }) => [name, documentCount]),
      [["Alpha", 1], ["Beta", 1], ["Shared", 2]],
    );

    const alphaBeforeRename = fixture.db.getDocument(alpha.id)!;
    assert.equal(fixture.db.renameTag("Alpha", "Renamed").kind, "renamed");
    assert.equal(fixture.db.getDocument(alpha.id)!.revision, alphaBeforeRename.revision + 1);
    const mergeTag = fixture.db.mergeTag("Renamed", "Shared");
    assert.equal(mergeTag.kind, "merged");
    assert.equal(mergeTag.kind === "merged" ? mergeTag.response.affectedDocuments : 0, 1);
    assert.deepEqual(fixture.db.getDocument(alpha.id)!.tags, ["Shared"]);
    assert.equal(fixture.db.deleteTag("Beta").kind, "deleted");
    const collectionRevision = fixture.db.getDocument(alpha.id)!.revision;
    const mergeCollection = fixture.db.mergeCollection(secondCollection.id, firstCollection.id);
    assert.equal(mergeCollection.kind, "merged");
    assert.equal(mergeCollection.kind === "merged" ? mergeCollection.affectedDocuments : 0, 1);
    assert.equal(fixture.db.getDocument(alpha.id)!.revision, collectionRevision + 1);

    const beforeBatch = [fixture.db.getDocument(alpha.id)!, fixture.db.getDocument(beta.id)!];
    const batch = fixture.db.batchDocuments(
      beforeBatch.map(({ id, revision }) => ({ id, revision })),
      "add-tag",
      "Bulk",
    );
    assert.equal(batch.kind, "updated");
    assert.equal(batch.kind === "updated" ? batch.response.affectedDocuments : 0, 2);
    const afterBatch = beforeBatch.map(({ id }) => fixture.db.getDocument(id)!);
    const stale = fixture.db.batchDocuments(
      [{ id: afterBatch[0]!.id, revision: beforeBatch[0]!.revision }, { id: afterBatch[1]!.id, revision: afterBatch[1]!.revision }],
      "remove-tag",
      "Bulk",
    );
    assert.equal(stale.kind, "conflict");
    assert.ok(afterBatch.every(({ id, revision }) => fixture.db.getDocument(id)!.revision === revision));
    assert.ok(afterBatch.every(({ id }) => fixture.db.getDocument(id)!.tags.includes("Bulk")));
  } finally {
    fixture.close();
  }
});

test("resolved duplicates can be kept and queued captures can be cancelled then retried", () => {
  const fixture = database();
  try {
    const original = fixture.db.createOrGetDocument("https://example.com/requested").document;
    const originalJob = fixture.db.claimNextCapture();
    assert.ok(originalJob);
    fixture.db.completeCapture(originalJob, {
      title: "Original",
      author: null,
      publishedAt: null,
      finalUrl: "https://example.com/final",
      canonicalUrl: "https://example.com/canonical",
      markdown: "Original body",
      mode: "http",
      warning: null,
      httpStatus: 200,
    }, null);

    const sourceDuplicate = fixture.db.createOrGetDocument(original.sourceUrl);
    assert.equal(sourceDuplicate.duplicateKind, "source");
    const resolvedDuplicate = fixture.db.createOrGetDocument("https://example.com/canonical");
    assert.equal(resolvedDuplicate.document.id, original.id);
    assert.equal(resolvedDuplicate.duplicateKind, "resolved");
    const kept = fixture.db.createOrGetDocument("https://example.com/canonical", true);
    assert.equal(kept.created, true);
    assert.equal(kept.duplicateKind, "resolved");
    assert.equal(fixture.db.findDuplicateDocument(kept.document.id)?.id, original.id);
    assert.deepEqual(fixture.db.getCaptureQueueCounts(), { active: 0, queued: 1 });

    const cancelled = fixture.db.cancelQueuedCapture(kept.document.id);
    assert.equal(cancelled.kind, "cancelled");
    if (cancelled.kind !== "cancelled") return;
    assert.equal(cancelled.document.errorCode, "CAPTURE_CANCELLED");
    assert.deepEqual(fixture.db.getCaptureQueueCounts(), { active: 0, queued: 0 });
    assert.equal(fixture.db.retryDocument(kept.document.id).kind, "queued");
    const running = fixture.db.claimNextCapture();
    assert.ok(running);
    assert.deepEqual(fixture.db.getCaptureQueueCounts(), { active: 1, queued: 0 });
    assert.equal(fixture.db.cancelQueuedCapture(kept.document.id).kind, "not_queued");
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

test("drafts survive restart and only matching document saves clear them", () => {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-drafts-"));
  let db = openDatabase(directory);
  try {
    const created = db.createOrGetDocument("https://example.com/draft").document;
    const job = db.claimNextCapture();
    assert.ok(job);
    const ready = db.completeCapture(job, {
      title: "Published title",
      author: null,
      publishedAt: null,
      finalUrl: created.sourceUrl,
      canonicalUrl: null,
      markdown: "Published body",
      mode: "http",
      warning: null,
      httpStatus: 200,
    }, null);
    const firstDraft = db.saveDocumentDraft(ready.id, null, ready.revision, "", "Recovered body", ["Local"]);
    assert.equal(firstDraft.kind, "saved");
    if (firstDraft.kind !== "saved") return;
    assert.equal(firstDraft.draft.draftRevision, 1);
    db.close();

    db = openDatabase(directory);
    const recovered = db.getDocumentDraft(ready.id);
    assert.ok(recovered);
    assert.match(recovered.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.deepEqual({ ...recovered, updatedAt: undefined }, {
      documentId: ready.id,
      draftRevision: 1,
      baseRevision: ready.revision,
      title: "",
      markdown: "Recovered body",
      tags: ["Local"],
      updatedAt: undefined,
    });
    const newerDraft = db.saveDocumentDraft(
      ready.id,
      firstDraft.draft.draftRevision,
      ready.revision,
      "Newer draft",
      "Keep me",
      ["Local"],
    );
    assert.equal(newerDraft.kind, "saved");
    if (newerDraft.kind !== "saved") return;
    assert.equal(newerDraft.draft.draftRevision, 2);
    const stalePut = db.saveDocumentDraft(
      ready.id,
      firstDraft.draft.draftRevision,
      ready.revision,
      "Stale draft",
      "Must not win",
      [],
    );
    assert.equal(stalePut.kind, "conflict");
    if (stalePut.kind !== "conflict") return;
    assert.equal(stalePut.draft?.markdown, "Keep me");
    assert.equal(db.deleteDocumentDraft(ready.id, firstDraft.draft.draftRevision).kind, "conflict");
    assert.equal(db.getDocumentDraft(ready.id)?.draftRevision, 2);
    const official = db.updateDocument(ready.id, ready.revision, {
      title: "Different official edit",
      markdown: "Official body",
      tags: [],
    });
    assert.equal(official.kind, "updated");
    assert.equal(db.getDocumentDraft(ready.id)?.markdown, "Keep me");
    if (official.kind !== "updated") return;
    const finalDraft = db.saveDocumentDraft(
      ready.id,
      newerDraft.draft.draftRevision,
      official.document.revision,
      "Final",
      "Persisted",
      ["Done"],
    );
    assert.equal(finalDraft.kind, "saved");
    if (finalDraft.kind !== "saved") return;
    assert.equal(
      db.updateDocument(ready.id, official.document.revision, {
        title: "Final",
        markdown: "Persisted",
        tags: ["Done"],
      }).kind,
      "updated",
    );
    assert.equal(db.getDocumentDraft(ready.id), null);
    const staleRevive = db.saveDocumentDraft(
      ready.id,
      finalDraft.draft.draftRevision,
      official.document.revision + 1,
      "Stale revive",
      "Must stay deleted",
      [],
    );
    assert.equal(staleRevive.kind, "conflict");
    if (staleRevive.kind !== "conflict") return;
    assert.equal(staleRevive.draft, null);
    const recreated = db.saveDocumentDraft(
      ready.id,
      null,
      official.document.revision + 1,
      "Recreated",
      "New draft",
      [],
    );
    assert.equal(recreated.kind, "saved");
    if (recreated.kind !== "saved") return;
    assert.ok(recreated.draft.draftRevision > finalDraft.draft.draftRevision);
    assert.equal(db.deleteDocumentDraft(ready.id, finalDraft.draft.draftRevision).kind, "conflict");
    assert.equal(db.deleteDocumentDraft(ready.id, recreated.draft.draftRevision).kind, "deleted");
    assert.equal(db.getDocumentDraft(ready.id), null);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
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

    const staleDelete = fixture.db.softDeleteDocument(ready.id, second.document.revision);
    assert.equal(staleDelete.kind, "conflict");
    if (staleDelete.kind === "conflict") {
      assert.equal(staleDelete.document.revision, revisionRestore.document.revision);
      assert.equal(staleDelete.document.deletedAt, null);
    }
    const trashed = fixture.db.softDeleteDocument(ready.id, revisionRestore.document.revision);
    assert.equal(trashed.kind, "deleted");
    if (trashed.kind !== "deleted") return;
    const localDraft = fixture.db.saveDocumentDraft(
      ready.id,
      null,
      revisionRestore.document.revision,
      "Local draft",
      "Keep",
      [],
    );
    assert.equal(localDraft.kind, "saved");
    if (localDraft.kind !== "saved") return;
    assert.equal(fixture.db.getDocumentDraft(ready.id)?.markdown, "Keep");
    assert.deepEqual(fixture.db.listTags(), []);
    assert.equal(fixture.db.listDocuments().total, 0);
    assert.equal(fixture.db.listDocuments({ q: "First", trash: "only" }).total, 1);
    assert.ok(fixture.db.listDocuments({ trash: "only" }).items[0]?.deletedAt);
    assert.equal(
      fixture.db.updateDocument(ready.id, revisionRestore.document.revision, { title: "Hidden edit" }).kind,
      "deleted",
    );

    const staleRestore = fixture.db.restoreDocument(ready.id, revisionRestore.document.revision);
    assert.equal(staleRestore.kind, "conflict");
    if (staleRestore.kind === "conflict") assert.ok(staleRestore.document.deletedAt);
    const restored = fixture.db.restoreDocument(ready.id, trashed.document.revision);
    assert.equal(restored.kind, "restored");
    if (restored.kind !== "restored") return;
    assert.deepEqual(fixture.db.listTags(), ["One"]);
    assert.equal(fixture.db.listDocuments().total, 1);
    const deletedAgain = fixture.db.softDeleteDocument(ready.id, restored.document.revision);
    assert.equal(deletedAgain.kind, "deleted");
    if (deletedAgain.kind !== "deleted") return;
    assert.equal(
      fixture.db.permanentlyDeleteDocument(ready.id, deletedAgain.document.revision - 1, null).kind,
      "conflict",
    );
    assert.equal(
      fixture.db.permanentlyDeleteDocument(ready.id, deletedAgain.document.revision, null).kind,
      "draft_exists",
    );
    assert.equal(
      fixture.db.permanentlyDeleteDocument(
        ready.id,
        deletedAgain.document.revision,
        localDraft.draft.draftRevision,
      ).kind,
      "deleted",
    );
    assert.equal(existsSync(snapshot), false);
    assert.equal(
      (fixture.db.sql.prepare("SELECT count(*) AS total FROM file_deletions").get() as { total: number }).total,
      0,
    );
    assert.equal(fixture.db.getDocument(ready.id), null);
    assert.equal(fixture.db.getDocumentDraft(ready.id), null);
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
    const deleted = fixture.db.softDeleteDocument(created.id, fixture.db.getDocument(created.id)!.revision);
    assert.equal(deleted.kind, "deleted");
    if (deleted.kind !== "deleted") return;
    assert.equal(
      fixture.db.permanentlyDeleteDocument(created.id, deleted.document.revision, null).kind,
      "snapshot_failed",
    );
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
      const deleted = fixture.db.softDeleteDocument(created.id, fixture.db.getDocument(created.id)!.revision);
      assert.equal(deleted.kind, "deleted");
      if (deleted.kind !== "deleted") continue;
      assert.equal(
        fixture.db.permanentlyDeleteDocument(created.id, deleted.document.revision, null).kind,
        "snapshot_failed",
      );
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
    const deleted = fixture.db.softDeleteDocument(created.id, fixture.db.getDocument(created.id)!.revision);
    assert.equal(deleted.kind, "deleted");
    if (deleted.kind !== "deleted") return;
    fixture.db.sql.exec(`
      CREATE TRIGGER block_document_delete BEFORE DELETE ON documents BEGIN
        SELECT RAISE(ABORT, 'simulated database failure');
      END;
    `);

    assert.throws(
      () => fixture.db.permanentlyDeleteDocument(created.id, deleted.document.revision, null),
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

    const first = fixture.db.softDeleteDocument(documents[0].id, documents[0].revision);
    assert.equal(first.kind, "deleted");
    if (first.kind !== "deleted") return;
    assert.equal(
      fixture.db.permanentlyDeleteDocument(documents[0].id, first.document.revision, null).kind,
      "deleted",
    );
    assert.equal(existsSync(absolutePath), true);

    const second = fixture.db.softDeleteDocument(documents[1].id, documents[1].revision);
    assert.equal(second.kind, "deleted");
    if (second.kind !== "deleted") return;
    assert.equal(
      fixture.db.permanentlyDeleteDocument(documents[1].id, second.document.revision, null).kind,
      "deleted",
    );
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
    const deleted = db.softDeleteDocument(created.id, recovered.revision);
    assert.equal(deleted.kind, "deleted");
    if (deleted.kind !== "deleted") return;
    assert.equal(db.permanentlyDeleteDocument(created.id, deleted.document.revision, null).kind, "deleted");
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
    assert.equal(
      fixture.db.softDeleteDocument(lastId, fixture.db.getDocument(lastId)!.revision).kind,
      "deleted",
    );
    assert.deepEqual(fixture.db.listTags(), ["First"]);
    assert.deepEqual(fixture.db.listTags("only"), ["Overflow"]);
  } finally {
    fixture.close();
  }
});

test("current migrations upgrade v3 and the frozen v7 release schema", () => {
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
        CURRENT_SCHEMA_VERSION,
      );
    } finally {
      upgraded.close();
    }
    const repeated = openDatabase(directory);
    try {
      assert.equal(
        (repeated.sql.prepare("SELECT count(*) AS total FROM schema_migrations").get() as { total: number }).total,
        CURRENT_SCHEMA_VERSION,
      );
      assert.equal(repeated.listDocumentRevisions(documentId)?.length, 2);
    } finally {
      repeated.close();
    }

    const currentDirectory = join(directory, "release-v7");
    mkdirSync(currentDirectory);
    const currentPath = join(currentDirectory, "zhiye.sqlite3");
    const fixture = new DatabaseSync(currentPath);
    fixture.exec(readFileSync(new URL("./fixtures/schema-v7.sql", import.meta.url), "utf8"));
    const migrationsBefore = fixture
      .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
      .all();
    fixture.close();

    assert.deepEqual(inspectDatabaseSchema(currentDirectory).pendingVersions, [8, 9, 10]);
    const current = openDatabase(currentDirectory);
    try {
      assert.equal(current.getDocument("release-document")?.markdown, "Frozen release schema body.");
      assert.deepEqual(current.getDocument("release-document")?.tags, ["Fixture"]);
      assert.deepEqual(current.getDocument("release-document")?.collections, []);
      assert.equal(current.getDocument("release-document")?.favorite, false);
      assert.equal(current.getDocument("release-document")?.archivedAt, null);
      assert.equal(current.getDocument("release-document")?.sourceNote, "");
      assert.equal(current.listDocuments({ q: "Frozen" }).total, 1);
      assert.equal(
        (current.sql.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number })
          .version,
        CURRENT_SCHEMA_VERSION,
      );
      assert.equal(
        (
          current.sql
            .prepare("SELECT 1 AS found FROM pragma_table_info('captures') WHERE name = 'extractor_version'")
            .get() as { found: number }
        ).found,
        1,
      );
      assert.deepEqual(
        current.sql.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version LIMIT 7").all(),
        migrationsBefore,
      );
    } finally {
      current.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema inspection is read-only and rejects future or incomplete histories", () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-schema-inspection-"));
  const emptyDir = join(root, "empty");
  const dataDir = join(root, "data");
  try {
    assert.deepEqual(inspectDatabaseSchema(emptyDir), {
      status: "empty",
      currentVersion: 0,
      supportedVersion: CURRENT_SCHEMA_VERSION,
      appliedVersions: [],
      pendingVersions: Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1),
    });
    assert.equal(existsSync(emptyDir), false);

    const linkedDir = join(root, "linked");
    const missingTarget = join(root, "missing-target.sqlite3");
    mkdirSync(linkedDir);
    symlinkSync(missingTarget, join(linkedDir, "zhiye.sqlite3"));
    assert.throws(() => inspectDatabaseSchema(linkedDir), /regular file/u);
    assert.throws(() => migrateDatabase(linkedDir), /regular file/u);
    assert.throws(() => openDatabase(linkedDir), /regular file/u);
    assert.equal(existsSync(missingTarget), false);

    const sidecarDir = join(root, "linked-sidecar");
    mkdirSync(sidecarDir);
    const sidecarDatabase = join(sidecarDir, "zhiye.sqlite3");
    const empty = new DatabaseSync(sidecarDatabase);
    empty.close();
    symlinkSync(join(root, "missing-wal"), `${sidecarDatabase}-wal`);
    assert.throws(() => inspectDatabaseSchema(sidecarDir), /regular file/u);

    const snapshotsData = join(root, "linked-snapshots");
    const outsideSnapshots = join(root, "outside-snapshots");
    mkdirSync(snapshotsData);
    mkdirSync(outsideSnapshots);
    chmodSync(outsideSnapshots, 0o755);
    symlinkSync(outsideSnapshots, join(snapshotsData, "snapshots"), "dir");
    assert.throws(() => openDatabase(snapshotsData), /real directory/u);
    assert.equal(statSync(outsideSnapshots).mode & 0o777, 0o755);
    assert.equal(existsSync(join(snapshotsData, "zhiye.sqlite3")), false);

    assert.equal(migrateDatabase(dataDir).status, "current");

    const raw = new DatabaseSync(join(dataDir, "zhiye.sqlite3"));
    raw.exec(`
      DROP INDEX documents_archive_favorite_updated;
      DROP TABLE document_collections;
      DROP TABLE collections;
      ALTER TABLE documents DROP COLUMN published_at_edited;
      ALTER TABLE documents DROP COLUMN author_edited;
      ALTER TABLE documents DROP COLUMN source_note;
      ALTER TABLE documents DROP COLUMN archived_at;
      ALTER TABLE documents DROP COLUMN favorite;
      DELETE FROM schema_migrations WHERE version = ${CURRENT_SCHEMA_VERSION};
    `);
    raw.close();
    assert.deepEqual(inspectDatabaseSchema(dataDir).pendingVersions, [CURRENT_SCHEMA_VERSION]);
    assert.equal(migrateDatabase(dataDir).status, "current");

    const future = new DatabaseSync(join(dataDir, "zhiye.sqlite3"));
    future
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(CURRENT_SCHEMA_VERSION + 1, new Date().toISOString());
    future.close();
    assert.equal(inspectDatabaseSchema(dataDir).status, "future");
    assert.throws(
      () => migrateDatabase(dataDir),
      (error: unknown) => error instanceof DatabaseSchemaError && error.code === "FUTURE_SCHEMA",
    );

    const broken = new DatabaseSync(join(dataDir, "zhiye.sqlite3"));
    broken.prepare("DELETE FROM schema_migrations WHERE version IN (?, ?)").run(4, CURRENT_SCHEMA_VERSION + 1);
    broken.close();
    assert.equal(inspectDatabaseSchema(dataDir).status, "non-contiguous");
    assert.throws(
      () => openDatabase(dataDir),
      (error: unknown) =>
        error instanceof DatabaseSchemaError && error.code === "NON_CONTIGUOUS_MIGRATIONS",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all pending migrations roll back together on failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "zhiye-migration-rollback-"));
  const path = join(directory, "zhiye.sqlite3");
  try {
    const raw = new DatabaseSync(path);
    raw.exec(readFileSync(new URL("./fixtures/schema-v3.sql", import.meta.url), "utf8"));
    raw.exec("CREATE TABLE file_deletions(path TEXT PRIMARY KEY)");
    raw.close();

    assert.throws(() => openDatabase(directory), /file_deletions/u);
    assert.deepEqual(inspectDatabaseSchema(directory), {
      status: "pending",
      currentVersion: 3,
      supportedVersion: CURRENT_SCHEMA_VERSION,
      appliedVersions: [1, 2, 3],
      pendingVersions: [4, 5, 6, 7, 8, 9, 10],
    });
    const unchanged = new DatabaseSync(path, { readOnly: true });
    try {
      const documentColumns = unchanged.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
      assert.equal(documentColumns.some(({ name }) => name === "deleted_at"), false);
      assert.equal(
        unchanged
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'document_revisions'")
          .get(),
        undefined,
      );
    } finally {
      unchanged.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("backup metadata, health, and orphan cleanup stay database guarded", () => {
  const fixture = database();
  const record = (
    id: string,
    reason: BackupRecord["reason"],
    createdAt: string,
    directoryName: string | null,
    status: BackupRecord["status"] = "verified",
  ): BackupRecord => ({
    id,
    directoryName,
    reason,
    status,
    createdAt,
    finishedAt: createdAt,
    verifiedAt: status === "verified" ? createdAt : null,
    totalBytes: status === "verified" ? 42 : null,
    schemaVersion: status === "verified" ? CURRENT_SCHEMA_VERSION : null,
    errorCode: status === "verified" ? null : "BACKUP_FAILED",
    errorMessage: status === "verified" ? null : "Backup failed",
  });
  try {
    assert.deepEqual(fixture.db.getBackupSettings(), { automaticRetentionCount: 7 });
    assert.throws(() => fixture.db.setAutomaticRetentionCount(0), RangeError);
    assert.deepEqual(fixture.db.setAutomaticRetentionCount(2), { automaticRetentionCount: 2 });
    assert.throws(
      () => fixture.db.sql.prepare("UPDATE backup_settings SET automatic_retention_count = 101").run(),
      /constraint/u,
    );

    const automatic = [1, 2, 3].map((day) =>
      record(
        `automatic-${day}`,
        "automatic",
        `2026-08-0${day}T01:00:00.000Z`,
        `backup-automatic-${day}`,
      ),
    );
    for (const item of automatic) fixture.db.upsertBackupRecord(item);
    const manual = record("manual", "manual", "2026-08-04T01:00:00.000Z", "backup-manual");
    fixture.db.upsertBackupRecord(manual);
    fixture.db.upsertBackupRecord(
      record("failed", "automatic", "2026-08-05T01:00:00.000Z", null, "failed"),
    );
    assert.equal(fixture.db.getBackupRecordByDirectoryName("backup-manual")?.id, manual.id);
    assert.throws(() => fixture.db.upsertBackupRecord({ ...manual, id: "unsafe", directoryName: "/tmp/x" }), RangeError);
    assert.equal(
      fixture.db.hasAutomaticBackupForDay("2026-08-05T00:00:00.000Z", "2026-08-06T00:00:00.000Z"),
      false,
    );
    assert.equal(
      fixture.db.hasAutomaticBackupForDay("2026-08-03T00:00:00.000Z", "2026-08-04T00:00:00.000Z"),
      true,
    );
    assert.deepEqual(fixture.db.listExpiredAutomaticBackups().map(({ id }) => id), ["automatic-1"]);
    assert.equal(fixture.db.deleteAutomaticBackupRecord("manual"), false);
    assert.equal(fixture.db.deleteAutomaticBackupRecord("automatic-1"), true);

    const created = fixture.db.createOrGetDocument("https://example.com/health").document;
    const job = fixture.db.claimNextCapture();
    assert.ok(job);
    const referenced = "snapshots/referenced.html.gz";
    fixture.db.completeCapture(job, {
      title: "Health",
      author: null,
      publishedAt: null,
      finalUrl: created.sourceUrl,
      canonicalUrl: null,
      markdown: "Healthy",
      mode: "http",
      warning: null,
      httpStatus: 200,
    }, referenced);
    const orphan = "snapshots/orphan.html.gz";
    mkdirSync(join(fixture.directory, orphan));
    assert.deepEqual(fixture.db.queueSnapshotDeletions([referenced, orphan]), {
      queued: [orphan],
      referenced: [referenced],
    });
    assert.throws(
      () => fixture.db.queueSnapshotDeletions(["snapshots/rolled-back.html.gz", "snapshots/../unsafe.html.gz"]),
      /outside storage/u,
    );
    assert.equal(
      fixture.db.sql.prepare("SELECT path FROM file_deletions WHERE path = ?").get("snapshots/rolled-back.html.gz"),
      undefined,
    );
    fixture.db.processPendingFileDeletions();

    const health = fixture.db.getDatabaseHealth();
    assert.deepEqual(health.integrityCheck, ["ok"]);
    assert.deepEqual(health.foreignKeyViolations, []);
    assert.deepEqual(health.referencedSnapshotPaths, [referenced]);
    assert.equal(health.pendingFileDeletions[0]?.path, orphan);
    assert.equal(health.pendingFileDeletions[0]?.attempts, 1);
    assert.ok(health.recentErrors.some(({ source }) => source === "backup"));
    assert.ok(health.recentErrors.some(({ source }) => source === "file-deletion"));
  } finally {
    fixture.close();
  }
});
