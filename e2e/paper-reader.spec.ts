import { expect, test } from "@playwright/test";

test("imports a paper and opens the bilingual page reader", async ({ page }) => {
  await page.goto("/");
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  if (await deferSetup.isVisible()) {
    await deferSetup.click();
    await expect(page.getByLabel("网页地址")).toBeVisible();
  }

  await expect(page.getByRole("button", { name: "导入论文", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "导入论文", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入论文" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "上传 PDF" }).click();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "e2e-paper.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\nE2E fixture\n", "ascii"),
  });
  await dialog.getByRole("button", { name: "创建论文" }).click();

  await expect(page.getByRole("heading", { name: "E2E 论文" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("一篇 E2E 论文。", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("中文对照 · 第 1 页", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑译文" }).click();
  await expect(page.locator("textarea")).toHaveCount(1);
  await page.locator("textarea").fill("修改后的论文译文。");
  await page.getByRole("button", { name: "保存本页" }).click();
  await expect(page.locator(".paper-reader-notice")).toContainText("本页译文已保存。");

  await page.getByRole("button", { name: "更多操作：E2E 论文" }).click();
  await page.getByRole("dialog", { name: "操作：E2E 论文" }).getByRole("button", { name: "删除（移入回收站）" }).click();
  const trashResponse = page.waitForResponse((response) => response.request().method() === "DELETE" && /^\/api\/documents\/[^/]+$/u.test(new URL(response.url()).pathname));
  await page.getByRole("alertdialog", { name: "移入回收站" }).getByRole("button", { name: "移入回收站" }).click();
  expect((await trashResponse).status()).toBe(200);
  await expect(page.getByRole("button", { name: "回收站", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "永久删除：E2E 论文" })).toBeVisible();
  await page.getByRole("button", { name: "永久删除：E2E 论文" }).click();
  await page.getByRole("alertdialog", { name: "永久删除知识" }).getByRole("button", { name: "永久删除" }).click();
  await expect(page.getByRole("button", { name: "E2E 论文", exact: true })).toHaveCount(0);
});
