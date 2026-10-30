import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import type { StudyDocument } from "../shared/study-types.js";

async function appearance(element: Locator) {
  return element.evaluate(node => {
    const style = getComputedStyle(node);
    const pseudo = (name: string) => {
      const value = getComputedStyle(node, name);
      return { content: value.content, background: value.backgroundColor, backgroundImage: value.backgroundImage, opacity: value.opacity, boxShadow: value.boxShadow };
    };
    return {
      fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
      lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, color: style.color,
      background: style.backgroundColor, backgroundImage: style.backgroundImage,
      borderColor: style.borderColor, borderBottomWidth: style.borderBottomWidth,
      borderRadius: style.borderRadius, boxShadow: style.boxShadow,
      outline: { color: style.outlineColor, width: style.outlineWidth, style: style.outlineStyle, offset: style.outlineOffset },
      focused: document.activeElement === node, focusVisible: node.matches(":focus-visible"),
      hovered: node.matches(":hover"), pressed: node.matches(":active"), current: node.getAttribute("aria-current"),
      before: pseudo("::before"), after: pseudo("::after"),
      stateVariables: Object.fromEntries(Array.from(style).filter(name => name.startsWith("--") && /state|hover|focus/iu.test(name)).map(name => [name, style.getPropertyValue(name)])),
      stateLayers: Array.from(node.querySelectorAll('[class*="state-layer"],[data-state-layer]')).map(layer => {
        const value = getComputedStyle(layer);
        return { className: layer.className, background: value.backgroundColor, opacity: value.opacity };
      }),
    };
  });
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const measure = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom,
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop,
        overflowX: style.overflowX, overflowY: style.overflowY, maxWidth: style.maxWidth,
        paddingLeft: style.paddingLeft, paddingRight: style.paddingRight, scrollbarGutter: style.scrollbarGutter,
      };
    };
    const host = measure(".study-host"), workspace = measure(".study-workspace"), content = measure(".study-content");
    const ancestors = [];
    let element = document.querySelector<HTMLElement>(".study-document-list")!;
    while (element) {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      ancestors.push({ tag: element.tagName, id: element.id, className: element.className,
        x: rect.x, right: rect.right, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight, overflowY: style.overflowY,
        canScrollVertically: element.scrollHeight > element.clientHeight + 1 && /auto|scroll/u.test(style.overflowY) });
      element = element.parentElement!;
    }
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      host, workspace, content, library: measure(".study-library"), list: measure(".study-document-list"),
      header: measure(".study-workspace-head"), navigation: measure(".study-navigation"), firstRow: measure(".study-document-list > li"),
      rightGaps: { viewportToWorkspace: innerWidth - workspace.right, hostToWorkspace: host.right - workspace.right,
        viewportToContent: innerWidth - content.right, hostToContent: host.right - content.right },
      document: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight, scrollTop: document.documentElement.scrollTop,
        bodyScrollHeight: document.body.scrollHeight, bodyClientHeight: document.body.clientHeight, bodyScrollTop: document.body.scrollTop,
        scrollingElement: document.scrollingElement?.tagName, windowScrollY: scrollY },
      ancestors,
    };
  });
}

