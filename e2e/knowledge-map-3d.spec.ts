import { expect, test, type Page } from "@playwright/test";

// Trace screenshots force GPU readbacks and distort the rendering benchmark.
test.use({ trace: "off" });

declare global {
  interface Window {
    map3dEvidence: {
      contexts: WebGL2RenderingContext[];
      frames: number;
      drawCalls: number;
      instances: number;
      buffers: number;
      measuring: boolean;
      times: number[];
      layoutRequests: number;
      layoutPositions: number[];
      gpuReady: () => Promise<void>;
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.addInitScript(() => {
    const stats = window.map3dEvidence = { contexts: [] as WebGL2RenderingContext[], frames: 0, drawCalls: 0, instances: 0, buffers: 0, measuring: false, times: [] as number[], layoutRequests: 0, layoutPositions: [] as number[],
      gpuReady: async () => {
        const gl = document.querySelector<HTMLCanvasElement>(".map-3d canvas")!.getContext("webgl2")!;
        const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!fence) throw new Error("GPU fence unavailable");
        gl.flush();
        const started = performance.now();
        try {
          while (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) {
            if (performance.now() - started > 15_000) throw new Error("GPU work did not finish");
            await new Promise((resolve) => setTimeout(resolve, 8));
          }
        } finally { gl.deleteSync(fence); }
      },
    };
    const BrowserWorker = window.Worker;
    window.Worker = class extends BrowserWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", ({ data }) => { if (data.positions instanceof Float32Array) stats.layoutPositions = Array.from(data.positions); });
      }
      postMessage(message: { data?: { nodes?: unknown[] } }) {
        if (message.data?.nodes) stats.layoutRequests += 1;
        super.postMessage(message);
      }
    };
    const context = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      const result = Reflect.apply(context, this, [type, ...args]);
      if (type === "webgl2" && result && !stats.contexts.includes(result)) stats.contexts.push(result);
      return result;
    } as typeof context;
    const isMap = (gl: WebGL2RenderingContext) => gl.canvas instanceof HTMLCanvasElement && gl.canvas.isConnected && gl.canvas.closest(".map-3d");
    const clear = WebGL2RenderingContext.prototype.clear;
    WebGL2RenderingContext.prototype.clear = function (...args) {
      if (isMap(this)) { stats.frames += 1; stats.drawCalls = 0; stats.instances = 0; if (stats.measuring) stats.times.push(performance.now()); }
      return clear.apply(this, args);
    };
    const instanced = WebGL2RenderingContext.prototype.drawElementsInstanced;
    WebGL2RenderingContext.prototype.drawElementsInstanced = function (...args) {
      if (isMap(this)) { stats.drawCalls += 1; stats.instances += args[4]; }
      return instanced.apply(this, args);
    };
    const arrayInstances = WebGL2RenderingContext.prototype.drawArraysInstanced;
    WebGL2RenderingContext.prototype.drawArraysInstanced = function (...args) {
      if (isMap(this)) { stats.drawCalls += 1; stats.instances += args[3]; }
      return arrayInstances.apply(this, args);
    };
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function (...args) {
      if (isMap(this)) { stats.drawCalls += 1; if (args[0] === this.POINTS) stats.instances += args[2]; }
      return draw.apply(this, args);
    };
    const elements = WebGL2RenderingContext.prototype.drawElements;
    WebGL2RenderingContext.prototype.drawElements = function (...args) {
      if (isMap(this)) stats.drawCalls += 1;
      return elements.apply(this, args);
    };
    const buffers = new Set<WebGLBuffer>();
    const create = WebGL2RenderingContext.prototype.createBuffer;
    WebGL2RenderingContext.prototype.createBuffer = function () {
      const buffer = create.call(this);
      if (buffer && isMap(this)) { buffers.add(buffer); stats.buffers = buffers.size; }
      return buffer;
    };
    const remove = WebGL2RenderingContext.prototype.deleteBuffer;
    WebGL2RenderingContext.prototype.deleteBuffer = function (buffer) {
      if (buffer) buffers.delete(buffer);
      stats.buffers = buffers.size;
      return remove.call(this, buffer);
    };
  });
});

