import { expect, test } from "@playwright/test";

test("imports, edits, previews, searches, exports, and blocks raw scripts", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("网页地址").fill("https://example.com/requested");
  await page.getByRole("button", { name: "收取网页" }).click();

  await expect(page.getByLabel("文档标题")).toHaveValue("远端测试文章", { timeout: 8_000 });
  await expect(page.getByRole("heading", { name: "抓取成功" })).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { __zhiyeXss?: boolean }).__zhiyeXss)).toBeUndefined();

  await page.getByLabel("文档标题").fill("人工整理标题");
  const editor = page.getByLabel("Markdown 编辑器");
  await editor.click();
  await editor.press("Control+A");
  await editor.fill("# 人工修改\n\n保存后的正文");
  await page.getByPlaceholder("用逗号分隔").fill("测试, 本地");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible({ timeout: 5_000 });

  const downloadStarted = page.waitForEvent("download");
  await page.getByRole("link", { name: /导出 \.md/ }).click();
  expect((await downloadStarted).suggestedFilename()).toMatch(/\.md$/u);

  await page.reload();
  await page.getByRole("button", { name: /人工整理标题/ }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("人工整理标题");
  await expect(page.getByRole("heading", { name: "人工修改" })).toBeVisible();
  await page.getByPlaceholder("搜索标题与正文").fill("保存后的正文");
  await expect(page.getByRole("button", { name: /人工整理标题/ })).toBeVisible();
});
