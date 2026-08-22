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
    Object.defineProperty(window, "chrome", { configurable: true, value: api });
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
  await page.getByRole("button", { name: "确认并保存新副本" }).click();
  await expect(page.locator("#status")).toHaveText("已保存，织页目录已自动刷新。");
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
  await page.getByRole("button", { name: "确认并保存新副本" }).click();
  await expect(page.locator("#status")).toHaveText("已保存为织页中的新副本。");
  await page.evaluate(() => {
    const state = (window as typeof window & { __EXTENSION_PUSH_TEST__: { hasTab: boolean; rejectInjection: boolean } }).__EXTENSION_PUSH_TEST__;
    state.rejectInjection = false;
    state.hasTab = false;
    document.querySelector<HTMLElement>("#clip-form")!.hidden = false;
  });
  await page.getByRole("button", { name: "确认并保存新副本" }).click();
  await expect(page.locator("#status")).toHaveText("已保存为织页中的新副本。");
});
