import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

async function article(request: APIRequestContext, title: string) {
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const { document } = await (await request.post("/api/documents", { headers, data: { title } })).json();
  await request.patch(`/api/documents/${document.id}`, { headers, data: { revision: document.revision, markdown: Array.from({ length: 80 }, (_, index) => `## 章节 ${index}\n\nReading paragraph ${index}. 保存位置后再次打开，继续阅读。`).join("\n\n") } });
  return { document: await (await request.get(`/api/documents/${document.id}`)).json(), headers };
}
async function openArticle(page: Page, title: string) {
  await page.locator(".library-directory").getByRole("button", { name: title, exact: true }).click();
  await expect(page.locator(".reader-main .markdown-preview")).toBeVisible();
}
const fraction = (page: Page) => page.locator(".preview-pane").evaluate((pane) => pane.scrollTop / Math.max(1, pane.scrollHeight - pane.clientHeight));

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
});

test("research has one active destination, shared controls and no redundant header or sidebar link", async ({ page, request }, testInfo) => {
  const { document } = await article(request, `界面统一${Date.now()}`);
  await page.route("**/api/study/topics", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/study/source-collections", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  await rail.getByRole("button", { name: "研究", exact: true }).click();
  const workspace = page.getByRole("region", { name: "研究工作台" });
  await expect(rail.getByRole("button", { pressed: true })).toHaveCount(1);
  await expect(rail.getByRole("button", { name: "研究", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "返回阅读", exact: true })).toHaveCount(0);
  await expect(page.locator(".study-host > header")).toHaveCount(0);
  expect((await page.locator(".study-host").boundingBox())!.height).toBe(900);
  await expect(workspace.getByRole("status")).toHaveText("暂无专题");
  await expect(workspace.getByRole("button", { name: "新建专题", exact: true })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("study-empty-desktop.png") });
  await workspace.getByRole("button", { name: "资料", exact: true }).click();
  const checkbox = workspace.getByRole("checkbox", { name: "只看未读", exact: true });
  await expect(checkbox).toHaveClass("ui-checkbox");
  await expect(checkbox).toHaveCSS("width", "17px");
  await checkbox.check();
  expect((await new AxeBuilder({ page }).include(".study-workspace").analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "深色外观", exact: true }).click();
  await expect(checkbox).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("study-library-mobile-dark.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await rail.getByRole("button", { name: "设置", exact: true }).click();
  await expect(rail.getByRole("button", { pressed: true })).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: "打开资料时恢复阅读位置", exact: true })).toHaveClass("ui-checkbox");
  await rail.getByRole("button", { name: "资料库", exact: true }).click();
  await openArticle(page, document.title);
  await expect(page.locator(".study-reading-progress")).toHaveCount(0);
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "阅读功能" }).getByRole("button", { name: "专题与复习", exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("reader-without-progress-bar.png") });
});

test("reading position restores by default and the shared setting persists an opt-out", async ({ page, request }) => {
  const { document, headers } = await article(request, `自动恢复${Date.now()}`);
  const progressUrl = `/api/study/documents/${document.id}/progress`;
  expect((await request.put(progressUrl, { headers, data: { revision: 0, documentRevision: document.revision, fraction: .55, anchor: null, read: false } })).ok()).toBe(true);
  await page.goto("/"); await openArticle(page, document.title);
  await expect.poll(() => fraction(page)).toBeCloseTo(.55, 2);
  await expect(page.getByRole("button", { name: "恢复阅读位置", exact: true })).toHaveCount(0);
  await page.locator(".preview-pane").hover(); await page.mouse.wheel(0, 350);
  await expect.poll(() => fraction(page)).toBeGreaterThan(.55);
  const latestPosition = await fraction(page);
  await page.locator(".reader-main").getByRole("button", { name: "收藏", exact: true }).click();
  await expect(page.locator(".reader-main").getByRole("button", { name: "取消收藏", exact: true })).toBeVisible();
  await expect.poll(() => fraction(page)).toBeCloseTo(latestPosition, 2);
  await expect.poll(async () => (await (await request.get(progressUrl)).json()).fraction).toBeCloseTo(latestPosition, 2);
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "设置", exact: true }).click();
  const setting = page.getByRole("checkbox", { name: "打开资料时恢复阅读位置", exact: true });
  await expect(setting).toBeChecked(); await setting.uncheck();
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  await expect(page.locator(".preview-pane")).toBeVisible();
  await expect.poll(() => fraction(page)).toBe(0);
  await page.reload();
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "设置", exact: true }).click();
  await expect(setting).not.toBeChecked();
  await page.getByRole("button", { name: "恢复默认", exact: true }).click(); await expect(setting).toBeChecked();
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  await openArticle(page, document.title);
  await expect.poll(() => fraction(page)).toBeCloseTo(latestPosition, 2);
});

test("a quick tab switch flushes the captured position before it is restored", async ({ page, request }) => {
  const first = await article(request, `快速切换甲${Date.now()}`), second = await article(request, `快速切换乙${Date.now()}`);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const progressUrl = `/api/study/documents/${first.document.id}/progress`;
  await page.route(`**${progressUrl}`, async (route) => { if (route.request().method() === "PUT") await held; await route.continue(); });
  await page.goto("/"); await openArticle(page, first.document.title);
  const pane = page.locator(".preview-pane");
  await pane.hover(); await page.mouse.wheel(0, 900);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  const savedFraction = await fraction(page);
  const saving = page.waitForRequest((value) => value.method() === "PUT" && value.url().endsWith(progressUrl));
  await openArticle(page, second.document.title);
  await saving;
  await openArticle(page, first.document.title);
  release();
  await expect.poll(() => fraction(page)).toBeCloseTo(savedFraction, 2);
  await expect.poll(async () => (await (await request.get(progressUrl)).json())?.fraction).toBeCloseTo(savedFraction, 2);
  expect(await (await request.get(`/api/study/documents/${second.document.id}/progress`)).json()).toBeNull();
});

