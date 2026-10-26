import { useState } from "react";
import { Button, Checkbox } from "../components/ui/Controls";
import { FileSelectButton } from "../components/ui/Uploads";
import { Modal } from "../components/ui/Modal";
import { useDialogs, useToast } from "../components/ui/Feedback";
import { pluginRegistry, useExternalPlugins } from "./external-plugins";
import { PLUGIN_PACKAGE_BYTES, PLUGIN_STATE_BYTES, stagePluginPackage, type VerifiedPluginPackage } from "./plugin-package";
import type { InstalledPlugin, PluginApproval } from "./plugin-registry";
import { PluginView } from "./PluginView";

const labels = { "selection.read": "读取当前选区", "translation.request": "通过已配置模型翻译选区", "storage.own": "保存自己的私有设置", "annotations.create": "保存选区摘录" };
const approval = (item: Pick<InstalledPlugin, "sha256" | "manifest">): PluginApproval => ({ sha256: item.sha256, publisherOrigin: item.manifest.publisher.origin, permissions: item.manifest.permissions });
const message = (cause: unknown) => cause instanceof Error ? cause.message : "操作失败，请重试。";
function PackageDetails({ item }: { item: Pick<InstalledPlugin, "sha256" | "manifest"> }) {
  return <div className="plugin-package-details"><h3>{item.manifest.name} · {item.manifest.version}</h3><p>{item.manifest.publisher.name} · {item.manifest.publisher.origin}</p><code>{item.sha256}</code><ul>{item.manifest.permissions.map((permission) => <li key={permission}>{labels[permission]}</li>)}</ul>{!item.manifest.permissions.length && <p>不申请资料或私有设置权限。</p>}</div>;
}
export function PluginSettings() {
  const { plugins, retained, error: registryError } = useExternalPlugins(), dialogs = useDialogs(), toast = useToast();
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [accepted, setAccepted] = useState(false);
  const [staged, setStaged] = useState<VerifiedPluginPackage | null>(null), [probe, setProbe] = useState<VerifiedPluginPackage | null>(null);
  const [backup, setBackup] = useState<{ text: string; items: InstalledPlugin[] } | null>(null);
  const [removing, setRemoving] = useState<InstalledPlugin | null>(null), [removeData, setRemoveData] = useState(false);
  const perform = async (action: () => Promise<void> | void) => { setBusy(true); setError(""); try { await action(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } };
  const start = async (id: string) => { setProbe(await pluginRegistry.getVerified(id)); };
  const failed = (reason: string) => { if (!probe) return; try { pluginRegistry.rollback(probe.manifest.id); } catch (cause) { setError(message(cause)); } setProbe(null); setError(`${reason} 已停用此版本；可用的上一版及其设置已恢复。`); };
  return <section className="external-plugin-settings" aria-label="第三方插件"><h2>第三方插件</h2>
    <p>导入本地插件包。插件在可终止的后台环境中运行，界面由织页绘制；不能读取整页、访问网络或修改页面样式。</p>
    <p>包和私有设置仅保存在当前浏览器，最多 4 MiB。请单独导出备份；插件保存的摘录属于知识库。</p>
    <div className="reader-tool-actions"><FileSelectButton label="导入插件包" accept=".zip,application/zip" disabled={busy || Boolean(probe)} onChange={(event) => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file) return;
      void perform(async () => { if (file.size > PLUGIN_PACKAGE_BYTES) throw new Error("插件包超过 1 MiB。"); setStaged(await stagePluginPackage(new Uint8Array(await file.arrayBuffer()))); setAccepted(false); });
    }} /><Button disabled={busy || Boolean(probe)} onClick={() => void perform(() => {
      const url = URL.createObjectURL(new Blob([pluginRegistry.exportState()], { type: "application/json" })), link = document.createElement("a"); link.href = url; link.download = "zhiye-plugins.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    })}>导出插件备份</Button><FileSelectButton label="恢复插件备份" accept=".json,application/json" disabled={busy || Boolean(probe)} onChange={(event) => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file) return;
      void perform(async () => { if (file.size > PLUGIN_STATE_BYTES) throw new Error("备份超过 4 MiB。"); const text = await file.text(); setBackup({ text, items: await pluginRegistry.inspectBackup(text) }); setAccepted(false); });
    }} /></div>
    {(error || registryError) && <p role="alert" className="error-text">{error || registryError}</p>}
    {!plugins.length && <p>尚未安装第三方插件。</p>}
    <ul className="external-plugin-list">{plugins.map((item) => <li key={item.id}><h3>{item.manifest.name} · {item.manifest.version}</h3><p>{item.manifest.publisher.origin}</p><div className="reader-tool-actions">
      {item.pending ? <Button disabled={busy || Boolean(probe)} onClick={() => void perform(() => start(item.id))}>验证并启用</Button> : <Checkbox label={`启用 ${item.manifest.name}`} checked={item.enabled} disabled={busy || Boolean(probe)} onChange={(event) => void perform(() => { pluginRegistry.setEnabled(item.id, event.target.checked); })} />}
      {item.hasPrevious && <Button disabled={busy || Boolean(probe)} onClick={() => void perform(async () => { if (await dialogs.confirm("回退插件代码，并恢复升级前的私有设置。此后在插件中修改的设置会被替换；知识库摘录保持保留。", { title: "回退插件", confirmLabel: "回退代码与设置" })) pluginRegistry.rollback(item.id); })}>回退上一版</Button>}
      <Button disabled={busy || Boolean(probe)} onClick={() => { setRemoving(item); setRemoveData(false); }}>卸载</Button>
    </div></li>)}</ul>
    {retained.length > 0 && <section aria-label="已卸载插件的设置"><h3>保留的插件设置</h3><ul className="external-plugin-list">{retained.map((item) => <li key={item.id}><p>{item.id} · {item.publisherOrigin}</p><Button disabled={busy || Boolean(probe)} onClick={() => void perform(async () => { if (await dialogs.confirm("永久删除此已卸载插件的私有设置？请先导出插件备份，知识库摘录不受影响。", { title: "清除插件设置", confirmLabel: "永久删除设置", tone: "danger" })) pluginRegistry.clearRetainedData(item.id, item.publisherOrigin); })}>清除保留设置</Button></li>)}</ul></section>}
    {probe && <div role="status">正在验证 {probe.manifest.name}…<Button onClick={() => failed("已取消验证。")}>取消验证</Button><div hidden><PluginView pkg={probe} api={null} onReady={() => { try { pluginRegistry.activate(probe.manifest.id, probe.sha256); setProbe(null); toast.success("插件已启用，可在阅读器中打开。"); } catch (cause) { failed(message(cause)); } }} onFailure={failed} /></div></div>}
    <Modal open={Boolean(staged || backup)} title={staged ? "确认安装插件" : "确认恢复插件备份"} dismissible={!busy} onClose={() => { setStaged(null); setBackup(null); }} footer={<><Button disabled={busy} onClick={() => { setStaged(null); setBackup(null); }}>取消</Button><Button variant="primary" disabled={!accepted || busy} onClick={() => void perform(async () => {
      if (staged) { const pkg = staged; await pluginRegistry.install(pkg, approval(pkg)); setStaged(null); setProbe(pkg); }
      else if (backup) { await pluginRegistry.importState(backup.text, backup.items.map(approval)); setBackup(null); toast.success("插件备份已恢复，请逐个验证并启用。"); }
    })}>{staged ? "安装并验证" : "恢复并保持停用"}</Button></>}>
      <p>发布者名称和来源是包内声明，未经身份认证。指纹用于核对文件，不能证明代码安全。只安装你确认来源的包；隔离环境仍可能消耗设备内存。</p>
      {backup && <p>恢复会替换相同版本插件的私有设置。请先导出当前插件备份；恢复后逐个验证并启用。</p>}
      {staged ? <><PackageDetails item={staged} />{plugins.some((item) => item.id === staged.manifest.id) && <p>升级会重新确认全部权限，并保留上一版代码与设置供回退。</p>}</> : backup?.items.map((item) => <PackageDetails key={item.id} item={item} />)}
      <Checkbox label="我已核对来源、文件指纹和所列权限" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
      {error && <p role="alert" className="error-text">{error}</p>}
    </Modal>
    <Modal open={Boolean(removing)} title="卸载插件" onClose={() => setRemoving(null)} footer={<><Button onClick={() => setRemoving(null)}>取消</Button><Button variant="danger" onClick={() => void perform(() => { if (removing) pluginRegistry.uninstall(removing.id, removeData); setRemoving(null); })}>卸载插件</Button></>}>
      <p>卸载 {removing?.manifest.name}。默认保留私有设置，重新安装相同设置版本时可继续使用。</p><Checkbox label="同时删除此插件的私有设置" checked={removeData} onChange={(event) => setRemoveData(event.target.checked)} />
      {error && <p role="alert" className="error-text">{error}</p>}
    </Modal>
  </section>;
}
