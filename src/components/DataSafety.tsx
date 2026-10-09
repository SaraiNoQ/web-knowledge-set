import { FileSelectButton } from "./ui/Uploads";
import { Button } from "./ui/Controls";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { BackupReason, BackupRecord, BackupStatus } from "../../shared/types";
import { api, ApiRequestError, type DataSafetyStatus, type RestoreBackupResult } from "../api";
import { userErrorMessage } from "../error-messages";
import { useDialogs } from "./ui/Feedback";

const reasonLabels: Record<BackupReason, string> = {
  manual: "手动备份",
  automatic: "每日备份",
  "pre-migration": "升级备份",
  "pre-restore": "恢复前副本",
};

const statusLabels: Record<BackupStatus, string> = {
  creating: "创建中",
  verified: "检查通过",
  failed: "创建失败",
  invalid: "检查失败",
  missing: "文件缺失",
};

function dateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function bytes(value: number | null | undefined) {
  if (value == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 && unit ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

function BackupRow({
  backup,
  busy,
  recovery,
  onVerify,
  onExport,
  onRestore,
  onDelete,
}: {
  backup: BackupRecord;
  busy: boolean;
  recovery: boolean;
  onVerify: () => void;
  onExport: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const restorable = backup.status === "verified" && Boolean(backup.directoryName);
  return (
    <li className="backup-row">
      <div className="backup-date">
        <time dateTime={backup.createdAt}>{dateTime(backup.createdAt)}</time>
        <span>{reasonLabels[backup.reason]}</span>
      </div>
      <div className="backup-facts">
        <span className={`backup-status is-${backup.status}`}>{statusLabels[backup.status]}</span>
        <span>{bytes(backup.totalBytes)}</span>
        {backup.schemaVersion && <span>schema {backup.schemaVersion}</span>}
      </div>
      {(backup.errorCode || backup.errorMessage) && <p className="backup-error">{userErrorMessage(backup.errorCode ?? "BACKUP_FAILED")}</p>}
      <div className="backup-actions">
        <Button type="button" onClick={onVerify} disabled={busy || recovery || !backup.directoryName}>检查备份</Button>
        <Button type="button" onClick={onExport} disabled={busy || !restorable}>下载备份</Button>
        <Button className="restore-button" type="button" onClick={onRestore} disabled={busy || !restorable}>恢复备份</Button>
        <Button className="delete-button" type="button" onClick={onDelete} disabled={busy}>删除备份</Button>
      </div>
    </li>
  );
}

export function DataSafety({
  cloud = false,
  beforeOperation,
  onClose,
  onModeChange,
  onDiagnostics,
}: {
  cloud?: boolean;
  beforeOperation: () => Promise<void>;
  onClose: () => void;
  onModeChange: (recovery: boolean) => void;
  onDiagnostics: () => void;
}) {
  const dialogs = useDialogs();
  const [status, setStatus] = useState<DataSafetyStatus | null>(null);
  const [retention, setRetention] = useState(7);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dataDirectory, setDataDirectory] = useState<string | null>(null);
  const [dataDirectoryError, setDataDirectoryError] = useState("");
  const desktop = "__TAURI_INTERNALS__" in window;
  const statusRef = useRef(status);
  const busyRef = useRef(busy);
  statusRef.current = status;
  busyRef.current = busy;

  const loadDataDirectory = useCallback(async () => {
    if (!desktop) return;
    setDataDirectoryError("");
    try {
      const path = await invoke<string>("get_data_directory");
      setDataDirectory(path || null);
    } catch (cause) {
      setDataDirectoryError((cause as Error).message || "无法读取当前知识库位置。");
    }
  }, [desktop]);

  const refresh = useCallback(async () => {
    const next = await api.getDataSafety();
    setStatus(next);
    setRetention(next.settings?.automaticRetentionCount ?? 7);
    onModeChange(next.mode === "recovery");
    void loadDataDirectory();
    return next;
  }, [loadDataDirectory, onModeChange]);

  useEffect(() => {
    void refresh().catch((cause) => setError((cause as Error).message));
  }, [refresh]);

  useEffect(() => {
    if (!status?.maintenance) return;
    const timer = window.setTimeout(() => {
      void refresh().catch((cause) => setError((cause as Error).message));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [refresh, status]);

  const perform = async (name: string, work: () => Promise<unknown>, message: string) => {
    if (busyRef.current) return;
    busyRef.current = name;
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await work();
      setNotice(message);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
      await refresh().catch(() => undefined);
    } finally {
      busyRef.current = "";
      setBusy("");
    }
  };

  const createBackup = () => perform("create", async () => {
    await beforeOperation();
    await api.createBackup();
  }, "备份已完成，并通过检查。");

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const accepted = cloud ? [".zhiye-cloud-backup"] : [".zhiye-backup", ".zhiye-cloud-backup"];
    if (!accepted.some((extension) => file.name.toLocaleLowerCase().endsWith(extension))) {
      setError(`请选择 ${accepted.join(" / ")} 完整备份文件。`);
      return;
    }
    const maxBytes = cloud ? 8 * 1024 * 1024 : 2 * 1024 * 1024 * 1024;
    if (file.size > maxBytes) {
      setError(`备份文件超过 ${cloud ? "8 MiB" : "2 GiB"} 安全上限，无法导入。`);
      return;
    }
    if (!await dialogs.confirm(
      "备份文件未加密，可能含完整资料。导入不替换当前资料，也不会自动恢复。继续吗？",
      { title: "导入备份", confirmLabel: "继续导入", tone: "warning" },
    ) || busyRef.current) return;
    await perform("import", () => api.importBackup(file), "备份已导入并检查，当前资料未改动。需要恢复时，请选择“恢复备份”。");
  };

  const verify = (backup: BackupRecord) => perform(`verify:${backup.id}`, () => api.verifyBackup(backup.id), "备份校验完成。");

  const exportBackup = async (backup: BackupRecord) => {
    if (busyRef.current || !await dialogs.confirm(
      "备份未加密，包含完整资料。确定下载吗？",
      { title: "下载备份", confirmLabel: "继续下载", tone: "warning" },
    )) return;
    const current = statusRef.current?.backups.find((value) => value.id === backup.id);
    if (busyRef.current || statusRef.current?.maintenance || current?.status !== "verified" || !current.directoryName) return;
    const link = document.createElement("a");
    link.href = api.backupExportUrl(current.id);
    link.download = "";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  };

  const restore = async (backup: BackupRecord) => {
    if (busyRef.current || !await dialogs.confirm(
      `恢复 ${dateTime(backup.createdAt)} 的备份？当前数据会先另行备份，随后应用将重新载入。`,
      { title: "恢复备份", confirmLabel: "开始恢复", tone: "danger" },
    )) return;
    const current = statusRef.current?.backups.find((value) => value.id === backup.id);
    if (busyRef.current || !current || current.status !== "verified" || !current.directoryName) return;
    const operation = `restore:${current.id}`;
    busyRef.current = operation;
    setBusy(operation);
    setError("");
    setNotice("");
    try {
      if (!cloud && statusRef.current?.mode === "ready") await beforeOperation();
      let result: RestoreBackupResult;
      try {
        result = await api.restoreBackup(current.id);
      } catch (cause) {
        if (!(cause instanceof ApiRequestError) || cause.code !== "QUARANTINE_REQUIRED") throw cause;
        if (!await dialogs.confirm(
          "当前数据无法备份。继续会单独保留全部旧数据，再恢复备份。仍要继续吗？",
          { title: "保留旧库", confirmLabel: "保留恢复", tone: "danger" },
        ) || busyRef.current !== operation || !statusRef.current?.backups.some((value) => value.id === current.id)) return;
        result = await api.restoreBackup(current.id, true);
      }
      const warnings = [
        result.quarantinedDataPath && `恢复完成；原有数据已隔离保留在 ${result.quarantinedDataPath}。`,
        result.cleanupPending && "恢复完成，但旧数据目录仍待下次启动清理。",
      ].filter(Boolean);
      if (warnings.length) await dialogs.alert(warnings.join("\n"), { title: "恢复完成", tone: "warning" });
      window.location.reload();
    } catch (cause) {
      setError((cause as Error).message);
      await refresh().catch(() => undefined);
    } finally {
      busyRef.current = "";
      setBusy("");
    }
  };

  const deleteBackup = async (backup: BackupRecord) => {
    if (busyRef.current || !await dialogs.confirm(
      `删除 ${dateTime(backup.createdAt)} 的备份？删除后无法恢复。`,
      { title: "删除备份", confirmLabel: "删除备份", tone: "danger" },
    )) return;
    await perform(`delete:${backup.id}`, () => api.deleteBackup(backup.id), "备份已删除。");
  };

  const saveRetention = (event: FormEvent) => {
    event.preventDefault();
    if (!Number.isInteger(retention) || retention < 1 || retention > 100) {
      setError("自动备份保留数量必须在 1 到 100 之间。");
      return;
    }
    void perform("settings", () => api.updateBackupSettings(retention), "自动备份数量已更新。");
  };

  const changeDataDirectory = async () => {
    if (cloud || !desktop || busyRef.current || statusRef.current?.maintenance || statusRef.current?.mode === "recovery") return;
    if (!await dialogs.confirm(
      "请选择一个空文件夹。保存修改后，会迁移全部数据并重启。迁移失败会保留原位置。继续吗？",
      { title: "更换位置", confirmLabel: "选择新位置", tone: "warning" },
    ) || busyRef.current) return;
    busyRef.current = "location";
    setBusy("location");
    setError("");
    setNotice("");
    try {
      await beforeOperation();
      const result = await invoke<{ configured: boolean }>("change_data_directory");
      if (result.configured) setNotice("新位置已选择，正在安全迁移并重新启动…");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      busyRef.current = "";
      setBusy("");
    }
  };

  const cleanup = async () => {
    if (busyRef.current || !await dialogs.confirm(
      "清理资料库不再使用的文件？仍在使用的文件会保留。",
      { title: "清理余留", confirmLabel: "开始清理", tone: "warning" },
    ) || busyRef.current || statusRef.current?.maintenance || statusRef.current?.mode === "recovery") return;
    busyRef.current = "cleanup";
    setBusy("cleanup");
    setError("");
    setNotice("");
    try {
      const result = await api.cleanupData();
      const next = await refresh();
      const pending = next.health?.database.pendingFileDeletions.length ?? 0;
      const deletedSnapshots = result.deleted.filter((path) => path.startsWith("snapshots/")).length;
      const deletedAssets = result.deleted.filter((path) => path.startsWith("assets/")).length;
      const unsafeEntries = result.unsafeSnapshotEntries.length + result.unsafeAssetEntries.length;
      const summary = `已删除 ${deletedSnapshots} 个未引用快照、${deletedAssets} 个未引用离线资源。`;
      if (unsafeEntries || pending) {
        setError(`${summary}${pending} 个文件待重试，${unsafeEntries} 个不安全条目未处理。`);
      } else {
        setNotice(summary);
      }
    } catch (cause) {
      setError((cause as Error).message);
      await refresh().catch(() => undefined);
    } finally {
      busyRef.current = "";
      setBusy("");
    }
  };

  if (!status) {
    return (
      <main className="safety-page">
        {error ? (
          <div className="safety-loading" role="alert">
            <p>{error}</p>
            <Button type="button" onClick={() => { setError(""); void refresh().catch((cause) => setError((cause as Error).message)); }}>重试</Button>
            <Button type="button" onClick={onClose}>返回列表</Button>
          </div>
        ) : <div className="safety-loading" role="status">正在检查本机数据…</div>}
      </main>
    );
  }

  const recovery = status.mode === "recovery";
  const databaseHealthy = Boolean(
    status.health &&
    status.health.database.integrityCheck.length === 1 &&
    status.health.database.integrityCheck[0] === "ok" &&
    status.health.database.foreignKeyViolations.length === 0,
  );
  const fileIssues = status.health
    ? status.health.missingSnapshots.length + status.health.orphanSnapshots.length + status.health.unsafeSnapshotEntries.length
      + status.health.missingAssets.length + status.health.orphanAssets.length + status.health.unsafeAssetEntries.length
    : 0;

  return (
    <main className="safety-page">
      <header className="safety-head">
        <div>
          <span className="eyebrow">DATA STEWARDSHIP · {cloud ? "R2 CLOUD" : "本机"}</span>
          <h1>备份恢复</h1>
          <p>{cloud ? "备份云端文章、智能设置和生成结果。" : "检查本机资料，创建可恢复的备份。"}</p>
        </div>
        <div className="safety-head-actions">{!cloud && <Button type="button" className="safety-close" onClick={onDiagnostics} disabled={Boolean(busy)}>问题排查</Button>}{!recovery && <Button type="button" className="safety-close" onClick={onClose} disabled={Boolean(busy)}>返回列表</Button>}</div>
      </header>

      {recovery && (
        <section className="recovery-banner" role="alert">
          <strong>织页已进入恢复模式</strong>
          <p>{status.recoveryError ? userErrorMessage(status.recoveryError.code) : "当前资料无法打开。请选择已检查的备份恢复。"}</p>
          {status.recoveryError?.code && <code>{status.recoveryError.code}</code>}
        </section>
      )}

      {status.maintenance && <div className="safety-message is-notice" role="status">正在完成数据维护，结束后将自动刷新…</div>}

      {(error || notice) && <div className={`safety-message ${error ? "is-error" : "is-notice"}`} role={error ? "alert" : "status"}>{error || notice}</div>}

      <section className="safety-overview" aria-label="数据概况">
        <article>
          <span>DATABASE</span>
          <strong>{status.health ? databaseHealthy ? "完整" : "需处理" : "不可读取"}</strong>
          <small>{status.health ? `${status.health.database.foreignKeyViolations.length} 个外键异常` : "恢复数据库后重新检查"}</small>
        </article>
        <article>
          <span>FILES</span>
          <strong>{status.health ? fileIssues ? `${fileIssues} 项` : "一致" : "—"}</strong>
          <small>{status.health ? `快照 ${status.health.missingSnapshots.length} 缺失/${status.health.orphanSnapshots.length} 未引用/${status.health.unsafeSnapshotEntries.length} 不安全 · 离线资源 ${status.health.missingAssets.length} 缺失/${status.health.orphanAssets.length} 未引用/${status.health.unsafeAssetEntries.length} 不安全` : "暂无文件索引"}</small>
        </article>
        <article>
          <span>STORAGE</span>
          <strong>{bytes(status.health?.storageBytes)}</strong>
          <small>数据库、网页存档与离线资源</small>
        </article>
        <article>
          <span>LAST BACKUP</span>
          <strong>{status.health?.recentBackup ? dateTime(status.health.recentBackup.createdAt) : "尚无"}</strong>
          <small>{status.health?.recentBackup ? statusLabels[status.health.recentBackup.status] : "建议立即创建第一份备份"}</small>
        </article>
      </section>

      <div className={`safety-columns${cloud ? " is-cloud" : ""}`}>
        <section className="safety-card backup-ledger">
          <header>
            <div>
              <span className="eyebrow">ARCHIVE LEDGER</span>
              <h2>完整备份</h2>
              <p>{cloud ? ".zhiye-cloud-backup 未加密，包含云端文档与 AI 结果，不包含 API Key；导入不会自动恢复。" : ".zhiye-backup / .zhiye-cloud-backup 均可；本机导入会把云端备份转成 .zhiye-backup，只新增已校验备份，不会自动恢复。云端不含网页存档与离线图片。"}</p>
            </div>
            <div className="backup-ledger-actions">
              <FileSelectButton label={busy === "import" ? "正在导入…" : "导入备份"} inputLabel="导入备份文件" accept={cloud ? ".zhiye-cloud-backup,application/vnd.zhiye.cloud-backup+json" : ".zhiye-backup,.zhiye-cloud-backup,application/vnd.zhiye.backup+zip,application/vnd.zhiye.cloud-backup+json"} disabled={Boolean(busy) || status.maintenance} onChange={(event) => void importBackup(event)} />
              <Button className="primary-button" type="button" onClick={() => void createBackup()} disabled={Boolean(busy) || recovery || status.maintenance}>
                {busy === "create" ? "正在备份…" : "立即备份"}
              </Button>
            </div>
          </header>
          {!status.backups.length ? <p className="safety-empty">还没有备份，建议先备份一次。</p> : (
            <ol className="backup-list">
              {status.backups.map((backup) => (
                <BackupRow
                  key={backup.id}
                  backup={backup}
                  busy={Boolean(busy) || status.maintenance}
                  recovery={recovery}
                  onVerify={() => void verify(backup)}
                  onExport={() => void exportBackup(backup)}
                  onRestore={() => void restore(backup)}
                  onDelete={() => void deleteBackup(backup)}
                />
              ))}
            </ol>
          )}
        </section>

        {!cloud && <aside className="safety-card safety-controls">
          {desktop && <>
            <div><span className="eyebrow">KNOWLEDGE BASE</span><h2>存放位置</h2></div>
            <div className="safety-location-current" aria-live="polite">
              <span>当前位置</span>
              {dataDirectory ? <code title={dataDirectory} aria-label={`当前知识库路径：${dataDirectory}`}>{dataDirectory}</code> : dataDirectoryError ? <p role="alert">{dataDirectoryError}</p> : <span>正在读取…</span>}
            </div>
            <p>选择空文件夹后，会迁移资料并重启。<br />失败时保留原位置。</p>
            <Button type="button" onClick={() => void changeDataDirectory()} disabled={Boolean(busy) || recovery || status.maintenance}>{busy === "location" ? "正在准备迁移…" : "更换位置"}</Button>
            <hr />
          </>}
          <div><span className="eyebrow">HOUSEKEEPING</span><h2>自动备份</h2></div>
          <p>每日首次启动时备份一次。<br />只轮换每日备份，其他备份保留。</p>
          <form onSubmit={saveRetention}>
            <label htmlFor="backup-retention">保留份数</label>
            <div><input id="backup-retention" type="number" min="1" max="100" step="1" value={retention} onChange={(event) => setRetention(Number(event.target.value))} disabled={Boolean(busy) || recovery || status.maintenance} /><span>份</span></div>
            <Button type="submit" disabled={Boolean(busy) || recovery || status.maintenance}>保存设置</Button>
          </form>
          <hr />
          <h3>文件清理</h3>
          <p>只清理不再使用的文件。<br />失败项下次重试。</p>
          <Button type="button" onClick={() => void cleanup()} disabled={Boolean(busy) || recovery || status.maintenance}>{busy === "cleanup" ? "正在清理…" : "清理余留"}</Button>
        </aside>}
      </div>
    </main>
  );
}
