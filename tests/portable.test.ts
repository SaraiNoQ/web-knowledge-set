import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { derivedInputHash, openDatabase, type KnowledgeDatabase } from "../server/db.js";
import {
  createPortableBundle,
  inspectPortableZip,
  PortableError,
  promotePortableAssets,
  stagePortableBundle,
} from "../server/portable.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const assetUrl = "https://cdn.example.com/image.png";
const secondAssetUrl = "https://mirror.example.com/same-image.png";
const relativeAssetUrl = "https://example.com/img.png";

function readyDocument(db: KnowledgeDatabase, markdown: string) {
  const created = db.createOrGetDocument("https://example.com/article").document;
  const job = db.claimNextCapture();
  assert.ok(job);
  const ready = db.completeCapture(job, {
    title: "Portable article",
    author: "Ada",
    publishedAt: "2026-08-12",
    finalUrl: "https://example.com/article-final",
    canonicalUrl: "https://example.com/article",
    markdown,
    mode: "http",
    warning: null,
    httpStatus: 200,
  }, null);
  const collection = db.createCollection("Reading").collection;
  const organized = db.updateDocument(ready.id, ready.revision, {
    tags: ["Research"], collectionIds: [collection.id], favorite: true, archived: true,
    sourceNote: "Imported from the web",
  });
  assert.equal(organized.kind, "updated");
  return organized.document;
}

