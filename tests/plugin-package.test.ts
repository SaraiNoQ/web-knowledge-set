import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync, unzipSync } from "fflate";
import { PLUGIN_PACKAGE_BYTES, PluginPackageError, pluginSha256, stagePluginPackage, type PluginManifest, type VerifiedPluginPackage } from "../src/reader-tools/plugin-package.js";
import { PLUGIN_REGISTRY_KEY, createPluginRegistry, type PluginApproval } from "../src/reader-tools/plugin-registry.js";
import type { ToolStorageBackend } from "../src/reader-tools/tool-storage.js";

class MemoryStorage implements ToolStorageBackend {
  values = new Map<string, string>(); failWrite = false;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrite) throw new Error("quota"); this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
async function packageBytes(changes: Partial<PluginManifest> = {}, script = "document.body.textContent = 'Example tool';") {
  const entry = strToU8(script);
  const manifest: PluginManifest = { schemaVersion: 1, hostApiVersion: 1, id: "example.selection", name: "Selection example", version: "1.0.0", storageVersion: 1, publisher: { name: "Example publisher", origin: "https://example.test" }, permissions: ["selection.read", "storage.own"], entry: "main.js", files: { "main.js": await pluginSha256(entry) }, ...changes };
  return zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), "main.js": entry }, { level: 0 });
}
const approve = (pkg: VerifiedPluginPackage): PluginApproval => ({ sha256: pkg.sha256, permissions: pkg.manifest.permissions, publisherOrigin: pkg.manifest.publisher.origin });
function mutateCentral(bytes: Uint8Array, change: (view: DataView, offset: number) => void) {
  const copy = Uint8Array.from(bytes), view = new DataView(copy.buffer);
  for (let offset = 0; offset + 46 < copy.length; offset += 1) if (view.getUint32(offset, true) === 0x02014b50) { change(view, offset); return copy; }
  throw new Error("fixture central record missing");
}

test("plugin packages verify manifest, archive fingerprint and every declared asset", async () => {
  const bytes = await packageBytes(), pkg = await stagePluginPackage(bytes);
  assert.equal(pkg.sha256, await pluginSha256(bytes)); assert.equal(pkg.manifest.id, "example.selection"); assert.match(pkg.script, /Example tool/u);
  const files = unzipSync(bytes); files["main.js"] = strToU8("modified code");
  await assert.rejects(stagePluginPackage(zipSync(files, { level: 0 })), /哈希/u);
  files["extra.html"] = strToU8("<script>unlisted</script>"); await assert.rejects(stagePluginPackage(zipSync(files, { level: 0 })), PluginPackageError);
  await assert.rejects(stagePluginPackage(await packageBytes({ hostApiVersion: 2 as never })), /协议/u);
  await assert.rejects(stagePluginPackage(await packageBytes({ permissions: ["network" as never] })), /权限/u);
  await assert.rejects(stagePluginPackage(await packageBytes({ id: "translation" })), /命名空间/u);
  await assert.rejects(stagePluginPackage(await packageBytes({ publisher: { name: "Unverified", origin: "https://example.test/path" } })), /origin/u);
});

test("plugin ZIP rejects traversal, case collisions, encrypted/symlink files, bombs and corrupted headers before activation", async () => {
  const bytes = await packageBytes(), files = unzipSync(bytes);
  await assert.rejects(stagePluginPackage(zipSync({ ...files, "../main.js": files["main.js"]! })), PluginPackageError);
  await assert.rejects(stagePluginPackage(zipSync({ ...files, "MAIN.js": files["main.js"]! })), PluginPackageError);
  await assert.rejects(stagePluginPackage(mutateCentral(bytes, (view, offset) => view.setUint16(offset + 8, 1, true))), /加密/u);
  await assert.rejects(stagePluginPackage(mutateCentral(bytes, (view, offset) => view.setUint32(offset + 38, 0xa1ff0000, true))), /不支持/u);
  await assert.rejects(stagePluginPackage(mutateCentral(bytes, (view, offset) => view.setUint32(offset + 24, PLUGIN_PACKAGE_BYTES + 1, true))), /超限/u);
  await assert.rejects(stagePluginPackage(zipSync(files)), /不压缩/u);
  const corrupt = Uint8Array.from(bytes); corrupt[0] = 0; await assert.rejects(stagePluginPackage(corrupt), PluginPackageError);
  await assert.rejects(stagePluginPackage(new Uint8Array(70_000)), PluginPackageError);
});

