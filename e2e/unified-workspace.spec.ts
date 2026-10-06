import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
});

test("root and expanded folders show every document while the reader scrolls below its tabs", async ({ page, request }) => {
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const prefix = `连续目录${Date.now()}`;
  const folder = await (await request.post("/api/folders", { headers, data: { name: prefix } })).json();
  let articleId = "";
  for (let index = 0; index < 96; index++) {
    const { document } = await (await request.post("/api/documents", { headers, data: { title: `${prefix}-${index}` } })).json();
    if (index === 0) articleId = document.id;
    if (index >= 61) expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { revision: document.revision, folderId: folder.id } })).ok()).toBe(true);
  }
  const body = `# 连续阅读\n\n${Array.from({ length: 100 }, (_, index) => `## 章节 ${index}\n\n阅读正文。\n\n`).join("")}\n\n## 最后章节\n\n末尾。`;
  expect((await request.patch(`/api/documents/${articleId}`, { headers, data: { revision: 1, markdown: body } })).ok()).toBe(true);
  const upload = await request.post("/api/papers/upload", { headers: { ...headers, "Content-Type": "application/pdf", "X-Filename": "directory-paper.pdf" }, data: Buffer.from("%PDF-1.7\nRoot fixture\n") });
  expect(upload.ok()).toBe(true);
  const { paper } = await upload.json();
  const paperDocument = await (await request.get(`/api/documents/${paper.id}`)).json();
  expect(paperDocument.folderId).toBe(null);
  await page.goto("/");
  await expect(page.locator('.root-contents button[aria-description="论文"]')).toBeVisible();
  await expect(page.locator(".directory-kind-badge")).toHaveCount(0);
  await expect(page.locator(".root-contents .directory-document-label").filter({ hasText: prefix })).toHaveCount(61);
  await expect(page.locator(".library-directory .panel-heading").getByRole("button", { name: "新建", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "文件夹", exact: true })).toHaveCount(0);
  await page.locator(".folder-node > button[aria-expanded]").filter({ hasText: prefix }).click();
  await expect(page.locator(".folder-contents .directory-document-label").filter({ hasText: prefix })).toHaveCount(35);
  await expect(page.locator(".folder-pagination")).toHaveCount(0);
  await page.locator(".root-contents").getByRole("button", { name: `${prefix}-0`, exact: true }).click();
  const tabs = await page.locator(".document-tabbar").boundingBox();
  const scroll = await page.locator(".reader-layout").boundingBox();
  expect(Math.abs(scroll!.y - tabs!.y - tabs!.height)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.getByRole("button", { name: "展开右侧功能区", exact: true }).click();
  const outline = page.locator(".document-tools");
  expect((await outline.boundingBox())!.height).toBeLessThanOrEqual(scroll!.height + 1);
  const outlineTop = (await outline.boundingBox())!.y;
  await outline.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(outline.getByRole("button", { name: "最后章节", exact: true })).toBeInViewport();
  await page.locator(".reader-layout").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator(".markdown-preview h2").last()).toBeInViewport();
  expect(Math.abs((await outline.boundingBox())!.y - outlineTop)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "收起右侧功能区", exact: true }).first().click();
  expect((await page.locator(".document-tabbar").boundingBox())!.y).toBe(tabs!.y);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".document-tabbar")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("leaving the reader before a preview completes prevents the send", async ({ page, request }) => {
  await page.unroute("**/health");
  const settingsResponse = await request.get("/api/settings/llm");
  const settings = await settingsResponse.json();
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": settingsResponse.headers()["x-zhiye-data-epoch"] };
  expect((await request.put("/api/settings/llm", { headers, data: { revision: settings.revision, enabled: true, target: "local", remote: settings.remote, local: settings.local } })).ok()).toBe(true);
  const title = `离开后不发送${Date.now()}`;
  const { document } = await (await request.post("/api/documents", { headers, data: { title } })).json();
  expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { revision: 1, markdown: "测试正文。" } })).ok()).toBe(true);
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const received = new Promise<void>((resolve) => { arrived = resolve; });
  const starts: string[] = [];
  page.on("request", (value) => { if (value.method() === "POST" && value.url().endsWith("/derived-task")) starts.push(value.url()); });
  await page.route("**/derived-preview", async (route) => { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }); });
  await page.goto("/");
  await page.locator(".root-contents").getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "AI 派生", exact: true }).click();
  await page.getByRole("button", { name: "AI 对话", exact: true }).click();
  await page.getByLabel("AI 对话 Prompt").fill("分析正文");
  await page.getByRole("button", { name: "发送并生成", exact: true }).click();
  await received;
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  const finished = page.waitForResponse((response) => response.url().endsWith("/derived-preview"));
  release();
  await (await finished).finished();
  await page.getByRole("button", { name: "返回资料库", exact: true }).click();
  await page.getByRole("button", { name: "AI 派生", exact: true }).click();
  await expect(page.locator(".derived-empty")).toBeVisible();
  expect(starts).toEqual([]);
});
