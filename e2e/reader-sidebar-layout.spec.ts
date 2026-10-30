import { expect, test, type Locator } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";

async function appearance(button: Locator) {
  return button.evaluate(node => {
    const style = getComputedStyle(node);
    return { color: style.color, background: style.backgroundColor, border: style.borderColor,
      fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
      outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
}

test("reader sidebar keeps short tabs typography and scrolling usable across sizes and themes", async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", route => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.addInitScript(() => {
    localStorage.setItem("zhiye.theme", "light");
    localStorage.setItem("zhiye.reader-tools.enabled", '["translation"]');
    localStorage.setItem("zhiye.reader-tool.translation.$settings", JSON.stringify({ schemaVersion: 1, values: {
      automatic: false, language: "zh-CN", glossary: { revision: 1,
        terms: Array.from({ length: 24 }, (_, index) => ({ source: `Evidence-led research terminology ${index + 1}`, target: `证据与长期知识研究术语 ${index + 1}` })) },
    } }));
  });
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `侧栏排版检查 ${Date.now()}`;
  const created = await request.post("/api/documents", { headers, data: { title } });
  expect(created.ok()).toBe(true);
  const { document: article } = await created.json();
  const markdown = Array.from({ length: 80 }, (_, index) => `## 阅读层次与证据管理的长期观察 ${index + 1}\n\nReading paragraph ${index + 1}. 这是一段用于检验长内容与独立滚动的正文。`).join("\n\n");
  expect((await request.patch(`/api/documents/${article.id}`, { headers, data: { revision: article.revision, markdown } })).ok()).toBe(true);
  await page.goto("/");
  await page.locator(".library-directory").getByRole("button", { name: title, exact: true }).click();
  await expect(page.locator(".reader-main .markdown-preview")).toBeVisible();
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "右侧功能区", exact: true });
  const navigation = sidebar.getByRole("navigation", { name: "阅读功能", exact: true });
  const content = sidebar.locator(".reader-sidebar-content"), header = sidebar.locator(":scope > header");
  const translation = navigation.getByRole("button", { name: "翻译", exact: true });
  await expect(navigation.getByRole("button")).toHaveText(["大纲", "管理", "翻译"]);
  await translation.click();
  await expect(sidebar.getByRole("combobox", { name: "目标语言", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "翻译选区", exact: true })).toBeDisabled();

  const variants = [
    { width: 1440, height: 900, dark: false, scale: 1 },
    { width: 390, height: 844, dark: false, scale: 1 },
    { width: 320, height: 720, dark: false, scale: 1 },
    { width: 390, height: 844, dark: false, scale: 2 },
    { width: 1440, height: 900, dark: true, scale: 1 },
    { width: 390, height: 844, dark: true, scale: 1 },
  ];
  const evidence = [];
  for (const variant of variants) {
    const name = `${variant.width}-${variant.dark ? "dark" : "light"}${variant.scale === 2 ? "-text200" : ""}`;
    await page.setViewportSize({ width: variant.width, height: variant.height });
    await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, variant.scale);
    if (await page.locator("html").getAttribute("data-theme") !== (variant.dark ? "dark" : "light")) {
      await page.getByRole("button", { name: variant.dark ? "深色外观" : "浅色外观", exact: true }).click();
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", variant.dark ? "dark" : "light");
    await content.evaluate(node => { node.scrollTop = 0; });
    await sidebar.locator(".translation-glossary").evaluate(node => { (node as HTMLDetailsElement).open = false; });
    await page.mouse.move(0, 0);
    const geometry = await sidebar.evaluate(node => {
      const rect = node.getBoundingClientRect(), tabs = Array.from(node.querySelectorAll<HTMLElement>(".reader-sidebar-tabs > button"));
      const close = node.querySelector<HTMLElement>("header > button")!, closeRect = close.getBoundingClientRect();
      const roles = [node, ...tabs, node.querySelector(".selection-translation label")!, node.querySelector(".ui-select")!, node.querySelector(".translation-hint")!, node.querySelector(".translation-glossary summary")!];
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
        documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
        tabs: tabs.map(tab => { const bounds = tab.getBoundingClientRect(); return { top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height }; }),
        close: { width: closeRect.width, height: closeRect.height },
        fontFamilies: roles.map(role => getComputedStyle(role).fontFamily) };
    });
    expect(geometry.left, `${name} left boundary`).toBeGreaterThanOrEqual(0);
    expect(geometry.right, `${name} right boundary`).toBeLessThanOrEqual(variant.width + 1);
    expect(geometry.bottom, `${name} bottom boundary`).toBeLessThanOrEqual(variant.height + 1);
    expect(geometry.documentWidth, `${name} page width`).toBeLessThanOrEqual(variant.width + 1);
    expect(geometry.scrollWidth, `${name} sidebar width`).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(Math.max(...geometry.tabs.map(tab => tab.top)) - Math.min(...geometry.tabs.map(tab => tab.top)), `${name} single tab row`).toBeLessThanOrEqual(1);
    for (const tab of geometry.tabs) expect(tab.height, `${name} tab target`).toBeGreaterThanOrEqual(44);
    expect(geometry.close.width, `${name} close target width`).toBeGreaterThanOrEqual(44);
    expect(geometry.close.height, `${name} close target height`).toBeGreaterThanOrEqual(44);
    expect(new Set(geometry.fontFamilies).size, `${name} font families`).toBe(1);

    const rest = await appearance(translation);
    await translation.hover();
    const hover = await appearance(translation);
    expect(hover.color, `${name} selected hover text`).toBe(rest.color);
    expect(hover.background, `${name} selected hover background`).toBe(rest.background);
    expect(hover.border, `${name} selected hover border`).toBe(rest.border);
    const inactive = await appearance(navigation.getByRole("button", { name: "大纲", exact: true }));
    expect(rest.color !== inactive.color || rest.background !== inactive.background, `${name} active distinction`).toBe(true);
    await translation.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
    await expect(translation).toBeFocused();
    const focused = await appearance(translation);
    expect(focused.outlineStyle, `${name} keyboard focus`).not.toBe("none");
    expect(parseFloat(focused.outlineWidth), `${name} visible focus ring`).toBeGreaterThanOrEqual(2);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath(`reader-sidebar-translation-${name}.png`), animations: "disabled" });

    await sidebar.locator(".translation-glossary summary").click();
    const before = { header: await header.boundingBox(), reader: await page.locator(".reader-main").evaluate(node => node.scrollTop) };
    await content.hover(); await page.mouse.wheel(0, 700);
    await expect.poll(() => content.evaluate(node => node.scrollTop), { message: `${name} content scroll owner` }).toBeGreaterThan(0);
    expect(await sidebar.evaluate(node => node.scrollTop), `${name} sidebar shell stays fixed`).toBe(0);
    expect(await page.locator(".reader-main").evaluate(node => node.scrollTop), `${name} reader stays fixed`).toBe(before.reader);
    expect((await header.boundingBox())!.y, `${name} header stays fixed`).toBeCloseTo(before.header!.y, 1);
    await page.screenshot({ path: testInfo.outputPath(`reader-sidebar-scrolled-${name}.png`), animations: "disabled" });
    evidence.push({ name, geometry, selected: { rest, hover, focused }, contentScrollTop: await content.evaluate(node => node.scrollTop) });
    if (variant.width === 1440) expect((await new AxeBuilder({ page }).include(".reader-sidebar").analyze()).violations).toEqual([]);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
  await page.setViewportSize({ width: 390, height: 844 });
  await navigation.getByRole("button", { name: "大纲", exact: true }).click();
  await expect(content.getByRole("navigation", { name: "Markdown 大纲", exact: true }).getByRole("button")).toHaveCount(80);
  await content.evaluate(node => { node.scrollTop = 0; });
  await content.hover(); await page.mouse.wheel(0, 700);
  await expect.poll(() => content.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await expect(navigation.getByRole("button", { name: "大纲", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("reader-sidebar-outline-mobile-dark.png"), animations: "disabled" });
  await navigation.getByRole("button", { name: "管理", exact: true }).click();
  await expect(content.getByRole("heading", { name: /^摘录与笔记/u })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("reader-sidebar-management-mobile-dark.png"), animations: "disabled" });
  await writeFile(testInfo.outputPath("reader-sidebar-layout.json"), JSON.stringify(evidence, null, 2));
  await sidebar.getByRole("button", { name: /^收起/u }).click();
  await expect(sidebar).toBeHidden();
  await expect(page.getByRole("button", { name: "展开侧栏", exact: true })).toBeFocused();
});
