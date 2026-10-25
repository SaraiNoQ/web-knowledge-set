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

test("directory keeps one page per branch and polls only the visible page", async ({ page, request }) => {
  const document = await createArticle(request, "分页模板");
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/api/folders", (route) => route.fulfill({ json: [] }));
  const requestedPages: number[] = [];
  let total = 65;
  await page.route("**/api/documents?*", async (route) => {
    const url = new URL(route.request().url());
    const currentPage = Number(url.searchParams.get("page") || 1);
    if (url.searchParams.get("unfiled") === "true") requestedPages.push(currentPage);
    const start = (currentPage - 1) * 30;
    await route.fulfill({ json: { page: currentPage, pageSize: 30, total, items: Array.from({ length: Math.max(0, Math.min(30, total - start)) }, (_, index) => ({ ...document, id: `pagination-${start + index}`, title: `分页文档 ${start + index + 1}`, status: index === 0 ? "queued" : "ready" })) } });
  });
  await page.goto("/");
  const root = page.getByRole("region", { name: "未分组内容" });
  const pages = page.getByRole("navigation", { name: "未分组分页" });
  await expect(root.locator(".document-row")).toHaveCount(30);
  expect(requestedPages.every((value) => value === 1)).toBe(true);
  const first = root.getByRole("button", { name: "分页文档 1", exact: true });
  await first.focus();
  await page.keyboard.press("ArrowDown");
  await expect(root.getByRole("button", { name: "分页文档 2", exact: true })).toBeFocused();
  await root.getByRole("checkbox", { name: "选择 分页文档 2", exact: true }).check();
  await pages.getByRole("button", { name: "下一页" }).click();
  await expect(root.getByRole("button", { name: "分页文档 31", exact: true })).toBeVisible();
  await expect(root.locator(".document-row")).toHaveCount(30);
  await expect.poll(() => requestedPages.filter((value) => value === 2).length, { timeout: 6_000 }).toBeGreaterThanOrEqual(2);
  expect(requestedPages).not.toContain(3);
  await pages.getByRole("button", { name: "上一页" }).click();
  await expect(root.getByRole("checkbox", { name: "选择 分页文档 2", exact: true })).toBeChecked();
  await pages.getByRole("button", { name: "下一页" }).click();
  await expect(pages).toContainText("第 2 / 3 页");
  // A deletion elsewhere can invalidate the next page; recover without an empty dead end.
  total = 25;
  await pages.getByRole("button", { name: "下一页" }).click();
  await expect(root.locator(".document-row")).toHaveCount(25);
  await expect(root.getByRole("button", { name: "分页文档 1", exact: true })).toBeVisible();
  await expect(pages).toHaveCount(0);
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