test("a late saved position never overrides a user's scroll", async ({ page, request }) => {
  const { document, headers } = await article(request, `延迟恢复${Date.now()}`);
  const progressUrl = `/api/study/documents/${document.id}/progress`;
  await request.put(progressUrl, { headers, data: { revision: 0, documentRevision: document.revision, fraction: .8, anchor: null, read: false } });
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**${progressUrl}`, async (route) => { if (route.request().method() === "GET") { const response = await route.fetch(); await held; await route.fulfill({ response }); } else await route.continue(); });
  await page.goto("/"); await openArticle(page, document.title);
  await page.locator(".preview-pane").hover(); await page.mouse.wheel(0, 650);
  await expect.poll(() => fraction(page)).toBeGreaterThan(0);
  const chosen = await fraction(page);
  release();
  await expect.poll(async () => (await (await request.get(progressUrl)).json()).fraction).toBeCloseTo(chosen, 2);
  await expect.poll(() => fraction(page)).toBeCloseTo(chosen, 2);
});

test("an excerpt destination wins over a delayed automatic reading position", async ({ page, request }) => {
  const { document, headers } = await article(request, `引用定位${Date.now()}`);
  const quote = "Reading paragraph 60. 保存位置后再次打开，继续阅读。";
  const annotation = await (await request.post(`/api/reader-tools/documents/${document.id}/annotations`, { headers, data: { revision: document.revision, anchor: { quote, prefix: "", suffix: "", source: "preview" } } })).json();
  const topic = await (await request.post("/api/study/topics", { headers, data: { name: `引用目标${Date.now()}` } })).json();
  await request.patch(`/api/study/topics/${topic.id}`, { headers, data: { revision: topic.revision, annotationId: annotation.id } });
  const progressUrl = `/api/study/documents/${document.id}/progress`;
  await request.put(progressUrl, { headers, data: { revision: 0, documentRevision: document.revision, fraction: .1, anchor: null, read: false } });
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**${progressUrl}`, async (route) => { if (route.request().method() === "GET") { const response = await route.fetch(); await held; await route.fulfill({ response }); } else await route.continue(); });
  await page.goto("/");
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "研究", exact: true }).click();
  const workspace = page.getByRole("region", { name: "研究工作台" });
  await workspace.getByRole("complementary", { name: "专题列表" }).getByRole("button", { name: topic.name, exact: true }).click();
  await workspace.getByRole("region", { name: "专题摘录" }).getByRole("button", { name: "定位原文", exact: true }).click();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(quote);
  const destination = await fraction(page);
  expect(destination).toBeGreaterThan(.5);
  release();
  await expect.poll(async () => (await (await request.get(progressUrl)).json()).fraction).toBeCloseTo(destination, 2);
  await expect.poll(() => fraction(page)).toBeCloseTo(destination, 2);
});

test("returning before another document finishes loading still restores the original position", async ({ page, request }) => {
  const first = await article(request, `慢切换甲${Date.now()}`), second = await article(request, `慢切换乙${Date.now()}`);
  await request.put(`/api/study/documents/${first.document.id}/progress`, { headers: first.headers, data: { revision: 0, documentRevision: first.document.revision, fraction: .4, anchor: null, read: false } });
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/documents/${second.document.id}`, async (route) => { const response = await route.fetch(); await held; await route.fulfill({ response }).catch(() => undefined); });
  await page.goto("/"); await openArticle(page, first.document.title);
  await expect.poll(() => fraction(page)).toBeCloseTo(.4, 2);
  const loading = page.waitForRequest((value) => value.url().endsWith(`/api/documents/${second.document.id}`));
  await page.locator(".library-directory").getByRole("button", { name: second.document.title, exact: true }).click();
  await loading;
  await openArticle(page, first.document.title);
  await expect.poll(() => fraction(page)).toBeCloseTo(.4, 2);
  release();
  await expect(page.locator(".document-tab-select[aria-pressed='true']")).toHaveText(first.document.title);
});

test("automatic restoration follows delayed image layout until the user takes control", async ({ page, request }) => {
  const { document, headers } = await article(request, `图片位置恢复${Date.now()}`);
  const hash = "c".repeat(64), source = `zhiye://asset/${hash}`;
  const markdown = `![延迟加载图](${source})\n\n` + Array.from({ length: 30 }, (_, index) => `Paragraph ${index}. 图片加载前后都应恢复到保存的位置。`).join("\n\n");
  await request.patch(`/api/documents/${document.id}`, { headers, data: { revision: document.revision, markdown } });
  const updated = await (await request.get(`/api/documents/${document.id}`)).json();
  await request.put(`/api/study/documents/${document.id}/progress`, { headers, data: { revision: 0, documentRevision: updated.revision, fraction: .6, anchor: null, read: false } });
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/assets/${hash}`, async (route) => { await held; await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="2000"><path fill="#bd412c" d="M0 0h600v2000H0z"/></svg>' }); });
  await page.goto("/"); await openArticle(page, document.title);
  await expect.poll(() => fraction(page)).toBeCloseTo(.6, 2);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  release();
  await expect.poll(() => page.getByRole("img", { name: "延迟加载图" }).evaluate((image: HTMLImageElement) => image.complete && image.naturalHeight > 0)).toBe(true);
  await expect.poll(() => fraction(page)).toBeCloseTo(.6, 2);
});
