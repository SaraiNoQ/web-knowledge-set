import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("tabs compress, evict in opening order, and preserve the current dirty document", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const titles = Array.from({ length: 7 }, (_, index) => `压缩标签${Date.now()}-${index} 长标题检验`);
  for (const title of titles) expect((await request.post("/api/documents", { headers, data: { title } })).ok()).toBe(true);
  await page.goto("/");
  const tabs = page.getByRole("navigation", { name: "已打开的文章" });
  for (const title of titles) await page.locator(".directory-document-row").getByRole("button", { name: title, exact: true }).click();
  await expect(tabs.locator(".document-tab")).toHaveCount(7);
  expect((await page.locator(".document-tabbar").boundingBox())!.height).toBe(33);
  const widths = await tabs.locator(".document-tab").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
  expect(widths.every((width) => width < 210 && width >= 120)).toBe(true);
  expect(await tabs.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await tabs.getByRole("button", { name: titles[0], exact: true }).click();
  await page.getByRole("button", { name: "编辑这篇知识", exact: true }).click();
  await page.getByRole("textbox", { name: "Markdown 编辑器" }).fill("# 必须保留的草稿");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tabs.locator(".document-tab")).toHaveCount(2);
  await expect(tabs.locator('.document-tab-select[aria-pressed="true"]')).toHaveAttribute("title", titles[0]);
  await expect(tabs.getByRole("button", { name: titles[6], exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Markdown 编辑器" })).toHaveText("# 必须保留的草稿");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(await tabs.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect((await (await request.get("/api/documents")).json()).items.filter((item: { title: string }) => titles.includes(item.title))).toHaveLength(7);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 900 });
  for (const title of titles.slice(1, 6)) await page.locator(".directory-document-row").getByRole("button", { name: title, exact: true }).click();
  await expect(tabs.locator(".document-tab")).toHaveCount(4);
  await expect(tabs.locator(".document-tab-select")).toHaveText(titles.slice(2, 6));
  await tabs.getByRole("button", { name: titles[2], exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tabs.locator(".document-tab-select")).toHaveText(titles.slice(4, 6));
  await expect(tabs.locator('.document-tab-select[aria-pressed="true"]')).toHaveAttribute("title", titles[4]);
});

test("tab capacity resumes after a pending organization update", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const titles = Array.from({ length: 3 }, (_, index) => `延迟收藏标签${Date.now()}-${index}`);
  for (const title of titles) expect((await request.post("/api/documents", { headers, data: { title } })).ok()).toBe(true);
  let finishUpdate!: () => void;
  const pending = new Promise<void>((resolve) => { finishUpdate = resolve; });
  await page.route("**/api/documents/*", async (route) => {
    if (route.request().method() === "PATCH" && "favorite" in route.request().postDataJSON()) await pending;
    await route.continue();
  });
  await page.goto("/");
  for (const title of titles) await page.locator(".directory-document-row").getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "设为收藏", exact: true }).click();
  const tabs = page.getByRole("navigation", { name: "已打开的文章" });
  await expect(tabs.locator(".document-tab-select").last()).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tabs.locator(".document-tab")).toHaveCount(3);
  finishUpdate();
  await expect(tabs.locator(".document-tab-select")).toHaveText(titles.slice(1));
});

