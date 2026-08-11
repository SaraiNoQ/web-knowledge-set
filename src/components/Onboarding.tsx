import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useState } from "react";

import type { OnboardingState } from "../../shared/types";
import { api, ApiRequestError } from "../api";

const steps = [
  { mark: "01", title: "只在你的电脑上", eyebrow: "LOCAL BY DEFAULT" },
  { mark: "02", title: "选定知识库位置", eyebrow: "DATA LOCATION" },
  { mark: "03", title: "给恢复留一条路", eyebrow: "RECOVERY" },
  { mark: "04", title: "知道第一版的边界", eyebrow: "WORKING LIMITS" },
] as const;

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}

export function Onboarding({ state, onComplete, onLater }: {
  state: OnboardingState;
  onComplete: (state: OnboardingState) => void;
  onLater: () => void;
}) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restartRequired, setRestartRequired] = useState(false);
  const desktop = "__TAURI_INTERNALS__" in window;

  const chooseDirectory = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await invoke<{ configured: boolean }>("choose_data_directory");
      if (result.configured) setRestartRequired(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    setBusy(true);
    setError("");
    try {
      onComplete(await api.saveOnboarding(true, state.revision));
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 409) {
        try {
          const latest = await api.getOnboarding();
          if (latest.completed) {
            onComplete(latest);
            return;
          }
        } catch {
          // Use the original conflict below.
        }
      }
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const closeForRestart = async () => {
    setBusy(true);
    setError("");
    try {
      await getCurrentWindow().close();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <main className="onboarding-page" aria-labelledby="onboarding-title">
      <header className="onboarding-masthead">
        <div className="brand"><span className="brand-seal">知</span><span><strong>织页</strong><small>ZHIYE · FIRST THREAD</small></span></div>
        <button type="button" onClick={onLater} disabled={busy}>稍后设置</button>
      </header>

      <div className="onboarding-layout">
        <nav className="onboarding-rail" aria-label="首次设置进度">
          {steps.map((item, index) => (
            <button type="button" key={item.mark} aria-current={index === step ? "step" : undefined} onClick={() => setStep(index)} disabled={busy || restartRequired}>
              <span>{item.mark}</span><strong>{item.title}</strong>
            </button>
          ))}
        </nav>

        <section className="onboarding-sheet">
          <span className="eyebrow">{steps[step].eyebrow} · {steps[step].mark} / 04</span>
          {step === 0 && <>
            <h1 id="onboarding-title">你的知识，<br />先留在本机。</h1>
            <p className="onboarding-lead">织页没有账户系统、云同步或遥测。网页抓取只访问你主动提交的公开地址；本地编辑、搜索与整理都在这台电脑完成。</p>
            <div className="onboarding-facts"><article><strong>SQLite</strong><span>唯一事实源</span></article><article><strong>LOCALHOST</strong><span>不监听局域网</span></article><article><strong>NO TELEMETRY</strong><span>不上传诊断</span></article></div>
          </>}

          {step === 1 && <>
            <h1 id="onboarding-title">给知识库一个<br />稳定的位置。</h1>
            {restartRequired ? (
              <div className="onboarding-restart" role="status">
                <strong>位置已保存</strong>
                <p>织页必须安全关闭本地服务后再从新目录启动。重新打开时，首次设置会在新的空知识库中继续。</p>
                <button type="button" className="primary-button" onClick={() => void closeForRestart()} disabled={busy}>{busy ? "正在安全退出…" : "安全退出织页"}</button>
              </div>
            ) : desktop ? <>
              <p className="onboarding-lead">默认位置由 macOS 管理。若你需要把知识库放到外置盘或其他目录，只能选择一个真实的空文件夹；织页不会悄悄搬动已有数据。</p>
              <button type="button" className="onboarding-directory" onClick={() => void chooseDirectory()} disabled={busy}>{busy ? "正在打开选择器…" : "选择其他空文件夹"}<span>↗</span></button>
              <small>选择过程完全在桌面端完成，网页界面不会收到绝对路径。</small>
            </> : <>
              <p className="onboarding-lead">本地 Web 服务使用启动时的数据目录。浏览器不能在服务运行中安全切换它。</p>
              <pre className="onboarding-command">KB_DATA_DIR=/你的/知识库目录 pnpm start</pre>
              <small>停止当前服务后，用上述环境变量重新启动。目录迁移请使用“数据安全”中的完整备份与恢复。</small>
            </>}
          </>}

          {step === 2 && <>
            <h1 id="onboarding-title">备份不是装饰，<br />它是返回键。</h1>
            <p className="onboarding-lead">织页每天最多创建一次自动完整备份，并在数据库升级前先留存旧版本。恢复会校验清单、哈希与数据库结构，再切换当前数据。</p>
            <ol className="onboarding-sequence"><li><span>1</span><div><strong>自动留档</strong><p>每日一次，默认保留最近 7 份。</p></div></li><li><span>2</span><div><strong>升级前保护</strong><p>迁移数据库前先生成可验证备份。</p></div></li><li><span>3</span><div><strong>人工恢复</strong><p>从“数据安全”检查、恢复或导出诊断。</p></div></li></ol>
          </>}

          {step === 3 && <>
            <h1 id="onboarding-title">先把公开网页，<br />织成可靠文本。</h1>
            <p className="onboarding-lead">第一版专注公开文章：登录态、付费墙、验证码、PDF 与整站爬取暂不支持；外部图片不保证离线。AI 默认关闭，只有确认发送范围后才会请求你配置的模型端点。</p>
            <div className="onboarding-limits"><p><strong>⌘ K</strong><span>聚焦搜索</span></p><p><strong>⌘ S</strong><span>立即保存</span></p><p><strong>?</strong><span>查看完整快捷键</span></p></div>
          </>}

          {error && <p className="onboarding-error" role="alert">{error}</p>}
          {!restartRequired && <footer className="onboarding-actions">
            <button type="button" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={busy || step === 0}>上一步</button>
            {step < steps.length - 1
              ? <button type="button" className="primary-button" onClick={() => setStep((value) => value + 1)} disabled={busy}>继续</button>
              : <button type="button" className="primary-button" onClick={() => void complete()} disabled={busy}>{busy ? "正在保存…" : "进入资料库"}</button>}
          </footer>}
        </section>
      </div>
    </main>
  );
}
