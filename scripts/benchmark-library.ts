import { statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { openDatabase } from "../server/db.js";

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

  const measure = (operation: () => unknown) => {
    const samples: number[] = [];
    for (let index = 0; index < 25; index += 1) {
      const started = performance.now();
      operation();
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    return Number(samples[Math.ceil(samples.length * 0.95) - 1]!.toFixed(2));
  };

  const results = {
    documents: 10_000,
    databaseBytes: statSync(join(root, "zhiye.sqlite3")).size,
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
    },
  };
  console.log(JSON.stringify(results, null, 2));
  if (Object.values(results.p95Ms).some((duration) => duration > 300)) process.exitCode = 1;
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