for (const cloud of [false, true]) test(`right outline folds and navigates real headings in ${cloud ? "web" : "local"} mode`, async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  if (cloud) await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `大纲验收${cloud}-${Date.now()}`;
  const { document } = await (await request.post("/api/documents", { headers, data: { title } })).json();
  const markdown = `# 根标题\n\n## 子标题\n\n#### 跳级标题\n\n\`\`\`md\n# 代码中的假标题\n\`\`\`\n\n${"正文段落。\n\n".repeat(50)}## 中部跳转\n\n${"正文段落。\n\n".repeat(50)}## 重复标题\n\n内容\n\n## 重复标题\n`;
  expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { markdown, revision: document.revision } })).ok()).toBe(true);
  await page.goto("/");
  await page.locator(".directory-document-row").getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "展开右侧功能区", exact: true }).click();
  const outline = page.getByRole("navigation", { name: "Markdown 大纲" });
  await expect(outline.getByRole("button", { name: "代码中的假标题", exact: true })).toHaveCount(0);
  await expect(outline.locator(".outline-heading")).toHaveCount(6);
  await outline.getByRole("button", { name: "折叠 子标题", exact: true }).click();
  await expect(outline.getByRole("button", { name: "跳级标题", exact: true })).toHaveCount(0);
  await outline.getByRole("button", { name: "展开 子标题", exact: true }).click();
  await outline.getByRole("button", { name: "重复标题", exact: true }).last().click();
  await expect(page.locator('.reader-main .markdown-preview h2').last()).toBeInViewport();
  await page.screenshot({ path: `test-results/outline-${cloud ? "web" : "local"}-reading.png` });
  if (cloud) await page.getByRole("button", { name: "编辑这篇知识", exact: true }).click();
  await page.getByRole("button", { name: "对照", exact: true }).click();
  await outline.getByRole("button", { name: "中部跳转", exact: true }).click();
  await expect.poll(async () => {
    const heading = await page.locator(".markdown-preview").getByRole("heading", { name: "中部跳转", exact: true }).boundingBox();
    const toolbar = await page.locator(".editor-toolbar").boundingBox();
    return heading!.y >= toolbar!.y + toolbar!.height - 1 && heading!.y + heading!.height <= page.viewportSize()!.height;
  }).toBe(true);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await outline.getByRole("button", { name: "折叠 子标题", exact: true }).click();
  await page.getByRole("textbox", { name: "Markdown 编辑器" }).fill(`前言段落。\n\n${markdown}`);
  await expect(outline.getByRole("button", { name: "跳级标题", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Markdown 编辑器" }).fill("# 删除前父级\n\n## 保留子级\n");
  await outline.getByRole("button", { name: "折叠 删除前父级", exact: true }).click();
  await page.getByRole("textbox", { name: "Markdown 编辑器" }).fill("## 保留子级\n\n### 保留后代\n");
  await expect(outline.getByRole("button", { name: "保留后代", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Markdown 编辑器" }).fill("# 新草稿\n\n## 编辑定位\n");
  await expect(outline.getByRole("button", { name: "新草稿", exact: true })).toBeVisible();
  await outline.getByRole("button", { name: "编辑定位", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Markdown 编辑器" })).toBeFocused();
  await page.getByRole("button", { name: "收起右侧功能区", exact: true }).click();
  await expect(outline).toHaveCount(0);
  await page.getByRole("button", { name: "展开右侧功能区", exact: true }).click();
  for (const width of [1440, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
  await page.screenshot({ path: `test-results/outline-${cloud ? "web" : "local"}-mobile.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `test-results/outline-${cloud ? "web" : "local"}-desktop.png` });
  expect((await new AxeBuilder({ page }).include(".document-tools").analyze()).violations).toEqual([]);
});

for (const cloud of [false, true]) {
  test(`document tabs switch, close and protect edits in ${cloud ? "web" : "local"} mode`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
    await page.route("**/api/settings/appearance", (route) => route.fulfill({ json: { immersiveMode: route.request().method() === "GET" ? false : route.request().postDataJSON().immersiveMode } }));
    if (cloud) await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
    await page.goto("/");
    const create = { click: async () => {
      await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "快捷搜索与新建文章", exact: true }).click();
      await page.getByRole("dialog", { name: "快捷搜索与新建", exact: true }).getByRole("option", { name: /新建空白文章/ }).click();
    } };
    await create.click();
    if (cloud) await page.getByRole("button", { name: "编辑这篇知识" }).click();
    if (cloud) {
      await page.getByRole("button", { name: "重命名文章", exact: true }).dblclick();
      await page.getByRole("textbox", { name: "文章标题", exact: true }).fill("第一篇工作笔记");
      await page.getByRole("textbox", { name: "文章标题", exact: true }).press("Enter");
      await expect(page.getByRole("button", { name: "重命名文章", exact: true })).toHaveAttribute("title", "第一篇工作笔记");
    } else await page.getByLabel("文档标题").fill("第一篇工作笔记");
    await page.getByRole("textbox", { name: "Markdown 编辑器" }).fill("第一篇已保存正文。");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已保存", { exact: true })).toBeVisible();
    await create.click();
    const tabs = page.getByRole("navigation", { name: "已打开的文章" });
    await expect(tabs.locator(".document-tab-select")).toHaveCount(2);
    if (cloud) await page.getByRole("button", { name: "编辑这篇知识" }).click();
    if (cloud) {
      await page.getByRole("button", { name: "重命名文章", exact: true }).dblclick();
      await page.getByRole("textbox", { name: "文章标题", exact: true }).fill("第二篇工作笔记");
      await page.getByRole("textbox", { name: "文章标题", exact: true }).press("Enter");
      await expect(page.getByRole("button", { name: "重命名文章", exact: true })).toHaveAttribute("title", "第二篇工作笔记");
    } else await page.getByLabel("文档标题").fill("第二篇工作笔记");
    await page.getByRole("textbox", { name: "Markdown 编辑器" }).fill("第二篇已保存正文。");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(tabs.getByRole("button", { name: "第二篇工作笔记", exact: true })).toBeVisible();
    await tabs.getByRole("button", { name: "第一篇工作笔记", exact: true }).click();
    await expect(tabs.getByRole("button", { name: "第一篇工作笔记", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(tabs.locator(".document-tab-select")).toHaveCount(2);
    await tabs.getByRole("button", { name: "第一篇工作笔记", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.getByRole("button", { name: "第二篇工作笔记", exact: true })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(tabs.getByRole("button", { name: "第一篇工作笔记", exact: true })).toBeFocused();
    if (!cloud) {
      await page.getByLabel("作者", { exact: true }).fill("尚未保存的作者");
      await tabs.getByRole("button", { name: "第二篇工作笔记", exact: true }).click();
      const metadataDialog = page.getByRole("alertdialog", { name: "存在未保存修改" });
      await metadataDialog.getByRole("button", { name: "取消" }).click();
      await expect(page.getByLabel("作者", { exact: true })).toHaveValue("尚未保存的作者");
      await page.getByLabel("作者", { exact: true }).fill("");
    }
    if (cloud) await page.getByRole("button", { name: "编辑这篇知识" }).click();
    await page.getByRole("textbox", { name: "Markdown 编辑器" }).fill("尚未保存的内容。");
    await page.getByRole("button", { name: "关闭文章：第一篇工作笔记" }).click();
    const dialog = page.getByRole("alertdialog", { name: "存在未保存修改" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(tabs.locator(".document-tab-select")).toHaveCount(2);
    await expect(page.getByRole("textbox", { name: "Markdown 编辑器" })).toHaveText("尚未保存的内容。");
    await page.setViewportSize({ width: 1440, height: 600 });
    for (const immersive of [false, true]) {
      if (immersive) await page.getByRole("button", { name: "进入沉浸模式", exact: true }).click();
      await page.locator(".editor-toolbar").evaluate((element) => element.scrollIntoView({ block: "start" }));
      const toolbar = await page.locator(".editor-toolbar").boundingBox();
      const bar = await page.locator(".document-tabbar").boundingBox();
      expect(toolbar!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height);
      await expect(page.getByRole("button", { name: "保存", exact: true })).toBeVisible();
      if (immersive) await page.getByRole("button", { name: "退出沉浸模式", exact: true }).click();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    while (await page.getByRole("button", { name: "关闭通知", exact: true }).count()) await page.getByRole("button", { name: "关闭通知", exact: true }).first().click();
    await page.screenshot({ path: info.outputPath(`workspace-${cloud ? "web" : "local"}.png`) });
    await page.getByRole("button", { name: "关闭文章：第二篇工作笔记" }).click();
    await expect(tabs.locator(".document-tab-select")).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "Markdown 编辑器" })).toHaveText("尚未保存的内容。");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已保存", { exact: true })).toBeVisible();
    await create.click();
    await page.getByRole("button", { name: "关闭文章：未命名文章" }).click();
    await expect(tabs.getByRole("button", { name: "第一篇工作笔记", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "返回文档目录", exact: true }).click();
    await expect(tabs.locator(".document-tab-select")).toHaveCount(1);
    await tabs.getByRole("button", { name: "第一篇工作笔记", exact: true }).click();
    await expect(tabs.getByRole("button", { name: "第一篇工作笔记", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    while (await page.getByRole("button", { name: "关闭通知", exact: true }).count()) await page.getByRole("button", { name: "关闭通知", exact: true }).first().click();
    await page.screenshot({ path: info.outputPath(`workspace-mobile-${cloud ? "web" : "local"}.png`) });
    await page.getByRole("button", { name: "关闭文章：第一篇工作笔记" }).click();
    await expect(page.getByRole("complementary", { name: "知识列表" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "工作台导航" })).toBeVisible();
  });
}

test("long folder breadcrumbs fit small screens and the rail scrolls on landscape", async ({ page, request }) => {
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/api/settings/appearance", (route) => route.fulfill({ json: { immersiveMode: route.request().method() === "GET" ? false : route.request().postDataJSON().immersiveMode } }));
  const list = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": list.headers()["x-zhiye-data-epoch"] };
  const folderName = "这是用于检验小屏幕位置栏截断的长文件夹名称".repeat(3);
  const created = await request.post("/api/folders", { headers, data: { name: folderName } });
  expect(created.ok()).toBe(true);
  const folder = await created.json();
  await page.goto("/");
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "快捷搜索与新建文章", exact: true }).click();
  await page.getByRole("dialog", { name: "快捷搜索与新建", exact: true }).getByRole("option", { name: /新建空白文章/ }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("未命名文章");
  const row = page.locator(".directory-document-row.is-selected");
  await row.getByRole("button", { name: /^更多操作/ }).click();
  await page.getByRole("dialog", { name: /^操作/ }).getByRole("button", { name: "移动到文件夹…" }).click();
  const move = page.getByRole("dialog", { name: "移动到文件夹" });
  await move.getByRole("combobox").click();
  await page.getByRole("option", { name: folderName, exact: true }).click();
  await move.getByRole("button", { name: "移动", exact: true }).click();
  await expect(page.locator(".workspace-location > span")).toHaveText(folderName);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 844, height: 390 });
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  await expect.poll(() => rail.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await rail.getByRole("button", { name: "配置 AI", exact: true }).scrollIntoViewIfNeeded();
  const button = await rail.getByRole("button", { name: "配置 AI", exact: true }).boundingBox();
  expect(button!.y).toBeGreaterThanOrEqual(0);
  expect(button!.y + button!.height).toBeLessThanOrEqual(390);
  await request.delete(`/api/folders/${folder.id}`, { headers });
});
