import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
});

test("root and expanded folders show every document while the reader scrolls below its tabs", async ({ page, request }) => {
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const prefix = `连续目录${Date.now()}`;
  const folder = await (await request.post("/api/folders", { headers, data: { name: prefix } })).json();
  let articleId = "";
  for (let index = 0; index < 96; index++) {
    const { document } = await (await request.post("/api/documents", { headers, data: { title: `${prefix}-${index}` } })).json();
    if (index === 0) articleId = document.id;
    if (index >= 61) expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { revision: document.revision, folderId: folder.id } })).ok()).toBe(true);
  }
  const body = `# 连续阅读\n\n${Array.from({ length: 100 }, (_, index) => `## 章节 ${index}\n\n阅读正文。\n\n`).join("")}\n\n## 最后章节\n\n末尾。`;
  expect((await request.patch(`/api/documents/${articleId}`, { headers, data: { revision: 1, markdown: body } })).ok()).toBe(true);
  const upload = await request.post("/api/papers/upload", { headers: { ...headers, "Content-Type": "application/pdf", "X-Filename": "directory-paper.pdf" }, data: Buffer.from("%PDF-1.7\nRoot fixture\n") });
  expect(upload.ok()).toBe(true);
  const { paper } = await upload.json();
  const paperDocument = await (await request.get(`/api/documents/${paper.id}`)).json();
  expect(paperDocument.folderId).toBe(null);
  await page.goto("/");
  await expect(page.locator('.root-contents button[aria-description="论文"]').filter({ hasText: paperDocument.title })).toBeVisible();
  await expect(page.locator(".directory-kind-badge")).toHaveCount(0);
  await expect(page.locator(".root-contents .directory-document-label").filter({ hasText: prefix })).toHaveCount(61);
  await expect(page.locator(".library-directory .panel-heading").getByRole("button", { name: "新建", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "文件夹", exact: true })).toHaveCount(0);
  await page.locator(".folder-node > button[aria-expanded]").filter({ hasText: prefix }).click();
  await expect(page.locator(".folder-contents .directory-document-label").filter({ hasText: prefix })).toHaveCount(35);
  await expect(page.locator(".folder-pagination")).toHaveCount(0);
  expect(await page.locator(".reader-main").evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
  await page.screenshot({ path: "/tmp/zhiye-reader-empty.png" });
  await page.locator(".root-contents").getByRole("button", { name: `${prefix}-0`, exact: true }).click();
  const tabs = await page.locator(".document-tabbar").boundingBox();
  const scroll = await page.locator(".reader-layout").boundingBox();
  const location = (await page.locator(".workspace-location").boundingBox())!;
  expect(location.height).toBe(42);
  expect(Math.abs(location.y - tabs!.y - tabs!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(scroll!.y - location.y - location.height)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.getByRole("button", { name: "展开右侧功能区", exact: true }).click();
  const outline = page.locator(".document-tools");
  expect((await outline.boundingBox())!.height).toBeLessThanOrEqual(scroll!.height + 1);
  const outlineTop = (await outline.boundingBox())!.y;
  await outline.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(outline.getByRole("button", { name: "最后章节", exact: true })).toBeInViewport();
  const preview = page.locator(".preview-pane.cloud-reader");
  const previewTop = (await preview.boundingBox())!.y;
  const headTop = (await page.locator(".compact-document-head").boundingBox())!.y;
  await preview.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await page.locator(".reader-layout").evaluate((element) => element.scrollTop)).toBe(0);
  expect(await page.locator(".reader-main").evaluate((element) => element.scrollTop)).toBe(0);
  expect((await page.locator(".workspace-location").boundingBox())!.y).toBe(location.y);
  expect((await page.locator(".compact-document-head").boundingBox())!.y).toBe(headTop);
  expect((await preview.boundingBox())!.y).toBe(previewTop);
  await expect(page.locator(".markdown-preview h2").last()).toBeInViewport();
  await outline.getByRole("button", { name: "最后章节", exact: true }).click();
  await expect(page.locator(".markdown-preview h2").last()).toBeInViewport();
  expect(Math.abs((await outline.boundingBox())!.y - outlineTop)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "收起右侧功能区", exact: true }).first().click();
  expect((await page.locator(".document-tabbar").boundingBox())!.y).toBe(tabs!.y);
  await page.screenshot({ path: "/tmp/zhiye-reader-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".document-tabbar")).toBeVisible();
  await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
  await page.screenshot({ path: "/tmp/zhiye-reader-mobile-dark.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("leaving the reader before a preview completes prevents the send", async ({ page, request }) => {
  await page.unroute("**/health");
  const settingsResponse = await request.get("/api/settings/llm");
  const settings = await settingsResponse.json();
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": settingsResponse.headers()["x-zhiye-data-epoch"] };
  expect((await request.put("/api/settings/llm", { headers, data: { revision: settings.revision, enabled: true, target: "local", remote: settings.remote, local: settings.local } })).ok()).toBe(true);
  const title = `离开后不发送${Date.now()}`;
  const { document } = await (await request.post("/api/documents", { headers, data: { title } })).json();
  expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { revision: 1, markdown: "测试正文。" } })).ok()).toBe(true);
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const received = new Promise<void>((resolve) => { arrived = resolve; });
  const starts: string[] = [];
  page.on("request", (value) => { if (value.method() === "POST" && value.url().endsWith("/derived-task")) starts.push(value.url()); });
  await page.route("**/derived-preview", async (route) => { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }); });
  await page.goto("/");
  await page.locator(".root-contents").getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "AI 派生", exact: true }).click();
  await page.getByRole("button", { name: "AI 对话", exact: true }).click();
  await page.getByLabel("AI 对话 Prompt").fill("分析正文");
  await page.getByRole("button", { name: "发送并生成", exact: true }).click();
  await received;
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  const finished = page.waitForResponse((response) => response.url().endsWith("/derived-preview"));
  release();
  await (await finished).finished();
  await page.getByRole("button", { name: "返回资料库", exact: true }).click();
  await page.getByRole("button", { name: "AI 派生", exact: true }).click();
  await expect(page.locator(".derived-empty")).toBeVisible();
  expect(starts).toEqual([]);
});

