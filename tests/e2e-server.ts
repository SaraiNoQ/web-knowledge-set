import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createApp, type CaptureFunction } from "../server/app.js";
import { openDatabase } from "../server/db.js";

const root = mkdtempSync(join(tmpdir(), "zhiye-e2e-"));
const dataDir = join(root, "data");
const capture: CaptureFunction = async (url) => ({
  extractorVersion: "e2e-capture@1",
  title: "远端测试文章",
  author: "测试作者",
  publishedAt: "2026-08-09",
  finalUrl: url.replace("/requested", "/final"),
  canonicalUrl: url.replace("/requested", "/canonical"),
  markdown: "# 抓取成功\n\n这是可搜索的本地知识正文。\n\n![追踪像素](http://127.0.0.1:9/private.png)\n\n<script>window.__zhiyeXss = true</script>",
  mode: "http",
  warning: null,
  rawHtml: "<!doctype html><title>远端测试文章</title><article><h1>快照重新提取</h1><p>这是只来自本地 HTML 快照的候选正文。</p></article>",
  httpStatus: 200,
});
const app = createApp({
  dataDir,
  database: openDatabase(dataDir),
  staticDir: resolve("dist"),
  capture,
  dev: true,
  onDesktopCloseReady: () => undefined,
});
const server = createServer((request, response) => void app.handler(request, response));

async function close() {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await app.close();
  rmSync(root, { recursive: true, force: true });
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
server.listen(4174, "127.0.0.1");
