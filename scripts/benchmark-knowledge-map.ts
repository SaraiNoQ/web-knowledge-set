import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, platform, arch, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";
import { appendSemanticGraphState, computeSemanticGraph, createSemanticGraphState } from "../shared/semantic-graph.js";
import type { SemanticVectorEntry } from "../shared/types.js";
import { SEMANTIC_FORMAT_VERSION } from "../shared/semantic.js";

const count = 1_000;
const dimension = 1_024;
const root = mkdtempSync(join(tmpdir(), "zhiye-knowledge-map-benchmark-"));
const dataDir = join(root, "data");
const db = openDatabase(dataDir);
const app = createApp({ dataDir, database: db, bootstrapToken: "benchmark", startWorker: false });
const server = createServer((request, response) => void app.handler(request, response));

try {
  for (let index = 0; index < count; index += 1) db.createArticle(`Benchmark ${String(index).padStart(4, "0")}`);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const launch = await fetch(`${base}/launch?token=benchmark`, { redirect: "manual" });
  const cookie = (launch.headers.get("set-cookie") ?? "").split(";", 1)[0];
  assert.ok(cookie);

  const metadataStart = performance.now();
  let cursor = 0;
  let received = 0;
  let bytes = 0;
  do {
    const response = await fetch(`${base}/api/knowledge-map?limit=500&cursor=${cursor}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const body = await response.text();
    bytes += Buffer.byteLength(body);
    const page = JSON.parse(body) as { items: unknown[]; total: number; nextCursor: string | null };
    received += page.items.length;
    cursor = page.nextCursor === null ? -1 : Number(page.nextCursor);
    assert.equal(page.total, count);
  } while (cursor >= 0);
  const metadataMs = performance.now() - metadataStart;
  assert.equal(received, count);
  assert.ok(metadataMs <= 2_000, `1000-node metadata took ${metadataMs.toFixed(1)}ms`);

  const vectors: SemanticVectorEntry[] = Array.from({ length: count }, (_, index) => ({
    id: `benchmark-${String(index).padStart(4, "0")}`,
    sourceHash: String(index).padStart(64, "0"),
    model: "BAAI/bge-m3",
    formatVersion: SEMANTIC_FORMAT_VERSION,
    vector: Array.from({ length: dimension }, (_, axis) => Math.sin((index + 1) * (axis + 1) * 0.0001)),
  }));
  const graphStart = performance.now();
  const fullGraph = computeSemanticGraph(vectors);
  const graphMs = performance.now() - graphStart;
  assert.ok(graphMs <= 5_000, `1000 × 1024 graph calculation took ${graphMs.toFixed(1)}ms`);

  const progressiveStart = performance.now();
  let state = createSemanticGraphState(vectors.slice(0, 1));
  for (const entry of vectors.slice(1)) {
    state = appendSemanticGraphState(state, [entry]);
  }
  const progressiveMs = performance.now() - progressiveStart;
  assert.deepEqual(state.graph, fullGraph);

  console.log(JSON.stringify({
    platform: `${platform()} ${arch()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    node: process.version,
    documents: received,
    dimensions: dimension,
    metadataMs: Number(metadataMs.toFixed(1)),
    metadataBytes: bytes,
    fullGraphMs: Number(graphMs.toFixed(1)),
    progressiveIndexUpdatesMs: Number(progressiveMs.toFixed(1)),
    edges: fullGraph.edges.length,
  }, null, 2));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
