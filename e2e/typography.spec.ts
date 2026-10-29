import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/health", route => route.fulfill({ json: { ok: true, mode: "cloud-core" } }));
  await page.route("**/api/settings/onboarding", route => route.fulfill({ json: { completed: true, revision: 1 } }));
});

test("UI headings keep their hierarchy and ordinary form controls use the UI family", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "智能设置", exact: true }).click();
  const family = await page.locator("body").evaluate(element => getComputedStyle(element).fontFamily);
  await expect(page.getByRole("combobox", { name: "服务平台", exact: true })).toHaveCSS("font-family", family);
  for (const width of [1440, 640, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("heading", { name: "设置", exact: true })).toHaveCSS("font-size", "32px");
    await expect(page.getByRole("heading", { name: "智能设置", exact: true })).toHaveCSS("font-size", "24px");
    await expect(page.getByRole("heading", { name: "功能开关", exact: true })).toHaveCSS("font-size", "18px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("a saved reading size also scales table text", async ({ page, request }) => {
  const listing = await request.get("/api/documents");
  const headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `阅读字号与表格-${Date.now()}`;
  const created = await request.post("/api/documents", { headers, data: { title } });
  expect(created.ok()).toBe(true);
  const { document } = await created.json();
  expect((await request.patch(`/api/documents/${document.id}`, { headers, data: {
    revision: document.revision, markdown: "正文与表格应使用相同字号。\n\n| 项目 | 内容 |\n| --- | --- |\n| 文字 | 阅读设置 |",
  } })).ok()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("spinbutton", { name: "字号", exact: true }).fill("28");
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  await page.locator(".library-directory").getByRole("button", { name: title, exact: true }).click();
  await expect(page.locator(".reader-main .markdown-preview")).toHaveCSS("font-size", "28px");
  await expect(page.locator(".reader-main .markdown-preview td").first()).toHaveCSS("font-size", "28px");
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "字号", exact: true })).toHaveValue("28");
});