async function resetScroll(page: Page) {
  await page.evaluate(() => {
    for (const node of document.querySelectorAll<HTMLElement>(".study-content,.study-workspace,.study-host,.app-shell")) node.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function tabTo(page: Page, target: Locator, limit = 12) {
  for (let index = 0; index < limit && !await target.evaluate(node => node === document.activeElement); index++) await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
}

test("study surface audit measures long-list layout typography scrolling and interaction states", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", route => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/health", route => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  await page.route("**/api/study/topics", route => route.fulfill({ json: [] }));
  await page.route("**/api/study/source-collections", route => route.fulfill({ json: [] }));
  await page.route("**/api/study/reviews?*", route => route.fulfill({ json: [] }));
  await page.route("**/api/study/duplicates", route => route.fulfill({ json: { items: [], nextCursor: null, scanned: 92 } }));
  await page.route("**/api/study/merges", route => route.fulfill({ json: [] }));
  const titles = ["创作者与设计师资源工具合集", "从零散阅读到研究判断：一份需要在窄屏完整阅读的长期观察、证据整理和实践笔记", "A practical guide to evidence-led research, thoughtful software design, and long-term knowledge work"];
  const documents: StudyDocument[] = Array.from({ length: 92 }, (_, index) => ({
    id: `audit-${index}`, title: `${titles[index % titles.length]} · ${index + 1}`,
    kind: index % 7 === 6 ? "paper" : "article", sourceUrl: `https://source.example.test/articles/${index}`,
    revision: 1, deletedAt: null, folderId: null, tags: index % 3 === 0 ? ["设计", "研究方法"] : [], markdown: "Audit fixture content.",
  }));
  await page.route(/\/api\/study\/documents\?/, route => {
    const params = new URL(route.request().url()).searchParams, number = Number(params.get("page") || 1);
    return route.fulfill({ json: { items: documents.slice((number - 1) * 20, number * 20), total: documents.length, page: number } });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "研究", exact: true }).click();
  const workspace = page.getByRole("region", { name: "研究工作台" }), navigation = page.getByRole("navigation", { name: "研究功能" });
  const tabStates: Array<Record<string, unknown>> = [];
  for (const [label, region] of [["专题", null], ["复习", "摘录复习"], ["治理", "资料治理"], ["资料", "研究资料"]] as const) {
    const button = navigation.getByRole("button", { name: label, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-current", "page");
    await expect(navigation.locator('button[aria-current="page"]')).toHaveCount(1);
    if (region) await expect(workspace.getByRole("region", { name: region, exact: true })).toBeVisible();
    else await expect(workspace.getByRole("status")).toHaveText("暂无专题");
    tabStates.push({ tab: label, appearance: await appearance(button) });
    if (label !== "资料") await page.screenshot({ path: testInfo.outputPath(`study-audit-tab-${label}.png`), animations: "disabled" });
  }
  const library = workspace.getByRole("region", { name: "研究资料", exact: true });
  await expect(library.locator(".study-document-list > li")).toHaveCount(20);
  const accessibility = await new AxeBuilder({ page }).include(".study-workspace").analyze();
  const seriousViolations = accessibility.violations.filter(item => item.impact === "serious" || item.impact === "critical").map(item => ({
    id: item.id, impact: item.impact, help: item.help, affectedNodes: item.nodes.length,
    targets: item.nodes.slice(0, 3).map(node => node.target),
  }));
  expect.soft(seriousViolations).toEqual([]);
  const darkAccessibility = [];
  const samples = [];
  for (const variant of [
    { width: 1440, height: 900, dark: false, fontScale: 1 }, { width: 1920, height: 1080, dark: false, fontScale: 1 },
    { width: 390, height: 844, dark: false, fontScale: 1 }, { width: 320, height: 844, dark: false, fontScale: 1 },
    { width: 390, height: 844, dark: false, fontScale: 2 },
    { width: 390, height: 844, dark: true, fontScale: 1 }, { width: 1920, height: 1080, dark: true, fontScale: 1 },
  ]) {
    await page.setViewportSize({ width: variant.width, height: variant.height });
    await page.evaluate(scale => { document.documentElement.style.fontSize = scale === 1 ? "" : "200%"; }, variant.fontScale);
    if (variant.dark && await page.locator("html").getAttribute("data-theme") !== "dark") {
      await page.getByRole("button", { name: "深色外观", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    }
    await resetScroll(page);
    const firstRow = library.locator(".study-document-list > li").first(), activeTab = navigation.getByRole("button", { name: "资料", exact: true });
    const search = library.getByRole("textbox", { name: "搜索资料", exact: true });
    await page.mouse.move(0, 0);
    const fonts = {
      heading: await appearance(workspace.getByRole("heading", { name: "研究", exact: true })), tab: await appearance(activeTab),
      search: await appearance(search), searchLabel: await appearance(library.locator(".study-library-search")),
      title: await appearance(firstRow.locator(".study-document-title")), metadata: await appearance(firstRow.locator(".study-document-heading > small")),
      tagInput: await appearance(firstRow.getByRole("textbox", { name: "主题标签", exact: true })),
      action: await appearance(firstRow.getByRole("button", { name: "检查来源", exact: true })),
    };
    expect.soft(fonts.heading.fontFamily).toContain("sans-serif");
    for (const role of Object.values(fonts)) expect.soft(role.fontFamily).toBe(fonts.heading.fontFamily);
    const atRest = await appearance(activeTab);
    const inactiveRest = await appearance(navigation.getByRole("button", { name: "专题", exact: true }));
    await navigation.getByRole("button", { name: "专题", exact: true }).hover();
    const inactiveHover = await appearance(navigation.getByRole("button", { name: "专题", exact: true }));
    await activeTab.hover();
    const selectedHover = await appearance(activeTab);
    await page.mouse.down();
    const selectedPressed = await appearance(activeTab);
    await page.mouse.move(0, 0); await page.mouse.up();
    await workspace.getByRole("button", { name: "新建专题", exact: true }).focus();
    const keyboardFocus = [];
    for (const label of ["专题", "资料", "复习", "治理"]) {
      await page.keyboard.press("Tab");
      const tab = navigation.getByRole("button", { name: label, exact: true });
      await expect(tab).toBeFocused();
      keyboardFocus.push({ tab: label, appearance: await appearance(tab) });
    }
    await tabTo(page, search);
    await tabTo(page, firstRow.locator(".study-document-title"));
    await tabTo(page, firstRow.getByRole("textbox", { name: "主题标签", exact: true }));
    await tabTo(page, firstRow.getByRole("button", { name: "检查来源", exact: true }));
    const actionKeyboardFocus = await appearance(firstRow.getByRole("button", { name: "检查来源", exact: true }));
    const selectedKeyboardFocus = keyboardFocus.find(item => item.tab === "资料")!.appearance;
    expect.soft(atRest.background).not.toBe(inactiveRest.background);
    expect.soft(atRest.background).not.toBe("rgba(0, 0, 0, 0)");
    expect.soft(atRest.color).not.toBe(inactiveRest.color);
    for (const state of [selectedHover, selectedPressed, selectedKeyboardFocus]) {
      expect.soft(state.background).toBe(atRest.background);
      expect.soft(state.color).toBe(atRest.color);
      expect.soft(state.borderColor).toBe(atRest.borderColor);
      expect.soft(state.borderBottomWidth).toBe(atRest.borderBottomWidth);
    }
    for (const state of [...keyboardFocus.map(item => item.appearance), actionKeyboardFocus]) {
      expect.soft(state.focusVisible).toBe(true);
      expect.soft(parseFloat(state.outline.width)).toBeGreaterThanOrEqual(1);
      expect.soft(state.outline.style).not.toBe("none");
      expect.soft(state.outline.color).not.toBe("rgba(0, 0, 0, 0)");
    }
    const afterKeyboard = await geometry(page);
    expect.soft(afterKeyboard.document.windowScrollY).toBe(0);
    expect.soft(afterKeyboard.document.scrollTop).toBe(0);
    expect.soft(afterKeyboard.document.bodyScrollTop).toBe(0);
    expect.soft(afterKeyboard.host.scrollTop).toBe(0);
    expect.soft(afterKeyboard.workspace.scrollTop).toBe(0);
    await resetScroll(page);
    const before = await geometry(page), key = `${variant.width}-${variant.dark ? "dark" : "light"}${variant.fontScale === 2 ? "-text200" : ""}`;
    for (const gap of Object.values(before.rightGaps)) expect.soft(Math.abs(gap)).toBeLessThanOrEqual(1);
    expect.soft(before.document.scrollWidth).toBeLessThanOrEqual(before.viewport.width);
    expect.soft(before.document.scrollHeight).toBeLessThanOrEqual(before.document.clientHeight + 1);
    expect.soft(before.document.bodyScrollHeight).toBeLessThanOrEqual(before.document.bodyClientHeight + 1);
    expect.soft(before.host.scrollHeight).toBeLessThanOrEqual(before.host.clientHeight + 1);
    expect.soft(before.workspace.scrollHeight).toBeLessThanOrEqual(before.workspace.clientHeight + 1);
    const scrollableAncestors = before.ancestors.filter(element => element.canScrollVertically);
    expect.soft(scrollableAncestors).toHaveLength(1);
    expect.soft(scrollableAncestors[0]?.className.split(" ")).toContain("study-content");
    if (variant.dark && variant.width === 390) {
      const scan = await new AxeBuilder({ page }).include(".study-workspace").analyze();
      const violations = scan.violations.filter(item => item.impact === "serious" || item.impact === "critical").map(item => ({ id: item.id, impact: item.impact, affectedNodes: item.nodes.length }));
      darkAccessibility.push({ variant, violations });
      expect.soft(violations).toEqual([]);
    }
    await page.screenshot({ path: testInfo.outputPath(`study-audit-library-${key}.png`), animations: "disabled" });
    await page.locator(".study-content").hover();
    await page.mouse.wheel(0, 700);
    await expect.poll(async () => (await geometry(page)).ancestors.some(element => element.scrollTop > 0)).toBe(true);
    const after = await geometry(page);
    const scrollingOwners = after.ancestors.filter((element, index) => element.scrollTop !== before.ancestors[index]?.scrollTop);
    expect.soft(scrollingOwners).toHaveLength(1);
    expect.soft(scrollingOwners[0]?.className.split(" ")).toContain("study-content");
    expect.soft(after.host.scrollTop).toBe(0);
    expect.soft(after.workspace.scrollTop).toBe(0);
    expect.soft(after.document.windowScrollY).toBe(0);
    expect.soft(after.document.scrollTop).toBe(0);
    expect.soft(after.document.bodyScrollTop).toBe(0);
    expect.soft(after.header.y).toBeCloseTo(before.header.y, 0);
    expect.soft(after.navigation.y).toBeCloseTo(before.navigation.y, 0);
    samples.push({ variant, fonts, interactionStates: { atRest, inactiveRest, inactiveHover, selectedHover, selectedPressed, keyboardFocus, actionKeyboardFocus },
      before, after, afterKeyboard, scrollingOwners, bodyScrolls: after.document.windowScrollY !== before.document.windowScrollY || after.document.scrollTop !== before.document.scrollTop || after.document.bodyScrollTop !== before.document.bodyScrollTop,
      innerStudyScrolls: scrollingOwners.some(element => /study-content|study-workspace|study-host/u.test(element.className)) });
    if (variant.width === 1920 && !variant.dark || variant.width === 390 && !variant.dark) await page.screenshot({ path: testInfo.outputPath(`study-audit-scrolled-${key}.png`), animations: "disabled" });
  }
  const result = { samples, tabStates, accessibility: { violations: accessibility.violations.map(item => ({ id: item.id, impact: item.impact, affectedNodes: item.nodes.length })), seriousViolations, darkAccessibility } };
  const output = testInfo.outputPath("study-surface-audit.json");
  await writeFile(output, JSON.stringify(result, null, 2));
  await testInfo.attach("study-surface-audit", { path: output, contentType: "application/json" });
  console.log("STUDY_SURFACE_AUDIT", JSON.stringify({ output, seriousViolations, samples: samples.map(item => ({
    variant: item.variant, rightGaps: item.before.rightGaps, scrollingOwners: item.scrollingOwners,
    bodyScrolls: item.bodyScrolls, innerStudyScrolls: item.innerStudyScrolls,
  })) }));
});
