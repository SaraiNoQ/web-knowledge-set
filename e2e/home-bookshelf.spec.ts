import { expect, test } from "@playwright/test";

test("home bookshelf saves selected articles, image and text covers, folder tabs and navigation", async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", route => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/api/settings/llm", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), enabled: false } });
  });

  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"]! };
  const prefix = `书架回归${Date.now()}`;
  const folder = await (await request.post("/api/folders", { headers, data: { name: `${prefix}·研究` } })).json();
  const hiddenFolder = await (await request.post("/api/folders", { headers, data: { name: `${prefix}·未精选` } })).json();
  const articles: Array<{ id: string; title: string; markdown: string }> = [];
  for (const [index, suffix] of ["文字封面", "图片封面", "不展示文章"].entries()) {
    const title = `${prefix}·${suffix}`;
    const response = await request.post("/api/documents", { headers, data: { title } });
    expect(response.ok()).toBe(true);
    const { document } = await response.json();
    const markdown = `# ${suffix}\n\n这是书架的原始正文，设置封面时不会改动。`;
    const updated = await request.patch(`/api/documents/${document.id}`, { headers, data: { revision: document.revision, markdown, folderId: index === 2 ? hiddenFolder.id : folder.id } });
    expect(updated.ok()).toBe(true);
    articles.push({ id: document.id, title, markdown });
  }
  const [textArticle, imageArticle, hiddenArticle] = articles as [typeof articles[number], typeof articles[number], typeof articles[number]];

  await page.goto("/");
  const shelf = page.getByRole("region", { name: "首页书架", exact: true });
  await expect(shelf).toBeVisible();
  await shelf.getByRole("button", { name: "布置首页", exact: true }).click();
  const editor = page.getByRole("region", { name: "首页布置", exact: true });
  await editor.getByRole("textbox", { name: "搜索首页候选文章" }).fill(prefix);
  await editor.getByRole("checkbox", { name: `在首页展示：${textArticle.title}`, exact: true }).check();
  await editor.getByRole("textbox", { name: "封面短标题", exact: true }).fill("值得重读的研究");
  await editor.getByRole("button", { name: "苔绿", exact: true }).click();
  await expect(editor.locator(".home-cover-preview .article-cover-title")).toHaveText("值得重读的研究");
  await editor.getByRole("checkbox", { name: `在首页展示：${imageArticle.title}`, exact: true }).check();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGN4dmnVfwAIZgNiqZBFKAAAAABJRU5ErkJggg==", "base64");
  await editor.locator('input[type="file"][aria-label="上传文章封面"]').setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: png });
  const previewImage = editor.getByRole("img", { name: `${imageArticle.title}的封面预览`, exact: true });
  await expect(previewImage).toBeVisible();
  await expect.poll(() => previewImage.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await editor.getByRole("button", { name: /^已选文章/ }).click();
  await editor.getByRole("button", { name: `上移：${imageArticle.title}`, exact: true }).click();
  await page.screenshot({ path: "/tmp/zhiye-home-editor.png", fullPage: true });
  await editor.getByRole("button", { name: "保存布置", exact: true }).click();

  await expect(shelf).toBeVisible();
  await expect(shelf.locator(".home-book-name")).toHaveText([imageArticle.title, textArticle.title]);
  await expect(shelf.getByRole("button", { name: `阅读：${hiddenArticle.title}`, exact: true })).toHaveCount(0);
  await expect(shelf.getByRole("tab", { name: hiddenFolder.name, exact: true })).toHaveCount(0);
  await expect(shelf.getByRole("tab", { name: folder.name, exact: true })).toBeVisible();
  await expect(shelf.getByRole("button", { name: `阅读：${textArticle.title}`, exact: true }).locator(".article-cover-title")).toHaveText("值得重读的研究");
  await expect(shelf.getByRole("button", { name: `阅读：${imageArticle.title}`, exact: true }).locator("img")).toHaveAttribute("src", /\/api\/home\/covers\/[a-f0-9]{64}$/);
  await shelf.getByRole("tab", { name: folder.name, exact: true }).click();
  await shelf.getByRole("button", { name: `阅读：${textArticle.title}`, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "文档标题", exact: true })).toHaveValue(textArticle.title);
  await page.getByRole("button", { name: "返回首页", exact: true }).click();
  await expect(shelf.getByRole("tab", { name: folder.name, exact: true })).toHaveAttribute("aria-selected", "true");

  await shelf.getByRole("button", { name: "布置首页", exact: true }).click();
  await editor.getByRole("textbox", { name: "搜索首页候选文章" }).fill(textArticle.title);
  const textRow = editor.locator(".home-article-list li").filter({ has: page.getByRole("checkbox", { name: `在首页展示：${textArticle.title}`, exact: true }) });
  await textRow.locator(".home-article-select").click();
  await editor.getByRole("textbox", { name: "封面短标题", exact: true }).fill("未保存的新书封");
  await editor.getByRole("button", { name: "返回首页", exact: true }).click();
  await expect(page.getByText("首页布置尚未保存，确定放弃修改吗？", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(shelf.getByRole("button", { name: `阅读：${textArticle.title}`, exact: true }).locator(".article-cover-title")).toHaveText("值得重读的研究");
  for (const article of articles) {
    const saved = await (await request.get(`/api/documents/${article.id}`)).json();
    expect(saved.document?.markdown ?? saved.markdown).toBe(article.markdown);
  }

  await shelf.getByRole("tab", { name: "全部", exact: true }).click();
  await page.screenshot({ path: "/tmp/zhiye-home-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(shelf.getByRole("button", { name: `阅读：${textArticle.title}`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/zhiye-home-mobile.png", fullPage: true });
  expect(pageErrors).toEqual([]);
});
