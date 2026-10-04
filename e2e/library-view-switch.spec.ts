import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  let immersiveMode = false;
  await page.route("**/api/settings/appearance", async (route) => {
    if (route.request().method() === "PUT") immersiveMode = route.request().postDataJSON().immersiveMode;
    await route.fulfill({ json: { immersiveMode } });
  });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
});

test("library header and map switch stay compact and usable at desktop and small widths", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  for (const width of [1440, 1000, 800, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const immersive of [false, true]) {
      if (immersive) await page.getByRole("button", { name: "进入沉浸模式" }).click();
      const library = page.getByRole("complementary", { name: "知识列表" });
      const switcher = library.getByRole("group", { name: "资料库显示方式" });
      await expect(switcher).toBeVisible();
      await expect.poll(() => library.evaluate((element) => parseFloat(getComputedStyle(element).paddingTop))).toBe(12);
      const layout = await library.evaluate((element) => {
        const panel = element.getBoundingClientRect();

        const meta = element.querySelector(".library-title-group")!.getBoundingClientRect();
        const count = element.querySelector(".total-count")!.getBoundingClientRect();
        const title = element.querySelector("h2")!.getBoundingClientRect();
        const switcher = element.querySelector(".library-view-toggle")!.getBoundingClientRect();
        return { gap: parseFloat(getComputedStyle(element).paddingTop), metaCenter: meta.top + meta.height / 2, countCenter: count.top + count.height / 2, titleRight: title.right, switchLeft: switcher.left, switchRight: switcher.right, panelRight: panel.right };
      });
      expect(layout.gap).toBe(12);
      expect(Math.abs(layout.countCenter - layout.metaCenter)).toBeLessThanOrEqual(1);
      expect(layout.titleRight).toBeLessThan(layout.switchLeft);
      expect(layout.switchRight).toBeLessThanOrEqual(layout.panelRight);
      await expect(switcher).toHaveCSS("height", "34px");
      await page.screenshot({ path: info.outputPath(`library-${width}-${immersive ? "immersive" : "ordinary"}.png`) });
      await switcher.getByRole("button", { name: "知识地图", exact: true }).click();
      const map = page.getByRole("region", { name: "知识地图", exact: true });
      await expect(map).toBeVisible();
      await expect(map.getByRole("button", { name: "知识地图", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(map.getByRole("button", { name: "知识地图", exact: true })).toBeFocused();
      const heading = await map.locator("h2").boundingBox();
      const toggle = await map.locator(".library-view-toggle").boundingBox();
      const count = await map.locator(".map-total").boundingBox();
      expect(toggle!.x).toBeGreaterThan(heading!.x + heading!.width);
      expect(toggle!.x - heading!.x - heading!.width).toBeLessThanOrEqual(21);
      expect(toggle!.x + toggle!.width).toBeLessThan(count!.x);
      expect(toggle!.height).toBe(34);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`map-${width}-${immersive ? "immersive" : "ordinary"}.png`) });
      await map.getByRole("button", { name: "返回列表" }).click();
      await expect(switcher.getByRole("button", { name: "列表", exact: true })).toBeFocused();
      await expect(switcher.getByRole("button", { name: "列表", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (immersive) await page.getByRole("button", { name: "退出沉浸模式" }).click();
    }
  }
  await page.getByRole("button", { name: "查看回收站", exact: true }).click();
  await expect(page.getByRole("heading", { name: "回收站", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "资料库显示方式" })).toHaveCount(0);
});

for (const cloud of [false, true]) {
  test(`reading and dirty article edits can switch views safely in ${cloud ? "cloud" : "local"} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    if (cloud) await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
    await page.goto("/");
    await page.getByRole("button", { name: "新建", exact: true }).click();
    await page.getByRole("dialog", { name: "新建" }).getByRole("button", { name: "创建文章" }).click();
    if (cloud) await expect(page.locator(".workspace-location").getByText("未命名文章", { exact: true })).toBeVisible();
    else await expect(page.getByLabel("文档标题")).toHaveValue("未命名文章");
    const mapButton = page.locator(".library-panel").getByRole("button", { name: "知识地图" });
    await mapButton.click();
    await expect(page.locator(".knowledge-map-host.is-active")).toBeVisible();
    await expect(page.getByLabel("文档标题")).toHaveCount(0);
    await page.getByRole("button", { name: "返回列表" }).click();
    await expect(page.getByRole("complementary", { name: "知识列表" })).toBeVisible();
    await page.getByRole("region", { name: "根目录内容" }).getByRole("button", { name: "未命名文章", exact: true }).last().click();
    if (cloud) await page.getByRole("button", { name: "编辑这篇知识" }).click();
    const editor = page.getByRole("textbox", { name: "Markdown 编辑器" });
    await editor.fill("切换地图前未保存的正文。");
    await mapButton.click();
    const confirm = page.getByRole("alertdialog", { name: "存在未保存修改" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    await expect(editor).toContainText("切换地图前未保存的正文。");
    await expect(page.locator(".workspace")).not.toHaveClass(/is-map-mode/u);
    await mapButton.click();
    await confirm.getByRole("button", { name: "继续并放弃" }).click();
    await expect(page.locator(".knowledge-map-host.is-active")).toBeVisible();
    await page.getByRole("button", { name: "返回列表" }).click();
    await expect(page.getByRole("complementary", { name: "知识列表" })).toBeVisible();
    await page.locator(".library-panel").getByRole("button", { name: "知识地图" }).click();
    await page.getByText(/^节点列表/u).click();
    await page.locator(".map-accessible-list").getByRole("button", { name: "未命名文章" }).last().click();
    await page.getByRole("button", { name: "打开阅读" }).click();
    await expect(page.locator(".knowledge-map-host.is-active")).toHaveCount(0);
    await mapButton.click();
    await expect(page.locator(".knowledge-map-host.is-active")).toBeVisible();
    await page.getByRole("button", { name: "返回列表" }).click();
    await expect(page.locator(".workspace")).not.toHaveClass(/is-map-mode/u);
  });
}

test("view switch supports keyboard, motion preferences and high contrast", async ({ page }) => {
  await page.goto("/");
  const switcher = page.locator(".library-panel .library-view-toggle");
  const mapButton = switcher.getByRole("button", { name: "知识地图" });
  await mapButton.focus();
  await expect(page.getByRole("tooltip")).toHaveText("知识地图");
  await expect(switcher).toHaveCSS("box-shadow", /inset/u);
  expect(await switcher.evaluate((element) => parseFloat(getComputedStyle(element, "::before").animationDuration))).toBeGreaterThan(.1);
  await page.keyboard.press("Enter");
  const mapSwitcher = page.locator(".knowledge-map-host.is-active .library-view-toggle");
  await expect(mapSwitcher.getByRole("button", { name: "知识地图" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(mapSwitcher.getByRole("button", { name: "返回列表" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(switcher.getByRole("button", { name: "列表" })).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await switcher.evaluate((element) => parseFloat(getComputedStyle(element, "::before").animationDuration))).toBeLessThan(.01);
  await mapButton.hover();
  await expect(mapButton).toHaveCSS("transform", "none");
  await page.emulateMedia({ forcedColors: "active" });
  await expect(switcher).toHaveCSS("outline-style", "solid");
  expect(await switcher.evaluate((element) => getComputedStyle(element, "::before").display)).toBe("none");
  await expect(switcher.getByRole("button", { name: "列表" })).toHaveAttribute("aria-pressed", "true");
});
