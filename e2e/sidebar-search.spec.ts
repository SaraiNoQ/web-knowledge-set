import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

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
    expect(header!.height).toBe(44);
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
  await expect(page.getByRole("button", { name: "重命名文章", exact: true })).toHaveText(document.title);
  await page.getByLabel("目录分类", { exact: true }).getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByRole("button", { name: "重命名文章", exact: true })).toHaveText(document.title);
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
  await panel.getByRole("combobox", { name: "搜索范围", exact: true }).selectOption("body");
  await panel.getByRole("combobox", { name: "搜索文档类型", exact: true }).selectOption("article");
  await panel.getByRole("checkbox", { name: "仅搜索收藏", exact: true }).check();
  await expect(panel.locator(".library-search-result-title")).toHaveText(document.title);
  await page.getByRole("searchbox", { name: "搜索文档", exact: true }).fill("标题");
  await expect(panel.getByText("没有找到匹配文档。试试其他关键词或调整搜索设置。", { exact: true })).toBeVisible();
  await panel.getByRole("combobox", { name: "搜索范围", exact: true }).selectOption("title");
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
  await panel.getByRole("combobox", { name: "搜索结果排序", exact: true }).selectOption("title");
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

test("mobile rail search reopens saved results and guards unsaved reader edits", async ({ page, request }) => {
  const document = await seed(request, "手机搜索返回验收", "MobileReturnToken 正文用于验证手机搜索返回。");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const panel = await search(page, "MobileReturnToken");
  const resultTitle = panel.locator(".library-search-result-title");
  await expect(resultTitle).toHaveText(document.title);
  await resultTitle.click();
  await expect(page.getByRole("button", { name: "重命名文章", exact: true })).toHaveText(document.title);
  await expect(panel).toBeHidden();
  const railSearch = page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "搜索文档", exact: true });
  await railSearch.click();
  await expect(panel).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "搜索文档", exact: true })).toHaveValue("MobileReturnToken");
  await expect(resultTitle).toHaveText(document.title);
  await resultTitle.click();
  await page.getByRole("button", { name: "编辑这篇知识", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 编辑器" });
  await editor.fill("手机搜索返回之前尚未保存的正文");
  await railSearch.click();
  const confirm = page.getByRole("alertdialog", { name: "存在未保存修改" });
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor).toHaveText("手机搜索返回之前尚未保存的正文");
  await expect(panel).toBeHidden();
  await railSearch.click();
  await confirm.getByRole("button", { name: "继续并放弃", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "搜索文档", exact: true })).toHaveValue("MobileReturnToken");
  await expect(resultTitle).toHaveText(document.title);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
