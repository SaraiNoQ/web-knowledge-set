import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

import { api } from "../api";
import { userErrorFrom } from "../error-messages";
import { Modal } from "./ui/Modal";

type Phase = "idle" | "checking" | "current" | "available" | "backing-up" | "installing" | "restarting" | "error";

export function AppUpdater({ beforeOperation, disabled }: { beforeOperation: () => Promise<void>; disabled: boolean }) {
  const updateRef = useRef<Update | null>(null);
  const installedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [metadata, setMetadata] = useState<{ currentVersion: string; version: string; date?: string; body?: string } | null>(null);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    void invoke<boolean>("updater_configured").then(setConfigured).catch(() => undefined);
  }, []);

  useEffect(() => () => {
    void updateRef.current?.close();
  }, []);

  useEffect(() => {
    if (phase !== "restarting") return;
    const timedOut = () => {
      setError("更新已安装，但安全重启被未保存更改或后台任务阻止。请处理页面提示后重试。");
      setPhase("error");
    };
    window.addEventListener("zhiye:close-timeout", timedOut);
    return () => window.removeEventListener("zhiye:close-timeout", timedOut);
  }, [phase]);

  const close = () => {
    if (["backing-up", "installing", "restarting"].includes(phase)) return;
    void updateRef.current?.close();
    updateRef.current = null;
    installedRef.current = false;
    setOpen(false);
    setPhase("idle");
  };

  const checkNow = async () => {
    setOpen(true);
    setPhase("checking");
    setError("");
    setMetadata(null);
    try {
      await updateRef.current?.close();
      const update = await check({ allowDowngrades: false, timeout: 15_000 });
      updateRef.current = update;
      if (!update) {
        setPhase("current");
        return;
      }
      setMetadata({ currentVersion: update.currentVersion, version: update.version, date: update.date, body: update.body });
      setPhase("available");
    } catch (cause) {
      setError(userErrorFrom(cause, "无法检查更新。请检查网络和更新配置后重试。"));
      setPhase("error");
    }
  };

  const restart = async () => {
    setPhase("restarting");
    setError("");
    try {
      await invoke("restart_after_update");
    } catch (cause) {
      setError(userErrorFrom(cause, "更新已安装，但无法安全重启。请保存工作后重新打开织页。"));
      setPhase("error");
    }
  };

  const install = async () => {
    const update = updateRef.current;
    if (!update) return;
    setError("");
    setDownloaded(0);
    setTotal(null);
    try {
      setPhase("backing-up");
      await beforeOperation();
      const backup = await api.createBackup();
      if (backup.status !== "verified" || !backup.verifiedAt) {
        throw Object.assign(new Error("更新前完整留档未通过校验"), { code: backup.errorCode ?? "BACKUP_FAILED" });
      }
      setPhase("installing");
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") setTotal(event.data.contentLength ?? null);
        else if (event.event === "Progress") setDownloaded((value) => value + event.data.chunkLength);
      });
      installedRef.current = true;
      await restart();
    } catch (cause) {
      setError(userErrorFrom(cause, "更新未完成。当前版本和本地数据保持不变，可稍后重试。"));
      setPhase("error");
    }
  };

  const progress = total && total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : null;
  const busy = phase === "checking" || phase === "backing-up" || phase === "installing" || phase === "restarting";

  if (!configured) return null;

  return <>
    <button type="button" className="local-mark update-link" onClick={() => void checkNow()} disabled={disabled}>检查更新</button>
    {open && <Modal open panel={false} className="shortcut-backdrop" title="应用更新" dismissible={!busy} onClose={close}>
      <section className="shortcut-card update-card">
        <header><div><span className="eyebrow">SIGNED UPDATE</span><h2 id="update-title">应用更新</h2></div><button type="button" onClick={close} disabled={busy} aria-label="稍后更新">×</button></header>
        {phase === "checking" && <p role="status">正在通过 GitHub Releases 检查签名更新…</p>}
        {phase === "current" && <p role="status">当前已经是最新版本。</p>}
        {metadata && <div className="update-release"><strong>v{metadata.currentVersion} → v{metadata.version}</strong>{metadata.date && <time dateTime={metadata.date}>{new Date(metadata.date).toLocaleDateString("zh-CN")}</time>}{metadata.body && <p>{metadata.body.slice(0, 4_000)}</p>}</div>}
        {phase === "available" && <p>确认后会先保存当前草稿并创建、校验完整留档，再下载和安装签名更新。</p>}
        {phase === "backing-up" && <p role="status">正在保存草稿并校验更新前完整留档…</p>}
        {phase === "installing" && <div className="update-progress" role="status"><progress value={progress ?? undefined} max="100" /> <span>{progress === null ? "正在下载并验证签名…" : `正在下载并验证签名… ${progress}%`}</span></div>}
        {phase === "restarting" && <p role="status">更新已安装，正在安全保存并重新启动…</p>}
        {error && <p className="update-error" role="alert">{error}</p>}
        <footer>
          <button type="button" onClick={close} disabled={busy}>稍后</button>
          {phase === "available" && <button type="button" className="primary-button" onClick={() => void install()}>创建留档并更新</button>}
          {phase === "error" && <button type="button" className="primary-button" onClick={() => void (installedRef.current ? restart() : updateRef.current ? install() : checkNow())}>{installedRef.current ? "重试重启" : "重试"}</button>}
        </footer>
      </section>
    </Modal>}
  </>;
}