const folders = [{ id: "reading", name: "阅读方法" }];
function node(index: number, semantic = false) {
  return {
    id: `three-${index}`, title: index === 0 ? "三维阅读" : `关联阅读 ${index}`,
    kind: index % 2 ? "paper" : "article", folderId: "reading", folderName: "阅读方法",
    status: "ready", favorite: true, archivedAt: null, updatedAt: "2026-10-25T00:00:00.000Z", pageCount: index % 2 ? 3 : null,
    semanticState: semantic ? "ready" : "unavailable", semanticSourceHash: semantic ? String(index).padStart(64, "0") : null,
    semanticModel: semantic ? "test-model" : null, semanticFormatVersion: semantic ? "semantic-text-v1" : null,
  };
}
async function openMap(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "知识地图", exact: true }).click();
  await expect(page.locator(".map-canvas-inner canvas")).toBeVisible();
}
async function switch3D(page: Page) {
  const frames = await page.evaluate(() => window.map3dEvidence.frames);
  await page.getByRole("group", { name: "地图维度" }).getByRole("button", { name: "3D", exact: true }).click();
  await expect(page.locator(".map-3d canvas")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => window.map3dEvidence.frames), { timeout: 15_000 }).toBeGreaterThan(frames);
}

test("2D and 3D retain filters, selection and semantic relations without refetching vectors", async ({ page }, testInfo) => {
  const nodes = [node(0, true), node(1, true), node(2, true)];
  let vectors = 0;
  let metadata = 0;
  const modules: string[] = [];
  page.on("request", (request) => { if (/KnowledgeMap3D-.*\.js/u.test(request.url())) modules.push(request.url()); });
  await page.route("**/api/knowledge-map?*", (route) => {
    metadata += 1;
    return route.fulfill({ json: { items: nodes, folders, total: nodes.length, nextCursor: null } });
  });
  await page.route("**/api/knowledge-map/vectors?*", (route) => {
    vectors += 1;
    return route.fulfill({ json: { items: nodes.map((item) => ({ id: item.id, sourceHash: item.semanticSourceHash, model: item.semanticModel, formatVersion: item.semanticFormatVersion, vector: [1, 0] })), total: 3, nextCursor: null } });
  });
  await openMap(page);
  expect(modules).toHaveLength(0);
  expect(await page.evaluate(() => window.map3dEvidence.contexts.length)).toBe(0);
  await page.locator(".map-accessible-list summary").click();
  await page.locator(".map-accessible-list li").first().getByRole("button").click();
  const detail = page.getByRole("complementary", { name: "资料详情" });
  await expect(detail).toContainText("相似分数 1.00");
  await page.getByRole("combobox", { name: "分组", exact: true }).click();
  await page.getByRole("option", { name: "阅读方法", exact: true }).click();
  const search = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/knowledge-map" && new URL(response.url()).searchParams.get("q") === "阅读");
  await page.getByRole("textbox", { name: "搜索标题" }).fill("阅读");
  await search;
  await expect.poll(() => metadata).toBeGreaterThan(1);
  await expect(page.locator(".map-loading")).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "相似要求" })).toBeVisible();
  await page.getByRole("slider", { name: "相似要求" }).press("End");
  await expect(page.locator(".map-threshold-value")).toHaveText("0.90");
  await detail.getByRole("button", { name: "聚焦关联", exact: true }).click();
  const requestsBefore = metadata;
  await switch3D(page);
  await expect.poll(() => page.evaluate(() => window.map3dEvidence.instances)).toBe(4);
  const depth = await page.evaluate(() => window.map3dEvidence.layoutPositions.filter((_, index) => index % 3 === 2));
  expect(Math.max(...depth) - Math.min(...depth)).toBeGreaterThan(1);
  await expect(page.getByRole("textbox", { name: "搜索标题" })).toHaveValue("阅读");
  await expect(page.getByRole("combobox", { name: "分组", exact: true })).toHaveText("阅读方法");
  await expect(page.getByRole("slider", { name: "相似要求" })).toHaveValue("0.9");
  await expect(page.getByRole("button", { name: "当前关联", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(detail.getByRole("heading", { name: "三维阅读" })).toBeVisible();
  await expect(detail).toContainText("相似分数 1.00");
  await page.locator(".map-accessible-list").getByRole("button", { name: /关联阅读 1/u }).click();
  await expect(detail.getByRole("heading", { name: "关联阅读 1" })).toBeVisible();
  for (const width of [1440, 800]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`map-3d-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "深色外观", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await page.screenshot({ path: testInfo.outputPath("map-3d-dark.png") });
  await page.getByRole("button", { name: "浅色外观", exact: true }).click();
  await page.getByRole("group", { name: "地图维度" }).getByRole("button", { name: "2D", exact: true }).click();
  await expect(page.locator(".map-3d")).toHaveCount(0);
  await expect(page.locator(".map-canvas-inner canvas")).toBeVisible();
  await expect(detail.getByRole("heading", { name: "关联阅读 1" })).toBeVisible();
  await expect(detail).toContainText("相似分数 1.00");
  expect(metadata).toBe(requestsBefore);
  expect(vectors).toBe(1);
  expect(modules).toHaveLength(1);
});

test("1000 nodes use batched drawing, remain interactive and release WebGL resources on switches", async ({ page }) => {
  test.setTimeout(90_000);
  page.on("console", (message) => { if (message.type() === "error") console.log(`3D console: ${message.text()}`); });
  const nodes = Array.from({ length: 1_000 }, (_, index) => node(index, true));
  await page.route("**/api/knowledge-map?*", (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0);
    const items = nodes.slice(offset, offset + 250);
    return route.fulfill({ json: { items, folders, total: nodes.length, nextCursor: offset + items.length < nodes.length ? String(offset + items.length) : null } });
  });
  await page.route("**/api/knowledge-map/vectors?*", (route) => {
    const ids = JSON.parse(new URL(route.request().url()).searchParams.get("ids") ?? "[]") as string[];
    const items = ids.map((id) => {
      const index = Number(id.slice("three-".length));
      const item = nodes[index]!;
      return { id, sourceHash: item.semanticSourceHash, model: item.semanticModel, formatVersion: item.semanticFormatVersion,
        vector: Array.from({ length: 100 }, (_, axis) => axis === Math.floor(index / 10) ? 1 : 0) };
    });
    return route.fulfill({ json: { items, total: items.length, nextCursor: null } });
  });
  await openMap(page);
  await expect(page.locator(".map-accessible-list summary")).toContainText("1000");
  await expect(page.locator(".map-semantic-status")).toHaveCount(0, { timeout: 10_000 });
  const started = Date.now();
  await switch3D(page);
  await expect.poll(() => page.evaluate(() => window.map3dEvidence.instances)).toBe(1_001);
  const canvas = page.locator(".map-3d canvas");
  await page.evaluate(() => window.map3dEvidence.gpuReady());
  const firstFrameMs = Date.now() - started;
  expect(firstFrameMs).toBeLessThan(10_000);
  expect(await page.evaluate(() => window.map3dEvidence.drawCalls)).toBe(5);
  const bounds = (await canvas.boundingBox())!;
  const before = await page.locator(".map-3d-labels span").first().getAttribute("style");
  await page.mouse.move(bounds.x + 12, bounds.y + 20);
  await page.mouse.down();
  const measurement = await page.evaluate(async ({ x, y }) => {
    const stats = window.map3dEvidence;
    stats.times = [];
    stats.measuring = true;
    const canvas = document.querySelector<HTMLCanvasElement>(".map-3d canvas")!;
    const started = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - started;
        canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, pointerType: "mouse", buttons: 1, clientX: x + Math.sin(elapsed / 300) * 100, clientY: y + Math.cos(elapsed / 300) * 70 }));
        if (elapsed < 2_000) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    stats.measuring = false;
    await stats.gpuReady();
    const elapsed = performance.now() - started;
    const intervals = stats.times.slice(1).map((time, index) => time - stats.times[index]!).sort((a, b) => a - b);
    return { fps: stats.times.length * 1_000 / elapsed, p95Ms: intervals[Math.floor(intervals.length * 0.95)] ?? 0, drawCalls: stats.drawCalls };
  }, { x: bounds.x + 12, y: bounds.y + 20 });
  await page.mouse.up();
  console.log(JSON.stringify({ stage: "interaction", nodes: 1_001, firstFrameMs, ...measurement }));
  expect(measurement.fps).toBeGreaterThanOrEqual(30);
  expect(measurement.drawCalls).toBeLessThanOrEqual(5);
  await expect(page.locator(".map-3d-labels span").first()).not.toHaveAttribute("style", before!);
  await page.locator(".map-accessible-list summary").click();
  await page.locator(".map-accessible-list li").first().getByRole("button").click();
  await expect(page.getByRole("complementary", { name: "资料详情" })).toContainText("相似分数 1.00");
  await expect.poll(() => page.evaluate(() => window.map3dEvidence.drawCalls)).toBe(5);
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "资料库", exact: true }).click();
  await expect(page.locator(".knowledge-map-host")).toHaveClass(/is-dormant/u);
  const frames = await page.evaluate(() => window.map3dEvidence.frames);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.map3dEvidence.frames)).toBe(frames);
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "知识地图", exact: true }).click();
  for (let index = 0; index < 4; index += 1) {
    await page.getByRole("group", { name: "地图维度" }).getByRole("button", { name: "2D", exact: true }).click();
    await expect(page.locator(".map-3d")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.map3dEvidence.contexts.every((context) => context.isContextLost()))).toBe(true);
    expect(await page.evaluate(() => window.map3dEvidence.contexts.every((context) => context.canvas.width === 0 && context.canvas.height === 0))).toBe(true);
    expect(await page.evaluate(() => window.map3dEvidence.buffers)).toBe(0);
    await switch3D(page);
    await expect.poll(() => page.evaluate(() => window.map3dEvidence.instances)).toBe(1_001);
  }
  await expect.poll(async () => {
    const frames = await page.evaluate(() => window.map3dEvidence.frames);
    await page.waitForTimeout(150);
    return await page.evaluate(() => window.map3dEvidence.frames) - frames;
  }).toBe(0);
  console.log(JSON.stringify({ browser: page.context().browser()?.version(), nodes: 1_001, firstFrameMs, ...measurement, releasedContexts: await page.evaluate(() => window.map3dEvidence.contexts.filter((context) => context.isContextLost()).length) }));
});

test("3D node dragging preserves the camera and survives a 2D round trip", async ({ page }) => {
  const nodes = [node(0)];
  await page.route("**/api/knowledge-map?*", (route) => route.fulfill({ json: { items: nodes, folders, total: 1, nextCursor: null } }));
  await openMap(page);
  await page.locator(".map-accessible-list summary").click();
  await page.locator(".map-accessible-list li").first().getByRole("button").click();
  await switch3D(page);
  const label = page.locator(".map-3d-labels").getByText("三维阅读", { exact: true });
  const folder = page.locator(".map-3d-labels").getByText("阅读方法 · 1", { exact: true });
  await expect(label).toBeVisible();
  const before = (await label.boundingBox())!;
  const folderBefore = (await folder.boundingBox())!;
  await page.mouse.move(before.x - 10, before.y);
  await page.mouse.down();
  await page.mouse.move(before.x + 60, before.y + 40, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => {
    const position = (await label.boundingBox())!;
    return Math.hypot(position.x - before.x - 70, position.y - before.y - 40);
  }).toBeLessThan(2);
  const moved = (await label.boundingBox())!;
  const layouts = await page.evaluate(() => window.map3dEvidence.layoutRequests);
  const folderAfter = (await folder.boundingBox())!;
  expect(Math.hypot(folderAfter.x - folderBefore.x, folderAfter.y - folderBefore.y)).toBeLessThan(2);
  await page.getByRole("group", { name: "地图维度" }).getByRole("button", { name: "2D", exact: true }).click();
  await switch3D(page);
  await expect(label).toBeVisible();
  await expect.poll(async () => {
    const returned = (await label.boundingBox())!;
    return Math.hypot(returned.x - moved.x, returned.y - moved.y);
  }).toBeLessThan(2);
  expect(await page.evaluate(() => window.map3dEvidence.layoutRequests)).toBe(layouts);
  const group = (await folder.boundingBox())!;
  await page.mouse.click(group.x - 10, group.y);
  await expect(page.getByRole("complementary", { name: "资料详情" })).toBeHidden();
  await expect(page.locator(".map-canvas-toolbar").getByRole("button", { name: "返回总览" })).toBeVisible();
});

test("the whole relationship network is laid out in space and can be explored from another angle", async ({ page }, testInfo) => {
  const groups = ["人工智能", "知识管理", "软件工程"].map((name, index) => ({ id: `group-${index}`, name }));
  const nodes = Array.from({ length: 36 }, (_, index) => ({ ...node(index, true),
    title: `网络测试资料 ${index + 1}`, folderId: groups[index % 3]!.id, folderName: groups[index % 3]!.name }));
  await page.route("**/api/knowledge-map?*", (route) => route.fulfill({ json: { items: nodes, folders: groups, total: nodes.length, nextCursor: null } }));
  await page.route("**/api/knowledge-map/vectors?*", (route) => {
    const ids = JSON.parse(new URL(route.request().url()).searchParams.get("ids") ?? "[]") as string[];
    const items = ids.map((id) => {
      const index = Number(id.slice("three-".length));
      return { id, sourceHash: nodes[index]!.semanticSourceHash, model: "test-model", formatVersion: "semantic-text-v1",
        vector: [Math.cos(index * Math.PI / 18), Math.sin(index * Math.PI / 18), Math.sin(index * 1.7) * 0.3] };
    });
    return route.fulfill({ json: { items, total: items.length, nextCursor: null } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMap(page);
  await expect(page.locator(".map-accessible-list summary")).toContainText("36");
  await expect(page.locator(".map-semantic-status")).toHaveCount(0);
  await switch3D(page);
  await expect.poll(() => page.evaluate(() => window.map3dEvidence.instances)).toBe(39);
  await expect.poll(() => page.evaluate(() => window.map3dEvidence.drawCalls)).toBe(5);
  await page.screenshot({ path: testInfo.outputPath("network-3d.png") });
  const canvas = (await page.locator(".map-3d canvas").boundingBox())!;
  const first = await page.locator(".map-3d-labels span").first().getAttribute("style");
  await page.mouse.move(canvas.x + 12, canvas.y + 12);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 180, canvas.y + 90, { steps: 16 });
  await page.mouse.up();
  await expect(page.locator(".map-3d-labels span").first()).not.toHaveAttribute("style", first!);
  await page.screenshot({ path: testInfo.outputPath("network-3d-rotated.png") });
});

test("a paused 2D map still paints its first spatial network frame", async ({ page }) => {
  await page.route("**/api/knowledge-map?*", (route) => route.fulfill({ json: { items: [node(0)], folders, total: 1, nextCursor: null } }));
  await openMap(page);
  await page.getByRole("button", { name: "暂停移动", exact: true }).click();
  await switch3D(page);
  await expect.poll(() => page.evaluate(() => window.map3dEvidence.instances)).toBe(2);
  const frames = await page.evaluate(() => window.map3dEvidence.frames);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.map3dEvidence.frames)).toBe(frames);
  await page.getByRole("button", { name: "继续移动", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.map3dEvidence.frames)).toBeGreaterThan(frames);
});

for (const failure of ["unavailable", "context-loss"] as const) test(`3D ${failure} returns to 2D and preserves the selected document`, async ({ page }) => {
  const nodes = [node(0)];
  await page.route("**/api/knowledge-map?*", (route) => route.fulfill({ json: { items: nodes, folders, total: 1, nextCursor: null } }));
  if (failure === "unavailable") await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      return type === "webgl2" ? null : Reflect.apply(getContext, this, [type, ...args]);
    } as typeof getContext;
  });
  await openMap(page);
  await page.locator(".map-accessible-list summary").click();
  await page.locator(".map-accessible-list li").first().getByRole("button").click();
  if (failure === "context-loss") {
    await switch3D(page);
    await page.locator(".map-3d canvas").evaluate((canvas: HTMLCanvasElement) => canvas.getContext("webgl2")!.getExtension("WEBGL_lose_context")!.loseContext());
  } else await page.getByRole("group", { name: "地图维度" }).getByRole("button", { name: "3D", exact: true }).click();
  await expect(page.getByRole("group", { name: "地图维度" }).getByRole("button", { name: "2D", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("3D 暂不可用，已返回 2D；筛选和选中资料已保留。", { exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "资料详情" }).getByRole("heading", { name: "三维阅读" })).toBeVisible();
  await expect(page.locator(".map-3d")).toHaveCount(0);
});
