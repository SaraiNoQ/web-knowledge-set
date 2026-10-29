import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("extension popup prevents horizontal overflow and uses the app scrollbar palette", async ({ page, browserName }) => {
  const [html, css] = await Promise.all([readFile("extension/popup.html", "utf8"), readFile("extension/popup.css", "utf8")]);
  await page.setViewportSize({ width: 420, height: 600 });
  await page.setContent(html
    .replace('<link rel="stylesheet" href="popup.css">', `<style>${css}</style>`)
    .replace('<script src="popup.js"></script>', ""));
  await page.locator("#pair-panel").evaluate((element: HTMLElement) => { element.hidden = true; });
  await page.locator("#clip-panel").evaluate((element: HTMLElement) => { element.hidden = false; });
  await page.locator("#clip-form").evaluate((element: HTMLElement) => { element.hidden = false; });
  await page.locator("#source").fill(`https://example.com/${"long-segment".repeat(60)}`);
  await page.locator("#markdown").fill("unbroken_markdown_token".repeat(200));
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    pageOverflowX: getComputedStyle(document.documentElement).overflowX,
    editorOverflowX: getComputedStyle(document.querySelector("textarea")!).overflowX,
    editorOverflowY: getComputedStyle(document.querySelector("textarea")!).overflowY,
    editorClientHeight: document.querySelector("textarea")!.clientHeight,
    editorScrollHeight: document.querySelector("textarea")!.scrollHeight,
    scrollbarColor: getComputedStyle(document.documentElement).scrollbarColor,
    thumb: getComputedStyle(document.documentElement, "::-webkit-scrollbar-thumb").backgroundColor,
    track: getComputedStyle(document.documentElement, "::-webkit-scrollbar-track").backgroundColor,
  }));
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(layout.scrollWidth).toBe(layout.clientWidth);
  expect(layout.pageOverflowX).toBe("hidden");
  expect(layout.editorOverflowX).toBe("hidden");
  expect(layout.editorOverflowY).toBe("auto");
  expect(layout.editorScrollHeight).toBeGreaterThan(layout.editorClientHeight);
  await page.locator("#markdown").evaluate((element: HTMLTextAreaElement) => { element.scrollTop = 64; });
  expect(await page.locator("#markdown").evaluate((element: HTMLTextAreaElement) => element.scrollTop)).toBeGreaterThan(0);
  if (browserName === "firefox") {
    expect(layout.scrollbarColor).toContain("rgb(189, 65, 44)");
    expect(layout.scrollbarColor).toContain("rgba(189, 65, 44, 0.08)");
  } else {
    expect(layout.thumb).toBe("rgb(189, 65, 44)");
    expect(layout.track).toBe("rgba(189, 65, 44, 0.08)");
  }
  await page.emulateMedia({ forcedColors: "active" });
  const forced = await page.evaluate(() => ({
    scrollbarColor: getComputedStyle(document.documentElement).scrollbarColor,
    thumb: getComputedStyle(document.documentElement, "::-webkit-scrollbar-thumb").backgroundColor,
    track: getComputedStyle(document.documentElement, "::-webkit-scrollbar-track").backgroundColor,
  }));
  expect(forced.scrollbarColor).toBe("auto");
  if (browserName !== "firefox") {
    expect(forced.thumb).not.toBe("rgb(189, 65, 44)");
    expect(forced.track).not.toBe("rgba(189, 65, 44, 0.08)");
  }
});

