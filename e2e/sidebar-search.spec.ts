import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/api/settings/appearance", (route) => route.fulfill({ json: { immersiveMode: route.request().method() === "GET" ? false : route.request().postDataJSON().immersiveMode } }));
});

async function seed(request: APIRequestContext, title: string, markdown: string, favorite = false) {
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const created = await request.post("/api/documents", { headers, data: { title } });
  expect(created.ok()).toBe(true);
  const { document } = await created.json();
  const patched = await request.patch(`/api/documents/${document.id}`, { headers, data: { markdown, favorite, revision: document.revision } });
  expect(patched.ok()).toBe(true);
  return patched.json();
}

async function chooseSearchOption(page: Page, name: string, option: string) {
  await page.locator(".library-search").getByRole("combobox", { name, exact: true }).click();
  await expect(page.getByRole("listbox", { name, exact: true })).toBeVisible();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function search(page: Page, query: string) {
  await page.getByLabel("目录分类", { exact: true }).getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByRole("searchbox", { name: "搜索文档", exact: true }).fill(query);
  return page.locator(".library-search");
}

function result(id: string, title: string, matches: string[] = []) {
  return { id, title, kind: "article", sourceUrl: "", finalUrl: null, canonicalUrl: null, author: null, status: "ready", warning: null, errorCode: null, errorMessage: null, tags: [], collections: [], folderId: null, favorite: false, archivedAt: null, revision: 1, deletedAt: null, createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", searchMatches: matches };
}

test("directory categories align with article tabs and reuse existing views", async ({ page, request }) => {
  const document = await seed(request, "顶部分类验收文章", "顶部分类验收正文", true);
  await page.goto("/");
  const categories = page.getByLabel("目录分类", { exact: true });
  await expect(categories.getByRole("button")).toHaveCount(5);
  await expect(categories.getByRole("button", { name: "列表", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const immersive of [false, true]) {
    if (immersive) await page.getByRole("button", { name: "进入沉浸模式", exact: true }).click();
    const header = await categories.boundingBox();
    const articleTabs = await page.locator(".document-tabbar").boundingBox();
    expect(header!.height).toBe(33);
    expect(header!.y).toBe(articleTabs!.y);
    expect(header!.height).toBe(articleTabs!.height);
    if (immersive) await page.getByRole("button", { name: "退出沉浸模式", exact: true }).click();
  }
  await categories.getByRole("button", { name: "收藏", exact: true }).click();
  await expect(page.locator(".directory-document-row").getByRole("button", { name: document.title, exact: true })).toBeVisible();
  await expect(categories.getByRole("button", { name: "收藏", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const [name, field, value] of [["论文", "kind", "paper"], ["回收站", "trash", "only"]]) {
    const queried = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/api/documents" && url.searchParams.get(field) === value;
    });
    await categories.getByRole("button", { name, exact: true }).click();
    await queried;
    await expect(categories.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  await categories.getByRole("button", { name: "列表", exact: true }).click();
  await expect(page.locator(".directory-document-row").getByRole("button", { name: document.title, exact: true })).toBeVisible();
});

test("search opens body matches and category changes protect unsaved edits", async ({ page, request }) => {
  const document = await seed(request, "联邦搜索验收", "第一段正文。\n\n唯一检索词：联邦原型分析。");
  await page.goto("/");
  const panel = await search(page, "联邦原型");
  await expect(panel.locator(".library-search-result-title")).toHaveText(document.title);
  await expect(panel.locator("mark")).toContainText(["联邦原型"]);
  await panel.locator(".library-search-snippets button").first().click();
  await expect(page.getByRole("navigation", { name: "已打开的文章" }).getByRole("button", { name: document.title, exact: true })).toBeVisible();
  await page.getByLabel("目录分类", { exact: true }).getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByRole("button", { name: "重命名文章", exact: true })).toHaveAttribute("title", document.title);
  await page.getByLabel("目录分类", { exact: true }).getByRole("button", { name: "列表", exact: true }).click();
  await page.getByLabel("目录分类", { exact: true }).getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "搜索文档", exact: true })).toHaveValue("联邦原型");
  await expect(panel.locator(".library-search-result-title")).toHaveText(document.title);
  await panel.locator(".library-search-result-title").click();
  await page.getByRole("button", { name: "编辑这篇知识", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 编辑器" });
  await editor.fill("分类切换前尚未保存的正文");
  await page.getByLabel("目录分类", { exact: true }).getByRole("button", { name: "收藏", exact: true }).click();
  await page.getByRole("alertdialog", { name: "存在未保存修改" }).getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor).toHaveText("分类切换前尚未保存的正文");
  await expect(page.getByLabel("目录分类", { exact: true }).getByRole("button", { name: "搜索", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("quick actions search, open results, create named articles, and protect drafts", async ({ page, request }) => {
  const suffix = Date.now();
  const searchTerm = `QuickPaletteBody${suffix}`;
  const document = await seed(request, `快捷面板搜索结果${suffix}`, `${searchTerm} 命中正文。`, false);
  await page.goto("/");
  const railSearch = page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "快捷搜索与新建文章", exact: true });
  await railSearch.click();
  const dialog = page.getByRole("dialog", { name: "快捷搜索与新建", exact: true });
  const input = dialog.getByRole("combobox", { name: "搜索资料或输入文章标题", exact: true });
  await expect(input).toBeFocused();
  await input.fill(searchTerm);
  await expect(dialog.getByRole("option", { name: new RegExp(document.title) })).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "已打开的文章" }).getByRole("button", { name: document.title, exact: true })).toBeVisible();

  await railSearch.click();
  const currentInput = dialog.getByRole("combobox", { name: "搜索资料或输入文章标题", exact: true });
  await expect(dialog.getByRole("option", { name: /新建空白文章/ })).toBeVisible();
  await currentInput.fill(searchTerm);
  await expect(dialog.getByRole("option", { name: new RegExp(document.title) })).toBeVisible();
  await currentInput.fill(`${searchTerm} `);
  await expect(dialog.getByRole("option", { name: new RegExp(document.title) })).toBeVisible();
  await currentInput.press("Enter");
  await expect(dialog).toHaveCount(0);

  await railSearch.click();
  const createTitle = `快捷面板新建标题${suffix}`;
  await dialog.getByRole("combobox", { name: "搜索资料或输入文章标题", exact: true }).fill(createTitle);
  await expect(dialog.getByRole("option", { name: new RegExp(createTitle) })).toBeVisible();
  await dialog.getByRole("combobox", { name: "搜索资料或输入文章标题", exact: true }).press("Shift+Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重命名文章", exact: true })).toHaveAttribute("title", createTitle);

  await railSearch.click();
  const enterTitle = `回车创建的快捷文章${suffix}`;
  const enterInput = dialog.getByRole("combobox", { name: "搜索资料或输入文章标题", exact: true });
  await enterInput.fill(enterTitle);
  await expect(dialog.getByRole("option", { name: new RegExp(enterTitle) })).toBeVisible();
  await enterInput.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重命名文章", exact: true })).toHaveAttribute("title", enterTitle);

  await page.getByRole("button", { name: "编辑这篇知识", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 编辑器" });
  await editor.fill("创建前必须保护的未保存正文");
  await railSearch.click();
  const openInput = dialog.getByRole("combobox", { name: "搜索资料或输入文章标题", exact: true });
  await openInput.fill(searchTerm);
  await expect(dialog.getByRole("option", { name: new RegExp(document.title) })).toBeVisible();
  await openInput.press("Enter");
  const openDiscard = page.getByRole("alertdialog", { name: "存在未保存修改" });
  await expect(openDiscard).toBeVisible();
  await openDiscard.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(openInput).toBeFocused();
  await expect(editor).toHaveText("创建前必须保护的未保存正文");

  const unsavedTitle = `不应创建的文章${suffix}`;
  const createInput = dialog.getByRole("combobox", { name: "搜索资料或输入文章标题", exact: true });
  await createInput.fill(unsavedTitle);
  await expect(dialog.getByRole("option", { name: new RegExp(unsavedTitle) })).toBeVisible();
  await createInput.press("Enter");
  const discard = page.getByRole("alertdialog", { name: "存在未保存修改" });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(createInput).toHaveValue(unsavedTitle);
  await expect(createInput).toBeFocused();
  await expect(dialog.getByRole("alert")).toContainText("未保存内容和当前输入都已保留");
  await expect(editor).toHaveText("创建前必须保护的未保存正文");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重命名文章", exact: true })).toHaveAttribute("title", enterTitle);
  await expect(editor).toHaveText("创建前必须保护的未保存正文");
});

test("quick actions shortcuts open the centered panel and Escape restores focus", async ({ page }) => {
  await page.goto("/");
  const railSearch = page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "快捷搜索与新建文章", exact: true });
  await railSearch.click();
  const dialog = page.getByRole("dialog", { name: "快捷搜索与新建", exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(railSearch).toBeFocused();

  await page.keyboard.press("Control+k");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("quick actions keep their paper surface inside narrow dark viewports", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
  const railSearch = page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "快捷搜索与新建文章", exact: true });
  await railSearch.click();
  const dialog = page.getByRole("dialog", { name: "快捷搜索与新建", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const panel = await dialog.locator(".quick-actions-panel").boundingBox();
    expect(panel).not.toBeNull();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(width);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("quick actions stay compact and accessible across themes, content, and search states", async ({ page }) => {
  let finishSearch!: () => void;
  const searchReady = new Promise<void>((resolve) => { finishSearch = resolve; });
  await page.route("**/api/documents?**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (!query) return route.continue();
    if (query === "失败状态") return route.fulfill({ status: 503, json: { error: { code: "INTERNAL_ERROR", message: "搜索暂不可用，请稍后重试。" } } });
    await searchReady;
    return route.fulfill({ json: { items: Array.from({ length: 7 }, (_, index) => result(`visual-${index}`, `${index + 1} · 长标题与中英文混排 ${"检索体验 / Reading notes ".repeat(12)}`, ["用于检查命中片段的行高、层级与截断。".repeat(8)])), total: 9, page: 1, pageSize: 50 } });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "快捷搜索与新建文章", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "快捷搜索与新建", exact: true });
  const panel = dialog.locator(".quick-actions-panel");
  const input = dialog.getByRole("combobox", { name: "搜索资料或输入文章标题", exact: true });
  const empty = await panel.boundingBox();
  expect(empty!.width).toBeLessThanOrEqual(640);
  expect(empty!.height).toBeLessThan(210);
  await panel.screenshot({ path: "test-results/quick-actions-light.png" });
  await input.fill("长标题检索");
  await expect(dialog.getByRole("status", { name: "正在搜索资料" })).toBeVisible();
  finishSearch();
  await expect(dialog.getByRole("option")).toHaveCount(7);
  await input.press("ArrowDown");
  await expect(dialog.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await panel.screenshot({ path: "test-results/quick-actions-results.png" });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1440, 800, 390, 320]) {
      await page.setViewportSize({ width, height: 700 });
      const bounds = await panel.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700);
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(dialog.locator(".quick-actions-footer")).toBeInViewport();
      await input.press("End");
      for (let index = 0; index < 7; index++) {
        await input.press("ArrowDown");
        await expect(dialog.locator('[role="option"][aria-selected="true"]')).toBeInViewport();
      }
    }
    expect((await new AxeBuilder({ page }).include(".quick-actions-panel").analyze()).violations).toEqual([]);
    await panel.screenshot({ path: `test-results/quick-actions-${theme}-mobile.png` });
  }
  await input.fill("失败状态");
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(input).toBeFocused();
  await input.fill("");
  await expect(dialog.getByRole("option", { name: /新建空白文章/ })).toBeVisible();
  await input.press("Tab");
  await expect(dialog.getByRole("button", { name: "关闭快捷面板" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("the map rail entry returns to the selected directory category", async ({ page, request }) => {
  const document = await seed(request, `地图返回收藏${Date.now()}`, "收藏状态应保留。", true);
  await page.goto("/");
  const categories = page.getByRole("navigation", { name: "目录分类" });
  await categories.getByRole("button", { name: "收藏", exact: true }).click();
  await expect(page.locator(".directory-document-row").getByRole("button", { name: document.title, exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "查看知识地图", exact: true }).click();
  await expect(page.getByRole("heading", { name: "知识地图", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "文档资料库", exact: true }).click();
  await expect(categories.getByRole("button", { name: "收藏", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".directory-document-row").getByRole("button", { name: document.title, exact: true })).toBeVisible();
});

test("search keeps snippets as text and treats punctuation and multiple words literally", async ({ page, request }) => {
  const title = "SearchSafe Alpha [bracket]";
  await seed(request, title, '<img src=x onerror="window.__searchXss=true"> SearchSafe Alpha [bracket] 100%_marker');
  await seed(request, "SearchSafe Alpha distractor", "SearchSafe Alpha only");
  await page.goto("/");
  const panel = await search(page, "SearchSafe [bracket]");
  await expect(panel.locator(".library-search-result-title")).toHaveText(title);
  await expect(panel.locator(".library-search-snippets")).toContainText('<img src=x onerror="window.__searchXss=true">');
  await expect(panel.locator("img, script")).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { __searchXss?: boolean }).__searchXss)).toBeUndefined();
  await page.getByRole("searchbox", { name: "搜索文档", exact: true }).fill("100%_marker");
  await expect(panel.locator(".library-search-result-title")).toHaveText(title);
  await expect(panel.locator("mark")).toContainText(["100%_marker"]);
});

test("search settings use actual fields and Aa distinguishes case", async ({ page, request }) => {
  const document = await seed(request, "SearchCASE 标题", "SearchCASE 正文 alpha", true);
  await page.goto("/");
  const panel = await search(page, "searchcase");
  await expect(panel.locator(".library-search-result-title")).toHaveText(document.title);
  await panel.getByRole("button", { name: "区分大小写", exact: true }).click();
  await expect(panel.getByText("没有找到匹配文档。试试其他关键词或调整搜索设置。", { exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "搜索文档", exact: true }).fill("SearchCASE");
  await expect(panel.locator(".library-search-result-title")).toHaveText(document.title);
  await panel.getByRole("button", { name: "搜索设置", exact: true }).click();
  await chooseSearchOption(page, "搜索范围", "正文");
  await chooseSearchOption(page, "搜索文档类型", "文章");
  await panel.getByRole("checkbox", { name: "仅搜索收藏", exact: true }).check();
  await expect(panel.locator(".library-search-result-title")).toHaveText(document.title);
  await page.getByRole("searchbox", { name: "搜索文档", exact: true }).fill("标题");
  await expect(panel.getByText("没有找到匹配文档。试试其他关键词或调整搜索设置。", { exact: true })).toBeVisible();
  await chooseSearchOption(page, "搜索范围", "标题");
  await expect(panel.locator(".library-search-result-title")).toHaveText(document.title);
});

test("search supports paging, sorting, collapsing and more context", async ({ page }) => {
  const requests: URL[] = [];
  await page.route("**/api/documents?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("q") !== "PagingMatch") return route.continue();
    requests.push(url);
    const currentPage = Number(url.searchParams.get("page") || 1);
    await route.fulfill({ json: { items: [result(`page-${currentPage}`, `PagingMatch 文档 ${currentPage}`, Array.from({ length: 5 }, (_, index) => `PagingMatch 第 ${index + 1} 个上下文`))], total: 21, page: currentPage, pageSize: 20 } });
  });
  await page.goto("/");
  const panel = await search(page, "PagingMatch");
  await expect(panel.locator(".library-search-snippets button")).toHaveCount(2);
  await panel.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(panel.locator(".library-search-result-title")).toHaveText("PagingMatch 文档 2");
  await chooseSearchOption(page, "搜索结果排序", "标题 (A–Z)");
  await expect(panel.locator(".library-search-result-title")).toHaveText("PagingMatch 文档 1");
  await expect.poll(() => requests.at(-1)?.searchParams.get("sort")).toBe("title");
  await panel.getByRole("button", { name: "搜索设置", exact: true }).click();
  await panel.getByRole("switch", { name: "显示更多上下文", exact: true }).check();
  await expect(panel.locator(".library-search-snippets button")).toHaveCount(5);
  await panel.getByRole("switch", { name: "折叠搜索结果", exact: true }).check();
  await expect(panel.locator(".library-search-snippets")).toHaveCount(0);
  await panel.getByRole("button", { name: "展开 PagingMatch 文档 1 的搜索结果", exact: true }).click();
  await expect(panel.locator(".library-search-snippets button")).toHaveCount(5);
});

test("late search responses cannot overwrite newer results and history can be cleared", async ({ page }) => {
  let releaseOld!: () => void;
  const oldResponse = new Promise<void>((resolve) => { releaseOld = resolve; });
  let oldStarted = false;
  let oldFinished = false;
  await page.route("**/api/documents?**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query !== "StaleOld" && query !== "FreshNew") return route.continue();
    if (query === "StaleOld") { oldStarted = true; await oldResponse; }
    await route.fulfill({ json: { items: [result(query, `${query} 文档`, [`${query} 正文`])], total: 1, page: 1, pageSize: 20 } }).catch(() => undefined);
    if (query === "StaleOld") oldFinished = true;
  });
  await page.goto("/");
  const panel = await search(page, "StaleOld");
  await expect.poll(() => oldStarted).toBe(true);
  await page.getByRole("searchbox", { name: "搜索文档", exact: true }).fill("FreshNew");
  await expect(panel.locator(".library-search-result-title")).toHaveText("FreshNew 文档");
  releaseOld();
  await expect.poll(() => oldFinished).toBe(true);
  await expect(panel.locator(".library-search-result-title")).toHaveText("FreshNew 文档");
  await panel.getByRole("button", { name: "清空搜索", exact: true }).click();
  await expect(panel.getByRole("button", { name: "FreshNew", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "StaleOld", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "FreshNew", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "搜索文档", exact: true })).toHaveValue("FreshNew");
  await expect(panel.locator(".library-search-result-title")).toHaveText("FreshNew 文档");
  await panel.getByRole("button", { name: "清空搜索", exact: true }).click();
  await panel.getByRole("button", { name: "清除搜索历史", exact: true }).click();
  await expect(panel.getByText("搜索历史", { exact: true })).toHaveCount(0);
});

test("search categories and controls fit mobile dark mode", async ({ page }) => {
  await page.goto("/");
  await search(page, "");
  await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
  await page.locator(".library-search").getByRole("button", { name: "搜索设置", exact: true }).click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByLabel("目录分类", { exact: true }).getByRole("button", { name: "搜索", exact: true })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "搜索文档", exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("mobile rail opens quick actions without leaving the current search or reader", async ({ page, request }) => {
  const document = await seed(request, "手机搜索返回验收", "MobileReturnToken 正文用于验证手机搜索返回。");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const panel = await search(page, "MobileReturnToken");
  const resultTitle = panel.locator(".library-search-result-title");
  await expect(resultTitle).toHaveText(document.title);
  await resultTitle.click();
  await expect(page.getByRole("button", { name: "重命名文章", exact: true })).toHaveText(document.title);
  await expect(panel).toBeHidden();
  const railSearch = page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "快捷搜索与新建文章", exact: true });
  await railSearch.click();
  const quickActions = page.getByRole("dialog", { name: "快捷搜索与新建", exact: true });
  await expect(quickActions).toBeVisible();
  await expect(panel).toBeHidden();
  await expect(quickActions.getByRole("combobox", { name: "搜索资料或输入文章标题", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(quickActions).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重命名文章", exact: true })).toHaveAttribute("title", document.title);
  await page.getByRole("button", { name: "编辑这篇知识", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 编辑器" });
  await editor.fill("手机搜索返回之前尚未保存的正文");
  await railSearch.click();
  await expect(quickActions).toBeVisible();
  await expect(page.getByRole("alertdialog", { name: "存在未保存修改" })).toHaveCount(0);
  await expect(editor).toHaveText("手机搜索返回之前尚未保存的正文");
  await page.keyboard.press("Escape");
  await expect(quickActions).toHaveCount(0);
  await expect(editor).toHaveText("手机搜索返回之前尚未保存的正文");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("directory scroll leaves the category bar fixed and has no duplicate search filters", async ({ page }) => {
  await page.route("**/api/documents?**", (route) => route.fulfill({ json: {
    items: Array.from({ length: 60 }, (_, index) => result(`scroll-${index}`, `滚动验收文档 ${index + 1}`)),
    total: 60, page: 1, pageSize: 100,
  } }));
  await page.goto("/");
  const library = page.getByRole("complementary", { name: "知识列表" });
  const categories = page.getByRole("navigation", { name: "目录分类" });
  await expect(library.getByRole("searchbox")).toHaveCount(0);
  await expect(library.getByRole("combobox", { name: "搜索范围", exact: true })).toHaveCount(0);
  await expect(library.getByText("搜索范围", { exact: true })).toHaveCount(0);
  await expect(library.getByRole("button", { name: "滚动验收文档 60", exact: true })).toBeAttached();
  const region = library.locator(".sidebar-scroll-region");
  await region.hover();
  // Hover can scroll the containing page into view; compare only the wheel's
  // effect after that positioning has completed.
  const barBefore = (await categories.boundingBox())!;
  const regionBefore = (await region.boundingBox())!;
  expect(regionBefore.y).toBeGreaterThanOrEqual(barBefore.y + barBefore.height);
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => library.evaluate((element) => element.scrollTop)).toBe(0);
  const barAfter = (await categories.boundingBox())!;
  expect(barAfter.y).toBe(barBefore.y);
  expect(barAfter.height).toBe(barBefore.height);
  await region.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(library.getByRole("button", { name: "滚动验收文档 60", exact: true })).toBeInViewport();
});

test("search input and custom field menus reuse the existing compact controls", async ({ page, request }) => {
  const document = await seed(request, "控件样式验收", "CustomSelectToken 正文");
  await page.goto("/");
  const panel = await search(page, "CustomSelectToken");
  await expect(panel.locator(".library-search-input")).toHaveCSS("border-radius", "4px");
  await panel.getByRole("button", { name: "搜索设置", exact: true }).click();
  const scope = panel.getByRole("combobox", { name: "搜索范围", exact: true });
  await scope.click();
  const menu = page.getByRole("listbox", { name: "搜索范围", exact: true });
  await expect(menu).toHaveClass(/ui-select-menu/u);
  await page.getByRole("option", { name: "正文", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(scope).toContainText("正文");
  await expect(panel.locator(".library-search-result-title")).toHaveText(document.title);
  await chooseSearchOption(page, "搜索范围", "标题");
  await expect(panel.getByText("没有找到匹配文档。试试其他关键词或调整搜索设置。", { exact: true })).toBeVisible();
  await chooseSearchOption(page, "搜索范围", "正文");
  await expect(panel.locator(".library-search-result-title")).toHaveText(document.title);
});
