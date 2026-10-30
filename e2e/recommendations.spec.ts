import { expect, test } from "@playwright/test";

test("map applies relation types before Top-K and ignores stale continuation scopes without refetching vectors", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  const stamp = "2026-10-26T00:00:00.000Z";
  const nodes = [["map-source", "筛选来源"], ["tag-target", "共同标签资料"], ["semantic-target", "语义候选资料"], ["citation-target", "引用资料"]].map(([id, title], index) => ({ id, title, kind: "article", folderId: null, folderName: null, status: "ready", favorite: false, archivedAt: null, updatedAt: stamp, pageCount: null, semanticState: "ready", semanticSourceHash: String(index + 1).repeat(64), semanticModel: "test-model", semanticFormatVersion: "semantic-text-v1" }));
  const document = (id: string) => ({ id, title: nodes.find((node) => node.id === id)!.title, sourceUrl: `https://example.com/${id}`, kind: "article", revision: 1, deletedAt: null, folderId: null, tags: [], markdown: "" });
  const item = (id: string, type: "semantic" | "tag" | "citation") => ({ document: document(id), reasons: [{ type, label: type === "tag" ? "共同标签：test" : type === "citation" ? "正文包含来源链接" : "正文向量相近", ...(type === "semantic" ? { score: .99 } : {}) }], evidence: [], score: 1 });
  await page.route("**/api/knowledge-map?*", (route) => route.fulfill({ json: { items: nodes, folders: [], total: nodes.length, nextCursor: null } }));
  let vectorRequests = 0;
  await page.route("**/api/knowledge-map/vectors?*", (route) => { vectorRequests++; return route.fulfill({ json: { items: nodes.map((node) => ({ id: node.id, sourceHash: node.semanticSourceHash, model: node.semanticModel, formatVersion: node.semanticFormatVersion, vector: [1, 0] })), total: nodes.length, nextCursor: null } }); });
  const queries: Array<{ id: string; types: string; cursor: string }> = [];
  let releaseTag = () => {}, releaseCitation = () => {}, tagSettled = false, citationSettled = false;
  const heldTag = new Promise<void>((resolve) => { releaseTag = resolve; }), heldCitation = new Promise<void>((resolve) => { releaseCitation = resolve; });
  await page.route("**/api/study/related/*?*", async (route) => {
    const url = new URL(route.request().url()), id = decodeURIComponent(url.pathname.split("/").at(-1)!), types = url.searchParams.get("types") ?? "", cursor = url.searchParams.get("cursor") ?? "";
    queries.push({ id, types, cursor });
    try {
      if (cursor === "tag-page") await heldTag;
      if (cursor === "citation-page") await heldCitation;
      const rows = id !== "map-source" ? [] : cursor ? [item("semantic-target", "semantic")] : types === "tag" ? [item("tag-target", "tag")] : types === "tag,citation" ? [item("citation-target", "citation")] : [item("semantic-target", "semantic")];
      await route.fulfill({ json: { sourceId: id, sourceRevision: 1, items: rows, scannedDocuments: 1000, truncated: !cursor && id === "map-source", nextCursor: cursor || id !== "map-source" ? null : types === "tag" ? "tag-page" : types === "tag,citation" ? "citation-page" : null } });
    } catch { /* A changed type/id scope aborts its old network request. */ }
    finally { if (cursor === "tag-page") tagSettled = true; if (cursor === "citation-page") citationSettled = true; }
  });
  try {
    await page.goto("/"); await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "知识地图", exact: true }).click();
    const map = page.getByRole("region", { name: "知识地图", exact: true }); await expect(map.locator(".map-loading")).toHaveCount(0);
    await expect.poll(() => vectorRequests).toBeGreaterThan(0); await expect(map.locator(".map-semantic-status")).toHaveCount(0);
    await map.locator(".map-accessible-list summary").click(); await map.locator(".map-accessible-list").getByRole("button", { name: "筛选来源" }).click();
    const evidence = map.getByRole("region", { name: "关联证据" }), detail = map.getByRole("complementary", { name: "资料详情" });
    await expect(evidence).toContainText("语义候选资料"); const vectorsBefore = vectorRequests;
    for (const label of ["分组归属", "人工关联", "内容相近", "引用", "词项匹配"]) await map.getByRole("checkbox", { name: label, exact: true }).uncheck();
    await expect.poll(() => queries.some((query) => query.id === "map-source" && query.types === "tag" && !query.cursor)).toBe(true);
    await expect(evidence).toContainText("共同标签资料"); await expect(evidence).not.toContainText("语义候选资料");
    await expect(detail.getByRole("heading", { name: "筛选来源", exact: true })).toBeVisible();
    await evidence.getByRole("button", { name: "继续查找关联证据", exact: true }).click();
    await expect.poll(() => queries.some((query) => query.cursor === "tag-page" && query.types === "tag")).toBe(true);
    await map.getByRole("checkbox", { name: "引用", exact: true }).check();
    await expect.poll(() => queries.some((query) => query.id === "map-source" && query.types === "tag,citation" && !query.cursor)).toBe(true);
    await expect(evidence).toContainText("引用资料");
    releaseTag(); await expect.poll(() => tagSettled).toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(evidence).toContainText("引用资料"); await expect(evidence).not.toContainText("语义候选资料");
    await evidence.getByRole("button", { name: "继续查找关联证据", exact: true }).click();
    await expect.poll(() => queries.some((query) => query.cursor === "citation-page" && query.types === "tag,citation")).toBe(true);
    await map.locator(".map-accessible-list").getByRole("button", { name: "共同标签资料" }).click();
    await expect(detail.getByRole("heading", { name: "共同标签资料", exact: true })).toBeVisible();
    await expect.poll(() => queries.some((query) => query.id === "tag-target" && query.types === "tag,citation" && !query.cursor)).toBe(true);
    await expect(evidence).toContainText("本次检索没有找到关联证据。");
    releaseCitation(); await expect.poll(() => citationSettled).toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(evidence).not.toContainText("语义候选资料"); expect(vectorRequests).toBe(vectorsBefore);
  } finally { releaseTag(); releaseCitation(); }
});

