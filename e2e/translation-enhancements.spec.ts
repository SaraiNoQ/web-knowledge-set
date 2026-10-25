import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

async function selectParagraph(page: Page, index = 0) {
  await page.locator(".reader-main .markdown-preview p").nth(index).evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
}
test.beforeEach(async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.addInitScript(() => { localStorage.setItem("zhiye.reader-tools.enabled", '["translation"]'); });
  const response = await request.get("/api/settings/llm"), settings = await response.json();
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": response.headers()["x-zhiye-data-epoch"] };
  expect((await request.put("/api/settings/llm", { headers, data: { enabled: true, target: "local", remote: settings.remote,
    local: { endpointUrl: "http://127.0.0.1:4175", model: "e2e", trusted: true }, revision: settings.revision } })).ok()).toBe(true);
  const title = `翻译增强${Date.now()}`;
  const { document } = await (await request.post("/api/documents", { headers, data: { title } })).json();
  expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { revision: document.revision, markdown: "knowledge map improves reading.\n\nThe second selected passage." } })).ok()).toBe(true);
  await page.goto("/"); await page.getByRole("button", { name: title, exact: true }).click();
  await selectParagraph(page); await page.getByRole("toolbar", { name: "选区操作" }).getByRole("button", { name: "翻译", exact: true }).click();
});

test("glossary import/export preserves existing terms and cache varies by glossary and language", async ({ page }, testInfo) => {
  const panel = page.getByRole("dialog", { name: "划词翻译", exact: true });
  const requests: Array<{ text: string; language: string; glossary?: Array<{ source: string; target: string }> }> = [];
  await page.route("**/api/reader-tools/documents/*/translate", async (route) => {
    const input = route.request().postDataJSON(); requests.push(input);
    await route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ type: "delta", text: `${input.language}:${input.glossary?.[0]?.target ?? input.text}` }) + '\n{"type":"done"}\n' });
  });
  await panel.locator(".translation-glossary summary").click();
  await panel.getByRole("textbox", { name: "原词", exact: true }).fill("knowledge map");
  await panel.getByRole("textbox", { name: "首选译法", exact: true }).fill("知识地图");
  await panel.getByRole("button", { name: "添加术语", exact: true }).click();
  await expect(panel.locator(".translation-glossary summary")).toHaveText("术语表（1）");
  await panel.getByRole("button", { name: "翻译选区", exact: true }).click();
  await expect(panel.getByLabel("选区译文")).toHaveText("zh-CN:知识地图");
  expect(requests[0]?.glossary).toEqual([{ source: "knowledge map", target: "知识地图" }]);
  await panel.getByRole("button", { name: "翻译选区", exact: true }).click();
  await expect(panel.getByRole("button", { name: "保存译文摘录" })).toBeEnabled(); expect(requests).toHaveLength(1);
  const download = page.waitForEvent("download"); await panel.getByRole("button", { name: "导出术语", exact: true }).click();
  const file = await download; expect(file.suggestedFilename()).toBe("zhiye-glossary.json");
  expect(JSON.parse(readFileSync((await file.path())!, "utf8"))).toEqual({ format: "zhiye-glossary", schemaVersion: 1, terms: [{ source: "knowledge map", target: "知识地图" }] });
  await panel.getByLabel("导入术语文件").setInputFiles({ name: "conflict.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "zhiye-glossary", schemaVersion: 1, terms: [{ source: "knowledge map", target: "冲突译法" }] })) });
  await expect(panel.getByRole("alert")).toContainText("不同译法"); await expect(panel.locator(".translation-glossary summary")).toHaveText("术语表（1）");
  await panel.getByRole("textbox", { name: "原词", exact: true }).fill("reading"); await panel.getByRole("textbox", { name: "首选译法", exact: true }).fill("阅读"); await panel.getByRole("button", { name: "添加术语", exact: true }).click();
  await panel.getByRole("button", { name: "翻译选区", exact: true }).click(); await expect.poll(() => requests.length).toBe(2); await expect(panel.getByRole("button", { name: "保存译文摘录" })).toBeEnabled();
  await panel.getByRole("combobox", { name: "目标语言", exact: true }).click(); await page.getByRole("option", { name: "English", exact: true }).click();
  await panel.getByRole("button", { name: "翻译选区", exact: true }).click(); await expect.poll(() => requests.length).toBe(3); await expect(panel.getByLabel("选区译文")).toHaveText("en:知识地图");
  await page.screenshot({ path: testInfo.outputPath("translation-glossary.png") });
});

test("automatic translation is opt-in, cancels old selections and ignores late output", async ({ page }) => {
  const panel = page.getByRole("dialog", { name: "划词翻译", exact: true });
  const requests: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/reader-tools/documents/*/translate", async (route) => {
    const text = route.request().postDataJSON().text as string; requests.push(text);
    if (text.startsWith("knowledge")) await held;
    await route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ type: "delta", text: text.startsWith("knowledge") ? "late A" : "current B" }) + '\n{"type":"done"}\n' }).catch(() => undefined);
  });
  const automatic = panel.getByRole("checkbox", { name: "稳定选区后自动翻译", exact: true }); await expect(automatic).not.toBeChecked();
  // Wait longer than the stable-selection delay to prove the default makes no request.
  await page.waitForTimeout(700); expect(requests).toHaveLength(0);
  await automatic.check();
  try {
    await expect.poll(() => requests.length).toBe(1);
    await selectParagraph(page, 1);
    await expect(panel.getByLabel("待翻译选区")).toHaveText("The second selected passage.");
    await expect.poll(() => requests.length).toBe(2); await expect(panel.getByLabel("选区译文")).toHaveText("current B");
  } finally { release(); }
  await expect(panel.getByLabel("选区译文")).toHaveText("current B");
  await automatic.uncheck(); await expect(panel.getByRole("button", { name: "保存译文摘录" })).toBeEnabled();
  await selectParagraph(page); await page.waitForTimeout(700); expect(requests).toHaveLength(2);
});
