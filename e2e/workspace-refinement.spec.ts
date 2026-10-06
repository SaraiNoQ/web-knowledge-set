import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
});

test("category tabs replace duplicate rail entries and collapsed directory leaves no strip", async ({ page }) => {
  await page.goto("/");
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  const documents = rail.getByRole("button", { name: "文档资料库", exact: true });
  await expect(documents).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".library-tabs")).toHaveCount(0);
  const toggleWidth = await page.locator(".sidebar-category-toggle").evaluate((el) => el.getBoundingClientRect().width / (el.parentElement!.clientWidth - parseFloat(getComputedStyle(el.parentElement!).paddingLeft) - parseFloat(getComputedStyle(el.parentElement!).paddingRight)));
  expect(toggleWidth).toBeCloseTo(.75, 2);
  const categories = page.getByRole("navigation", { name: "目录分类" });
  for (const name of ["查看收藏", "查看回收站", "查看论文"]) {
    await expect(rail.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  for (const name of ["列表", "收藏", "论文", "回收站", "搜索"]) {
    const entry = categories.getByRole("button", { name, exact: true });
    await expect(entry.locator("svg")).toHaveCount(1);
    await expect(entry).toHaveAttribute("title", name);
    await expect(entry).toHaveText("");
    await entry.click();
    await expect(entry).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("navigation", { name: "目录分类" }).getByRole("button", { name: "列表", exact: true }).click();
  await expect(documents).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "文档资料库", exact: true }).click();
  await expect(page.locator(".library-panel")).toBeHidden();
  await expect(documents).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "展开知识织片", exact: true })).toHaveCount(0);
  const reader = await page.locator(".reader-panel").boundingBox();
  const railBounds = await rail.boundingBox();
  expect(reader!.x - railBounds!.x - railBounds!.width).toBeLessThanOrEqual(2);
  await documents.click();
  await expect(page.locator(".library-panel")).toBeVisible();
  await expect(documents).toHaveAttribute("aria-pressed", "true");
});

test("compact reader exposes safe title editing from breadcrumb and directory", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "快捷搜索与新建文章", exact: true }).click();
  await page.getByRole("dialog", { name: "快捷搜索与新建", exact: true }).getByRole("option", { name: /新建空白文章/ }).click();
  const title = page.getByRole("button", { name: "重命名文章", exact: true });
  await expect(title).toHaveText("未命名文章");
  await expect(page.locator(".document-head h2")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(显示|隐藏)文档侧栏$/ })).toHaveCount(0);
  const kicker = await page.locator(".document-kicker").boundingBox();
  const actions = await page.locator(".document-actions").boundingBox();
  expect(Math.abs(kicker!.y + kicker!.height / 2 - actions!.y - actions!.height / 2)).toBeLessThanOrEqual(2);
  await title.dblclick();
  const input = page.getByRole("textbox", { name: "文章标题", exact: true });
  await input.fill("取消后不应保存");
  await input.press("Escape");
  await expect(title).toHaveText("未命名文章");
  await title.dblclick();
  await input.fill("面包屑改名测试");
  await input.press("Enter");
  await expect(title).toHaveText("面包屑改名测试");
  const tabs = page.getByRole("navigation", { name: "已打开的文章" });
  await expect(tabs.getByRole("button", { name: "面包屑改名测试", exact: true })).toBeVisible();
  const row = page.locator(".directory-document-row.is-selected");
  await row.getByRole("button", { name: "更多操作：面包屑改名测试" }).click();
  await page.getByRole("dialog", { name: "操作：面包屑改名测试" }).getByRole("button", { name: "重命名", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "重命名文章", exact: true });
  await rename.getByLabel("文章标题", { exact: true }).fill("目录改名测试");
  await rename.getByRole("button", { name: "保存", exact: true }).click();
  await expect(title).toHaveText("目录改名测试");
  await expect(tabs.getByRole("button", { name: "目录改名测试", exact: true })).toBeVisible();
  await page.reload();
  await page.locator(".directory-document-row").getByRole("button", { name: "目录改名测试", exact: true }).click();
  await expect(title).toHaveText("目录改名测试");
});


test("immersive control stays in the rail and removes the old top bar", async ({ page }) => {
  await page.goto("/");
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  await rail.getByRole("button", { name: "进入沉浸模式", exact: true }).click();
  await expect(page.locator(".immersive-bar")).toHaveCount(0);
  await expect(page.locator(".masthead")).toBeHidden();
  const exit = rail.getByRole("button", { name: "退出沉浸模式", exact: true });
  await expect(exit).toBeFocused();
  const exitBounds = await exit.boundingBox();
  const settingsBounds = await rail.getByRole("button", { name: "打开设置", exact: true }).boundingBox();
  expect(exitBounds!.y + exitBounds!.height).toBeLessThanOrEqual(settingsBounds!.y);
  expect((await page.locator(".workspace").boundingBox())!.y).toBe(0);
  await exit.click();
  await expect(page.locator(".masthead")).toHaveCount(0);
});

