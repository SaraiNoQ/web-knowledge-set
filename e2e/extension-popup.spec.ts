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
