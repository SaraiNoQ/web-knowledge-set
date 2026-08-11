import { useEffect, useState } from "react";

import type { DiagnosticReport } from "../../shared/types";
import { api } from "../api";

function bytes(value: number | undefined) {
  if (value === undefined) return "—";
  const units = ["B", "KiB", "MiB", "GiB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 && unit ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function Diagnostics({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api.getDiagnostics(controller.signal).then(setReport).catch((cause) => {
      if (!controller.signal.aborted) setError((cause as Error).message);
    });
    return () => controller.abort();
  }, []);

  const download = async () => {
    setExporting(true);
    setError("");
    setNotice("");
    try {
      const { blob, fileName } = await api.exportDiagnostics();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNotice("诊断包已导出；发送前请再人工检查其中的两个文本文件。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setExporting(false);
    }
  };

  if (!report) {
    return (
      <main className="safety-page diagnostics-page">
        <div className="safety-loading" role={error ? "alert" : "status"}>
          <p>{error || "正在整理本机诊断信息…"}</p>
          {error && <button type="button" onClick={onClose}>返回数据安全</button>}
        </div>
      </main>
    );
  }

  const integrity = report.health?.databaseIntegrity ?? "unavailable";
  const recent = report.recentErrors.slice(0, 12);
  const logs = report.logs.slice(-12).reverse();

  return (
    <main className="safety-page diagnostics-page" aria-labelledby="diagnostics-title">
      <header className="safety-head">
        <div>
          <span className="eyebrow">LOCAL DIAGNOSTICS · 不上传</span>
          <h1 id="diagnostics-title">诊断台</h1>
          <p>只整理版本、队列、完整性计数与稳定错误码。</p>
        </div>
        <button type="button" className="safety-close" onClick={onClose}>返回数据安全</button>
      </header>

      {(error || notice) && (
        <div className={`safety-message ${error ? "is-error" : "is-notice"}`} role={error ? "alert" : "status"}>
          {error || notice}
        </div>
      )}

      <section className="safety-overview" aria-label="运行概况">
        <article><span>VERSION</span><strong>v{report.application.version}</strong><small>{report.application.desktop ? "macOS 桌面端" : "本地 Web"} · Node {report.application.nodeVersion}</small></article>
        <article><span>SCHEMA</span><strong>{report.schema.current ?? "不可读"} / {report.schema.supported}</strong><small>{report.schema.status === "current" ? "迁移版本一致" : "数据库处于恢复模式"}</small></article>
        <article><span>QUEUE</span><strong>{report.queue ? report.queue.active + report.queue.queued : "—"}</strong><small>{report.queue ? `${report.queue.active} 正在执行 · ${report.queue.queued} 等待` : "队列不可读"}</small></article>
        <article><span>INTEGRITY</span><strong>{integrity === "ok" ? "完整" : integrity === "failed" ? "需处理" : "不可读"}</strong><small>{report.health ? `${report.health.foreignKeyViolations} 个外键异常` : "请先恢复数据库"}</small></article>
      </section>

      <div className="diagnostics-grid">
        <section className="safety-card diagnostics-ledger">
          <header><div><span className="eyebrow">ERROR LEDGER</span><h2>最近错误码</h2></div><small>不包含错误 message</small></header>
          {!recent.length ? <p className="safety-empty">没有可报告的近期错误。</p> : (
            <ol className="diagnostics-list">
              {recent.map((entry, index) => <li key={`${entry.occurredAt}-${entry.source}-${index}`}><time dateTime={entry.occurredAt}>{dateTime(entry.occurredAt)}</time><strong>{entry.code}</strong><span>{entry.source}</span></li>)}
            </ol>
          )}
        </section>

        <aside className="safety-card diagnostics-export">
          <span className="eyebrow">PRIVACY ENVELOPE</span>
          <h2>导出前先知道边界</h2>
          <p>诊断包默认不含正文、标题、标签、URL、查询参数、Cookie、密钥、快照、绝对路径或 AI 输入输出。</p>
          <dl>
            <div><dt>本地存储</dt><dd>{bytes(report.health?.storageBytes)}</dd></div>
            <div><dt>文件异常</dt><dd>{report.health ? report.health.missingSnapshots + report.health.missingAssets + report.health.unsafeSnapshotEntries + report.health.unsafeAssetEntries : "—"}</dd></div>
            <div><dt>本地日志</dt><dd>{report.logs.length} 条</dd></div>
          </dl>
          <button type="button" className="primary-button" onClick={() => void download()} disabled={exporting}>{exporting ? "正在整理…" : "导出诊断包"}</button>
          <small>包内仍可能反映运行时间与错误类型；与他人分享前请人工检查。</small>
        </aside>

        <section className="safety-card diagnostics-ledger diagnostics-runtime">
          <header><div><span className="eyebrow">RUNTIME THREAD</span><h2>本地运行记录</h2></div><small>最近 {logs.length} 条</small></header>
          {!logs.length ? <p className="safety-empty">暂无运行记录。</p> : (
            <ol className="diagnostics-list">
              {logs.map((entry, index) => <li key={`${entry.timestamp}-${entry.event}-${index}`}><time dateTime={entry.timestamp}>{dateTime(entry.timestamp)}</time><strong>{entry.event}</strong><span>{entry.code || entry.level}</span></li>)}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}