test("shared controls keep the same upload design, focus, widths and theme", async ({ page, request }) => {
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `控件统一${Date.now()}`;
  const { document } = await (await request.post("/api/documents", { headers, data: { title } })).json();
  expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { revision: 1, markdown: "# 统一阅读\n\n正文保留纸张风格。" } })).ok()).toBe(true);
  await page.goto("/");
  await page.locator(".root-contents").getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "导入", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "导入", exact: true });
  const markdownButton = modal.getByRole("button", { name: "选择文件", exact: true });
  const markdownStyle = await markdownButton.evaluate((element) => { const style = getComputedStyle(element); return [style.height, style.borderRadius, style.boxShadow, style.fontFamily]; });
  await modal.getByRole("button", { name: "论文 PDF", exact: true }).click();
  await modal.getByRole("button", { name: "上传 PDF", exact: true }).click();
  const pdf = modal.getByRole("button", { name: "选择 PDF 文件", exact: true });
  expect(await pdf.evaluate((element) => { const style = getComputedStyle(element); return [style.height, style.borderRadius, style.boxShadow, style.fontFamily]; })).toEqual(markdownStyle);
  expect((await new AxeBuilder({ page }).include(".bulk-import-card").analyze()).violations).toEqual([]);
  await page.screenshot({ path: "/tmp/zhiye-unified-upload-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/zhiye-unified-upload-mobile.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  await page.getByRole("button", { name: "阅读与显示", exact: true }).click();
  const select = await page.locator(".reading-control > .ui-select-wrap").boundingBox();
  for (const number of await page.locator(".reading-number").all()) expect((await number.boundingBox())!.width).toBe(select!.width);
  const size = page.getByRole("spinbutton", { name: "正文字号", exact: true });
  await size.fill("16"); await size.focus();
  const box = (await size.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100);
  await expect(size).toHaveValue("17");
  await expect(page.locator(".reading-text-preview")).toHaveCSS("font-size", "17px");
  await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
  expect((await new AxeBuilder({ page }).include(".workspace-settings").analyze()).violations).toEqual([]);
  await page.screenshot({ path: "/tmp/zhiye-unified-settings-dark.png" });
  await page.getByRole("button", { name: "切换到浅色模式", exact: true }).click();
  await page.getByRole("button", { name: "返回资料库", exact: true }).click();
  await page.getByRole("button", { name: "AI 派生", exact: true }).click();
  await page.getByRole("button", { name: "AI 对话", exact: true }).click();
  await expect(page.getByRole("button", { name: "发送并生成", exact: true })).toBeVisible();
  await expect(page.locator(".derived-panel").getByText("01 · GENERATE", { exact: true })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include(".derived-panel").analyze()).violations).toEqual([]);
  await page.screenshot({ path: "/tmp/zhiye-unified-ai-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/zhiye-unified-ai-mobile.png" });
});