test("extension save notifies open library tabs without coupling save success to delivery", async ({ page }) => {
  await page.addInitScript(() => {
    const state: { args?: unknown[]; hasTab: boolean; query?: unknown; received: unknown[]; rejectInjection: boolean } = { hasTab: true, received: [], rejectInjection: false };
    window.addEventListener("zhiye:extension-saved", (event) => state.received.push((event as CustomEvent<unknown>).detail));
    const api = {
      runtime: {},
      storage: { local: { get: async () => ({ token: "paired-token" }), set: async () => undefined, remove: async () => undefined } },
      tabs: { query: async (query: unknown) => { state.query = query; return state.hasTab ? [{ id: 17, url: "https://zhiye.sarainoq.cn/" }] : []; } },
      scripting: { executeScript: async (details: { args?: unknown[]; func?: (...args: unknown[]) => unknown }) => {
        if (state.rejectInjection) throw new Error("tab closed");
        state.args = details.args;
        return [{ result: details.func?.(...(details.args ?? [])) }];
      } },
    };
    Object.defineProperty(window, "browser", { configurable: true, value: api });
    Object.defineProperty(window, "fetch", { configurable: true, value: async () => new Response(JSON.stringify({ documentId: "saved-document-id" }), { status: 201, headers: { "Content-Type": "application/json" } }) });
    Object.assign(window, { __EXTENSION_PUSH_TEST__: state });
  });
  const [html, css, script] = await Promise.all([
    readFile("extension/popup.html", "utf8"),
    readFile("extension/popup.css", "utf8"),
    readFile("dist/extensions/zhiye-clipper-chrome/popup.js", "utf8"),
  ]);
  await page.route("https://extension.test/**", (route) => route.fulfill({ contentType: "text/html", body: html.replace('<link rel="stylesheet" href="popup.css">', `<style>${css}</style>`).replace('<script src="popup.js"></script>', "") }));
  await page.goto("https://extension.test/popup.html");
  await page.addScriptTag({ content: script });
  await expect(page.locator("#clip-panel")).toBeVisible();
  await page.locator("#clip-form").evaluate((element: HTMLElement) => { element.hidden = false; });
  await page.locator("#title").fill("即时刷新测试");
  await page.locator("#source").fill("https://example.com/saved");
  await page.locator("#markdown").fill("# 已保存");
  await page.getByRole("button", { name: "保存副本" }).click();
  await expect(page.locator("#status")).toHaveText("已保存，织片列表已更新。");
  expect(await page.evaluate(() => {
    const { args, query, received } = (window as typeof window & { __EXTENSION_PUSH_TEST__: { args?: unknown[]; query?: unknown; received: unknown[] } }).__EXTENSION_PUSH_TEST__;
    return { args, query, received };
  })).toEqual({
    args: ["saved-document-id"],
    query: { url: "https://zhiye.sarainoq.cn/*" },
    received: ["saved-document-id"],
  });
  await page.evaluate(() => {
    const state = (window as typeof window & { __EXTENSION_PUSH_TEST__: { rejectInjection: boolean } }).__EXTENSION_PUSH_TEST__;
    state.rejectInjection = true;
    document.querySelector<HTMLElement>("#clip-form")!.hidden = false;
  });
  await page.getByRole("button", { name: "保存副本" }).click();
  await expect(page.locator("#status")).toHaveText("已另存一张新织片。");
  await page.evaluate(() => {
    const state = (window as typeof window & { __EXTENSION_PUSH_TEST__: { hasTab: boolean; rejectInjection: boolean } }).__EXTENSION_PUSH_TEST__;
    state.rejectInjection = false;
    state.hasTab = false;
    document.querySelector<HTMLElement>("#clip-form")!.hidden = false;
  });
  await page.getByRole("button", { name: "保存副本" }).click();
  await expect(page.locator("#status")).toHaveText("已另存一张新织片。");
});