test("portable bundle round-trips documents and images without rewriting links or code", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-portable-"));
  const source = openDatabase(join(root, "source"));
  const target = openDatabase(join(root, "target"));
  const skippedTarget = openDatabase(join(root, "skipped-target"));
  let crashTarget = openDatabase(join(root, "crash-target"));
  const updatedSource = openDatabase(join(root, "updated-source"));
  const markdown = [
    `![cached](${assetUrl})`,
    `![${assetUrl}](${assetUrl})`,
    `![same bytes](${secondAssetUrl})`,
    "![relative](/img.png)",
    `![same canonical](${relativeAssetUrl})`,
    `[normal link](${assetUrl})`,
    `\`${assetUrl}\``,
  ].join("\n\n");
  try {
    const original = readyDocument(source, markdown);
    assert.equal(source.saveDerivedResult({
      documentId: original.id,
      type: "summary",
      model: "portable-test",
      endpointId: "local-test",
      promptVersion: "summary-v1",
      inputHash: derivedInputHash(original.title, original.markdown),
      output: "DERIVED_RESULTS_ARE_NOT_PORTABLE_V1",
      durationMs: 1,
      sourceChars: original.title.length + original.markdown.length,
      sentChars: original.title.length + original.markdown.length,
      truncated: false,
    }).kind, "saved");
    const hash = createHash("sha256").update(png).digest("hex");
    assert.equal(source.prepareDocumentAssets(original.id, [assetUrl, secondAssetUrl, relativeAssetUrl]), true);
    writeFileSync(source.assetFilePath(hash), png, { mode: 0o600 });
    for (const url of [assetUrl, secondAssetUrl, relativeAssetUrl]) {
      assert.equal(source.markAssetFetching(original.id, url), true);
      assert.equal(source.completeAsset(original.id, url, hash, "image/png", png.length), true);
    }

    const archive = await createPortableBundle(source, [original.id]);
    const files = unzipSync(archive);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as {
      documents: Array<{ path: string; assets: Array<{ path: string; sourceUrl: string; originalUrl: string; sha256: string; mimeType: string; byteSize: number }> }>;
    };
    const exported = strFromU8(files[manifest.documents[0]!.path]!);
    assert.doesNotMatch(exported, /DERIVED_RESULTS_ARE_NOT_PORTABLE_V1/u);
    assert.match(exported, /!\[cached\]\(\.\.\/assets\/[a-f0-9-]+\.png\)/u);
    assert.match(exported, new RegExp(`!\\[${assetUrl.replaceAll(".", "\\.")}\\]\\(\\.\\.\\/assets\\/[a-f0-9-]+\\.png\\)`, "u"));
    assert.match(exported, /!\[same bytes\]\(\.\.\/assets\/[a-f0-9-]+\.png\)/u);
    assert.match(exported, /!\[relative\]\(\.\.\/assets\/[a-f0-9-]+\.png\)/u);
    assert.match(exported, /!\[same canonical\]\(\.\.\/assets\/[a-f0-9-]+\.png\)/u);
    assert.deepEqual(
      manifest.documents[0]!.assets.filter((asset) => "originalUrl" in asset).length,
      4,
    );
    assert.match(exported, new RegExp(`\\[normal link\\]\\(${assetUrl.replaceAll(".", "\\.")}\\)`, "u"));
    assert.match(exported, new RegExp("`" + assetUrl.replaceAll(".", "\\.") + "`", "u"));
    assert.equal("originalMarkdown" in (JSON.parse(strFromU8(files["manifest.json"]!)).documents[0]), false);

    const conflictingBody = Buffer.concat([png, Buffer.from([1])]);
    const conflictingHash = createHash("sha256").update(conflictingBody).digest("hex");
    const conflictingOriginalUrl = "/./img.png";
    const conflictingPath = `assets/${conflictingHash}-${createHash("sha256").update(conflictingOriginalUrl).digest("hex")}.png`;
    manifest.documents[0]!.assets.push({
      path: conflictingPath, sha256: conflictingHash, mimeType: "image/png",
      sourceUrl: relativeAssetUrl, originalUrl: conflictingOriginalUrl, byteSize: conflictingBody.length,
    });
    files[conflictingPath] = conflictingBody;
    files["manifest.json"] = strToU8(JSON.stringify(manifest));
    await assert.rejects(
      stagePortableBundle(target, zipSync(files)),
      (error: unknown) => error instanceof PortableError && error.code === "INVALID_MANIFEST",
    );
    assert.deepEqual(readdirSync(target.importStagingDir), []);

    const preview = await stagePortableBundle(target, archive);
    assert.deepEqual(preview.counts, { total: 1, valid: 1, duplicate: 0, invalid: 0, assets: 1 });
    const promoted = promotePortableAssets(target, preview.id);
    const applied = target.applyImportBatch(preview.id, "skip");
    target.queueFileDeletions(promoted.map((value) => `assets/${value}`));
    target.processPendingFileDeletions();
    assert.equal(applied?.counts.created, 1);
    const restored = target.getDocument(applied!.items[0]!.documentId!);
    assert.ok(restored);
    assert.equal(restored.markdown, original.markdown);
    assert.equal(restored.title, original.title);
    assert.equal(restored.sourceUrl, original.sourceUrl);
    assert.equal(restored.finalUrl, original.finalUrl);
    assert.equal(restored.canonicalUrl, original.canonicalUrl);
    assert.equal(restored.author, original.author);
    assert.equal(restored.publishedAt, original.publishedAt);
    assert.deepEqual(restored.tags, original.tags);
    assert.deepEqual(restored.collections.map(({ name }) => name), ["Reading"]);
    assert.equal(restored.favorite, true);
    assert.equal(restored.archivedAt, original.archivedAt);
    assert.equal(restored.sourceNote, original.sourceNote);
    assert.equal(restored.createdAt, original.createdAt);
    assert.deepEqual(target.listDerivedResults(restored.id), { items: [], page: 1, pageSize: 30, total: 0 });
    assert.equal(readFileSync(target.assetFilePath(hash)).equals(png), true);
    assert.deepEqual(target.listDocumentAssets(restored.id)?.map(({ sourceUrl }) => sourceUrl), [assetUrl, relativeAssetUrl, secondAssetUrl]);

    skippedTarget.createOrGetDocument(original.sourceUrl);
    const skippedPreview = await stagePortableBundle(skippedTarget, archive);
    const skippedPromoted = promotePortableAssets(skippedTarget, skippedPreview.id);
    const skipped = skippedTarget.applyImportBatch(skippedPreview.id, "skip");
    skippedTarget.queueFileDeletions(skippedPromoted.map((value) => `assets/${value}`));
    skippedTarget.processPendingFileDeletions();
    assert.equal(skipped?.counts.skipped, 1);
    assert.equal(existsSync(skippedTarget.assetFilePath(hash)), false);

    const crashPreview = await stagePortableBundle(crashTarget, archive);
    promotePortableAssets(crashTarget, crashPreview.id);
    assert.equal(existsSync(crashTarget.assetFilePath(hash)), true);
    crashTarget.close();
    crashTarget = openDatabase(join(root, "crash-target"));
    assert.equal(existsSync(crashTarget.assetFilePath(hash)), false);

    const shared = target.createOrGetDocument("https://example.com/shared-holder").document;
    assert.equal(target.prepareDocumentAssets(shared.id, [assetUrl]), true);
    assert.equal(target.markAssetFetching(shared.id, assetUrl), true);
    assert.equal(target.completeAsset(shared.id, assetUrl, hash, "image/png", png.length), true);
    const replacementBody = Buffer.concat([png, Buffer.from([2])]);
    const replacementHash = createHash("sha256").update(replacementBody).digest("hex");
    const replacement = readyDocument(updatedSource, markdown);
    assert.equal(updatedSource.prepareDocumentAssets(replacement.id, [assetUrl, secondAssetUrl, relativeAssetUrl]), true);
    writeFileSync(updatedSource.assetFilePath(replacementHash), replacementBody, { mode: 0o600 });
    for (const url of [assetUrl, secondAssetUrl, relativeAssetUrl]) {
      assert.equal(updatedSource.markAssetFetching(replacement.id, url), true);
      assert.equal(updatedSource.completeAsset(replacement.id, url, replacementHash, "image/png", replacementBody.length), true);
    }
    const updatePreview = await stagePortableBundle(target, await createPortableBundle(updatedSource, [replacement.id]));
    promotePortableAssets(target, updatePreview.id);
    assert.equal(target.applyImportBatch(updatePreview.id, "update")?.counts.updated, 1);
    target.cleanupUnreferencedAssets();
    assert.equal(existsSync(target.assetFilePath(hash)), true);
    assert.equal(existsSync(target.assetFilePath(replacementHash)), true);
    target.sql.prepare("DELETE FROM document_assets WHERE document_id = ?").run(shared.id);
    target.cleanupUnreferencedAssets();
    assert.equal(existsSync(target.assetFilePath(hash)), false);
  } finally {
    source.close();
    target.close();
    skippedTarget.close();
    crashTarget.close();
    updatedSource.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable ZIP validation rejects unsafe paths, symlinks, bombs, and checksum changes", async () => {
  assert.throws(() => inspectPortableZip(zipSync({})), PortableError);
  for (const path of ["/absolute", "../escape", "dir\\escape", "bad\0name"]) {
    assert.throws(() => inspectPortableZip(zipSync({ [path]: strToU8("x") })), PortableError);
  }
  const symlink = Buffer.from(zipSync({ "manifest.json": strToU8("{}") }));
  const central = symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  symlink[central + 5] = 3;
  symlink.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
  assert.throws(() => inspectPortableZip(symlink), (error: unknown) => error instanceof PortableError && error.code === "ZIP_SYMLINK");

  const mismatchedHeader = Buffer.from(zipSync({ "manifest.json": strToU8("{}") }));
  mismatchedHeader.writeUInt16LE(mismatchedHeader.readUInt16LE(6) | 1, 6);
  assert.throws(() => inspectPortableZip(mismatchedHeader), PortableError);

  const mismatchedSize = Buffer.from(zipSync({ "manifest.json": strToU8("{}") }));
  mismatchedSize.writeUInt32LE(mismatchedSize.readUInt32LE(22) + 1, 22);
  assert.throws(() => inspectPortableZip(mismatchedSize), PortableError);

  const overlapping = Buffer.from(zipSync({ "first.txt": strToU8("first"), "second.txt": strToU8("second") }, { level: 0 }));
  const firstCentral = overlapping.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(firstCentral >= 0);
  const expanded = overlapping.readUInt32LE(18) + 40;
  overlapping.writeUInt32LE(expanded, 18);
  overlapping.writeUInt32LE(expanded, firstCentral + 20);
  assert.throws(() => inspectPortableZip(overlapping), PortableError);

  assert.throws(
    () => inspectPortableZip(zipSync({ "huge.bin": new Uint8Array(1024 * 1024) }, { level: 9 })),
    (error: unknown) => error instanceof PortableError && error.code === "ZIP_BOMB",
  );
  const tooMany = Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [`f${index}`, new Uint8Array()]));
  assert.throws(() => inspectPortableZip(zipSync(tooMany)), PortableError);

  const root = mkdtempSync(join(tmpdir(), "zhiye-portable-checksum-"));
  const source = openDatabase(join(root, "source"));
  const target = openDatabase(join(root, "target"));
  try {
    const document = readyDocument(source, "Original");
    const files = unzipSync(await createPortableBundle(source, [document.id]));
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as { documents: Array<{ path: string }> };
    files[manifest.documents[0]!.path] = strToU8("Changed");
    await assert.rejects(
      stagePortableBundle(target, zipSync(files)),
      (error: unknown) => error instanceof PortableError && error.code === "CHECKSUM_MISMATCH",
    );
    assert.deepEqual(readdirSync(target.importStagingDir), []);

    const forged = Buffer.from(zipSync({ "forged.bin": new Uint8Array(1024 * 1024) }, { level: 9 }));
    const forgedCentral = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(forgedCentral >= 0);
    forged.writeUInt32LE(1, 22);
    forged.writeUInt32LE(1, forgedCentral + 24);
    inspectPortableZip(forged);
    await assert.rejects(
      stagePortableBundle(target, forged),
      (error: unknown) => error instanceof PortableError && error.code === "ZIP_BOMB",
    );
    assert.deepEqual(readdirSync(target.importStagingDir), []);

    const cancellable = zipSync({ "large.bin": new Uint8Array(8 * 1024 * 1024) }, { level: 0 });
    const controller = new AbortController();
    let healthResponded = false;
    setImmediate(() => {
      healthResponded = target.getDatabaseHealth().integrityCheck[0] === "ok";
      controller.abort();
    });
    await assert.rejects(
      stagePortableBundle(target, cancellable, controller.signal),
      (error: unknown) => error instanceof PortableError && error.code === "REQUEST_ABORTED",
    );
    assert.equal(healthResponded, true);
    assert.deepEqual(readdirSync(target.importStagingDir), []);
  } finally {
    source.close();
    target.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable export stops at its running size limit before reading a tail asset", async () => {
  const root = mkdtempSync(join(tmpdir(), "zhiye-portable-limit-"));
  const source = openDatabase(join(root, "source"));
  const largeUrl = "https://example.com/large.png";
  const missingUrl = "https://example.com/missing.png";
  const variants = [
    "/large.png", "/./large.png", "/a/../large.png", "//example.com/large.png",
    "https://example.com:443/large.png", "https://EXAMPLE.com/large.png", "/a/b/../../large.png",
  ];
  try {
    const document = readyDocument(source, [...variants.map((url) => `![large](${url})`), `![tail](${missingUrl})`].join("\n"));
    const body = Buffer.alloc(25 * 1024 * 1024);
    body.set(png);
    const hash = createHash("sha256").update(body).digest("hex");
    const missingHash = "f".repeat(64);
    assert.equal(source.prepareDocumentAssets(document.id, [largeUrl, missingUrl]), true);
    writeFileSync(source.assetFilePath(hash), body, { mode: 0o600 });
    assert.equal(source.markAssetFetching(document.id, largeUrl), true);
    assert.equal(source.completeAsset(document.id, largeUrl, hash, "image/png", body.length), true);
    assert.equal(source.markAssetFetching(document.id, missingUrl), true);
    assert.equal(source.completeAsset(document.id, missingUrl, missingHash, "image/png", body.length), true);
    await assert.rejects(
      createPortableBundle(source, [document.id]),
      (error: unknown) => error instanceof PortableError && error.code === "EXPORT_LIMIT",
    );
    assert.equal(existsSync(source.assetFilePath(missingHash)), false);
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
  }
});