for (const cloud of [false, true]) {
  test(`theme toggles persist without losing editor content in ${cloud ? "cloud" : "local"} mode`, async ({ page }) => {
    if (!cloud) await page.unroute("**/health");
    await page.goto("/");
    const rail = page.getByRole("navigation", { name: "工作台导航" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const initialBackground = await page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "快捷搜索与新建文章", exact: true }).click();
  await page.getByRole("dialog", { name: "快捷搜索与新建", exact: true }).getByRole("option", { name: /新建空白文章/ }).click();
    if (cloud) await page.getByRole("button", { name: "编辑这篇知识", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Markdown 编辑器" });
    await editor.fill("主题切换保留未保存正文。");
    await rail.getByRole("button", { name: "切换到深色模式", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(editor).toHaveText("主题切换保留未保存正文。");
    await expect.poll(() => page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(initialBackground);
    const colors = await editor.evaluate((element) => {
      const text = getComputedStyle(element).color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const background = getComputedStyle(element.closest(".cm-editor")!).backgroundColor.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const luminance = (rgb: number[]) => rgb.map((value) => value / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const a = luminance(text), b = luminance(background);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    });
    expect(colors).toBeGreaterThanOrEqual(4.5);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已保存", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await rail.getByRole("button", { name: "切换到浅色模式", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
}

test("breadcrumb uses a capped content width and keeps the complete saved title", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".panel-heading h2")).toHaveText("目录");
  await expect(page.locator(".library-toggle")).toHaveCount(0);
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "快捷搜索与新建文章", exact: true }).click();
  await page.getByRole("dialog", { name: "快捷搜索与新建", exact: true }).getByRole("option", { name: /新建空白文章/ }).click();
  const title = page.getByRole("button", { name: "重命名文章", exact: true });
  await title.dblclick();
  const input = page.getByRole("textbox", { name: "文章标题", exact: true });
  await input.fill("短标题");
  expect((await input.boundingBox())!.width).toBeLessThan(150);
  const longTitle = "一二三四五六七八九十一二三四五六七八九十超出部分";
  await input.fill(longTitle);
  expect((await input.boundingBox())!.width).toBeLessThan(400);
  await input.press("Enter");
  await expect(title).toHaveText(Array.from(longTitle).slice(0, 20).join("") + "…");
  await expect(title).toHaveAttribute("title", longTitle);
  await title.dblclick();
  await expect(input).toHaveValue(longTitle);
  await input.press("Escape");
});

test("editor fills the remaining viewport and can reveal the complete last line", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "快捷搜索与新建文章", exact: true }).click();
  await page.getByRole("dialog", { name: "快捷搜索与新建", exact: true }).getByRole("option", { name: /新建空白文章/ }).click();
  await page.getByRole("button", { name: "编辑这篇知识", exact: true }).click();
  await expect(page.locator(".document-head .title-field")).toHaveCount(0);
  const editor = page.getByRole("textbox", { name: "Markdown 编辑器" });
  await editor.fill(Array.from({ length: 100 }, (_, index) => `段落 ${index}：正文回归。`).join("\n\n") + "\n\n最后一行完整可见");
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  await page.getByRole("button", { name: "返回资料库", exact: true }).click();
  await expect.poll(() => page.locator(".editor-grid").evaluate((element) => Math.abs(element.getBoundingClientRect().bottom - innerHeight))).toBeLessThanOrEqual(2);
  for (const immersive of [false, true]) {
    if (immersive) await page.getByRole("button", { name: "进入沉浸模式", exact: true }).click();
    for (const width of [1440, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      for (let collapsed = 0; collapsed < 2; collapsed += 1) {
        if (collapsed) await page.getByRole("button", { name: "文档资料库", exact: true }).click();
        await expect.poll(() => page.locator(".editor-grid").evaluate((element) => Math.abs(element.getBoundingClientRect().bottom - innerHeight))).toBeLessThanOrEqual(2);
        // Width changes reflow CodeMirror and the preview asynchronously. Scroll
        // their final layout, then require the complete last line in both panes.
        await expect.poll(async () => {
          await page.locator(".cm-scroller").evaluate((element) => { element.scrollTop = element.scrollHeight; });
          await page.locator(".preview-pane").evaluate((element) => { element.scrollTop = element.scrollHeight; });
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          const overflow: number[] = [];
          for (const [container, last] of [[".editor-pane", ".cm-line:last-child"], [".preview-pane", ".markdown-preview > :last-child"]]) {
            const line = page.locator(last);
            if ((await line.textContent())?.trim() !== "最后一行完整可见") return Number.POSITIVE_INFINITY;
            const bounds = await line.boundingBox();
            const pane = await page.locator(container).boundingBox();
            if (!bounds || !pane) return Number.POSITIVE_INFINITY;
            overflow.push(bounds.y + bounds.height - pane.y - pane.height, pane.y - bounds.y);
          }
          return Math.max(...overflow);
        }).toBeLessThanOrEqual(1);
        await expect(page.locator(".cm-line").filter({ hasText: "最后一行完整可见" })).toBeVisible();
        if (collapsed) await page.getByRole("button", { name: "文档资料库", exact: true }).click();
      }
    }
  }
});
