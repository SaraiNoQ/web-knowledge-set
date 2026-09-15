import { expect, test } from "@playwright/test";

test("knowledge map stays responsive with 1000 documents and 1024-dimension vectors", async ({ page }) => {
  test.setTimeout(90_000);
  const count = 1_000;
  const dimension = 1_024;
  const model = "BAAI/bge-m3";
  const formatVersion = "semantic-text-v1";
  const folders = Array.from({ length: 20 }, (_, index) => ({ id: `folder-${index}`, name: `Folder ${index}` }));
  const nodes = Array.from({ length: count }, (_, index) => {
    const id = `perf-${String(index).padStart(4, "0")}`;
    const folder = index < 50 ? null : folders[index % folders.length]!;
    const kind = index % 2 === 0 ? "article" : "paper";
    return {
      id, kind, title: `Benchmark ${String(index).padStart(4, "0")}`,
      folderId: folder?.id ?? null, folderName: folder?.name ?? null, status: "ready", favorite: false, archivedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z", pageCount: kind === "paper" ? 12 : null, semanticState: "ready",
      semanticSourceHash: index.toString(16).padStart(64, "0"), semanticModel: model, semanticFormatVersion: formatVersion,
    };
  });
  const vectors = nodes.map((node, index) => ({
    id: node.id, sourceHash: node.semanticSourceHash, model, formatVersion,
    vector: Array.from({ length: dimension }, (_, axis) => (((index + 1) * (axis + 3)) % 97 - 48) / 97),
  }));
  const vectorsById = new Map(vectors.map((entry) => [entry.id, entry]));

  await page.route("**/api/knowledge-map?*", (route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 250);
    const items = nodes.slice(offset, offset + limit);
    const next = offset + items.length;
    return route.fulfill({ json: { items, folders, total: count, nextCursor: next < count ? String(next) : null } });
  });
  await page.route("**/api/knowledge-map/vectors?*", (route) => {
    const ids = JSON.parse(new URL(route.request().url()).searchParams.get("ids") ?? "[]") as string[];
    const items = ids.flatMap((id) => {
      const entry = vectorsById.get(id);
      return entry ? [entry] : [];
    });
    return route.fulfill({ json: { items, total: items.length, nextCursor: null } });
  });

  await page.goto("/");
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  await expect(deferSetup.or(page.getByLabel("网页地址"))).toBeVisible();
  if (await deferSetup.isVisible()) await deferSetup.click();
  const firstMetadataPage = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/knowledge-map" && !url.searchParams.has("cursor");
  });
  const lastMetadataPage = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/knowledge-map" && url.searchParams.get("cursor") === "750";
  });
  const finalVectorPage = page.waitForResponse((response) => {
    const url = new URL(response.url());
    if (url.pathname !== "/api/knowledge-map/vectors") return false;
    return (JSON.parse(url.searchParams.get("ids") ?? "[]") as string[]).includes("perf-0999");
  });
  const metadataStart = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: "知识地图" }).click();
  await Promise.all([firstMetadataPage, lastMetadataPage]);
  const metadataMs = await page.evaluate((start) => performance.now() - start, metadataStart);
  expect(metadataMs, `1000-node metadata took ${metadataMs.toFixed(1)}ms`).toBeLessThan(2_000);
  await finalVectorPage;

  const graphStart = await page.evaluate(() => performance.now());
  await expect(page.locator(".map-semantic-status")).toHaveCount(0, { timeout: 10_000 });
  const graphMs = await page.evaluate((start) => performance.now() - start, graphStart);
  expect(graphMs, `1000 × 1024 similarity calculation took ${graphMs.toFixed(1)}ms`).toBeLessThan(5_000);
  await page.waitForTimeout(6_000);

  const canvas = page.locator(".map-canvas-inner canvas");
  await expect(canvas).toBeVisible();
  const relationPixels = () => canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const red = pixels[offset]!;
      const green = pixels[offset + 1]!;
      const blue = pixels[offset + 2]!;
      if (pixels[offset + 3]! > 80 && ((Math.abs(red - 103) < 3 && Math.abs(green - 93) < 3 && Math.abs(blue - 133) < 3) ||
        (Math.abs(red - 109) < 3 && Math.abs(green - 103) < 3 && Math.abs(blue - 88) < 3))) count += 1;
    }
    return count;
  });
  const point = await canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset] === 119 && data[offset + 1] === 118 && data[offset + 2] === 111 && data[offset + 3] > 0) {
        const pixel = offset / 4;
        return { x: pixel % canvas.width, y: Math.floor(pixel / canvas.width), width: canvas.width, height: canvas.height };
      }
    }
    return null;
  });
  expect(point, "canvas should contain a draggable article node").not.toBeNull();
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const startX = bounds!.x + point!.x * bounds!.width / point!.width;
  const startY = bounds!.y + point!.y * bounds!.height / point!.height;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 120, startY + 80, { steps: 24 });
  await expect(page.locator(".map-coordinate-note")).toContainText("拖动时暂时隐藏连线");
  expect(await relationPixels()).toBe(0);
  const canvasFrame = () => canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index += 1) hash = Math.imul(hash ^ pixels[index]!, 16777619);
    return hash >>> 0;
  });
  const draggedNodePath = { x: startX + 120, y: startY + 80 };
  const otherNodePoint = await canvas.evaluate((element, target) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    const bounds = canvas.getBoundingClientRect();
    const left = Math.max(2, Math.floor((target.x - 64 - bounds.left) * canvas.width / bounds.width));
    const right = Math.min(canvas.width - 2, Math.ceil((target.x + 64 - bounds.left) * canvas.width / bounds.width));
    const top = Math.max(2, Math.floor((target.y - 48 - bounds.top) * canvas.height / bounds.height));
    const bottom = Math.min(canvas.height - 2, Math.ceil((target.y + 48 - bounds.top) * canvas.height / bounds.height));
    for (let y = 2; y < canvas.height - 2; y += 1) {
      for (let x = 2; x < canvas.width - 2; x += 1) {
        if (x >= left && x < right && y >= top && y < bottom) continue;
        if (pixels[(y * canvas.width + x) * 4 + 3]! > 250) return { x, y };
      }
    }
    return null;
  }, draggedNodePath);
  expect(otherNodePoint, "a non-dragged node pixel outside the drag path should be visible").not.toBeNull();
  const nodeFrame = (point: { x: number; y: number }) => canvas.evaluate((element, position) => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let y = position.y - 7; y <= position.y + 7; y += 1) {
      for (let x = position.x - 7; x <= position.x + 7; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        for (let channel = 0; channel < 4; channel += 1) hash = Math.imul(hash ^ pixels[offset + channel]!, 16777619);
      }
    }
    return hash >>> 0;
  }, point);
  const otherNodeFrame = await nodeFrame(otherNodePoint!);
  const frameAtDrag = await canvasFrame();
  await page.waitForTimeout(2_000);
  expect(await canvasFrame()).toBe(frameAtDrag);
  const { frames, elapsed, moves } = await page.evaluate(async ({ x, y }) => {
    const state = window as typeof window & { __mapDrawFrames?: number; __mapMeasureStarted?: number; __mapMeasuring?: boolean };
    const canvas = document.querySelector<HTMLCanvasElement>(".map-canvas-inner canvas");
    const context = canvas?.getContext("2d");
    if (!context) throw new Error("2D map canvas is unavailable");
    const clearRect = context.clearRect.bind(context);
    state.__mapDrawFrames = 0;
    state.__mapMeasureStarted = performance.now();
    state.__mapMeasuring = true;
    // Count actual ForceGraph canvas redraws; a bare RAF loop can pass while the map stays frozen.
    context.clearRect = (left, top, width, height) => {
      if (state.__mapMeasuring) state.__mapDrawFrames = (state.__mapDrawFrames ?? 0) + 1;
      clearRect(left, top, width, height);
    };
    let moves = 0;
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        const offset = moves % 2 === 0 ? 24 : -24;
        window.dispatchEvent(new MouseEvent("mousemove", {
          bubbles: true, cancelable: true, view: window,
          clientX: x + offset, clientY: y + (moves % 4 < 2 ? 16 : -16), buttons: 1,
        }));
        moves += 1;
        if (now - state.__mapMeasureStarted! >= 2_000) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    state.__mapMeasuring = false;
    return { frames: state.__mapDrawFrames ?? 0, elapsed: performance.now() - state.__mapMeasureStarted!, moves };
  }, { x: startX + 120, y: startY + 80 });
  expect(moves).toBeGreaterThanOrEqual(60);
  const fps = frames * 1_000 / elapsed;
  expect(await canvasFrame()).not.toBe(frameAtDrag);
  expect(await nodeFrame(otherNodePoint!)).toBe(otherNodeFrame);
  await page.mouse.up();
  await expect(page.locator(".map-coordinate-note")).toHaveText("位置仅用于排布，不代表相似度。");
  await expect.poll(relationPixels).toBeGreaterThan(0);
  console.log(JSON.stringify({ browser: page.context().browser()?.version(), documents: count, folders: folders.length, dimensions: dimension, metadataMs: Number(metadataMs.toFixed(1)), graphMs: Number(graphMs.toFixed(1)), dragFps: Number(fps.toFixed(1)) }));
  expect(fps, `drag animation produced ${fps.toFixed(1)} frames/s`).toBeGreaterThanOrEqual(30);
});
