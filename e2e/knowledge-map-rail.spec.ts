import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
});

async function finishSetup(page: Page) {
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  await expect(deferSetup.or(page.getByLabel("网页链接"))).toBeVisible();
  if (await deferSetup.isVisible()) await deferSetup.click();
}

test("the rail opens the map and returns to the directory without view toggles", async ({ page }, testInfo) => {
  const folders = [{ id: "reading", name: "阅读方法" }, { id: "research", name: "研究论文" }, { id: "notes", name: "知识笔记" }];
  const items = Array.from({ length: 92 }, (_, index) => ({
    id: `layout-${index}`, title: `阅读资料 ${index + 1}`, kind: index % 5 ? "article" : "paper",
    folderId: index < 60 ? folders[index % folders.length].id : null,
    status: "ready", favorite: false, archivedAt: null, updatedAt: "2026-10-30T00:00:00.000Z",
    pageCount: null, semanticState: "unavailable", semanticSourceHash: null, semanticModel: null, semanticFormatVersion: null,
  }));
  await page.route("**/api/knowledge-map?*", (route) => route.fulfill({ json: { items, folders, total: items.length, nextCursor: null } }));
  await page.goto("/");
  await finishSetup(page);
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  const mapButton = rail.getByRole("button", { name: "知识地图", exact: true });
  const directoryButton = rail.getByRole("button", { name: "资料库", exact: true });
  await expect(page.locator(".library-view-toggle")).toHaveCount(0);

  for (const width of [1440, 800, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await mapButton.click();
    await expect(page.getByRole("heading", { name: "知识地图", exact: true })).toBeVisible();
    await expect(page.locator(".map-total")).toHaveText("92 篇");
    await expect(page.locator(".map-privacy-note")).toHaveText("实线表示分组，虚线表示内容相近。");
    await expect(page.getByRole("combobox", { name: "收藏", exact: true })).toHaveCount(0);
    await expect(page.locator(".map-canvas-inner canvas")).toBeVisible();
    const map = await page.locator(".knowledge-map").boundingBox();
    const filters = await page.getByRole("complementary", { name: "地图筛选" }).boundingBox();
    const canvas = await page.getByRole("region", { name: "资料关联画布" }).boundingBox();
    const title = await page.getByRole("heading", { name: "知识地图", exact: true }).boundingBox();
    const actions = await page.locator(".knowledge-map-actions").boundingBox();
    expect(filters!.y).toBeCloseTo(map!.y, 0);
    expect(actions!.x).toBeGreaterThan(title!.x + title!.width);
    expect(actions!.x + actions!.width).toBeLessThanOrEqual(map!.x + map!.width);
    if (width > 560) expect(canvas!.y).toBeCloseTo(map!.y, 0);
    await expect(page.getByText("03 · ATLAS", { exact: true })).toHaveCount(0);
    await expect(page.locator(".library-view-toggle")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator(".knowledge-map").screenshot({ path: testInfo.outputPath(`map-layout-${width}.png`), animations: "disabled" });
    await directoryButton.click();
    await expect(page.locator(".knowledge-map-host")).toHaveClass(/is-dormant/u);
    const directory = page.getByRole("navigation", { name: "目录分类" });
    if (!await directory.isVisible()) await directoryButton.click();
    await expect(directory).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("opening the map keeps the unsaved edit guard", async ({ page }) => {
  await page.goto("/");
  await finishSetup(page);
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("dialog", { name: "新建" }).getByRole("button", { name: "新建文章" }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 编辑器" });
  await editor.fill("地图打开前的未保存正文");
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  const mapButton = rail.getByRole("button", { name: "知识地图", exact: true });
  await mapButton.click();
  const discard = page.getByRole("alertdialog", { name: "存在未保存修改" });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor).toHaveText("地图打开前的未保存正文");
  await expect(page.locator(".knowledge-map-host.is-active")).toHaveCount(0);

  await mapButton.click();
  await page.getByRole("alertdialog", { name: "存在未保存修改" }).getByRole("button", { name: "继续并放弃" }).click();
  await expect(page.getByRole("heading", { name: "知识地图", exact: true })).toBeVisible();
});
