import { Button } from "./ui/Controls";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useState } from "react";

import type { OnboardingState } from "../../shared/types";
import { api, ApiRequestError } from "../api";
import { userErrorFrom } from "../error-messages";
import { Modal } from "./ui/Modal";

const steps = [
  { mark: "01", title: "本机保存", eyebrow: "LOCAL BY DEFAULT" },
  { mark: "02", title: "存放位置", eyebrow: "DATA LOCATION" },
  { mark: "03", title: "保存网页", eyebrow: "CAPTURE" },
  { mark: "04", title: "查找整理", eyebrow: "LIBRARY" },
  { mark: "05", title: "编辑文章", eyebrow: "EDIT & PREVIEW" },
  { mark: "06", title: "备份须知", eyebrow: "SAFETY FIRST" },
] as const;

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
  const desktop = "__TAURI_INTERNALS__" in window;

  const chooseDirectory = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await invoke<{ configured: boolean }>("choose_data_directory");
      if (result.configured) setRestartRequired(true);
    } catch (cause) {
      setError(userErrorFrom(cause, "无法选择存放位置，请确认文件夹可用后重试。"));
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
      setError(userErrorFrom(cause, "无法保存首次使用状态，请稍后重试。"));
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
      setError(userErrorFrom(cause, "无法保存退出，请保存工作后重试。"));
      setBusy(false);
    }
  };

  const page = (
    <section className={`onboarding-page ${revisit ? "is-revisit" : ""}`} aria-labelledby="onboarding-title">
      <header className="onboarding-masthead">
        <div className="brand"><span className="brand-seal">知</span><span><strong>织页</strong><small>ZHIYE · FIRST THREAD</small></span></div>
        <Button type="button" autoFocus={revisit} onClick={() => revisit ? onLater() : void complete()} disabled={busy}>{revisit ? "关闭指南" : "稍后设置"}</Button>
      </header>

      <div className="onboarding-layout">
        <nav className="onboarding-rail" aria-label="使用指南进度">
          {steps.map((item, index) => (
            <Button type="button" key={item.mark} aria-current={index === step ? "step" : undefined} onClick={() => setStep(index)} disabled={busy || restartRequired}>
              <span>{item.mark}</span><strong>{item.title}</strong>
            </Button>
          ))}
        </nav>

        <section className="onboarding-sheet">
          <span className="eyebrow">{steps[step].eyebrow} · {steps[step].mark} / {String(steps.length).padStart(2, "0")}</span>
          {step === 0 && <>
            <h1 id="onboarding-title">本机保存</h1>
            <p className="onboarding-lead">本机版无需账户，不同步云端或上传统计。<br />只访问你提交的公开网页。<br />编辑、搜索和整理在本机完成。</p>
            <div className="onboarding-facts"><article><strong>SQLite</strong><span>资料统一保存在本机</span></article><article><strong>LOCALHOST</strong><span>仅限这台电脑访问</span></article><article><strong>NO TELEMETRY</strong><span>不上传诊断</span></article></div>
          </>}

          {step === 1 && <>
            <h1 id="onboarding-title">存放位置</h1>
            {restartRequired ? (
              <div className="onboarding-restart" role="status">
                <strong>位置已保存</strong>
                <p>请先退出织页，再重新打开。<br />首次设置会在新的空知识库中继续。</p>
                <Button type="button" className="primary-button" onClick={() => void closeForRestart()} disabled={busy}>{busy ? "正在安全退出…" : "保存退出"}</Button>
              </div>
            ) : desktop ? <>
              <p className="onboarding-lead">默认位置由 macOS 管理。<br />更换位置须选择一个空文件夹。<br />首次设置不会搬动已有数据。</p>
              <Button type="button" className="onboarding-directory" onClick={() => void chooseDirectory()} disabled={busy}>{busy ? "正在打开选择器…" : "选择位置"}<span>↗</span></Button>
              <small>在桌面端选择，完整路径不会传给网页。</small>
            </> : <>
              <p className="onboarding-lead">本机服务启动时确定存放位置。<br />运行中无法通过浏览器更换。</p>
              <pre className="onboarding-command">KB_DATA_DIR=/你的/知识库目录 pnpm start</pre>
              <small>先停止服务，再按上述设置启动。搬移资料请使用完整备份与恢复。</small>
            </>}
          </>}

          {step === 2 && <>
            <h1 id="onboarding-title">保存网页</h1>
            <p className="onboarding-lead">粘贴链接，点击“保存网页”。<br />自动读取正文，保留来源和网页存档。</p>
            <div className="onboarding-facts"><article><strong>URL</strong><span>粘贴网页链接</span></article><article><strong>AUTO</strong><span>自动换种方式读取</span></article><article><strong>STATUS</strong><span>随时查看进度与错误</span></article></div>
            <small>这里只支持公开网页。不支持登录、付费或验证码页面。不支持 PDF 或整站下载。</small>
          </>}

          {step === 3 && <>
            <h1 id="onboarding-title">查找整理</h1>
            <p className="onboarding-lead">可按标题、正文和来源查找。<br />用标签描述特点，用专题整理主题。<br />也可收藏、归档或放入回收站。</p>
            <ol className="onboarding-sequence"><li><span>1</span><div><strong>全文搜索</strong><p>按 ⌘ K 随时聚焦搜索框。</p></div></li><li><span>2</span><div><strong>标签与专题</strong><p>一张织片可同时属于多个主题。</p></div></li><li><span>3</span><div><strong>视图切换</strong><p>全部、收藏、回收站与论文，一键切换。</p></div></li></ol>
          </>}

          {step === 4 && <>
            <h1 id="onboarding-title">编辑文章</h1>
            <p className="onboarding-lead">正文用 Markdown 保存。<br />可编辑、边写边看或预览。<br />重新收取和助手不会自动覆盖修改。<br />历史版本可恢复。</p>
            <div className="onboarding-limits"><p><strong>EDIT</strong><span>直接编辑文章</span></p><p><strong>SPLIT</strong><span>边写边看预览</span></p><p><strong>⌘ S</strong><span>立即保存</span></p></div>
          </>}

          {step === 5 && <>
            <h1 id="onboarding-title">备份须知</h1>
            <p className="onboarding-lead">在“备份恢复”中管理备份。<br />助手默认关闭，点击生成后才处理。<br />结果单独保存，不改正文。</p>
            <ol className="onboarding-sequence"><li><span>1</span><div><strong>自动备份</strong><p>每日最多一次，默认保留最近 7 份。</p></div></li><li><span>2</span><div><strong>升级前保护</strong><p>数据库迁移前先生成可验证备份。</p></div></li><li><span>3</span><div><strong>AI 需要确认</strong><p>只向所选服务发送本次确认的内容。</p></div></li></ol>
          </>}

          {error && <p className="onboarding-error" role="alert">{error}</p>}
          {!restartRequired && <footer className="onboarding-actions">
            <Button type="button" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={busy || step === 0}>上一步</Button>
            {step < steps.length - 1
              ? <Button type="button" className="primary-button" onClick={() => setStep((value) => value + 1)} disabled={busy}>继续</Button>
              : <Button type="button" className="primary-button" onClick={() => void complete()} disabled={busy}>{busy ? "正在保存…" : state.completed ? "关闭指南" : "开始使用"}</Button>}
          </footer>}
        </section>
      </div>
    </section>
  );

  return revisit ? (
    <Modal
      open
      panel={false}
      className="onboarding-dialog"
      title="使用指南"
      dismissible={!busy && !restartRequired}
      onClose={revisit ? onLater : () => void complete()}
    >
      {page}
    </Modal>
  ) : <main className="onboarding-frame">{page}</main>;
}
