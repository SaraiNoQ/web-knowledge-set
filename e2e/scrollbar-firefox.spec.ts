import { expect, test } from "@playwright/test";

test("uses the themed scrollbar in Firefox", async ({ page }) => {
  await page.goto("/");
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  if (await deferSetup.isVisible()) await deferSetup.click();

  const scrollbar = await page.evaluate(() => {
    const probe = document.createElement("div");
    const content = document.createElement("div");
    Object.assign(probe.style, { width: "48px", height: "48px", overflow: "scroll" });
    Object.assign(content.style, { width: "160px", height: "160px" });
    probe.append(content);
    document.body.append(probe);
    probe.scrollTo(32, 32);
    const style = getComputedStyle(probe);
    const result = { colors: style.scrollbarColor, scrollLeft: probe.scrollLeft, scrollTop: probe.scrollTop };
    probe.remove();
    return result;
  });

  expect(scrollbar.colors).toBe("rgb(189, 65, 44) rgba(189, 65, 44, 0.08)");
  expect(scrollbar.scrollLeft).toBeGreaterThan(0);
  expect(scrollbar.scrollTop).toBeGreaterThan(0);

  await page.getByLabel("网页地址").fill(`https://example.com/firefox-scrollbar-${Date.now()}`);
  await page.getByRole("button", { name: "收取网页" }).click();
  await expect(page.getByLabel("文档标题")).toBeVisible({ timeout: 8_000 });
  const realContainers = await page.evaluate(() => [".library-panel", ".cm-scroller"].map((selector) => ({
    selector,
    colors: getComputedStyle(document.querySelector(selector)!).scrollbarColor,
  })));
  expect(realContainers).toEqual([
    { selector: ".library-panel", colors: "rgb(189, 65, 44) rgba(189, 65, 44, 0.08)" },
    { selector: ".cm-scroller", colors: "rgb(189, 65, 44) rgba(189, 65, 44, 0.08)" },
  ]);

  await page.emulateMedia({ forcedColors: "active" });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).scrollbarColor)).toBe("auto");
});
