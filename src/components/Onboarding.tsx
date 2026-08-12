import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";

import type { OnboardingState } from "../../shared/types";
import { api, ApiRequestError } from "../api";

const steps = [
  { mark: "01", title: "只在你的电脑上", eyebrow: "LOCAL BY DEFAULT" },
  { mark: "02", title: "选定知识库位置", eyebrow: "DATA LOCATION" },
  { mark: "03", title: "从链接收取知识", eyebrow: "CAPTURE" },
  { mark: "04", title: "搜索与整理", eyebrow: "LIBRARY" },
  { mark: "05", title: "编辑 Markdown", eyebrow: "EDIT & PREVIEW" },
  { mark: "06", title: "备份与 AI 边界", eyebrow: "SAFETY FIRST" },
] as const;

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}

export function Onboarding({ state, onComplete, onLater, revisit = false }: {
  state: OnboardingState;
  onComplete: (state: OnboardingState) => void;
  onLater: () => void;
  revisit?: boolean;
}) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restartRequired, setRestartRequired] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const desktop = "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!revisit || !dialog) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      previousFocus?.focus();
    };
  }, [revisit]);

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
    if (state.completed) {
      onComplete(state);
      return;
    }
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

  const page = (
    <section className={`onboarding-page ${revisit ? "is-revisit" : ""}`} aria-labelledby="onboarding-title">
      <header className="onboarding-masthead">
        <div className="brand"><span className="brand-seal">知</span><span><strong>织页</strong><small>ZHIYE · FIRST THREAD</small></span></div>
        <button type="button" autoFocus={revisit} onClick={onLater} disabled={busy}>{revisit ? "关闭指南" : "稍后设置"}</button>
      </header>

      <div className="onboarding-layout">
        <nav className="onboarding-rail" aria-label="使用指南进度">
          {steps.map((item, index) => (
            <button type="button" key={item.mark} aria-current={index === step ? "step" : undefined} onClick={() => setStep(index)} disabled={busy || restartRequired}>
              <span>{item.mark}</span><strong>{item.title}</strong>
            </button>
          ))}
        </nav>

        <section className="onboarding-sheet">
          <span className="eyebrow">{steps[step].eyebrow} · {steps[step].mark} / {String(steps.length).padStart(2, "0")}</span>
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
            <h1 id="onboarding-title">从一个链接，<br />收取一张织片。</h1>
            <p className="onboarding-lead">把公开网页地址粘贴到页面顶部，点击“收取网页”。织页会先直接读取，正文不足时再自动使用隔离浏览器，并保留来源与本地快照。</p>
            <div className="onboarding-facts"><article><strong>URL</strong><span>粘贴公开链接</span></article><article><strong>AUTO</strong><span>静态失败自动回退</span></article><article><strong>STATUS</strong><span>随时查看进度与错误</span></article></div>
            <small>登录态、付费墙、验证码、PDF 与整站爬取暂不支持。</small>
          </>}

          {step === 3 && <>
            <h1 id="onboarding-title">找到它，<br />再把它归好。</h1>
            <p className="onboarding-lead">左侧资料库用标题、正文和来源搜索。标签适合描述属性，集合适合组织主题；收藏、归档与回收站让资料库保持清楚。</p>
            <ol className="onboarding-sequence"><li><span>1</span><div><strong>全文搜索</strong><p>按 ⌘ K 随时聚焦搜索框。</p></div></li><li><span>2</span><div><strong>标签与集合</strong><p>一篇知识可同时属于多个主题。</p></div></li><li><span>3</span><div><strong>状态视图</strong><p>快速查看最近、收藏、失败或回收站内容。</p></div></li></ol>
          </>}

          {step === 4 && <>
            <h1 id="onboarding-title">正文归你，<br />来源仍可追。</h1>
            <p className="onboarding-lead">右侧工作台保存标准 Markdown，可在编辑、对照和预览之间切换。人工修改不会被重新抓取或 AI 静默覆盖，修订历史也可随时恢复。</p>
            <div className="onboarding-limits"><p><strong>EDIT</strong><span>直接编辑 Markdown</span></p><p><strong>SPLIT</strong><span>边写边看预览</span></p><p><strong>⌘ S</strong><span>立即保存</span></p></div>
          </>}

          {step === 5 && <>
            <h1 id="onboarding-title">先留返回键，<br />再请模型帮忙。</h1>
            <p className="onboarding-lead">“数据安全”会校验并管理完整备份。AI 默认关闭；开启后仍需逐篇查看发送范围并明确确认，模型结果作为派生内容保存，不直接改写正文。</p>
            <ol className="onboarding-sequence"><li><span>1</span><div><strong>自动留档</strong><p>每日最多一次，默认保留最近 7 份。</p></div></li><li><span>2</span><div><strong>升级前保护</strong><p>数据库迁移前先生成可验证备份。</p></div></li><li><span>3</span><div><strong>AI 需要确认</strong><p>只向你配置的端点发送当次明示的文本。</p></div></li></ol>
          </>}

          {error && <p className="onboarding-error" role="alert">{error}</p>}
          {!restartRequired && <footer className="onboarding-actions">
            <button type="button" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={busy || step === 0}>上一步</button>
            {step < steps.length - 1
              ? <button type="button" className="primary-button" onClick={() => setStep((value) => value + 1)} disabled={busy}>继续</button>
              : <button type="button" className="primary-button" onClick={() => void complete()} disabled={busy}>{busy ? "正在保存…" : state.completed ? "关闭指南" : "进入资料库"}</button>}
          </footer>}
        </section>
      </div>
    </section>
  );

  return revisit ? (
    <dialog
      ref={dialogRef}
      className="onboarding-dialog"
      aria-labelledby="onboarding-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onLater(); }}
    >
      {page}
    </dialog>
  ) : <main className="onboarding-frame">{page}</main>;
}
