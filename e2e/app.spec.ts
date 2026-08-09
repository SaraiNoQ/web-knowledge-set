import { expect, test } from "@playwright/test";

test("imports, restores history, trashes, restores, searches, exports, and blocks raw scripts", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("网页地址").fill("https://example.com/requested");
  await page.getByRole("button", { name: "收取网页" }).click();

  await expect(page.getByLabel("文档标题")).toHaveValue("远端测试文章", { timeout: 8_000 });
  await expect(page.getByRole("heading", { name: "抓取成功" })).toBeVisible();
  await expect(page.getByText("外部图片已隐藏：追踪像素")).toBeVisible();
  await expect(page.locator(".markdown-preview img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { __zhiyeXss?: boolean }).__zhiyeXss)).toBeUndefined();

  await page.evaluate(async () => {
    const list = await fetch("/api/documents?page=1").then((response) => response.json()) as {
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
      headers: { "Content-Type": "application/json" },
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
    const list = await fetch("/api/documents?page=1").then((response) => response.json()) as {
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
      headers: { "Content-Type": "application/json" },
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
  await expect(page.getByText("已保存", { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "修订历史" }).click();
  await expect(page.getByRole("heading", { name: "修订历史" })).toBeVisible();
  const firstRevision = page.getByRole("listitem").filter({ hasText: "第一版正文" });
  await expect(firstRevision).toBeVisible();
  await page.evaluate(async () => {
    const list = await fetch("/api/documents?page=1").then((response) => response.json()) as {
      items: Array<{ id: string }>;
    };
    const document = await fetch(`/api/documents/${list.items[0].id}`).then((response) => response.json()) as {
      id: string;
      revision: number;
    };
    await fetch(`/api/documents/${document.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: document.revision, title: "另一窗口更新" }),
    });
  });
  await firstRevision.getByRole("button", { name: "恢复此版本" }).click();
  await expect(page.getByText("这篇知识在别处被修改过")).toBeVisible();
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
    const list = await fetch("/api/documents?page=1").then((response) => response.json()) as {
      items: Array<{ id: string }>;
    };
    await fetch(`/api/documents/${list.items[0].id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
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
  await page.getByRole("button", { name: "恢复到资料库" }).click();
  await expect(page.getByRole("button", { name: "资料库", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("文档标题")).toBeEnabled();

  await page.reload();
  await page.getByRole("button", { name: /人工整理标题/ }).click();
  await expect(page.getByLabel("文档标题")).toHaveValue("人工整理标题");
  await expect(page.getByRole("heading", { name: "第一版" })).toBeVisible();
  await page.getByPlaceholder("搜索标题与正文").fill("第一版正文");
  await expect(page.getByRole("button", { name: /人工整理标题/ })).toBeVisible();
});
