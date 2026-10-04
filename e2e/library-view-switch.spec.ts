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
      await expect.poll(() => library.evaluate((element) =>
        element.querySelector(".eyebrow")!.getBoundingClientRect().top - element.getBoundingClientRect().top)).toBe(width > 820 ? 11 : 9);
      const layout = await library.evaluate((element) => {
        const panel = element.getBoundingClientRect();
        const label = element.querySelector(".eyebrow")!.getBoundingClientRect();
        const title = element.querySelector("h2")!.getBoundingClientRect();
        const switcher = element.querySelector(".library-view-toggle")!.getBoundingClientRect();
        return { gap: label.top - panel.top, titleRight: title.right, switchLeft: switcher.left, switchRight: switcher.right, panelRight: panel.right };
      });
      expect(layout.gap).toBe(width > 820 ? 11 : 9);
      expect(layout.titleRight).toBeLessThan(layout.switchLeft);
      expect(layout.switchRight).toBeLessThanOrEqual(layout.panelRight);
      await page.screenshot({ path: info.outputPath(`library-${width}-${immersive ? "immersive" : "ordinary"}.png`) });
      await switcher.getByRole("button", { name: "知识地图", exact: true }).click();
      const map = page.getByRole("region", { name: "知识地图", exact: true });
      await expect(map).toBeVisible();
      await expect(map.getByRole("button", { name: "知识地图", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(map.getByRole("button", { name: "知识地图", exact: true })).toBeFocused();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`map-${width}-${immersive ? "immersive" : "ordinary"}.png`) });
      await map.getByRole("button", { name: "返回列表" }).click();
      await expect(switcher.getByRole("button", { name: "列表", exact: true })).toBeFocused();
      await expect(switcher.getByRole("button", { name: "列表", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (immersive) await page.getByRole("button", { name: "退出沉浸模式" }).click();
    }
  }
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await expect(page.getByRole("heading", { name: "回收站", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "资料库显示方式" })).toHaveCount(0);
});

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
