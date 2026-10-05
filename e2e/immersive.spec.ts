import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function resetAppearance(request: APIRequestContext) {
  const current = await request.get("/api/settings/appearance");
  const saved = await request.put("/api/settings/appearance", {
    data: { immersiveMode: false },
    headers: { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": current.headers()["x-zhiye-data-epoch"] },
  });
  expect(saved.ok()).toBe(true);
}

test.beforeEach(async ({ page, request }) => {
  await resetAppearance(request);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
});
test.afterEach(async ({ request }) => resetAppearance(request));

async function enter(page: Page) {
  await page.getByRole("button", { name: "进入沉浸模式" }).click();
  const exit = page.getByRole("button", { name: "退出沉浸模式" });
  await expect(exit).toBeVisible();
  await expect(exit).toHaveAttribute("aria-disabled", "false");
}

test("immersive layout fills the viewport and restores chrome at desktop and small widths", async ({ page }, info) => {
  for (const width of [1440, 800, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByLabel("网页地址")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`ordinary-${width}.png`) });
    await enter(page);
    await expect(page.getByRole("button", { name: "退出沉浸模式" })).toBeFocused();
    await expect(page.locator(".masthead")).toBeHidden();
    await expect(page.locator(".capture-band")).toBeHidden();
    await expect(page.getByRole("navigation", { name: "工作台导航" })).toBeVisible();
    const layout = await page.evaluate(() => ({
      bar: document.querySelector(".immersive-bar"),
      workspace: document.querySelector(".workspace")!.getBoundingClientRect().top,
      height: document.querySelector(".workspace")!.getBoundingClientRect().height,
      viewport: innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    expect(layout.bar).toBeNull();
    expect(layout.workspace).toBe(0);
    expect(layout.height).toBeGreaterThanOrEqual(layout.viewport);
    expect(layout.overflow).toBe(false);
    if (width > 820) {
      await page.getByRole("button", { name: "文档资料库" }).click();
      await expect(page.locator(".workspace")).toHaveClass(/library-collapsed/u);
      await expect(page.getByRole("button", { name: "退出沉浸模式" })).toBeVisible();
      await page.getByRole("button", { name: "文档资料库" }).click();
    }
    await page.screenshot({ path: info.outputPath(`immersive-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(page.locator(".app-shell")).toHaveClass(/is-immersive/u);
    await page.getByRole("button", { name: "退出沉浸模式" }).click();
    await expect(page.getByRole("button", { name: "进入沉浸模式" })).toBeFocused();
    await expect(page.getByLabel("网页地址")).toBeVisible();
  }
});

test("switching preserves the editor instance, dirty content, selection and scroll", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("dialog", { name: "新建" }).getByRole("button", { name: "创建文章" }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 编辑器" });
  await editor.fill(Array.from({ length: 100 }, (_, i) => `段落 ${i} 尚未保存。`).join("\n"));
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.locator(".cm-editor").evaluate((element) => {
    element.setAttribute("data-preserved", "yes");
    element.querySelector(".cm-scroller")!.scrollTop = 120;
  });
  const selection = await page.evaluate(() => ({ anchor: getSelection()?.anchorOffset, focus: getSelection()?.focusOffset }));
  await enter(page);
  await expect(page.getByText("未保存", { exact: true })).toBeVisible();
  await expect(page.locator(".cm-editor")).toHaveAttribute("data-preserved", "yes");
  await expect(editor).toContainText("尚未保存。");
  expect(await page.locator(".cm-scroller").evaluate((element) => element.scrollTop)).toBe(120);
  // Focusing a toolbar button may clear the DOM selection; CodeMirror's
  // selection must be restored when focus returns to the same editor.
  await editor.focus();
  expect(await page.evaluate(() => ({ anchor: getSelection()?.anchorOffset, focus: getSelection()?.focusOffset }))).toEqual(selection);
  await page.getByRole("button", { name: "退出沉浸模式" }).focus();
  await page.evaluate(() => window.scrollTo(0, 700));
  const toolbar = await page.locator(".editor-toolbar").boundingBox();
  expect(toolbar!.y).toBeGreaterThanOrEqual(33);
  expect(await page.locator(".editor-toolbar").evaluate((element) => getComputedStyle(element).top)).toBe("33px");
  await page.getByRole("button", { name: "退出沉浸模式" }).click();
  await expect(page.locator(".cm-editor")).toHaveAttribute("data-preserved", "yes");
  await expect(editor).toContainText("尚未保存。");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("local preference survives refresh and settings remain accessible", async ({ page }) => {
  await page.goto("/");
  await enter(page);
  await page.reload();
  await expect(page.getByRole("button", { name: "退出沉浸模式" })).toBeVisible();
  await page.keyboard.press("?");
  await page.getByRole("button", { name: "重新打开使用指南" }).click();
  await expect(page.getByRole("dialog", { name: /你的知识/u })).toBeVisible();
  await expect(page.locator(".masthead")).toBeVisible();
  await expect(page.locator(".immersive-bar")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "退出沉浸模式" })).toBeVisible();
  await page.getByRole("button", { name: "退出沉浸模式" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator(".masthead")).toBeVisible();
  await expect(page.locator(".immersive-bar")).toBeHidden();
});

test("recovery mode keeps its full navigation even with a saved immersive preference", async ({ page, request }) => {
  const current = await request.get("/api/settings/appearance");
  await request.put("/api/settings/appearance", {
    data: { immersiveMode: true },
    headers: { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": current.headers()["x-zhiye-data-epoch"] },
  });
  await page.route("**/api/data-safety", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, mode: "recovery", recoveryError: { code: "DATABASE_CORRUPT", message: "recovery" } } });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "数据安全" })).toBeVisible();
  await expect(page.locator(".masthead")).toBeVisible();
  await expect(page.locator(".immersive-bar")).toBeHidden();
});

test("failed preference reads default to ordinary mode and failed writes keep the new mode", async ({ page }) => {
  await page.route("**/api/settings/appearance", (route) => route.fulfill({ status: 503, json: { error: { code: "DATA_UNAVAILABLE", message: "unavailable" } } }));
  await page.goto("/");
  await expect(page.getByLabel("网页地址")).toBeVisible();
  await enter(page);
  await expect(page.getByText("显示模式已切换，但未能记住选择。请稍后重新切换以保存。")).toBeVisible();
  await page.getByRole("button", { name: "退出沉浸模式" }).click();
  await expect(page.getByLabel("网页地址")).toBeVisible();
});

test("preference writes disable repeated toggles while keeping keyboard focus", async ({ page }) => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let writes = 0;
  await page.route("**/api/settings/appearance", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    writes += 1;
    await pending;
    await route.fulfill({ json: { immersiveMode: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "进入沉浸模式" }).click();
  const exit = page.getByRole("button", { name: "退出沉浸模式" });
  try {
    await expect(exit).toHaveAttribute("aria-disabled", "true");
    await expect(exit).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".app-shell")).toHaveClass(/is-immersive/u);
    expect(writes).toBe(1);
  } finally { finish(); }
  await expect(exit).toHaveAttribute("aria-disabled", "false");
});

test("cloud preference uses browser storage and survives refresh without the local appearance API", async ({ page }) => {
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  let appearanceRequests = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/settings/appearance") appearanceRequests += 1; });
  await page.goto("/");
  await enter(page);
  expect(await page.evaluate(() => localStorage.getItem("zhiye:immersive-mode"))).toBe("true");
  await page.reload();
  await expect(page.getByRole("button", { name: "退出沉浸模式" })).toBeVisible();
  await page.getByRole("button", { name: "退出沉浸模式" }).click();
  await expect(page.getByRole("button", { name: "进入沉浸模式" })).toHaveAttribute("aria-disabled", "false");
  expect(await page.evaluate(() => localStorage.getItem("zhiye:immersive-mode"))).toBe("false");
  expect(appearanceRequests).toBe(0);
});

test("unavailable cloud storage still allows entering and exiting", async ({ page }) => {
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  await page.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage blocked", "SecurityError"); } }));
  await page.goto("/");
  await enter(page);
  await expect(page.getByText("显示模式已切换，但未能记住选择。请稍后重新切换以保存。")).toBeVisible();
  await page.getByRole("button", { name: "退出沉浸模式" }).click();
  await expect(page.locator(".masthead")).toBeVisible();
});

test("immersive knowledge map keeps its canvas mounted and fills the viewport", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "查看知识地图", exact: true }).click();
  const canvas = page.locator(".map-canvas-inner canvas");
  await expect(canvas).toBeVisible();
  await canvas.evaluate((element) => element.setAttribute("data-preserved", "yes"));
  await enter(page);
  for (const width of [1440, 800, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(canvas).toHaveAttribute("data-preserved", "yes");
    await expect.poll(() => page.locator(".knowledge-map-host.is-active").evaluate((element) => element.clientHeight)).toBe(900);
    const bounds = await page.evaluate(() => {
      window.scrollTo(0, 100_000);
      const rect = document.querySelector(".knowledge-map-host.is-active")!.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(Math.round(bounds.top)).toBe(0);
    expect(Math.round(bounds.bottom)).toBe(900);
    expect(bounds.overflow).toBe(false);
    await expect(page.getByRole("button", { name: "退出沉浸模式" })).toBeVisible();
  }
});

test("paper translation drafts and reader state survive immersive switching", async ({ page, request }) => {
  const llmResponse = await request.get("/api/settings/llm");
  const settings = await llmResponse.json();
  const enabled = await request.put("/api/settings/llm", {
    data: { enabled: true, target: "local", remote: settings.remote, local: { endpointUrl: "http://127.0.0.1:4175", model: "e2e", trusted: true }, revision: settings.revision },
    headers: { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": llmResponse.headers()["x-zhiye-data-epoch"] },
  });
  expect(enabled.ok()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "导入论文", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入论文" });
  await dialog.getByRole("tab", { name: "上传 PDF" }).click();
  await dialog.locator('input[type="file"]').setInputFiles({ name: "immersive.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nE2E fixture\n", "ascii") });
  const upload = page.waitForResponse((response) => response.url().endsWith("/api/papers/upload") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "创建论文" }).click();
  const { paper } = await (await upload).json();
  try {
    await expect(page.getByText("一篇 E2E 论文。", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "重命名文章", exact: true }).dblclick();
    await page.getByRole("textbox", { name: "文章标题", exact: true }).fill("论文标题同步测试");
    await page.getByRole("textbox", { name: "文章标题", exact: true }).press("Enter");
    await expect(page.locator(".paper-reader-header h1")).toHaveText("论文标题同步测试");
    await page.getByRole("button", { name: "编辑译文" }).click();
    await page.locator("textarea").fill("沉浸模式中的未保存译文。");
    await page.locator(".paper-reader").evaluate((element) => element.setAttribute("data-preserved", "yes"));
    await enter(page);
    await expect(page.locator(".paper-reader")).toHaveAttribute("data-preserved", "yes");
    await expect(page.locator("textarea")).toHaveValue("沉浸模式中的未保存译文。");
    await expect.poll(() => page.locator(".paper-reader-body").evaluate((element) => element.clientHeight - (innerHeight))).toBe(0);
    for (const height of [900, 600]) {
      await page.setViewportSize({ width: 320, height });
      await expect.poll(() => page.locator(".paper-reader-pdf-page").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(420);
      const stacked = await page.locator(".paper-reader-body").evaluate((element) => {
        const body = element.getBoundingClientRect();
        const original = element.querySelector(".paper-reader-pdf-page")!.getBoundingClientRect();
        const translation = element.querySelector(".paper-reader-translation")!.getBoundingClientRect();
        return { height: body.height, bottom: body.bottom, originalHeight: original.height, translationHeight: translation.height, translationBottom: translation.bottom, stacked: translation.top >= original.bottom, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(stacked.height, JSON.stringify(stacked)).toBeGreaterThanOrEqual(840);
      expect(stacked.originalHeight).toBeGreaterThanOrEqual(420);
      expect(stacked.translationHeight).toBeGreaterThanOrEqual(420);
      expect(stacked.stacked).toBe(true);
      expect(stacked.translationBottom).toBeLessThanOrEqual(stacked.bottom);
      expect(stacked.overflow).toBe(false);
      await page.locator("textarea").scrollIntoViewIfNeeded();
      await expect(page.locator("textarea")).toBeVisible();
      await expect(page.getByRole("button", { name: "退出沉浸模式" })).toBeVisible();
      expect(await page.locator(".paper-reader-translation-scroll").evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
    }
    await page.getByRole("button", { name: "退出沉浸模式" }).click();
    await expect(page.locator("textarea")).toHaveValue("沉浸模式中的未保存译文。");
    await page.setViewportSize({ width: 1440, height: 900 });
    const mapButton = page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "查看知识地图", exact: true });
    await mapButton.click();
    const discard = page.getByRole("alertdialog", { name: "存在未保存修改" });
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator("textarea")).toHaveValue("沉浸模式中的未保存译文。");
    await mapButton.click();
    await discard.getByRole("button", { name: "继续并放弃" }).click();
    await expect(page.locator(".knowledge-map-host.is-active")).toBeVisible();
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "文档资料库", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "知识列表" })).toBeVisible();
  } finally {
    const document = await request.get(`/api/documents/${paper.id}`);
    const { revision } = await document.json();
    const trashed = await request.delete(`/api/documents/${paper.id}`, {
      data: { revision },
      headers: { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": document.headers()["x-zhiye-data-epoch"] },
    });
    expect(trashed.ok()).toBe(true);
    const removed = await request.delete(`/api/documents/${paper.id}/permanent`, {
      data: { revision: (await trashed.json()).revision, draftRevision: null },
      headers: { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": trashed.headers()["x-zhiye-data-epoch"] },
    });
    expect(removed.ok()).toBe(true);
  }
});