test("opening current-document evidence protects drafts and ignores late refresh after another navigation", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  const listing = await request.get("/api/documents"), epoch = listing.headers()["x-zhiye-data-epoch"];
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": epoch };
  const title = `当前证据${Date.now()}`, otherTitle = `后续文档${Date.now()}`;
  const source = (await (await request.post("/api/documents", { headers, data: { title } })).json()).document;
  const other = (await (await request.post("/api/documents", { headers, data: { title: otherTitle } })).json()).document;
  const original = "Current saved source paragraph.", otherBody = "Other document remains current.";
  await request.patch(`/api/documents/${source.id}`, { headers, data: { revision: source.revision, markdown: original } });
  await request.patch(`/api/documents/${other.id}`, { headers, data: { revision: other.revision, markdown: otherBody } });
  const current = await (await request.get(`/api/documents/${source.id}`)).json();
  await page.route("**/api/study/related/*?*", (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
    return route.fulfill({ json: { sourceId: id, sourceRevision: current.revision, scannedDocuments: 1, truncated: false, nextCursor: null,
      items: id === source.id ? [{ document: { ...current, markdown: "" }, reasons: [{ type: "citation", label: "真实来源片段" }], score: 1.5, evidence: [{ id: "current:1", documentId: source.id, documentRevision: current.revision, title, basis: "context", anchor: { quote: original, prefix: "", suffix: "", source: "editor" } }] }] : [] } });
  });
  await page.goto("/"); await page.getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "右侧功能区" }); await sidebar.getByRole("button", { name: "管理", exact: true }).click();
  const editor = page.getByLabel("Markdown 编辑器"), evidence = sidebar.getByRole("button", { name: `查看原文：${title}`, exact: true });
  await expect(evidence).toBeVisible();
  await editor.fill("UNSAVED user draft must survive.");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
  await evidence.click();
  const confirmation = page.getByRole("alertdialog", { name: "存在未保存修改", exact: true }); await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor).toHaveText("UNSAVED user draft must survive.");
  expect((await (await request.get(`/api/documents/${source.id}`)).json()).markdown).toBe(original);

  await editor.fill(original);
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  let captured = 0, release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/documents/${source.id}`, async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    captured += 1; await held;
    await route.fulfill({ json: current, headers: { "X-Zhiye-Data-Epoch": epoch } });
  });
  try {
    const lateResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/documents/${source.id}` && response.request().method() === "GET");
    await evidence.click(); await expect.poll(() => captured).toBe(1);
    await page.locator(".library-directory").getByRole("button", { name: otherTitle, exact: true }).click();
    await expect(editor).toHaveText(otherBody);
    release(); await (await lateResponse).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(editor).toHaveText(otherBody);
  } finally { release(); }
});

