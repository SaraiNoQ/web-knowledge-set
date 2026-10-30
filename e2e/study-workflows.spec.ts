import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
});

test("research topics collect documents and excerpts, preserve notes, and show clickable answer evidence", async ({ page, request }, testInfo) => {
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const suffix = Date.now(), documentTitle = `研究资料${suffix}`, topicName = `研究问题${suffix}`, quote = "Graph learning uses shared representations.";
  const created = await (await request.post("/api/documents", { headers, data: { title: documentTitle } })).json();
  const document = await (await request.patch(`/api/documents/${created.document.id}`, { headers, data: { revision: created.document.revision, markdown: quote } })).json();
  const source = document.document ?? document;
  expect((await request.post(`/api/reader-tools/documents/${source.id}/annotations`, { headers, data: { revision: source.revision, anchor: { quote, prefix: "", suffix: "", source: "preview" }, note: "可共享表征", translation: "图学习使用共享表征。" } })).ok()).toBe(true);
  await page.goto("/"); await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "研究", exact: true }).click();
  const workspace = page.getByRole("region", { name: "研究工作台" });
  await workspace.getByRole("button", { name: "新建专题", exact: true }).click();
  const prompt = page.getByRole("dialog", { name: "新建专题", exact: true }); await prompt.getByRole("textbox", { name: "专题名称", exact: true }).fill(topicName); await prompt.getByRole("button", { name: "确认", exact: true }).click();
  await expect(workspace.getByRole("heading", { name: topicName, exact: true })).toBeVisible();
  await workspace.getByRole("textbox", { name: "查找资料", exact: true }).fill(documentTitle); await workspace.getByRole("button", { name: `加入专题资料：${documentTitle}`, exact: true }).click();
  await expect(workspace.getByRole("region", { name: "专题资料" }).getByRole("button", { name: documentTitle, exact: true })).toBeVisible();
  await workspace.getByRole("textbox", { name: "笔记", exact: true }).fill("这些资料支持可共享表征，仍需核实其边界。"); await workspace.getByRole("button", { name: "保存专题笔记", exact: true }).click(); await expect(workspace.getByRole("button", { name: "保存专题笔记", exact: true })).toBeDisabled();
  await workspace.getByText("从已有摘录加入", { exact: true }).click(); await workspace.getByRole("button", { name: `加入专题摘录：${quote.slice(0, 20)}`, exact: true }).click();
  await expect(workspace.getByRole("region", { name: "专题摘录" })).toContainText("可共享表征");
  let calls = 0;
  await page.route("**/api/study/topics/*/ask", async (route) => { calls += 1; const input = route.request().postDataJSON(); expect(input.question).toBe("共享表征是什么？"); expect(input.topicRevision).toBeGreaterThan(1); await route.fulfill({ json: { answer: "资料指出，图学习使用共享表征。[evidence]", refused: false, citations: [{ id: "evidence", documentId: source.id, documentRevision: source.revision, title: documentTitle, anchor: { quote, prefix: "", suffix: "", source: "preview" } }] } }); });
  const question = workspace.getByRole("region", { name: "专题问答" }); await question.getByRole("textbox", { name: "问题", exact: true }).fill("共享表征是什么？"); expect(calls).toBe(0); await question.getByRole("button", { name: "基于专题提问", exact: true }).click();
  await expect(question.getByLabel("专题回答")).toContainText("资料指出，图学习使用共享表征。"); await expect(question).toContainText(quote); expect(calls).toBe(1);
  expect((await new AxeBuilder({ page }).include(".study-workspace").analyze()).violations).toEqual([]);
  await page.screenshot({path:testInfo.outputPath("research-workspace-desktop.png")});
  await page.setViewportSize({width:390,height:844});
  await expect(workspace.getByRole("textbox",{name:"笔记",exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("research-workspace-mobile.png")});
  await page.setViewportSize({width:1440,height:900});
  await question.getByRole("button", { name: documentTitle, exact: true }).last().click(); await expect(page.locator(".reader-main .markdown-preview")).toContainText(quote);
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "研究", exact: true }).click(); await expect(workspace.getByRole("textbox", { name: "笔记", exact: true })).toHaveValue("这些资料支持可共享表征，仍需核实其边界。");
  await workspace.getByRole("region", { name: "专题摘录" }).getByRole("button", { name: "加入复习", exact: true }).click(); await workspace.getByRole("button", { name: "复习", exact: true }).click();
  const reviews = workspace.getByRole("region", { name: "摘录复习" }); await expect(reviews).toContainText(quote); await reviews.getByRole("button", { name: "查看笔记与译文", exact: true }).first().click(); await reviews.getByRole("button", { name: "记得", exact: true }).first().click();
  await expect.poll(async () => (await (await request.get("/api/study/reviews?all=true")).json()).find((item: { annotation: { documentId: string } }) => item.annotation.documentId === source.id)?.repetitions).toBe(1);
});

