import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { TRANSLATION_LANGUAGES } from "../../shared/types";
import type {
  DerivedPreview,
  DerivedResult,
  DerivedResultType,
  DerivedTask,
  KnowledgeDocument,
  LlmSettings,
  TranslationLanguage,
} from "../../shared/types";
import { api } from "../api";
import { userErrorMessage } from "../error-messages";

const TYPE_LABEL: Record<DerivedResultType, string> = {
  summary: "摘要",
  outline: "分层提纲",
  keywords: "关键词",
  "tag-suggestions": "标签建议",
  translation: "翻译",
};
const LIGHTWEIGHT_RESULT_CHARS = 250_000;

function typeLabel(type: DerivedResultType, targetLanguage?: TranslationLanguage | null) {
  return type === "translation" && targetLanguage ? `翻译 · ${TRANSLATION_LANGUAGES[targetLanguage]}` : TYPE_LABEL[type];
}

function dateTime(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  } catch {
    return value;
  }
}

function stringList(output: string) {
  try {
    const value = JSON.parse(output) as unknown;
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))] : [];
  } catch {
    return output.split(/[,，\n]/u).map((value) => value.replace(/^[-*#\s]+/u, "").trim()).filter(Boolean);
  }
}

function ModelMarkdown({ children }: { children: string }) {
  return (
    <div className="derived-markdown">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: label }) => <span className="derived-blocked-link">{label}</span>,
          img: ({ alt }) => <span className="derived-blocked-image" role="img" aria-label={alt ? `模型图片：${alt}` : "模型图片"}>[图片请求已阻止{alt ? `：${alt}` : ""}]</span>,
        }}
      >{children}</ReactMarkdown>
    </div>
  );
}

function DerivedOutput({ result, markdown, onLoadMarkdown }: {
  result: DerivedResult;
  markdown: boolean;
  onLoadMarkdown: () => void;
}) {
  if (result.output.length <= LIGHTWEIGHT_RESULT_CHARS || markdown) return <ModelMarkdown>{result.output}</ModelMarkdown>;
  return (
    <div className="derived-lightweight">
      <div><span>轻量阅读</span><p>结果超过 250,000 字符，默认以纯文本显示以保持流畅。</p><button type="button" onClick={onLoadMarkdown}>加载 Markdown 渲染</button></div>
      <pre aria-label="派生结果纯文本">{result.output}</pre>
    </div>
  );
}

interface DerivedKnowledgeProps {
  cloud?: boolean;
  document: KnowledgeDocument;
  open: boolean;
  preferredType: DerivedResultType;
  onTypeChange: (type: DerivedResultType) => void;
  onClose: () => void;
  generationBlockedReason: string | null;
  onAdoptTags: (tags: string[]) => Promise<void>;
}

