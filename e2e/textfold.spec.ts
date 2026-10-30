import { expect, test } from "@playwright/test";

test("saved articles generate reading levels, switch from split, retain originals and survive navigation", async ({ page, request }) => {
  const errors: string[] = [];
  let generations = 0;
  page.on("response", response => { if (response.ok() && response.request().method() === "POST" && response.url().endsWith("/derived-task")) generations++; });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/settings/onboarding", route => route.fulfill({ json: { completed: true, revision: 1 } }));
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `分层阅读${Date.now()}`;
  const { document } = await (await request.post("/api/documents", { headers, data: { title } })).json();
  const text = "研究发现这种方法可以减少处理时间，但只在测试数据上得到验证。实际部署仍然需要考虑网络延迟和输入数据的差异。因此我们建议先完成小规模测试，再决定是否扩大应用范围。";
  const markdown = `# 方法\n\n${text.replace("这种方法", "**这种方法**")}\n\n> ${text}\n\n- ${text}\n\n\`\`\`js\nconst preserved = true;\n\`\`\``;
  expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { markdown, revision: document.revision } })).ok()).toBe(true);
  await page.goto("/");
  await page.locator(".directory-document-row").getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "边写边看", exact: true }).click();
  const levels = page.getByRole("combobox", { name: "阅读层级", exact: true });
  await expect(levels).toBeVisible({ timeout: 20000 });
  await levels.click();
  await page.getByRole("option", { name: "精简原句", exact: true }).click();
  await expect(page.locator(".markdown-preview strong")).toHaveText("这种方法");
  await expect(page.locator(".markdown-preview")).not.toContainText("实际部署");
  await expect(page.locator(".markdown-preview blockquote")).toContainText("研究发现");
  await expect(page.locator(".markdown-preview li")).toContainText("研究发现");
  await levels.click();
  await page.getByRole("option", { name: "要点", exact: true }).click();
  await expect(page.locator(".markdown-preview")).toContainText("方法在测试中更快。 部署前需要验证。");
  await levels.click();
  await page.getByRole("option", { name: "结论", exact: true }).click();
  await expect(page.locator(".markdown-preview")).toContainText("方法在测试中更快。");
  await expect(page.locator(".markdown-preview")).not.toContainText("部署前需要验证。");
  await levels.click();
  await page.getByRole("option", { name: "主题", exact: true }).click();
  await expect(page.locator(".markdown-preview")).toContainText("方法验证");
  await expect(page.locator(".markdown-preview")).toContainText("const preserved = true;");
  await expect(page.getByRole("textbox", { name: "Markdown 编辑器" })).toHaveCount(0);
  await page.evaluate(id => window.dispatchEvent(new CustomEvent("zhiye:reader-anchor", { detail: { documentId: id } })), document.id);
  await expect(page.locator(".markdown-preview")).toContainText(text);
  const saved = await (await request.get(`/api/documents/${document.id}`)).json();
  expect(saved.document?.markdown ?? saved.markdown).toBe(markdown);
  expect(generations).toBe(1);
  await page.reload();
  await page.locator(".directory-document-row").getByRole("button", { name: title, exact: true }).click();
  await expect(levels).toBeVisible({ timeout: 15000 });
  await expect(levels).toContainText("原文");
  expect(generations).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/zhiye-textfold-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "/tmp/zhiye-textfold-desktop.png", fullPage: true });
  const secondTitle = `第二篇${Date.now()}`;
  await request.post("/api/documents", { headers, data: { title: secondTitle } });
  await page.reload();
  await page.locator(".directory-document-row").getByRole("button", { name: secondTitle, exact: true }).click();
  await expect(page.locator(".markdown-preview")).toHaveCount(0);
  await page.locator(".directory-document-row").getByRole("button", { name: title, exact: true }).click();
  await expect(levels).toBeVisible();
  expect(errors).toEqual([]);
});


