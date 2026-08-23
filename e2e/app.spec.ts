import { expect, test, type Page, type Request } from "@playwright/test";
import { readFile } from "node:fs/promises";

const readyImageUrl = "https://assets.example.test/ready.png";
const failedImageUrl = "https://assets.example.test/failed.png";

async function chooseUiOption(page: Page, name: string, option: string) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("extension content script preserves ChatGPT rendered math in Chromium", async ({ page }) => {
  await page.route("https://chatgpt.com/**", (route) => route.fulfill({ headers: { "Content-Type": "text/html; charset=utf-8" }, body: `<!doctype html><html><head><title>世界模型入门</title></head><body><main><article><div class="markdown prose">
    <h1>世界模型与具身智能</h1>
    <p>这是一个足够长的测试回答，用于验证浏览器扩展会选择完整正文而不是导航或页面装饰。策略接收观察并产生动作，环境再返回下一时刻的观察，从而形成持续交互的闭环。下面的公式必须作为可编辑 TeX 保留下来。</p>
    <div contenteditable="false"><button type="button" aria-label="复制公式"><span class="katex-display"><span class="katex"><span class="katex-mathml"><math display="block"><semantics><mrow><mi>o</mi></mrow><annotation encoding="application/x-tex">观察 o_t \\to 策略 \\pi \\to 动作 a_t \\to 环境 \\to o_{t+1}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">视觉公式不得重复</span></span></span></button></div>
    <button type="button"><span contenteditable="false"><span class="katex-display"><span class="katex"><span class="katex-mathml"><math display="block"><semantics><annotation encoding="application/x-tex">Q(s, a) = r + \\gamma V(s')</annotation></semantics></math></span></span></span></span></button>
    <div contenteditable="false"><button type="button" aria-label="复制公式"><span class="katex-display"><span class="katex"><span class="katex-mathml"><math display="block" data-latex="P_c = \\frac{\\sum_k N_{k,c}p_{k,c}}{\\sum_k N_{k,c}}"><mrow><mi>P</mi></mrow></math></span><span class="katex-html" aria-hidden="true">当前 ChatGPT 视觉公式不得重复</span></span></span></button></div>
    <form class="katex" data-latex="FORM_SECRET"></form>
    <span class="katex" contenteditable="true" data-latex="EDITABLE_SECRET"></span>
    <p>后续段落继续解释模仿学习、强化学习与世界模型的区别，确保公式位于正文中间且前后内容都能被正常提取。</p>
  </div></article></main></body></html>` }));
  await page.goto("https://chatgpt.com/c/zhiye-math-fixture");
  await page.addScriptTag({ content: await readFile("dist/extensions/zhiye-clipper-chrome/content.js", "utf8") });
  const markdown = await page.evaluate(async () => (await (window as typeof window & { __ZHIYE_CLIP_RESULT__: Promise<{ markdown: string }> }).__ZHIYE_CLIP_RESULT__).markdown);
  const first = "观察 o_t \\to 策略 \\pi \\to 动作 a_t \\to 环境 \\to o_{t+1}";
  const second = "Q(s, a) = r + \\gamma V(s')";
  const third = "P_c = \\frac{\\sum_k N_{k,c}p_{k,c}}{\\sum_k N_{k,c}}";
  expect(markdown.split(first)).toHaveLength(2);
  expect(markdown.split(second)).toHaveLength(2);
  expect(markdown.split(third)).toHaveLength(2);
  expect(markdown.indexOf(first)).toBeLessThan(markdown.indexOf(second));
  expect(markdown.indexOf(second)).toBeLessThan(markdown.indexOf(third));
  expect(markdown).not.toContain("FORM_SECRET");
  expect(markdown).not.toContain("EDITABLE_SECRET");
  expect(markdown).not.toContain("视觉公式不得重复");
  expect(markdown).not.toContain("当前 ChatGPT 视觉公式不得重复");
});

test("refreshes the directory when the browser extension announces a saved clip", async ({ page }) => {
  await page.goto("/");
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  await deferSetup.or(page.getByLabel("网页地址")).first().waitFor();
  if (await deferSetup.isVisible()) await deferSetup.click();
  await expect(page.getByText("暂无未归入文件夹的知识。")).toBeVisible();
  const folderName = `即时刷新-${Date.now()}`;
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("dialog", { name: "新建" }).getByRole("button", { name: "创建文件夹" }).click();
  await page.getByRole("dialog", { name: "新建文件夹" }).getByLabel("文件夹名称").fill(folderName);
  await page.getByRole("dialog", { name: "新建文件夹" }).getByRole("button", { name: "创建", exact: true }).click();
  const folder = page.locator(".folder-node").filter({ hasText: folderName });
  await expect(folder).toBeVisible();
  await folder.locator(":scope > button").click();
  await expect(page.getByText("这个文件夹是空的。")).toBeVisible();
  const foldersRefresh = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === "/api/folders");
  const rootRefresh = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === "/api/documents" && new URL(request.url()).searchParams.get("unfiled") === "true");
  const folderRefresh = page.waitForRequest((request) => request.method() === "GET" && new URL(request.url()).pathname === "/api/documents" && new URL(request.url()).searchParams.has("folderId"));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("zhiye:extension-saved", { detail: "extension-document-id" })));
  await Promise.all([foldersRefresh, rootRefresh, folderRefresh]);
  await expect(page.getByRole("status").filter({ hasText: "浏览器扩展已保存新知识，目录已刷新。" })).toBeVisible();
});

test("keeps the first-run guide deferrable, reopenable, readable, and durable", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /你的知识/u })).toBeVisible();
  await page.getByRole("button", { name: "稍后设置" }).click();
  await expect(page.getByLabel("网页地址")).toBeVisible();
  await expect.poll(() => page.locator(".capture-copy p").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);

  await page.getByRole("button", { name: "使用指南" }).click();
  const guide = page.getByRole("dialog", { name: /你的知识/u });
  await expect(guide).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(guide).toBeHidden();

  await page.getByRole("button", { name: "使用指南" }).click();
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByRole("heading", { name: /稳定的位置/u })).toBeVisible();
  await expect(page.getByText("KB_DATA_DIR=/你的/知识库目录 pnpm start")).toBeVisible();
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByRole("heading", { name: /从一个链接/u })).toBeVisible();
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByRole("heading", { name: /找到它/u })).toBeVisible();
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByRole("heading", { name: /正文归你/u })).toBeVisible();
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByRole("heading", { name: /先留返回键/u })).toBeVisible();
  await page.getByRole("button", { name: "进入资料库" }).click();
  await expect(page.getByLabel("网页地址")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("网页地址")).toBeVisible();
  await expect(page.getByRole("heading", { name: /你的知识/u })).toBeHidden();
  await expect(page.getByRole("button", { name: "使用指南" })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText("系统报告当前离线", { exact: false })).toBeVisible();
  await expect(page.getByLabel("网页地址")).toBeEnabled();
  await context.setOffline(false);
});

test("keeps the primary workspace keyboard and screen-reader reachable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  if (await deferSetup.isVisible()) await deferSetup.click();
  await expect(page.getByLabel("网页地址")).toBeVisible();
  const issues = await page.evaluate(() => {
    const visible = (element: Element) => element.getClientRects().length > 0;
    const named = (element: Element) => Boolean(
      element.getAttribute("aria-label") ||
      element.getAttribute("aria-labelledby") ||
      element.getAttribute("title") ||
      element.textContent?.trim(),
    );
    const ids = [...document.querySelectorAll<HTMLElement>("[id]")].map(({ id }) => id);
    return [
      ...(document.querySelectorAll("main").length === 1 ? [] : ["页面必须有且只有一个 main"]),
      ...(document.querySelectorAll("h1").length === 1 ? [] : ["页面必须有且只有一个 h1"]),
      ...[...document.querySelectorAll("button, a[href]")].filter(visible).filter((element) => !named(element)).map(() => "可操作元素缺少名称"),
      ...[...document.querySelectorAll("img")].filter(visible).filter((element) => !element.hasAttribute("alt")).map(() => "图片缺少 alt"),
      ...[...document.querySelectorAll<HTMLElement>("[tabindex]")].filter((element) => element.tabIndex > 0).map(() => "禁止正数 tabindex"),
      ...(new Set(ids).size === ids.length ? [] : ["页面存在重复 id"]),
    ];
  });
  expect(issues).toEqual([]);
  const scrollbar = await page.evaluate(() => {
    const probe = document.createElement("div");
    const content = document.createElement("div");
    Object.assign(probe.style, { width: "48px", height: "48px", overflow: "scroll" });
    Object.assign(content.style, { width: "160px", height: "160px" });
    probe.append(content);
    document.body.append(probe);
    probe.scrollTo(32, 32);
    const result = {
      thumb: getComputedStyle(probe, "::-webkit-scrollbar-thumb").backgroundColor,
      width: getComputedStyle(probe, "::-webkit-scrollbar").width,
      scrollLeft: probe.scrollLeft,
      scrollTop: probe.scrollTop,
    };
    probe.remove();
    return result;
  });
  expect(scrollbar.thumb).toBe("rgb(189, 65, 44)");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement, "::-webkit-scrollbar-track").backgroundColor)).toBe("rgba(189, 65, 44, 0.08)");
  expect(scrollbar.width).toBe("11px");
  expect(scrollbar.scrollLeft).toBeGreaterThan(0);
  expect(scrollbar.scrollTop).toBeGreaterThan(0);
  await page.emulateMedia({ forcedColors: "active" });
  const forcedScrollbar = await page.evaluate(() => {
    const probe = document.createElement("div");
    Object.assign(probe.style, { width: "48px", height: "48px", overflow: "scroll" });
    probe.append(document.createElement("div"));
    document.body.append(probe);
    const result = {
      colors: getComputedStyle(probe).scrollbarColor,
      thumb: getComputedStyle(probe, "::-webkit-scrollbar-thumb").backgroundColor,
      track: getComputedStyle(probe, "::-webkit-scrollbar-track").backgroundColor,
    };
    probe.remove();
    return result;
  });
  expect(forcedScrollbar.colors).toBe("auto");
  expect(forcedScrollbar.thumb).not.toBe("rgb(189, 65, 44)");
  expect(forcedScrollbar.track).not.toBe("rgba(0, 0, 0, 0)");
  await page.emulateMedia({ forcedColors: "none" });
  await page.getByLabel("网页地址").focus();
  await expect(page.getByLabel("网页地址")).toBeFocused();
});

