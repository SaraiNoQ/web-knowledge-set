import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
});

async function finishSetup(page: Page) {
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  await expect(deferSetup.or(page.getByLabel("网页地址"))).toBeVisible();
  if (await deferSetup.isVisible()) await deferSetup.click();
}

test("the rail opens the map and returns to the directory without view toggles", async ({ page }) => {
  await page.goto("/");
  await finishSetup(page);
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  const mapButton = rail.getByRole("button", { name: "查看知识地图", exact: true });
  const directoryButton = rail.getByRole("button", { name: "文档资料库", exact: true });
  await expect(page.locator(".library-view-toggle")).toHaveCount(0);

  for (const width of [1440, 800, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await mapButton.click();
    await expect(page.getByRole("heading", { name: "知识地图", exact: true })).toBeVisible();
    await expect(page.getByText("03 · ATLAS", { exact: true })).toHaveCount(0);
    await expect(page.locator(".library-view-toggle")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await directoryButton.click();
    await expect(page.getByRole("navigation", { name: "目录分类" })).toBeVisible();
    await expect(page.locator(".knowledge-map-host")).toHaveClass(/is-dormant/u);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("opening the map keeps the unsaved edit guard", async ({ page }) => {
  await page.goto("/");
  await finishSetup(page);
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("dialog", { name: "新建" }).getByRole("button", { name: "创建文章" }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 编辑器" });
  await editor.fill("地图打开前的未保存正文");
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  const mapButton = rail.getByRole("button", { name: "查看知识地图", exact: true });
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
