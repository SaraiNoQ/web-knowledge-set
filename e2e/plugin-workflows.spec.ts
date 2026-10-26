import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

function bundle(version = "1.0.0", broken = false, suppliedScript?: string, permissions = ["selection.read", "storage.own"]) {
  const script = suppliedScript ?? (broken ? "throw new Error('failed upgrade');" : `
    let current = null;
    const view = (text) => zhiye.render({text,fields:[],actions:[{id:'read',label:'读取选区'},{id:'store',label:'保存插件设置'},{id:'recall',label:'读取插件设置'},{id:'denied',label:'尝试未授权翻译'}]});
    view('插件就绪 ${version}');
    zhiye.onAction(async (id) => {
      try {
        if(id==='read') {current=await zhiye.selection();view(current ? current.selection.anchor.quote : '没有选区');}
        if(id==='store') {await zhiye.storage.set('note','retained private setting');view('插件设置已保存');}
        if(id==='recall') view(await zhiye.storage.get('note','empty'));
        if(id==='denied') {current=await zhiye.selection();await zhiye.translate(current.token,'en');}
      } catch(error) {view(error.message);}
    });`);
  const manifest = { schemaVersion: 1, hostApiVersion: 1, id: "example.reader", name: "示例阅读插件", version, storageVersion: 1,
    publisher: { name: "Example", origin: "https://example.com" }, permissions, entry: "main.js", files: { "main.js": createHash("sha256").update(script).digest("hex") } };
  return Buffer.from(zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), "main.js": strToU8(script) }, { level: 0 }));
}
async function settings(page: Page) { await page.getByRole("button", { name: "设置", exact: true }).click(); await page.getByRole("button", { name: "阅读工具", exact: true }).click(); }
async function install(page: Page, bytes: Buffer) {
  await page.getByLabel("导入插件包", { exact: true }).setInputFiles({ name: "example.zip", mimeType: "application/zip", buffer: bytes });
  const dialog = page.getByRole("dialog", { name: "确认安装插件", exact: true });
  await expect(dialog.getByRole("button", { name: "安装并验证" })).toBeDisabled(); await expect(dialog).toContainText("未经身份认证");
  await dialog.getByRole("checkbox", { name: "我已核对来源、文件指纹和所列权限" }).check(); await dialog.getByRole("button", { name: "安装并验证" }).click(); await expect(dialog).toBeHidden();
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/settings/onboarding", (route) => route.fulfill({ json: { completed: true, revision: 1 } }));
});

test("approved external package runs outside DOM, enforces permissions, and keeps settings through uninstall and backup", async ({ page, request }, info) => {
  const listing = await request.get("/api/documents"), headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `外部插件资料${Date.now()}`, created = await (await request.post("/api/documents", { headers, data: { title } })).json();
  await request.patch(`/api/documents/${created.document.id}`, { headers, data: { revision: created.document.revision, markdown: "A selected original passage." } });
  const original = bundle(); await page.goto("/"); await settings(page); await install(page, original);
  await expect(page.getByRole("checkbox", { name: "启用 示例阅读插件", exact: true })).toBeChecked();
  const section = page.getByRole("region", { name: "第三方插件", exact: true });
  expect((await new AxeBuilder({ page }).include(".external-plugin-settings").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("plugin-settings-desktop.png") }); await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath("plugin-settings-mobile.png") }); await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "返回列表", exact: true }).click(); await page.getByRole("button", { name: title, exact: true }).click();
  const paragraph = page.locator(".reader-main .markdown-preview p").first(); await paragraph.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); });
  await page.getByRole("toolbar", { name: "选区操作" }).getByRole("button", { name: "示例阅读插件", exact: true }).click();
  const tool = page.getByRole("dialog", { name: "示例阅读插件", exact: true }); await expect(tool).toContainText("插件就绪 1.0.0");
  await tool.getByRole("button", { name: "读取选区", exact: true }).click(); await expect(tool).toContainText("A selected original passage.");
  await tool.getByRole("button", { name: "尝试未授权翻译", exact: true }).click(); await expect(tool).toContainText("工具未声明所需权限");
  await tool.getByRole("button", { name: "保存插件设置", exact: true }).click(); await expect(tool).toContainText("插件设置已保存"); await page.keyboard.press("Escape");
  await settings(page); const download = page.waitForEvent("download"); await section.getByRole("button", { name: "导出插件备份", exact: true }).click(); const saved = await download; expect(saved.suggestedFilename()).toBe("zhiye-plugins.json");
  await section.getByRole("button", { name: "卸载", exact: true }).click(); const remove = page.getByRole("dialog", { name: "卸载插件", exact: true }); await expect(remove.getByRole("checkbox")).not.toBeChecked(); await remove.getByRole("button", { name: "卸载插件", exact: true }).click();
  await expect(section).toContainText("尚未安装第三方插件"); await install(page, original); await expect(page.getByRole("checkbox", { name: "启用 示例阅读插件", exact: true })).toBeChecked();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("zhiye.external-plugins.v1")!).data["example.reader"].values.note)).toBe("retained private setting");
  await page.getByLabel("恢复插件备份", { exact: true }).setInputFiles((await saved.path())!); const restore = page.getByRole("dialog", { name: "确认恢复插件备份", exact: true }); await restore.getByRole("checkbox").check(); await restore.getByRole("button", { name: "恢复并保持停用", exact: true }).click();
  await section.getByRole("button", { name: "验证并启用", exact: true }).click(); await expect(page.getByRole("checkbox", { name: "启用 示例阅读插件", exact: true })).toBeChecked();
});

