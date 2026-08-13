import assert from "node:assert/strict";
import { existsSync, fsyncSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { createApp, type CaptureFunction } from "../server/app.js";
import { BACKUP_ARCHIVE_MIME } from "../server/backup.js";
import { derivedInputHash, openDatabase } from "../server/db.js";
import type {
  BackupRecord,
  CaptureHistoryItem,
  CaptureQueueStatus,
  CreateDocumentResponse,
  DataSafetyStatus,
  DeleteCollectionResponse,
  DocumentAsset,
  DocumentDraft,
  DocumentListResponse,
  DocumentRevision,
  DerivedResult,
  DerivedResultListResponse,
  DerivedPreview,
  DerivedTask,
  KnowledgeDocument,
  KnowledgeCollection,
  KnowledgeTag,
  ImportApplyResult,
  ImportPreview,
  RecentFilter,
  ReextractionPreview,
} from "../shared/types.js";

const mutableFs = createRequire(import.meta.url)("node:fs") as {
  fsyncSync: typeof fsyncSync;
  renameSync: typeof renameSync;
};

async function waitFor(base: string, cookie: string, id: string, status: KnowledgeDocument["status"]) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/api/documents/${id}`, { headers: { Cookie: cookie } });
    const document = (await response.json()) as KnowledgeDocument;
    if (document.status === status) return document;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Document ${id} did not reach ${status}`);
}

