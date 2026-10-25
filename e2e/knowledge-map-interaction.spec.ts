import { expect, test, type Page } from "@playwright/test";

interface MapEvidence {
  draws: number;
  nodes: number;
  workerModes: string[];
  labels: string[];
  terminated: number;
  stallNextGraph: boolean;
  squares: Array<{ x: number; y: number }>;
}
declare global { interface Window { mapEvidence: MapEvidence } }

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.addInitScript(() => {
    window.mapEvidence = { draws: 0, nodes: 0, workerModes: [], labels: [], terminated: 0, stallNextGraph: false, squares: [] };
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    const fill = CanvasRenderingContext2D.prototype.fill;
    const text = CanvasRenderingContext2D.prototype.fillText;
    const rect = CanvasRenderingContext2D.prototype.rect;
    const isMap = (context: CanvasRenderingContext2D) => context.canvas.closest(".map-canvas-inner");
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (isMap(this)) { window.mapEvidence.draws += 1; window.mapEvidence.nodes = 0; window.mapEvidence.labels = []; window.mapEvidence.squares = []; }
      return clear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fill = function (...args: [CanvasFillRule?] | [Path2D, CanvasFillRule?]) {
      if (isMap(this)) window.mapEvidence.nodes += 1;
      return Reflect.apply(fill, this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (isMap(this)) window.mapEvidence.labels.push(args[0]);
      return text.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.rect = function (x, y, width, height) {
      if (isMap(this)) {
        const point = new DOMPoint(x + width / 2, y + height / 2).matrixTransform(this.getTransform());
        const bounds = this.canvas.getBoundingClientRect();
        window.mapEvidence.squares.push({ x: bounds.left + point.x * bounds.width / this.canvas.width, y: bounds.top + point.y * bounds.height / this.canvas.height });
      }
      return rect.call(this, x, y, width, height);
    };
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      postMessage(message: { mode?: string }) {
        if (message.mode) window.mapEvidence.workerModes.push(message.mode);
        if (message.mode === "replace" && window.mapEvidence.stallNextGraph) {
          window.mapEvidence.stallNextGraph = false;
          return;
        }
        super.postMessage(message);
      }
      terminate() { window.mapEvidence.terminated += 1; super.terminate(); }
    };
  });
});

function mapNode(id: string, title: string, folderId: string | null = "reading") {
  return {
    id, title, folderId, folderName: folderId ? "阅读方法" : null,
    kind: "article", status: "ready", favorite: false, archivedAt: null,
    updatedAt: "2026-10-25T00:00:00.000Z", pageCount: null,
    semanticState: "unavailable", semanticSourceHash: null, semanticModel: null, semanticFormatVersion: null,
  };
}

async function openMap(page: Page, stallGraph = false) {
  await page.goto("/");
  if (stallGraph) await page.evaluate(() => { window.mapEvidence.stallNextGraph = true; });
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "知识地图", exact: true }).click();
  await expect(page.locator(".map-canvas-inner canvas")).toBeVisible();
  await expect(page.locator(".map-loading")).toHaveCount(0);
}

