import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Button, IconButton, Select } from "./ui/Controls";
import { SegmentedControl } from "./ui/SegmentedControl";
import { WorkspaceIcon } from "./ui/WorkspaceIcon";
import { useDialogs, useToast } from "./ui/Feedback";

const TYPE_LABEL: Record<DerivedResultType, string> = {
  summary: "摘要",
  outline: "分层提纲",
  keywords: "关键词",
  "tag-suggestions": "标签建议",
  translation: "翻译",
};
export type DerivedMode = DerivedResultType | "custom";
const CUSTOM_LABEL = "AI 对话";
const LIGHTWEIGHT_RESULT_CHARS = 250_000;

function typeLabel(type: DerivedResultType, targetLanguage?: TranslationLanguage | null, promptVersion?: string) {
  if (promptVersion?.startsWith("custom-v1-") || promptVersion?.startsWith("cloud-custom-v1-")) return CUSTOM_LABEL;
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
  const keywords = result.type === "keywords" ? stringList(result.output) : [];
  if (keywords.length > 1) return <p className="derived-keywords">{keywords.join(" · ")}</p>;
  if (result.output.length <= LIGHTWEIGHT_RESULT_CHARS || markdown) return <ModelMarkdown>{result.output}</ModelMarkdown>;
  return (
    <div className="derived-lightweight">
      <div><span>轻量阅读</span><p>结果超过 250,000 字符，默认以纯文本显示以保持流畅。</p><Button type="button" onClick={onLoadMarkdown}>加载 Markdown 渲染</Button></div>
      <pre aria-label="派生结果纯文本">{result.output}</pre>
    </div>
  );
}

interface DerivedKnowledgeProps {
  cloud?: boolean;
  hideTagSuggestions?: boolean;
  document: KnowledgeDocument;
  open: boolean;
  preferredType: DerivedMode;
  onTypeChange: (type: DerivedMode) => void;
  onClose: () => void;
  generationBlockedReason: string | null;
  onAdoptTags: (tags: string[]) => Promise<void>;
}