test("returns home from the logo and toggles the knowledge sidebar", async ({ page }) => {
  await page.goto("/");
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  await expect(deferSetup.or(page.getByLabel("网页地址"))).toBeVisible();
  if (await deferSetup.isVisible()) await deferSetup.click();

  const collapse = page.getByRole("button", { name: "收起知识织片" });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await collapse.click();
  await expect(page.locator(".workspace")).toHaveClass(/library-collapsed/u);
  await expect.poll(() => page.locator(".library-panel").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const expand = page.getByRole("button", { name: "展开知识织片" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.getByRole("navigation", { name: "资料库视图" })).toBeVisible();
  await expect.poll(() => page.locator(".library-tabs").evaluate((element) => getComputedStyle(element).display)).toBe("grid");
  await page.setViewportSize({ width: 1280, height: 900 });
  await expand.click();
  await expect(page.locator(".workspace")).not.toHaveClass(/library-collapsed/u);

  const scope = page.getByRole("combobox", { name: "搜索范围" });
  await scope.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.getByRole("option", { name: "仅标题" }).click();
  await expect(scope).toContainText("仅标题");
  await scope.press("ArrowDown");
  await scope.press("ArrowDown");
  await expect(page.getByRole("option", { name: "仅正文" })).toHaveClass(/is-active/u);
  await scope.press("Enter");
  await expect(scope).toContainText("仅正文");
  await expect(scope).toHaveAttribute("aria-valuetext", "仅正文");
  await scope.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.locator(".filters").evaluate((element: HTMLFieldSetElement) => { element.disabled = true; });
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.locator(".filters").evaluate((element: HTMLFieldSetElement) => { element.disabled = false; });
  await scope.focus();
  await scope.press("?");
  await expect(page.getByRole("dialog", { name: "帮助与关于" })).toHaveCount(0);

  await page.getByLabel("网页地址").fill("https://example.com/logo-return");
  await page.getByRole("button", { name: "收取网页" }).click();
  const title = page.getByLabel("文档标题");
  await expect(title).toHaveJSProperty("tagName", "INPUT");
  await expect(title).toHaveValue("远端测试文章", { timeout: 8_000 });
  await title.fill("保留这次未保存修改");
  await page.getByRole("button", { name: "返回知识库主界面" }).click();
  const discardDialog = page.getByRole("alertdialog", { name: "存在未保存修改" });
  await expect(discardDialog).toContainText("当前修改尚未保存");
  await discardDialog.getByRole("button", { name: "取消" }).click();
  await expect(title).toHaveValue("保留这次未保存修改");

  await title.fill("确认离开未保存修改");
  await page.getByRole("button", { name: "返回知识库主界面" }).click();
  await page.getByRole("alertdialog", { name: "存在未保存修改" }).getByRole("button", { name: "继续并放弃" }).click();
  await expect(page.getByLabel("网页地址")).toBeVisible();
});

test("creates a folder and moves one knowledge item with the accessible dialog", async ({ page }) => {
  await page.goto("/");
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  await expect(deferSetup.or(page.getByLabel("网页地址"))).toBeVisible();
  if (await deferSetup.isVisible()) await deferSetup.click();
  const captureUrl = `https://example.com/folder-${Date.now()}`;
  await page.getByLabel("网页地址").fill(captureUrl);
  await page.getByRole("button", { name: "收取网页" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("远端测试文章", { timeout: 8_000 });
  const rootRow = page.getByRole("region", { name: "根目录内容" }).locator(".directory-document-row").filter({ has: page.locator(`a[href="${captureUrl}"]`) });
  await expect(rootRow.getByRole("button", { name: "远端测试文章", exact: true })).toBeVisible();
  await expect(page.locator(".folder-node").filter({ hasText: "根目录" })).toHaveCount(0);
  await expect(page.locator(".result-caption, .document-list")).toHaveCount(0);
  const folderName = `目录-${Date.now()}`;
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("dialog", { name: "新建" }).getByRole("button", { name: "创建文件夹" }).click();
  const create = page.getByRole("dialog", { name: "新建文件夹" });
  await create.getByLabel("文件夹名称").fill(folderName);
  await create.getByRole("button", { name: "创建" }).click();
  await expect(page.getByText(`已创建文件夹“${folderName}”。`)).toBeVisible();
  await rootRow.getByRole("button", { name: "更多操作：远端测试文章" }).click();
  const actions = page.getByRole("dialog", { name: "操作：远端测试文章" });
  await expect(actions).toBeVisible();
  await actions.getByRole("button", { name: "移动到文件夹…" }).click();
  const move = page.getByRole("dialog", { name: "移动到文件夹" });
  await move.getByRole("combobox", { name: "目标位置" }).click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.getByRole("option", { name: folderName }).click();
  await move.getByRole("button", { name: "移动", exact: true }).click();
  await expect(page.getByText(`已移到“${folderName}”。`)).toBeVisible();
  const folderBranch = page.locator(".folder-branch").filter({ hasText: folderName });
  await expect(folderBranch.locator(".folder-node > button").first()).toHaveAttribute("aria-expanded", "true");
  const movedRow = folderBranch.locator(".directory-document-row").filter({ has: page.locator(`a[href="${captureUrl}"]`) });
  await expect(movedRow).toBeVisible();
  const moreActions = movedRow.getByRole("button", { name: "更多操作：远端测试文章" });
  await moreActions.click();
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await expect(page.getByRole("dialog", { name: "操作：远端测试文章" })).toHaveCount(0);
  await expect(moreActions).toBeFocused();
  await moreActions.click();
  await page.getByRole("dialog", { name: "操作：远端测试文章" }).getByRole("button", { name: "删除（移入回收站）" }).click();
  await page.getByRole("alertdialog", { name: "移入回收站" }).getByRole("button", { name: "移入回收站" }).click();
  await expect(page.getByRole("button", { name: "回收站", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".document-list .directory-document-row").filter({ has: page.locator(`a[href="${captureUrl}"]`) })).toBeVisible();
});

test("creates a top-level blank article from the directory menu", async ({ page }) => {
  await page.goto("/");
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  await expect(deferSetup.or(page.getByLabel("网页地址"))).toBeVisible();
  if (await deferSetup.isVisible()) await deferSetup.click();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("dialog", { name: "新建" }).getByRole("button", { name: "创建文章" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("未命名文章");
  await expect(page.locator(".document-kicker").getByText("本地文章", { exact: true })).toBeVisible();
  await expect(page.locator('.document-kicker a[href^="zhiye:"]')).toHaveCount(0);
  await expect(page.getByRole("region", { name: "根目录内容" }).getByRole("button", { name: "未命名文章", exact: true })).toHaveAttribute("aria-current", "true");
});

test("opens one keyboard-accessible help and about dialog in normal and recovery modes", async ({ page }) => {
  await page.goto("/");
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  await expect(deferSetup.or(page.getByLabel("网页地址"))).toBeVisible();
  if (await deferSetup.isVisible()) await deferSetup.click();

  const helpButton = page.getByRole("button", { name: "帮助", exact: true });
  await helpButton.focus();
  await helpButton.click();
  const help = page.getByRole("dialog", { name: "帮助与关于" });
  await expect(help).toBeVisible();
  await expect(help.getByRole("heading", { name: "快速上手" })).toBeVisible();
  await expect(help.getByText(/^v\d+\.\d+\.\d+(?:-[\w.]+)?$/u)).toBeVisible();
  await expect(help.getByText("本地 Web", { exact: true })).toBeVisible();
  await help.getByRole("button", { name: "生成 5 分钟配对码" }).click();
  await expect(help.getByRole("status")).toContainText(/[A-Z2-9]{10}/u);
  for (const link of await help.getByRole("navigation", { name: "项目帮助链接" }).getByRole("link").all()) {
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/u);
  }
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await expect(helpButton).toBeFocused();

  await page.keyboard.press("?");
  await expect(help).toBeVisible();
  await help.getByRole("button", { name: "重新打开使用指南" }).click();
  const guide = page.getByRole("dialog", { name: /你的知识/u });
  await expect(guide).toBeVisible();
  await page.keyboard.press("Escape");

  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":{"code":"DATA_UNAVAILABLE","message":"recovery"}}' }));
  await page.route("**/api/data-safety", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, mode: "recovery", recoveryError: { code: "DATABASE_CORRUPT", message: "recovery" } } });
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "数据安全" })).toBeVisible();
  await page.getByRole("button", { name: "帮助", exact: true }).click();
  await expect(help.getByText("本地 Web · 恢复模式", { exact: true })).toBeVisible();
  await expect(help.getByRole("button", { name: "恢复资料后可打开指南" })).toBeDisabled();
});

test("previews a batch before importing it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "批量导入" }).click();
  const dialog = page.getByRole("dialog", { name: "批量导入" });
  await dialog.getByRole("button", { name: "Markdown" }).click();
  await dialog.getByLabel("选择多个 .md 文件").setInputFiles(Array.from({ length: 101 }, (_, index) => ({
    name: `note-${index}.md`, mimeType: "text/markdown", buffer: Buffer.from("# note"),
  })));
  await expect(dialog.getByText("最多选择 100 个 Markdown 文件。")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "检查导入内容" })).toBeDisabled();
  await dialog.getByRole("button", { name: "浏览器书签" }).click();
  await dialog.getByLabel("选择浏览器导出的 bookmarks.html").setInputFiles({
    name: "bookmarks.html", mimeType: "text/html", buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  await expect(dialog.getByText("导入文件合计不能超过 10 MiB。")).toBeVisible();
  await dialog.getByRole("button", { name: "网址列表" }).click();
  await dialog.getByLabel("每行一个公开网页地址").fill("not-a-url");
  await dialog.getByRole("button", { name: "检查导入内容" }).click();
  await expect(dialog.locator(".bulk-preview-list li")).toContainText("not-a-url");
  await expect(dialog.locator(".bulk-preview-list li")).toContainText("无效");
  await expect(dialog.getByRole("button", { name: "确认导入" })).toBeDisabled();
  await dialog.getByRole("button", { name: "重新选择" }).click();
  await dialog.getByRole("button", { name: "Markdown" }).click();
  await dialog.getByLabel("选择多个 .md 文件").setInputFiles({
    name: "batch-close.md", mimeType: "text/markdown", buffer: Buffer.from("# 批量关闭测试"),
  });
  await dialog.getByRole("button", { name: "检查导入内容" }).click();
  await dialog.getByRole("button", { name: "确认导入" }).click();
  await expect(dialog.getByText(/新增 1/u)).toBeVisible();
  const cleanup = page.waitForRequest((request) => request.method() === "DELETE" && /\/api\/imports\//u.test(new URL(request.url()).pathname));
  const closeReady = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/desktop/close-ready");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("zhiye:close-requested", { detail: { attemptId: "9100" } })));
  await cleanup;
  await closeReady;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("zhiye:close-timeout", { detail: { attemptId: "9100" } })));
  await dialog.getByRole("button", { name: "关闭批量导入" }).click();
  await expect(dialog).toBeHidden();

  const downloadStarted = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出全部" }).click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toMatch(/^zhiye-export-\d{4}-\d{2}-\d{2}\.zip$/u);
  await expect(page.getByText("知识包已生成：", { exact: false })).toBeVisible();
  const bundlePath = await download.path();
  if (!bundlePath) throw new Error("Portable bundle download has no local path");
  await page.getByRole("button", { name: "批量导入" }).click();
  await dialog.getByRole("button", { name: "织页知识包" }).click();
  await dialog.getByLabel("选择织页导出的 .zip 知识包").setInputFiles({
    name: download.suggestedFilename(), mimeType: "application/zip", buffer: await readFile(bundlePath),
  });
  await dialog.getByRole("button", { name: "检查导入内容" }).click();
  await expect(dialog.locator(".bulk-counts")).toContainText("文档");
  await expect(dialog.locator(".bulk-counts")).toContainText("资源");
  await expect(dialog.locator(".bulk-counts .is-assets strong")).toHaveText("0");
  await dialog.getByRole("button", { name: "关闭批量导入" }).click();
  await expect(dialog).toBeHidden();
});

