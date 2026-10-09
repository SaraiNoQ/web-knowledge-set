import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectNoHighImpactViolations(page: Page, name: string) {
  const shell = page.locator(".app-shell");
  if (await shell.count()) {
    await shell.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  }
  const result = await new AxeBuilder({ page }).analyze();
  const issues = result.violations
    .filter(({ impact }) => impact === "serious" || impact === "critical")
    .flatMap((violation) => violation.nodes.map((node) =>
      `${name} · ${violation.id} · ${node.target.join(" ")} · ${node.failureSummary}`
    ));

  expect(issues, issues.join("\n")).toEqual([]);
}

async function removeTemporaryDocument(page: Page, id: string) {
  await page.evaluate(async (documentId) => {
    const epochResponse = await fetch("/api/documents?page=1");
    const epoch = epochResponse.headers.get("X-Zhiye-Data-Epoch");
    const detailResponse = await fetch(`/api/documents/${encodeURIComponent(documentId)}`);
    if (!epochResponse.ok || !epoch || !detailResponse.ok) throw new Error("accessibility cleanup unavailable");
    const headers = { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": epoch };
    let document = await detailResponse.json() as { deletedAt: string | null; revision: number };

    if (!document.deletedAt) {
      const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ revision: document.revision }),
      });
      if (!response.ok) throw new Error(`accessibility cleanup trash failed: ${response.status}`);
      document = await response.json() as typeof document;
    }

    const draftResponse = await fetch(`/api/documents/${encodeURIComponent(documentId)}/draft`);
    if (!draftResponse.ok) throw new Error(`accessibility cleanup draft failed: ${draftResponse.status}`);
    const draft = await draftResponse.json() as { draftRevision: number } | null;
    const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/permanent`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ revision: document.revision, draftRevision: draft?.draftRevision ?? null }),
    });
    if (!response.ok) throw new Error(`accessibility cleanup delete failed: ${response.status}`);
  }, id);
}

test("has no serious or critical accessibility violations in primary workflows", async ({ page }) => {
  test.setTimeout(60_000);
  let temporaryDocumentId = "";

  await page.route("**/api/settings/onboarding", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const state = await response.json() as { completed: boolean; revision: number };
    await route.fulfill({ response, json: { ...state, completed: false } });
  });

  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "本机保存" })).toBeVisible();
    await expectNoHighImpactViolations(page, "首次使用指南");

    await page.getByRole("button", { name: "稍后设置" }).click();
    await expect(page.getByLabel("网页链接")).toBeVisible();
    await expect(page.locator(".document-list .state-loading")).toHaveCount(0);
    await expectNoHighImpactViolations(page, "资料库");
    await page.getByRole("navigation", { name: "目录分类" }).getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("button", { name: "搜索设置", exact: true }).click();
    const librarySelect = page.getByRole("combobox").first();
    const selectedValueId = await librarySelect.locator("span").first().getAttribute("id");
    expect(selectedValueId).toBeTruthy();
    expect((await librarySelect.getAttribute("aria-describedby"))?.split(/\s+/u)).toContain(selectedValueId);

    await page.getByRole("navigation", { name: "目录分类" }).getByRole("button", { name: "全部资料", exact: true }).click();
    const readyRow = page.locator(".document-row-wrap").filter({ hasText: "可以阅读" }).first();
    if (await readyRow.count()) {
      await readyRow.locator(".document-row").click();
    } else {
      const created = page.waitForResponse((response) =>
        response.ok() && response.request().method() === "POST" && new URL(response.url()).pathname === "/api/documents"
      );
      await page.getByLabel("网页链接").fill(`https://example.com/accessibility-${crypto.randomUUID()}`);
      await page.getByRole("button", { name: "保存网页" }).click();
      const body = await (await created).json() as { created: boolean; document: { id: string } };
      expect(body.created).toBe(true);
      temporaryDocumentId = body.document.id;
    }
    await expect(page.getByLabel("Markdown 编辑器")).toBeVisible({ timeout: 8_000 });
    await expectNoHighImpactViolations(page, "Markdown 编辑器");

    await page.getByRole("button", { name: "批量导入" }).click();
    await expect(page.getByRole("dialog", { name: "导入" })).toBeVisible();
    await expectNoHighImpactViolations(page, "批量导入");
    await page.getByRole("button", { name: "关闭导入" }).click();

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "智能设置" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "相关资料" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "自动推荐" })).not.toBeChecked();
    await expectNoHighImpactViolations(page, "AI 设置");
    await page.getByRole("button", { name: "返回列表" }).click();
    await page.keyboard.press("Escape");

    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "知识地图", exact: true }).click();
    await expect(page.getByRole("heading", { name: "知识地图", exact: true })).toBeVisible();
    await expectNoHighImpactViolations(page, "知识地图");
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "资料库", exact: true }).click();

    await page.getByRole("button", { name: "备份恢复", exact: true }).click();
    await expect(page.getByRole("heading", { name: "备份恢复" })).toBeVisible();
    await expectNoHighImpactViolations(page, "备份恢复");
    await page.getByRole("button", { name: "返回列表" }).click();

    await page.getByRole("button", { name: "使用帮助", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "使用帮助" })).toBeVisible();
    await expectNoHighImpactViolations(page, "使用帮助");
  } finally {
    if (temporaryDocumentId) await removeTemporaryDocument(page, temporaryDocumentId);
  }
});
