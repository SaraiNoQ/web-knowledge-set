import type { ToolStorageBackend } from "./tool-storage";
import { READER_TOOL_STORAGE_BYTES } from "./tool-storage";
import { PLUGIN_STATE_BYTES, PluginPackageError, parsePluginManifest, pluginArchiveBytes, pluginIdValid, pluginObject, stagePluginPackage, type PluginManifest, type PluginPermission, type VerifiedPluginPackage } from "./plugin-package";

export const PLUGIN_REGISTRY_KEY = "zhiye.external-plugins.v1";
export interface PluginApproval { sha256: string; permissions: PluginPermission[]; publisherOrigin: string }
export interface InstalledPlugin { id: string; manifest: PluginManifest; sha256: string; enabled: boolean; pending: boolean; hasPrevious: boolean }
interface SavedPackage { manifest: PluginManifest; sha256: string; archive: string }
interface PluginData { schemaVersion: number; publisherOrigin: string; values: Record<string, unknown> }
interface SavedInstallation { package: SavedPackage; enabled: boolean; pending: boolean; previous: { package: SavedPackage; enabled: boolean; data: PluginData } | null }
interface RegistryState { schemaVersion: 1; installations: Record<string, SavedInstallation>; data: Record<string, PluginData> }
interface BackupState { format: "zhiye-plugin-backup"; schemaVersion: 1; installations: Record<string, SavedInstallation>; data: Record<string, PluginData> }
const fail = (message: string): never => { throw new PluginPackageError(message); };
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const validKey = (key: string) => typeof key === "string" && key.length > 0 && key.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(key) && !["__proto__", "constructor", "prototype"].includes(key);
function json(value: unknown): string { try { const encoded = JSON.stringify(value); if (encoded === undefined) return fail("插件设置必须是 JSON 数据。"); return encoded; } catch { return fail("插件设置必须是 JSON 数据。"); } }
function dataValue(value: unknown): PluginData {
  const v = pluginObject(value, ["schemaVersion", "publisherOrigin", "values"]);
  if (!Number.isSafeInteger(v.schemaVersion) || Number(v.schemaVersion) < 1 || Number(v.schemaVersion) > 100 || !v.values || typeof v.values !== "object" || Array.isArray(v.values) || Object.keys(v.values).some((key) => !validKey(key))) return fail("插件私有设置格式无效。");
  let origin: URL; try { origin = new URL(String(v.publisherOrigin)); } catch { return fail("插件私有设置缺少有效来源。"); }
  if (typeof v.publisherOrigin !== "string" || origin.protocol !== "https:" || origin.origin !== v.publisherOrigin) return fail("插件私有设置缺少有效来源。");
  const data = { schemaVersion: Number(v.schemaVersion), publisherOrigin: v.publisherOrigin, values: v.values as Record<string, unknown> };
  if (bytes(json(data)) > READER_TOOL_STORAGE_BYTES) return fail("插件私有设置超过 64 KiB，原设置未修改。");
  return data;
}
function savedPackage(value: unknown): SavedPackage {
  const v = pluginObject(value, ["manifest", "sha256", "archive"]), manifest = parsePluginManifest(v.manifest);
  if (typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(v.sha256) || typeof v.archive !== "string") return fail("已保存的插件包格式无效。");
  pluginArchiveBytes(v.archive);
  return { manifest, sha256: v.sha256, archive: v.archive };
}
function readState(value: unknown): RegistryState {
  const v = pluginObject(value, ["schemaVersion", "installations", "data"]);
  if (v.schemaVersion !== 1 || !v.installations || typeof v.installations !== "object" || Array.isArray(v.installations) || !v.data || typeof v.data !== "object" || Array.isArray(v.data)) return fail("插件注册记录已损坏，原记录未修改。");
  const installations: RegistryState["installations"] = Object.create(null), data: RegistryState["data"] = Object.create(null);
  if (Object.keys(v.installations).length > 20 || Object.keys(v.data).length > 40) return fail("插件数量超过当前上限。");
  for (const [id, raw] of Object.entries(v.data)) { if (!pluginIdValid(id)) return fail("插件私有设置命名空间无效。"); data[id] = dataValue(raw); }
  for (const [id, raw] of Object.entries(v.installations)) {
    if (!pluginIdValid(id)) return fail("插件命名空间无效。");
    const item = pluginObject(raw, ["package", "enabled", "pending", "previous"]), pkg = savedPackage(item.package);
    if (pkg.manifest.id !== id || typeof item.enabled !== "boolean" || typeof item.pending !== "boolean" || item.pending && item.enabled || data[id]?.schemaVersion !== pkg.manifest.storageVersion || data[id]?.publisherOrigin !== pkg.manifest.publisher.origin) return fail("插件注册记录与私有设置版本或来源不匹配。");
    let previous: SavedInstallation["previous"] = null;
    if (item.previous !== null) {
      const old = pluginObject(item.previous, ["package", "enabled", "data"]), previousPackage = savedPackage(old.package), previousData = dataValue(old.data);
      if (previousPackage.manifest.id !== id || typeof old.enabled !== "boolean" || previousData.schemaVersion !== previousPackage.manifest.storageVersion || previousData.publisherOrigin !== previousPackage.manifest.publisher.origin) return fail("插件回退快照无效。");
      previous = { package: previousPackage, enabled: old.enabled, data: previousData };
    }
    installations[id] = { package: pkg, enabled: item.enabled, pending: item.pending, previous };
  }
  return { schemaVersion: 1, installations, data };
}
async function verified(saved: SavedPackage): Promise<VerifiedPluginPackage> {
  const pkg = await stagePluginPackage(pluginArchiveBytes(saved.archive));
  if (pkg.sha256 !== saved.sha256 || json(pkg.manifest) !== json(saved.manifest)) return fail("已保存的插件完整性校验失败，请重新导入已确认的原包。");
  return pkg;
}
function approved(pkg: SavedPackage, approval: PluginApproval) {
  if (!approval || approval.sha256 !== pkg.sha256 || approval.publisherOrigin !== pkg.manifest.publisher.origin || !Array.isArray(approval.permissions) || json([...approval.permissions].sort()) !== json([...pkg.manifest.permissions].sort())) return fail("尚未确认此插件指纹、发布者来源和全部权限。");
}
function versionAfter(next: string, previous: string) {
  const a = next.split(".").map(Number), b = previous.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) { if (a[index] !== b[index]) return a[index]! > b[index]!; }
  return false;
}
const listed = (id: string, item: SavedInstallation): InstalledPlugin => ({ id, manifest: clone(item.package.manifest), sha256: item.package.sha256, enabled: item.enabled, pending: item.pending, hasPrevious: Boolean(item.previous) });

