// Isolated synthetic API for benchmark-macos-map.mjs. Never load a personal data directory.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";

const root = resolve(process.env.ZHIYE_MAP_BENCH_ROOT || "");
assert(root.startsWith("/private/tmp/zhiye-mac-map-"), "Benchmark must use its isolated temporary root");
const source = join(root, "source"), dataDir = join(root, "data");
assert.equal(process.env.KB_DATA_DIR, dataDir, "Refuse a non-benchmark knowledge library");
mkdirSync(dataDir, { recursive: true });
const { openDatabase } = await import(pathToFileURL(join(source, "dist-server/server/db.js")));
const { createApp } = await import(pathToFileURL(join(source, "dist-server/server/app.js")));
const database = openDatabase(dataDir);
const app = createApp({ database, dataDir, staticDir: join(source, "dist"), startWorker: false, dev: false, onDesktopCloseReady: () => process.exit(0) });
const folders = Array.from({ length: 20 }, (_, index) => ({ id: `perf-folder-${index}`, name: `研究分组 ${index}` }));
const nodes = Array.from({ length: 10000 }, (_, index) => ({ id: `perf-${String(index).padStart(5, "0")}`, title: `性能资料 ${String(index).padStart(5, "0")}`, kind: index % 2 ? "paper" : "article", folderId: folders[index % 20].id, folderName: folders[index % 20].name, status: "ready", favorite: index % 3 === 0, archivedAt: null, updatedAt: "2026-10-26T00:00:00.000Z", pageCount: index % 2 ? 3 : null, semanticState: "ready", semanticSourceHash: String(index).padStart(64, "0"), semanticModel: "benchmark-1024", semanticFormatVersion: "semantic-text-v1" }));
const vectors = nodes.slice(0, 1000).map((node, index) => ({ id: node.id, sourceHash: node.semanticSourceHash, model: node.semanticModel, formatVersion: node.semanticFormatVersion, vector: Array.from({ length: 1024 }, (_, axis) => axis === Math.floor(index / 10) ? 1 : 0) }));
const byId = new Map(nodes.map((node) => [node.id, node])), byVectorId = new Map(vectors.map((vector) => [vector.id, vector]));
const processRows = () => execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="], { encoding: "utf8" }).trim().split("\n").map((line) => { const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return match ? { pid: +match[1], ppid: +match[2], rssKiB: +match[3], command: match[4] } : null; }).filter(Boolean);
const before = new Set(JSON.parse(process.env.ZHIYE_MAP_BENCH_INITIAL_WEBKIT || "[]"));
const memory = () => {
  const rows = processRows(), own = new Set([process.pid, process.ppid]);
  const selected = rows.filter((row) => own.has(row.pid) || (/com\.apple\.WebKit\.(?:WebContent|GPU|Networking)/.test(row.command) && !before.has(row.pid)));
  return { processes: selected, totalRssKiB: selected.reduce((sum, row) => sum + row.rssKiB, 0), attribution: "Tauri/sidecar plus newly launched WebKit processes; no forced GC" };
};
const json = (response, value, status = 200) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
let resultCount = 0;
const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  const count = request.headers["x-zhiye-benchmark-size"] === "10000" ? 10000 : 1000;
  try {
    if (url.pathname === "/__map-benchmark/result" && request.method === "POST") {
      if (request.headers.origin !== url.origin || request.headers["content-type"] !== "application/json" || ++resultCount > 300) return json(response, { error: "invalid recorder request" }, 403);
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 128 * 1024) return json(response, { error: "result too large" }, 413); chunks.push(chunk); }
      const result = { ...JSON.parse(Buffer.concat(chunks).toString("utf8")), memory: memory(), recordedAt: new Date().toISOString() };
      appendFileSync(join(root, `${process.env.ZHIYE_MAP_BENCH_ENGINE || "tauri"}-events.jsonl`), JSON.stringify(result) + "\n");
      if (result.stage === "failed" || (result.stage === "complete" && result.count === 10000)) writeFileSync(join(root, `${process.env.ZHIYE_MAP_BENCH_ENGINE || "tauri"}-finished.json`), JSON.stringify(result));
      return json(response, { ok: true });
    }
    if (url.pathname === "/api/settings/onboarding") return json(response, { completed: true, revision: 1 });
    if (url.pathname === "/api/knowledge-map") {
      const query = (url.searchParams.get("q") || "").toLowerCase(), folder = url.searchParams.get("folderId"), kind = url.searchParams.get("kind"), favorite = url.searchParams.get("favorite");
      const items = nodes.slice(0, count).filter((node) => (!query || node.title.toLowerCase().includes(query)) && (!folder || folder === node.folderId) && (!kind || kind === node.kind) && (!favorite || String(node.favorite) === favorite));
      const offset = Number(url.searchParams.get("cursor") || 0), limit = Math.min(500, Number(url.searchParams.get("limit") || 250)), page = items.slice(offset, offset + limit);
      return json(response, { items: page, folders, total: items.length, nextCursor: offset + page.length < items.length ? String(offset + page.length) : null });
    }
    if (url.pathname === "/api/knowledge-map/vectors") {
      const ids = JSON.parse(url.searchParams.get("ids") || "[]"), items = ids.map((id) => byVectorId.get(id)).filter(Boolean);
      return json(response, { items, total: items.length, nextCursor: null });
    }
    if (/^\/api\/reader-tools\/documents\/[^/]+\/data$/.test(url.pathname)) return json(response, { page: 1, annotations: [], connections: [], totalAnnotations: 0, totalConnections: 0 });
    if (url.pathname.startsWith("/api/study/related/")) {
      const id = url.pathname.split("/").at(-1), node = byId.get(id), peers = node ? nodes.filter((peer) => peer.id !== id && peer.folderId === node.folderId).slice(0, 10) : [];
      return json(response, { sourceId: id, sourceRevision: 1, items: peers.map((peer) => ({ document: { ...peer, revision: 1, sourceUrl: `https://example.com/${peer.id}`, deletedAt: null, markdown: "", tags: [] }, reasons: [{ type: "folder", label: "同组资料" }], evidence: [], score: .2 })), scannedDocuments: count, truncated: false, nextCursor: null });
    }
    await app.handler(request, response);
  } catch (error) { json(response, { error: error.message }, 500); }
});
server.listen(0, "127.0.0.1", () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(root, `${process.env.ZHIYE_MAP_BENCH_ENGINE || "tauri"}-url.txt`), `${base}/launch?token=${encodeURIComponent(app.bootstrapToken)}`);
  console.log(`ZHIYE_READY ${base}/launch?token=${encodeURIComponent(app.bootstrapToken)}`);
});
const input = createInterface({ input: process.stdin });
input.on("line", (line) => { if (line === "ZHIYE_SHUTDOWN") process.exit(0); });
process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));
