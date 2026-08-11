import { useEffect, useState } from "react";

import type { LlmSettings } from "../../shared/types";
import { api, ApiRequestError } from "../api";

interface AiSettingsProps {
  onClose: () => void;
}

export function AiSettings({ onClose }: AiSettingsProps) {
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [target, setTarget] = useState<LlmSettings["target"]>("remote");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteModel, setRemoteModel] = useState("");
  const [localUrl, setLocalUrl] = useState("");
  const [localModel, setLocalModel] = useState("");
  const [localTrusted, setLocalTrusted] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const install = (value: LlmSettings) => {
    setSettings(value);
    setTarget(value.target);
    setRemoteUrl(value.remote.endpointUrl);
    setRemoteModel(value.remote.model);
    setLocalUrl(value.local.endpointUrl);
    setLocalModel(value.local.model);
    setLocalTrusted(value.local.trusted);
    setEnabled(value.enabled);
  };

  useEffect(() => {
    const controller = new AbortController();
    void api.getLlmSettings(controller.signal).then(install).catch((cause) => {
      if ((cause as Error).name !== "AbortError") setError((cause as Error).message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  const save = async () => {
    if (!settings || (enabled && target === "local" && !localTrusted)) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const updated = await api.updateLlmSettings({
        enabled,
        target,
        remote: { endpointUrl: remoteUrl.trim(), model: remoteModel.trim() },
        local: { endpointUrl: localUrl.trim(), model: localModel.trim(), trusted: localTrusted },
        revision: settings.revision,
      });
      install(updated);
      setNotice(updated.enabled ? "AI 派生已启用。只有逐篇确认后才会发送正文。" : "设置已保存，AI 仍处于关闭状态。");
    } catch (cause) {
      setError(cause instanceof ApiRequestError && cause.status === 409 ? "设置已在别处更新，请关闭后重新打开。" : (cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const disableAndDelete = async () => {
    if (!settings || !window.confirm("关闭 AI，并删除所有文档的派生结果？此操作无法撤销。")) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await api.disableLlm(settings.revision, true);
      install(response.settings);
      setNotice(`AI 已关闭，并删除 ${response.deletedResults} 条派生结果。`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="ai-settings" aria-labelledby="ai-settings-title">
      <header>
        <div><span className="eyebrow">OPTIONAL DERIVATION</span><h1 id="ai-settings-title">AI 派生设置</h1><p>默认不发送任何内容。每篇文档都需先核对准确的发送范围，再明确确认。</p></div>
        <button type="button" onClick={onClose}>返回资料库</button>
      </header>

      {loading ? <div className="ai-settings-state" role="status">正在读取本地设置…</div> : !settings ? <div className="ai-settings-state is-error" role="alert">{error || "无法读取 AI 设置。"}</div> : (
        <div className="ai-settings-grid">
          <section className="ai-settings-card">
            <div className="ai-setting-lead"><span>01</span><div><h2>明确开启</h2><p>开启设置本身不会发送正文；生成前仍需逐篇确认。</p></div></div>
            <label className="ai-enable"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={saving} /><span><strong>允许 AI 派生知识</strong><small>{enabled ? "已准备：仍需逐篇确认" : "关闭：不会发生模型网络请求"}</small></span></label>
          </section>

          <section className="ai-settings-card">
            <div className="ai-setting-lead"><span>02</span><div><h2>网络目标</h2><p>远程端点必须使用 HTTPS；本地端点仅允许本机地址。</p></div></div>
            <fieldset className="ai-endpoint-kind" disabled={saving}>
              <legend className="sr-only">端点类型</legend>
              <button type="button" aria-pressed={target === "remote"} onClick={() => setTarget("remote")}>远程 HTTPS</button>
              <button type="button" aria-pressed={target === "local"} onClick={() => setTarget("local")}>可信本地端点</button>
            </fieldset>
            {target === "remote" ? <><label><span>OpenAI-compatible HTTPS 地址</span><input aria-label="AI 远程端点地址" type="url" value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="https://api.example.com/v1/chat/completions" disabled={saving} /></label><label><span>远程模型</span><input aria-label="AI 远程模型" value={remoteModel} onChange={(event) => setRemoteModel(event.target.value)} placeholder="model-name" disabled={saving} /></label><div className={`ai-key-state ${settings.apiKeyConfigured ? "is-ready" : ""}`}><i />{settings.apiKeyConfigured ? "服务端已配置密钥；密钥不会返回浏览器。" : "服务端未配置密钥。远程生成暂不可用。"}</div></> : <><label><span>OpenAI-compatible 本机地址</span><input aria-label="AI 本地端点地址" type="url" value={localUrl} onChange={(event) => { setLocalUrl(event.target.value); setLocalTrusted(false); }} placeholder="http://127.0.0.1:11434/v1/chat/completions" disabled={saving} /></label><label><span>本地模型</span><input aria-label="AI 本地模型" value={localModel} onChange={(event) => setLocalModel(event.target.value)} placeholder="model-name" disabled={saving} /></label><label className="ai-local-trust"><input type="checkbox" checked={localTrusted} onChange={(event) => setLocalTrusted(event.target.checked)} disabled={saving} /><span>我信任这个本机端点，并理解正文会发送给运行它的进程。</span></label></>}
          </section>

          <aside className="ai-privacy-note">
            <span>03 · BEFORE SENDING</span>
            <h2>隐私与费用边界</h2>
            <p>发送内容可能包含网页正文、标题及其中的个人信息。远程供应商可能计费并按其政策处理输入；织页不自动生成、不后台重试，也不会把密钥写入数据库、导出或前端响应。</p>
            <strong>当前目标</strong><code>{(target === "remote" ? remoteUrl : localUrl).trim() || "尚未设置"}</code>
          </aside>

          <footer>
            <button type="button" className="text-button danger" onClick={() => void disableAndDelete()} disabled={saving}>关闭 AI 并删除全部结果</button>
            <button type="button" className="primary-button" onClick={() => void save()} disabled={saving || (target === "remote" ? !remoteUrl.trim() || !remoteModel.trim() : !localUrl.trim() || !localModel.trim() || (enabled && !localTrusted))}>{saving ? "保存中…" : "保存设置"}</button>
          </footer>
          {notice && <p className="ai-settings-message" role="status">{notice}</p>}
          {error && <p className="ai-settings-message is-error" role="alert">{error}</p>}
        </div>
      )}
    </main>
  );
}
