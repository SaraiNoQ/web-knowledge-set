import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { LlmApiKeyStatus, LlmConnectionTestResult, LlmSettings } from "../../shared/types";
import { api, ApiRequestError } from "../api";

interface AiSettingsProps {
  onClose: () => void;
}

type KeychainStatus = LlmApiKeyStatus;

const REMOTE_PROVIDERS = [
  ["openai", "OpenAI", "https://api.openai.com/v1/chat/completions"],
  ["deepseek", "DeepSeek", "https://api.deepseek.com/chat/completions"],
  ["kimi", "Kimi（月之暗面）", "https://api.moonshot.cn/v1/chat/completions"],
  ["dashscope", "阿里云百炼", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"],
  ["zhipu", "智谱 GLM", "https://open.bigmodel.cn/api/paas/v4/chat/completions"],
  ["siliconflow", "硅基流动", "https://api.siliconflow.cn/v1/chat/completions"],
  ["gemini", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"],
  ["minimax", "MiniMax", "https://api.minimaxi.com/v1/chat/completions"],
  ["openrouter", "OpenRouter", "https://openrouter.ai/api/v1/chat/completions"],
] as const;

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function endpointValue(value: string) {
  try {
    return new URL(value.trim()).href;
  } catch {
    return value.trim();
  }
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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmConnectionTestResult | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keychainEndpoint, setKeychainEndpoint] = useState<string | null | undefined>(undefined);
  const [processKeyEndpoint, setProcessKeyEndpoint] = useState<string | null>(null);
  const testController = useRef<AbortController | null>(null);
  const desktop = "__TAURI_INTERNALS__" in window;
  const remoteProvider = REMOTE_PROVIDERS.find((provider) => provider[2] === remoteUrl)?.[0] ?? "other";
  const currentRemoteEndpoint = endpointValue(remoteUrl);
  const processKeyConfigured = Boolean(currentRemoteEndpoint && processKeyEndpoint === currentRemoteEndpoint);
  const locked = saving || testing;
  const clearTestResult = () => {
    setTestResult(null);
    setError("");
  };

  const install = (value: LlmSettings) => {
    setSettings(value);
    setTarget(value.target);
    setRemoteUrl(value.remote.endpointUrl || REMOTE_PROVIDERS[0][2]);
    setRemoteModel(value.remote.model);
    setLocalUrl(value.local.endpointUrl);
    setLocalModel(value.local.model);
    setLocalTrusted(value.local.trusted);
    setEnabled(value.enabled);
  };

  const markProcessKey = (endpointUrl: string | null) => {
    setProcessKeyEndpoint(endpointUrl);
    setSettings((current) => current ? {
      ...current,
      apiKeyConfigured: Boolean(endpointUrl && endpointValue(current.remote.endpointUrl) === endpointUrl),
    } : current);
  };

  const changeRemoteUrl = (value: string) => {
    if (value === remoteUrl) return;
    setRemoteUrl(value);
    setApiKey("");
    setNotice("");
    setError("");
    clearTestResult();
  };

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.getLlmSettings(controller.signal),
      api.getLlmApiKeyStatus(controller.signal),
    ]).then(([value, keyStatus]) => {
      install(value);
      setProcessKeyEndpoint(keyStatus.endpointUrl);
    }).catch((cause) => {
      if (!(cause instanceof Error && cause.name === "AbortError")) setError(errorMessage(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => {
      controller.abort();
      testController.current?.abort();
      testController.current = null;
    };
  }, []);

  useEffect(() => {
    if (!desktop) return;
    void invoke<KeychainStatus>("llm_keychain_status")
      .then((status) => setKeychainEndpoint(status.endpointUrl))
      .catch((cause) => setError(errorMessage(cause)));
  }, [desktop]);

  const storeApiKey = async () => {
    const value = apiKey.trim();
    const endpointUrl = remoteUrl.trim();
    if (!value || !endpointUrl) return;
    setSaving(true);
    setError("");
    setNotice("");
    clearTestResult();
    try {
      const processStatus = await api.setLlmApiKey(value, endpointUrl);
      const boundEndpoint = processStatus.endpointUrl;
      markProcessKey(boundEndpoint);
      if (desktop) {
        try {
          const status = await invoke<KeychainStatus>("set_llm_api_key", { apiKey: value, endpointUrl: boundEndpoint });
          setKeychainEndpoint(status.endpointUrl);
        } catch (keychainCause) {
          try {
            const cleanupStatus = await api.deleteLlmApiKey();
            markProcessKey(cleanupStatus.endpointUrl);
            setError(`macOS 钥匙串保存失败，已从当前进程撤回密钥：${errorMessage(keychainCause)}`);
          } catch (cleanupCause) {
            setError(`macOS 钥匙串保存失败，且当前进程密钥清理失败：${errorMessage(cleanupCause)}`);
          }
          return;
        }
      }
      setApiKey("");
      setNotice(desktop ? "密钥已立即生效，并保存到 macOS 钥匙串。" : "密钥已立即生效；本地服务重启后需重新输入。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const deleteApiKey = async () => {
    if (!window.confirm(desktop ? "从当前进程和 macOS 钥匙串删除远程模型密钥？" : "从当前本地服务进程删除远程模型密钥？")) return;
    setSaving(true);
    setError("");
    setNotice("");
    clearTestResult();
    try {
      const processStatus = await api.deleteLlmApiKey();
      markProcessKey(processStatus.endpointUrl);
      setApiKey("");
      if (desktop) {
        try {
          const status = await invoke<KeychainStatus>("delete_llm_api_key");
          setKeychainEndpoint(status.endpointUrl);
        } catch (keychainCause) {
          setError(`当前进程密钥已清除，但 macOS 钥匙串删除失败：${errorMessage(keychainCause)}`);
          return;
        }
      }
      setNotice(desktop ? "密钥已从当前进程和 macOS 钥匙串删除。" : "密钥已从当前本地服务进程删除。");
    } catch (cause) {
      setError(`当前进程密钥清除失败，${desktop ? "未改动 macOS 钥匙串" : "请重试"}：${errorMessage(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!settings || (enabled && target === "local" && !localTrusted)) return;
    setSaving(true);
    setError("");
    setNotice("");
    setTestResult(null);
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
      setError(cause instanceof ApiRequestError && cause.code === "LLM_SETTINGS_CONFLICT" ? "设置已在别处更新，请关闭后重新打开。" : errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    const endpointUrl = (target === "remote" ? remoteUrl : localUrl).trim();
    const model = (target === "remote" ? remoteModel : localModel).trim();
    if (!endpointUrl || !model || (target === "remote" ? !processKeyConfigured : !localTrusted)) return;
    const controller = new AbortController();
    testController.current?.abort();
    testController.current = controller;
    setTesting(true);
    setError("");
    setNotice("");
    setTestResult(null);
    try {
      setTestResult(await api.testLlmConnection(
        target === "remote" ? { target, endpointUrl, model } : { target, endpointUrl, model, trusted: true },
        controller.signal,
      ));
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === "AbortError")) setError(errorMessage(cause));
    } finally {
      if (testController.current === controller) {
        testController.current = null;
        setTesting(false);
      }
    }
  };

  const disableAndDelete = async () => {
    if (!settings || !window.confirm("关闭 AI，并删除所有文档的派生结果？此操作无法撤销。")) return;
    setSaving(true);
    setError("");
    setNotice("");
    setTestResult(null);
    try {
      const response = await api.disableLlm(settings.revision, true);
      install(response.settings);
      setNotice(`AI 已关闭，并删除 ${response.deletedResults} 条派生结果。`);
    } catch (cause) {
      setError(errorMessage(cause));
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
            <label className="ai-enable"><input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); clearTestResult(); }} disabled={locked} /><span><strong>允许 AI 派生知识</strong><small>{enabled ? "已准备：仍需逐篇确认" : "关闭：不会自动发生模型网络请求"}</small></span></label>
          </section>

          <section className="ai-settings-card">
            <div className="ai-setting-lead"><span>02</span><div><h2>网络目标</h2><p>远程端点必须使用 HTTPS；本地端点仅允许本机地址。</p></div></div>
            <fieldset className="ai-endpoint-kind" disabled={locked}>
              <legend className="sr-only">端点类型</legend>
              <button type="button" aria-pressed={target === "remote"} onClick={() => { setTarget("remote"); clearTestResult(); }}>远程 HTTPS</button>
              <button type="button" aria-pressed={target === "local"} onClick={() => { setTarget("local"); clearTestResult(); }}>可信本地端点</button>
            </fieldset>
            {target === "remote" ? <>
              <label>
                <span>AI 平台</span>
                <select
                  aria-label="AI 远程平台"
                  value={remoteProvider}
                  onChange={(event) => changeRemoteUrl(REMOTE_PROVIDERS.find((provider) => provider[0] === event.target.value)?.[2] ?? "")}
                  disabled={locked}
                >
                  {REMOTE_PROVIDERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  <option value="other">其他（手动输入）</option>
                </select>
              </label>
              {remoteProvider === "other" && <label>
                <span>OpenAI-compatible HTTPS 地址</span>
                <input aria-label="AI 远程端点地址" type="url" value={remoteUrl} onChange={(event) => changeRemoteUrl(event.target.value)} placeholder="https://api.example.com/v1/chat/completions" disabled={locked} />
              </label>}
              <div className="ai-keychain">
                <label>
                  <span>API Key（不会回显）</span>
                  <input aria-label="远程模型 API 密钥" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); clearTestResult(); }} autoComplete="new-password" spellCheck={false} placeholder={processKeyConfigured ? "当前平台已配置；输入新值可替换" : "粘贴当前平台的 API Key"} disabled={locked} />
                </label>
                <div>
                  <span>{desktop ? (keychainEndpoint === undefined ? "正在检查 macOS 钥匙串…" : keychainEndpoint ? (endpointValue(keychainEndpoint) === currentRemoteEndpoint ? "当前平台密钥已保存到 macOS 钥匙串" : "钥匙串内有其他平台密钥；当前平台需重新输入") : "将保存到 macOS 钥匙串") : "仅保存于当前本地服务进程"}</span>
                  <button type="button" onClick={() => void storeApiKey()} disabled={locked || !apiKey.trim() || !remoteUrl.trim()}>保存密钥</button>
                  {(processKeyEndpoint || keychainEndpoint) && <button type="button" className="danger" onClick={() => void deleteApiKey()} disabled={locked}>删除密钥</button>}
                </div>
              </div>
              <div className={`ai-key-state ${processKeyConfigured ? "is-ready" : ""}`}><i />{processKeyConfigured ? "当前进程已加载当前平台密钥；密钥不会返回浏览器。" : "当前平台未加载密钥。切换平台后需重新输入。"}</div>
              <label><span>远程模型</span><input aria-label="AI 远程模型" value={remoteModel} onChange={(event) => { setRemoteModel(event.target.value); clearTestResult(); }} placeholder="model-name" disabled={locked} /></label>
            </> : <>
              <label><span>OpenAI-compatible 本机地址</span><input aria-label="AI 本地端点地址" type="url" value={localUrl} onChange={(event) => { setLocalUrl(event.target.value); setLocalTrusted(false); clearTestResult(); }} placeholder="http://127.0.0.1:11434/v1/chat/completions" disabled={locked} /></label>
              <label><span>本地模型</span><input aria-label="AI 本地模型" value={localModel} onChange={(event) => { setLocalModel(event.target.value); clearTestResult(); }} placeholder="model-name" disabled={locked} /></label>
              <label className="ai-local-trust"><input type="checkbox" checked={localTrusted} onChange={(event) => { setLocalTrusted(event.target.checked); clearTestResult(); }} disabled={locked} /><span>我信任这个本机端点，并理解正文会发送给运行它的进程。</span></label>
            </>}
            <div className="ai-connection-test">
              <button type="button" onClick={() => void testConnection()} disabled={locked || (target === "remote" ? !remoteUrl.trim() || !remoteModel.trim() || !processKeyConfigured || Boolean(apiKey.trim()) : !localUrl.trim() || !localModel.trim() || !localTrusted)}>{testing ? "测试中…" : "测试连接"}</button>
              <small>{target === "remote" && apiKey.trim() ? "先保存密钥，再测试该密钥与当前端点。" : "只发送固定探针，不发送文档；远程供应商可能收取小额费用。"}</small>
              {testResult && <p role="status">固定探针连接成功 · {testResult.target === "remote" ? "远程" : "本机"} · {testResult.model} · {testResult.durationMs} ms。未发送正文，也未保存或启用当前设置；远程测试可能产生小额费用。</p>}
            </div>
          </section>

          <aside className="ai-privacy-note">
            <span>03 · BEFORE SENDING</span>
            <h2>隐私与费用边界</h2>
            <p>发送内容可能包含网页正文、标题及其中的个人信息。远程供应商可能计费并按其政策处理输入；织页不自动生成、不后台重试，也不会把密钥写入数据库、导出或前端响应。</p>
            <strong>当前目标</strong><code>{(target === "remote" ? remoteUrl : localUrl).trim() || "尚未设置"}</code>
          </aside>

          <footer>
            <button type="button" className="text-button danger" onClick={() => void disableAndDelete()} disabled={locked}>关闭 AI 并删除全部结果</button>
            <button type="button" className="primary-button" onClick={() => void save()} disabled={locked || (target === "remote" ? !remoteUrl.trim() || !remoteModel.trim() || (enabled && !processKeyConfigured) : !localUrl.trim() || !localModel.trim() || (enabled && !localTrusted))}>{saving ? "保存中…" : "保存设置"}</button>
          </footer>
          {notice && <p className="ai-settings-message" role="status">{notice}</p>}
          {error && <p className="ai-settings-message is-error" role="alert">{error}</p>}
        </div>
      )}
    </main>
  );
}
