import { expect, test } from "@playwright/test";

for (const cloud of [false, true]) test(`map uses shared UI controls in ${cloud ? "web" : "desktop"}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/settings/onboarding", route => route.fulfill({ json: { completed: true, revision: 1 } }));
  if (cloud) await page.route("**/health", route => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  else await page.addInitScript(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke: async (command: string) => command === "take_external_intents" ? [] : "/tmp/ui-consistency" } }));
  await page.goto("/");
  await page.getByRole("button", { name: "知识地图", exact: true }).click();
  const filters = page.getByRole("complementary", { name: "地图筛选" });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const name of ["资料类型", "分组", "收藏"]) await expect(filters.getByRole("combobox", { name, exact: true })).toHaveClass(/ui-select/);
    await filters.getByRole("combobox", { name: "资料类型", exact: true }).click();
    await expect(page.locator(".ui-select-menu")).toBeVisible();
    await page.getByRole("option", { name: "文章", exact: true }).click();
    await expect(filters.getByRole("combobox", { name: "资料类型", exact: true })).toHaveText("文章");
    for (const checkbox of await filters.getByRole("checkbox").all()) {
      await expect(checkbox).toHaveClass(/ui-checkbox/);
      await expect(checkbox).toHaveCSS("width", "17px");
      expect(await checkbox.evaluate(element => getComputedStyle(element).accentColor)).not.toBe("auto");
    }
    const advanced = filters.locator(".map-advanced");
    if (await advanced.getAttribute("open") === null) await advanced.locator("summary").click();
    const slider = filters.getByRole("slider", { name: "相似要求" });
    await expect(slider).toHaveClass(/ui-range/);
    await expect(slider).toHaveCSS("height", "5px");
    expect(await slider.evaluate(element => getComputedStyle(element).backgroundImage)).toContain("linear-gradient");
    await page.screenshot({ path: info.outputPath(`map-${cloud ? "web" : "desktop"}-${theme}.png`) });
  }
});