test("selection preserves the overview and local exploration explains folder relations without AI", async ({ page }, testInfo) => {
  const nodes = [mapNode("first", "主动阅读"), mapNode("second", "阅读笔记"), mapNode("third", "其他主题", null)];
  await page.route("**/api/knowledge-map?*", (route) => {
    const folderId = new URL(route.request().url()).searchParams.get("folderId");
    const items = folderId ? nodes.filter((node) => node.folderId === folderId) : nodes;
    return route.fulfill({ json: { items, folders: [{ id: "reading", name: "阅读方法" }], total: items.length, nextCursor: null } });
  });
  await openMap(page);
  await expect(page.getByRole("complementary", { name: "资料详情" })).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.mapEvidence.labels.some((label) => label.includes("阅读方法 · 2")))).toBe(true);
  await page.locator(".map-accessible-list summary").click();
  await page.locator(".map-accessible-list").getByRole("button", { name: "主动阅读" }).click();
  const detail = page.getByRole("complementary", { name: "资料详情" });
  await expect(detail).toContainText("尚未启用语义推荐");
  await expect(detail).toContainText("同属「阅读方法」，依据你的分组");
  await expect(detail).not.toContainText("处理完成后");
  await expect(page.getByRole("button", { name: "全部资料", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => window.mapEvidence.nodes)).toBe(5);
  await detail.getByRole("button", { name: "聚焦关联", exact: true }).click();
  await expect(page.getByRole("button", { name: "当前关联", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => window.mapEvidence.nodes)).toBe(3);
  await page.locator(".map-canvas-toolbar").getByRole("button", { name: "返回总览", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.mapEvidence.nodes)).toBe(5);
  await expect(detail.getByRole("heading", { name: "主动阅读" })).toBeVisible();
  await detail.getByRole("button", { name: "关闭详情" }).click();
  await expect(detail).toBeHidden();
  let previousGroup: { x: number; y: number } | undefined;
  await expect.poll(async () => {
    const current = await page.evaluate(() => window.mapEvidence.squares[0]);
    const movement = previousGroup && current ? Math.hypot(current.x - previousGroup.x, current.y - previousGroup.y) : Infinity;
    previousGroup = current;
    return movement;
  }, { intervals: [100, 200, 300, 500], timeout: 10_000 }).toBeLessThan(0.1);
  const group = await page.evaluate(() => window.mapEvidence.squares[0]);
  await page.mouse.click(group.x, group.y);
  await expect.poll(() => page.evaluate(() => window.mapEvidence.nodes)).toBe(3);
  await expect(page.locator(".map-canvas-toolbar").getByRole("button", { name: "返回总览" })).toBeVisible();
  await page.getByRole("combobox", { name: "分组", exact: true }).selectOption("reading");
  await expect(page.locator(".map-canvas-toolbar").getByRole("button", { name: "返回总览" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "分组", exact: true }).selectOption("");
  await expect.poll(() => page.evaluate(() => window.mapEvidence.nodes)).toBe(5);
  await page.locator(".map-accessible-list").getByRole("button", { name: "主动阅读" }).click();
  for (const width of [1440, 800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(detail.getByRole("button", { name: "打开资料" })).toBeVisible();
    await expect.poll(() => detail.evaluate((element) => getComputedStyle(element).backgroundColor)).toMatch(/^rgb\(/u);
    await page.screenshot({ path: testInfo.outputPath(`map-${width}.png`) });
  }
});

test("large maps aggregate groups and mount only one page of the accessible list", async ({ page }) => {
  const nodes = Array.from({ length: 2_500 }, (_, index) => mapNode(`large-${index}`, `资料 ${index + 1}`, index < 1_500 ? "reading" : null));
  await page.route("**/api/knowledge-map?*", (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0);
    const items = nodes.slice(offset, offset + 250);
    const next = offset + items.length;
    return route.fulfill({ json: { items, folders: [{ id: "reading", name: "阅读方法" }], total: nodes.length, nextCursor: next < nodes.length ? String(next) : null } });
  });
  await openMap(page);
  await expect(page.getByText("已按分组汇总，点击分组展开。", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.mapEvidence.nodes)).toBe(2);
  await expect(page.locator(".map-accessible-list li")).toHaveCount(0);
  await page.locator(".map-accessible-list summary").click();
  await expect(page.locator(".map-accessible-list li")).toHaveCount(50);
  await page.getByRole("navigation", { name: "地图资料分页" }).getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".map-accessible-list").getByRole("button", { name: "资料 51", exact: false })).toBeVisible();
  await page.locator(".map-accessible-list li").first().getByRole("button").click();
  await page.getByRole("button", { name: "聚焦关联", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.mapEvidence.nodes)).toBe(10);
  await expect(page.getByRole("heading", { name: "资料 51", exact: true })).toBeVisible();
  await page.locator(".map-accessible-list summary").click();
  await expect(page.locator(".map-accessible-list li")).toHaveCount(0);
});

