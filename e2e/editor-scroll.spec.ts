import { expect, test } from "@playwright/test";

test("keeps the editor scroll position while read-only state changes", async ({ page }) => {
  await page.goto("/");
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  await expect(deferSetup.or(page.getByLabel("网页地址"))).toBeVisible();
  if (await deferSetup.isVisible()) await deferSetup.click();

  await page.getByLabel("网页地址").fill(`https://example.com/editor-scroll-${Date.now()}`);
  await page.getByRole("button", { name: "收取网页" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("远端测试文章", { timeout: 8_000 });

  const editor = page.getByLabel("Markdown 编辑器");
  await editor.fill(`# 长文\n\n${"保持当前滚动位置。\n\n".repeat(600)}`);
  await expect(page.locator(".save-indicator")).toHaveText("已保存", { timeout: 8_000 });
  const scroller = page.locator(".markdown-editor .cm-scroller");
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const before = await scroller.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(500);

  await page.getByLabel("作者").fill("滚动稳定测试");
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(before * 0.8);
  await expect.poll(() => page.locator(".editor-pane").evaluate((element) => getComputedStyle(element).overflowY)).toBe("hidden");
});
