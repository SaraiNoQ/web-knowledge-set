import { expect, test } from "@playwright/test";

for (const cloud of [false, true]) test(`split preview navigates to source in ${cloud ? "web" : "local"} mode`, async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  if (cloud) await page.route("**/health", (route) => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `预览定位-${cloud}-${Date.now()}`;
  const { document } = await (await request.post("/api/documents", { headers, data: { title } })).json();
  const markdown = `# 开头\n\n${"重复段落。\n\n".repeat(60)}## 目标标题\n\n含有 **加粗目标** 的正文。\n\n- 首项\n- 列表目标\n\n> 引用目标\n\n\`\`\`js\nconst target = 1;\n\`\`\`\n\n| 表头 |\n| --- |\n| 单元目标 |\n\n公式 $x^2$。\n\n重复段落。\n\n[外部链接](https://example.test/)\n`;
  expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { markdown, revision: document.revision } })).ok()).toBe(true);
  await page.goto("/");
  await page.locator(".directory-document-row").getByRole("button", { name: title, exact: true }).click();
  if (cloud) await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "边写边看", exact: true }).click();
  const preview = page.locator(".preview-pane .markdown-preview");
  const editor = page.getByRole("textbox", { name: "Markdown 编辑器" });
  const scroller = page.locator(".cm-scroller");
  const cases = [
    { target: preview.getByRole("heading", { name: "目标标题" }), offset: markdown.indexOf("## 目标标题") },
    { target: preview.locator("strong"), offset: markdown.indexOf("**加粗目标**") },
    { target: preview.getByText("列表目标", { exact: true }), offset: markdown.indexOf("- 列表目标") },
    { target: preview.getByText("引用目标", { exact: true }), offset: markdown.indexOf("引用目标") },
    { target: preview.locator("pre code"), offset: markdown.indexOf("```js") },
    { target: preview.getByRole("cell", { name: "单元目标" }), offset: markdown.indexOf("| 单元目标") },
    { target: preview.locator("p").filter({ hasText: "公式" }), offset: markdown.indexOf("公式") },
    { target: preview.getByText("重复段落。", { exact: true }).last(), offset: markdown.lastIndexOf("重复段落。") },
  ];
  for (const { target, offset } of cases) {
    await scroller.evaluate((element) => { element.scrollTop = 0; });
    await target.click();
    await expect(editor).toBeFocused();
    await expect(page.locator(".cm-activeLineGutter")).toHaveText(String(markdown.slice(0, offset).split("\n").length));
    await expect.poll(() => editor.evaluate((element) => {
      const selection = window.getSelection()!;
      const line = selection.anchorNode?.parentElement?.closest(".cm-line");
      if (!line || !element.contains(line)) return null;
      const range = document.createRange();
      range.selectNodeContents(line);
      range.setEnd(selection.anchorNode!, selection.anchorOffset);
      return { before: range.toString(), visible: line.getBoundingClientRect().top >= element.closest(".cm-scroller")!.getBoundingClientRect().top && line.getBoundingClientRect().bottom <= element.closest(".cm-scroller")!.getBoundingClientRect().bottom };
    })).toEqual({ before: markdown.slice(markdown.lastIndexOf("\n", offset - 1) + 1, offset), visible: true });
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  }
  // Selecting preview text must leave the source caret and focus alone.
  const paragraph = preview.getByText("重复段落。", { exact: true }).last();
  await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("重复段落。");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const link = preview.getByRole("link", { name: "外部链接" });
  await expect(link).toHaveAttribute("href", "https://example.test/");
  await expect(link).toHaveAttribute("target", "_blank");
  await page.route("https://example.test/", (route) => route.fulfill({ body: "link target" }));
  const popupPromise = page.waitForEvent("popup");
  await link.click();
  await (await popupPromise).close();
  await expect(editor).not.toBeFocused();
  // Source positions must follow unsaved edits, including repeated text.
  await editor.fill(`前言。\n\n${markdown}`);
  await preview.getByRole("heading", { name: "目标标题" }).click();
  await expect(editor).toBeFocused();
  await expect(page.locator(".cm-activeLineGutter")).toHaveText(String(markdown.slice(0, markdown.indexOf("## 目标标题")).split("\n").length + 2));
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(preview.locator("[data-source-offset]")).toHaveCount(0);
});