test("sidebar rows align left and composite controls keep a single focus surface", async ({ page, request }) => {
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const titles = [`短${Date.now()}`, `长标题${Date.now()}用于检查目录同层图标固定对齐和文本省略`];
  for (const title of titles) expect((await request.post("/api/documents", { headers, data: { title } })).ok()).toBe(true);
  await page.goto("/");
  for (const theme of ["light", "dark"] as const) {
    if (theme === "dark") await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const rows = titles.map((title) => page.locator(".root-contents").getByRole("button", { name: title, exact: true }));
      const icons = [];
      for (const row of rows) {
        const box = (await row.boundingBox())!;
        const icon = (await row.locator("svg").boundingBox())!;
        icons.push(icon.x - box.x);
        expect(icon.x - box.x).toBeLessThan(8);
        await row.hover();
        await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(row).toHaveCSS("box-shadow", "none");
        await row.click();
        if (width < 821) await page.getByRole("button", { name: "返回文档目录", exact: true }).click();
        await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        expect((await row.locator("svg").boundingBox())!.x).toBe(icon.x);
      }
      expect(icons[0]).toBe(icons[1]);
      const more = page.locator(".root-contents").getByRole("button", { name: `更多操作：${titles[0]}`, exact: true });
      await more.hover();
      await expect(more).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(more).toHaveCSS("box-shadow", "none");
      await rows[0].hover();
      await page.screenshot({ path: `/tmp/zhiye-sidebar-${theme}-${width}.png` });
      const searchTab = page.locator(".sidebar-category-toggle").getByRole("button", { name: "搜索", exact: true });
      await searchTab.hover();
      await expect(searchTab).toHaveCSS("box-shadow", "none");
      await expect(searchTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await searchTab.click();
      const input = page.getByRole("searchbox", { name: "搜索文档", exact: true });
      await expect(input).toBeFocused();
      await expect(input).toHaveCSS("outline-style", "none");
      const tray = page.locator(".library-search-input");
      await expect.poll(() => tray.evaluate((element) => { const probe = document.createElement("span"); probe.style.color = "var(--vermilion)"; element.append(probe); const accent = getComputedStyle(probe).color; probe.remove(); return getComputedStyle(element).borderTopColor === accent; })).toBe(true);
      await page.screenshot({ path: `/tmp/zhiye-search-${theme}-${width}.png` });
      await page.keyboard.press("Tab");
      const caseButton = page.getByRole("button", { name: "区分大小写", exact: true });
      await expect(caseButton).toBeFocused();
      await expect(caseButton).toHaveCSS("outline-style", "solid");
      await page.locator(".sidebar-category-toggle").getByRole("button", { name: "列表", exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await page.emulateMedia({ forcedColors: "active" });
  await page.locator(".sidebar-category-toggle").getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "搜索文档", exact: true })).toHaveCSS("outline-style", "none");
  await expect(page.locator(".library-search-input")).toHaveCSS("outline-style", "solid");
  await expect(page.locator(".library-search-input")).toHaveCSS("outline-width", "2px");
});


test("flat controls reserve material depth for interaction and directory menus share one surface", async ({ page, request }) => {
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `平面菜单${Date.now()}`;
  expect((await request.post("/api/documents", { headers, data: { title } })).ok()).toBe(true);
  await page.goto("/");
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator(".sidebar-category-toggle")).toHaveCSS("box-shadow", "none");
      await expect(page.locator(".sidebar-category-toggle .ui-segmented-surface")).toHaveCSS("box-shadow", "none");
      const trigger = page.getByRole("button", { name: `更多操作：${title}`, exact: true });
      await trigger.click();
      const menu = page.getByRole("dialog", { name: `操作：${title}`, exact: true });
      await expect(menu).toHaveCSS("box-shadow", "none");
      for (const button of await menu.getByRole("button").all()) await expect(button).toHaveCSS("box-shadow", "none");
      const move = menu.getByRole("button", { name: "移动到文件夹…", exact: true });
      await expect(move).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(move).toHaveCSS("font-weight", "500");
      await move.hover();
      await expect(move).toHaveCSS("box-shadow", "none");
      await page.screenshot({ path: `/tmp/zhiye-flat-menu-${theme}-${width}.png` });
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await page.getByRole("button", { name: "导入", exact: true }).click();
  const upload = page.getByRole("dialog", { name: "导入", exact: true });
  const file = upload.getByRole("button", { name: "选择文件", exact: true });
  await expect(file).toHaveCSS("box-shadow", "none");
  await file.hover();
  await expect.poll(() => file.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
  await page.mouse.down();
  await expect.poll(() => file.evaluate((element) => getComputedStyle(element).boxShadow)).toContain("inset");
  // Cancel the pointer activation so this visual check does not open a file chooser.
  await page.mouse.move(1, 1);
  await page.mouse.up();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "快捷搜索与新建文章", exact: true }).click();
  const quick = page.getByRole("dialog", { name: "快捷搜索与新建", exact: true });
  await expect(quick.locator(".quick-actions-header > button, .quick-actions-header > svg")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/zhiye-flat-quick-desktop.png" });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: "/tmp/zhiye-flat-quick-mobile.png" });
  await page.keyboard.press("Escape");
});
