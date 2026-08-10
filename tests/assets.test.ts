import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cacheDocumentAssets,
  detectImageMime,
  extractImageUrls,
  type AssetFetchFunction,
} from "../server/assets.js";
import { openDatabase, type KnowledgeDatabase } from "../server/db.js";
import { cleanupOrphanSnapshots, dataSafetyHealth } from "../server/data-safety.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function readyDocument(db: KnowledgeDatabase, url: string, markdown: string) {
  const created = db.createOrGetDocument(url).document;
  const job = db.claimNextCapture();
  assert.ok(job);
  return db.completeCapture(
    job,
    {
      title: "Asset article",
      author: null,
      publishedAt: null,
      finalUrl: url,
      canonicalUrl: null,
      markdown,
      mode: "http",
      warning: null,
      httpStatus: 200,
    },
    null,
  );
}

test("extracts final inline and reference image URLs outside code", () => {
  const markdown = [
    "![inline](./images/one.png \"title\")",
    "![hero][cover]",
    "![same](https://example.com/base/images/one.png)",
    "![ignored](data:image/png;base64,AA==)",
    "`![inline code](https://evil.example/inline.png)`",
    "```md",
    "![fenced](https://evil.example/fenced.png)",
    "```",
    "",
    "[cover]: </two.png>",
  ].join("\n");
  assert.deepEqual(extractImageUrls(markdown, "https://example.com/base/article"), [
    "https://example.com/base/images/one.png",
    "https://example.com/two.png",
  ]);
});

test("detects only the five supported image signatures", () => {
  const avif = Buffer.alloc(24);
  avif.writeUInt32BE(24, 0);
  avif.write("ftyp", 4, "ascii");
  avif.write("avif", 8, "ascii");
  avif.write("mif1", 16, "ascii");
  assert.equal(detectImageMime(Buffer.from([0xff, 0xd8, 0xff])), "image/jpeg");
  assert.equal(detectImageMime(png), "image/png");
  assert.equal(detectImageMime(Buffer.from("GIF89a")), "image/gif");
  assert.equal(detectImageMime(Buffer.from("RIFF0000WEBP")), "image/webp");
  assert.equal(detectImageMime(avif), "image/avif");
  assert.equal(detectImageMime(Buffer.from("<svg></svg>")), null);
});

test("caches valid images, records failures, and leaves the ready document unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-assets-"));
  const db = openDatabase(join(root, "data"));
  try {
    const document = readyDocument(
      db,
      "https://example.com/articles/one",
      "![local](../image.png)\n\n![bad](https://cdn.example.com/not-png)",
    );
    const fetchAsset: AssetFetchFunction = async (url) => ({
      body: png,
      contentType: url.endsWith("not-png") ? "image/jpeg" : "image/png",
      finalUrl: url,
      status: 200,
    });
    const assets = await cacheDocumentAssets(
      db,
      document.id,
      document.markdown,
      document.finalUrl!,
      fetchAsset,
    );
    assert.equal(assets.length, 2);
    const ready = assets.find((asset) => asset.status === "ready");
    const failed = assets.find((asset) => asset.status === "failed");
    assert.ok(ready);
    const readyHash = ready.assetHash;
    assert.ok(readyHash);
    assert.equal(ready.mimeType, "image/png");
    assert.equal(ready.byteSize, png.length);
    assert.equal(existsSync(db.assetFilePath(readyHash)), true);
    assert.equal(failed?.errorCode, "UNSUPPORTED_CONTENT_TYPE");
    assert.equal(db.getDocument(document.id)?.status, "ready");
    assert.equal(db.getDocument(document.id)?.revision, document.revision);

    const orphanHash = "a".repeat(64);
    const orphanPath = db.assetFilePath(orphanHash);
    writeFileSync(orphanPath, png);
    assert.deepEqual(dataSafetyHealth(db).orphanAssets, [`assets/${orphanHash}`]);
    assert.deepEqual(cleanupOrphanSnapshots(db).deleted, [`assets/${orphanHash}`]);
    unlinkSync(db.assetFilePath(readyHash));
    assert.deepEqual(dataSafetyHealth(db).missingAssets, [`assets/${readyHash}`]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("deduplicates shared assets and deletes the file only after its last document", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-assets-dedup-"));
  const db = openDatabase(join(root, "data"));
  const fetchAsset: AssetFetchFunction = async (url) => ({
    body: png,
    contentType: "image/png",
    finalUrl: url,
    status: 200,
  });
  try {
    const first = readyDocument(db, "https://example.com/first", "![shared](https://cdn.example.com/shared.png)");
    const second = readyDocument(db, "https://example.com/second", "![shared](https://cdn.example.com/shared.png)");
    await cacheDocumentAssets(db, first.id, first.markdown, first.finalUrl!, fetchAsset);
    await cacheDocumentAssets(db, second.id, second.markdown, second.finalUrl!, fetchAsset);
    const firstAsset = db.listDocumentAssets(first.id)?.[0];
    const sharedHash = firstAsset?.assetHash;
    assert.ok(sharedHash);
    const path = db.assetFilePath(sharedHash);
    assert.equal((db.sql.prepare("SELECT count(*) AS count FROM assets").get() as { count: number }).count, 1);

    const firstTrash = db.softDeleteDocument(first.id, db.getDocument(first.id)!.revision);
    assert.equal(firstTrash.kind, "deleted");
    if (firstTrash.kind !== "deleted") return;
    assert.equal(db.permanentlyDeleteDocument(first.id, firstTrash.document.revision, null).kind, "deleted");
    assert.equal(existsSync(path), true);

    const secondTrash = db.softDeleteDocument(second.id, db.getDocument(second.id)!.revision);
    assert.equal(secondTrash.kind, "deleted");
    if (secondTrash.kind !== "deleted") return;
    assert.equal(db.permanentlyDeleteDocument(second.id, secondTrash.document.revision, null).kind, "deleted");
    assert.equal(existsSync(path), false);
    assert.equal((db.sql.prepare("SELECT count(*) AS count FROM assets").get() as { count: number }).count, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stops requesting images after the shared document budget is exhausted", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-assets-budget-"));
  const db = openDatabase(join(root, "data"));
  let requests = 0;
  try {
    db.sql.prepare(
      `UPDATE asset_settings
       SET max_asset_bytes = ?, max_document_asset_bytes = ?, concurrency = 3 WHERE id = 1`,
    ).run(png.length, png.length * 2);
    const document = readyDocument(
      db,
      "https://example.com/budget",
      "![one](./one.png)\n![two](./two.png)\n![three](./three.png)",
    );
    const assets = await cacheDocumentAssets(db, document.id, document.markdown, document.finalUrl!, async (url) => {
      requests += 1;
      return { body: png, contentType: "image/png", finalUrl: url, status: 200 };
    });
    assert.equal(requests, 2);
    assert.deepEqual(assets.map(({ status }) => status), ["ready", "ready", "failed"]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