test("reader recommendations expose source evidence, join a topic and open the quoted original", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  const listing = await request.get("/api/documents"), epoch = listing.headers()["x-zhiye-data-epoch"];
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": epoch };
  const title = `推荐来源${Date.now()}`, peerTitle = `推荐证据${Date.now()}`;
  const source = (await (await request.post("/api/documents", { headers, data: { title } })).json()).document;
  const peer = (await (await request.post("/api/documents", { headers, data: { title: peerTitle } })).json()).document;
  await request.patch(`/api/documents/${source.id}`, { headers, data: { revision: source.revision, markdown: "Graph learning original evidence." } });
  await request.patch(`/api/documents/${peer.id}`, { headers, data: { revision: peer.revision, markdown: "Peer graph evidence paragraph." } });
  const current = await (await request.get(`/api/documents/${source.id}`)).json(), target = await (await request.get(`/api/documents/${peer.id}`)).json();
  const topicResponse = await request.post("/api/study/topics", { headers, data: { name: `推荐专题${Date.now()}` } }); expect(topicResponse.ok()).toBe(true); const topic = await topicResponse.json();
  await page.route("**/api/study/related/*?*", (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
    return route.fulfill({ json: { sourceId: id, sourceRevision: id === source.id ? current.revision : target.revision, scannedDocuments: 2, truncated: false, nextCursor: null,
      items: id === source.id ? [{ document: { ...target, markdown: "" }, reasons: [{ type: "semantic", label: "正文向量相近", score: .92 }], score: .92, evidence: [{ id: "peer:1", documentId: peer.id, documentRevision: target.revision, title: peerTitle, basis: "term-overlap", anchor: { quote: "Peer graph evidence paragraph.", prefix: "", suffix: "", source: "editor" } }] }] : [] } });
  });
  await page.goto("/"); await page.getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "右侧功能区" }); await sidebar.getByRole("button", { name: "管理", exact: true }).click();
  const recommendations = sidebar.getByRole("region", { name: "相关资料推荐" });
  await expect(recommendations).toContainText("正文向量相近 · 0.92"); await expect(recommendations).toContainText("Peer graph evidence paragraph.");
  await recommendations.getByRole("combobox", { name: "推荐资料加入的专题" }).click(); await page.getByRole("option", { name: topic.name, exact: true }).click();
  await recommendations.getByRole("button", { name: "加入所选专题", exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/api/study/topics/${topic.id}`)).json()).documentIds.includes(peer.id)).toBe(true);
  await recommendations.getByRole("button", { name: `查看原文：${peerTitle}`, exact: true }).click();
  await expect(page.getByLabel("Markdown 编辑器")).toContainText("Peer graph evidence paragraph.");
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("Peer graph evidence paragraph.");
});

test("manual connections can bind source excerpts and explicitly confirm citations", async ({ page, request }) => {
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  const listing = await request.get("/api/documents"), headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `摘录来源${Date.now()}`, peerTitle = `关联摘录${Date.now()}`;
  const first = (await (await request.post("/api/documents", { headers, data: { title } })).json()).document;
  const second = (await (await request.post("/api/documents", { headers, data: { title: peerTitle } })).json()).document;
  await request.patch(`/api/documents/${first.id}`, { headers, data: { revision: first.revision, markdown: "First excerpt evidence." } });
  await request.patch(`/api/documents/${second.id}`, { headers, data: { revision: second.revision, markdown: "Second excerpt evidence." } });
  const source = await (await request.get(`/api/documents/${first.id}`)).json(), target = await (await request.get(`/api/documents/${second.id}`)).json();
  const note = await (await request.post(`/api/reader-tools/documents/${first.id}/annotations`, { headers, data: { revision: source.revision, anchor: { quote: "First excerpt evidence.", prefix: "", suffix: "", source: "editor" } } })).json();
  const peerNote = await (await request.post(`/api/reader-tools/documents/${second.id}/annotations`, { headers, data: { revision: target.revision, anchor: { quote: "Second excerpt evidence.", prefix: "", suffix: "", source: "editor" } } })).json();
  const linked = await (await request.post(`/api/reader-tools/documents/${first.id}/connections`, { headers, data: { revision: source.revision, targetId: second.id, note: "Supports this claim" } })).json();
  await page.goto("/"); await page.getByRole("button", { name: title, exact: true }).click(); await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "右侧功能区" }); await sidebar.getByRole("button", { name: "管理", exact: true }).click();
  await sidebar.locator(".reader-evidence-editor summary").click();
  await sidebar.getByRole("combobox", { name: "这篇资料的摘录", exact: true }).click(); await page.getByRole("option", { name: "First excerpt evidence.", exact: true }).click();
  await sidebar.getByRole("combobox", { name: "关联资料的摘录", exact: true }).click(); await page.getByRole("option", { name: "Second excerpt evidence.", exact: true }).click();
  await sidebar.getByRole("combobox", { name: "关系类型", exact: true }).click(); await page.getByRole("option", { name: "我确认这是引用关系", exact: true }).click();
  await sidebar.getByRole("button", { name: "保存关联证据", exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/api/study/connections/${linked.connection.id}/evidence`)).json())?.relationType).toBe("citation");
  const saved = await (await request.get(`/api/study/connections/${linked.connection.id}/evidence`)).json();
  expect([saved.sourceAnnotationId, saved.targetAnnotationId].sort()).toEqual([note.id, peerNote.id].sort());
  expect((await (await request.get(`/api/documents/${first.id}`)).json()).markdown).toBe("First excerpt evidence.");
});
