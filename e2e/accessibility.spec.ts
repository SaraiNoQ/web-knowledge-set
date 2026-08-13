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
    await expect(page.getByRole("heading", { name: /你的知识/u })).toBeVisible();
    await expectNoHighImpactViolations(page, "首次使用指南");

    await page.getByRole("button", { name: "稍后设置" }).click();
    await expect(page.getByLabel("网页地址")).toBeVisible();
    await expect(page.locator(".document-list .state-loading")).toHaveCount(0);
    await expectNoHighImpactViolations(page, "资料库");

    const readyRow = page.locator(".document-row-wrap").filter({ hasText: "已就绪" }).first();
    if (await readyRow.count()) {
      await readyRow.locator(".document-row").click();
    } else {
      const created = page.waitForResponse((response) =>
        response.ok() && response.request().method() === "POST" && new URL(response.url()).pathname === "/api/documents"
      );
      await page.getByLabel("网页地址").fill(`https://example.com/accessibility-${crypto.randomUUID()}`);
      await page.getByRole("button", { name: "收取网页" }).click();
      const body = await (await created).json() as { created: boolean; document: { id: string } };
      expect(body.created).toBe(true);
      temporaryDocumentId = body.document.id;
    }
    await expect(page.getByLabel("Markdown 编辑器")).toBeVisible({ timeout: 8_000 });
    await expectNoHighImpactViolations(page, "Markdown 编辑器");

    await page.getByRole("button", { name: "批量导入" }).click();
    await expect(page.getByRole("dialog", { name: "批量导入" })).toBeVisible();
    await expectNoHighImpactViolations(page, "批量导入");
    await page.getByRole("button", { name: "关闭批量导入" }).click();

    await page.getByRole("button", { name: "AI 设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "AI 派生设置" })).toBeVisible();
    await expectNoHighImpactViolations(page, "AI 设置");
    await page.getByRole("button", { name: "返回资料库" }).click();

    await page.getByRole("button", { name: "数据安全", exact: true }).click();
    await expect(page.getByRole("heading", { name: "数据安全" })).toBeVisible();
    await expectNoHighImpactViolations(page, "数据安全");
    await page.getByRole("button", { name: "返回资料库" }).click();

    await page.getByRole("button", { name: "帮助", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "帮助与关于" })).toBeVisible();
    await expectNoHighImpactViolations(page, "帮助与关于");
  } finally {
    if (temporaryDocumentId) await removeTemporaryDocument(page, temporaryDocumentId);
  }
});
