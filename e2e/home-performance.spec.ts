import { expect, test } from "@playwright/test";

test("home shelf reuses pages and stays visible while fresh data arrives", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", route => route.fulfill({ json: { completed: true, revision: 1 } }));
  const cards = ["缓存中的阅读方法", "缓存中的工程实践"].map((title, index) => ({
    documentId: `cached-${index}`, title, folderId: `folder-${index}`, folderName: index ? "工程实践" : "阅读方法",
    createdAt: "2026-10-30T00:00:00Z", featured: true, position: index, coverHash: null,
    color: index ? "sage" : "rust", shortTitle: "", fit: "contain",
  }));
  let requests = 0;
  await page.route(/\/api\/home(?:\?|$)/, async route => {
    requests++;
    const params = new URL(route.request().url()).searchParams;
    const items = params.get("folder") ? cards.filter(card => card.folderId === params.get("folder")) : cards;
    await new Promise(resolve => setTimeout(resolve, 600));
    await route.fulfill({ json: { revision: 1, items, total: items.length, libraryTotal: cards.length, page: 1, folders: cards.map(card => ({ id: card.folderId, name: card.folderName })) } });
  });
  await page.route("**/api/knowledge-map?*", route => route.fulfill({ json: { items: [], folders: [], total: 0, nextCursor: null } }));
  const shelf = page.getByRole("region", { name: "首页书架", exact: true });
  const metrics: Array<{ action: string; requests: number; readyMs: number }> = [];
  const measure = async (action: string, run: () => Promise<unknown>, count: number) => {
    const start = Date.now(), before = requests;
    await run();
    await expect(shelf.locator(".home-book")).toHaveCount(count);
    await expect(shelf.getByRole("tabpanel")).toHaveAttribute("aria-busy", "false");
    metrics.push({ action, requests: requests - before, readyMs: Date.now() - start });
  };
  await measure("first-load", () => page.goto("/"), 2);
  await measure("first-folder", () => shelf.getByRole("tab", { name: "阅读方法", exact: true }).click(), 1);
  await measure("return-all", () => shelf.getByRole("tab", { name: "全部", exact: true }).click(), 2);
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  await rail.getByRole("button", { name: "知识地图", exact: true }).click();
  await expect(page.getByRole("heading", { name: "知识地图", exact: true })).toBeVisible();
  await measure("return-from-map", () => rail.getByRole("button", { name: "资料库", exact: true }).click(), 2);
  await shelf.getByRole("button", { name: "布置首页", exact: true }).click();
  const editor = page.getByRole("region", { name: "首页布置", exact: true });
  await expect(editor.locator(".home-article-select")).toHaveCount(2);
  await expect(editor.getByRole("button", { name: "返回首页", exact: true })).toBeEnabled();
  await measure("cancel-arrangement", () => editor.getByRole("button", { name: "返回首页", exact: true }).click(), 2);
  const beforeRefresh = requests;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("zhiye:extension-saved", { detail: "cached-new-document" })));
  await expect.poll(() => requests).toBeGreaterThan(beforeRefresh);
  const visibleDuringRefresh = await shelf.locator(".home-book").count();
  await expect(shelf.getByRole("tabpanel")).toHaveAttribute("aria-busy", "false");
  console.log("HOME_SHELF_PERFORMANCE", JSON.stringify({ metrics, visibleDuringRefresh }));
  await testInfo.attach("home-performance.json", { body: Buffer.from(JSON.stringify({ metrics, visibleDuringRefresh }, null, 2)), contentType: "application/json" });
  expect(metrics.map(metric => metric.requests)).toEqual([1, 1, 0, 0, 0]);
  expect(visibleDuringRefresh).toBe(2);
});

