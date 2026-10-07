import { expect, test } from "@playwright/test";

for (const cloud of [false, true]) test(`Markdown toolbar and floating pane labels in ${cloud ? "cloud" : "local"} mode`, async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  if (cloud) await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `工具行布局${cloud}-${Date.now()}`;
  const { document } = await (await request.post("/api/documents", { headers, data: { title } })).json();
  const markdown = "# 阅读与记录\n\n" + "让格式工具留在手边，让正文拥有更多空间。\n\n".repeat(100);
  expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { revision: 1, markdown } })).ok()).toBe(true);
  await page.goto("/");
  const defer = page.getByRole("button", { name: "稍后设置", exact: true });
  if (await defer.isVisible()) await defer.click();
  await page.getByRole("button", { name: title, exact: true }).click();
  const head = page.locator(".compact-document-head");
  if (cloud) {
    await expect(head.getByRole("group", { name: "编辑器显示模式", exact: true })).toHaveCount(0);
    await expect(head.locator(".document-actions > button").first()).toHaveText("编辑");
    await head.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(head.locator(".document-actions > button").first()).toHaveText("返回阅读");
    const mode = await head.locator(".mode-switch").boundingBox();
    const back = await head.getByRole("button", { name: "返回阅读", exact: true }).boundingBox();
    expect(mode!.x + mode!.width).toBeLessThanOrEqual(back!.x);
    expect(Math.abs(mode!.y + mode!.height / 2 - back!.y - back!.height / 2)).toBeLessThanOrEqual(1);
  }
  const editor = page.getByLabel("Markdown 编辑器");
  await expect(page.locator(".editor-toolbar .markdown-format-toolbar")).toHaveCount(1);
  await expect(page.locator(".editor-pane .markdown-format-toolbar")).toHaveCount(0);
  await editor.evaluate((element) => { element.dataset.identity = "retained"; });
  const sourceLabel = page.locator(".editor-pane .pane-label");
  const previewLabel = page.locator(".preview-pane .pane-label");
  const sourceY = (await sourceLabel.boundingBox())!.y;
  const previewY = (await previewLabel.boundingBox())!.y;
  for (const overlay of await page.locator(".pane-label-overlay").all()) expect((await overlay.boundingBox())!.height).toBe(0);
  expect(Math.abs((await page.locator(".markdown-editor-host").boundingBox())!.y - (await page.locator(".editor-pane").boundingBox())!.y)).toBeLessThanOrEqual(1);
  await page.locator(".cm-scroller").evaluate((element) => { element.scrollTop = 180; });
  await expect(sourceLabel).toHaveCSS("opacity", "0.5");
  await expect(previewLabel).toHaveCSS("opacity", "1");
  expect((await sourceLabel.boundingBox())!.y).toBe(sourceY);
  await page.locator(".editor-grid .preview-pane").evaluate((element) => { element.scrollTop = 180; });
  await expect(previewLabel).toHaveCSS("opacity", "0.5");
  expect((await previewLabel.boundingBox())!.y).toBe(previewY);
  await page.locator(".cm-scroller").evaluate((element) => { element.scrollTop = 0; });
  await page.locator(".editor-grid .preview-pane").evaluate((element) => { element.scrollTop = 0; });
  await expect(sourceLabel).toHaveCSS("opacity", "1");
  await expect(previewLabel).toHaveCSS("opacity", "1");
  await expect(editor).toHaveAttribute("data-identity", "retained");
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.screenshot({ path: `/tmp/zhiye-md-layout-${cloud}-${theme}.png` });
  }
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.locator(".markdown-toolbar-host")).toBeHidden();
  await page.getByRole("button", { name: "编辑", exact: true }).last().click();
  await expect(page.locator(".editor-toolbar .markdown-format-toolbar")).toBeVisible();
  for (const width of [800, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const tools = await page.locator(".markdown-format-toolbar").boundingBox();
    expect(tools!.x).toBeGreaterThanOrEqual(0);
    expect(tools!.x + tools!.width).toBeLessThanOrEqual(width);
    if (cloud) {
      const header = (await head.boundingBox())!;
      const back = (await head.getByRole("button", { name: "返回阅读", exact: true }).boundingBox())!;
      const modes = (await head.locator(".mode-switch").boundingBox())!;
      expect(back.y).toBeGreaterThanOrEqual(header.y);
      expect(back.y + back.height).toBeLessThanOrEqual(header.y + header.height);
      if (width <= 560) expect(modes.y + modes.height).toBeLessThanOrEqual(back.y);
      else expect(modes.x + modes.width).toBeLessThanOrEqual(back.x);
    }
    await page.screenshot({ path: `/tmp/zhiye-md-layout-${cloud}-${width}.png` });
  }
  if (cloud) {
    await head.getByRole("button", { name: "返回阅读", exact: true }).click();
    await expect(head.getByRole("group", { name: "编辑器显示模式", exact: true })).toHaveCount(0);
    await expect(page.locator(".markdown-format-toolbar")).toHaveCount(0);
    await expect(page.locator(".markdown-preview h1")).toHaveText("阅读与记录");
  }
});
