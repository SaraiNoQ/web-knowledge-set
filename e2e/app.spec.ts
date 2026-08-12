import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const readyImageUrl = "https://assets.example.test/ready.png";
const failedImageUrl = "https://assets.example.test/failed.png";

test("keeps first-run setup local, deferrable, and durable", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /你的知识/u })).toBeVisible();
  await page.getByRole("button", { name: "稍后设置" }).click();
  await expect(page.getByLabel("网页地址")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: /你的知识/u })).toBeVisible();
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByRole("heading", { name: /稳定的位置/u })).toBeVisible();
  await expect(page.getByText("KB_DATA_DIR=/你的/知识库目录 pnpm start")).toBeVisible();
  await page.getByRole("button", { name: "继续" }).click();
  await page.getByRole("button", { name: "继续" }).click();
  await page.getByRole("button", { name: "进入资料库" }).click();
  await expect(page.getByLabel("网页地址")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("网页地址")).toBeVisible();
  await expect(page.getByRole("heading", { name: /你的知识/u })).toBeHidden();
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
  await page.getByLabel("网页地址").focus();
  await expect(page.getByLabel("网页地址")).toBeFocused();
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
  const modelRequests: string[] = [];
  await page.route("https://model.example.test/**", async (route) => {
    modelRequests.push(route.request().url());
    await route.abort();
  });
  await page.goto("/");
  await page.getByLabel("网页地址").fill("https://example.com/ai-lifecycle");
  await page.getByRole("button", { name: "收取网页" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("AI 生命周期文章", { timeout: 8_000 });

  await page.getByRole("button", { name: "AI 设置", exact: true }).click();
  await page.getByRole("button", { name: "可信本地端点" }).click();
  await page.getByLabel("AI 本地端点地址").fill("http://127.0.0.1:4175/v1/chat/completions");
  await page.getByLabel("AI 本地模型").fill("fake-e2e-model");
  await page.getByText("我信任这个本机端点", { exact: false }).click();
  await page.getByText("允许 AI 派生知识", { exact: true }).click();
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("AI 派生已启用。", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "返回资料库" }).click();

  await page.getByRole("button", { name: "AI 派生", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "AI 派生知识" });
  await panel.getByRole("button", { name: "预览摘要发送范围" }).click();
  await expect(panel.getByLabel("将发送给模型的准确文本")).toContainText("AI 生命周期文章");
  await expect(panel.getByText("http://127.0.0.1:4175/v1/chat/completions")).toBeVisible();
  await panel.getByText("我已核对上方准确文本", { exact: false }).click();
  await panel.getByRole("button", { name: "确认发送并生成" }).click();
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
  await panel.getByRole("button", { name: "标签建议", exact: true }).click();
  await panel.getByRole("button", { name: "预览标签建议发送范围" }).click();
  await panel.getByText("我已核对上方准确文本", { exact: false }).click();
  await panel.getByRole("button", { name: "确认发送并生成" }).click();
  const suggested = panel.getByLabel("#人工智能");
  await expect(suggested).toBeVisible({ timeout: 5_000 });
  await expect(suggested).not.toBeChecked();
  await suggested.check();
  await panel.getByRole("button", { name: "采纳所选标签" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("AI 生命周期文章");
  await expect(page.locator(".tag-field input")).toHaveValue(/人工智能/u);

  await page.getByRole("button", { name: "AI 设置", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "关闭 AI 并删除全部结果" }).click();
  await expect(page.getByText(/AI 已关闭，并删除 2 条派生结果/u)).toBeVisible();
  await page.getByRole("button", { name: "返回资料库" }).click();
  await page.getByRole("button", { name: "AI 派生", exact: true }).click();
  await expect(page.getByText("还没有派生结果。", { exact: false })).toBeVisible();
});

test("imports, restores history, trashes, restores, searches, exports, and blocks raw scripts", async ({ page }) => {
  const remoteImageRequests: string[] = [];
  await page.route("https://assets.example.test/**", async (route) => {
    remoteImageRequests.push(route.request().url());
    await route.abort();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "数据安全" }).click();
  await expect(page.getByRole("heading", { name: "数据安全" })).toBeVisible();
  await page.getByRole("button", { name: "创建留档" }).click();
  await expect(page.getByText("完整留档已创建并校验。")).toBeVisible();
  await expect(page.getByText("校验通过").first()).toBeVisible();
  await page.getByRole("button", { name: "返回资料库" }).click();
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
  await page.getByRole("button", { name: /远端测试文章/ }).click();
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
  await expect(page.getByText("已保存", { exact: true })).toBeVisible({ timeout: 5_000 });

  const titleEditor = page.getByLabel("文档标题");
  await titleEditor.fill("  人工整理标题  ");
  const editor = page.getByLabel("Markdown 编辑器");
  await editor.click();
  await editor.press("Control+A");
  await editor.fill("# 第一版\n\n第一版正文");
  await page.getByPlaceholder("用逗号分隔").fill("测试, 本地");
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
  await page.getByRole("button", { name: /人工整理标题/ }).click();
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
  await expect.poll(() => undoPutStarted).toBe(true);
  await editor.fill(firstMarkdown);
  const undoPutResponse = page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() !== "PUT" || !new URL(request.url()).pathname.endsWith("/draft")) return false;
    return (request.postDataJSON() as { markdown?: string }).markdown?.includes(undoneMarker) ?? false;
  });
  releaseUndoPut();
  await undoPutResponse;
  await expect.poll(() => undoDeleteStarted).toBe(true);
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    return { dispatched: window.dispatchEvent(event), prevented: event.defaultPrevented };
  })).toEqual({ dispatched: false, prevented: true });
  const undoDeleteResponse = page.waitForResponse((response) =>
    response.request().method() === "DELETE" && new URL(response.url()).pathname.endsWith("/draft")
  );
  releaseUndoDelete();
  await undoDeleteResponse;
  await expect.poll(currentStoredDraft).toBeNull();
  await page.unroute("**/api/documents/*/draft");
  await page.reload();
  await page.getByRole("button", { name: /人工整理标题/ }).click();
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
  await page.getByRole("button", { name: /另一窗口更新/ }).click();
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
  await expect(page.getByText("这篇知识已被移入回收站")).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "保留我的修改" }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByLabel("Markdown 预览").getByText("删除冲突后仍保留。")).toBeVisible();

  const downloadStarted = page.waitForEvent("download");
  await page.getByRole("link", { name: /导出 \.md/ }).click();
  expect((await downloadStarted).suggestedFilename()).toMatch(/\.md$/u);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("移入回收站");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "移入回收站" }).click();
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
  await page.getByRole("button", { name: /人工整理标题/ }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("人工整理标题");
  await expect(page.getByRole("heading", { name: "第一版" })).toBeVisible();
  await page.getByPlaceholder("搜索标题与正文").fill("第一版正文");
  await expect(page.getByRole("button", { name: /人工整理标题/ })).toBeVisible();

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
  await page.getByRole("button", { name: /人工整理标题/ }).click();
  await page.getByRole("button", { name: /远端测试文章/ }).click();
  await expect(page.locator(".duplicate-banner")).toHaveCount(0);

  await page.reload();
  await page.getByRole("button", { name: /远端测试文章/ }).click();
  const duplicateBanner = page.locator(".duplicate-banner");
  await expect(duplicateBanner.getByText("发现另一篇相同来源的知识")).toBeVisible();
  await expect(duplicateBanner.getByRole("button", { name: "打开已有" })).toBeVisible();
  await duplicateBanner.getByRole("button", { name: "打开已有" }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("人工整理标题");
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await expect(page.getByRole("button", { name: "回收站", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.getByRole("button", { name: /远端测试文章/ }).click();
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

  await page.getByRole("button", { name: /人工整理标题/ }).click();
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
  await page.getByRole("button", { name: /人工整理标题/ }).click();
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
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("临时集合");
    expect(dialog.message()).toContain("1 篇知识");
    await dialog.accept();
  });
  await temporaryCollection.getByRole("button", { name: "删除 临时集合" }).click();
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
  const keyboardRow = page.getByRole("button", { name: /人工整理标题/ });
  await expect(keyboardRow).toBeVisible();
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "快捷键" })).toBeVisible();
  await page.getByRole("button", { name: "关闭快捷键" }).click();
  await keyboardRow.focus();
  await page.keyboard.press("x");
  await expect(page.getByLabel("选择 人工整理标题")).toBeChecked();
  await page.getByLabel("批量操作", { exact: true }).selectOption("unarchive");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.getByText("已处理当前页选中的 1 篇知识。")).toBeVisible();
  await page.getByRole("button", { name: /人工整理标题/ }).click();
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
  await expect(page.getByRole("alert")).toContainText("模拟留档失败");
  expect(await page.evaluate(() => (window as typeof window & { __UPDATER_TEST__: { calls: string[] } }).__UPDATER_TEST__.calls.filter((value) => value === "plugin:updater|download_and_install").length)).toBe(0);
  await page.getByRole("button", { name: "稍后", exact: true }).click();
  await page.unroute("**/api/data-safety/backups");

  await updateButton.click();
  await page.getByRole("button", { name: "创建留档并更新" }).click();
  await expect(page.getByRole("alert")).toContainText("模拟下载中断");
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
