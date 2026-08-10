import assert from "node:assert/strict";
import { existsSync, fsyncSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { createApp, type CaptureFunction } from "../server/app.js";
import { openDatabase } from "../server/db.js";
import type {
  BackupRecord,
  CaptureHistoryItem,
  DataSafetyStatus,
  DocumentDraft,
  DocumentListResponse,
  DocumentRevision,
  KnowledgeDocument,
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
  const root = mkdtempSync(join(tmpdir(), "zhiye-api-"));
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
  const app = createApp({
    dataDir: directory,
    database: openDatabase(directory),
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
    const jsonHeaders = { Cookie: cookie, Origin: base, "Content-Type": "application/json" };

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
    const created = (await createdResponse.json()) as KnowledgeDocument;
    const ready = await waitFor(base, cookie, created.id, "ready");
    assert.equal(ready.sourceUrl, "https://example.com/article");

    const duplicate = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ url: "https://example.com/article" }),
    });
    assert.equal(duplicate.status, 200);
    assert.equal(((await duplicate.json()) as KnowledgeDocument).id, ready.id);

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

    const exported = await fetch(`${base}/api/documents/${ready.id}/export.md`, {
      headers: { Cookie: cookie },
    });
    assert.equal(exported.status, 200);
    const exportedText = await exported.text();
    assert.match(exportedText, /^---\ntitle: "Captured article"\nsource: "https:\/\/example\.com\/article"/u);
    assert.match(exportedText, /tags: \["Inbox"\]\n---\n\n# Human edit\n$/u);

    const failedCreate = await fetch(`${base}/api/documents`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ url: "https://example.com/retry" }),
    });
    const failedId = ((await failedCreate.json()) as KnowledgeDocument).id;
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
      failedSnapshot = (await response.json()) as KnowledgeDocument;
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
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(desktopCloseAttempts, ["314"]);

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
