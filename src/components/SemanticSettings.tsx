import { Button } from "./ui/Controls";
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
      setNotice(wasEnabled ? "新密钥已保存，处理已暂停。请测试连接后重新开启。" : "推荐密钥已保存。请测试连接后开启处理。");
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
      setNotice("推荐密钥已删除，自动处理已暂停。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setBusy(false); }
  };

  const saveModel = async () => {
    if (!settings || !model.trim()) return;
    if (model.trim() !== settings.model && (settings.indexedDocuments > 0 || settings.indexingDocuments > 0 || settings.totalChunks > 0 || settings.failedDocuments > 0) &&
      !await dialogs.confirm("更换模型会清除旧关联。资料需要重新处理。", {
        title: "重新建立", confirmLabel: "更换模型", tone: "warning",
      })) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api.setSemanticSettings({ enabled: false, model: model.trim(), revision: settings.revision });
      await refresh(); setEnabled(false); setTestedModel(""); setDimension(null);
      setNotice("模型已保存，测试通过后可开启处理。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setBusy(false); }
  };

  const applyEnabled = async () => {
    if (!settings) return;
    const next = !settings.enabled;
    if (next) {
      if (model.trim() !== settings.model) { setError("请先保存模型，再测试并开启。"); return; }
      if (!settings.apiKeyConfigured) { setError("请先保存推荐密钥。"); return; }
      if (testedModel !== model.trim()) { setError("请先测试当前模型连接。"); return; }
      const confirmed = await dialogs.confirm(
        "文章正文和已提取的论文原文将发送给 SiliconFlow " + model.trim() +
          "。待处理 " + settings.pendingDocuments.toLocaleString("zh-CN") + " 篇，预计约 " +
          (settings.estimatedPendingChunks ?? 0).toLocaleString("zh-CN") +
          " 段，实际数量以处理结果为准。服务商可能收费。不发送 PDF、页图、译文或图片。",
        { title: "开启推荐", confirmLabel: "开启处理", tone: "warning" },
      );
      if (!confirmed) return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await api.setSemanticSettings({ enabled: next, model: model.trim(), revision: settings.revision });
      await refresh(); setEnabled(value.enabled);
      setNotice(value.enabled ? "自动处理已开启，页面打开时继续处理。" : "资料处理已暂停。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setBusy(false); }
  };

  const runIndexAction = async (action: "retry" | "rebuild") => {
    if (action === "rebuild" && !await dialogs.confirm("清除旧关联并重新建立？已保存的文章和论文不会改动。", {
      title: "重新建立", confirmLabel: "重新建立", tone: "warning",
    })) return;
    setBusy(true); setError("");
    try {
      const result = action === "retry" ? await api.retrySemanticFailures() : await api.rebuildSemanticIndexes();
      const current = await refresh();
      setNotice(action === "retry"
        ? "已安排 " + result.affectedDocuments + " 篇失败资料重试。" + (current.enabled ? "将继续处理。" : "处理已暂停。请检查密钥和额度，测试后重新开启。")
        : "已清除 " + result.affectedDocuments + " 篇资料的旧关联。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <section className="semantic-settings">
      <header><div><span className="eyebrow">04 · KNOWLEDGE MAP</span><h2>相关资料</h2><p>使用 SiliconFlow。<br />先保存，再测试并开启。</p></div></header>
      {!settings ? <p role={error ? "alert" : "status"}>{error || "正在读取推荐处理状态…"}</p> : <>
        <div className="semantic-settings-grid">
          <div className="semantic-settings-card">
            <label><span>推荐模型</span><input aria-label="推荐模型" value={model} onChange={(event) => { setModel(event.target.value); setTestedModel(""); setDimension(null); }} maxLength={200} disabled={busy} /></label>
            <small>默认 BAAI/bge-m3。发送地址：https://api.siliconflow.cn/v1/embeddings。</small>
            <Button type="button" onClick={() => void saveModel()} disabled={busy || !model.trim() || model.trim() === settings.model}>保存模型</Button>
          </div>
          <div className="semantic-settings-card">
            <label><span>SiliconFlow API 密钥</span><input aria-label="推荐密钥" type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.apiKeyConfigured ? "已保存，输入新密钥可替换" : "粘贴 SiliconFlow API Key"} disabled={busy} /></label>
            <small>{cloud ? "密钥只存当前浏览器。不写入云端数据库、备份或导出。" : "密钥暂存服务内存。服务重启后需重新填写。"}</small>
            <div><Button type="button" onClick={() => void storeKey()} disabled={busy || !apiKey.trim()}>保存密钥</Button>{settings.apiKeyConfigured && <Button type="button" onClick={() => void removeKey()} disabled={busy}>删除密钥</Button>}</div>
          </div>
        </div>
        <div className="semantic-settings-actions">
          <Button type="button" onClick={() => void testModel()} disabled={busy || !settings.apiKeyConfigured || !model.trim()}>{busy ? "处理中…" : "测试连接"}</Button>
          <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={busy} />自动推荐</label>
          <Button type="button" className="primary-button" onClick={() => void applyEnabled()} disabled={busy || enabled === settings.enabled}>{enabled ? "开始处理" : "暂停处理"}</Button>
        </div>
        <dl className="semantic-progress">
          <div><dt>已完成</dt><dd>{settings.indexedDocuments}</dd></div><div><dt>待处理</dt><dd>{settings.pendingDocuments}</dd></div>
          <div><dt>处理失败</dt><dd>{settings.failedDocuments}</dd></div><div><dt>内容片段</dt><dd>{settings.completedChunks} / {settings.totalChunks}</dd></div>
          <div><dt>状态</dt><dd>{settings.enabled ? "启用" : "暂停"}</dd></div>
        </dl>
        {settings.lastError && <p className="semantic-settings-message is-error" role="status">最近处理错误：{settings.lastError}（连续失败 {settings.consecutiveFailures} 次）</p>}
        {settings.failedDocuments > 0 && <Button type="button" onClick={() => void runIndexAction("retry")} disabled={busy}>重试失败</Button>}
        <Button type="button" onClick={() => void runIndexAction("rebuild")} disabled={busy || !(settings.indexedDocuments || settings.indexingDocuments || settings.failedDocuments || settings.totalChunks)}>重新建立</Button>
        {dimension !== null && <p className="semantic-settings-message" role="status">{notice}</p>}
        {notice && dimension === null && <p className="semantic-settings-message" role="status">{notice}</p>}
        {error && <p className="semantic-settings-message is-error" role="alert">{error}</p>}
      </>}
    </section>
  );
}