test("an upgrade requires renewed approval and a failed startup restores previous code and settings", async ({ page }) => {
  await page.goto("/"); await settings(page); await install(page, bundle()); await expect(page.getByRole("checkbox", { name: "启用 示例阅读插件", exact: true })).toBeChecked();
  await install(page, bundle("2.0.0", true));
  const section = page.getByRole("region", { name: "第三方插件", exact: true }); await expect(section.getByRole("alert")).toContainText("上一版及其设置已恢复");
  await expect(section.getByRole("heading", { name: "示例阅读插件 · 1.0.0", exact: true })).toBeVisible(); await expect(section.getByRole("checkbox", { name: "启用 示例阅读插件", exact: true })).toBeChecked();
  await install(page, bundle("3.0.0", false, "Promise.reject(new Error('async startup failure'));"));
  await expect(section.getByRole("heading", { name: "示例阅读插件 · 1.0.0", exact: true })).toBeVisible(); await expect(section.getByRole("checkbox", { name: "启用 示例阅读插件", exact: true })).toBeChecked();
});

test("external RPC rejects undeclared capabilities and missing selection tokens before any model or data write", async ({ page, request }) => {
  const listing = await request.get("/api/documents"), headers = { Origin: "http://127.0.0.1:4174", "X-Zhiye-Data-Epoch": listing.headers()["x-zhiye-data-epoch"] };
  const title = `插件权限资料${Date.now()}`, created = await (await request.post("/api/documents", { headers, data: { title } })).json();
  await request.patch(`/api/documents/${created.document.id}`, { headers, data: { revision: created.document.revision, markdown: "Permission-bound selected passage." } });
  const script = `
    zhiye.render({text:'准备校验权限',fields:[],actions:[{id:'check',label:'校验权限'}]});
    zhiye.onAction(async () => {
      const selected = await zhiye.selection(), results = [];
      let index = 0;
      for (const operation of [() => zhiye.storage.get('secret'), () => zhiye.storage.set('secret','value'), () => zhiye.translate(selected.token,'en'), () => zhiye.saveExcerpt(selected.token,'',''), () => zhiye.translate(undefined,'en'), () => zhiye.saveExcerpt(undefined,'','')]) {
        if(index++ === 3) await new Promise(resolve => setTimeout(resolve,650));
        try { await operation(); results.push('unexpected success'); } catch(error) { results.push(error.message); }
      }
      zhiye.render({text:JSON.stringify(results),fields:[],actions:[]});
    });`;
  let writes = 0;
  page.on("request", (request) => { if (/\/api\/reader-tools\/documents\/[^/]+\/(?:translate|annotations)$/u.test(new URL(request.url()).pathname) && request.method() === "POST") writes += 1; });
  await page.goto("/"); await settings(page); await install(page, bundle("1.0.0", false, script, ["selection.read"])); await expect(page.getByRole("checkbox", { name: "启用 示例阅读插件", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "返回列表", exact: true }).click(); await page.getByRole("button", { name: title, exact: true }).click();
  await page.locator(".reader-main .markdown-preview p").first().evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); });
  await page.getByRole("toolbar", { name: "选区操作" }).getByRole("button", { name: "示例阅读插件", exact: true }).click();
  const tool = page.getByRole("dialog", { name: "示例阅读插件", exact: true }); await tool.getByRole("button", { name: "校验权限", exact: true }).click();
  await expect(tool).toContainText("请先读取当前选区"); const results = JSON.parse((await tool.locator(".external-plugin-text").textContent())!) as string[];
  expect(results.filter((text) => text.includes("工具未声明所需权限"))).toHaveLength(4); expect(results.filter((text) => text.includes("请先读取当前选区"))).toHaveLength(2); expect(writes).toBe(0);
});
