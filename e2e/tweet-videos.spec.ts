import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function cloudPage(page: Page) {
  await page.route("**/health", route => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  await page.route("**/api/settings/onboarding", route => route.fulfill({ json: { completed: true, revision: 1 } }));
}

async function article(request: APIRequestContext) {
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const response = await request.post("/api/documents", { headers, data: { title: "推文视频验证" } });
  expect(response.ok()).toBe(true);
  const { document } = await response.json();
  return { ...(await (await request.get(`/api/documents/${document.id}`)).json()), sourceUrl: "https://x.com/example/status/123456789", markdown: "正文和图片先保存。" };
}

test("tweet video setting defaults to 20 MB, saves with revision and survives reopening", async ({ page }) => {
  await cloudPage(page);
  let settings = { maxBytes: 20_000_000, revision: 0 };
  await page.route("**/api/settings/tweet-videos", async route => {
    if (route.request().method() === "PUT") {
      expect(route.request().postDataJSON()).toEqual({ maxBytes: 30_000_000, revision: 0 });
      expect(route.request().headers()["x-zhiye-data-epoch"]).toBeTruthy();
      settings = { maxBytes: 30_000_000, revision: 1 };
    }
    await route.fulfill({ json: settings });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "阅读工具", exact: true }).click();
  const limit = page.getByRole("spinbutton", { name: "每条推文视频上限" });
  await expect(limit).toHaveValue("20");
  await limit.fill("101");
  await expect(page.getByRole("button", { name: "保存视频设置" })).toBeDisabled();
  await limit.fill("30");
  await page.getByRole("button", { name: "保存视频设置" }).click();
  await expect(page.getByRole("status")).toContainText("已保存，后续抓取生效。");
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "阅读工具", exact: true }).click();
  await expect(limit).toHaveValue("30");
});

test("ready tweet refreshes to local video only and leaves ordinary images as images", async ({ page, request }) => {
  await cloudPage(page);
  const base = await article(request);
  const videoHash = "a".repeat(64), imageHash = "b".repeat(64);
  let ready = false;
  let documents = 0;
  const remote: string[] = [];
  page.on("request", request => { if (new URL(request.url()).hostname === "video.twimg.com") remote.push(request.url()); });
  await page.route(`**/api/documents/${base.id}`, route => {
    documents += 1;
    return route.fulfill({ json: ready ? { ...base, revision: base.revision + 1, markdown: `${base.markdown}\n\n![推文视频 1](zhiye://asset/${videoHash})\n\n![普通图片](zhiye://asset/${imageHash})\n\n![推文视频 2](https://video.twimg.com/never-fetch.mp4)` } : base });
  });
  await page.route(`**/api/documents/${base.id}/tweet-videos`, route => route.fulfill({ json: { status: ready ? "ready" : "queued", errorCode: null, maxBytes: 20_000_000 } }));
  await page.route(`**/api/assets/${videoHash}`, route => route.fulfill({ contentType: "video/mp4", body: Buffer.from("not-a-playable-test-video") }));
  await page.route(`**/api/assets/${imageHash}`, route => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WQAAAABJRU5ErkJggg==", "base64") }));
  await page.goto("/");
  await page.locator(".directory-document-row").getByRole("button", { name: base.title, exact: true }).click();
  await expect(page.getByText("正在后台保存推文视频，文字和图片可正常阅读。", { exact: true })).toBeVisible();
  ready = true;
  const video = page.locator(".markdown-preview video");
  await expect(video).toHaveCount(1);
  await expect(video).toHaveAttribute("src", `/api/assets/${videoHash}`);
  await expect(video).toHaveAttribute("controls", "");
  await expect(video).toHaveAttribute("preload", "metadata");
  await expect(video).not.toHaveAttribute("autoplay");
  await expect(page.locator(".markdown-preview img[alt='普通图片']")).toBeVisible();
  await expect(page.getByRole("link", { name: "下载推文视频 1", exact: true })).toHaveAttribute("href", `/api/assets/${videoHash}`);
  expect(documents).toBeGreaterThan(1);
  expect(remote).toEqual([]);
});

test("background video completion does not overwrite an unsaved cloud editor", async ({ page, request }) => {
  await cloudPage(page);
  const base = await article(request);
  let ready = false, readyReads = 0, documentReads = 0;
  await page.route(`**/api/documents/${base.id}`, route => { documentReads += 1; return route.fulfill({ json: base }); });
  await page.route(`**/api/documents/${base.id}/tweet-videos`, route => {
    if (ready) readyReads += 1;
    return route.fulfill({ json: { status: ready ? "ready" : "queued", errorCode: null, maxBytes: 20_000_000 } });
  });
  await page.goto("/");
  await page.locator(".directory-document-row").getByRole("button", { name: base.title, exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 编辑器" });
  await editor.fill("尚未保存的正文不能被后台下载覆盖。");
  const previous = documentReads;
  ready = true;
  await expect.poll(() => readyReads).toBeGreaterThan(0);
  await expect(editor).toHaveText("尚未保存的正文不能被后台下载覆盖。");
  expect(documentReads).toBe(previous);
});

test("oversize video is skipped without hiding text, while text-only X posts stay quiet", async ({ page, request }) => {
  await cloudPage(page);
  const base = await article(request);
  await page.route(`**/api/documents/${base.id}`, route => route.fulfill({ json: base }));
  let code = "VIDEO_TOO_LARGE";
  await page.route(`**/api/documents/${base.id}/tweet-videos`, route => route.fulfill({ json: { status: "skipped", errorCode: code, maxBytes: 20_000_000 } }));
  await page.goto("/");
  await page.locator(".directory-document-row").getByRole("button", { name: base.title, exact: true }).click();
  await expect(page.getByText("视频超过本条推文的大小上限，已跳过；文字和图片已保留。", { exact: true })).toBeVisible();
  await expect(page.locator(".markdown-preview")).toContainText(base.markdown);
  code = "NO_PUBLIC_VIDEO";
  await page.reload();
  await page.locator(".directory-document-row").getByRole("button", { name: base.title, exact: true }).click();
  await expect(page.locator(".markdown-preview")).toContainText(base.markdown);
  await expect(page.locator(".tweet-video-status")).toHaveCount(0);
  code = "VIDEO_FORMAT_UNSUPPORTED";
  await page.reload();
  await page.locator(".directory-document-row").getByRole("button", { name: base.title, exact: true }).click();
  await expect(page.getByText("该视频暂无可下载的 MP4，文字和图片已保留。", { exact: true })).toBeVisible();
  await expect(page.locator(".markdown-preview")).toContainText(base.markdown);
});