test("returning from a reader reuses vectors and the graph, and hidden maps stop drawing", async ({ page, request }) => {
  const listing = await request.get("/api/documents");
  const response = await request.post("/api/documents", {
    headers: { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] },
    data: { title: "缓存中的阅读资料" },
  });
  expect(response.ok()).toBe(true);
  const { document } = await response.json();
  const nodes = [mapNode(document.id, document.title), mapNode("related", "关联资料")].map((node, index) => ({
    ...node, semanticState: "ready", semanticSourceHash: String(index).repeat(64), semanticModel: "test-model", semanticFormatVersion: "semantic-text-v1",
  }));
  let vectorRequests = 0;
  await page.route("**/api/knowledge-map?*", (route) => route.fulfill({ json: { items: nodes, folders: [{ id: "reading", name: "阅读方法" }], total: nodes.length, nextCursor: null } }));
  await page.route("**/api/knowledge-map/vectors?*", (route) => {
    vectorRequests += 1;
    return route.fulfill({ json: { items: nodes.map((node) => ({ id: node.id, sourceHash: node.semanticSourceHash, model: node.semanticModel, formatVersion: node.semanticFormatVersion, vector: [1, 0] })), total: 2, nextCursor: null } });
  });
  await openMap(page);
  await page.locator(".map-accessible-list summary").click();
  await page.locator(".map-accessible-list").getByRole("button", { name: document.title }).click();
  const detail = page.getByRole("complementary", { name: "资料详情" });
  await expect(detail.getByText("模型推荐 · 同属「阅读方法」", { exact: true })).toBeVisible();
  const workerModes = await page.evaluate(() => window.mapEvidence.workerModes);
  await detail.getByRole("button", { name: "打开资料" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue(document.title);
  await expect(page.locator(".knowledge-map-host")).toHaveClass(/is-dormant/u);
  const draws = await page.evaluate(() => window.mapEvidence.draws);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.mapEvidence.draws)).toBe(draws);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "知识地图", exact: true })).toBeVisible();
  await expect(page.locator(".map-loading")).toHaveCount(0);
  await expect(detail.getByText("模型推荐 · 同属「阅读方法」", { exact: true })).toBeVisible();
  expect(vectorRequests).toBe(1);
  expect(await page.evaluate(() => window.mapEvidence.workerModes)).toEqual(workerModes);
});

test("a new content version cancels an unfinished graph instead of waiting behind it", async ({ page }) => {
  let version = 1;
  const nodes = [mapNode("version-a", "版本甲"), mapNode("version-b", "版本乙")];
  await page.route("**/api/knowledge-map?*", (route) => route.fulfill({ json: {
    items: nodes.map((node) => ({ ...node, semanticState: "ready", semanticSourceHash: String(version).repeat(64), semanticModel: "test-model", semanticFormatVersion: "semantic-text-v1" })),
    folders: [{ id: "reading", name: "阅读方法" }], total: nodes.length, nextCursor: null,
  } }));
  await page.route("**/api/knowledge-map/vectors?*", (route) => route.fulfill({ json: {
    items: nodes.map((node) => ({ id: node.id, sourceHash: String(version).repeat(64), model: "test-model", formatVersion: "semantic-text-v1", vector: [1, 0] })),
    total: nodes.length, nextCursor: null,
  } }));
  await openMap(page, true);
  await expect.poll(() => page.evaluate(() => window.mapEvidence.workerModes.filter((mode) => mode === "replace").length)).toBe(1);
  const terminated = await page.evaluate(() => window.mapEvidence.terminated);
  version = 2;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("zhiye:extension-saved", { detail: "new-map-version" })));
  await expect(page.locator(".map-semantic-status")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.mapEvidence.terminated)).toBeGreaterThan(terminated);
  await page.locator(".map-accessible-list summary").click();
  await page.locator(".map-accessible-list li").first().getByRole("button").click();
  await expect(page.locator(".map-detail-related").filter({ has: page.getByRole("heading", { name: "内容相近", exact: true }) })).toContainText("相似分数 1.00");
});
