import { expect, test, type APIRequestContext } from "@playwright/test";

async function createArticle(request: APIRequestContext, title: string, markdown?: string) {
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const response = await request.post("/api/documents", { headers, data: { title } });
  expect(response.ok()).toBe(true);
  const { document } = await response.json();
  if (markdown) expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { markdown, revision: document.revision } })).ok()).toBe(true);
  return document;
}

test("directory paints its first batch, fills from a worker and polls only pending pages", async ({ page, context, request }) => {
  const document = await createArticle(request, "懒加载模板");
  const epoch = (await request.get("/api/documents")).headers()["x-zhiye-data-epoch"]!;
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  const stamp = (index: number) => new Date(Date.UTC(2026, 9, 26) + (100 - index) * 1_000).toISOString();
  await page.route("**/api/folders", (route) => route.fulfill({ json: [{ id: "mixed-folder", name: "混排分组", documentCount: 0, createdAt: stamp(0), updatedAt: stamp(1.5) }] }));
  const requestedPages: number[] = [];
  let total = 65;
  let release!: () => void;
  const background = new Promise<void>((resolve) => { release = resolve; });
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await context.route("**/api/documents?*", async (route) => {
    const url = new URL(route.request().url());
    const currentPage = Number(url.searchParams.get("page") || 1);
    if (url.searchParams.get("unfiled") === "true") {
      requestedPages.push(currentPage);
      if (currentPage > 1) await background;
    }
    const start = (currentPage - 1) * 30;
    await route.fulfill({ headers: { "X-Zhiye-Data-Epoch": epoch }, json: { page: currentPage, pageSize: 30, total, items: Array.from({ length: Math.max(0, Math.min(30, total - start)) }, (_, index) => ({ ...document, id: `lazy-${start + index}`, title: `懒加载文档 ${start + index + 1}`, updatedAt: stamp(start + index), status: start + index === 60 ? "queued" : "ready" })) } });
  });
  await page.goto("/");
  const root = page.getByRole("region", { name: "未分组内容" });
  await expect(root.locator(".document-row")).toHaveCount(30);
  await expect(page.getByRole("navigation", { name: "未分组分页" })).toHaveCount(0);
  await root.getByRole("button", { name: "懒加载文档 1", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(root.getByRole("button", { name: "懒加载文档 2", exact: true })).toBeFocused();
  await root.getByRole("checkbox", { name: "选择 懒加载文档 2", exact: true }).check();
  await expect.poll(() => requestedPages.includes(2)).toBe(true);
  expect(workers.some((url) => url.includes("directory-loader-worker"))).toBe(true);
  release();
  await expect(root.locator(".document-row")).toHaveCount(65);
  await expect(root.getByRole("checkbox", { name: "选择 懒加载文档 2", exact: true })).toBeChecked();
  const order = await root.locator(":scope > .directory-document-row, :scope > .folder-branch").evaluateAll((nodes) => nodes.slice(0, 4).map((node) => node.querySelector(".directory-document-label, .folder-node strong")?.textContent));
  expect(order).toEqual(["懒加载文档 1", "懒加载文档 2", "混排分组", "懒加载文档 3"]);
  await root.getByRole("button", { name: "更多操作：混排分组", exact: true }).click();
  const actions = page.getByRole("dialog", { name: "分组操作：混排分组" });
  await expect(actions.getByRole("button", { name: "修改名称" })).toBeFocused();
  await expect(actions.getByRole("button", { name: "删除分组" })).toBeVisible();
  await page.screenshot({ path: "test-results/directory-lazy-desktop.png" });
  await page.keyboard.press("Escape");
  await expect(root.getByRole("button", { name: "更多操作：混排分组", exact: true })).toBeFocused();
  await expect.poll(() => requestedPages.filter((value) => value === 3).length, { timeout: 6_000 }).toBeGreaterThanOrEqual(2);
  expect(requestedPages.filter((value) => value === 2)).toHaveLength(1);
  total = 25;
  await expect(root.locator(".document-row")).toHaveCount(25, { timeout: 6_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  const rail = page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "资料库", exact: true });
  if (await rail.getAttribute("aria-expanded") === "false") await rail.click();
  await root.getByRole("button", { name: "更多操作：混排分组", exact: true }).click();
  await expect(actions).toBeVisible();
  const bounds = await actions.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/directory-lazy-mobile.png" });
});

test("directory keeps loaded rows on background failure and rejects an old data epoch", async ({ page, context, request }) => {
  const document = await createArticle(request, "失败恢复模板");
  const epoch = (await request.get("/api/documents")).headers()["x-zhiye-data-epoch"]!;
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/api/folders", (route) => route.fulfill({ json: [] }));
  let failure = true;
  let stale = false;
  await context.route("**/api/documents?*", async (route) => {
    const url = new URL(route.request().url());
    const current = Number(url.searchParams.get("page") || 1);
    if (current === 2 && failure) { await route.fulfill({ status: 503, headers: { "X-Zhiye-Data-Epoch": epoch }, json: { error: { code: "REQUEST_FAILED" } } }); return; }
    const start = (current - 1) * 30;
    await route.fulfill({ headers: { "X-Zhiye-Data-Epoch": stale && current > 1 ? "restored-epoch" : epoch }, json: { page: current, pageSize: 30, total: 35, items: Array.from({ length: current === 1 ? 30 : 5 }, (_, index) => ({ ...document, id: `retry-${start + index}`, title: `恢复文档 ${start + index}`, status: "ready" })) } });
  });
  await page.goto("/");
  const root = page.getByRole("region", { name: "未分组内容" });
  await expect(root.locator(".document-row")).toHaveCount(30);
  await expect(root.getByRole("button", { name: "重试" })).toBeVisible();
  failure = false; stale = true;
  await root.getByRole("button", { name: "重试" }).click();
  await expect(root.getByRole("alert")).toContainText("知识库已从备份恢复");
  await expect(root.locator(".document-row")).toHaveCount(30);
  stale = false;
  await root.getByRole("button", { name: "重试" }).click();
  await expect(root.locator(".document-row")).toHaveCount(35);
  await expect(root.getByRole("alert")).toHaveCount(0);
});

test("directory cancels an old background fill when the category changes", async ({ page, context, request }) => {
  const document = await createArticle(request, "切换筛选模板");
  const epoch = (await request.get("/api/documents")).headers()["x-zhiye-data-epoch"]!;
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/api/folders", (route) => route.fulfill({ json: [] }));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let backgroundStarted = false;
  await context.route("**/api/documents?*", async (route) => {
    const url = new URL(route.request().url());
    const current = Number(url.searchParams.get("page") || 1);
    const favorite = url.searchParams.get("favorite") === "true";
    if (current > 1 && !favorite) { backgroundStarted = true; await held; }
    await route.fulfill({ headers: { "X-Zhiye-Data-Epoch": epoch }, json: { page: current, pageSize: 30, total: favorite ? 1 : 35, items: favorite ? [{ ...document, id: "favorite", title: "收藏独有文章", favorite: true }] : Array.from({ length: current === 1 ? 30 : 5 }, (_, index) => ({ ...document, id: `old-${current}-${index}`, title: `旧筛选文章 ${current}-${index}` })) } });
  });
  await page.goto("/");
  const root = page.getByRole("region", { name: "未分组内容" });
  await expect(root.locator(".document-row")).toHaveCount(30);
  await expect.poll(() => backgroundStarted).toBe(true);
  await page.getByRole("navigation", { name: "目录分类" }).getByRole("button", { name: "收藏", exact: true }).click();
  await expect(root.getByRole("button", { name: "收藏独有文章", exact: true })).toBeVisible();
  release();
  await expect(root.locator(".document-row")).toHaveCount(1);
  await expect(root).not.toContainText("旧筛选文章");
});

test("folder menu renames and deletes without losing articles and its contents accept drops", async ({ page, request }) => {
  const document = await createArticle(request, "分组保留文章");
  const epoch = (await request.get("/api/documents")).headers()["x-zhiye-data-epoch"]!;
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": epoch };
  const folder = await (await request.post("/api/folders", { headers, data: { name: "混排拖放分组" } })).json();
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.goto("/");
  const branch = page.locator(".folder-branch").filter({ has: page.locator(".folder-node strong", { hasText: "混排拖放分组" }) });
  await branch.locator("button[aria-expanded]").click();
  await expect(branch.locator(".folder-contents")).toContainText("这个分组里还没有织片");
  await branch.locator(".folder-contents").evaluate((element, target) => {
    const transfer = new DataTransfer();
    transfer.setData("application/x-zhiye-document", JSON.stringify(target));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { id: document.id, revision: document.revision, folderId: null });
  await expect.poll(async () => (await (await request.get(`/api/documents/${document.id}`)).json()).folderId).toBe(folder.id);
  await expect(branch.getByRole("button", { name: document.title, exact: true })).toBeVisible();
  await branch.getByRole("button", { name: "更多操作：混排拖放分组" }).click();
  await page.getByRole("dialog", { name: "分组操作：混排拖放分组" }).getByRole("button", { name: "修改名称" }).click();
  const rename = page.getByRole("dialog", { name: "修改名称", exact: true });
  await rename.getByLabel("分组名称").fill("改名后的分组");
  await rename.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".root-contents > :first-child .folder-node strong")).toHaveText("改名后的分组");
  await page.getByRole("button", { name: "更多操作：改名后的分组" }).click();
  await page.getByRole("dialog", { name: "分组操作：改名后的分组" }).getByRole("button", { name: "删除分组" }).click();
  await page.getByRole("alertdialog", { name: "删除分组", exact: true }).getByRole("button", { name: "删除分组", exact: true }).click();
  await expect(page.getByRole("button", { name: "更多操作：改名后的分组" })).toHaveCount(0);
  await expect(page.locator(".root-contents > .directory-document-row").getByRole("button", { name: document.title, exact: true })).toBeVisible();
  const retained = await (await request.get(`/api/documents/${document.id}`)).json();
  expect(retained.folderId).toBeNull();
  expect(retained.deletedAt).toBeNull();
});

test("directory reconciles captures that finish across multiple pages between polls", async ({ page, context, request }) => {
  const document = await createArticle(request, "批量抓取模板");
  const epoch = (await request.get("/api/documents")).headers()["x-zhiye-data-epoch"]!;
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/api/folders", (route) => route.fulfill({ json: [] }));
  let completed = false;
  await context.route("**/api/documents?*", async (route) => {
    const current = Number(new URL(route.request().url()).searchParams.get("page") || 1);
    const documents = Array.from({ length: 120 }, (_, index) => ({ ...document, id: `batch-${String(index).padStart(3, "0")}`, title: `批量抓取 ${index + 1}`, status: completed || index < 60 ? "ready" : "queued", updatedAt: new Date(Date.UTC(2026, 9, 26) + ((completed && index >= 60 ? 240 : 120) - index) * 1_000).toISOString() })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    await route.fulfill({ headers: { "X-Zhiye-Data-Epoch": epoch }, json: { page: current, pageSize: 30, total: 120, items: documents.slice((current - 1) * 30, current * 30) } });
  });
  await page.goto("/");
  const root = page.getByRole("region", { name: "未分组内容" });
  await expect(root.locator(".document-row")).toHaveCount(120);
  await expect(root.locator(".sr-only").filter({ hasText: /^等待收取$/ })).toHaveCount(60);
  completed = true;
  await expect(root.locator(".sr-only").filter({ hasText: /^等待收取$/ })).toHaveCount(0, { timeout: 8_000 });
  await expect(root.locator(".document-row")).toHaveCount(120);
  await expect(root.locator(".directory-document-label").first()).toHaveText("批量抓取 61");
});

for (const runtime of ["cloud", "desktop"] as const) test(`long article reading requires opt-in in ${runtime} UI`, async ({ page, request }) => {
  const title = `长文保护-${runtime}`;
  await createArticle(request, title, `# 长文测试\n\n${"正文内容。".repeat(50_001)}`);
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  if (runtime === "cloud") await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  else await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke: async (command: string) => {
      if (command === "take_external_intents") return [];
      if (command === "get_data_directory") return "/tmp/performance-boundary-test";
      throw new Error(`Unexpected desktop command: ${command}`);
    } } });
  });
  await page.goto("/");
  await page.locator(".directory-document-row").getByRole("button", { name: title, exact: true }).click();
  await expect(page.getByText("长文预览已暂停", { exact: true })).toBeVisible();
  await expect(page.locator(".markdown-preview")).toHaveCount(0);
  if (runtime === "cloud") {
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const grid = page.locator(".editor-grid");
    await expect(grid).toHaveClass(/mode-edit/);
    await expect(grid.getByRole("region", { name: "Markdown 源文编辑" })).toBeVisible();
    await expect(page.locator(".markdown-preview")).toHaveCount(0);
    const widths = await grid.evaluate((element) => ({
      grid: element.getBoundingClientRect().width,
      editor: element.querySelector(".editor-pane")!.getBoundingClientRect().width,
    }));
    expect(widths.editor).toBeGreaterThan(widths.grid * 0.95);
    await page.getByRole("button", { name: "边写边看", exact: true }).click();
  } else await page.getByRole("button", { name: "打开预览", exact: true }).click();
  await expect(page.locator(".markdown-preview").getByRole("heading", { name: "长文测试" })).toBeVisible();
  if (runtime === "cloud") {
    await page.getByRole("button", { name: "返回阅读", exact: true }).click();
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(page.locator(".editor-grid")).toHaveClass(/mode-split/);
    await expect(page.locator(".markdown-preview")).toBeVisible();
  }
});