test("busy reading levels resume automatically and stop retrying after navigating away", async ({ page, request }) => {
  await page.route("**/api/settings/onboarding", route => route.fulfill({ json: { completed: true, revision: 1 } }));
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const settings = await (await request.get("/api/settings/llm")).json();
  expect((await request.put("/api/settings/llm", { headers, data: { enabled: true, target: "local", remote: settings.remote,
    local: { endpointUrl: "http://127.0.0.1:4175", model: "e2e", trusted: true }, revision: settings.revision } })).ok()).toBe(true);
  const text = "研究发现这种方法可以减少处理时间，但只在测试数据上得到验证。实际部署仍然需要考虑网络延迟和输入数据的差异。因此我们建议先完成小规模测试，再决定是否扩大应用范围。";
  const documents: Array<{ id: string; title: string }> = [];
  for (const suffix of ["A", "B"]) {
    const { document } = await (await request.post("/api/documents", { headers, data: { title: `等待分层${Date.now()}${suffix}` } })).json();
    expect((await request.patch(`/api/documents/${document.id}`, { headers, data: { markdown: text, revision: document.revision } })).ok()).toBe(true);
    documents.push(document);
  }
  let attemptsA = 0, attemptsB = 0, cancellations = 0, available = false;
  page.on("request", request => { if (request.method() === "DELETE" && request.url().includes("/api/derived-tasks/")) cancellations++; });
  await page.route("**/api/documents/*/derived-task", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    const first = route.request().url().includes(documents[0].id);
    if (first) attemptsA++; else attemptsB++;
    if (first || !available || attemptsB <= 2) await route.fulfill({ status: 409, json: { error: { code: "LLM_BUSY", message: "助手正在处理其他任务，请稍候。" } } });
    else await route.continue();
  });
  await page.goto("/");
  await page.locator(".directory-document-row").getByRole("button", { name: documents[0].title, exact: true }).click();
  await expect(page.getByRole("button", { name: "等待模型空闲…", exact: true })).toBeDisabled();
  expect(attemptsA).toBeGreaterThan(0);
  await page.locator(".directory-document-row").getByRole("button", { name: documents[1].title, exact: true }).click();
  const priorAttemptsA = attemptsA;
  await expect(page.getByRole("button", { name: "等待模型空闲…", exact: true })).toBeDisabled();
  expect(attemptsB).toBeGreaterThan(0);
  available = true;
  await expect(page.getByRole("combobox", { name: "阅读层级", exact: true })).toBeVisible({ timeout: 15000 });
  expect(attemptsB).toBeGreaterThan(2);
  expect(attemptsA).toBe(priorAttemptsA);
  expect(cancellations).toBe(0);
  await expect(page.getByRole("button", { name: "重试阅读分层", exact: true })).toHaveCount(0);
});

test("reopening a document joins its matching running fold without starting another task", async ({ page, request }) => {
  await page.route("**/api/settings/onboarding", route => route.fulfill({ json: { completed: true, revision: 1 } }));
  const listing = await request.get("/api/documents"), headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const settings = await (await request.get("/api/settings/llm")).json();
  expect((await request.put("/api/settings/llm", { headers, data: { enabled: true, target: "local", remote: settings.remote,
    local: { endpointUrl: "http://127.0.0.1:4175", model: "e2e", trusted: true }, revision: settings.revision } })).ok()).toBe(true);
  const { document } = await (await request.post("/api/documents", { headers, data: { title: `接续分层${Date.now()}` } })).json();
  const markdown = "研究发现这种方法可以减少处理时间，但只在测试数据上得到验证。实际部署仍然需要考虑网络延迟和输入数据的差异。因此我们建议先完成小规模测试，再决定是否扩大应用范围。";
  const saved = await (await request.patch(`/api/documents/${document.id}`, { headers, data: { markdown, revision: document.revision } })).json();
  const source = saved.document ?? saved;
  const preview = await (await request.post(`/api/documents/${document.id}/derived-preview`, { headers, data: { type: "summary", revision: source.revision, customPrompt: "zhiye:textfold:v2" } })).json();
  const pending = await (await request.post(`/api/documents/${document.id}/derived-task`, { headers, data: preview })).json();
  expect(pending.status).toBe("running");
  let starts = 0, joins = 0, polls = 0;
  // Replay the real pending snapshot so reuse is exercised even if the model finishes before the page opens.
  await page.route(`**/api/documents/${document.id}/derived-results?*`, route => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 20 } }));
  await page.route(`**/api/documents/${document.id}/derived-task`, async route => {
    if (route.request().method() === "GET") { joins++; await route.fulfill({ json: pending }); }
    else { starts++; await route.continue(); }
  });
  await page.route(`**/api/derived-tasks/${pending.id}`, async route => { polls++; await route.continue(); });
  await page.goto("/");
  await page.locator(".directory-document-row").getByRole("button", { name: document.title, exact: true }).click();
  await expect(page.getByRole("combobox", { name: "阅读层级", exact: true })).toBeVisible({ timeout: 15000 });
  expect(joins).toBe(1);
  expect(polls).toBeGreaterThan(0);
  expect(starts).toBe(0);
});