export function createPluginRegistry(backend: ToolStorageBackend) {
  const listeners = new Set<() => void>();
  let cachedRaw: string | null | undefined, cachedState: RegistryState | undefined;
  const load = () => {
    let raw: string | null; try { raw = backend.getItem(PLUGIN_REGISTRY_KEY); } catch { return fail("浏览器暂时无法读取插件，请稍后重试。"); }
    if (cachedState && raw === cachedRaw) return cachedState;
    if (raw !== null && bytes(raw) > PLUGIN_STATE_BYTES) return fail("插件记录超过 4 MiB，原记录未修改。");
    let value: unknown; try { value = raw === null ? { schemaVersion: 1, installations: {}, data: {} } : JSON.parse(raw); } catch { return fail("插件注册记录已损坏，原记录未修改。"); }
    cachedState = readState(value); cachedRaw = raw; return cachedState;
  };
  const save = (next: RegistryState) => {
    const encoded = json(next);
    if (bytes(encoded) > PLUGIN_STATE_BYTES) return fail("插件包及设置合计超过 4 MiB，请先导出并卸载不用的插件。");
    readState(next);
    try { backend.setItem(PLUGIN_REGISTRY_KEY, encoded); } catch { return fail("浏览器未能保存插件，原包和设置均已保留。请先导出并清理空间。"); }
    cachedRaw = encoded; cachedState = next;
    for (const listener of listeners) listener();
  };
  const mutable = () => clone(load());
  const installed = (state: RegistryState, id: string) => state.installations[id] ?? fail("插件尚未安装。");
  const inspectBackup = async (encoded: string) => {
    if (typeof encoded !== "string" || bytes(encoded) > PLUGIN_STATE_BYTES) return fail("插件备份超过 4 MiB。");
    let parsed: unknown; try { parsed = JSON.parse(encoded); } catch { return fail("插件备份不是有效 JSON。"); }
    const raw = pluginObject(parsed, ["format", "schemaVersion", "installations", "data"]);
    if (raw.format !== "zhiye-plugin-backup") return fail("这不是织页插件备份。");
    const state = readState({ schemaVersion: raw.schemaVersion, installations: raw.installations, data: raw.data });
    for (const item of Object.values(state.installations)) { await verified(item.package); if (item.previous) await verified(item.previous.package); }
    return state;
  };
  const externalChange = (event: StorageEvent) => { if (event.key === null || event.key === PLUGIN_REGISTRY_KEY) { cachedRaw = undefined; cachedState = undefined; for (const listener of listeners) listener(); } };
  return {
    list: (): InstalledPlugin[] => Object.entries(load().installations).map(([id, item]) => listed(id, item)),
    async getVerified(id: string) { return verified(installed(load(), id).package); },
    async install(pkg: VerifiedPluginPackage, approval: PluginApproval) {
      const checked = await stagePluginPackage(pluginArchiveBytes(pkg.archive));
      if (checked.sha256 !== pkg.sha256 || json(checked.manifest) !== json(pkg.manifest)) return fail("插件暂存内容已变化，请重新选择原包。");
      const saved: SavedPackage = { manifest: checked.manifest, sha256: checked.sha256, archive: checked.archive }; approved(saved, approval);
      const state = mutable(), id = checked.manifest.id, old = state.installations[id], data = state.data[id];
      if (old && !versionAfter(checked.manifest.version, old.package.manifest.version)) return fail("升级版本必须高于当前版本；需要旧版时请使用回退。");
      if (data && data.publisherOrigin !== checked.manifest.publisher.origin) return fail("此 ID 的原设置属于不同发布者来源。请先导出并明确卸载清理设置，再安装新来源；原数据未修改。");
      if (data && data.schemaVersion !== checked.manifest.storageVersion) return fail("此插件更改了私有设置版本。请先导出设置并卸载清理，再单独安装，原设置未修改。");
      if (old?.pending) return fail("请先确认或撤回尚未启用的插件版本。");
      state.data[id] ??= { schemaVersion: checked.manifest.storageVersion, publisherOrigin: checked.manifest.publisher.origin, values: {} };
      state.installations[id] = { package: saved, enabled: false, pending: true, previous: old ? { package: old.package, enabled: old.enabled, data: clone(state.data[id]!) } : null };
      save(state);
    },
    activate(id: string, sha256: string) { const state = mutable(), item = installed(state, id); if (item.package.sha256 !== sha256) return fail("插件版本已变化，请重新打开。"); item.enabled = true; item.pending = false; save(state); },
    setEnabled(id: string, enabled: boolean) { const state = mutable(), item = installed(state, id); if (enabled && item.pending) return fail("插件尚未完成运行检查，请先打开并验证。"); item.enabled = enabled; save(state); },
    rollback(id: string) {
      const state = mutable(), item = installed(state, id), previous = item.previous;
      if (!previous) { item.enabled = false; item.pending = false; } else { state.installations[id] = { package: previous.package, enabled: previous.enabled, pending: false, previous: null }; state.data[id] = clone(previous.data); }
      save(state);
    },
    uninstall(id: string, removeData = false) { const state = mutable(); installed(state, id); delete state.installations[id]; if (removeData) delete state.data[id]; save(state); },
    retainedData() { const state = load(); return Object.entries(state.data).filter(([id]) => !state.installations[id]).map(([id, data]) => ({ id, publisherOrigin: data.publisherOrigin, storageVersion: data.schemaVersion })); },
    clearRetainedData(id: string, publisherOrigin: string) {
      const state = mutable();
      if (!pluginIdValid(id) || state.installations[id] || !state.data[id] || state.data[id]!.publisherOrigin !== publisherOrigin) return fail("保留设置已变化，或插件仍已安装；原设置未修改。");
      delete state.data[id]; save(state);
    },
    storage(id: string) {
      if (!pluginIdValid(id)) return fail("插件私有设置命名空间无效。");
      return {
        get<T>(key: string, fallback: T): T { if (!validKey(key)) return fail("插件设置名称无效。"); const state = load(); installed(state, id); const values = state.data[id]!.values; return Object.hasOwn(values, key) ? clone(values[key]) as T : fallback; },
        set(key: string, value: unknown) { if (!validKey(key)) return fail("插件设置名称无效。"); const state = mutable(); installed(state, id); const safeValue = JSON.parse(json(value)) as unknown; state.data[id]!.values[key] = safeValue; dataValue(state.data[id]); save(state); },
      };
    },
    subscribe(listener: () => void) { if (!listeners.size && typeof window !== "undefined") window.addEventListener("storage", externalChange); listeners.add(listener); return () => { listeners.delete(listener); if (!listeners.size && typeof window !== "undefined") window.removeEventListener("storage", externalChange); }; },
    exportState() { const state = clone(load()); return json({ format: "zhiye-plugin-backup", ...state } satisfies BackupState); },
    async inspectBackup(encoded: string): Promise<InstalledPlugin[]> { const state = await inspectBackup(encoded); return Object.entries(state.installations).map(([id, item]) => listed(id, item)); },
    async importState(encoded: string, approvals: PluginApproval[]) {
      const restored = await inspectBackup(encoded);
      for (const item of Object.values(restored.installations)) { const approval = approvals.find((value) => value.sha256 === item.package.sha256); approved(item.package, approval!); }
      const state = mutable();
      for (const [id, data] of Object.entries(restored.data)) {
        if (state.data[id] && state.data[id]!.publisherOrigin !== data.publisherOrigin) return fail("备份私有设置属于不同发布者来源。请先导出并明确清理旧设置；原数据未修改。");
        if (!restored.installations[id]) {
          if (state.installations[id] || state.data[id] && json(state.data[id]) !== json(data)) return fail("备份包含已卸载插件的设置，与当前数据冲突；原数据未修改。");
          state.data[id] = clone(data); continue;
        }
        const active = state.installations[id];
        if (active && active.package.sha256 !== restored.installations[id]!.package.sha256) return fail("备份与当前插件版本不同，请先导出当前状态并卸载对应插件。");
        const item = restored.installations[id]!;
        state.data[id] = clone(data); state.installations[id] = { package: item.package, enabled: false, pending: true, previous: active ? { package: active.package, enabled: active.enabled, data: clone(load().data[id]!) } : null };
      }
      save(state);
    },
  };
}
export type PluginRegistry = ReturnType<typeof createPluginRegistry>;
