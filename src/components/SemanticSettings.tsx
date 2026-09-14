import { useEffect, useState } from "react";

import type { SemanticSettings } from "../../shared/types";
import { api } from "../api";
import { useDialogs } from "./ui/Feedback";

export function SemanticSettingsPanel({ cloud, refreshKey }: { cloud: boolean; refreshKey: number }) {
  const dialogs = useDialogs();
  const [settings, setSettings] = useState<SemanticSettings | null>(null);
  const [model, setModel] = useState("BAAI/bge-m3");
  const [enabled, setEnabled] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [testedModel, setTestedModel] = useState("");
  const [dimension, setDimension] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = async (signal?: AbortSignal) => {
    const value = await api.getSemanticSettings(signal, true);
    setSettings(value);
    setModel(value.model);
    setEnabled(value.enabled);
    return value;
  };

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((cause) => {
      if (!controller.signal.aborted) setError((cause as Error).message);
    });
    return () => controller.abort();
  }, [refreshKey]);

  const testModel = async () => {
    setBusy(true); setError(""); setNotice(""); setDimension(null);
    try {
      const result = await api.testSemanticEmbedding(model.trim());
      setTestedModel(model.trim());
      setDimension(result.dimension);
      setNotice("连接成功 · " + result.model + " · " + result.dimension + " 维");
    } catch (cause) {
      setTestedModel("");
      setError((cause as Error).message || "向量连接测试失败");
    } finally { setBusy(false); }
  };

  const storeKey = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const wasEnabled = settings?.enabled === true;
      if (settings?.enabled) await api.setSemanticSettings({ enabled: false, model: settings.model, revision: settings.revision });
      await api.setSemanticApiKey(apiKey);
      setApiKey("");
      await refresh();
      setEnabled(false);
      setTestedModel("");
      setNotice(wasEnabled ? "索引已暂停并保存新密钥。请测试连接后重新启用。" : "向量 API 密钥已保存。请测试连接后再启用索引。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setBusy(false); }
  };

  const removeKey = async () => {
    setBusy(true); setError("");
    try {
      await api.deleteSemanticApiKey();
      await refresh();
      setTestedModel("");
      setNotice("向量 API 密钥已清除，自动索引已暂停。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setBusy(false); }
  };

  const saveModel = async () => {
    if (!settings || !model.trim()) return;
    if (model.trim() !== settings.model && (settings.indexedDocuments > 0 || settings.indexingDocuments > 0 || settings.totalChunks > 0 || settings.failedDocuments > 0) &&
      !await dialogs.confirm("更换向量模型会清除当前模型生成的索引，需要重新处理资料。", {
        title: "重建语义索引", confirmLabel: "更换模型", tone: "warning",
      })) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api.setSemanticSettings({ enabled: false, model: model.trim(), revision: settings.revision });
      await refresh(); setEnabled(false); setTestedModel(""); setDimension(null);
      setNotice("模型已保存。连接测试通过后可启用语义索引。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setBusy(false); }
  };

  const applyEnabled = async () => {
    if (!settings) return;
    const next = !settings.enabled;
    if (next) {
      if (model.trim() !== settings.model) { setError("请先保存新模型，再测试连接并启用。"); return; }
      if (!settings.apiKeyConfigured) { setError("请先保存向量 API 密钥。"); return; }
      if (testedModel !== model.trim()) { setError("请先测试当前模型连接。"); return; }
      const confirmed = await dialogs.confirm(
        "将把文章正文和已完成提取的论文原文发送给 SiliconFlow " + model.trim() +
          " 建立向量索引。当前有 " + settings.pendingDocuments.toLocaleString("zh-CN") + " 篇资料待处理，预计约 " +
          (settings.estimatedPendingChunks ?? 0).toLocaleString("zh-CN") +
          " 段；实际分段数会在处理过程中确认。模型供应商可能计费。不会发送 PDF、页图、译文或图片。",
        { title: "启用语义关联", confirmLabel: "启用并继续", tone: "warning" },
      );
      if (!confirmed) return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await api.setSemanticSettings({ enabled: next, model: model.trim(), revision: settings.revision });
      await refresh(); setEnabled(value.enabled);
      setNotice(value.enabled ? "语义索引已启用；当前页面打开时会增量处理资料。" : "语义索引已暂停。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setBusy(false); }
  };

  const runIndexAction = async (action: "retry" | "rebuild") => {
    if (action === "rebuild" && !await dialogs.confirm("清除现有语义向量并从头建立索引？已保存的文章和论文不会受影响。", {
      title: "重建全部索引", confirmLabel: "重建索引", tone: "warning",
    })) return;
    setBusy(true); setError("");
    try {
      const result = action === "retry" ? await api.retrySemanticFailures() : await api.rebuildSemanticIndexes();
      const current = await refresh();
      setNotice(action === "retry"
        ? "已安排 " + result.affectedDocuments + " 篇失败资料重试。" + (current.enabled ? "索引会继续处理。" : "索引当前已暂停；请检查密钥和配额、测试连接后重新启用。")
        : "已清除 " + result.affectedDocuments + " 篇资料的旧索引。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <section className="semantic-settings">
      <header><div><span className="eyebrow">04 · KNOWLEDGE MAP</span><h2>语义关联</h2><p>单独配置 SiliconFlow 向量模型；保存、测试和启用彼此分开。</p></div></header>
      {!settings ? <p role={error ? "alert" : "status"}>{error || "正在读取语义索引状态…"}</p> : <>
        <div className="semantic-settings-grid">
          <div className="semantic-settings-card">
            <label><span>向量模型</span><input aria-label="向量模型" value={model} onChange={(event) => { setModel(event.target.value); setTestedModel(""); setDimension(null); }} maxLength={200} disabled={busy} /></label>
            <small>默认 BAAI/bge-m3。向量请求固定发送到 https://api.siliconflow.cn/v1/embeddings。</small>
            <button type="button" onClick={() => void saveModel()} disabled={busy || !model.trim() || model.trim() === settings.model}>保存模型</button>
          </div>
          <div className="semantic-settings-card">
            <label><span>SiliconFlow API 密钥</span><input aria-label="向量 API 密钥" type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.apiKeyConfigured ? "已配置；输入可替换" : "粘贴向量 API Key"} disabled={busy} /></label>
            <small>{cloud ? "云端密钥单独保存在当前浏览器，不写入 D1、留档或导出。" : "密钥只保存在当前服务进程内存，服务重启后需重新设置。"}</small>
            <div><button type="button" onClick={() => void storeKey()} disabled={busy || !apiKey.trim()}>保存密钥</button>{settings.apiKeyConfigured && <button type="button" onClick={() => void removeKey()} disabled={busy}>清除密钥</button>}</div>
          </div>
        </div>
        <div className="semantic-settings-actions">
          <button type="button" onClick={() => void testModel()} disabled={busy || !settings.apiKeyConfigured || !model.trim()}>{busy ? "处理中…" : "测试向量连接"}</button>
          <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={busy} />允许自动建立语义关联</label>
          <button type="button" className="primary-button" onClick={() => void applyEnabled()} disabled={busy || enabled === settings.enabled}>{enabled ? "启用并索引" : "暂停索引"}</button>
        </div>
        <dl className="semantic-progress">
          <div><dt>已建立</dt><dd>{settings.indexedDocuments}</dd></div><div><dt>待处理</dt><dd>{settings.pendingDocuments}</dd></div>
          <div><dt>失败</dt><dd>{settings.failedDocuments}</dd></div><div><dt>分段</dt><dd>{settings.completedChunks} / {settings.totalChunks}</dd></div>
          <div><dt>状态</dt><dd>{settings.enabled ? "启用" : "暂停"}</dd></div>
        </dl>
        {settings.lastError && <p className="semantic-settings-message is-error" role="status">最近索引错误：{settings.lastError}（连续失败 {settings.consecutiveFailures} 次）</p>}
        {settings.failedDocuments > 0 && <button type="button" onClick={() => void runIndexAction("retry")} disabled={busy}>重试失败资料</button>}
        <button type="button" onClick={() => void runIndexAction("rebuild")} disabled={busy || !(settings.indexedDocuments || settings.indexingDocuments || settings.failedDocuments || settings.totalChunks)}>重建全部索引</button>
        {dimension !== null && <p className="semantic-settings-message" role="status">{notice}</p>}
        {notice && dimension === null && <p className="semantic-settings-message" role="status">{notice}</p>}
        {error && <p className="semantic-settings-message is-error" role="alert">{error}</p>}
      </>}
    </section>
  );
}