export function DerivedKnowledge({ cloud = false, document, open, preferredType: type, onTypeChange, onClose, generationBlockedReason, onAdoptTags }: DerivedKnowledgeProps) {
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [results, setResults] = useState<DerivedResult[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [task, setTask] = useState<DerivedTask | null>(null);
  const [targetLanguage, setTargetLanguage] = useState<TranslationLanguage>("zh-CN");
  const [preview, setPreview] = useState<DerivedPreview | null>(null);
  const [previewBatch, setPreviewBatch] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [markdownResults, setMarkdownResults] = useState<Set<string>>(() => new Set());
  const [selectedTags, setSelectedTags] = useState<{ resultId: string; tags: string[] }>({ resultId: "", tags: [] });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadResults = useCallback(async (resultPage = page, signal?: AbortSignal) => {
    const response = await api.listDerivedResults(document.id, resultPage, signal);
    setResults(response.items);
    setTotal(response.total);
    setPage(response.page);
  }, [document.id, page]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setPreview(null);
    setPreviewBatch(0);
    setConfirmed(false);
    setMarkdownResults(new Set());
    setSelectedTags({ resultId: "", tags: [] });
    setError("");
    void Promise.all([
      api.getLlmSettings(controller.signal).then(setSettings),
      loadResults(1, controller.signal),
      api.getDerivedTask(document.id, controller.signal).then(setTask),
    ]).catch((cause) => {
      if ((cause as Error).name !== "AbortError") setError((cause as Error).message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [document.id, document.revision]);

  useEffect(() => {
    if (task?.status !== "running") return;
    const timer = window.setInterval(() => {
      void api.getDerivedTaskById(task.id).then((updated) => {
        setTask(updated);
        if (updated.status === "succeeded") {
          setPreview(null);
          setConfirmed(false);
          setNotice(`${typeLabel(updated.type, updated.targetLanguage)}已生成，正文与标签均未修改。`);
          void loadResults(1);
        }
      }).catch((cause) => setError((cause as Error).message));
    }, 900);
    return () => window.clearInterval(timer);
  }, [loadResults, task?.id, task?.status]);

  const prepare = async () => {
    if (generationBlockedReason) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await api.previewDerivedResult(document.id, type, document.revision, type === "translation" ? targetLanguage : undefined);
      setPreview(value);
      setPreviewBatch(0);
      setConfirmed(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!preview || !confirmed) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const started = await api.startDerivedTask(document.id, preview);
      setTask(started);
      if (started.status === "succeeded") {
        setPreview(null);
        setConfirmed(false);
        setNotice(cloud ? `${typeLabel(started.type, started.targetLanguage)}已生成并保存；正文未修改。` : `${typeLabel(started.type, started.targetLanguage)}已有相同输入结果，未重复请求模型。`);
        await loadResults(1);
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!task || task.status !== "running") return;
    setBusy(true);
    setError("");
    try {
      setTask(await api.cancelDerivedTask(task.id));
      setNotice("已取消这次生成；不会自动重试。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!task || (task.status !== "failed" && task.status !== "cancelled")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setTask(await api.retryDerivedTask(task.id));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pin = async (result: DerivedResult) => {
    setBusy(true);
    setError("");
    try {
      await api.pinDerivedResult(document.id, result.id, !result.pinned);
      await loadResults(page);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (result: DerivedResult) => {
    if (!window.confirm(`删除这条${typeLabel(result.type, result.targetLanguage)}结果？`)) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteDerivedResult(document.id, result.id);
      await loadResults(page);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const adoptTags = async (result: DerivedResult) => {
    if (selectedTags.resultId !== result.id || !selectedTags.tags.length) return;
    setBusy(true);
    setError("");
    try {
      await onAdoptTags(selectedTags.tags);
      setNotice(`已人工采纳 ${selectedTags.tags.length} 个标签。`);
      setSelectedTags({ resultId: "", tags: [] });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pinned = useMemo(() => results.find((result) => result.type === "summary" && result.pinned), [results]);
  const taskLabel = task ? typeLabel(task.type, task.targetLanguage) : "";
  const previewBatchCount = preview?.sentTexts.length ?? 0;
  const lastPreviewBatch = previewBatchCount > 0 && previewBatch === previewBatchCount - 1;
  const loadResultMarkdown = (resultId: string) => setMarkdownResults((current) => new Set(current).add(resultId));

  return (
    <>
      {pinned && !open && <section className={`derived-pinned ${pinned.stale ? "is-stale" : ""}`} aria-label="固定摘要"><div><span>PINNED SUMMARY</span>{pinned.stale && <em>正文更新后已过期</em>}</div><DerivedOutput result={pinned} markdown={markdownResults.has(pinned.id)} onLoadMarkdown={() => loadResultMarkdown(pinned.id)} /></section>}
      {open && (
        <aside id="derived-knowledge" className="derived-panel" aria-label="AI 派生知识">
          <header><div><span className="eyebrow">DERIVED, NEVER OVERWRITTEN</span><h3>AI 派生知识</h3><p>结果独立保存；不会改写正文，也不会自动添加标签。</p></div><button type="button" onClick={onClose} aria-label="关闭 AI 派生知识">×</button></header>

          {loading ? <div className="derived-state" role="status">正在翻阅派生记录…</div> : (
            <>
              <section className="derived-generator" aria-labelledby="derived-generator-title">
                <div><span>01 · GENERATE</span><h4 id="derived-generator-title">选择一项，再核对发送范围</h4></div>
                <div className="derived-options">
                  <fieldset disabled={busy || task?.status === "running" || !settings?.enabled || Boolean(generationBlockedReason)}>
                    <legend className="sr-only">派生类型</legend>
                    {(Object.entries(TYPE_LABEL) as Array<[DerivedResultType, string]>).filter(([value]) => !cloud || value !== "tag-suggestions").map(([value, label]) => <button key={value} type="button" aria-pressed={type === value} onClick={() => { onTypeChange(value); setPreview(null); setPreviewBatch(0); setConfirmed(false); }}>{label}</button>)}
                  </fieldset>
                  {type === "translation" && <label className="derived-target-language"><span>翻译为</span><select aria-label="翻译目标语言" value={targetLanguage} onChange={(event) => { setTargetLanguage(event.target.value as TranslationLanguage); setPreview(null); setPreviewBatch(0); setConfirmed(false); }} disabled={busy || task?.status === "running" || !settings?.enabled || Boolean(generationBlockedReason)}>{(Object.entries(TRANSLATION_LANGUAGES) as Array<[TranslationLanguage, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
                </div>
                {!settings?.enabled && <p className="derived-boundary">AI 当前关闭。历史结果仍可查看；请先到页首“AI 设置”中启用。</p>}
                {generationBlockedReason && <p className="derived-boundary">{generationBlockedReason}</p>}
                <button type="button" className="primary-button" onClick={() => void prepare()} disabled={busy || !settings?.enabled || task?.status === "running" || Boolean(generationBlockedReason)}>{busy && !preview ? "准备中…" : `预览${TYPE_LABEL[type]}发送范围`}</button>
              </section>

              {preview && (
                <section className="derived-preview" aria-label="模型发送范围预览">
                  <div className="derived-coverage"><span>02 · SEND PREVIEW</span><strong>{preview.coverage.sentChars.toLocaleString("zh-CN")} / {preview.coverage.sourceChars.toLocaleString("zh-CN")} 字符</strong><em>{preview.coverage.truncated ? "已按稳定段落截断" : "覆盖完整正文"}</em></div>
                  <dl><div><dt>目标</dt><dd>{preview.target.url}</dd></div><div><dt>模型</dt><dd>{preview.model}</dd></div><div><dt>类型</dt><dd>{typeLabel(preview.type, preview.targetLanguage)}</dd></div></dl>
                  <div className="derived-batch-nav" aria-label="发送批次导航"><button type="button" onClick={() => setPreviewBatch((value) => Math.max(0, value - 1))} disabled={previewBatch === 0}>上一批</button><strong>第 {previewBatch + 1} / {previewBatchCount} 批</strong><button type="button" onClick={() => setPreviewBatch((value) => Math.min(previewBatchCount - 1, value + 1))} disabled={lastPreviewBatch}>下一批</button></div>
                  <pre aria-label="将发送给模型的准确文本">{preview.sentTexts[previewBatch]}</pre>
                  {lastPreviewBatch && <label className="derived-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我已核对上方准确文本与网络目标，共 {previewBatchCount} 批，确认本次发送。</span></label>}
                  <div><button type="button" onClick={() => { setPreview(null); setPreviewBatch(0); setConfirmed(false); }}>取消</button>{lastPreviewBatch && <button type="button" className="primary-button" onClick={() => void start()} disabled={!confirmed || busy}>{busy ? "提交中…" : "确认发送并生成"}</button>}</div>
                </section>
              )}

              {task && task.status !== "succeeded" && <section className={`derived-task is-${task.status}`} aria-live="polite"><div><span>03 · TASK</span><strong>{taskLabel}{task.status === "running" ? "正在生成" : task.status === "failed" ? "生成失败" : "已取消"}</strong>{task.status === "running" && <div className="derived-task-progress"><progress aria-label="AI 生成批次进度" max={task.progress.totalBatches} value={task.progress.completedBatches} /><small>批次进度 {task.progress.completedBatches} / {task.progress.totalBatches}</small></div>}{task.error && <small>{task.error.code} · {userErrorMessage(task.error.code)}</small>}{task.status !== "running" && task.progress.totalBatches > 1 && <small className="derived-retry-note">重试将从第一批开始，不会复用已完成批次。</small>}</div>{task.status === "running" ? <button type="button" onClick={() => void cancel()} disabled={busy}>取消任务</button> : <button type="button" onClick={() => void retry()} disabled={busy || !settings?.enabled}>重试</button>}</section>}

              {(notice || error) && <p className={`derived-message ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{error || notice}</p>}

              <section className="derived-history" aria-labelledby="derived-history-title">
                <div className="derived-history-head"><div><span>04 · LEDGER</span><h4 id="derived-history-title">派生历史</h4></div><strong>{total} 条</strong></div>
                {!results.length ? <p className="derived-empty">还没有派生结果。AI 关闭时，这里也不会产生任何后台请求。</p> : <ol>{results.map((result) => {
                  const tags = result.type === "tag-suggestions" ? stringList(result.output) : [];
                  const checkedTags = selectedTags.resultId === result.id ? selectedTags.tags : [];
                  return <li key={result.id} className={result.stale ? "is-stale" : undefined}><header><div><strong>{typeLabel(result.type, result.targetLanguage)}</strong>{result.pinned && <span>已固定</span>}{result.stale && <em>已过期</em>}{result.truncated && <em>输入已截断</em>}</div><time dateTime={result.createdAt}>{dateTime(result.createdAt)}</time></header><div className="derived-result-meta">{result.model} · {result.endpointId} · {result.durationMs} ms{result.usage?.totalTokens ? ` · ${result.usage.totalTokens} tokens` : ""}</div>{result.type === "tag-suggestions" ? <fieldset className="derived-tags" disabled={busy || Boolean(generationBlockedReason)}><legend>选择要加入的标签（默认不选）</legend>{tags.map((tag) => <label key={tag}><input type="checkbox" checked={checkedTags.includes(tag)} onChange={(event) => setSelectedTags((current) => { const selected = current.resultId === result.id ? current.tags : []; return { resultId: result.id, tags: event.target.checked ? [...new Set([...selected, tag])] : selected.filter((value) => value !== tag) }; })} />#{tag}</label>)}<button type="button" onClick={() => void adoptTags(result)} disabled={!checkedTags.length || busy}>采纳所选标签</button></fieldset> : <DerivedOutput result={result} markdown={markdownResults.has(result.id)} onLoadMarkdown={() => loadResultMarkdown(result.id)} />}<footer>{result.type === "summary" && <button type="button" onClick={() => void pin(result)} disabled={busy}>{result.pinned ? "取消固定" : "固定摘要"}</button>}<button type="button" className="danger" onClick={() => void remove(result)} disabled={busy}>删除结果</button></footer></li>;
                })}</ol>}
                {total > 30 && <nav aria-label="派生历史分页"><button type="button" disabled={page <= 1 || busy} onClick={() => void loadResults(page - 1)}>上一页</button><span>{page} / {Math.ceil(total / 30)}</span><button type="button" disabled={page >= Math.ceil(total / 30) || busy} onClick={() => void loadResults(page + 1)}>下一页</button></nav>}
              </section>
            </>
          )}
        </aside>
      )}
    </>
  );
}
