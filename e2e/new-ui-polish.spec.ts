import { expect, test } from "@playwright/test";

const titles = ["从阅读到实践：构建自己的知识工作流", "关于复杂系统的长期观察与一份需要认真保存的研究笔记", "A practical guide to thoughtful software design", "用更少的步骤，完成更好的工作", "一次小规模研究", "没有图片也可以成为一本好书"];
const cards = titles.map((title, i) => ({ documentId: `polish-${i}`, title, folderId: `folder-${i % 3}`, folderName: ["研究与方法", "产品和设计", "工程实践"][i % 3], createdAt: "2026-10-20T00:00:00Z", featured: true, position: i, coverHash: i === 3 ? "a".repeat(64) : null, color: ["sage", "rust", "sky", "paper", "ochre", "sage"][i], shortTitle: "", fit: "contain" }));

test("new reading UI keeps covers, keyboard tabs and editor usable across sizes", async ({ page }) => {
  let state: "ready" | "empty" | "error" = "ready";
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/settings/onboarding", route => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/api/home/covers/**", route => route.fulfill({ status: 404, body: "missing" }));
  await page.route(/\/api\/home(?:\?|$)/, route => {
    const url = new URL(route.request().url()), folder = url.searchParams.get("folder");
    if (state === "error") return route.fulfill({ status: 503, json: { error: { code: "HOME_ERROR" } } });
    if (state === "empty") return route.fulfill({ json: { revision: 1, items: [], total: 0, libraryTotal: 0, page: 1, folders: [] } });
    const items = folder ? cards.filter(c => c.folderId === folder) : cards;
    return route.fulfill({ json: { revision: 1, items, total: items.length, libraryTotal: 6, page: 1, folders: ["研究与方法", "产品和设计", "工程实践"].map((name,i)=>({id:`folder-${i}`,name})) } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const shelf = page.getByRole("region", { name: "首页书架", exact: true });
  await expect(shelf.locator(".home-book")).toHaveCount(6);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(shelf).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/new-ui-home-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("tab", { name: "全部", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "研究与方法", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "布置首页", exact: true }).click();
  const editor = page.getByRole("region", { name: "首页布置", exact: true });
  await editor.locator(".home-article-select").first().click();
  await editor.getByRole("button", { name: /^已选文章/ }).click();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (await page.locator("#reader-panel").evaluate(element => element.clientWidth) <= 640) {
      const list = await editor.locator(".home-catalog").boundingBox();
      const preview = await editor.locator(".home-cover-editor").boundingBox();
      expect(preview!.y).toBeGreaterThanOrEqual(list!.y + list!.height);
      expect((await editor.getByRole("button", { name: `下移：${titles[0]}`, exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: `/tmp/new-ui-editor-${width}.png`, fullPage: true });
  }
  await page.getByRole("button", { name: "深色外观", exact: true }).click();
  const editorInk = await editor.evaluate(element => getComputedStyle(element).color);
  await expect(editor.locator(".home-article-select").first()).toHaveCSS("color", editorInk);
  await page.screenshot({ path: "/tmp/new-ui-editor-dark.png", fullPage: true, animations: "disabled" });
  await editor.locator(".home-cover-preview").scrollIntoViewIfNeeded();
  await expect(editor.getByRole("button", { name: "保存布置", exact: true })).toBeInViewport();
  state = "error"; await page.reload();
  await expect(page.getByRole("alert")).toContainText("书架暂时没有打开");
  state = "ready"; await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(shelf.locator(".home-book")).toHaveCount(6);
  await expect(shelf.locator(".home-book").nth(3).locator(".article-cover-title")).toHaveText(titles[3]!);
  state = "empty"; await page.reload();
  await expect(shelf.getByRole("button", { name: "导入文章", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