test("plugin activation needs fingerprint, origin and exact permissions; upgrades stage disabled and failure restores code and settings", async () => {
  const backend = new MemoryStorage(), registry = createPluginRegistry(backend), first = await stagePluginPackage(await packageBytes());
  await assert.rejects(registry.install(first, { ...approve(first), sha256: "0".repeat(64) }), /尚未确认/u);
  await assert.rejects(registry.install(first, { ...approve(first), permissions: [] }), /权限/u);
  await assert.rejects(registry.install(first, { ...approve(first), publisherOrigin: "https://other.test" }), /来源/u);
  await registry.install(first, approve(first)); assert.deepEqual(registry.list().map(({ enabled, pending }) => ({ enabled, pending })), [{ enabled: false, pending: true }]);
  assert.throws(() => registry.setEnabled(first.manifest.id, true), /检查/u);
  registry.activate(first.manifest.id, first.sha256); const storage = registry.storage(first.manifest.id); storage.set("note", "original user data");
  const second = await stagePluginPackage(await packageBytes({ version: "1.1.0" }, "document.body.textContent='Upgrade';"));
  await registry.install(second, approve(second)); assert.equal(registry.list()[0]!.enabled, false); assert.equal(registry.list()[0]!.hasPrevious, true);
  registry.activate(second.manifest.id, second.sha256); storage.set("note", "new-version data"); registry.rollback(second.manifest.id);
  assert.equal(registry.list()[0]!.sha256, first.sha256); assert.equal(registry.list()[0]!.enabled, true); assert.equal(storage.get("note", ""), "original user data");
  assert.equal((await registry.getVerified(first.manifest.id)).script, first.script);
  const incompatible = await stagePluginPackage(await packageBytes({ version: "2.0.0", storageVersion: 2 }));
  const before = backend.getItem(PLUGIN_REGISTRY_KEY); await assert.rejects(registry.install(incompatible, approve(incompatible)), /私有设置版本/u); assert.equal(backend.getItem(PLUGIN_REGISTRY_KEY), before);
  await assert.rejects(registry.install(first, approve(first)), /高于/u);
});

test("registry writes and namespace quotas are atomic, disable keeps data and uninstall deletion is explicit", async () => {
  const backend = new MemoryStorage(), registry = createPluginRegistry(backend), pkg = await stagePluginPackage(await packageBytes());
  await registry.install(pkg, approve(pkg)); registry.activate(pkg.manifest.id, pkg.sha256); const storage = registry.storage(pkg.manifest.id); storage.set("note", "retained");
  const before = backend.getItem(PLUGIN_REGISTRY_KEY); backend.failWrite = true; assert.throws(() => storage.set("note", "lost"), /保留/u); assert.equal(backend.getItem(PLUGIN_REGISTRY_KEY), before);
  backend.failWrite = false; assert.throws(() => storage.set("huge", "字".repeat(30_000)), /64 KiB/u); assert.equal(storage.get("note", ""), "retained");
  assert.throws(() => storage.set("__proto__", { bad: true }), /名称/u);
  registry.setEnabled(pkg.manifest.id, false); assert.equal(storage.get("note", ""), "retained"); registry.uninstall(pkg.manifest.id); assert.equal(registry.list().length, 0);
  await registry.install(pkg, approve(pkg)); assert.equal(storage.get("note", ""), "retained"); registry.uninstall(pkg.manifest.id, true); await registry.install(pkg, approve(pkg)); assert.equal(storage.get("note", "empty"), "empty");
});