async function openQuickSavePopup(page: import("@playwright/test").Page) {
  const [html, css, script] = await Promise.all([
    readFile("extension/popup.html", "utf8"), readFile("extension/popup.css", "utf8"),
    readFile("dist/extensions/zhiye-clipper-chrome/popup.js", "utf8"),
  ]);
  await page.addInitScript(() => {
    const clip = { title: "测试网页", sourceUrl: "https://example.com/article", markdown: "完整正文与图片 ![图](https://example.com/a.png)", author: "作者", publishedAt: "2026-10-30" };
    const api = {
      storage: { local: {
        get: async () => ({ token: "paired-token", ...JSON.parse(localStorage.getItem("settings") ?? "{}") }),
        set: async (value: Record<string, unknown>) => localStorage.setItem("settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("settings") ?? "{}"), ...value })),
        remove: async () => undefined,
      } },
      tabs: { query: async (query: { active?: boolean }) => query.active ? [{ id: 17, url: clip.sourceUrl }] : [] },
      scripting: { executeScript: async (details: { files?: string[] }) => details.files ? [] : [{ result: await Promise.resolve(clip) }] },
    };
    Object.defineProperty(window, "browser", { configurable: true, value: api });
  });
  await page.route("https://extension.test/**", (route) => {
    if (route.request().url().endsWith("popup.js")) return route.fulfill({ contentType: "text/javascript", body: script });
    return route.fulfill({ contentType: "text/html", body: html.replace('<link rel="stylesheet" href="popup.css">', `<style>${css}</style>`) });
  });
  await page.setViewportSize({ width: 420, height: 600 });
  await page.goto("https://extension.test/popup.html");
  await expect(page.locator("#clip-panel")).toBeVisible();
}

test("quick save skips preview, locks repeat submissions and confirms only after saving", async ({ page }) => {
  let posts = 0;
  let submitted: unknown;
  let finish!: () => void;
  const saved = new Promise<void>((resolve) => { finish = resolve; });
  await page.route("https://clip.sarainoq.cn/api/browser-extension/clips", async (route) => {
    posts += 1;
    submitted = route.request().postDataJSON();
    await saved;
    await route.fulfill({ status: 201, json: { documentId: "quick-saved" } });
  });
  await openQuickSavePopup(page);
  const read = await page.locator("#extract").boundingBox();
  const quick = await page.locator("#quick-save").boundingBox();
  expect(quick!.width / read!.width).toBeCloseTo(1.5, 1);
  await page.getByRole("button", { name: "读取并保存" }).click();
  await expect(page.locator("#capture-scene")).toHaveAttribute("data-state", "saving");
  await expect(page.locator("#clip-form")).toBeHidden();
  await expect(page.locator("#markdown")).toHaveValue("");
  await expect(page.locator("#quick-save")).toBeDisabled();
  await expect(page.locator("#extract")).toBeDisabled();
  await page.locator("#quick-save").dispatchEvent("click");
  await expect.poll(() => posts).toBe(1);
  expect(submitted).toEqual({ title: "测试网页", sourceUrl: "https://example.com/article", markdown: "完整正文与图片 ![图](https://example.com/a.png)", author: "作者", publishedAt: "2026-10-30" });
  finish();
  await expect(page.locator("#capture-scene")).toHaveAttribute("data-state", "success");
  await expect(page.locator("#status")).toHaveText("已另存一张新织片。");
  await expect(page.locator("#quick-save")).toBeEnabled();
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator(".capture-paper").evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  expect(await page.locator(".saved-mark").evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
});

test("AI settings use a separate view, persist and apply to quick save; preview remains editable", async ({ page }) => {
  let key: string | undefined;
  await page.route("https://clip.sarainoq.cn/api/browser-extension/clips", async (route) => {
    key = route.request().headers()["x-zhiye-llm-key"];
    await route.fulfill({ status: 201, json: { documentId: "saved", aiTitleError: "MODEL_UNAVAILABLE" } });
  });
  await openQuickSavePopup(page);
  await expect(page.getByRole("heading", { name: "AI 标题" })).toBeHidden();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator("#clip-panel")).toBeHidden();
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeFocused();
  await page.getByLabel("生成标题").check();
  await page.getByLabel("云端 AI 密钥").fill("test-only-key");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("生成标题")).toBeChecked();
  await expect(page.getByLabel("云端 AI 密钥")).toHaveValue("test-only-key");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "读取并保存" }).click();
  await expect(page.locator("#status")).toContainText("已保存；AI 标题未生成");
  await expect(page.locator("#capture-scene")).toHaveAttribute("data-state", "success");
  expect(key).toBe("test-only-key");
  await page.getByRole("button", { name: "读取网页", exact: true }).click();
  await expect(page.locator("#title")).toHaveValue("测试网页");
  await page.locator("#title").fill("修改的标题");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("生成标题").uncheck();
  await expect(page.getByLabel("云端 AI 密钥")).toBeHidden();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.locator("#title")).toHaveValue("修改的标题");
  await page.getByRole("button", { name: "保存副本" }).click();
  await expect(page.locator("#status")).toHaveText("已另存一张新织片。");
  expect(key).toBeUndefined();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("settings")!).llmKey)).toBe("");
});

test("quick save errors do not show a success stamp or preview and permit retry", async ({ page }) => {
  let attempts = 0;
  await page.route("https://clip.sarainoq.cn/api/browser-extension/clips", async (route) => {
    attempts += 1;
    await route.fulfill(attempts === 1 ? { status: 500, json: { error: { code: "INTERNAL_ERROR" } } } : { status: 201, json: { documentId: "retry" } });
  });
  await openQuickSavePopup(page);
  await page.getByRole("button", { name: "读取并保存" }).click();
  await expect(page.locator("#capture-scene")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#status")).toContainText("保存失败");
  await expect(page.locator("#clip-form")).toBeHidden();
  await expect(page.locator("#quick-save")).toBeEnabled();
  await page.getByRole("button", { name: "读取并保存" }).click();
  await expect(page.locator("#capture-scene")).toHaveAttribute("data-state", "success");
  expect(attempts).toBe(2);
});
