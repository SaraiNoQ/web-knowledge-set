import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { BackupReason, BackupRecord, BackupStatus } from "../../shared/types";
import { api, ApiRequestError, type DataSafetyStatus, type RestoreBackupResult } from "../api";

const reasonLabels: Record<BackupReason, string> = {
  manual: "手动留档",
  automatic: "每日留档",
  "pre-migration": "升级前留档",
  "pre-restore": "恢复前留档",
};

const statusLabels: Record<BackupStatus, string> = {
  creating: "创建中",
  verified: "校验通过",
  failed: "创建失败",
  invalid: "校验失败",
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
  onRestore,
}: {
  backup: BackupRecord;
  busy: boolean;
  recovery: boolean;
  onVerify: () => void;
  onRestore: () => void;
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
      {backup.errorMessage && <p className="backup-error">{backup.errorMessage}</p>}
      <div className="backup-actions">
        <button type="button" onClick={onVerify} disabled={busy || recovery || !backup.directoryName}>重新校验</button>
        <button className="restore-button" type="button" onClick={onRestore} disabled={busy || !restorable}>恢复此留档</button>
      </div>
    </li>
  );
}

export function DataSafety({
  beforeOperation,
  onClose,
  onModeChange,
  onDiagnostics,
}: {
  beforeOperation: () => Promise<void>;
  onClose: () => void;
  onModeChange: (recovery: boolean) => void;
  onDiagnostics: () => void;
}) {
  const [status, setStatus] = useState<DataSafetyStatus | null>(null);
  const [retention, setRetention] = useState(7);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const next = await api.getDataSafety();
    setStatus(next);
    setRetention(next.settings?.automaticRetentionCount ?? 7);
    onModeChange(next.mode === "recovery");
    return next;
  }, [onModeChange]);

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
      setBusy("");
    }
  };

  const createBackup = () => perform("create", async () => {
    await beforeOperation();
    await api.createBackup();
  }, "完整留档已创建并校验。");

  const verify = (backup: BackupRecord) => perform(`verify:${backup.id}`, () => api.verifyBackup(backup.id), "留档校验完成。");

  const restore = async (backup: BackupRecord) => {
    if (!window.confirm(`恢复 ${dateTime(backup.createdAt)} 的留档？当前数据会先另行留档，随后应用将重新载入。`)) return;
    setBusy(`restore:${backup.id}`);
    setError("");
    setNotice("");
    try {
      if (status?.mode === "ready") await beforeOperation();
      let result: RestoreBackupResult;
      try {
        result = await api.restoreBackup(backup.id);
      } catch (cause) {
        if (!(cause instanceof ApiRequestError) || cause.code !== "QUARANTINE_REQUIRED") throw cause;
        if (!window.confirm("当前数据无法完成恢复前留档。继续会把当前数据完整隔离保存，再启用所选留档。仍要继续吗？")) return;
        result = await api.restoreBackup(backup.id, true);
      }
      const warnings = [
        result.quarantinedDataPath && `恢复完成；原有数据已隔离保留在 ${result.quarantinedDataPath}。`,
        result.cleanupPending && "恢复完成，但旧数据目录仍待下次启动清理。",
      ].filter(Boolean);
      if (warnings.length) window.alert(warnings.join("\n"));
      window.location.reload();
    } catch (cause) {
      setError((cause as Error).message);
      await refresh().catch(() => undefined);
    } finally {
      setBusy("");
    }
  };

  const saveRetention = (event: FormEvent) => {
    event.preventDefault();
    if (!Number.isInteger(retention) || retention < 1 || retention > 100) {
      setError("自动留档保留数量必须在 1 到 100 之间。");
      return;
    }
    void perform("settings", () => api.updateBackupSettings(retention), "自动留档数量已更新。");
  };

  const cleanup = async () => {
    if (!window.confirm("清理未被数据库引用的网页快照？仍在使用的文件不会被删除。")) return;
    setBusy("cleanup");
    setError("");
    setNotice("");
    try {
      const result = await api.cleanupData();
      const next = await refresh();
      const pending = next.health?.database.pendingFileDeletions.length ?? 0;
      if (result.unsafeSnapshotEntries.length || pending) {
        setError(`已删除 ${result.deleted.length} 个未引用快照；${pending} 个文件待重试，${result.unsafeSnapshotEntries.length} 个不安全条目未处理。`);
      } else {
        setNotice(`已删除 ${result.deleted.length} 个未引用快照。`);
      }
    } catch (cause) {
      setError((cause as Error).message);
      await refresh().catch(() => undefined);
    } finally {
      setBusy("");
    }
  };

  if (!status) {
    return (
      <main className="safety-page">
        {error ? (
          <div className="safety-loading" role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => { setError(""); void refresh().catch((cause) => setError((cause as Error).message)); }}>重试</button>
            <button type="button" onClick={onClose}>返回资料库</button>
          </div>
        ) : <div className="safety-loading" role="status">正在核对本地数据…</div>}
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
    : 0;

  return (
    <main className="safety-page">
      <header className="safety-head">
        <div>
          <span className="eyebrow">DATA STEWARDSHIP · 本机</span>
          <h1>数据安全</h1>
          <p>校验数据库与网页快照，创建可恢复的完整留档。</p>
        </div>
        <div className="safety-head-actions"><button type="button" className="safety-close" onClick={onDiagnostics} disabled={Boolean(busy)}>诊断台</button>{!recovery && <button type="button" className="safety-close" onClick={onClose} disabled={Boolean(busy)}>返回资料库</button>}</div>
      </header>

      {recovery && (
        <section className="recovery-banner" role="alert">
          <strong>织页已进入恢复模式</strong>
          <p>{status.recoveryError?.message || "当前数据库无法安全打开。请选择一份已校验留档进行恢复。"}</p>
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
          <small>{status.health ? `${status.health.missingSnapshots.length} 缺失 · ${status.health.orphanSnapshots.length} 未引用` : "暂无文件索引"}</small>
        </article>
        <article>
          <span>STORAGE</span>
          <strong>{bytes(status.health?.storageBytes)}</strong>
          <small>数据库与网页快照</small>
        </article>
        <article>
          <span>LAST BACKUP</span>
          <strong>{status.health?.recentBackup ? dateTime(status.health.recentBackup.createdAt) : "尚无"}</strong>
          <small>{status.health?.recentBackup ? statusLabels[status.health.recentBackup.status] : "建议立即创建第一份留档"}</small>
        </article>
      </section>

      <div className="safety-columns">
        <section className="safety-card backup-ledger">
          <header>
            <div><span className="eyebrow">ARCHIVE LEDGER</span><h2>完整留档</h2></div>
            <button className="primary-button" type="button" onClick={() => void createBackup()} disabled={Boolean(busy) || recovery || status.maintenance}>
              {busy === "create" ? "正在留档…" : "创建留档"}
            </button>
          </header>
          {!status.backups.length ? <p className="safety-empty">还没有完整留档。</p> : (
            <ol className="backup-list">
              {status.backups.map((backup) => (
                <BackupRow
                  key={backup.id}
                  backup={backup}
                  busy={Boolean(busy) || status.maintenance}
                  recovery={recovery}
                  onVerify={() => void verify(backup)}
                  onRestore={() => void restore(backup)}
                />
              ))}
            </ol>
          )}
        </section>

        <aside className="safety-card safety-controls">
          <div><span className="eyebrow">HOUSEKEEPING</span><h2>自动留档</h2></div>
          <p>每日首次启动保留一份完整副本。只自动轮换每日留档，不触及手动、升级前或恢复前留档。</p>
          <form onSubmit={saveRetention}>
            <label htmlFor="backup-retention">保留每日留档</label>
            <div><input id="backup-retention" type="number" min="1" max="100" step="1" value={retention} onChange={(event) => setRetention(Number(event.target.value))} disabled={Boolean(busy) || recovery || status.maintenance} /><span>份</span></div>
            <button type="submit" disabled={Boolean(busy) || recovery || status.maintenance}>保存设置</button>
          </form>
          <hr />
          <h3>文件清理</h3>
          <p>只删除没有任何数据库记录引用的网页快照；失败项会留待下次重试。</p>
          <button type="button" onClick={() => void cleanup()} disabled={Boolean(busy) || recovery || status.maintenance}>{busy === "cleanup" ? "正在清理…" : "清理未引用快照"}</button>
        </aside>
      </div>
    </main>
  );
}
