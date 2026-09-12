import { expect, test } from "@playwright/test";

test("imports a paper and opens the bilingual page reader", async ({ page }) => {
  await page.goto("/");
  // The onboarding screen can render after this check, so wait for the button
  // rather than testing for it once and skipping the click.
  await page.getByRole("button", { name: "稍后设置" }).click({ timeout: 5_000 }).catch(() => undefined);

  await expect(page.getByRole("button", { name: "导入论文", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "导入论文", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入论文" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "上传 PDF" }).click();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "e2e-paper.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\nE2E fixture\n", "ascii"),
  });
  await dialog.getByRole("button", { name: "创建论文" }).click();

  await expect(page.getByRole("heading", { name: "E2E 论文" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("一篇 E2E 论文。", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("中文对照 · 第 1 页", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑译文" }).click();
  await expect(page.locator("textarea")).toHaveCount(1);
  await page.locator("textarea").fill("修改后的论文译文。");
  await page.getByRole("button", { name: "保存本页" }).click();
  await expect(page.locator(".paper-reader-notice")).toContainText("本页译文已保存。");

  await page.getByRole("button", { name: "更多操作：E2E 论文" }).click();
  await page.getByRole("dialog", { name: "操作：E2E 论文" }).getByRole("button", { name: "删除（移入回收站）" }).click();
  const trashResponse = page.waitForResponse((response) => response.request().method() === "DELETE" && /^\/api\/documents\/[^/]+$/u.test(new URL(response.url()).pathname));
  await page.getByRole("alertdialog", { name: "移入回收站" }).getByRole("button", { name: "移入回收站" }).click();
  expect((await trashResponse).status()).toBe(200);
  await expect(page.getByRole("button", { name: "回收站", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "永久删除：E2E 论文" })).toBeVisible();
  await page.getByRole("button", { name: "永久删除：E2E 论文" }).click();
  await page.getByRole("alertdialog", { name: "永久删除知识" }).getByRole("button", { name: "永久删除" }).click();
  await expect(page.getByRole("button", { name: "E2E 论文", exact: true })).toHaveCount(0);
});

// A valid one-page PDF, so PDF.js really rasterises the page and the zoom can
// be measured instead of assumed.
function minimalPdf() {
  const content = "0 0 1 rg 60 60 480 640 re f\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

test("the reader scrolls its own panes, zooms the page, and resizes the split", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "稍后设置" }).click({ timeout: 5_000 }).catch(() => undefined);
  await page.getByRole("button", { name: "导入论文", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入论文" });
  await dialog.getByRole("tab", { name: "上传 PDF" }).click();
  await dialog.locator('input[type="file"]').setInputFiles({ name: "layout.pdf", mimeType: "application/pdf", buffer: minimalPdf() });
  await dialog.getByRole("button", { name: "创建论文" }).click();
  await expect(page.getByRole("heading", { name: "E2E 论文" })).toBeVisible({ timeout: 10_000 });

  // Registering a page count is the same call the renderer makes; asking for 60
  // pages gives the rail more entries than any viewport can show.
  const paperId = /zhiye:\/\/paper\/([0-9a-f-]+)/u.exec((await page.locator(".paper-reader-header p").textContent()) ?? "")?.[1];
  expect(paperId).toBeTruthy();
  await page.evaluate(async (id) => {
    const epoch = (await fetch("/api/settings/onboarding")).headers.get("x-zhiye-data-epoch");
    await fetch(`/api/papers/${id}/page-renders`, { method: "POST", headers: { "Content-Type": "application/json", "X-Zhiye-Data-Epoch": epoch! }, body: JSON.stringify({ pageCount: 60 }) });
  }, paperId);
  await page.reload();
  await page.getByRole("button", { name: /layout\.pdf|E2E 论文/u }).first().click();
  await expect(page.getByRole("heading", { name: "E2E 论文" })).toBeVisible({ timeout: 15_000 });

  // The page rail keeps a fixed height and scrolls, rather than growing the page.
  const rail = await page.locator(".paper-reader-pages").evaluate((element) => ({
    client: element.clientHeight,
    scroll: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(rail.overflowY).toBe("auto");
  expect(rail.scroll).toBeGreaterThan(rail.client);
  const readerFits = await page.locator(".paper-reader").evaluate((element) => element.scrollHeight <= element.clientHeight + 1);
  expect(readerFits).toBe(true);

  // The reader is exactly one viewport tall, so scrolling the masthead and the
  // capture band away leaves the paper filling the window: at full scroll its
  // top sits at 0 and its bottom at the fold, with nothing left over below it.
  for (const width of [1440, 1000, 800]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => page.evaluate(() => {
      const reader = document.querySelector(".paper-reader") as HTMLElement;
      return Math.abs(Math.round(reader.clientHeight - window.innerHeight));
    })).toBeLessThanOrEqual(2);
    const atBottom = await page.evaluate(() => {
      window.scrollTo(0, 100_000);
      const rect = (document.querySelector(".paper-reader") as HTMLElement).getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), inner: window.innerHeight, scrolled: Math.round(window.scrollY) };
    });
    // The chrome must be scrollable away, and the paper must then fill the window
    // exactly — no gap below it, no part of it above the fold.
    expect(atBottom.scrolled).toBeGreaterThan(0);
    expect(Math.abs(atBottom.top)).toBeLessThanOrEqual(2);
    expect(Math.abs(atBottom.bottom - atBottom.inner)).toBeLessThanOrEqual(2);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Zoom really rescales the rendered page, and the pane scrolls it rather than
  // pushing the layout taller.
  const canvasWidth = () => page.locator(".paper-reader-pdf-scroll canvas").evaluate((element) => Math.round(element.getBoundingClientRect().width));
  const fitted = await canvasWidth();
  expect(fitted).toBeGreaterThan(0);
  await page.getByRole("button", { name: "放大原始 PDF" }).click();
  await page.getByRole("button", { name: "放大原始 PDF" }).click();
  await page.getByRole("button", { name: "放大原始 PDF" }).click();
  await expect(page.locator(".paper-reader-zoom span")).toHaveText("160%");
  await expect.poll(canvasWidth).toBeGreaterThan(fitted + 50);
  const pane = await page.locator(".paper-reader-pdf-scroll").evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight, overflowY: getComputedStyle(element).overflowY }));
  expect(pane.overflowY).toBe("auto");
  expect(pane.scroll).toBeGreaterThan(pane.client);
  await page.getByRole("button", { name: "恢复原始 PDF 缩放" }).click();
  await expect(page.locator(".paper-reader-zoom span")).toHaveText("100%");

  // The divider drags to a new split, and the arrow keys nudge it for keyboards.
  const split = page.getByRole("separator", { name: "调整原文与译文的宽度" });
  expect(await split.getAttribute("aria-valuenow")).toBe("50");
  const beforeDrag = await canvasWidth();
  const rect = await split.boundingBox();
  expect(rect).not.toBeNull();
  await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect!.x + rect!.width / 2 - 280, rect!.y + rect!.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => Number(await split.getAttribute("aria-valuenow"))).toBeLessThan(30);
  // Narrowing the pane re-fits the page into it rather than leaving the page at
  // the width it was first drawn with.
  await expect.poll(canvasWidth).toBeLessThan(beforeDrag - 50);
  await split.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => Number(await split.getAttribute("aria-valuenow"))).toBeGreaterThan(20);

  // The removed provenance column must not come back.
  await expect(page.locator(".paper-reader-inspector")).toHaveCount(0);

  // Below the breakpoint the panes stack and are taller than any viewport, so
  // the reader has to stop pinning its height: a fixed box with nothing able to
  // scroll would spill the lower pane over the page.
  await page.setViewportSize({ width: 720, height: 800 });
  await expect(page.locator(".paper-reader-split")).toBeHidden();
  const stacked = await page.locator(".paper-reader").evaluate((reader) => {
    const pdf = document.querySelector(".paper-reader-pdf-page") as HTMLElement;
    const translation = document.querySelector(".paper-reader-translation") as HTMLElement;
    return {
      sameRow: Math.abs(pdf.getBoundingClientRect().top - translation.getBoundingClientRect().top) < 8,
      clipped: reader.scrollHeight > reader.clientHeight + 1,
    };
  });
  expect(stacked.sameRow).toBe(false);
  expect(stacked.clipped).toBe(false);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("button", { name: "更多操作：E2E 论文" }).click();
  await page.getByRole("dialog", { name: "操作：E2E 论文" }).getByRole("button", { name: "删除（移入回收站）" }).click();
  await page.getByRole("alertdialog", { name: "移入回收站" }).getByRole("button", { name: "移入回收站" }).click();
  await page.getByRole("button", { name: "永久删除：E2E 论文" }).click();
  await page.getByRole("alertdialog", { name: "永久删除知识" }).getByRole("button", { name: "永久删除" }).click();
  await expect(page.getByRole("button", { name: "E2E 论文", exact: true })).toHaveCount(0);
});
