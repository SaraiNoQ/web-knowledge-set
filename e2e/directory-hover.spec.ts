import { expect, test } from "@playwright/test";

test("keeps directory details hover-only and omits the status dot", async ({ page }) => {
  await page.goto("/");
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  await expect(deferSetup.or(page.getByLabel("网页地址"))).toBeVisible();
  if (await deferSetup.isVisible()) await deferSetup.click();

  const captureUrl = `https://example.com/hover-${Date.now()}`;
  await page.getByLabel("网页地址").fill(captureUrl);
  await page.getByRole("button", { name: "收取网页" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("远端测试文章", { timeout: 8_000 });

  const row = page.getByRole("region", { name: "根目录内容" }).locator(".directory-document-row").filter({ has: page.locator(`a[href="${captureUrl}"]`) });
  const title = row.getByRole("button", { name: "远端测试文章", exact: true });
  await expect(title).toBeVisible();
  await expect(row.locator(".directory-status")).toHaveCount(0);

  await title.hover();
  await page.waitForTimeout(850);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(page.getByRole("tooltip")).toBeVisible({ timeout: 1_000 });
  await title.click();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});