for (const response of ["status", "503"] as const) test(`startup waits visibly for maintenance ${response} and mounts business requests only when ready`, async ({ page }) => {
  let available = false;
  let documentRequests = 0;
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/api/startup-status", (route) => available ? route.continue() : response === "503"
    ? route.fulfill({ status: 503, json: { error: { code: "MAINTENANCE", message: "startup" } } })
    : route.fulfill({ json: { mode: "ready", maintenance: true } }));
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/documents") documentRequests += 1; });
  await page.goto("/");
  await expect(page.getByText("正在整理知识库，请稍候…")).toBeVisible();
  expect(documentRequests).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("zhiye:close-requested", { detail: { attemptId: "1" } })));
  await expect(page.getByText("知识库正在启动，请完成后再次关闭窗口。", { exact: true })).toBeVisible();
  available = true;
  await expect(page.getByRole("heading", { name: "资料目录" })).toBeVisible();
  await expect.poll(() => documentRequests).toBeGreaterThan(0);
});

test("startup does not silently retry unrelated errors", async ({ page }) => {
  await page.clock.install();
  let requests = 0;
  await page.route("**/api/startup-status", (route) => {
    requests += 1;
    return route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "test" } } });
  });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("无法打开知识库");
  await page.clock.runFor(5_000);
  expect(requests).toBe(1);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => requests).toBe(2);
});

test("startup error still delegates a valid desktop close to the service", async ({ page }) => {
  await page.route("**/api/startup-status", (route) => route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "test" } } }));
  const attempts: string[] = [];
  await page.route("**/api/desktop/close-ready", (route) => {
    attempts.push(route.request().postDataJSON().attemptId);
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("无法打开知识库");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("zhiye:close-requested", { detail: { attemptId: "7" } })));
  await expect.poll(() => attempts).toEqual(["7"]);
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("zhiye:close-timeout", { detail: { attemptId: "7" } })));
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeEnabled();
});
