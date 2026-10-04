import { expect, test } from "@playwright/test";

for (const cloud of [false, true]) {
  test(`document tabs switch, close and protect edits in ${cloud ? "web" : "local"} mode`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
    await page.route("**/api/settings/appearance", (route) => route.fulfill({ json: { immersiveMode: route.request().method() === "GET" ? false : route.request().postDataJSON().immersiveMode } }));
    if (cloud) await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
    await page.goto("/");
    const create = page.getByRole("button", { name: "新建文章标签", exact: true });
    await create.click();
    if (cloud) await page.getByRole("button", { name: "编辑这篇知识" }).click();
    await page.getByLabel("文档标题").fill("第一篇工作笔记");
    await page.getByRole("textbox", { name: "Markdown 编辑器" }).fill("第一篇已保存正文。");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已保存", { exact: true })).toBeVisible();
    await create.click();
    const tabs = page.getByRole("navigation", { name: "已打开的文章" });
    await expect(tabs.locator(".document-tab-select")).toHaveCount(2);
    if (cloud) await page.getByRole("button", { name: "编辑这篇知识" }).click();
    await page.getByLabel("文档标题").fill("第二篇工作笔记");
    await page.getByRole("textbox", { name: "Markdown 编辑器" }).fill("第二篇已保存正文。");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(tabs.getByRole("button", { name: "第二篇工作笔记", exact: true })).toBeVisible();
    await tabs.getByRole("button", { name: "第一篇工作笔记", exact: true }).click();
    await expect(tabs.getByRole("button", { name: "第一篇工作笔记", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(tabs.locator(".document-tab-select")).toHaveCount(2);
    await tabs.getByRole("button", { name: "第一篇工作笔记", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.getByRole("button", { name: "第二篇工作笔记", exact: true })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(tabs.getByRole("button", { name: "第一篇工作笔记", exact: true })).toBeFocused();
    if (!cloud) {
      await page.getByLabel("作者", { exact: true }).fill("尚未保存的作者");
      await tabs.getByRole("button", { name: "第二篇工作笔记", exact: true }).click();
      const metadataDialog = page.getByRole("alertdialog", { name: "存在未保存修改" });
      await metadataDialog.getByRole("button", { name: "取消" }).click();
      await expect(page.getByLabel("作者", { exact: true })).toHaveValue("尚未保存的作者");
      await page.getByLabel("作者", { exact: true }).fill("");
    }
    if (cloud) await page.getByRole("button", { name: "编辑这篇知识" }).click();
    await page.getByRole("textbox", { name: "Markdown 编辑器" }).fill("尚未保存的内容。");
    await page.getByRole("button", { name: "关闭文章：第一篇工作笔记" }).click();
    const dialog = page.getByRole("alertdialog", { name: "存在未保存修改" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(tabs.locator(".document-tab-select")).toHaveCount(2);
    await expect(page.getByRole("textbox", { name: "Markdown 编辑器" })).toHaveText("尚未保存的内容。");
    await page.setViewportSize({ width: 1440, height: 600 });
    for (const immersive of [false, true]) {
      if (immersive) await page.getByRole("button", { name: "进入沉浸模式", exact: true }).click();
      await page.locator(".editor-toolbar").evaluate((element) => element.scrollIntoView({ block: "start" }));
      const toolbar = await page.locator(".editor-toolbar").boundingBox();
      const bar = await page.locator(".document-tabbar").boundingBox();
      expect(toolbar!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height);
      await expect(page.getByRole("button", { name: "保存", exact: true })).toBeVisible();
      if (immersive) await page.getByRole("button", { name: "退出沉浸模式", exact: true }).click();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    while (await page.getByRole("button", { name: "关闭通知", exact: true }).count()) await page.getByRole("button", { name: "关闭通知", exact: true }).first().click();
    await page.screenshot({ path: info.outputPath(`workspace-${cloud ? "web" : "local"}.png`) });
    await page.getByRole("button", { name: "关闭文章：第二篇工作笔记" }).click();
    await expect(tabs.locator(".document-tab-select")).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "Markdown 编辑器" })).toHaveText("尚未保存的内容。");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已保存", { exact: true })).toBeVisible();
    await create.click();
    await page.getByRole("button", { name: "关闭文章：未命名文章" }).click();
    await expect(tabs.getByRole("button", { name: "第一篇工作笔记", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "返回文档目录", exact: true }).click();
    await expect(tabs.locator(".document-tab-select")).toHaveCount(1);
    await tabs.getByRole("button", { name: "第一篇工作笔记", exact: true }).click();
    await expect(tabs.getByRole("button", { name: "第一篇工作笔记", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    while (await page.getByRole("button", { name: "关闭通知", exact: true }).count()) await page.getByRole("button", { name: "关闭通知", exact: true }).first().click();
    await page.screenshot({ path: info.outputPath(`workspace-mobile-${cloud ? "web" : "local"}.png`) });
    await page.getByRole("button", { name: "关闭文章：第一篇工作笔记" }).click();
    await expect(page.getByRole("complementary", { name: "知识列表" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "工作台导航" })).toBeVisible();
  });
}

test("long folder breadcrumbs fit small screens and the rail scrolls on landscape", async ({ page, request }) => {
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/api/settings/appearance", (route) => route.fulfill({ json: { immersiveMode: route.request().method() === "GET" ? false : route.request().postDataJSON().immersiveMode } }));
  const list = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": list.headers()["x-zhiye-data-epoch"] };
  const folderName = "这是用于检验小屏幕位置栏截断的长文件夹名称".repeat(3);
  const created = await request.post("/api/folders", { headers, data: { name: folderName } });
  expect(created.ok()).toBe(true);
  const folder = await created.json();
  await page.goto("/");
  await page.getByRole("button", { name: "新建文章标签", exact: true }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("未命名文章");
  const row = page.locator(".directory-document-row.is-selected");
  await row.getByRole("button", { name: /^更多操作/ }).click();
  await page.getByRole("dialog", { name: /^操作/ }).getByRole("button", { name: "移动到文件夹…" }).click();
  const move = page.getByRole("dialog", { name: "移动到文件夹" });
  await move.getByRole("combobox").click();
  await page.getByRole("option", { name: folderName, exact: true }).click();
  await move.getByRole("button", { name: "移动", exact: true }).click();
  await expect(page.locator(".workspace-location > span")).toHaveText(folderName);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 844, height: 390 });
  const rail = page.getByRole("navigation", { name: "工作台导航" });
  await expect.poll(() => rail.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await rail.getByRole("button", { name: "配置 AI", exact: true }).scrollIntoViewIfNeeded();
  const button = await rail.getByRole("button", { name: "配置 AI", exact: true }).boundingBox();
  expect(button!.y).toBeGreaterThanOrEqual(0);
  expect(button!.y + button!.height).toBeLessThanOrEqual(390);
  await request.delete(`/api/folders/${folder.id}`, { headers });
});
