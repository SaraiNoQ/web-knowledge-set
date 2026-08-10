import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createApp, type CaptureFunction } from "../server/app.js";
import type { AssetFetchFunction } from "../server/assets.js";
import { openDatabase } from "../server/db.js";

const root = mkdtempSync(join(tmpdir(), "zhiye-e2e-"));
const dataDir = join(root, "data");
const readyImageUrl = "https://assets.example.test/ready.png";
const failedImageUrl = "https://assets.example.test/failed.png";
const capture: CaptureFunction = async (url) => ({
  extractorVersion: "e2e-capture@1",
  title: "远端测试文章",
  author: "测试作者",
  publishedAt: "2026-08-09",
  finalUrl: url.replace("/requested", "/final"),
  canonicalUrl: url.replace("/requested", "/canonical"),
  markdown: `# 抓取成功\n\n这是可搜索的本地知识正文。\n\n![离线图片](${readyImageUrl})\n\n![失败图片](${failedImageUrl})\n\n<script>window.__zhiyeXss = true</script>`,
  mode: "http",
  warning: null,
  rawHtml: "<!doctype html><title>远端测试文章</title><article><h1>快照重新提取</h1><p>这是只来自本地 HTML 快照的候选正文。</p></article>",
  httpStatus: 200,
});
const fetchAsset: AssetFetchFunction = async (url) => {
  if (url === readyImageUrl) {
    return {
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WQAAAABJRU5ErkJggg==", "base64"),
      contentType: "image/png",
      finalUrl: url,
      status: 200,
    };
  }
  throw Object.assign(new Error("测试图片不可用"), { code: "HTTP_ERROR" });
};
const app = createApp({
  dataDir,
  database: openDatabase(dataDir),
  staticDir: resolve("dist"),
  capture,
  fetchAsset,
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
