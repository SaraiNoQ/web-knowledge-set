import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
});

test("one Markdown upload accepts files, drops, directories and shows import results", async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), "zhiye-md-"));
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "first.md"), "# 第一份目录文档");
  await writeFile(join(directory, "nested", "second.md"), "# 第二份目录文档");
  await writeFile(join(directory, "ignored.txt"), "忽略此文件");
  try {
    await page.goto("/");
    await expect(page.locator(".masthead")).toHaveCount(0);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "批量导入", exact: true });
    await modal.getByLabel("选择 Markdown 文件", { exact: true }).setInputFiles({ name: "picked.md", mimeType: "text/markdown", buffer: Buffer.from("# 点击添加的文档") });
    await page.locator(".markdown-dropzone").evaluate((element) => { const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File(["# 拖放的文档"], "dropped.md", { type: "text/markdown" })); element.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true })); });
    await expect(modal.getByRole("list", { name: "已添加的 Markdown 文件" }).locator("li")).toHaveCount(2);
    await modal.getByRole("button", { name: "移除文件：picked.md", exact: true }).click();
    await page.locator(".markdown-dropzone").evaluate((element) => {
      const file = new File(["# 拖放目录中的文档"], "drag-directory.md", { type: "text/markdown" });
      const transfer = new DataTransfer(); const item = transfer.items.add(file);
      const original = DataTransferItem.prototype.webkitGetAsEntry;
      Object.defineProperty(DataTransferItem.prototype, "webkitGetAsEntry", { configurable: true, value: () => ({ isFile: false, isDirectory: true, name: "拖放目录", fullPath: "/拖放目录", createReader: () => { let complete = false; return { readEntries: (resolve: (entries: unknown[]) => void) => { resolve(complete ? [] : [{ isFile: true, isDirectory: false, name: file.name, fullPath: `/拖放目录/${file.name}`, file: (resolveFile: (file: File) => void) => resolveFile(file) }]); complete = true; } }; } }) });
      element.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true }));
      Object.defineProperty(DataTransferItem.prototype, "webkitGetAsEntry", { configurable: true, value: original });
    });
    await expect(modal.getByRole("list")).toContainText("拖放目录/drag-directory.md");
    await modal.getByLabel("选择 Markdown 目录", { exact: true }).setInputFiles(directory);
    await expect(modal.getByRole("list", { name: "已添加的 Markdown 文件" }).locator("li")).toHaveCount(4);
    await expect(modal.getByRole("list")).not.toContainText("ignored.txt");
    expect((await new AxeBuilder({ page }).include(".bulk-import-card").analyze()).violations).toEqual([]);
    await page.screenshot({ path: "/tmp/zhiye-import-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/zhiye-import-mobile.png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await modal.getByRole("button", { name: "检查导入内容", exact: true }).click();
    await expect(modal.getByRole("button", { name: "确认导入", exact: true })).toBeEnabled();
    await expect(modal.locator(".bulk-preview-list li")).toHaveCount(4);
    await expect(modal.locator(".bulk-preview-list")).toContainText("dropped.md");
    await modal.getByRole("button", { name: "确认导入", exact: true }).click();
    await expect(modal.locator(".bulk-result-summary")).toContainText("新增 4");
    await modal.getByRole("button", { name: "完成", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("button", { name: "论文 PDF", exact: true }).click();
    const paper = page.getByRole("dialog", { name: "导入论文", exact: true });
    await expect(paper.getByRole("button", { name: "论文 PDF", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(paper.getByRole("tab", { name: "上传 PDF", exact: true })).toBeVisible();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("quick actions reveal and scroll to documents from settings with mouse and Enter", async ({ page, request }) => {
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `快捷定位${Date.now()}`;
  const { document } = await (await request.post("/api/documents", { headers, data: { title } })).json();
  expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { markdown: `# ${title}\n\n${"用于验证阅读页面滚动的段落。\n\n".repeat(100)}`, revision: document.revision } })).ok()).toBe(true);
  await page.goto("/");
  for (const mouse of [true, false]) {
    await page.getByRole("button", { name: "打开设置", exact: true }).click();
    await page.getByRole("button", { name: "快捷搜索与新建文章", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "快捷搜索与新建", exact: true });
    await expect(panel.getByRole("option", { name: /新建空白文章/ })).toBeVisible();
    const input = panel.getByRole("combobox"); await input.fill(title);
    const result = panel.getByRole("option", { name: new RegExp(title) }); await expect(result).toBeVisible();
    await expect(panel).toContainText("Shift + Enter");
    expect(await page.locator(".quick-actions-panel").evaluate((el) => getComputedStyle(el).borderRadius)).toBe("4px");
    if (mouse) await result.click(); else await input.press("Enter");
    await expect(panel).toBeHidden();
    await expect(page.locator(".workspace-settings")).toHaveCount(0);
    await expect(page.locator(".markdown-preview h1")).toHaveText(title);
    await expect.poll(async () => (await page.locator(".reader-panel").boundingBox())!.y).toBeLessThanOrEqual(2);
    await expect(page.locator(".reader-panel")).toBeFocused();
  }
});
