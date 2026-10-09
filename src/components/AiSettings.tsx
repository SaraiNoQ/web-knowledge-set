import { SegmentedControl } from "./ui/SegmentedControl";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { LlmApiKeyStatus, LlmConnectionTestResult, LlmSettings } from "../../shared/types";
import { api } from "../api";
import { isAbortError, userErrorFrom } from "../error-messages";
import { Button, Select } from "./ui/Controls";
import { useDialogs } from "./ui/Feedback";
import { SemanticSettingsPanel } from "./SemanticSettings";

interface AiSettingsProps {
  embedded?: boolean;
  cloud?: boolean;
  semanticRefresh?: number;
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

function endpointValue(value: string) {
  try {
    return new URL(value.trim()).href;
  } catch {
    return value.trim();
  }
}

export function AiSettings({ cloud = false, semanticRefresh = 0, embedded = false, onClose }: AiSettingsProps) {
  const dialogs = useDialogs();
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
  const [testError, setTestError] = useState("");
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
  const settingsRef = useRef(settings);
  const lockedRef = useRef(locked);
  settingsRef.current = settings;
  lockedRef.current = locked;
  const clearTestResult = () => {
    setTestResult(null);
    setTestError("");
    setError("");
  };

  const install = (value: LlmSettings) => {
    setSettings(value);
    setTarget(cloud ? "remote" : value.target);
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
      if (!isAbortError(cause)) setError(userErrorFrom(cause, "无法读取 AI 设置，请重新打开设置页。"));
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
    if (!cloud) return;
    const refresh = () => {
      void Promise.all([api.getLlmSettings(), api.getLlmApiKeyStatus()]).then(([value, status]) => {
        install(value);
        setProcessKeyEndpoint(status.endpointUrl);
      }).catch((cause) => setError(userErrorFrom(cause, "无法刷新云端密钥状态。")));
    };
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [cloud]);

  useEffect(() => {
    if (!desktop) return;
    void invoke<KeychainStatus>("llm_keychain_status")
      .then((status) => setKeychainEndpoint(status.endpointUrl))
      .catch((cause) => setError(userErrorFrom(cause, "无法读取 macOS 钥匙串中的密钥状态。")));
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
            setError(userErrorFrom(keychainCause, "macOS 钥匙串保存失败，已从当前进程撤回密钥。"));
          } catch (cleanupCause) {
            setError(userErrorFrom(cleanupCause, "macOS 钥匙串保存失败，且当前进程密钥清理失败。请重启织页后重试。"));
          }
          return;
        }
      }
      setApiKey("");
      setNotice(desktop ? "密钥已立即生效，并保存到 macOS 钥匙串。" : cloud ? "密钥已保存到当前浏览器；刷新后仍可使用，可随时在这里删除。" : "密钥已立即生效；本地服务重启后需重新输入。");
    } catch (cause) {
      setError(userErrorFrom(cause, "密钥保存失败，请检查输入后重试。"));
    } finally {
      setSaving(false);
    }
  };

  const deleteApiKey = async () => {
    if (lockedRef.current || !await dialogs.confirm(
      desktop ? "从当前进程和 macOS 钥匙串删除在线模型密钥？" : "从当前本地服务进程删除在线模型密钥？",
      { title: "删除在线模型密钥", confirmLabel: "删除密钥", tone: "danger" },
    ) || lockedRef.current) return;
    lockedRef.current = true;
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
          setError(userErrorFrom(keychainCause, "当前进程密钥已清除，但 macOS 钥匙串删除失败。"));
          return;
        }
      }
      setNotice(desktop ? "密钥已从当前进程和 macOS 钥匙串删除。" : cloud ? "密钥已从当前浏览器站点存储删除。" : "密钥已从当前本地服务进程删除。");
    } catch (cause) {
      setError(userErrorFrom(cause, `当前进程密钥清除失败，${desktop ? "未改动 macOS 钥匙串。" : "请重试。"}`));
    } finally {
      lockedRef.current = false;
      setSaving(false);
    }
  };

  const save = async () => {
    if (!settings || (enabled && target === "local" && !localTrusted)) return;
    setSaving(true);
    setError("");
    setNotice("");
    setTestResult(null);
    setTestError("");
    try {
      const updated = await api.updateLlmSettings({
        enabled,
        target,
        remote: { endpointUrl: remoteUrl.trim(), model: remoteModel.trim() },
        local: { endpointUrl: localUrl.trim(), model: localModel.trim(), trusted: localTrusted },
        revision: settings.revision,
      });
      install(updated);
      setNotice(updated.enabled ? "智能助手已启用，可手动发起生成。" : "设置已保存，AI 仍处于关闭状态。");
    } catch (cause) {
      setError(userErrorFrom(cause, "AI 设置未保存，请检查输入后重试。"));
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
    setTestError("");
    try {
      setTestResult(await api.testLlmConnection(
        target === "remote" ? { target, endpointUrl, model } : { target, endpointUrl, model, trusted: true },
        controller.signal,
      ));
    } catch (cause) {
      if (!isAbortError(cause)) setTestError(userErrorFrom(cause, "AI 连接测试失败，请检查密钥、模型和网络。"));
    } finally {
      if (testController.current === controller) {
        testController.current = null;
        setTesting(false);
      }
    }
  };

  const disableAndDelete = async () => {
    if (!settingsRef.current || lockedRef.current || !await dialogs.confirm(
      "关闭 AI，并删除所有文档的生成结果？删除后无法恢复。",
      { title: "关闭清空", confirmLabel: "关闭清空", tone: "danger" },
    )) return;
    const current = settingsRef.current;
    if (!current || lockedRef.current) return;
    lockedRef.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    setTestResult(null);
    try {
      const response = await api.disableLlm(current.revision, true);
      install(response.settings);
      setNotice(`AI 已关闭，并删除 ${response.deletedResults} 条生成结果。`);
    } catch (cause) {
      setError(userErrorFrom(cause, "无法关闭 AI 或删除结果，请稍后重试。"));
    } finally {
      lockedRef.current = false;
      setSaving(false);
    }
  };

  return (
    <section className="ai-settings" aria-labelledby="ai-settings-title">
      <header>
        <div>{embedded ? <h2 id="ai-settings-title">智能设置</h2> : <h1 id="ai-settings-title">智能设置</h1>}<p>选择平台和模型，手动生成内容。</p></div>
        {!embedded && <Button type="button" onClick={onClose}>返回列表</Button>}
      </header>

      {loading ? <div className="ai-settings-state" role="status">正在读取 AI 设置…</div> : !settings ? <div className="ai-settings-state is-error" role="alert">{error || "无法读取 AI 设置。"}</div> : (
        <div className="ai-settings-grid">
          <section className="ai-settings-card">
            <div className="ai-setting-lead"><span>01</span><div><h2>功能开关</h2><p>开启不发送正文，点击生成后才发送。</p></div></div>
            <label className="ai-enable"><input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); clearTestResult(); }} disabled={locked} /><span><strong>开启助手</strong><small>{enabled ? "已启用：可发起生成" : "已关闭，不会自动请求模型"}</small></span></label>
          </section>

          <section className="ai-settings-card">
            <div className="ai-setting-lead"><span>02</span><div><h2>连接设置</h2><p>在线服务须用 HTTPS；本机服务限本机地址。</p></div></div>
            {!cloud && <SegmentedControl label="服务位置" className="ai-endpoint-kind" value={target} disabled={locked} options={[{ value: "remote", label: "在线服务" }, { value: "local", label: "本机服务" }]} onChange={(value) => { setTarget(value); clearTestResult(); }} />}
            {target === "remote" ? <>
              <label>
                <span>服务平台</span>
                <Select
                  aria-label="服务平台"
                  value={remoteProvider}
                  onChange={(event) => changeRemoteUrl(REMOTE_PROVIDERS.find((provider) => provider[0] === event.target.value)?.[2] ?? "")}
                  disabled={locked}
                >
                  {REMOTE_PROVIDERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  {!cloud && <option value="other">手动填写</option>}
                </Select>
              </label>
              {remoteProvider === "other" && <label>
                <span>服务地址</span><small>须兼容 OpenAI 接口。</small>
                <input aria-label="在线服务地址" type="url" value={remoteUrl} onChange={(event) => changeRemoteUrl(event.target.value)} placeholder="https://api.example.com/v1/chat/completions" disabled={locked} />
              </label>}
              <div className="ai-keychain">
                <label>
                  <span>API Key（不会回显）</span>
                  <input aria-label="平台密钥" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); clearTestResult(); }} autoComplete="new-password" spellCheck={false} placeholder={processKeyConfigured ? "当前平台已保存；输入新值可替换" : "粘贴当前平台的 API Key"} disabled={locked} />
                </label>
                <div>
                  <span>{desktop ? (keychainEndpoint === undefined ? "正在检查 macOS 钥匙串…" : keychainEndpoint ? (endpointValue(keychainEndpoint) === currentRemoteEndpoint ? "当前平台密钥已保存到 macOS 钥匙串" : "钥匙串内有其他平台密钥；当前平台需重新输入") : "将保存到 macOS 钥匙串") : cloud ? "保存于当前浏览器站点存储；共享设备用完请删除" : "仅保存于当前本地服务进程"}</span>
                  <Button type="button" onClick={() => void storeApiKey()} disabled={locked || !apiKey.trim() || !remoteUrl.trim()}>保存密钥</Button>
                  {(processKeyEndpoint || keychainEndpoint) && <Button type="button" className="danger" onClick={() => void deleteApiKey()} disabled={locked}>删除密钥</Button>}
                </div>
              </div>
              <div className={`ai-key-state ${processKeyConfigured ? "is-ready" : ""}`}><i />{processKeyConfigured ? (cloud ? "当前平台密钥已就绪。不写入云端数据库或备份。" : "当前平台密钥已就绪，不会返回浏览器。") : "请填写当前平台的密钥。切换平台后需重新填写。"}</div>
              <label><span>在线模型</span><input aria-label="在线模型" value={remoteModel} onChange={(event) => { setRemoteModel(event.target.value); clearTestResult(); }} placeholder="model-name" disabled={locked} /></label>
            </> : <>
              <label><span>本机地址</span><small>须兼容 OpenAI 接口。</small><input aria-label="本机服务地址" type="url" value={localUrl} onChange={(event) => { setLocalUrl(event.target.value); setLocalTrusted(false); clearTestResult(); }} placeholder="http://127.0.0.1:11434/v1/chat/completions" disabled={locked} /></label>
              <label><span>本机模型</span><input aria-label="本机模型" value={localModel} onChange={(event) => { setLocalModel(event.target.value); clearTestResult(); }} placeholder="model-name" disabled={locked} /></label>
              <label className="ai-local-trust"><input type="checkbox" checked={localTrusted} onChange={(event) => { setLocalTrusted(event.target.checked); clearTestResult(); }} disabled={locked} /><span>我信任这个本机服务，允许向它发送正文。</span></label>
            </>}
            <div className="ai-connection-test">
              <Button type="button" onClick={() => void testConnection()} disabled={locked || (target === "remote" ? !remoteUrl.trim() || !remoteModel.trim() || !processKeyConfigured || Boolean(apiKey.trim()) : !localUrl.trim() || !localModel.trim() || !localTrusted)}>{testing ? "测试中…" : "测试连接"}</Button>
              <small>{target === "remote" && apiKey.trim() ? "先保存密钥，再测试连接。" : "测试不发送正文；在线服务可能少量收费。"}</small>
              {testResult && <div className="ai-test-result is-success" role="status"><strong>连接成功</strong><span>{testResult.target === "remote" ? "远程" : "本机"} · {testResult.model} · {testResult.durationMs} ms</span><small>测试未发送正文。在线服务可能少量收费。</small></div>}
              {testError && <div className="ai-test-result is-error" role="alert"><strong>连接失败</strong><span>{testError}</span><small>{cloud ? "密钥不会因测试失败而写入 D1 或备份。" : "密钥不会因测试失败而写入数据库或备份。"}</small></div>}
            </div>
          </section>

          <aside className="ai-privacy-note">
            <span>03 · BEFORE SENDING</span>
            <h2>发送须知</h2>
            <p>发送内容可能含正文、标题和个人信息。<br />服务商可能收费，并按其政策处理。<br />织页不自动生成，也不后台重试。<br />密钥不写入数据库、导出或返回页面。</p>
            <strong>发送地址</strong><code>{(target === "remote" ? remoteUrl : localUrl).trim() || "尚未设置"}</code>
          </aside>

          <footer>
            <Button type="button" className="text-button danger" onClick={() => void disableAndDelete()} disabled={locked}>关闭清空</Button>
            <Button type="button" className="primary-button" onClick={() => void save()} disabled={locked || (target === "remote" ? !remoteUrl.trim() || !remoteModel.trim() || (enabled && !processKeyConfigured) : !localUrl.trim() || !localModel.trim() || (enabled && !localTrusted))}>{saving ? "保存中…" : "保存设置"}</Button>
          </footer>
          {notice && <p className="ai-settings-message" role="status">{notice}</p>}
          {error && <p className="ai-settings-message is-error" role="alert">{error}</p>}
        </div>
      )}
      <SemanticSettingsPanel cloud={cloud} refreshKey={semanticRefresh} />
    </section>
  );
}