test("research question cancellation and navigation cannot display a late answer from another scope", async ({ page, request }) => {
  const listing = await request.get("/api/documents"), headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const created = await (await request.post("/api/documents", { headers, data: { title: `问答范围${Date.now()}` } })).json();
  const topic = await (await request.post("/api/study/topics", { headers, data: { name: `问答取消${Date.now()}` } })).json();
  await request.patch(`/api/study/topics/${topic.id}`, { headers, data: { revision: topic.revision, documentId: created.document.id } });
  let release = () => {}; const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/study/topics/*/ask", async (route) => { await held; await route.fulfill({ json: { answer: "late answer must stay hidden", citations: [], refused: true } }).catch(() => undefined); });
  await page.goto("/"); await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "研究", exact: true }).click();
  const workspace = page.getByRole("region", { name: "研究工作台" }); await workspace.getByRole("complementary", { name: "专题列表" }).getByRole("button", { name: topic.name, exact: true }).click();
  await workspace.getByRole("textbox", { name: "问题", exact: true }).fill("需要等待的问题"); await workspace.getByRole("button", { name: "基于专题提问", exact: true }).click(); await expect(workspace.getByRole("button", { name: "取消回答", exact: true })).toBeVisible();
  await workspace.getByRole("button", { name: "取消回答", exact: true }).click(); release(); await expect(workspace.getByText("late answer must stay hidden", { exact: true })).toHaveCount(0);
  await workspace.getByRole("textbox", { name: "笔记", exact: true }).fill("未保存的综合笔记"); await workspace.getByRole("button", { name: "资料", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "未保存的专题笔记", exact: true }); await expect(confirm).toBeVisible(); await confirm.getByRole("button", { name: "取消", exact: true }).click(); await expect(workspace.getByRole("textbox", { name: "笔记", exact: true })).toHaveValue("未保存的综合笔记");
});

test("pending topic and tag saves lock editors and preserve the submitted values", async ({ page, request }) => {
  const listing = await request.get("/api/documents"), headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const suffix = Date.now(), documentTitle = `保存资料${suffix}`;
  const created = await (await request.post("/api/documents", { headers, data: { title: documentTitle } })).json();
  const topic = await (await request.post("/api/study/topics", { headers, data: { name: `保存专题${suffix}` } })).json();
  let releaseTopic = () => {}, releaseTags = () => {};
  const heldTopic = new Promise<void>((resolve) => { releaseTopic = resolve; }), heldTags = new Promise<void>((resolve) => { releaseTags = resolve; });
  await page.route(`**/api/study/topics/${topic.id}`, async (route) => { if (route.request().method() === "PATCH") await heldTopic; await route.continue(); });
  await page.route(`**/api/study/documents/${created.document.id}/tags`, async (route) => { await heldTags; await route.continue(); });
  await page.goto("/"); await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "研究", exact: true }).click();
  const workspace = page.getByRole("region", { name: "研究工作台" }); await workspace.getByRole("complementary", { name: "专题列表" }).getByRole("button", { name: topic.name, exact: true }).click();
  const name = workspace.getByRole("textbox", { name: "专题名称", exact: true }), note = workspace.getByRole("textbox", { name: "笔记", exact: true });
  await name.fill(`${topic.name}已保存`); await note.fill("保存期间保留的综合笔记"); await workspace.getByRole("button", { name: "保存专题笔记", exact: true }).click();
  await expect(name).toBeDisabled(); await expect(note).toBeDisabled();
  releaseTopic(); await expect(name).toBeEnabled(); await expect(workspace.getByRole("heading", { name: `${topic.name}已保存`, exact: true })).toBeVisible();
  await expect(note).toHaveValue("保存期间保留的综合笔记");
  await workspace.getByRole("button", { name: "资料", exact: true }).click(); await workspace.getByRole("textbox", { name: "搜索资料", exact: true }).fill(documentTitle);
  const row = workspace.locator(".study-document-list > li").filter({ has: page.getByRole("button", { name: documentTitle, exact: true }) }), tags = row.getByRole("textbox", { name: "主题标签", exact: true });
  await tags.fill("saved-tag"); await row.getByRole("button", { name: "保存标签", exact: true }).click(); await expect(tags).toBeDisabled();
  releaseTags(); await expect(tags).toBeEnabled(); await expect(tags).toHaveValue("saved-tag");
  expect((await (await request.get(`/api/study/topics/${topic.id}`)).json()).note).toBe("保存期间保留的综合笔记");
  expect((await (await request.get(`/api/study/documents?q=${encodeURIComponent(documentTitle)}`)).json()).items[0].tags).toEqual(["saved-tag"]);
});

test("reading position persists without changing a selected translation passage", async ({ page, request }) => {
  const listing = await request.get("/api/documents"), headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `阅读进度${Date.now()}`, created = await (await request.post("/api/documents", { headers, data: { title } })).json();
  await request.patch(`/api/documents/${created.document.id}`, { headers, data: { revision: created.document.revision, markdown: "selected original passage.\n\n" + Array.from({ length: 100 }, (_, index) => `Reading paragraph ${index}. Persistent position without replacing selected words.`).join("\n\n") } });
  await page.addInitScript(() => localStorage.setItem("zhiye.reader-tools.enabled", '["translation"]'));
  await page.goto("/"); await page.getByRole("button", { name: title, exact: true }).click();
  const paragraph = page.locator(".reader-main .markdown-preview p").first(); await paragraph.scrollIntoViewIfNeeded(); await paragraph.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); });
  const pane = page.locator(".preview-pane"); await pane.hover(); await page.mouse.wheel(0, 600); await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(async () => (await (await request.get(`/api/study/documents/${created.document.id}/progress`)).json())?.fraction ?? 0).toBeGreaterThan(0);
  await page.keyboard.press("Alt+t"); await expect(page.getByRole("dialog", { name: "翻译", exact: true }).getByLabel("待翻译选区")).toHaveText("selected original passage."); await page.keyboard.press("Escape");
  await expect(page.getByLabel("阅读进度", { exact: true })).toHaveCount(0);
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "研究", exact: true }).click();
  const workspace = page.getByRole("region", { name: "研究工作台" }); await workspace.getByRole("button", { name: "资料", exact: true }).click(); await workspace.getByRole("textbox", { name: "搜索资料", exact: true }).fill(title);
  const row = workspace.locator(".study-document-list > li").filter({ has: page.getByRole("button", { name: title, exact: true }) });
  await row.getByRole("textbox", { name: "主题标签", exact: true }).fill("unsaved-research-tag"); await workspace.getByRole("button", { name: "专题", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "未保存的主题标签", exact: true }); await expect(confirm).toBeVisible(); await confirm.getByRole("button", { name: "取消", exact: true }).click(); await expect(row.getByRole("textbox", { name: "主题标签", exact: true })).toHaveValue("unsaved-research-tag");
  await row.getByRole("button", { name: "保存标签", exact: true }).click(); await expect(row.getByRole("button", { name: "保存标签", exact: true })).toBeDisabled();
  await workspace.getByRole("button", { name: "专题", exact: true }).click(); await expect(workspace.getByRole("button", { name: "专题", exact: true })).toHaveAttribute("aria-current", "page");
});

test("an existing collection can explicitly seed an independent research topic without changing its source", async ({ page, request }) => {
  const listing = await request.get("/api/documents"), headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const suffix = Date.now(), name = `旧集合${suffix}`, topicName = `独立研究${suffix}`, documentTitle = `集合来源资料${suffix}`;
  const collectionResult = await (await request.post("/api/collections", { headers, data: { name } })).json(), collection = collectionResult.collection ?? collectionResult;
  const created = await (await request.post("/api/documents", { headers, data: { title: documentTitle } })).json();
  await request.patch(`/api/documents/${created.document.id}`, { headers, data: { revision: created.document.revision, markdown: "Original collection material.", collectionIds: [collection.id] } });
  const before = (await (await request.get("/api/study/source-collections")).json()).find((item: { id: string }) => item.id === collection.id);
  expect(before.documents).toHaveLength(1);
  await page.goto("/"); await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "研究", exact: true }).click();
  const workspace = page.getByRole("region", { name: "研究工作台" }); await workspace.getByText("从现有集合建立专题", { exact: true }).click();
  await workspace.getByRole("combobox", { name: "来源集合", exact: true }).click(); await page.getByRole("option", { name: `${name}（1 篇）`, exact: true }).click(); await workspace.getByRole("textbox", { name: "新研究专题名称", exact: true }).fill(topicName);
  await expect(workspace).toContainText("复制当前资料清单，之后独立维护"); await workspace.getByRole("button", { name: "建立研究专题", exact: true }).click();
  await expect(workspace.getByRole("heading", { name: topicName, exact: true })).toBeVisible(); await expect(workspace.getByRole("region", { name: "专题资料" })).toContainText(documentTitle);
  const after = (await (await request.get("/api/study/source-collections")).json()).find((item: { id: string }) => item.id === collection.id); expect(after).toEqual(before);
});
