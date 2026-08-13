import { createHash, randomFillSync } from "node:crypto";
import { statSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { openDatabase } from "../server/db.js";
import { parseImportRequest } from "../server/import.js";
import { createPortableBundle, promotePortableAssets, stagePortableBundle } from "../server/portable.js";

const MIB = 1024 * 1024;
const PORTABLE_ASSET_BYTES = 99 * MIB / 4;

const root = mkdtempSync(join(tmpdir(), "zhiye-library-benchmark-"));
const db = openDatabase(root);

try {
  const insert = db.sql.prepare(
    `INSERT INTO documents(
       id, source_url, title, markdown, status, capture_mode, favorite, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'ready', 'http', ?, ?, ?)`,
  );
  db.sql.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 10_000; index += 1) {
      const id = `benchmark-${String(index).padStart(5, "0")}`;
      const timestamp = new Date(Date.UTC(2025, 0, 1, 0, index % 60, index % 60)).toISOString();
      insert.run(
        id,
        `https://example.com/articles/${index}`,
        `${index % 2 ? "Knowledge" : "知识"} article ${index}`,
        `${index % 2 ? "Local knowledge benchmark body" : "本地知识库基准正文"} ${index}`,
        Number(index % 10 === 0),
        timestamp,
        timestamp,
      );
    }
    db.sql.exec(`
      INSERT INTO tags(name) VALUES ('Benchmark');
      INSERT INTO collections(id, name, created_at, updated_at)
      VALUES ('benchmark-collection', 'Benchmark', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
      INSERT INTO document_tags(document_id, tag_id)
      SELECT id, (SELECT id FROM tags WHERE name = 'Benchmark') FROM documents
      WHERE CAST(substr(id, -5) AS INTEGER) % 10 = 0;
      INSERT INTO document_collections(document_id, collection_id)
      SELECT id, 'benchmark-collection' FROM documents
      WHERE CAST(substr(id, -5) AS INTEGER) % 10 = 0;
    `);
    db.sql.exec("COMMIT");
  } catch (error) {
    db.sql.exec("ROLLBACK");
    throw error;
  }

  const measure = (operation: () => unknown, samplesCount = 25) => {
    const samples: number[] = [];
    for (let index = 0; index < samplesCount; index += 1) {
      const started = performance.now();
      operation();
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    return Number(samples[Math.ceil(samples.length * 0.95) - 1]!.toFixed(2));
  };

  const longMarkdown = "x".repeat(MIB);
  let longDocument = db.getDocument("benchmark-00000")!;
  const longMarkdownWrite = measure(() => {
    const result = db.updateDocument(longDocument.id, longDocument.revision, { markdown: longMarkdown });
    if (result.kind !== "updated") throw new Error(`Unexpected long-document update: ${result.kind}`);
    longDocument = result.document;
  }, 7);
  const longMarkdownRead = measure(() => {
    if (db.getDocument(longDocument.id)?.markdown.length !== MIB) throw new Error("Long document was truncated");
  });

  const importItems = parseImportRequest("markdown", {
    files: Array.from({ length: 100 }, (_, index) => ({
      path: `benchmark-${index}.md`,
      content: `# Imported ${index}\n\nBatch benchmark body.`,
    })),
  });
  const batchStarted = performance.now();
  const importBatch = db.createImportBatch("markdown", importItems);
  const imported = db.applyImportBatch(importBatch.id, "skip");
  const batchImport = Number((performance.now() - batchStarted).toFixed(2));
  if (imported?.counts.created !== 100) throw new Error("100-item import did not complete");

  const portableSource = openDatabase(join(root, "portable-source"));
  const portableTarget = openDatabase(join(root, "portable-target"));
  let portableExport = 0;
  let portableImport = 0;
  let archiveBytes = 0;
  try {
    const created = portableSource.createOrGetDocument("https://example.com/portable-benchmark").document;
    const job = portableSource.claimNextCapture();
    if (!job) throw new Error("Portable benchmark capture job was not created");
    const urls = Array.from({ length: 4 }, (_, index) => `https://example.com/asset-${index}.png`);
    const document = portableSource.completeCapture(job, {
      title: "Portable benchmark",
      author: null,
      publishedAt: null,
      finalUrl: created.sourceUrl,
      canonicalUrl: created.sourceUrl,
      markdown: urls.map((url) => `![asset](${url})`).join("\n"),
      mode: "http",
      warning: null,
      httpStatus: 200,
    }, null);
    portableSource.prepareDocumentAssets(document.id, urls);
    for (const url of urls) {
      const body = Buffer.allocUnsafe(PORTABLE_ASSET_BYTES);
      randomFillSync(body);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(body);
      const hash = createHash("sha256").update(body).digest("hex");
      writeFileSync(portableSource.assetFilePath(hash), body, { mode: 0o600 });
      portableSource.markAssetFetching(document.id, url);
      if (!portableSource.completeAsset(document.id, url, hash, "image/png", body.length)) {
        throw new Error("Portable benchmark asset was not stored");
      }
    }
    let started = performance.now();
    const archive = await createPortableBundle(portableSource, [document.id]);
    portableExport = Number((performance.now() - started).toFixed(2));
    archiveBytes = archive.length;
    started = performance.now();
    const preview = await stagePortableBundle(portableTarget, archive);
    promotePortableAssets(portableTarget, preview.id);
    const applied = portableTarget.applyImportBatch(preview.id, "skip");
    portableImport = Number((performance.now() - started).toFixed(2));
    if (applied?.counts.created !== 1) throw new Error("Portable benchmark import did not complete");
  } finally {
    portableSource.close();
    portableTarget.close();
  }

  const results = {
    documents: Number((db.sql.prepare("SELECT count(*) AS total FROM documents").get() as { total: number }).total),
    databaseBytes: statSync(join(root, "zhiye.sqlite3")).size,
    scale: {
      markdownBytes: MIB,
      batchItems: 100,
      portableResourceBytes: 99 * MIB,
      portableArchiveBytes: archiveBytes,
    },
    p95Ms: {
      recent: measure(() => db.listDocuments({ page: 1 })),
      englishSearch: measure(() => db.listDocuments({ q: "knowledge", page: 1 })),
      chineseSearch: measure(() => db.listDocuments({ q: "知识", page: 1 })),
      titleSort: measure(() => db.listDocuments({ sort: "title", page: 1 })),
      combined: measure(() => db.listDocuments({
        tag: "Benchmark",
        collectionId: "benchmark-collection",
        status: "ready",
        favorite: true,
        captureMode: "http",
        sort: "title",
        page: 1,
      })),
      longMarkdownWrite,
      longMarkdownRead,
    },
    elapsedMs: { batchImport, portableExport, portableImport },
  };
  console.log(JSON.stringify(results, null, 2));
  const queryP95 = Object.entries(results.p95Ms)
    .filter(([name]) => !name.startsWith("longMarkdown"))
    .map(([, duration]) => duration);
  if (
    queryP95.some((duration) => duration > 300) ||
    longMarkdownWrite > 1_500 || longMarkdownRead > 300 ||
    batchImport > 5_000 || portableExport > 60_000 || portableImport > 60_000
  ) process.exitCode = 1;
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
