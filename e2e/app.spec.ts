import { expect, test } from "@playwright/test";

test("imports, restores history, trashes, restores, searches, exports, and blocks raw scripts", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("网页地址").fill("https://example.com/requested");
  await page.getByRole("button", { name: "收取网页" }).click();

  await expect(page.getByLabel("文档标题")).toHaveValue("远端测试文章", { timeout: 8_000 });
  await expect(page.getByRole("heading", { name: "抓取成功" })).toBeVisible();
  await expect(page.getByText("外部图片已隐藏：追踪像素")).toBeVisible();
  await expect(page.locator(".markdown-preview img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { __zhiyeXss?: boolean }).__zhiyeXss)).toBeUndefined();

  await page.getByLabel("文档标题").fill("人工整理标题");
  const editor = page.getByLabel("Markdown 编辑器");
  await editor.click();
  await editor.press("Control+A");
  await editor.fill("# 第一版\n\n第一版正文");
  await page.getByPlaceholder("用逗号分隔").fill("测试, 本地");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("已同步", { exact: true })).toBeVisible({ timeout: 5_000 });

  await editor.fill("# 第二版\n\n这段文字会被历史恢复替换。");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "修订历史" }).click();
  await expect(page.getByRole("heading", { name: "修订历史" })).toBeVisible();
  const firstRevision = page.getByRole("listitem").filter({ hasText: "第一版正文" });
  await expect(firstRevision).toBeVisible();
  await page.evaluate(async () => {
    const list = await fetch("/api/documents?page=1").then((response) => response.json()) as {
      items: Array<{ id: string }>;
    };
    const document = await fetch(`/api/documents/${list.items[0].id}`).then((response) => response.json()) as {
      id: string;
      revision: number;
    };
    await fetch(`/api/documents/${document.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: document.revision, title: "另一窗口更新" }),
    });
  });
  await firstRevision.getByRole("button", { name: "恢复此版本" }).click();
  await expect(page.getByText("这篇知识在别处被修改过")).toBeVisible();
  await page.getByRole("button", { name: "保留我的修改" }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("heading", { name: "第一版" })).toBeVisible();

  await editor.fill("# 第一版\n\n第一版正文\n\n删除冲突后仍保留。");
  await page.evaluate(async () => {
    const list = await fetch("/api/documents?page=1").then((response) => response.json()) as {
      items: Array<{ id: string }>;
    };
    await fetch(`/api/documents/${list.items[0].id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  });
  await expect(page.getByText("这篇知识已被移入回收站")).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "保留我的修改" }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByLabel("Markdown 预览").getByText("删除冲突后仍保留。")).toBeVisible();

  const downloadStarted = page.waitForEvent("download");
  await page.getByRole("link", { name: /导出 \.md/ }).click();
  expect((await downloadStarted).suggestedFilename()).toMatch(/\.md$/u);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("移入回收站");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "移入回收站" }).click();
  await expect(page.getByRole("button", { name: "回收站", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("文档标题")).toBeDisabled();
  await page.getByRole("button", { name: "恢复到资料库" }).click();
  await expect(page.getByRole("button", { name: "资料库", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("文档标题")).toBeEnabled();

  await page.reload();
  await page.getByRole("button", { name: /人工整理标题/ }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("人工整理标题");
  await expect(page.getByRole("heading", { name: "第一版" })).toBeVisible();
  await page.getByPlaceholder("搜索标题与正文").fill("第一版正文");
  await expect(page.getByRole("button", { name: /人工整理标题/ })).toBeVisible();
});