test("keeps optional AI generation explicit, cancellable, inert, and manually adopted", async ({ page }) => {
  test.setTimeout(90_000);
  const modelRequests: string[] = [];
  await page.route("https://model.example.test/**", async (route) => {
    modelRequests.push(route.request().url());
    await route.abort();
  });
  await page.goto("/");
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  await deferSetup.or(page.getByLabel("网页地址")).first().waitFor();
  if (await deferSetup.isVisible()) await deferSetup.click();
  await page.getByLabel("网页地址").fill("https://example.com/ai-lifecycle");
  await page.getByRole("button", { name: "收取网页" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("AI 生命周期文章", { timeout: 8_000 });

  await page.getByRole("button", { name: "AI 设置", exact: true }).click();
  const remoteProvider = page.getByRole("combobox", { name: "AI 远程平台" });
  await remoteProvider.click();
  await expect(page.getByRole("option")).toHaveCount(10);
  await remoteProvider.press("Escape");
  await page.getByLabel("AI 远程模型").fill("remote-e2e-model");
  await page.getByLabel("远程模型 API 密钥").fill("e2e-memory-only-key");
  const keyRequest = page.waitForRequest((request) => request.method() === "PUT" && new URL(request.url()).pathname === "/api/settings/llm/key");
  await page.getByRole("button", { name: "保存密钥" }).click();
  expect((await keyRequest).postDataJSON()).toEqual({
    apiKey: "e2e-memory-only-key",
    endpointUrl: "https://api.openai.com/v1/chat/completions",
  });
  await expect(page.getByText("密钥已立即生效", { exact: false })).toBeVisible();
  await expect(page.getByText("当前进程已加载当前平台密钥", { exact: false })).toBeVisible();
  await page.reload();
  const deferAfterReload = page.getByRole("button", { name: "稍后设置" });
  await deferAfterReload.or(page.getByRole("button", { name: "AI 设置", exact: true })).first().waitFor();
  if (await deferAfterReload.isVisible()) await deferAfterReload.click();
  await page.getByRole("button", { name: "AI 设置", exact: true }).click();
  await expect(page.getByText("当前进程已加载当前平台密钥", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "删除密钥" })).toBeVisible();
  await page.getByLabel("AI 远程模型").fill("remote-e2e-model");
  await page.getByLabel("远程模型 API 密钥").fill("must-not-cross-platforms");
  await expect(page.getByRole("button", { name: "测试连接" })).toBeDisabled();
  await expect(page.getByText("先保存密钥，再测试", { exact: false })).toBeVisible();
  await chooseUiOption(page, "AI 远程平台", "DeepSeek");
  await expect(page.getByText("https://api.deepseek.com/chat/completions", { exact: true })).toBeVisible();
  await expect(page.getByLabel("AI 远程端点地址")).toHaveCount(0);
  await expect(page.getByLabel("远程模型 API 密钥")).toHaveValue("");
  await expect(page.getByText("当前平台未加载密钥", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "测试连接" })).toBeDisabled();
  await page.getByText("允许 AI 派生知识", { exact: true }).click();
  await expect(page.getByRole("button", { name: "保存设置" })).toBeDisabled();
  await page.getByText("允许 AI 派生知识", { exact: true }).click();
  await chooseUiOption(page, "AI 远程平台", "其他（手动输入）");
  await expect(page.getByLabel("AI 远程端点地址")).toBeVisible();
  await page.getByLabel("AI 远程端点地址").fill("http://insecure.example.test/v1/chat/completions");
  await page.getByLabel("远程模型 API 密钥").fill("must-not-bind-to-insecure-endpoint");
  await page.getByRole("button", { name: "保存密钥" }).click();
  await expect(page.getByRole("alert")).toContainText("端点地址无效");
  await expect(page.getByText("当前平台未加载密钥", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "删除密钥" }).click();
  await page.getByRole("alertdialog", { name: "删除远程模型密钥" }).getByRole("button", { name: "删除密钥" }).click();
  await expect(page.getByText("当前平台未加载密钥", { exact: false })).toBeVisible();
  await chooseUiOption(page, "AI 远程平台", "OpenAI");
  await page.getByRole("button", { name: "可信本地端点" }).click();
  await page.getByLabel("AI 本地端点地址").fill("http://127.0.0.1:4175/v1/chat/completions");
  await page.getByLabel("AI 本地模型").fill("fake-e2e-model");
  await page.getByText("我信任这个本机端点", { exact: false }).click();
  await expect(page.locator(".ai-enable input")).not.toBeChecked();
  const probeRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/settings/llm/test");
  await page.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByLabel("AI 本地模型")).toBeDisabled();
  expect((await probeRequest).postDataJSON()).toEqual({
    target: "local",
    endpointUrl: "http://127.0.0.1:4175/v1/chat/completions",
    model: "fake-e2e-model",
    trusted: true,
  });
  await expect(page.getByRole("status").getByText("连接成功", { exact: true })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("固定探针未发送正文", { exact: false })).toBeVisible();
  const persistedBeforeSave = await page.evaluate(() => fetch("/api/settings/llm").then((response) => response.json())) as {
    enabled: boolean;
    local: { model: string };
  };
  expect(persistedBeforeSave.enabled).toBe(false);
  expect(persistedBeforeSave.local.model).not.toBe("fake-e2e-model");

  await page.getByLabel("AI 本地端点地址").fill("http://127.0.0.1:4176/v1/chat/completions");
  await expect(page.getByRole("status").getByText("连接成功", { exact: true })).toHaveCount(0);
  await page.getByText("我信任这个本机端点", { exact: false }).click();
  const failedProbe = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/settings/llm/test");
  await page.getByRole("button", { name: "测试连接" }).click();
  const failedProbeBody = (await failedProbe).postData() || "";
  expect(failedProbeBody).not.toContain("AI 生命周期文章");
  expect(failedProbeBody).not.toContain("这是可搜索的本地知识正文");
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 8_000 });
  await page.getByLabel("AI 本地端点地址").fill("http://127.0.0.1:4175/v1/chat/completions");
  await page.getByText("我信任这个本机端点", { exact: false }).click();
  await page.getByText("允许 AI 派生知识", { exact: true }).click();
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("AI 派生已启用。", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "返回资料库" }).click();
  await page.getByRole("button", { name: "AI 生命周期文章", exact: true }).click();

  await page.getByRole("button", { name: "AI 派生", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "AI 派生知识" });
  const summaryPreviewResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/derived-preview"));
  const summaryTaskRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/derived-task"));
  await panel.getByRole("button", { name: "获取", exact: true }).click();
  const summaryPreview = await (await summaryPreviewResponse).json() as { revision: number; sendHash: string };
  expect((await summaryTaskRequest).postDataJSON()).toMatchObject({ type: "summary", revision: summaryPreview.revision, sendHash: summaryPreview.sendHash });
  await expect(panel.getByLabel("模型发送范围预览")).toHaveCount(0);
  await expect(panel.getByText("摘要正在生成")).toBeVisible();
  await panel.getByRole("button", { name: "取消任务" }).click();
  await expect(panel.getByText("摘要已取消")).toBeVisible();
  await panel.getByRole("button", { name: "重试" }).click();
  await expect(panel.getByRole("heading", { name: "本地摘要" })).toBeVisible({ timeout: 5_000 });
  await expect(panel.getByText("不可点击")).toBeVisible();
  await expect(panel.getByText("不可点击").locator("xpath=ancestor::a")).toHaveCount(0);
  await expect(panel.getByText("图片请求已阻止", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __modelXss?: boolean }).__modelXss)).not.toBe(true);
  expect(modelRequests).toEqual([]);
  await panel.getByRole("button", { name: "固定摘要" }).click();
  await panel.getByRole("button", { name: "关闭 AI 派生知识" }).click();
  await expect(page.getByRole("region", { name: "固定摘要" })).toContainText("本地摘要");

  await page.getByRole("button", { name: "AI 派生", exact: true }).click();
  await panel.getByRole("button", { name: "AI 对话", exact: true }).click();
  const customPrompt = panel.getByLabel("AI 对话 Prompt");
  await expect(customPrompt).toBeVisible();
  await customPrompt.fill("找出文章中最值得反驳的假设");
  const customPreviewRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/derived-preview"));
  await panel.getByRole("button", { name: "预览发送范围" }).click();
  expect((await customPreviewRequest).postDataJSON()).toMatchObject({ type: "summary", customPrompt: "找出文章中最值得反驳的假设" });
  await expect(panel.getByLabel("将发送给模型的准确文本")).toContainText("AI 生命周期文章");
  const customTaskRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/derived-task"));
  await panel.getByRole("button", { name: "发送并生成" }).click();
  expect((await customTaskRequest).postDataJSON()).toMatchObject({ type: "summary", customPrompt: "找出文章中最值得反驳的假设" });
  await expect(panel.getByText("AI 对话正在生成")).toBeVisible();
  await expect(panel.locator(".derived-history li").filter({ hasText: "AI 对话" })).toBeVisible({ timeout: 5_000 });

  await panel.getByRole("button", { name: "标签建议", exact: true }).click();
  const tagPreviewResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/derived-preview"));
  const tagTaskRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/derived-task"));
  await panel.getByRole("button", { name: "获取", exact: true }).click();
  const tagPreview = await (await tagPreviewResponse).json() as { revision: number; sendHash: string };
  expect((await tagTaskRequest).postDataJSON()).toMatchObject({ type: "tag-suggestions", revision: tagPreview.revision, sendHash: tagPreview.sendHash });
  await expect(panel.getByLabel("模型发送范围预览")).toHaveCount(0);
  const suggested = panel.getByLabel("#人工智能");
  await expect(suggested).toBeVisible({ timeout: 5_000 });
  await expect(suggested).not.toBeChecked();
  await suggested.check();
  await panel.getByRole("button", { name: "采纳所选标签" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("AI 生命周期文章");
  await expect(page.locator(".tag-field input")).toHaveValue(/人工智能/u);

  await panel.getByRole("button", { name: "关闭 AI 派生知识" }).click();
  const editor = page.getByLabel("Markdown 编辑器");
  const longMarkdown = `# 超长原文\n\n${"完整翻译段落。".repeat(35_800)}`;
  const longSave = page.waitForResponse((response) => {
    const request = response.request();
    return response.ok() && request.method() === "PATCH" && /\/api\/documents\/[^/]+$/u.test(new URL(request.url()).pathname) &&
      (request.postDataJSON() as { markdown?: string }).markdown === longMarkdown;
  });
  await editor.fill(longMarkdown);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await longSave;
  await expect(page.getByText("已保存", { exact: true })).toBeVisible({ timeout: 8_000 });
  const originalMarkdown = await editor.textContent();
  await page.getByRole("button", { name: "翻译", exact: true }).click();
  await expect(panel.getByRole("button", { name: "翻译", exact: true })).toHaveAttribute("aria-pressed", "true");
  const language = panel.getByLabel("翻译目标语言");
  await language.click();
  await expect(page.getByRole("option")).toHaveCount(11);
  await page.getByRole("option", { name: "English", exact: true }).click();
  const translationPreviewResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/derived-preview$/u.test(new URL(response.url()).pathname));
  const translationRequest = page.waitForRequest((request) => request.method() === "POST" && /\/derived-task$/u.test(new URL(request.url()).pathname));
  await panel.getByRole("button", { name: "获取", exact: true }).click();
  const translationPreview = await (await translationPreviewResponse).json() as { revision: number; sendHash: string };
  expect((await translationRequest).postDataJSON()).toMatchObject({ type: "translation", revision: translationPreview.revision, sendHash: translationPreview.sendHash });
  await expect(panel.getByLabel("模型发送范围预览")).toHaveCount(0);
  await expect(panel.getByText("翻译 · English正在生成")).toBeVisible();
  await expect(panel.getByText(/批次进度 [1-9]\d* \/ \d+/u)).toBeVisible({ timeout: 8_000 });
  await expect(panel.getByText("翻译 · English已生成", { exact: false })).toBeVisible({ timeout: 45_000 });
  await expect(panel.getByText("翻译 · English", { exact: true }).last()).toBeVisible();
  await expect(panel.getByText("结果超过 250,000 字符", { exact: false })).toBeVisible();
  await expect(panel.getByLabel("派生结果纯文本")).toBeVisible();
  await expect(panel.getByRole("heading", { name: "译文：超长原文" })).toHaveCount(0);
  await panel.getByRole("button", { name: "加载 Markdown 渲染" }).click();
  await expect(panel.getByRole("heading", { name: "译文：超长原文" })).toBeVisible();
  await expect(page.getByLabel("Markdown 编辑器")).toHaveText(originalMarkdown || "");

  await page.getByRole("button", { name: "AI 设置", exact: true }).click();
  await page.getByRole("button", { name: "关闭 AI 并删除全部结果" }).click();
  await page.getByRole("alertdialog", { name: "关闭 AI 并删除结果" }).getByRole("button", { name: "关闭并删除" }).click();
  await expect(page.getByText(/AI 已关闭，并删除 4 条派生结果/u)).toBeVisible();
  await page.getByRole("button", { name: "返回资料库" }).click();
  await page.getByRole("button", { name: "AI 派生", exact: true }).click();
  await expect(page.getByText("还没有派生结果。", { exact: false })).toBeVisible();
});

