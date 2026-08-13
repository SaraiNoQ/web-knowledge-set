import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createApp, type CaptureFunction } from "../server/app.js";
import type { AssetFetchFunction } from "../server/assets.js";
import { openDatabase } from "../server/db.js";

const root = mkdtempSync(join(tmpdir(), "zhiye-e2e-"));
const dataDir = join(root, "data");
const llmServer = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ content?: string }> };
  const system = body.messages?.[0]?.content || "";
  const content = system.includes("This is a connection test")
    ? "ZHIYE_OK"
    : system.includes("Translate only")
    ? JSON.stringify((JSON.parse(body.messages?.[1]?.content || "[]") as Array<{ id: string; text: string }>)
      .map(({ id, text }) => ({ id, text: `译文：${text}` })))
    : system.includes("tag suggestion")
      ? JSON.stringify(["人工智能", "本地知识库"])
      : "## 本地摘要\n\n这是确定性的测试摘要。[不可点击](https://model.example.test/)\n\n![不得请求](https://model.example.test/pixel.png)\n\n<script>window.__modelXss = true</script>";
  setTimeout(() => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }));
  }, 1_200);
});
llmServer.listen(4175, "127.0.0.1");
const readyImageUrl = "https://assets.example.test/ready.png";
const failedImageUrl = "https://assets.example.test/failed.png";
const capture: CaptureFunction = async (url) => {
  const title = url.includes("/ai-lifecycle") ? "AI 生命周期文章" : "远端测试文章";
  return {
    extractorVersion: "e2e-capture@1",
    title,
    author: "测试作者",
    publishedAt: "2026-08-09",
    finalUrl: url.replace("/requested", "/final"),
    canonicalUrl: url.replace("/requested", "/canonical"),
    markdown: `# 抓取成功\n\n这是可搜索的本地知识正文。\n\n![离线图片](${readyImageUrl})\n\n![失败图片](${failedImageUrl})\n\n<script>window.__zhiyeXss = true</script>`,
    mode: "http",
    warning: null,
    rawHtml: `<!doctype html><title>${title}</title><article><h1>快照重新提取</h1><p>这是只来自本地 HTML 快照的候选正文。</p></article>`,
    httpStatus: 200,
  };
};
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
  bootstrapToken: "e2e-bootstrap-token",
  capture,
  fetchAsset,
  dev: false,
  onDesktopCloseReady: () => undefined,
});
const server = createServer((request, response) => void app.handler(request, response));

async function close() {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await new Promise<void>((resolveClose) => llmServer.close(() => resolveClose()));
  await app.close();
  rmSync(root, { recursive: true, force: true });
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
server.listen(4174, "127.0.0.1");