test("a removed last page returns to page one and stays there after leaving home", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/settings/onboarding", route => route.fulfill({ json: { completed: true, revision: 1 } }));
  const cards = Array.from({ length: 27 }, (_, index) => ({
    documentId: `page-${index}`, title: `分页文章 ${index + 1}`, folderId: null, folderName: null,
    createdAt: "2026-10-30T00:00:00Z", featured: true, position: index, coverHash: null,
    color: "sage", shortTitle: "", fit: "contain",
  }));
  let total = 27, requests = 0;
  await page.route(/\/api\/home(?:\?|$)/, route => {
    requests++;
    const number = Number(new URL(route.request().url()).searchParams.get("page") || 1);
    const items = cards.slice(0, total).slice((number - 1) * 24, number * 24);
    return route.fulfill({ json: { revision: 1, items, total, libraryTotal: total, page: number, folders: [] } });
  });
  await page.route("**/api/knowledge-map?*", route => route.fulfill({ json: { items: [], folders: [], total: 0, nextCursor: null } }));
  await page.goto("/");
  const shelf = page.getByRole("region", { name: "首页书架", exact: true });
  await expect(shelf.locator(".home-book")).toHaveCount(24);
  await shelf.getByRole("navigation", { name: "文章分页" }).getByRole("button", { name: "下一页", exact: true }).click();
  await expect(shelf.locator(".home-book")).toHaveCount(3);
  total = 24;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("zhiye:extension-saved", { detail: "removed-last-page" })));
  await expect(shelf.locator(".home-book")).toHaveCount(24);
  await expect(shelf.getByRole("tabpanel")).toHaveAttribute("aria-busy", "false");
  await expect(shelf.getByRole("navigation", { name: "文章分页" })).toHaveCount(0);
  expect(requests).toBe(4);
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  await rail.getByRole("button", { name: "知识地图", exact: true }).click();
  await expect(page.getByRole("heading", { name: "知识地图", exact: true })).toBeVisible();
  await rail.getByRole("button", { name: "资料库", exact: true }).click();
  await expect(shelf.locator(".home-book")).toHaveCount(24);
  await expect(shelf.getByRole("tabpanel")).toHaveAttribute("aria-busy", "false");
  expect(requests).toBe(4);
});

for (const failure of [401, 403, "epoch"] as const) {
  test(`a non-home API ${failure} failure removes cached cards before returning home`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route("**/api/settings/onboarding", route => route.fulfill({ json: { completed: true, revision: 1 } }));
    let invalid = false, homeRequests = 0;
    await page.route("**/api/capture-queue", route => {
      if (route.request().method() !== "PATCH") return route.continue();
      invalid = true;
      return route.fulfill(failure === "epoch"
        ? { headers: { "X-Zhiye-Data-Epoch": "changed-library-epoch" }, json: {} }
        : { status: failure, json: { error: { code: "SESSION_REQUIRED", message: "Session expired" } } });
    });
    await page.route(/\/api\/home(?:\?|$)/, route => {
      homeRequests++;
      if (invalid) return route.fulfill(failure === "epoch"
        ? { headers: { "X-Zhiye-Data-Epoch": "changed-library-epoch" }, json: {} }
        : { status: failure, json: { error: { code: "SESSION_REQUIRED", message: "Session expired" } } });
      return route.fulfill({ json: { revision: 1, items: [{ documentId: "private-card", title: "失效前缓存的文章", folderId: null, folderName: null, createdAt: "2026-10-30T00:00:00Z", featured: true, position: 0, coverHash: null, color: "sage", shortTitle: "", fit: "contain" }], total: 1, libraryTotal: 1, page: 1, folders: [] } });
    });
    await page.route("**/api/knowledge-map?*", route => route.fulfill({ json: { items: [], folders: [], total: 0, nextCursor: null } }));
    await page.goto("/");
    const shelf = page.getByRole("region", { name: "首页书架", exact: true });
    await expect(shelf.locator(".home-book")).toHaveCount(1);
    await page.getByRole("button", { name: "暂停收取", exact: true }).click();
    await expect(shelf.locator(".home-book")).toHaveCount(0);
    await expect(shelf.getByRole("alert")).toBeVisible();
    expect(homeRequests).toBe(1);
    const rail = page.getByRole("navigation", { name: "工作台导航" });
    await rail.getByRole("button", { name: "知识地图", exact: true }).click();
    await expect(page.getByRole("heading", { name: "知识地图", exact: true })).toBeVisible();
    await rail.getByRole("button", { name: "资料库", exact: true }).click();
    await expect(shelf.getByRole("alert")).toBeVisible();
    await expect(shelf.locator(".home-book")).toHaveCount(0);
    expect(homeRequests).toBe(2);
  });
}