test("deletes a complete backup after confirmation", async ({ page }) => {
  await page.goto("/");
  const deferSetup = page.getByRole("button", { name: "稍后设置" });
  if (await deferSetup.isVisible()) await deferSetup.click();
  await page.getByRole("button", { name: "数据安全" }).click();
  await expect(page.getByRole("heading", { name: "数据安全" })).toBeVisible();
  const backupRows = page.locator(".backup-row");
  const before = await backupRows.count();
  await page.getByRole("button", { name: "创建留档" }).click();
  await expect(page.getByText("完整留档已创建并校验。")).toBeVisible();
  await expect(backupRows).toHaveCount(before + 1);
  await backupRows.first().getByRole("button", { name: "删除此留档" }).click();
  const dialog = page.getByRole("alertdialog", { name: "删除完整留档" });
  await expect(dialog).toContainText("删除后无法恢复");
  await dialog.getByRole("button", { name: "删除留档" }).click();
  await expect(page.getByText("留档已删除。")).toBeVisible();
  await expect(backupRows).toHaveCount(before);
});

test("imports, restores history, trashes, restores, searches, exports, and blocks raw scripts", async ({ page }) => {
  test.setTimeout(60_000);
  const remoteImageRequests: string[] = [];
  await page.route("https://assets.example.test/**", async (route) => {
    remoteImageRequests.push(route.request().url());
    await route.abort();
  });
  const onboardingResponse = await page.request.get("/api/settings/onboarding");
  const onboarding = await onboardingResponse.json() as { completed: boolean; revision: number };
  if (!onboarding.completed) {
    const completed = await page.request.put("/api/settings/onboarding", {
      data: { completed: true, revision: onboarding.revision },
      headers: { "X-Zhiye-Data-Epoch": onboardingResponse.headers()["x-zhiye-data-epoch"] },
    });
    expect(completed.ok()).toBe(true);
  }
  await page.goto("/");
  await page.getByRole("button", { name: "数据安全" }).click();
  await expect(page.getByRole("heading", { name: "数据安全" })).toBeVisible();
  await page.getByRole("button", { name: "创建留档" }).click();
  await expect(page.getByText("完整留档已创建并校验。")).toBeVisible();
  await expect(page.getByText("校验通过").first()).toBeVisible();
  const backupRows = page.locator(".backup-row");
  const backupCount = await backupRows.count();
  const exportButton = backupRows.first().getByRole("button", { name: "导出文件" });
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const exportDialog = page.getByRole("alertdialog", { name: "导出完整留档" });
  await expect(exportDialog).toContainText("包含完整知识数据");
  await exportDialog.getByRole("button", { name: "继续下载" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zhiye-backup$/u);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("浏览器未保留导出留档");

  const restoreRequests: string[] = [];
  const recordRestore = (request: Request) => {
    if (/\/api\/data-safety\/backups\/[^/]+\/restore$/u.test(new URL(request.url()).pathname)) restoreRequests.push(request.url());
  };
  page.on("request", recordRestore);
  const importResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/data-safety/backups/import");
  await page.getByLabel("导入完整留档文件").setInputFiles({
    name: download.suggestedFilename(),
    mimeType: "application/vnd.zhiye.backup+zip",
    buffer: await readFile(downloadPath),
  });
  const importDialog = page.getByRole("alertdialog", { name: "导入完整留档" });
  await expect(importDialog).toContainText("不会覆盖当前资料或自动恢复");
  await importDialog.getByRole("button", { name: "继续导入" }).click();
  const importResponse = await importResponsePromise;
  expect(importResponse.status()).toBe(201);
  const importedBackup = await importResponse.json() as { id: string };
  await expect(page.getByText("留档文件已导入并校验；当前资料未更改。")).toBeVisible();
  await expect(backupRows).toHaveCount(backupCount + 1);
  expect(restoreRequests).toEqual([]);
  page.off("request", recordRestore);
  await expect(page.getByRole("heading", { name: "数据安全" })).toBeVisible();
  await page.getByRole("button", { name: "返回资料库" }).click();

  const markerUrl = "https://example.com/full-backup-restore-marker";
  await page.getByLabel("网页地址").fill(markerUrl);
  const markerResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/documents");
  await page.getByRole("button", { name: "收取网页" }).click();
  const markerResponse = await markerResponsePromise;
  const marker = await markerResponse.json() as { document: { id: string } };
  await expect(page.getByLabel("文档标题")).toHaveValue("远端测试文章", { timeout: 8_000 });

  await page.getByRole("button", { name: "数据安全" }).click();
  const importedRow = backupRows.first();
  await expect(importedRow).toHaveCount(1);
  const restoredResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/data-safety/backups/${encodeURIComponent(importedBackup.id)}/restore`);
  const reloadPromise = page.waitForEvent("framenavigated");
  await importedRow.getByRole("button", { name: "恢复此留档" }).click();
  await page.getByRole("alertdialog", { name: "恢复完整留档" }).getByRole("button", { name: "开始恢复" }).click();
  expect((await restoredResponsePromise).ok()).toBe(true);
  await reloadPromise;
  expect((await page.request.get(`/api/documents/${encodeURIComponent(marker.document.id)}`)).status()).toBe(404);
  await expect(page.getByLabel("网页地址")).toBeVisible();

  await page.getByLabel("网页地址").fill("https://example.com/requested");
  await page.getByRole("button", { name: "收取网页" }).click();

  await expect(page.getByLabel("文档标题")).toHaveValue("远端测试文章", { timeout: 8_000 });
  await expect(page.getByRole("heading", { name: "抓取成功" })).toBeVisible();
  const offlineImage = page.locator(".offline-image img");
  await expect(offlineImage).toHaveAttribute("src", /\/api\/assets\/[a-f0-9]{64}$/u);
  await expect.poll(() => offlineImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByText("图片离线保存失败", { exact: false })).toBeVisible();
  await expect(page.locator(".markdown-preview img")).toHaveCount(1);
  await expect(page.getByLabel("Markdown 编辑器")).toContainText(readyImageUrl);
  await expect(page.getByLabel("Markdown 编辑器")).toContainText(failedImageUrl);
  expect(remoteImageRequests).toEqual([]);
  expect(await page.evaluate(() => (window as typeof window & { __zhiyeXss?: boolean }).__zhiyeXss)).toBeUndefined();

  await page.getByRole("button", { name: "质量检查" }).click();
  const quality = page.getByRole("complementary", { name: "提取质量检查" });
  await expect(quality.getByText("正文可能不完整")).toBeVisible();
  await expect(quality.getByText("1 张图片未能离线保存")).toBeVisible();
  await quality.getByRole("button", { name: "查看采集历史与本地快照" }).click();
  const captureHistory = page.getByRole("complementary", { name: "采集历史" });
  await expect(captureHistory.getByText("e2e-capture@1")).toBeVisible();
  await captureHistory.getByRole("button", { name: "从快照重新提取" }).click();
  await expect(captureHistory.getByText("已从本地 HTML 快照生成候选，尚未修改正文。")).toBeVisible();
  await expect(page.getByLabel("Markdown 编辑器")).not.toContainText("只来自本地 HTML 快照");
  await captureHistory.getByLabel("替换 Markdown 正文").check();
  await page.evaluate(async () => {
    const listResponse = await fetch("/api/documents?page=1");
    const epoch = listResponse.headers.get("X-Zhiye-Data-Epoch")!;
    const list = await listResponse.json() as {
      items: Array<{ id: string }>;
    };
    const document = await fetch(`/api/documents/${list.items[0].id}`).then((response) => response.json()) as {
      id: string;
      revision: number;
    };
    await fetch(`/api/documents/${document.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": epoch },
      body: JSON.stringify({ revision: document.revision, markdown: "# 并发保护正文" }),
    });
  });
  await captureHistory.getByRole("button", { name: "采纳选中内容" }).click();
  await expect(captureHistory.getByText("文档已在别处变化，请重新从快照生成对比。")).toBeVisible();
  await expect(page.getByLabel("Markdown 编辑器")).toContainText("并发保护正文");
  await captureHistory.getByRole("button", { name: "从快照重新提取" }).click();
  await expect(captureHistory.getByText("已从本地 HTML 快照生成候选，尚未修改正文。")).toBeVisible();
  await captureHistory.getByLabel("替换 Markdown 正文").check();
  await captureHistory.getByRole("button", { name: "采纳选中内容" }).click();
  await expect(captureHistory.getByText("已采纳选中内容，原修订仍保留在历史中。")).toBeVisible();
  await expect(page.getByLabel("Markdown 编辑器")).toContainText("只来自本地 HTML 快照");
  await captureHistory.getByRole("button", { name: "关闭采集历史" }).click();

  await page.evaluate(async () => {
    const listResponse = await fetch("/api/documents?page=1");
    const epoch = listResponse.headers.get("X-Zhiye-Data-Epoch")!;
    const list = await listResponse.json() as {
      items: Array<{ id: string }>;
    };
    const document = await fetch(`/api/documents/${list.items[0].id}`).then((response) => response.json()) as {
      id: string;
      revision: number;
      title: string;
      tags: string[];
    };
    await fetch(`/api/documents/${document.id}/draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": epoch },
      body: JSON.stringify({
        expectedDraftRevision: null,
        baseRevision: document.revision,
        title: document.title,
        markdown: "## 恢复草稿\n\n关闭前必须落盘。",
        tags: document.tags,
      }),
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "远端测试文章", exact: true }).click();
  await expect(page.getByText("已恢复上次未正式保存的本地草稿。")).toBeVisible();
  const closeMarker = `close-${Date.now()}`;
  const closeMarkdown = `## 关闭前草稿\n\n${closeMarker}`;
  const closeAttemptId = "9001";
  const closeOrder: string[] = [];
  page.on("requestfinished", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "PUT" && pathname.endsWith("/draft")) {
      const body = request.postDataJSON() as { markdown?: string };
      if (body.markdown === closeMarkdown) closeOrder.push("draft");
    }
    if (request.method() === "POST" && pathname === "/api/desktop/close-ready") {
      const body = request.postDataJSON() as { attemptId?: string };
      if (body.attemptId === closeAttemptId) closeOrder.push("ready");
    }
  });
  const closeEditor = page.getByLabel("Markdown 编辑器");
  await closeEditor.fill(closeMarkdown);
  await page.evaluate((attemptId) => {
    window.dispatchEvent(new CustomEvent("zhiye:close-requested", { detail: { attemptId } }));
  }, closeAttemptId);
  await expect(page.getByLabel("文档标题")).toBeDisabled();
  await expect.poll(() => closeOrder.at(-1)).toBe("ready");
  expect(closeOrder).toEqual(["draft", "ready"]);
  await page.evaluate((attemptId) => {
    window.dispatchEvent(new CustomEvent("zhiye:close-timeout", { detail: { attemptId } }));
  }, closeAttemptId);
  await expect(page.getByLabel("文档标题")).toBeEnabled();

  const titleEditor = page.getByLabel("文档标题");
  await titleEditor.fill("  人工整理标题  ");
  const editor = page.getByLabel("Markdown 编辑器");
  await editor.click();
  await editor.press("Control+A");
  await editor.fill("# 第一版\n\n第一版正文");
  await page.getByPlaceholder("用逗号分隔").fill("测试, 本地");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("已同步", { exact: true })).toBeVisible({ timeout: 5_000 });

  const currentStoredDraft = () => page.evaluate(async () => {
    const list = await fetch("/api/documents?page=1").then((response) => response.json()) as {
      items: Array<{ id: string }>;
    };
    const draft = await fetch(`/api/documents/${list.items[0].id}/draft`).then((response) => response.json()) as {
      markdown: string;
    } | null;
    return draft?.markdown ?? null;
  });
  const currentStoredMarkdown = () => page.evaluate(async () => {
    const list = await fetch("/api/documents?page=1").then((response) => response.json()) as {
      items: Array<{ id: string }>;
    };
    const document = await fetch(`/api/documents/${list.items[0].id}`).then((response) => response.json()) as {
      markdown: string;
    };
    return document.markdown;
  });
  await expect(titleEditor).toHaveValue("人工整理标题");
  await expect.poll(currentStoredDraft).toBeNull();
  await page.reload();
  await page.getByRole("button", { name: "人工整理标题", exact: true }).click();
  await expect(page.getByText("已恢复上次未正式保存的本地草稿。")).toHaveCount(0);
  await expect(titleEditor).toHaveValue("人工整理标题");

  const undoneMarker = `undo-${Date.now()}`;
  const firstMarkdown = "# 第一版\n\n第一版正文";
  let releaseUndoPut!: () => void;
  let undoPutStarted = false;
  let releaseUndoDelete!: () => void;
  let undoDeleteStarted = false;
  const undoPutGate = new Promise<void>((resolve) => {
    releaseUndoPut = resolve;
  });
  const undoDeleteGate = new Promise<void>((resolve) => {
    releaseUndoDelete = resolve;
  });
  await page.route("**/api/documents/*/draft", async (route) => {
    const request = route.request();
    const body = request.method() === "PUT" ? request.postDataJSON() as { markdown?: string } : null;
    if (body?.markdown?.includes(undoneMarker)) {
      undoPutStarted = true;
      await undoPutGate;
    }
    if (request.method() === "DELETE") {
      undoDeleteStarted = true;
      await undoDeleteGate;
    }
    await route.continue();
  });
  await editor.fill(`${firstMarkdown}\n\n${undoneMarker}`);
  const undoPutResponse = page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() !== "PUT" || !new URL(request.url()).pathname.endsWith("/draft")) return false;
    return (request.postDataJSON() as { markdown?: string }).markdown?.includes(undoneMarker) ?? false;
  });
  await expect.poll(() => undoPutStarted).toBe(true);
  await editor.fill(firstMarkdown);
  releaseUndoPut();
  await undoPutResponse;
  const undoDeleteResponse = page.waitForResponse((response) =>
    response.request().method() === "DELETE" && new URL(response.url()).pathname.endsWith("/draft")
  );
  await expect.poll(() => undoDeleteStarted).toBe(true);
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    return { dispatched: window.dispatchEvent(event), prevented: event.defaultPrevented };
  })).toEqual({ dispatched: false, prevented: true });
  releaseUndoDelete();
  await undoDeleteResponse;
  await expect.poll(currentStoredDraft).toBeNull();
  await page.unroute("**/api/documents/*/draft");
  await page.reload();
  await page.getByRole("button", { name: "人工整理标题", exact: true }).click();
  await expect(page.getByText("已恢复上次未正式保存的本地草稿。")).toHaveCount(0);
  await expect(editor).not.toContainText(undoneMarker);

  const remoteMarker = `remote-${Date.now()}`;
  const localConflictMarker = `local-${Date.now()}`;
  await editor.fill(`${firstMarkdown}\n\n准备草稿`);
  await expect.poll(currentStoredDraft).toContain("准备草稿");
  await page.evaluate(async (markdown) => {
    const listResponse = await fetch("/api/documents?page=1");
    const epoch = listResponse.headers.get("X-Zhiye-Data-Epoch")!;
    const list = await listResponse.json() as {
      items: Array<{ id: string }>;
    };
    const document = await fetch(`/api/documents/${list.items[0].id}`).then((response) => response.json()) as {
      id: string;
      revision: number;
      title: string;
      tags: string[];
    };
    const draft = await fetch(`/api/documents/${document.id}/draft`).then((response) => response.json()) as {
      draftRevision: number;
    };
    await fetch(`/api/documents/${document.id}/draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": epoch },
      body: JSON.stringify({
        expectedDraftRevision: draft.draftRevision,
        baseRevision: document.revision,
        title: document.title,
        markdown,
        tags: document.tags,
      }),
    });
  }, `${firstMarkdown}\n\n${remoteMarker}`);
  await editor.fill(`${firstMarkdown}\n\n${localConflictMarker}`);
  await expect(page.getByText("草稿在另一窗口发生了变化")).toBeVisible();
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    return { dispatched: window.dispatchEvent(event), prevented: event.defaultPrevented };
  })).toEqual({ dispatched: false, prevented: true });
  await page.getByRole("button", { name: "保留我的草稿" }).click();
  await expect(page.getByText("草稿在另一窗口发生了变化")).toHaveCount(0);
  await expect.poll(currentStoredDraft).toContain(localConflictMarker);
  await editor.fill(firstMarkdown);
  await expect.poll(currentStoredDraft).toBeNull();

  await editor.fill("# 第二版\n\n这段文字会被历史恢复替换。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(currentStoredMarkdown).toContain("这段文字会被历史恢复替换。");
  await page.getByRole("button", { name: "修订历史" }).click();
  await expect(page.getByRole("heading", { name: "修订历史" })).toBeVisible();
  const firstRevision = page.getByRole("listitem").filter({ hasText: "第一版正文" });
  await expect(firstRevision).toBeVisible();
  await page.evaluate(async () => {
    const listResponse = await fetch("/api/documents?page=1");
    const epoch = listResponse.headers.get("X-Zhiye-Data-Epoch")!;
    const list = await listResponse.json() as {
      items: Array<{ id: string }>;
    };
    const document = await fetch(`/api/documents/${list.items[0].id}`).then((response) => response.json()) as {
      id: string;
      revision: number;
    };
    await fetch(`/api/documents/${document.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": epoch },
      body: JSON.stringify({ revision: document.revision, title: "另一窗口更新" }),
    });
  });
  let releaseRevisionRestore!: () => void;
  let revisionRestoreStarted = false;
  const revisionRestoreGate = new Promise<void>((resolve) => {
    releaseRevisionRestore = resolve;
  });
  await page.route("**/api/documents/*/revisions/*/restore", async (route) => {
    revisionRestoreStarted = true;
    await revisionRestoreGate;
    await route.continue();
  });
  await firstRevision.getByRole("button", { name: "恢复此版本" }).click();
  await expect.poll(() => revisionRestoreStarted).toBe(true);
  await expect(page.getByLabel("网页地址")).toBeDisabled();
  releaseRevisionRestore();
  await expect(page.getByText("这篇知识在别处被修改过")).toBeVisible();
  await page.unroute("**/api/documents/*/revisions/*/restore");
  await expect.poll(currentStoredDraft).toContain("第一版正文");
  const conflictMarker = `conflict-${Date.now()}`;
  await editor.fill(`# 第一版\n\n第一版正文\n\n${conflictMarker}`);
  await expect.poll(currentStoredDraft).toContain(conflictMarker);
  await page.reload();
  await page.getByRole("button", { name: "另一窗口更新", exact: true }).click();
  await expect(page.getByText("已恢复上次未正式保存的本地草稿。")).toBeVisible();
  await expect(page.getByText("这篇知识在别处被修改过")).toBeVisible();
  await expect(editor).toContainText(conflictMarker);
  await page.getByRole("button", { name: "保留我的修改" }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("heading", { name: "第一版" })).toBeVisible();

  await editor.click();
  await editor.press("Control+A");
  await editor.fill("# 第一版\n\n第一版正文\n\n删除冲突后仍保留。");
  await page.evaluate(async () => {
    const listResponse = await fetch("/api/documents?page=1");
    const epoch = listResponse.headers.get("X-Zhiye-Data-Epoch")!;
    const list = await listResponse.json() as {
      items: Array<{ id: string; revision: number }>;
    };
    await fetch(`/api/documents/${list.items[0].id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": epoch },
      body: JSON.stringify({ revision: list.items[0].revision }),
    });
  });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("这篇知识已被移入回收站")).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "保留我的修改" }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByLabel("Markdown 预览").getByText("删除冲突后仍保留。")).toBeVisible();

  const downloadStarted = page.waitForEvent("download");
  await page.getByRole("link", { name: /导出 \.md/ }).click();
  expect((await downloadStarted).suggestedFilename()).toMatch(/\.md$/u);

  await page.getByRole("button", { name: "移入回收站" }).click();
  const trashDialog = page.getByRole("alertdialog", { name: "移入回收站" });
  await expect(trashDialog).toContainText("之后可以恢复");
  await trashDialog.getByRole("button", { name: "移入回收站" }).click();
  await expect(page.getByRole("button", { name: "回收站", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("文档标题")).toBeDisabled();
  let releaseTrashRestore!: () => void;
  let trashRestoreStarted = false;
  const trashRestoreGate = new Promise<void>((resolve) => {
    releaseTrashRestore = resolve;
  });
  await page.route("**/api/documents/*/restore", async (route) => {
    trashRestoreStarted = true;
    await trashRestoreGate;
    await route.continue();
  });
  await page.getByRole("button", { name: "恢复到资料库" }).click();
  await expect.poll(() => trashRestoreStarted).toBe(true);
  await expect(page.getByLabel("网页地址")).toBeDisabled();
  releaseTrashRestore();
  await expect(page.getByRole("button", { name: "全部", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("文档标题")).toBeEnabled();
  await page.unroute("**/api/documents/*/restore");

  await page.reload();
  await page.getByRole("button", { name: "人工整理标题", exact: true }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("人工整理标题");
  await expect(page.getByRole("heading", { name: "第一版" })).toBeVisible();
  await page.getByPlaceholder("搜索标题与正文").fill("第一版正文");
  await expect(page.getByRole("button", { name: "人工整理标题", exact: true })).toBeVisible();

  const captureBand = page.locator(".capture-band");
  const captureInput = page.getByLabel("网页地址");
  await captureInput.fill("https://example.com/requested");
  await page.getByRole("button", { name: "收取网页" }).click();
  const sourceDuplicate = captureBand.locator(".import-duplicate");
  await expect(sourceDuplicate.getByText("这个网址已经收藏过。")).toBeVisible();
  await expect(sourceDuplicate.getByRole("button", { name: "保留两篇" })).toHaveCount(0);
  await sourceDuplicate.getByRole("button", { name: "打开已有" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("人工整理标题");

  await captureInput.fill("https://example.com/canonical");
  await page.getByRole("button", { name: "收取网页" }).click();
  const resolvedPrompt = captureBand.locator(".import-duplicate");
  await expect(resolvedPrompt.getByText("这个网址指向已有知识。")).toBeVisible();
  await expect(resolvedPrompt.getByRole("button", { name: "打开已有" })).toBeVisible();
  await resolvedPrompt.getByRole("button", { name: "保留两篇" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("远端测试文章", { timeout: 8_000 });
  await expect(captureBand.getByText("已保留为另一篇知识，两篇内容都不会被删除。")).toBeVisible();
  await expect(page.locator(".duplicate-banner")).toHaveCount(0);
  await page.getByRole("button", { name: "人工整理标题", exact: true }).click();
  await page.getByRole("button", { name: "远端测试文章", exact: true }).click();
  await expect(page.locator(".duplicate-banner")).toHaveCount(0);

  await page.reload();
  await page.getByRole("button", { name: "远端测试文章", exact: true }).click();
  const duplicateBanner = page.locator(".duplicate-banner");
  await expect(duplicateBanner.getByText("发现另一篇相同来源的知识")).toBeVisible();
  await expect(duplicateBanner.getByRole("button", { name: "打开已有" })).toBeVisible();
  await duplicateBanner.getByRole("button", { name: "打开已有" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("人工整理标题");
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await expect(page.getByRole("button", { name: "回收站", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.getByRole("button", { name: "远端测试文章", exact: true }).click();
  await expect(duplicateBanner).toHaveCount(0);

  await captureBand.getByRole("button", { name: "暂停采集" }).click();
  await expect(captureBand.getByRole("button", { name: "继续采集" })).toBeVisible();
  await captureInput.fill("https://example.com/queued-cancel");
  await page.getByRole("button", { name: "收取网页" }).click();
  await expect(page.getByRole("heading", { name: "等待继续采集" })).toBeVisible();
  await expect(captureBand.getByText("队列已暂停 · 1 篇等待")).toBeVisible();
  await page.getByRole("button", { name: "取消等待" }).click();
  await expect(page.getByText("CAPTURE_CANCELLED")).toBeVisible();
  await captureBand.getByRole("button", { name: "继续采集" }).click();
  await expect(captureBand.getByRole("button", { name: "暂停采集" })).toBeVisible();

  await page.getByRole("button", { name: "人工整理标题", exact: true }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("人工整理标题");
  await page.getByLabel("作者", { exact: true }).fill("林舟");
  await page.getByLabel("发布日期").fill("2025-05-06");
  await page.getByLabel("来源备注").fill("用于 M3 的来源核验。");
  await page.getByRole("button", { name: "保存来源信息" }).click();
  await expect(page.getByText("来源信息已保存。")).toBeVisible();

  await page.getByRole("button", { name: "设为收藏" }).click();
  await expect(page.getByRole("button", { name: "取消收藏" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("region", { name: "文档工作台" }).getByRole("button", { name: "归档", exact: true }).click();
  await expect(page.getByRole("button", { name: "取消归档" })).toBeVisible();

  await page.getByRole("button", { name: "管理分类" }).click();
  const collectionManager = page.getByRole("complementary", { name: "集合管理" });
  await collectionManager.getByLabel("新集合名称").fill("阅读清单");
  await collectionManager.getByRole("button", { name: "创建集合" }).click();
  await expect(collectionManager.getByText("阅读清单", { exact: true })).toBeVisible();
  await page.getByRole("group", { name: "集合" }).getByLabel("阅读清单").click();
  await expect(page.getByText("已加入集合。")).toBeVisible();
  await expect(page.getByRole("group", { name: "集合" }).getByLabel("阅读清单")).toBeChecked();
  await collectionManager.getByRole("button", { name: "重命名 阅读清单" }).click();
  await collectionManager.getByLabel("集合名称", { exact: true }).fill("研究清单");
  await collectionManager.getByRole("button", { name: "保存名称" }).click();
  await expect(page.getByText("集合已更名为“研究清单”。")).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "人工整理标题", exact: true }).click();
  await expect(page.getByLabel("作者", { exact: true })).toHaveValue("林舟");
  await expect(page.getByLabel("发布日期")).toHaveValue("2025-05-06");
  await expect(page.getByLabel("来源备注")).toHaveValue("用于 M3 的来源核验。");
  await expect(page.getByRole("button", { name: "取消收藏" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "取消归档" })).toBeVisible();
  await expect(page.getByRole("group", { name: "集合" }).getByLabel("研究清单")).toBeChecked();

  await page.getByRole("button", { name: "管理分类" }).click();
  const reloadedCollectionManager = page.getByRole("complementary", { name: "集合管理" });
  await reloadedCollectionManager.getByLabel("新集合名称").fill("临时集合");
  await reloadedCollectionManager.getByRole("button", { name: "创建集合" }).click();
  await page.getByRole("group", { name: "集合" }).getByLabel("临时集合").click();
  await expect(page.getByText("已加入集合。")).toBeVisible();
  const temporaryCollection = reloadedCollectionManager.getByRole("listitem").filter({ hasText: "临时集合" });
  await expect(temporaryCollection.getByText("1 篇知识")).toBeVisible();
  await temporaryCollection.getByRole("button", { name: "删除 临时集合" }).click();
  const deleteCollectionDialog = page.getByRole("alertdialog", { name: "删除集合" });
  await expect(deleteCollectionDialog).toContainText("临时集合");
  await expect(deleteCollectionDialog).toContainText("1 篇知识");
  await deleteCollectionDialog.getByRole("button", { name: "删除集合" }).click();
  await expect(page.getByText("已删除集合“临时集合”，从 1 篇知识中移除。")).toBeVisible();
  await expect(page.getByRole("group", { name: "集合" }).getByLabel("临时集合")).toHaveCount(0);

  let releaseStaleCollections!: () => void;
  let staleCollectionsReady = false;
  let staleCollectionsSettled = false;
  const staleCollectionsGate = new Promise<void>((resolve) => {
    releaseStaleCollections = resolve;
  });
  await page.route("**/api/collections", async (route) => {
    if (route.request().method() !== "GET" || staleCollectionsReady) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    staleCollectionsReady = true;
    await staleCollectionsGate;
    try {
      await route.fulfill({ response });
    } catch {
      // A successful collection mutation aborts this obsolete request.
    } finally {
      staleCollectionsSettled = true;
    }
  });
  await page.getByRole("button", { name: "数据安全" }).click();
  await page.getByRole("button", { name: "返回资料库" }).click();
  await expect.poll(() => staleCollectionsReady).toBe(true);
  const delayedCollectionManager = page.getByRole("complementary", { name: "集合管理" });
  await delayedCollectionManager.getByLabel("新集合名称").fill("延迟响应集合");
  await delayedCollectionManager.getByRole("button", { name: "创建集合" }).click();
  await expect(delayedCollectionManager.getByText("延迟响应集合", { exact: true })).toBeVisible();
  releaseStaleCollections();
  await expect.poll(() => staleCollectionsSettled).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(delayedCollectionManager.getByText("延迟响应集合", { exact: true })).toBeVisible();
  await page.unroute("**/api/collections");

  await page.getByRole("button", { name: "关闭分类管理" }).click();
  const libraryViews = page.getByRole("navigation", { name: "资料库视图" });
  await libraryViews.getByRole("button", { name: "收藏", exact: true }).click();
  const keyboardRow = page.getByRole("button", { name: "人工整理标题", exact: true });
  await expect(keyboardRow).toBeVisible();
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "帮助与关于" })).toBeVisible();
  await page.getByRole("button", { name: "关闭帮助" }).click();
  await keyboardRow.focus();
  await page.keyboard.press("x");
  await expect(page.getByLabel("选择 人工整理标题")).toBeChecked();
  await chooseUiOption(page, "批量操作", "取消归档");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.getByText("已处理当前页选中的 1 篇知识。")).toBeVisible();
  await page.getByRole("button", { name: "人工整理标题", exact: true }).click();
  await expect(page.getByRole("region", { name: "文档工作台" }).getByRole("button", { name: "归档", exact: true })).toBeVisible();

  let releaseMetadataPatch!: () => void;
  let metadataPatchStarted = false;
  let metadataPatchCount = 0;
  const metadataPatchGate = new Promise<void>((resolve) => {
    releaseMetadataPatch = resolve;
  });
  await page.route("**/api/documents/*", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "PATCH" && /^\/api\/documents\/[^/]+$/u.test(pathname)) {
      const body = request.postDataJSON() as { sourceNote?: string };
      if (body.sourceNote?.includes("关闭等待回归")) {
        metadataPatchCount += 1;
        if (metadataPatchCount === 1) {
          metadataPatchStarted = true;
          await metadataPatchGate;
        }
      }
    }
    await route.continue();
  });
  await page.getByLabel("来源备注").fill("关闭等待回归：不应用旧 revision 重复保存。");
  await page.getByRole("button", { name: "保存来源信息" }).click();
  await expect.poll(() => metadataPatchStarted).toBe(true);
  const metadataCloseAttemptId = "9002";
  const metadataCloseReady = page.waitForRequest((request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/desktop/close-ready") return false;
    return (request.postDataJSON() as { attemptId?: string }).attemptId === metadataCloseAttemptId;
  });
  await page.evaluate((attemptId) => {
    window.dispatchEvent(new CustomEvent("zhiye:close-requested", { detail: { attemptId } }));
  }, metadataCloseAttemptId);
  releaseMetadataPatch();
  await metadataCloseReady;
  expect(metadataPatchCount).toBe(1);
  await expect(page.getByLabel("来源备注")).toHaveValue("关闭等待回归：不应用旧 revision 重复保存。");
  await page.evaluate((attemptId) => {
    window.dispatchEvent(new CustomEvent("zhiye:close-timeout", { detail: { attemptId } }));
  }, metadataCloseAttemptId);
  await page.unroute("**/api/documents/*");

  let releaseOrganizationConflict!: () => void;
  let organizationPatchStarted = false;
  let conflictCloseReadyCount = 0;
  const organizationConflictGate = new Promise<void>((resolve) => {
    releaseOrganizationConflict = resolve;
  });
  await page.route("**/api/documents/*", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const body = request.method() === "PATCH" ? request.postDataJSON() as { favorite?: boolean } : {};
    if (!/^\/api\/documents\/[^/]+$/u.test(pathname) || typeof body.favorite !== "boolean") {
      await route.continue();
      return;
    }
    organizationPatchStarted = true;
    await organizationConflictGate;
    const current = await route.fetch({ method: "GET", headers: { Accept: "application/json" } });
    await route.fulfill({
      status: 409,
      headers: {
        "Content-Type": "application/json",
        "X-Zhiye-Data-Epoch": request.headers()["x-zhiye-data-epoch"],
      },
      body: JSON.stringify({ error: { code: "REVISION_CONFLICT", message: "conflict", document: await current.json() } }),
    });
  });
  page.on("request", (request) => {
    if (
      request.method() === "POST" && new URL(request.url()).pathname === "/api/desktop/close-ready" &&
      (request.postDataJSON() as { attemptId?: string }).attemptId === "9003"
    ) conflictCloseReadyCount += 1;
  });
  await page.getByRole("button", { name: "取消收藏" }).click();
  await expect.poll(() => organizationPatchStarted).toBe(true);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("zhiye:close-requested", { detail: { attemptId: "9003" } }));
  });
  releaseOrganizationConflict();
  await expect(page.getByText("关闭前无法保存更改：请先处理来源信息的版本冲突。")).toBeVisible();
  expect(conflictCloseReadyCount).toBe(0);
  await page.unroute("**/api/documents/*");
});

test("routes desktop capture and file intents through existing imports", async ({ page }) => {
  await page.addInitScript(() => {
    const coldIntents = [
      { kind: "capture", url: "https://example.com/desktop-deep-link" },
      { kind: "markdown", token: "desktop-markdown", name: "desktop-note.md" },
    ];
    let takes = 0;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: async (command: string, args?: { token?: string }) => {
          if (command === "take_external_intents") {
            takes += 1;
            if (takes === 1) return coldIntents.splice(0);
            if (takes === 2) {
              window.dispatchEvent(new Event("zhiye:external-intents-ready"));
              return [];
            }
            if (takes === 3) return [{ kind: "capture", url: "https://example.com/desktop-warm-link" }];
            return [];
          }
          if (command === "read_external_text" && args?.token === "desktop-markdown") {
            return { name: "desktop-note.md", content: "# 桌面 Markdown\n\n从 Finder 打开。" };
          }
          throw new Error(`Unexpected desktop command: ${command}`);
        },
      },
    });
  });
  await page.goto("/");
  await expect(page.getByLabel("文档标题")).toHaveValue("远端测试文章", { timeout: 8_000 });
  await expect.poll(() => page.evaluate(async () => {
    const value = await fetch("/api/documents?page=1").then((response) => response.json()) as {
      items: Array<{ sourceUrl: string }>;
    };
    return value.items.some((item) => item.sourceUrl === "https://example.com/desktop-warm-link");
  })).toBe(true);
  const dialog = page.getByRole("dialog", { name: "批量导入" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("已从桌面接收 1 个文件")).toBeVisible();
  await expect(dialog.getByText("已选择 1 个文件")).toBeVisible();
  await dialog.getByRole("button", { name: "检查导入内容" }).click();
  await expect(dialog.locator(".bulk-preview-list")).toContainText("desktop-note");
  await dialog.getByRole("button", { name: "确认导入" }).click();
  await expect(dialog.getByText(/新增 1/u)).toBeVisible();
});

test("desktop updater confirms, verifies a backup, reports progress, and keeps failures retryable", async ({ page }) => {
  await page.addInitScript(() => {
    type UpdaterHarness = {
      check: "none" | "available";
      download: "waiting" | "failed";
      calls: string[];
      releaseDownload?: () => void;
    };
    const harness: UpdaterHarness = { check: "none", download: "failed", calls: [] };
    Object.assign(window, { __UPDATER_TEST__: harness });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        transformCallback: () => 1,
        unregisterCallback: () => undefined,
        invoke: async (command: string, args?: { onEvent?: { onmessage: (event: unknown) => void } }) => {
          harness.calls.push(command);
          if (command === "take_external_intents") return [];
          if (command === "updater_configured") return new URL(location.href).searchParams.get("updater") !== "0";
          if (command === "plugin:resources|close") return undefined;
          if (command === "plugin:updater|check") {
            return harness.check === "none" ? null : {
              rid: 7,
              currentVersion: "0.9.0",
              version: "1.0.0",
              date: "2026-08-12T00:00:00Z",
              body: "签名正式版",
              rawJson: {},
            };
          }
          if (command === "plugin:updater|download_and_install") {
            args?.onEvent?.onmessage({ event: "Started", data: { contentLength: 100 } });
            args?.onEvent?.onmessage({ event: "Progress", data: { chunkLength: 25 } });
            if (harness.download === "failed") throw new Error("模拟下载中断");
            await new Promise<void>((resolve) => { harness.releaseDownload = resolve; });
            args?.onEvent?.onmessage({ event: "Progress", data: { chunkLength: 75 } });
            args?.onEvent?.onmessage({ event: "Finished" });
            return undefined;
          }
          if (command === "restart_after_update") return undefined;
          throw new Error(`Unexpected desktop command: ${command}`);
        },
      },
    });
  });
  await page.goto("/?updater=0");
  const deferOnboarding = page.getByRole("button", { name: "稍后设置" });
  if (await deferOnboarding.isVisible()) await deferOnboarding.click();
  await expect(page.locator(".masthead")).toBeVisible();
  await expect(page.getByRole("button", { name: "检查更新" })).toHaveCount(0);
  await page.goto("/");
  if (await deferOnboarding.isVisible()) await deferOnboarding.click();
  const updateButton = page.getByRole("button", { name: "检查更新" });
  await expect(updateButton).toBeVisible();

  await updateButton.click();
  await expect(page.getByText("当前已经是最新版本。")).toBeVisible();
  await page.getByRole("button", { name: "稍后", exact: true }).click();

  await page.evaluate(() => {
    (window as typeof window & { __UPDATER_TEST__: { check: string } }).__UPDATER_TEST__.check = "available";
  });
  await updateButton.click();
  await expect(page.getByText("v0.9.0 → v1.0.0")).toBeVisible();
  await page.getByRole("button", { name: "稍后", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "应用更新" })).toBeHidden();

  await page.route("**/api/data-safety/backups", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "BACKUP_FAILED", message: "模拟留档失败" } }) });
    } else await route.continue();
  });
  await updateButton.click();
  await page.getByRole("button", { name: "创建留档并更新" }).click();
  await expect(page.getByRole("alert")).toContainText("完整留档创建失败");
  expect(await page.evaluate(() => (window as typeof window & { __UPDATER_TEST__: { calls: string[] } }).__UPDATER_TEST__.calls.filter((value) => value === "plugin:updater|download_and_install").length)).toBe(0);
  await page.getByRole("button", { name: "稍后", exact: true }).click();
  await page.unroute("**/api/data-safety/backups");

  await updateButton.click();
  await page.getByRole("button", { name: "创建留档并更新" }).click();
  await expect(page.getByRole("alert")).toContainText("更新未完成");
  await page.getByRole("button", { name: "稍后", exact: true }).click();

  await page.evaluate(() => {
    (window as typeof window & { __UPDATER_TEST__: { download: string } }).__UPDATER_TEST__.download = "waiting";
  });
  await updateButton.click();
  await page.getByRole("button", { name: "创建留档并更新" }).click();
  await expect(page.getByText("正在下载并验证签名… 25%")).toBeVisible();
  await page.evaluate(() => {
    (window as typeof window & { __UPDATER_TEST__: { releaseDownload?: () => void } }).__UPDATER_TEST__.releaseDownload?.();
  });
  await expect(page.getByText("更新已安装，正在安全保存并重新启动…")).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { __UPDATER_TEST__: { calls: string[] } }).__UPDATER_TEST__.calls)).toContain("restart_after_update");
});

test("debounces automatic document saves until 20 seconds idle", async ({ page }) => {
  await page.goto("/");
  const deferOnboarding = page.getByRole("button", { name: "稍后设置" });
  if (await deferOnboarding.isVisible()) await deferOnboarding.click();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("dialog", { name: "新建" }).getByRole("button", { name: "创建文章" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("未命名文章");

  await page.clock.install();
  const patches: Array<{ title?: string; markdown?: string; tags?: string[] }> = [];
  page.on("request", (request) => {
    if (request.method() !== "PATCH" || !/^\/api\/documents\/[^/]+$/u.test(new URL(request.url()).pathname)) return;
    patches.push(request.postDataJSON() as { title?: string; markdown?: string; tags?: string[] });
  });
  const editor = page.getByLabel("Markdown 编辑器");
  await editor.fill("# 第一版");
  await expect(page.getByText("未保存", { exact: true })).toBeVisible();
  await page.clock.runFor(0);
  await page.clock.fastForward(10_000);
  expect(patches).toEqual([]);

  await editor.fill("# 第二版");
  await page.clock.runFor(0);
  await page.clock.fastForward(9_000);
  expect(patches).toEqual([]);

  const automaticSave = page.waitForResponse((response) =>
    response.ok() && response.request().method() === "PATCH" && /^\/api\/documents\/[^/]+$/u.test(new URL(response.url()).pathname) &&
    (response.request().postDataJSON() as { markdown?: string }).markdown === "# 第二版",
  );
  await page.clock.fastForward(1_000);
  await automaticSave;
  expect(patches).toHaveLength(1);
  expect(patches[0]).toMatchObject({ markdown: "# 第二版", tags: [] });
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();

  const title = page.getByLabel("文档标题");
  const tags = page.getByPlaceholder("用逗号分隔");
  const metadataSave = page.waitForResponse((response) => {
    const body = response.request().postDataJSON() as { title?: string; tags?: string[] };
    return response.ok() && response.request().method() === "PATCH" && /^\/api\/documents\/[^/]+$/u.test(new URL(response.url()).pathname) &&
      body.title === "自动标题" && Boolean(body.tags?.includes("自动标签"));
  });
  await title.fill("自动标题");
  await tags.fill("自动标签");
  await page.clock.runFor(0);
  await page.clock.fastForward(19_000);
  expect(patches).toHaveLength(1);
  await page.clock.fastForward(1_000);
  await metadataSave;
  expect(patches).toHaveLength(2);

  const manualSave = page.waitForResponse((response) =>
    response.ok() && response.request().method() === "PATCH" && /^\/api\/documents\/[^/]+$/u.test(new URL(response.url()).pathname) &&
    (response.request().postDataJSON() as { markdown?: string }).markdown === "# 手动保存",
  );
  await editor.fill("# 手动保存");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await manualSave;
  expect(patches).toHaveLength(3);
});
