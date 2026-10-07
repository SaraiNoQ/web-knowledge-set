import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
});

for (const cloud of [false, true]) test(`${cloud ? "cloud" : "local"} editor formats selections, inserts blocks, and keeps saved Markdown portable`, async ({ page, request }) => {
  if (cloud) await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `格式验证${cloud}-${Date.now()}`;
  const { document } = await (await request.post("/api/documents", { headers, data: { title } })).json();
  await page.goto("/");
  const defer = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await defer.isVisible()) await defer.click();
  await page.getByRole("button", { name: title, exact: true }).click();
  if (cloud) await page.locator(".compact-document-head").getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByLabel("Markdown 编辑器");
  await editor.fill("选中文字");
  await editor.press("Control+Home");
  await editor.press("Control+Shift+End");
  const bubble = page.getByRole("toolbar", { name: "选中文字格式", exact: true });
  await expect(bubble).toBeVisible();
  await bubble.getByRole("button", { name: "加粗", exact: true }).click();
  await expect(editor).toHaveText("**选中文字**");
  await expect(page.locator(".markdown-preview strong")).toHaveText("选中文字");
  const tools = page.getByRole("toolbar", { name: "Markdown 格式工具", exact: true });
  await tools.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(editor).toHaveText("选中文字");
  await tools.getByRole("button", { name: "重做", exact: true }).click();
  await expect(editor).toHaveText("**选中文字**");
  await editor.press("Escape");
  await expect(bubble).toBeHidden();
  await editor.press("Control+Home");
  await editor.press("Control+Shift+End");
  await editor.press("Control+k");
  await expect(editor).toHaveText("[**选中文字**](https://)");
  await page.keyboard.insertText("https://example.com");
  await expect(page.locator(".markdown-preview a")).toHaveAttribute("href", "https://example.com/");
  await editor.press("Control+End");
  await tools.getByRole("combobox", { name: "插入 Markdown", exact: true }).click();
  await page.getByRole("option", { name: "表格", exact: true }).click();
  await expect(editor).toBeFocused();
  await page.keyboard.insertText("列名");
  await expect(page.locator(".markdown-preview table")).toBeVisible();
  await expect(page.locator(".markdown-preview th").first()).toHaveText("列名");
  await page.getByRole("combobox", { name: "Markdown 展示风格", exact: true }).click();
  await page.getByRole("option", { name: "技术", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-reading-style", "technical");
  let releaseSave = () => {};
  if (cloud) {
    const held = new Promise<void>((resolve) => { releaseSave = resolve; });
    await page.route(`**/api/documents/${document.id}`, async (route) => {
      if (route.request().method() === "PATCH") await held;
      await route.continue();
    });
  }
  try {
    await page.getByRole("button", { name: "保存", exact: true }).click();
    if (cloud) {
      await expect(tools.getByRole("button", { name: "加粗", exact: true })).toBeDisabled();
      await expect(bubble).toBeHidden();
    }
  } finally { releaseSave(); }
  await expect(page.locator(".save-indicator")).toHaveText("已保存");
  const saved = await (await request.get(`/api/documents/${document.id}`)).json();
  expect(saved.markdown).toContain("[**选中文字**](https://example.com)");
  expect(saved.markdown).toContain("| 列名 | 内容 |");
  expect(saved.markdown).not.toContain("technical");
  await page.reload();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-reading-style", "technical");
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(page.locator(".markdown-preview table")).toBeVisible();
});

test("four reading treatments share accessible controls across light, dark and narrow screens", async ({ page, request }) => {
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `阅读风格${Date.now()}`;
  const { document } = await (await request.post("/api/documents", { headers, data: { title } })).json();
  const markdown = "# 让知识有自己的节奏\n\n记录值得留下的想法，让阅读与思考在同一处发生。\n\n## 从一段文字开始\n\n段落中的 **重点** 与 `Markdown`，都应清晰而克制。\n\n> 好的排版，让内容更容易被理解。\n\n- 日常笔记\n- 长文阅读\n\n```ts\nconst idea = 'keep it simple';\n```\n\n| 主题 | 用途 |\n| --- | --- |\n| 纸页 | 日常阅读 |\n| 技术 | 项目说明 |\n\n- [x] 留下一个想法\n";
  expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { revision: 1, markdown } })).ok()).toBe(true);
  await page.goto("/");
  const defer = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await defer.isVisible()) await defer.click();
  await page.getByRole("button", { name: title, exact: true }).click();
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
    for (const [id, label] of [["paper", "纸页"], ["minimal", "极简"], ["editorial", "书刊"], ["technical", "技术"]]) {
      await page.getByRole("combobox", { name: "Markdown 展示风格", exact: true }).click();
      await page.getByRole("option", { name: label, exact: true }).click();
      await expect(page.locator(".app-shell")).toHaveAttribute("data-reading-style", id);
      await expect(page.locator(".markdown-preview h1")).toHaveText("让知识有自己的节奏");
      await page.locator(".reader-panel").screenshot({ path: `/tmp/zhiye-md-${id}-${theme}.png` });
    }
  }
  await page.locator(".compact-document-head").getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByLabel("Markdown 编辑器");
  await editor.press("Control+Home");
  await editor.press("Control+Shift+ArrowRight");
  await expect(page.getByRole("toolbar", { name: "选中文字格式", exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include(".editor-workbench").analyze()).violations).toEqual([]);
  await page.screenshot({ path: "/tmp/zhiye-md-editor-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "编辑", exact: true }).last().click();
  await expect(page.getByRole("toolbar", { name: "Markdown 格式工具", exact: true })).toBeVisible();
  await editor.press("Control+Home");
  await editor.press("Control+Shift+ArrowRight");
  await page.screenshot({ path: "/tmp/zhiye-md-editor-mobile.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await page.getByRole("toolbar", { name: "选中文字格式", exact: true }).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

test("long Markdown keeps preview paused and responds to editing without rebuilding its view", async ({ page, request }) => {
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `长文排版${Date.now()}`;
  const { document } = await (await request.post("/api/documents", { headers, data: { title } })).json();
  const markdown = "# 长文\n\n" + "保留每一个想法，也保留输入时的流畅。\n\n".repeat(16_000);
  expect(markdown.length).toBeGreaterThan(250_000);
  expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { revision: 1, markdown } })).ok()).toBe(true);
  await page.goto("/");
  const defer = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await defer.isVisible()) await defer.click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(page.locator(".editor-grid")).toHaveClass(/mode-edit/);
  await expect(page.locator(".markdown-preview")).toHaveCount(0);
  const editor = page.getByLabel("Markdown 编辑器");
  await editor.press("Control+End");
  await editor.evaluate((element) => { element.dataset.viewIdentity = "retained"; });
  const started = Date.now();
  await page.keyboard.insertText("继续记录");
  await expect(editor.locator(".cm-line").last()).toContainText("继续记录");
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(2_000);
  test.info().annotations.push({ type: "long-document-input", description: `${markdown.length} characters, ${elapsed} ms to visible edit (server Chromium)` });
  await page.getByRole("combobox", { name: "Markdown 展示风格", exact: true }).click();
  await page.getByRole("option", { name: "书刊", exact: true }).click();
  await expect(editor).toHaveAttribute("data-view-identity", "retained");
  await expect(page.locator(".markdown-preview")).toHaveCount(0);
});
