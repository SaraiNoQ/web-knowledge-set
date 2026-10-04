import { expect, test } from "@playwright/test";

test("production page serves a decodable brand favicon", async ({ page }) => {
  await page.goto("/");
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute("type", "image/svg+xml");
  const href = await icon.getAttribute("href");
  expect(href).toBeTruthy();
  const response = await page.request.get(href!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/svg+xml");
  const dimensions = await page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  }, href!);
  expect(dimensions[0]).toBeGreaterThan(0);
  expect(dimensions[1]).toBeGreaterThan(0);
});