test("plugin backup restores verified packages disabled after fresh approval and does not replace different installed code", async () => {
  const source = createPluginRegistry(new MemoryStorage()), pkg = await stagePluginPackage(await packageBytes());
  await source.install(pkg, approve(pkg)); source.activate(pkg.manifest.id, pkg.sha256); source.storage(pkg.manifest.id).set("note", "backed-up result");
  const encoded = source.exportState(), targetBackend = new MemoryStorage(), target = createPluginRegistry(targetBackend);
  assert.equal((await target.inspectBackup(encoded))[0]!.sha256, pkg.sha256);
  await assert.rejects(target.importState(encoded, []), /尚未确认/u); assert.equal(targetBackend.getItem(PLUGIN_REGISTRY_KEY), null);
  await target.importState(encoded, [approve(pkg)]); assert.equal(target.list()[0]!.enabled, false); assert.equal(target.list()[0]!.pending, true); assert.equal(target.storage(pkg.manifest.id).get("note", ""), "backed-up result");
  const tampered = JSON.parse(encoded); tampered.installations[pkg.manifest.id].package.sha256 = "0".repeat(64); await assert.rejects(target.importState(JSON.stringify(tampered), [approve(pkg)]), /完整性/u);
  target.activate(pkg.manifest.id, pkg.sha256); const next = await stagePluginPackage(await packageBytes({ version: "1.0.1" })); await target.install(next, approve(next)); target.activate(next.manifest.id, next.sha256);
  const before = targetBackend.getItem(PLUGIN_REGISTRY_KEY); await assert.rejects(target.importState(encoded, [approve(pkg)]), /版本不同/u); assert.equal(targetBackend.getItem(PLUGIN_REGISTRY_KEY), before);
  source.uninstall(pkg.manifest.id); const orphan = source.exportState(), empty = createPluginRegistry(new MemoryStorage()); await empty.importState(orphan, []); await empty.install(pkg, approve(pkg)); assert.equal(empty.storage(pkg.manifest.id).get("note", ""), "backed-up result");
});

test("retained private data never follows the same claimed plugin ID to a different publisher origin", async () => {
  const backend = new MemoryStorage(), registry = createPluginRegistry(backend), first = await stagePluginPackage(await packageBytes());
  const changed = await stagePluginPackage(await packageBytes({ version: "1.1.0", publisher: { name: "Different publisher", origin: "https://different.test" } }));
  await registry.install(first, approve(first)); registry.activate(first.manifest.id, first.sha256); registry.storage(first.manifest.id).set("private", "original source only");
  let before = backend.getItem(PLUGIN_REGISTRY_KEY); await assert.rejects(registry.install(changed, approve(changed)), /不同发布者来源/u); assert.equal(backend.getItem(PLUGIN_REGISTRY_KEY), before);
  registry.uninstall(first.manifest.id); before = backend.getItem(PLUGIN_REGISTRY_KEY);
  assert.deepEqual(registry.retainedData(), [{ id: first.manifest.id, publisherOrigin: first.manifest.publisher.origin, storageVersion: 1 }]);
  await assert.rejects(registry.install(changed, approve(changed)), /不同发布者来源/u); assert.equal(backend.getItem(PLUGIN_REGISTRY_KEY), before);
  assert.throws(() => registry.clearRetainedData(first.manifest.id, changed.manifest.publisher.origin), /已变化/u); assert.equal(backend.getItem(PLUGIN_REGISTRY_KEY), before);
  await registry.install(first, approve(first)); assert.equal(registry.storage(first.manifest.id).get("private", ""), "original source only");
  assert.throws(() => registry.clearRetainedData(first.manifest.id, first.manifest.publisher.origin), /已安装/u);
  registry.uninstall(first.manifest.id); registry.clearRetainedData(first.manifest.id, first.manifest.publisher.origin); assert.deepEqual(registry.retainedData(), []);
  await registry.install(changed, approve(changed)); assert.equal(registry.storage(changed.manifest.id).get("private", "empty"), "empty");
});