test("local API authenticates, captures, edits, exports, deduplicates, and retries", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zhiye-api-")));
  const directory = join(root, "data");
  const attempts = new Map<string, number>();
  let markSlowCaptureStarted!: () => void;
  let releaseSlowCapture!: () => void;
  const slowCaptureStarted = new Promise<void>((resolve) => { markSlowCaptureStarted = resolve; });
  const capture: CaptureFunction = async (url) => {
    const attempt = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, attempt);
    if (url.includes("retry") && attempt === 1) {
      throw Object.assign(new Error("temporary failure"), { code: "HTTP_ERROR" });
    }
    if (url.includes("slow-close")) {
      markSlowCaptureStarted();
      await new Promise<void>((resolve) => { releaseSlowCapture = resolve; });
    }
    return {
      extractorVersion: "test-extractor@1",
      title: "Captured article",
      author: "Author",
      publishedAt: null,
      finalUrl: url,
      canonicalUrl: url,
      markdown: "# Captured\n\nKnowledge body",
      mode: "http",
      warning: null,
      rawHtml: "<!doctype html><title>Snapshot article</title><article><h1>Snapshot article</h1><p>Knowledge body preserved in the local HTML snapshot for a safe extraction preview.</p></article>",
      httpStatus: 200,
    };
  };
  const desktopCloseAttempts: string[] = [];
  const database = openDatabase(directory);
  const app = createApp({
    dataDir: directory,
    database,
    bootstrapToken: "bootstrap-test-token",
    sessionToken: "session-test-token",
    capture,
    onDesktopCloseReady: (attemptId) => {
      desktopCloseAttempts.push(attemptId);
    },
  });
  const server = createServer((request, response) => void app.handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
    assert.equal((await fetch(`${base}/api/documents`)).status, 401);
    const launch = await fetch(`${base}/launch?token=bootstrap-test-token`, { redirect: "manual" });
    assert.equal(launch.status, 302);
    assert.match(launch.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict; Path=\//u);
    assert.equal(
      (await fetch(`${base}/launch?token=bootstrap-test-token`, { redirect: "manual" })).status,
      401,
    );
    const cookie = (launch.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const queueResponse = await fetch(`${base}/api/capture-queue`, { headers: { Cookie: cookie } });
    const initialDataEpoch = queueResponse.headers.get("x-zhiye-data-epoch");
    assert.ok(initialDataEpoch);
    const jsonHeaders: Record<string, string> = {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
      "X-Zhiye-Data-Epoch": initialDataEpoch,
    };
    assert.deepEqual(
      (await queueResponse.json()) as CaptureQueueStatus,
      { paused: false, active: 0, queued: 0 },
    );
    const missingEpoch = await fetch(`${base}/api/capture-queue`, {
      method: "PATCH",
      headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    assert.equal(missingEpoch.status, 409);
    assert.equal(missingEpoch.headers.get("x-zhiye-data-epoch"), initialDataEpoch);
    assert.equal(((await missingEpoch.json()) as { error: { code: string } }).error.code, "STALE_DATA_EPOCH");
    assert.deepEqual(
      await (await fetch(`${base}/api/settings/recent-filters`, { headers: { Cookie: cookie } })).json(),
      { filters: [], revision: 0 },
    );
    assert.deepEqual(
      await (await fetch(`${base}/api/settings/onboarding`, { headers: { Cookie: cookie } })).json(),
      { completed: false, revision: 0 },
    );
    const completedOnboarding = await fetch(`${base}/api/settings/onboarding`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ completed: true, revision: 0 }),
    });
    assert.equal(completedOnboarding.status, 200);
    assert.deepEqual(await completedOnboarding.json(), { completed: true, revision: 1 });
    const staleOnboarding = await fetch(`${base}/api/settings/onboarding`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ completed: false, revision: 0 }),
    });
    assert.equal(staleOnboarding.status, 409);
    assert.equal(((await staleOnboarding.json()) as { error: { code: string } }).error.code, "ONBOARDING_CONFLICT");
    const recentFilters: RecentFilter[] = [{
      label: "最近研究",
      query: "knowledge",
      scope: "body",
      tag: "Research",
      collectionId: "",
      status: "ready",
      favorite: true,
      unorganized: false,
      captureMode: "http",
      from: "2026-08-01",
      to: "2026-08-11",
      sort: "updated",
    }];
    const savedRecentFilters = await fetch(`${base}/api/settings/recent-filters`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ filters: recentFilters, revision: 0 }),
    });
    assert.equal(savedRecentFilters.status, 200);
    assert.deepEqual(await savedRecentFilters.json(), { filters: recentFilters, revision: 1 });
    const staleRecentFilters = await fetch(`${base}/api/settings/recent-filters`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ filters: [], revision: 0 }),
    });
    assert.equal(staleRecentFilters.status, 409);
    const tooManyRecentFilters = await fetch(`${base}/api/settings/recent-filters`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ filters: Array.from({ length: 6 }, () => recentFilters[0]), revision: 1 }),
    });
    assert.equal(tooManyRecentFilters.status, 400);
    assert.deepEqual(
      await (await fetch(`${base}/api/settings/recent-filters`, { headers: { Cookie: cookie } })).json(),
      { filters: recentFilters, revision: 1 },
    );
    const paused = (await (
      await fetch(`${base}/api/capture-queue`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ paused: true }),
      })
    ).json()) as CaptureQueueStatus;
    assert.equal(paused.paused, true);
    const urlPreviewResponse = await fetch(`${base}/api/imports/preview`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        kind: "urls",
        content: "https://batch-one.example/article\nnot-a-url\nhttps://batch-one.example/article",
      }),
    });
    assert.equal(urlPreviewResponse.status, 201);
    const urlPreview = (await urlPreviewResponse.json()) as ImportPreview;
    assert.deepEqual(urlPreview.counts, { total: 3, valid: 1, duplicate: 1, invalid: 1 });
    const urlApplied = (await (
      await fetch(`${base}/api/imports/${urlPreview.id}/apply`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ strategy: "skip" }),
      })
    ).json()) as ImportApplyResult;
    assert.deepEqual(urlApplied.counts, { created: 1, updated: 0, skipped: 1, conflicts: 0, failed: 1 });
    assert.deepEqual(
      await (
        await fetch(`${base}/api/imports/${urlPreview.id}/apply`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ strategy: "copy" }),
        })
      ).json(),
      urlApplied,
    );

    const bookmarkPreview = (await (
      await fetch(`${base}/api/imports/preview`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          kind: "bookmarks",
          content: '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://book.example/?a=1&amp;b=2">Book</A></DL>',
        }),
      })
    ).json()) as ImportPreview;
    assert.equal(bookmarkPreview.items[0]?.sourceUrl, "https://book.example/?a=1&b=2");
    assert.equal(
      (await fetch(`${base}/api/imports/${bookmarkPreview.id}`, {
        method: "DELETE", headers: jsonHeaders, body: "{}",
      })).status,
      204,
    );

    const markdownPreview = (await (
      await fetch(`${base}/api/imports/preview`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          kind: "markdown",
          files: [
            { path: "notes/imported.md", content: '---\ntitle: "Imported note"\ntags: []\ncollections: []\nfavorite: true\nsource_note: "From disk"\ncustom: "kept"\n---\n\n# Body' },
            { path: "broken.md", content: "---\ntitle: nope\nBody" },
          ],
        }),
      })
    ).json()) as ImportPreview;
    assert.deepEqual(markdownPreview.counts, { total: 2, valid: 1, duplicate: 0, invalid: 1 });
    assert.match(markdownPreview.items[0]?.warnings[0] ?? "", /custom/u);
    const markdownApplied = (await (
      await fetch(`${base}/api/imports/${markdownPreview.id}/apply`, {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ strategy: "skip" }),
      })
    ).json()) as ImportApplyResult;
    assert.deepEqual(markdownApplied.counts, { created: 1, updated: 0, skipped: 0, conflicts: 0, failed: 1 });
    const importedMarkdown = (await (
      await fetch(`${base}/api/documents/${markdownApplied.items[0]?.documentId}`, { headers: { Cookie: cookie } })
    ).json()) as KnowledgeDocument;
    assert.equal(importedMarkdown.status, "ready");
    assert.equal(importedMarkdown.favorite, true);
    assert.deepEqual(importedMarkdown.tags, []);
    assert.deepEqual(importedMarkdown.collections, []);
    assert.match(importedMarkdown.markdown, /custom: "kept"/u);

    const portableExport = await fetch(`${base}/api/exports/portable`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ scope: "selected", documentIds: [importedMarkdown.id] }),
    });
    assert.equal(portableExport.status, 200);
    assert.equal(portableExport.headers.get("content-type"), "application/zip");
    assert.match(portableExport.headers.get("content-disposition") ?? "", /zhiye-export-\d{4}-\d{2}-\d{2}\.zip/u);
    const portableArchive = Buffer.from(await portableExport.arrayBuffer());
    const bundlePreviewResponse = await fetch(`${base}/api/imports/bundle/preview`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: base,
        "Content-Type": "application/zip",
        "X-Zhiye-Data-Epoch": initialDataEpoch,
      },
      body: portableArchive,
    });
    assert.equal(bundlePreviewResponse.status, 201);
    const bundlePreview = (await bundlePreviewResponse.json()) as ImportPreview;
    assert.deepEqual(bundlePreview.counts, { total: 1, valid: 0, duplicate: 1, invalid: 0, assets: 0 });
    assert.equal((await fetch(`${base}/api/imports/${bundlePreview.id}`, {
      method: "DELETE", headers: jsonHeaders, body: "{}",
    })).status, 204);

    const cancellable = ((await (
      await fetch(`${base}/api/documents`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ url: "https://example.com/cancel-me" }),
      })
    ).json()) as CreateDocumentResponse).document;
    assert.equal(paused.active, 0);
    const cancelled = await fetch(`${base}/api/documents/${cancellable.id}/cancel`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}",
    });
    assert.equal(cancelled.status, 200);
    assert.equal(((await cancelled.json()) as KnowledgeDocument).errorCode, "CAPTURE_CANCELLED");
    assert.equal(
      (
        await fetch(`${base}/api/documents/${cancellable.id}/retry`, {
          method: "POST",
          headers: jsonHeaders,
          body: "{}",
        })
      ).status,
      202,
    );
    const resumed = (await (
      await fetch(`${base}/api/capture-queue`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ paused: false }),
      })
    ).json()) as CaptureQueueStatus;
    assert.equal(resumed.paused, false);
    const cancellableReady = await waitFor(base, cookie, cancellable.id, "ready");

    const collectionResponse = await fetch(`${base}/api/collections`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: "Projects" }),
    });
    assert.equal(collectionResponse.status, 201);
    const collection = (await collectionResponse.json()) as KnowledgeCollection;
    assert.equal(collection.documentCount, 0);
    assert.equal(
      (
        await fetch(`${base}/api/collections`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ name: "projects" }),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await fetch(`${base}/api/collections`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ name: "x".repeat(101) }),
        })
      ).status,
      400,
    );
    const missingCollection = await fetch(`${base}/api/documents/${cancellable.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ revision: cancellableReady.revision, collectionIds: ["missing"] }),
    });
    assert.equal(missingCollection.status, 400);
    assert.equal(
      ((await missingCollection.json()) as { error: { code: string } }).error.code,
      "INVALID_COLLECTION_IDS",
    );
    assert.equal(
      (
        await fetch(`${base}/api/documents/${cancellable.id}`, {
          method: "PATCH",
          headers: jsonHeaders,
          body: JSON.stringify({ revision: cancellableReady.revision, publishedAt: "2026-02-30" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/api/documents/${cancellable.id}`, {
          method: "PATCH",
          headers: jsonHeaders,
          body: JSON.stringify({ revision: cancellableReady.revision, sourceNote: "x".repeat(50_001) }),
        })
      ).status,
      400,
    );
    const organizedResponse = await fetch(`${base}/api/documents/${cancellable.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({
        revision: cancellableReady.revision,
        author: "Manual author",
        publishedAt: "2026-08-10",
        sourceNote: "Primary source note",
        favorite: true,
        archived: true,
        collectionIds: [collection.id],
      }),
    });
    assert.equal(organizedResponse.status, 200);
    const organized = (await organizedResponse.json()) as KnowledgeDocument;
    assert.equal(organized.author, "Manual author");
    assert.equal(organized.publishedAt, "2026-08-10");
    assert.equal(organized.sourceNote, "Primary source note");
    assert.equal(organized.favorite, true);
    assert.ok(organized.archivedAt);
    assert.deepEqual(organized.collections, [{ id: collection.id, name: "Projects" }]);
    const organizedExport = await (
      await fetch(`${base}/api/documents/${cancellable.id}/export.md`, { headers: { Cookie: cookie } })
    ).text();
    assert.match(organizedExport, /collections: \["Projects"\]/u);
    assert.match(organizedExport, /favorite: true/u);
    assert.match(organizedExport, /archived_at: "\d{4}-\d{2}-\d{2}T/u);
    assert.match(organizedExport, /source_note: "Primary source note"/u);
    assert.equal(
      (
        (await (await fetch(`${base}/api/collections`, { headers: { Cookie: cookie } })).json()) as KnowledgeCollection[]
      )[0]?.documentCount,
      1,
    );
    const renamedCollection = (await (
      await fetch(`${base}/api/collections/${collection.id}`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ name: "Reading list" }),
      })
    ).json()) as KnowledgeCollection;
    assert.equal(renamedCollection.name, "Reading list");
    const collectionDelete = await fetch(`${base}/api/collections/${collection.id}`, {
      method: "DELETE",
      headers: jsonHeaders,
      body: "{}",
    });
    assert.equal(collectionDelete.status, 200);
    assert.deepEqual(await collectionDelete.json(), {
      deleted: true,
      affectedDocuments: 1,
    } satisfies DeleteCollectionResponse);
    const afterCollectionDelete = (await (
      await fetch(`${base}/api/documents/${cancellable.id}`, { headers: { Cookie: cookie } })
    ).json()) as KnowledgeDocument;
    assert.equal(afterCollectionDelete.revision, organized.revision + 1);
    assert.deepEqual(afterCollectionDelete.collections, []);
    assert.deepEqual(await (await fetch(`${base}/api/collections`, { headers: { Cookie: cookie } })).json(), []);

    const dataSafety = (await (
      await fetch(`${base}/api/data-safety`, { headers: { Cookie: cookie } })
    ).json()) as DataSafetyStatus;
    assert.equal(dataSafety.mode, "ready");
    assert.equal(dataSafety.health?.database.integrityCheck[0], "ok");
    const manualBackup = await fetch(`${base}/api/data-safety/backups`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}",
    });
    assert.equal(manualBackup.status, 201);
    const backupRecord = (await manualBackup.json()) as BackupRecord;
    assert.equal(backupRecord.status, "verified");
    assert.equal(
      (
        await fetch(`${base}/api/data-safety/backups/${encodeURIComponent(backupRecord.id)}/verify`, {
          method: "POST",
          headers: jsonHeaders,
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/api/data-safety/backups/${encodeURIComponent(backupRecord.id)}/export.zhiye-backup`)).status,
      401,
    );
    assert.equal(
      (
        await fetch(
          `${base}/api/data-safety/backups/${encodeURIComponent(backupRecord.id)}/export.zhiye-backup?unexpected=1`,
          { headers: { Cookie: cookie } },
        )
      ).status,
      400,
    );
    const archiveResponse = await fetch(
      `${base}/api/data-safety/backups/${encodeURIComponent(backupRecord.id)}/export.zhiye-backup`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(archiveResponse.status, 200);
    assert.equal(archiveResponse.headers.get("content-type"), BACKUP_ARCHIVE_MIME);
    assert.match(archiveResponse.headers.get("content-disposition") ?? "", /^attachment; filename="backup-.+\.zhiye-backup"$/u);
    const fullBackupArchive = Buffer.from(await archiveResponse.arrayBuffer());
    assert.equal(Number(archiveResponse.headers.get("content-length")), fullBackupArchive.length);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!readdirSync(`${directory}-backups`).some((entry) => entry.startsWith(".zhiye-backup-export-"))) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      if (attempt === 99) assert.fail("completed backup export left its temporary archive behind");
    }
    const wrongBackupMime = await fetch(`${base}/api/data-safety/backups/import`, {
      method: "POST",
      headers: jsonHeaders,
      body: fullBackupArchive,
    });
    assert.equal(wrongBackupMime.status, 415);
    assert.equal(((await wrongBackupMime.json()) as { error: { code: string } }).error.code, "BACKUP_ARCHIVE_REQUIRED");
    const missingLength = await new Promise<{ status: number; code: string }>((resolve, reject) => {
      const request = httpRequest(`${base}/api/data-safety/backups/import`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: base,
          "Content-Type": BACKUP_ARCHIVE_MIME,
          "Transfer-Encoding": "chunked",
          "X-Zhiye-Data-Epoch": initialDataEpoch,
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error: { code: string } };
          resolve({ status: response.statusCode ?? 0, code: payload.error.code });
        });
      });
      request.on("error", reject);
      request.end(fullBackupArchive);
    });
    assert.deepEqual(missingLength, { status: 411, code: "CONTENT_LENGTH_REQUIRED" });
    const importedBackupResponse = await fetch(`${base}/api/data-safety/backups/import`, {
      method: "POST",
      headers: { ...jsonHeaders, "Content-Type": BACKUP_ARCHIVE_MIME },
      body: fullBackupArchive,
    });
    assert.equal(importedBackupResponse.status, 201);
    const importedBackupRecord = (await importedBackupResponse.json()) as BackupRecord;
    assert.equal(importedBackupRecord.status, "verified");
    assert.notEqual(importedBackupRecord.id, backupRecord.id);
    for (const automaticRetentionCount of [0, 101]) {
      const response = await fetch(`${base}/api/data-safety/settings`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ automaticRetentionCount }),
      });
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, "INVALID_RETENTION");
    }

    const crossOrigin = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: { ...jsonHeaders, Origin: "https://evil.example" },
      body: JSON.stringify({ url: "https://example.com/blocked" }),
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(
      (
        await fetch(`${base}/api/documents`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: base },
          body: JSON.stringify({ url: "https://example.com/no-json-header" }),
        })
      ).status,
      415,
    );

    const createdResponse = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ url: "https://example.com/article#fragment" }),
    });
    assert.equal(createdResponse.status, 202);
    const createdResult = (await createdResponse.json()) as CreateDocumentResponse;
    const created = createdResult.document;
    assert.equal(createdResult.duplicateKind, null);
    const ready = await waitFor(base, cookie, created.id, "ready");
    assert.equal(ready.sourceUrl, "https://example.com/article");

    const duplicate = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ url: "https://example.com/article" }),
    });
    assert.equal(duplicate.status, 200);
    const duplicateResult = (await duplicate.json()) as CreateDocumentResponse;
    assert.equal(duplicateResult.document.id, ready.id);
    assert.equal(duplicateResult.duplicateKind, "source");

    const canonicalUrl = "https://example.com/article-canonical";
    app.db.sql
      .prepare("UPDATE documents SET final_url = ?, canonical_url = ? WHERE id = ?")
      .run("https://example.com/article-final", canonicalUrl, ready.id);
    const resolvedDuplicate = (await (
      await fetch(`${base}/api/documents`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ url: canonicalUrl }),
      })
    ).json()) as CreateDocumentResponse;
    assert.equal(resolvedDuplicate.document.id, ready.id);
    assert.equal(resolvedDuplicate.duplicateKind, "resolved");
    const forcedDuplicate = (await (
      await fetch(`${base}/api/documents`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ url: canonicalUrl, force: true }),
      })
    ).json()) as CreateDocumentResponse;
    assert.equal(forcedDuplicate.created, true);
    assert.equal(forcedDuplicate.duplicateKind, "resolved");
    await waitFor(base, cookie, forcedDuplicate.document.id, "ready");
    const duplicateGuidance = (await (
      await fetch(`${base}/api/documents/${forcedDuplicate.document.id}/duplicate`, {
        headers: { Cookie: cookie },
      })
    ).json()) as DocumentListResponse["items"][number] | null;
    assert.equal(duplicateGuidance?.id, ready.id);

    const draftResponse = await fetch(`${base}/api/documents/${ready.id}/draft`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        expectedDraftRevision: null,
        baseRevision: ready.revision,
        title: `  ${ready.title}  `,
        markdown: "# Human edit",
        tags: ["Inbox"],
      }),
    });
    assert.equal(draftResponse.status, 200);
    const firstDraft = (await draftResponse.json()) as DocumentDraft;
    assert.equal(firstDraft.draftRevision, 1);
    assert.equal(firstDraft.title, ready.title);
    const newerDraftResponse = await fetch(`${base}/api/documents/${ready.id}/draft`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        expectedDraftRevision: firstDraft.draftRevision,
        baseRevision: ready.revision,
        title: ready.title,
        markdown: "# Human edit",
        tags: ["Inbox"],
      }),
    });
    const newerDraft = (await newerDraftResponse.json()) as DocumentDraft;
    assert.equal(newerDraft.draftRevision, 2);
    const staleDraftPut = await fetch(`${base}/api/documents/${ready.id}/draft`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        expectedDraftRevision: firstDraft.draftRevision,
        baseRevision: ready.revision,
        title: ready.title,
        markdown: "# Stale draft",
        tags: [],
      }),
    });
    assert.equal(staleDraftPut.status, 409);
    const staleDraftPayload = (await staleDraftPut.json()) as {
      error: { code: string; draft: DocumentDraft };
    };
    assert.equal(staleDraftPayload.error.code, "DRAFT_CONFLICT");
    assert.equal(staleDraftPayload.error.draft.draftRevision, newerDraft.draftRevision);
    assert.equal(staleDraftPayload.error.draft.markdown, "# Human edit");
    const staleDraftDelete = await fetch(`${base}/api/documents/${ready.id}/draft`, {
      method: "DELETE",
      headers: jsonHeaders,
      body: JSON.stringify({ draftRevision: firstDraft.draftRevision }),
    });
    assert.equal(staleDraftDelete.status, 409);
    assert.equal(
      ((await staleDraftDelete.json()) as { error: { code: string } }).error.code,
      "DRAFT_CONFLICT",
    );
    assert.equal(
      ((await (await fetch(`${base}/api/documents/${ready.id}/draft`, { headers: { Cookie: cookie } })).json()) as DocumentDraft).draftRevision,
      2,
    );
    assert.equal(
      newerDraft.markdown,
      "# Human edit",
    );
    const currentDraftDelete = await fetch(`${base}/api/documents/${ready.id}/draft`, {
      method: "DELETE",
      headers: jsonHeaders,
      body: JSON.stringify({ draftRevision: newerDraft.draftRevision }),
    });
    assert.equal(currentDraftDelete.status, 204);
    const recreatedDraftResponse = await fetch(`${base}/api/documents/${ready.id}/draft`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        expectedDraftRevision: null,
        baseRevision: ready.revision,
        title: ready.title,
        markdown: "# Human edit",
        tags: ["Inbox"],
      }),
    });
    const recreatedDraft = (await recreatedDraftResponse.json()) as DocumentDraft;
    assert.ok(recreatedDraft.draftRevision > newerDraft.draftRevision);

    const editedResponse = await fetch(`${base}/api/documents/${ready.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({
        revision: ready.revision,
        title: ready.title,
        markdown: "# Human edit",
        tags: ["Inbox"],
      }),
    });
    assert.equal(editedResponse.status, 200);
    const edited = (await editedResponse.json()) as KnowledgeDocument;
    assert.deepEqual(edited.tags, ["Inbox"]);
    assert.equal(
      await (await fetch(`${base}/api/documents/${ready.id}/draft`, { headers: { Cookie: cookie } })).json(),
      null,
    );
    assert.deepEqual(await (await fetch(`${base}/api/tags`, { headers: { Cookie: cookie } })).json(), ["Inbox"]);
    assert.deepEqual(
      (await (await fetch(`${base}/api/tags/manage`, { headers: { Cookie: cookie } })).json()) as KnowledgeTag[],
      [{ name: "Inbox", documentCount: 1 }],
    );
    const filtered = (await (
      await fetch(`${base}/api/documents?q=Human&scope=body&status=ready&captureMode=http&sort=title&page=1`, {
        headers: { Cookie: cookie },
      })
    ).json()) as DocumentListResponse;
    assert.equal(filtered.total, 1);
    assert.equal((await fetch(`${base}/api/documents?page=1&page=2`, { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await fetch(`${base}/api/documents?unknown=1`, { headers: { Cookie: cookie } })).status, 400);
    const staleBatch = await fetch(`${base}/api/documents/batch`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        documents: [{ id: edited.id, revision: edited.revision - 1 }],
        action: "add-tag",
        value: "Bulk",
      }),
    });
    assert.equal(staleBatch.status, 409);
    assert.equal(((await staleBatch.json()) as { error: { code: string } }).error.code, "BATCH_CONFLICT");
    assert.deepEqual(
      ((await (await fetch(`${base}/api/documents/${edited.id}`, { headers: { Cookie: cookie } })).json()) as KnowledgeDocument).tags,
      ["Inbox"],
    );

    const captures = (await (
      await fetch(`${base}/api/documents/${ready.id}/captures`, { headers: { Cookie: cookie } })
    ).json()) as CaptureHistoryItem[];
    assert.equal(captures.length, 1);
    assert.equal(captures[0].status, "ready");
    assert.equal(captures[0].snapshotStored, "available");
    assert.equal(captures[0].extractorVersion, "test-extractor@1");
    const previewResponse = await fetch(
      `${base}/api/documents/${ready.id}/captures/${captures[0].id}/reextract`,
      { method: "POST", headers: jsonHeaders, body: "{}" },
    );
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as ReextractionPreview;
    assert.equal(preview.captureId, captures[0].id);
    assert.equal(preview.baseRevision, edited.revision);
    assert.equal(preview.extractorVersion, "defuddle@0.19.2");
    assert.deepEqual(preview.before, { title: edited.title, markdown: "# Human edit" });
    assert.match(preview.after.markdown, /Knowledge body/u);
    const unchangedAfterPreview = (await (
      await fetch(`${base}/api/documents/${ready.id}`, { headers: { Cookie: cookie } })
    ).json()) as KnowledgeDocument;
    assert.equal(unchangedAfterPreview.revision, edited.revision);
    assert.equal(unchangedAfterPreview.markdown, "# Human edit");

    const revisions = (await (
      await fetch(`${base}/api/documents/${ready.id}/revisions`, { headers: { Cookie: cookie } })
    ).json()) as DocumentRevision[];
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0].revision, edited.revision);
    assert.equal(revisions[0].markdown, "# Human edit");
    assert.equal(revisions[1].markdown, "# Captured\n\nKnowledge body");

    const secondEditResponse = await fetch(`${base}/api/documents/${ready.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ revision: edited.revision, markdown: "# Second edit", tags: ["Changed"] }),
    });
    assert.equal(secondEditResponse.status, 200);
    const secondEdit = (await secondEditResponse.json()) as KnowledgeDocument;

    const staleRestore = await fetch(
      `${base}/api/documents/${ready.id}/revisions/${edited.revision}/restore`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ revision: edited.revision }),
      },
    );
    assert.equal(staleRestore.status, 409);
    const restoredRevisionResponse = await fetch(
      `${base}/api/documents/${ready.id}/revisions/${edited.revision}/restore`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ revision: secondEdit.revision }),
      },
    );
    assert.equal(restoredRevisionResponse.status, 200);
    const restoredRevision = (await restoredRevisionResponse.json()) as KnowledgeDocument;
    assert.equal(restoredRevision.markdown, "# Human edit");
    assert.deepEqual(restoredRevision.tags, ["Inbox"]);

    const conflict = await fetch(`${base}/api/documents/${ready.id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ revision: ready.revision, title: "Stale" }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(
      ((await conflict.json()) as { error: { document: KnowledgeDocument } }).error.document.revision,
      restoredRevision.revision,
    );

    const storedSummary = database.saveDerivedResult({
      documentId: ready.id,
      type: "summary",
      model: "fake-model",
      endpointId: "fake-local",
      promptVersion: "summary-v1",
      inputHash: derivedInputHash(restoredRevision.title, restoredRevision.markdown),
      output: "DERIVED_ONLY_SUMMARY",
      durationMs: 5,
      sourceChars: restoredRevision.title.length + restoredRevision.markdown.length,
      sentChars: restoredRevision.title.length + restoredRevision.markdown.length,
      truncated: false,
    });
    const storedOutline = database.saveDerivedResult({
      documentId: ready.id,
      type: "outline",
      model: "fake-model",
      endpointId: "fake-local",
      promptVersion: "outline-v1",
      inputHash: derivedInputHash(restoredRevision.title, restoredRevision.markdown),
      output: "DERIVED_ONLY_OUTLINE",
      durationMs: 6,
      sourceChars: restoredRevision.title.length + restoredRevision.markdown.length,
      sentChars: restoredRevision.title.length + restoredRevision.markdown.length,
      truncated: false,
    });
    assert.equal(storedSummary.kind, "saved");
    assert.equal(storedOutline.kind, "saved");
    if (storedSummary.kind !== "saved" || storedOutline.kind !== "saved") {
      throw new Error("Derived results were not saved");
    }
    const derivedResponse = await fetch(`${base}/api/documents/${ready.id}/derived-results`, {
      headers: { Cookie: cookie },
    });
    assert.equal(derivedResponse.status, 200);
    assert.deepEqual(
      ((await derivedResponse.json()) as DerivedResultListResponse),
      { items: database.listDerivedResults(ready.id)!.items, page: 1, pageSize: 30, total: 2 },
    );
    assert.equal((await fetch(`${base}/api/documents/${ready.id}/derived-results`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ output: "must not be accepted" }),
    })).status, 404);
    const pinned = await fetch(
      `${base}/api/documents/${ready.id}/derived-results/${storedSummary.result.id}`,
      { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ pinned: true }) },
    );
    assert.equal(pinned.status, 200);
    assert.equal(((await pinned.json()) as DerivedResult).pinned, true);

    const exported = await fetch(`${base}/api/documents/${ready.id}/export.md`, {
      headers: { Cookie: cookie },
    });
    assert.equal(exported.status, 200);
    const exportedText = await exported.text();
    assert.match(exportedText, /^---\ntitle: "Captured article"\nsource: "https:\/\/example\.com\/article"/u);
    assert.match(
      exportedText,
      /tags: \["Inbox"\]\ncollections: \[\]\nfavorite: false\narchived_at: null\nsource_note: ""\n---\n\n# Human edit\n$/u,
    );
    assert.doesNotMatch(exportedText, /DERIVED_ONLY/u);

    const deletedOne = await fetch(
      `${base}/api/documents/${ready.id}/derived-results/${storedOutline.result.id}`,
      { method: "DELETE", headers: jsonHeaders, body: "{}" },
    );
    assert.equal(deletedOne.status, 204);
    const unconfirmedDelete = await fetch(`${base}/api/derived-results`, {
      method: "DELETE",
      headers: jsonHeaders,
      body: JSON.stringify({ confirm: false }),
    });
    assert.equal(unconfirmedDelete.status, 400);
    const deletedAll = await fetch(`${base}/api/derived-results`, {
      method: "DELETE",
      headers: jsonHeaders,
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(deletedAll.status, 200);
    assert.deepEqual(await deletedAll.json(), { deleted: true, deletedResults: 1 });
    assert.deepEqual(
      await (await fetch(`${base}/api/documents/${ready.id}/derived-results`, { headers: { Cookie: cookie } })).json(),
      { items: [], page: 1, pageSize: 30, total: 0 },
    );

    const failedCreate = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ url: "https://example.com/retry" }),
    });
    const failedId = ((await failedCreate.json()) as CreateDocumentResponse).document.id;
    await waitFor(base, cookie, failedId, "failed");
    const retry = await fetch(`${base}/api/documents/${failedId}/retry`, {
      method: "POST",
      headers: jsonHeaders,
    });
    assert.equal(retry.status, 202);
    await waitFor(base, cookie, failedId, "ready");

    assert.equal((await fetch(`${base}/api/documents?trash=all`, { headers: { Cookie: cookie } })).status, 400);
    const snapshotPath = (
      app.db.sql
        .prepare("SELECT snapshot_path FROM captures WHERE document_id = ? AND snapshot_path IS NOT NULL")
        .get(ready.id) as { snapshot_path: string }
    ).snapshot_path;
    assert.equal(existsSync(join(directory, snapshotPath)), true);
    const softDelete = await fetch(`${base}/api/documents/${ready.id}`, {
      method: "DELETE",
      headers: jsonHeaders,
      body: JSON.stringify({ revision: restoredRevision.revision }),
    });
    assert.equal(softDelete.status, 200);
    assert.ok(((await softDelete.json()) as KnowledgeDocument).deletedAt);
    assert.deepEqual(await (await fetch(`${base}/api/tags`, { headers: { Cookie: cookie } })).json(), []);
    assert.deepEqual(
      await (await fetch(`${base}/api/tags?trash=only`, { headers: { Cookie: cookie } })).json(),
      ["Inbox"],
    );
    assert.equal((await fetch(`${base}/api/tags?trash=all`, { headers: { Cookie: cookie } })).status, 400);
    const defaultList = (await (
      await fetch(`${base}/api/documents?q=Human`, { headers: { Cookie: cookie } })
    ).json()) as DocumentListResponse;
    assert.equal(defaultList.total, 0);
    const trashList = (await (
      await fetch(`${base}/api/documents?trash=only`, { headers: { Cookie: cookie } })
    ).json()) as DocumentListResponse;
    assert.equal(trashList.items.some(({ id }) => id === ready.id), true);
    assert.equal(
      (
        await fetch(`${base}/api/documents/${ready.id}`, {
          method: "PATCH",
          headers: jsonHeaders,
          body: JSON.stringify({ revision: restoredRevision.revision + 1, title: "Trash edit" }),
        })
      ).status,
      409,
    );
    const restore = await fetch(`${base}/api/documents/${ready.id}/restore`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ revision: restoredRevision.revision + 1 }),
    });
    assert.equal(restore.status, 200);
    const restored = (await restore.json()) as KnowledgeDocument;
    assert.equal(restored.deletedAt, null);
    const deleteAgain = await fetch(`${base}/api/documents/${ready.id}`, {
      method: "DELETE",
      headers: jsonHeaders,
      body: JSON.stringify({ revision: restored.revision }),
    });
    assert.equal(deleteAgain.status, 200);
    const trashedAgain = (await deleteAgain.json()) as KnowledgeDocument;
    const stalePermanent = await fetch(`${base}/api/documents/${ready.id}/permanent`, {
      method: "DELETE",
      headers: jsonHeaders,
      body: JSON.stringify({ revision: trashedAgain.revision - 1, draftRevision: null }),
    });
    assert.equal(stalePermanent.status, 409);
    assert.equal(existsSync(join(directory, snapshotPath)), true);
    const permanentDraftResponse = await fetch(`${base}/api/documents/${ready.id}/draft`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        expectedDraftRevision: null,
        baseRevision: trashedAgain.revision,
        title: trashedAgain.title,
        markdown: "# Draft in another window",
        tags: trashedAgain.tags,
      }),
    });
    const permanentDraft = (await permanentDraftResponse.json()) as DocumentDraft;
    const blockedPermanent = await fetch(`${base}/api/documents/${ready.id}/permanent`, {
      method: "DELETE",
      headers: jsonHeaders,
      body: JSON.stringify({ revision: trashedAgain.revision, draftRevision: null }),
    });
    assert.equal(blockedPermanent.status, 409);
    assert.equal(
      ((await blockedPermanent.json()) as { error: { code: string } }).error.code,
      "DRAFT_EXISTS",
    );
    const permanent = await fetch(`${base}/api/documents/${ready.id}/permanent`, {
      method: "DELETE",
      headers: jsonHeaders,
      body: JSON.stringify({
        revision: trashedAgain.revision,
        draftRevision: permanentDraft.draftRevision,
      }),
    });
    assert.equal(permanent.status, 204);
    assert.equal(existsSync(join(directory, snapshotPath)), false);
    assert.equal((await fetch(`${base}/api/documents/${ready.id}`, { headers: { Cookie: cookie } })).status, 404);

    const originalFsyncSync = mutableFs.fsyncSync;
    let failNextDirectorySync = true;
    mutableFs.fsyncSync = ((...args: Parameters<typeof fsyncSync>) => {
      if (failNextDirectorySync) {
        failNextDirectorySync = false;
        throw new Error("simulated snapshot directory sync failure");
      }
      return originalFsyncSync(...args);
    }) as typeof fsyncSync;
    syncBuiltinESMExports();
    let failedSnapshot!: KnowledgeDocument;
    try {
      const response = await fetch(`${base}/api/documents`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ url: "https://example.com/snapshot-sync-failure" }),
      });
      failedSnapshot = ((await response.json()) as CreateDocumentResponse).document;
      await waitFor(base, cookie, failedSnapshot.id, "failed");
    } finally {
      mutableFs.fsyncSync = originalFsyncSync;
      syncBuiltinESMExports();
    }
    assert.equal(
      (
        app.db.sql.prepare("SELECT snapshot_path FROM captures WHERE document_id = ?").get(failedSnapshot.id) as {
          snapshot_path: string | null;
        }
      ).snapshot_path,
      null,
    );

    const slowCapture = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ url: "https://example.com/slow-close" }),
    });
    assert.equal(slowCapture.status, 202);
    await slowCaptureStarted;
    const pausedDuringCapture = (await (
      await fetch(`${base}/api/capture-queue`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ paused: true }),
      })
    ).json()) as CaptureQueueStatus;
    assert.equal(pausedDuringCapture.paused, true);
    assert.equal(pausedDuringCapture.active, 1);
    const backupDuringCapture = fetch(`${base}/api/data-safety/backups`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}",
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = (await (
        await fetch(`${base}/api/data-safety`, { headers: { Cookie: cookie } })
      ).json()) as DataSafetyStatus;
      if (value.maintenance) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (attempt === 99) assert.fail("backup did not enter maintenance mode");
    }
    let closeResolved = false;
    const closeReady = fetch(`${base}/api/desktop/close-ready`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ attemptId: "314" }),
    }).then((response) => {
      closeResolved = true;
      return response;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeResolved, false);
    releaseSlowCapture();
    assert.equal((await backupDuringCapture).status, 201);
    assert.equal((await closeReady).status, 200);
    assert.equal(
      ((await (await fetch(`${base}/api/capture-queue`, { headers: { Cookie: cookie } })).json()) as CaptureQueueStatus)
        .paused,
      true,
    );
    await fetch(`${base}/api/capture-queue`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ paused: false }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(desktopCloseAttempts, ["314"]);

    await fetch(`${base}/api/capture-queue`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ paused: true }),
    });
    const missingRestore = await fetch(`${base}/api/data-safety/backups/missing/restore`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}",
    });
    assert.equal(missingRestore.status, 404);
    assert.equal(
      ((await (await fetch(`${base}/api/capture-queue`, { headers: { Cookie: cookie } })).json()) as CaptureQueueStatus)
        .paused,
      true,
    );
    const beforeRestore = (await (
      await fetch(`${base}/api/documents/${cancellable.id}`, { headers: { Cookie: cookie } })
    ).json()) as KnowledgeDocument;
    assert.equal(app.db.setLlmSettings({
      enabled: true,
      target: "local",
      remote: { endpointUrl: "", model: "" },
      local: { endpointUrl: "http://127.0.0.1:9/v1/chat/completions", model: "restore-test", trusted: true },
    }, 0).kind, "updated");
    const restorePreview = (await (await fetch(`${base}/api/documents/${cancellable.id}/derived-preview`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ type: "summary", revision: beforeRestore.revision }),
    })).json()) as DerivedPreview;
    const preRestoreTask = (await (await fetch(`${base}/api/documents/${cancellable.id}/derived-task`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        type: restorePreview.type,
        revision: restorePreview.revision,
        inputHash: restorePreview.inputHash,
        sendHash: restorePreview.sendHash,
        settingsRevision: restorePreview.settingsRevision,
      }),
    })).json()) as DerivedTask;
    const staleJsonHeaders = { ...jsonHeaders };
    const staleBody = JSON.stringify({ revision: beforeRestore.revision, sourceNote: "stale overwrite" });
    let markStaleBodyFlushed!: () => void;
    let finishStaleWrite!: () => void;
    const staleBodyFlushed = new Promise<void>((resolve) => {
      markStaleBodyFlushed = resolve;
    });
    const staleWriteResponse = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(`${base}/api/documents/${cancellable.id}`, {
        method: "PATCH",
        headers: { ...staleJsonHeaders, "Content-Length": Buffer.byteLength(staleBody) },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.on("error", reject);
      request.write(staleBody.slice(0, -1), markStaleBodyFlushed);
      finishStaleWrite = () => request.end(staleBody.slice(-1));
    });
    await staleBodyFlushed;
    await fetch(`${base}/api/data-safety`, { headers: { Cookie: cookie } });
    const restoreResponse = await fetch(
      `${base}/api/data-safety/backups/${encodeURIComponent(backupRecord.id)}/restore`,
      { method: "POST", headers: jsonHeaders, body: "{}" },
    );
    finishStaleWrite();
    assert.equal(restoreResponse.status, 200);
    const restoredDataEpoch = restoreResponse.headers.get("x-zhiye-data-epoch");
    assert.ok(restoredDataEpoch);
    assert.notEqual(restoredDataEpoch, initialDataEpoch);
    jsonHeaders["X-Zhiye-Data-Epoch"] = restoredDataEpoch;
    assert.equal((await fetch(`${base}/api/derived-tasks/${preRestoreTask.id}`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal(await (await fetch(`${base}/api/documents/${cancellable.id}/derived-task`, { headers: { Cookie: cookie } })).json(), null);
    const staleEpochWrite = await staleWriteResponse;
    assert.equal(staleEpochWrite.status, 409);
    assert.equal(
      (JSON.parse(staleEpochWrite.body) as { error: { code: string } }).error.code,
      "STALE_DATA_EPOCH",
    );
    const afterRestore = (await (
      await fetch(`${base}/api/documents/${cancellable.id}`, { headers: { Cookie: cookie } })
    ).json()) as KnowledgeDocument;
    assert.equal(afterRestore.revision, beforeRestore.revision);
    assert.equal(afterRestore.sourceNote, "Primary source note");
    assert.equal(
      ((await (await fetch(`${base}/api/capture-queue`, { headers: { Cookie: cookie } })).json()) as CaptureQueueStatus)
        .paused,
      true,
    );

    const originalRenameSync = mutableFs.renameSync;
    mutableFs.renameSync = ((...args: Parameters<typeof renameSync>) => {
      originalRenameSync(...args);
      if (
        String(args[0]) === directory &&
        basename(String(args[1])).startsWith(`.${basename(directory)}.previous-`)
      ) {
        mkdirSync(directory);
        writeFileSync(join(directory, "unexpected"), "do not replace");
      }
    }) as typeof renameSync;
    syncBuiltinESMExports();
    const failedRestore = await (async () => {
      try {
        return await fetch(
          `${base}/api/data-safety/backups/${encodeURIComponent(backupRecord.id)}/restore`,
          { method: "POST", headers: jsonHeaders, body: "{}" },
        );
      } finally {
        mutableFs.renameSync = originalRenameSync;
        syncBuiltinESMExports();
      }
    })();
    assert.equal(failedRestore.status, 400);
    assert.equal(
      ((await failedRestore.json()) as { error: { code: string } }).error.code,
      "RESTORE_CLEANUP_FAILED",
    );
    const recoveryStatus = (await (
      await fetch(`${base}/api/data-safety`, { headers: { Cookie: cookie } })
    ).json()) as DataSafetyStatus;
    assert.equal(recoveryStatus.mode, "recovery");
    const recoveryImport = await fetch(`${base}/api/data-safety/backups/import`, {
      method: "POST",
      headers: { ...jsonHeaders, "Content-Type": BACKUP_ARCHIVE_MIME },
      body: fullBackupArchive,
    });
    assert.equal(recoveryImport.status, 201);
    const recoveryImportedRecord = (await recoveryImport.json()) as BackupRecord;
    assert.equal(recoveryImportedRecord.status, "verified");
    const recoveryExport = await fetch(
      `${base}/api/data-safety/backups/${encodeURIComponent(recoveryImportedRecord.id)}/export.zhiye-backup`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(recoveryExport.status, 200);
    assert.equal(recoveryExport.headers.get("content-type"), BACKUP_ARCHIVE_MIME);
    assert.ok((await recoveryExport.arrayBuffer()).byteLength > 0);
    assert.equal((await fetch(`${base}/api/documents`, { headers: { Cookie: cookie } })).status, 503);
    const recoveryClose = await fetch(`${base}/api/desktop/close-ready`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ attemptId: "315" }),
    });
    assert.equal(recoveryClose.status, 200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(desktopCloseAttempts, ["314", "315"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("asset API exposes ready files and keeps per-image failures separate from capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-api-assets-"));
  const directory = join(root, "data");
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const capture: CaptureFunction = async (url) => ({
    title: "Images",
    author: null,
    publishedAt: null,
    finalUrl: url,
    canonicalUrl: null,
    markdown: "![ready](./ready.png)\n\n![failed](./failed.png)",
    mode: "http",
    warning: null,
    rawHtml: "<article><p>Images</p></article>",
    httpStatus: 200,
  });
  const app = createApp({
    dataDir: directory,
    database: openDatabase(directory),
    bootstrapToken: "asset-bootstrap-token",
    sessionToken: "asset-session-token",
    capture,
    fetchAsset: async (url) => {
      if (url.endsWith("failed.png")) throw Object.assign(new Error("image unavailable"), { code: "HTTP_ERROR" });
      return { body: png, contentType: "image/png", finalUrl: url, status: 200 };
    },
  });
  const server = createServer((request, response) => void app.handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const launch = await fetch(`${base}/launch?token=asset-bootstrap-token`, { redirect: "manual" });
    const cookie = (launch.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const initialResponse = await fetch(`${base}/api/documents`, { headers: { Cookie: cookie } });
    const dataEpoch = initialResponse.headers.get("x-zhiye-data-epoch");
    assert.ok(dataEpoch);
    const created = ((await (
      await fetch(`${base}/api/documents`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: base,
          "Content-Type": "application/json",
          "X-Zhiye-Data-Epoch": dataEpoch,
        },
        body: JSON.stringify({ url: "https://example.com/article/images" }),
      })
    ).json()) as CreateDocumentResponse).document;
    await waitFor(base, cookie, created.id, "ready");
    let assets: DocumentAsset[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      assets = (await (
        await fetch(`${base}/api/documents/${created.id}/assets`, { headers: { Cookie: cookie } })
      ).json()) as DocumentAsset[];
      if (assets.length === 2 && assets.every(({ status }) => status === "ready" || status === "failed")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const ready = assets.find((asset) => asset.status === "ready");
    const failed = assets.find((asset) => asset.status === "failed");
    const readyHash = ready?.assetHash;
    assert.ok(readyHash);
    assert.equal(failed?.errorCode, "HTTP_ERROR");
    assert.equal((await fetch(`${base}/api/assets/${readyHash}`)).status, 401);

    const response = await fetch(`${base}/api/assets/${readyHash}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    const etag = response.headers.get("etag");
    assert.ok(etag);
    assert.equal(
      (
        await fetch(`${base}/api/assets/${readyHash}`, {
          method: "HEAD",
          headers: { Cookie: cookie },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${base}/api/assets/${readyHash}`, {
          headers: { Cookie: cookie, "If-None-Match": etag },
        })
      ).status,
      304,
    );
    assert.equal(
      (await fetch(`${base}/api/assets/${readyHash.toUpperCase()}`, { headers: { Cookie: cookie } })).status,
      400,
    );
    const current = (await (
      await fetch(`${base}/api/documents/${created.id}`, { headers: { Cookie: cookie } })
    ).json()) as KnowledgeDocument;
    assert.equal(current.status, "ready");
    assert.equal(current.errorCode, null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted localhost establishes a cookie at the root without authenticating bare APIs", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-trusted-auth-"));
  const directory = join(root, "data");
  const staticDir = join(root, "static");
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>trusted</title>");
  const app = createApp({
    dataDir: directory,
    database: openDatabase(directory),
    staticDir,
    trustedLocalhost: true,
    startWorker: false,
  });
  const server = createServer((request, response) => void app.handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    assert.equal((await fetch(`${base}/api/documents`)).status, 401);
    const rootLaunch = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(rootLaunch.status, 302);
    assert.equal(rootLaunch.headers.get("location"), "/");
    const cookie = (rootLaunch.headers.get("set-cookie") ?? "").split(";", 1)[0];
    assert.match(cookie, /^zhiye_session=[A-Za-z0-9_-]{43}$/u);
    assert.match(rootLaunch.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict; Path=\//u);
    assert.equal((await fetch(`${base}/api/documents`)).status, 401);
    assert.equal((await fetch(`${base}/api/documents`, { headers: { Cookie: cookie } })).status, 200);

    const page = await fetch(`${base}/`, { headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>trusted<\/title>/u);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const legacyLaunch = await fetch(`${base}/launch?token=invalid`, { redirect: "manual" });
      assert.equal(legacyLaunch.status, 302);
      assert.equal(legacyLaunch.headers.get("location"), "/");
      assert.ok(legacyLaunch.headers.get("set-cookie"));
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
