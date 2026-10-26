import { expect, test } from "@playwright/test";

test("cached ANN backfill continues promptly and stops after completion without repeating model work", async ({ page }) => {
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
  await page.route("**/api/settings/semantic", async (route) => { const response = await route.fetch(), settings = await response.json(); await route.fulfill({ response, json: { ...settings, enabled: true, apiKeyConfigured: true } }); });
  let calls = 0, mapLoads = 0, release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/knowledge-map") mapLoads += 1; });
  await page.route("**/api/semantic/index-step", async (route) => { calls += 1; if (calls === 1) await held; return route.fulfill({ json: { status: calls <= 2 ? "progress" : "idle", documentId: null } }); });
  await page.goto("/"); await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "知识地图", exact: true }).click(); await expect.poll(() => mapLoads).toBeGreaterThan(0);
  const before = mapLoads; release(); await expect.poll(() => calls, { timeout: 3000 }).toBeGreaterThanOrEqual(3);
  const completed = calls; expect(completed).toBeLessThanOrEqual(4);
  await page.waitForTimeout(350); expect(calls).toBe(completed); expect(mapLoads - before).toBeLessThanOrEqual(1);
});