export function DerivedKnowledge({ cloud = false, hideTagSuggestions = false, document, open, preferredType: type, onTypeChange, onClose, generationBlockedReason, onAdoptTags }: DerivedKnowledgeProps) {
  const dialogs = useDialogs();
  const toast = useToast();
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [results, setResults] = useState<DerivedResult[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [task, setTask] = useState<DerivedTask | null>(null);
  const [targetLanguage, setTargetLanguage] = useState<TranslationLanguage>("zh-CN");
  const [customPrompt, setCustomPrompt] = useState("");
  const [markdownResults, setMarkdownResults] = useState<Set<string>>(() => new Set());
  const [selectedTags, setSelectedTags] = useState<{ resultId: string; tags: string[] }>({ resultId: "", tags: [] });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const contextRef = useRef("");
  contextRef.current = `${document.id}:${document.revision}`;
  const resultsRef = useRef(results);
  const busyRef = useRef(busy);
  resultsRef.current = results;
  busyRef.current = busy;
  const cloudKeyMissing = Boolean(cloud && settings?.target === "remote" && !settings.apiKeyConfigured);

  const loadResults = useCallback(async (resultPage = page, signal?: AbortSignal) => {
    const context = contextRef.current;
    const response = await api.listDerivedResults(document.id, resultPage, signal);
    if (signal?.aborted || contextRef.current !== context) return;
    setResults(response.items);
    setTotal(response.total);
    setPage(response.page);
  }, [document.id, page]);

  useEffect(() => {
    const controller = new AbortController();
    contextRef.current = `${document.id}:${document.revision}`;
    setLoading(true);
    setTask(null);
    setCustomPrompt("");
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
    return () => { contextRef.current = ""; controller.abort(); };
  }, [document.id, document.revision]);

  useEffect(() => {
    if (!open || !cloud) return;
    const controller = new AbortController();
    setError("");
    const refresh = () => void api.getLlmSettings(controller.signal).then(setSettings).catch((cause) => {
      if ((cause as Error).name !== "AbortError") setError((cause as Error).message);
    });
    refresh();
    window.addEventListener("storage", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("storage", refresh);
    };
  }, [cloud, open]);

  useEffect(() => {
    if (task?.status !== "running") return;
    const context = contextRef.current;
    let completed = false;
    const timer = window.setInterval(() => {
      void api.getDerivedTaskById(task.id).then((updated) => {
        if (completed || contextRef.current !== context) return;
        setTask(updated);
        if (updated.status === "succeeded") {
          completed = true;
          toast.success(`${typeLabel(updated.type, updated.targetLanguage, updated.preview.promptVersion)}已生成，正文与标签均未修改。`);
          void loadResults(1);
        }
      }).catch((cause) => { if (!completed && contextRef.current === context) setError((cause as Error).message); });
    }, 900);
    return () => { completed = true; window.clearInterval(timer); };
  }, [loadResults, task?.id, task?.status, toast]);

  const requestPreview = () => api.previewDerivedResult(document.id, type === "custom" ? "summary" : type, document.revision, type === "translation" ? targetLanguage : undefined, type === "custom" ? customPrompt : undefined);

  const startPreview = async (value: DerivedPreview) => {
    const context = contextRef.current;
    const started = await api.startDerivedTask(document.id, value);
    if (contextRef.current !== context) return;
    setTask(started);
    if (started.status === "succeeded") {
      toast.success(cloud ? `${typeLabel(started.type, started.targetLanguage, started.preview.promptVersion)}已生成并保存；正文未修改。` : `${typeLabel(started.type, started.targetLanguage, started.preview.promptVersion)}已有相同输入结果，未重复请求模型。`);
      await loadResults(1);
    }
  };

  const generate = async () => {
    if (busyRef.current || !settings?.enabled || task?.status === "running" || (type === "custom" && !customPrompt.trim()) || generationBlockedReason || cloudKeyMissing) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const context = contextRef.current;
    try {
      const value = await requestPreview();
      if (contextRef.current !== context) return;
      await startPreview(value);
    } catch (cause) {
      if (contextRef.current === context) setError((cause as Error).message);
    } finally {
      busyRef.current = false;
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
    if (busyRef.current || !await dialogs.confirm(
      `删除这条${typeLabel(result.type, result.targetLanguage, result.promptVersion)}结果？`,
      { title: "删除派生结果", confirmLabel: "删除结果", tone: "danger" },
    )) return;
    const current = resultsRef.current.find((value) => value.id === result.id);
    if (busyRef.current || !current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await api.deleteDerivedResult(document.id, current.id);
      await loadResults(page);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      busyRef.current = false;
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
  const taskLabel = task ? typeLabel(task.type, task.targetLanguage, task.preview.promptVersion) : "";
  const loadResultMarkdown = (resultId: string) => setMarkdownResults((current) => new Set(current).add(resultId));

  return (
    <>
      {pinned && !open && <section className={`derived-pinned ${pinned.stale ? "is-stale" : ""}`} aria-label="固定摘要"><div><span>PINNED SUMMARY</span>{pinned.stale && <em>正文更新后已过期</em>}</div><DerivedOutput result={pinned} markdown={markdownResults.has(pinned.id)} onLoadMarkdown={() => loadResultMarkdown(pinned.id)} /></section>}
      {open && (
        <aside id="derived-knowledge" className="derived-panel" aria-label="AI 派生知识">
          <header><h3>AI 派生知识</h3><IconButton label="关闭 AI 派生知识" onClick={onClose}><WorkspaceIcon name="close" /></IconButton></header>

          {loading ? <div className="derived-state" role="status">正在翻阅派生记录…</div> : (
            <>
              <section className="derived-generator" aria-label="生成派生内容">
                <div className="derived-options">
                  <SegmentedControl label="派生类型" value={type} disabled={busy || task?.status === "running" || !settings?.enabled || Boolean(generationBlockedReason) || cloudKeyMissing} options={[...(Object.entries(TYPE_LABEL) as Array<[DerivedResultType, string]>).filter(([value]) => value !== "tag-suggestions" || (!cloud && !hideTagSuggestions)).map(([value, label]) => ({ value, label })), { value: "custom", label: CUSTOM_LABEL }]} onChange={onTypeChange} />
                  {type === "translation" && <label className="derived-target-language"><span>翻译为</span><Select aria-label="翻译目标语言" value={targetLanguage} onChange={(event) => { setTargetLanguage(event.target.value as TranslationLanguage); }} disabled={busy || task?.status === "running" || !settings?.enabled || Boolean(generationBlockedReason) || cloudKeyMissing}>{(Object.entries(TRANSLATION_LANGUAGES) as Array<[TranslationLanguage, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>}
                </div>
                {!settings?.enabled && <p className="derived-boundary">AI 当前关闭。历史结果仍可查看；请先到左侧“设置”中启用。</p>}
                {cloudKeyMissing && <p className="derived-boundary">当前浏览器没有此平台的 AI 密钥。历史结果仍可查看；请先到左侧“设置”保存密钥。</p>}
                {generationBlockedReason && <p className="derived-boundary">{generationBlockedReason}</p>}
                {type !== "custom" && <Button type="button" className="primary-button" onClick={() => void generate()} disabled={busy || !settings?.enabled || task?.status === "running" || Boolean(generationBlockedReason) || cloudKeyMissing}>{busy ? "获取中…" : "获取"}</Button>}
              </section>

              {type === "custom" && <section className="derived-chat" aria-label="AI 对话">
                <label className="derived-custom-prompt"><span>你希望 AI 如何分析这篇文章？</span><textarea aria-label="AI 对话 Prompt" maxLength={4_000} rows={5} value={customPrompt} onChange={(event) => setCustomPrompt(event.target.value)} placeholder="例如：找出文章的核心论点、可疑假设和值得追问的问题。" disabled={busy || task?.status === "running"} /><small>{customPrompt.length.toLocaleString("zh-CN")} / 4,000</small></label>
                <div className="derived-chat-actions"><Button onClick={() => { setCustomPrompt(""); onTypeChange("summary"); }} disabled={busy || task?.status === "running"}>取消</Button><Button variant="primary" onClick={() => void generate()} disabled={busy || !customPrompt.trim() || !settings?.enabled || task?.status === "running" || Boolean(generationBlockedReason) || cloudKeyMissing}>{busy ? "生成中…" : "发送并生成"}</Button></div>
              </section>}

              {task && task.status !== "succeeded" && <section className={`derived-task is-${task.status}`} aria-live="polite"><div><span>TASK</span><strong>{taskLabel}{task.status === "running" ? "正在生成" : task.status === "failed" ? "生成失败" : "已取消"}</strong>{task.status === "running" && <div className="derived-task-progress"><progress aria-label="AI 生成批次进度" max={task.progress.totalBatches} value={task.progress.completedBatches} /><small>批次进度 {task.progress.completedBatches} / {task.progress.totalBatches}</small></div>}{task.error && <small>{task.error.code} · {userErrorMessage(task.error.code)}</small>}{task.status !== "running" && task.progress.totalBatches > 1 && <small className="derived-retry-note">重试将从第一批开始，不会复用已完成批次。</small>}</div>{task.status === "running" ? <Button type="button" onClick={() => void cancel()} disabled={busy}>取消任务</Button> : <Button type="button" onClick={() => void retry()} disabled={busy || !settings?.enabled}>重试</Button>}</section>}

              {(notice || error) && <p className={`derived-message ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{error || notice}</p>}

              <section className="derived-history" aria-labelledby="derived-history-title">
                <div className="derived-history-head"><div><h4 id="derived-history-title">派生历史</h4></div><strong>{total} 条</strong></div>
                {!results.length ? <p className="derived-empty">还没有派生结果。AI 关闭时，这里也不会产生任何后台请求。</p> : <ol>{results.map((result) => {
                  const tags = result.type === "tag-suggestions" ? stringList(result.output) : [];
                  const checkedTags = selectedTags.resultId === result.id ? selectedTags.tags : [];
                  return <li key={result.id} className={result.stale ? "is-stale" : undefined}><header><div><strong>{typeLabel(result.type, result.targetLanguage, result.promptVersion)}</strong>{result.pinned && <span>已固定</span>}{result.stale && <em>已过期</em>}{result.truncated && <em>输入已截断</em>}</div><time dateTime={result.createdAt}>{dateTime(result.createdAt)}</time></header><div className="derived-result-meta">{result.model} · {result.endpointId} · {result.durationMs} ms{result.usage?.totalTokens ? ` · ${result.usage.totalTokens} tokens` : ""}</div>{result.type === "tag-suggestions" ? <fieldset className="derived-tags" disabled={busy || Boolean(generationBlockedReason)}><legend>选择要加入的标签（默认不选）</legend>{tags.map((tag) => <label key={tag}><input type="checkbox" checked={checkedTags.includes(tag)} onChange={(event) => setSelectedTags((current) => { const selected = current.resultId === result.id ? current.tags : []; return { resultId: result.id, tags: event.target.checked ? [...new Set([...selected, tag])] : selected.filter((value) => value !== tag) }; })} />#{tag}</label>)}<Button type="button" onClick={() => void adoptTags(result)} disabled={!checkedTags.length || busy}>采纳所选标签</Button></fieldset> : <DerivedOutput result={result} markdown={markdownResults.has(result.id)} onLoadMarkdown={() => loadResultMarkdown(result.id)} />}<footer>{result.type === "summary" && !result.promptVersion.includes("custom-v1-") && <Button type="button" onClick={() => void pin(result)} disabled={busy}>{result.pinned ? "取消固定" : "固定摘要"}</Button>}<Button type="button" className="danger" onClick={() => void remove(result)} disabled={busy}>删除结果</Button></footer></li>;
                })}</ol>}
                {total > 30 && <nav aria-label="派生历史分页"><Button type="button" disabled={page <= 1 || busy} onClick={() => void loadResults(page - 1)}>上一页</Button><span>{page} / {Math.ceil(total / 30)}</span><Button type="button" disabled={page >= Math.ceil(total / 30) || busy} onClick={() => void loadResults(page + 1)}>下一页</Button></nav>}
              </section>
            </>
          )}
        </aside>
      )}
    </>
  );
}
