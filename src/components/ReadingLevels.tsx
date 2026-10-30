import { flushSync } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DerivedTask, KnowledgeDocument } from "../../shared/types";
import { FOLD_REQUEST, readFold, type FoldData, type FoldLevel } from "../../shared/textfold";
import { api, ApiRequestError } from "../api";
import { Button, Select } from "./ui/Controls";

export function ReadingLevels({ document, blocked, onChange }: {
  document: KnowledgeDocument; blocked: boolean;
  onChange: (value: { documentId: string; markdown: string; data: FoldData; level: FoldLevel } | null) => void;
}) {
  const [data, setData] = useState<FoldData | null>(null);
  const [level, setLevel] = useState<FoldLevel>("full");
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState("");
  const context = useRef(0);
  const busyRef = useRef(false);
  const generate = useCallback(async (automatic = false) => {
    if (blocked || busyRef.current) return;
    busyRef.current = true;
    const token = context.current;
    setBusy(true); setQueued(false); setError("");
    try {
      const settings = await api.getLlmSettings();
      if (token !== context.current) return;
      if (!settings.enabled || !settings.apiKeyConfigured && settings.target === "remote") {
        if (!automatic) setError("请先在 AI 设置中启用模型并配置凭据。");
        return;
      }
      const preview = await api.previewDerivedResult(document.id, "summary", document.revision, undefined, FOLD_REQUEST);
      if (token !== context.current) return;
      let task: DerivedTask | null = null;
      while (!task && token === context.current) {
        const existing = await api.getDerivedTask(document.id);
        if (token !== context.current) return;
        if (existing?.documentId === document.id && existing.type === "summary" && existing.preview.customPrompt === FOLD_REQUEST
          && existing.preview.revision === preview.revision && existing.preview.inputHash === preview.inputHash
          && existing.preview.sendHash === preview.sendHash && existing.preview.settingsRevision === preview.settingsRevision
          && ["running", "succeeded"].includes(existing.status)) { task = existing; break; }
        try { task = await api.startDerivedTask(document.id, preview); }
        catch (cause) {
          if (token !== context.current) return;
          if (!(cause instanceof ApiRequestError) || cause.code !== "LLM_BUSY") throw cause;
          setQueued(true);
          await new Promise(resolve => window.setTimeout(resolve, 1000));
          if (token !== context.current) return;
        }
      }
      if (token !== context.current || !task) return;
      setQueued(false);
      while (task.status === "running" && token === context.current) {
        await new Promise(resolve => window.setTimeout(resolve, 1000));
        if (token !== context.current) return;
        task = await api.getDerivedTaskById(task.id);
      }
      if (token !== context.current) return;
      if (task.status !== "succeeded" || !task.result) throw new Error(task.error?.message || "分层生成未完成，请重试。");
      const value = readFold(document.markdown, task.result.output);
      if (!value) throw new Error("分层结果无效，请重新生成。");
      setData(value);
    } catch (cause) {
      if (token === context.current) setError((cause as Error).message);
    } finally {
      if (token === context.current) { setBusy(false); setQueued(false); busyRef.current = false; }
    }
  }, [blocked, document.id, document.markdown, document.revision]);

  useEffect(() => {
    const token = ++context.current;
    busyRef.current = false; setBusy(false); setQueued(false); setData(null); setLevel("full"); setError("");
    onChange(null);
    if (blocked) return;
    let disposed = false;
    const timer = window.setTimeout(() => void (async () => {
      try {
        let page = 1;
        while (!disposed) {
          const results = await api.listDerivedResults(document.id, page);
          if (disposed) return;
          for (const result of results.items) {
            if (result.stale) continue;
            const value = readFold(document.markdown, result.output);
            if (value) { setData(value); return; }
          }
          if (page * results.pageSize >= results.total || !results.items.length) break;
          page += 1;
        }
        if (!disposed) await generate(true);
      } catch (cause) { if (!disposed) setError((cause as Error).message); }
    })(), 1200);
    return () => { disposed = true; window.clearTimeout(timer); if (context.current === token) context.current++; };
  }, [blocked, document.id, document.markdown, document.revision, generate, onChange]);

  useEffect(() => {
    onChange(!blocked && data ? { documentId: document.id, markdown: document.markdown, data, level } : null);
  }, [blocked, data, level, document.id, document.markdown, onChange]);

  useEffect(() => {
    const restore = (event: Event) => {
      if ((event as CustomEvent<{ documentId: string }>).detail?.documentId !== document.id) return;
      // Anchor lookup runs immediately after this event; commit the original text first.
      flushSync(() => {
        setLevel("full");
        onChange(data ? { documentId: document.id, markdown: document.markdown, data, level: "full" } : null);
      });
    };
    window.addEventListener("zhiye:reader-anchor", restore);
    return () => window.removeEventListener("zhiye:reader-anchor", restore);
  }, [document.id, document.markdown, data, onChange]);

  return <span className="reading-levels">
    {data ? <label>阅读层级 <Select aria-label="阅读层级" value={level} disabled={blocked} onChange={event => setLevel(event.target.value as FoldLevel)}>
      <option value="full">原文</option><option value="brief">精简原句</option><option value="key">要点</option><option value="takeaway">结论</option><option value="topic">主题</option>
    </Select></label> : <Button type="button" disabled={blocked || busy} onClick={() => void generate()}>{busy ? queued ? "等待模型空闲…" : "正在生成阅读层级…" : error ? "重试阅读分层" : "生成阅读层级"}</Button>}
    {error && <span role="status">{error}</span>}
  </span>;
}