test("backup restore rejects publisher-origin conflicts with orphan settings without changing either namespace", async () => {
  const first = await stagePluginPackage(await packageBytes()), second = await stagePluginPackage(await packageBytes({ publisher: { name: "Different", origin: "https://different.test" } }));
  const source = createPluginRegistry(new MemoryStorage()), targetBackend = new MemoryStorage(), target = createPluginRegistry(targetBackend);
  await source.install(first, approve(first)); source.storage(first.manifest.id).set("private", "source values"); const installedBackup = source.exportState(); source.uninstall(first.manifest.id); const orphanBackup = source.exportState();
  await target.install(second, approve(second)); target.storage(second.manifest.id).set("private", "target values"); target.uninstall(second.manifest.id);
  const before = targetBackend.getItem(PLUGIN_REGISTRY_KEY);
  await assert.rejects(target.importState(installedBackup, [approve(first)]), /不同发布者来源/u); assert.equal(targetBackend.getItem(PLUGIN_REGISTRY_KEY), before);
  await assert.rejects(target.importState(orphanBackup, []), /不同发布者来源/u); assert.equal(targetBackend.getItem(PLUGIN_REGISTRY_KEY), before);
  await target.install(second, approve(second)); assert.equal(target.storage(second.manifest.id).get("private", ""), "target values");
});

test("a stale startup probe cannot roll back a version already activated, replaced or uninstalled elsewhere", async () => {
  const backend = new MemoryStorage(), firstTab = createPluginRegistry(backend), otherTab = createPluginRegistry(backend);
  const first = await stagePluginPackage(await packageBytes()), second = await stagePluginPackage(await packageBytes({ version: "1.1.0" })), third = await stagePluginPackage(await packageBytes({ version: "1.2.0" }));
  await firstTab.install(first, approve(first)); firstTab.activate(first.manifest.id, first.sha256); firstTab.storage(first.manifest.id).set("note", "first version");
  await firstTab.install(second, approve(second)); firstTab.storage(second.manifest.id).set("note", "pending version");
  otherTab.activate(second.manifest.id, second.sha256); otherTab.storage(second.manifest.id).set("note", "activated elsewhere");
  let before = backend.getItem(PLUGIN_REGISTRY_KEY);
  assert.equal(firstTab.rollback(second.manifest.id, { sha256: second.sha256, pending: true }), false); assert.equal(backend.getItem(PLUGIN_REGISTRY_KEY), before);
  assert.equal(firstTab.storage(second.manifest.id).get("note", ""), "activated elsewhere");
  await otherTab.install(third, approve(third)); otherTab.storage(third.manifest.id).set("note", "newer pending data"); before = backend.getItem(PLUGIN_REGISTRY_KEY);
  assert.equal(firstTab.rollback(second.manifest.id, { sha256: second.sha256, pending: true }), false); assert.equal(backend.getItem(PLUGIN_REGISTRY_KEY), before);
  assert.equal(firstTab.storage(third.manifest.id).get("note", ""), "newer pending data");
  assert.equal(firstTab.rollback(third.manifest.id, { sha256: third.sha256, pending: true }), true);
  assert.equal(firstTab.list()[0]!.sha256, second.sha256); assert.equal(firstTab.storage(second.manifest.id).get("note", ""), "activated elsewhere");
  otherTab.uninstall(second.manifest.id); before = backend.getItem(PLUGIN_REGISTRY_KEY);
  assert.equal(firstTab.rollback(second.manifest.id, { sha256: second.sha256, pending: true }), false); assert.equal(backend.getItem(PLUGIN_REGISTRY_KEY), before);
});

test("a late ready message cannot reactivate a canceled probe with the same package fingerprint", async () => {
  const backend = new MemoryStorage(), registry = createPluginRegistry(backend), pkg = await stagePluginPackage(await packageBytes());
  await registry.install(pkg, approve(pkg)); assert.equal(registry.rollback(pkg.manifest.id, { sha256: pkg.sha256, pending: true }), true);
  const before = backend.getItem(PLUGIN_REGISTRY_KEY);
  assert.throws(() => registry.activate(pkg.manifest.id, pkg.sha256), /检查状态已变化/u); assert.equal(backend.getItem(PLUGIN_REGISTRY_KEY), before);
  assert.equal(registry.list()[0]!.enabled, false); assert.equal(registry.list()[0]!.pending, false);
  registry.setEnabled(pkg.manifest.id, true); const active = backend.getItem(PLUGIN_REGISTRY_KEY);
  assert.throws(() => registry.activate(pkg.manifest.id, pkg.sha256), /检查状态已变化/u); assert.equal(backend.getItem(PLUGIN_REGISTRY_KEY), active); assert.equal(registry.list()[0]!.enabled, true);
});
