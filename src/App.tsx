import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  CaptureStatus,
  DocumentSummary,
  KnowledgeDocument,
} from "../shared/types";
import { api, ApiRequestError } from "./api";
import { MarkdownEditor } from "./components/MarkdownEditor";

type EditorMode = "edit" | "split" | "preview";
type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";
type StatusFilter = CaptureStatus | "";

interface Draft {
  title: string;
  markdown: string;
  tags: string[];
}

const ACTIVE_STATUSES = new Set<CaptureStatus>(["queued", "fetching", "extracting"]);
const STATUS_LABEL: Record<CaptureStatus, string> = {
  queued: "等待抓取",
  fetching: "正在读取网页",
  extracting: "正在织理正文",
  ready: "已就绪",
  failed: "抓取失败",
};

function draftOf(document: KnowledgeDocument): Draft {
  return { title: document.title, markdown: document.markdown, tags: document.tags };
}

function draftsEqual(a: Draft, b: Draft) {
  return a.title === b.title && a.markdown === b.markdown && a.tags.join("\0") === b.tags.join("\0");
}

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(
      new Date(value),
    );
  } catch {
    return value;
  }
}

function sourceName(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "网页来源";
  }
}

function parseTags(value: string) {
  return [...new Set(value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];
}

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

function StatePanel({ kind, title, children }: { kind: "loading" | "empty" | "error"; title: string; children?: ReactNode }) {
  return (
    <div className={`state-panel state-${kind}`} role={kind === "error" ? "alert" : undefined}>
      <div className="state-glyph" aria-hidden="true">{kind === "loading" ? <Spinner /> : kind === "error" ? "!" : "◌"}</div>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

function DocumentStatus({ status }: { status: CaptureStatus }) {
  return <span className={`status status-${status}`}><i />{STATUS_LABEL[status]}</span>;
}

function resolveLink(href: string | undefined, sourceUrl: string) {
  if (!href) return undefined;
  if (href.startsWith("#") || href.startsWith("mailto:")) return href;
  try {
    const resolved = new URL(href, sourceUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : undefined;
  } catch {
    return undefined;
  }
}

function resolveImage(src: string | undefined, sourceUrl: string) {
  if (!src) return undefined;
  try {
    const resolved = new URL(src, sourceUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : undefined;
  } catch {
    return undefined;
  }
}

function MarkdownPreview({ markdown, sourceUrl }: { markdown: string; sourceUrl: string }) {
  return (
    <article className="markdown-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, children, ...props }) => {
            const safeHref = resolveLink(href, sourceUrl);
            if (!safeHref) return <span>{children}</span>;
            const external = !safeHref.startsWith("#");
            return <a {...props} href={safeHref} target={external ? "_blank" : undefined} rel={external ? "noreferrer noopener" : undefined}>{children}</a>;
          },
          img: ({ node: _node, src, alt }) => {
            const safeSrc = resolveImage(src, sourceUrl);
            return safeSrc ? <img src={safeSrc} alt={alt || ""} loading="lazy" referrerPolicy="no-referrer" /> : null;
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  );
}

export default function App() {
  const [items, setItems] = useState<DocumentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(30);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentDoc, setCurrentDoc] = useState<KnowledgeDocument | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tagText, setTagText] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [mode, setMode] = useState<EditorMode>("split");

  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState<KnowledgeDocument | null>(null);
  const [retrying, setRetrying] = useState(false);

  const selectedIdRef = useRef(selectedId);
  const draftRef = useRef(draft);
  const saveInFlight = useRef(false);
  selectedIdRef.current = selectedId;
  draftRef.current = draft;

  const persistedDraft = currentDoc ? draftOf(currentDoc) : null;
  const dirty = Boolean(draft && persistedDraft && !draftsEqual(draft, persistedDraft));
  const activeCapture = currentDoc ? ACTIVE_STATUSES.has(currentDoc.status) : false;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const mergeKnownTags = useCallback((documents: DocumentSummary[]) => {
    setKnownTags((previous) => [...new Set([...previous, ...documents.flatMap((item) => item.tags)])].sort());
  }, []);

  const updateListItem = useCallback((document: KnowledgeDocument) => {
    setItems((previous) => previous.map((item) => item.id === document.id ? {
      ...item,
      title: document.title,
      tags: document.tags,
      status: document.status,
      warning: document.warning,
      errorCode: document.errorCode,
      errorMessage: document.errorMessage,
      revision: document.revision,
      updatedAt: document.updatedAt,
    } : item));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setListLoading(true);
      setListError("");
      try {
        const result = await api.listDocuments({ q: query, tag, status, page }, controller.signal);
        setItems(result.items);
        setTotal(result.total);
        setPageSize(result.pageSize || 30);
        mergeKnownTags(result.items);
      } catch (error) {
        if ((error as Error).name !== "AbortError") setListError((error as Error).message);
      } finally {
        if (!controller.signal.aborted) setListLoading(false);
      }
    }, query ? 220 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [mergeKnownTags, page, query, status, tag]);

  useEffect(() => {
    if (!items.some((item) => ACTIVE_STATUSES.has(item.status))) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await api.listDocuments({ q: query, tag, status, page });
        setItems(result.items);
        setTotal(result.total);
        mergeKnownTags(result.items);
      } catch {
        // Background refresh failures should not replace the current workspace.
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [items, mergeKnownTags, page, query, status, tag]);

  useEffect(() => {
    if (!selectedId) {
      setCurrentDoc(null);
      setDraft(null);
      return;
    }
    const controller = new AbortController();
    setCurrentDoc(null);
    setDraft(null);
    setTagText("");
    setDetailLoading(true);
    setDetailError("");
    setSaveState("idle");
    setSaveError("");
    setConflict(null);
    api.getDocument(selectedId, controller.signal)
      .then((document) => {
        setCurrentDoc(document);
        setDraft(draftOf(document));
        setTagText(document.tags.join(", "));
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setDetailError((error as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !currentDoc || !ACTIVE_STATUSES.has(currentDoc.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const document = await api.getDocument(selectedId);
        updateListItem(document);
        setCurrentDoc(document);
        setDraft(draftOf(document));
        setTagText(document.tags.join(", "));
      } catch {
        // The list poll remains the visible source of capture progress.
      }
    }, 1800);
    return () => window.clearInterval(timer);
  }, [currentDoc, selectedId, updateListItem]);

  const saveNow = useCallback(async () => {
    if (!currentDoc || !draft || currentDoc.status !== "ready" || !dirty || saveInFlight.current || conflict) return;
    const sent = { ...draft, tags: [...draft.tags] };
    saveInFlight.current = true;
    setSaveState("saving");
    setSaveError("");
    try {
      const updated = await api.updateDocument(currentDoc.id, { ...sent, revision: currentDoc.revision });
      if (selectedIdRef.current !== currentDoc.id) return;
      setCurrentDoc(updated);
      updateListItem(updated);
      const unchangedSinceRequest = Boolean(draftRef.current && draftsEqual(draftRef.current, sent));
      if (unchangedSinceRequest) {
        setDraft(draftOf(updated));
        setTagText(updated.tags.join(", "));
      }
      setSaveState(unchangedSinceRequest ? "saved" : "idle");
    } catch (error) {
      if (selectedIdRef.current !== currentDoc.id) return;
      if (error instanceof ApiRequestError && error.status === 409 && error.document) {
        setConflict(error.document);
        setSaveState("conflict");
      } else {
        setSaveError((error as Error).message);
        setSaveState("error");
      }
    } finally {
      saveInFlight.current = false;
    }
  }, [conflict, currentDoc, dirty, draft, updateListItem]);

  useEffect(() => {
    if (!dirty || saveState === "conflict" || saveState === "error" || currentDoc?.status !== "ready") return;
    const timer = window.setTimeout(saveNow, 800);
    return () => window.clearTimeout(timer);
  }, [currentDoc?.status, dirty, saveNow, saveState]);

  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = window.setTimeout(() => setSaveState("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [saveState]);

  useEffect(() => {
    const handleSave = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener("keydown", handleSave);
    return () => window.removeEventListener("keydown", handleSave);
  }, [saveNow]);

  useEffect(() => {
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnUnsaved);
    return () => window.removeEventListener("beforeunload", warnUnsaved);
  }, [dirty]);

  const handleImport = async (event: FormEvent) => {
    event.preventDefault();
    setImportError("");
    if (dirty && !window.confirm("当前修改尚未保存，继续收取新网页吗？")) return;
    let normalized: string;
    try {
      const parsed = new URL(importUrl.trim());
      if (!/^https?:$/.test(parsed.protocol)) throw new Error();
      normalized = parsed.href;
    } catch {
      setImportError("请输入完整的 http(s) 网页地址。");
      return;
    }
    setImporting(true);
    try {
      const created = await api.createDocument(normalized);
      setImportUrl("");
      setQuery("");
      setTag("");
      setStatus("");
      setPage(1);
      const refreshed = await api.listDocuments({ page: 1 });
      setItems(refreshed.items);
      setTotal(refreshed.total);
      setPageSize(refreshed.pageSize || 30);
      mergeKnownTags(refreshed.items);
      setSelectedId(created.id);
    } catch (error) {
      setImportError((error as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const selectDocument = (id: string) => {
    if (id === selectedId) return;
    if (dirty && !window.confirm("当前修改尚未保存，确定离开吗？")) return;
    setSelectedId(id);
  };

  const closeDocument = () => {
    if (dirty && !window.confirm("当前修改尚未保存，确定离开吗？")) return;
    setSelectedId(null);
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".document-row")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  const retryCapture = async () => {
    if (!currentDoc) return;
    setRetrying(true);
    setDetailError("");
    try {
      const updated = await api.retryDocument(currentDoc.id);
      setCurrentDoc(updated);
      setDraft(draftOf(updated));
      setTagText(updated.tags.join(", "));
      updateListItem(updated);
    } catch (error) {
      setDetailError((error as Error).message);
    } finally {
      setRetrying(false);
    }
  };

  const acceptServerVersion = () => {
    if (!conflict) return;
    setCurrentDoc(conflict);
    setDraft(draftOf(conflict));
    setTagText(conflict.tags.join(", "));
    updateListItem(conflict);
    setConflict(null);
    setSaveState("idle");
  };

  const keepLocalVersion = () => {
    if (!conflict) return;
    setCurrentDoc(conflict);
    updateListItem(conflict);
    setConflict(null);
    setSaveState("idle");
  };

  const filteredDescription = useMemo(() => {
    const parts = [query && `“${query}”`, tag && `#${tag}`, status && STATUS_LABEL[status]].filter(Boolean);
    return parts.length ? parts.join(" · ") : "全部网页";
  }, [query, status, tag]);

  return (
    <div className="app-shell">
      <header className="masthead">
        <div className="brand" aria-label="织页本地知识库">
          <span className="brand-seal">织</span>
          <span><strong>织页</strong><small>ZHIYE · LOCAL KNOWLEDGE</small></span>
        </div>
        <p className="masthead-note">把散落的网页，<br />织成可编辑的知识。</p>
        <span className="local-mark"><i />本地工作台</span>
      </header>

      <section className="capture-band" aria-labelledby="capture-title">
        <div className="capture-index" aria-hidden="true">01</div>
        <div className="capture-copy">
          <h1 id="capture-title">收藏一张网页</h1>
          <p>输入链接，织页会留下正文、来源与可编辑的 Markdown。</p>
        </div>
        <form className="capture-form" onSubmit={handleImport}>
          <label className="sr-only" htmlFor="capture-url">网页地址</label>
          <span className="url-prefix" aria-hidden="true">URL</span>
          <input id="capture-url" value={importUrl} onChange={(event) => setImportUrl(event.target.value)} placeholder="https://example.com/an-article" inputMode="url" autoComplete="url" disabled={importing} />
          <button className="primary-button" type="submit" disabled={importing || !importUrl.trim()}>
            {importing ? <><Spinner />收取中</> : <><span>收取网页</span><Icon><path d="M5 12h14M13 6l6 6-6 6" /></Icon></>}
          </button>
        </form>
        <div className="form-message" aria-live="polite">{importError && <span className="error-text">{importError}</span>}</div>
      </section>

      <main className={`workspace ${selectedId ? "has-selection" : ""}`}>
        <aside className="library-panel" aria-label="知识列表">
          <div className="panel-heading">
            <div><span className="eyebrow">02 · LIBRARY</span><h2>知识织片</h2></div>
            <span className="total-count">{total}<small>篇</small></span>
          </div>

          <div className="filters">
            <label className="search-field">
              <span className="sr-only">搜索知识</span>
              <Icon size={17}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></Icon>
              <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索标题与正文" />
              {query && <button type="button" className="clear-search" onClick={() => setQuery("")} aria-label="清空搜索">×</button>}
            </label>
            <div className="select-row">
              <label><span className="sr-only">按标签筛选</span><select value={tag} onChange={(event) => { setTag(event.target.value); setPage(1); }}><option value="">全部标签</option>{knownTags.map((value) => <option key={value} value={value}>#{value}</option>)}</select></label>
              <label><span className="sr-only">按状态筛选</span><select value={status} onChange={(event) => { setStatus(event.target.value as StatusFilter); setPage(1); }}><option value="">全部状态</option><option value="ready">已就绪</option><option value="queued">等待中</option><option value="fetching">抓取中</option><option value="extracting">整理中</option><option value="failed">抓取失败</option></select></label>
            </div>
          </div>

          <div className="result-caption"><span>{filteredDescription}</span>{items.some((item) => ACTIVE_STATUSES.has(item.status)) && <span className="polling-mark"><i />更新中</span>}</div>

          <div className="document-list" onKeyDown={handleListKeyDown}>
            {listLoading && !items.length ? <StatePanel kind="loading" title="正在翻阅知识库" /> : listError ? <StatePanel kind="error" title="无法读取列表">{listError}</StatePanel> : !items.length ? <StatePanel kind="empty" title="还没有找到织片">{query || tag || status ? "试试放宽筛选条件。" : "从上方收藏第一张网页。"}</StatePanel> : items.map((item, index) => (
              <button type="button" key={item.id} className={`document-row ${selectedId === item.id ? "is-selected" : ""}`} onClick={() => selectDocument(item.id)} aria-current={selectedId === item.id ? "true" : undefined}>
                <span className="row-number">{String((page - 1) * pageSize + index + 1).padStart(2, "0")}</span>
                <span className="row-body">
                  <strong>{item.title || "未命名网页"}</strong>
                  <span className="row-source">{sourceName(item.sourceUrl)}<b>·</b>{formatDate(item.updatedAt)}</span>
                  <span className="row-footer"><DocumentStatus status={item.status} />{item.tags.slice(0, 2).map((value) => <em key={value}>#{value}</em>)}</span>
                </span>
                <span className="row-arrow" aria-hidden="true">↗</span>
              </button>
            ))}
          </div>

          {pageCount > 1 && <nav className="pagination" aria-label="知识列表分页"><button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span>{page} / {pageCount}</span><button type="button" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>下一页</button></nav>}
        </aside>

        <section className="reader-panel" aria-label="文档工作台">
          {!selectedId ? (
            <div className="welcome-state">
              <div className="weave-mark" aria-hidden="true"><i /><i /><i /><i /></div>
              <span className="eyebrow">QUIET WORKBENCH</span>
              <h2>在左侧选一张织片</h2>
              <p>阅读原文、整理标签，或直接修改 Markdown。<br />你的文字会留在本地。</p>
            </div>
          ) : detailLoading && !currentDoc ? (
            <StatePanel kind="loading" title="正在展开织片" />
          ) : detailError && !currentDoc ? (
            <StatePanel kind="error" title="无法打开这篇知识">{detailError}</StatePanel>
          ) : currentDoc && draft ? (
            <>
              <button type="button" className="mobile-back" onClick={closeDocument}><Icon size={16}><path d="m15 18-6-6 6-6" /></Icon>返回知识库</button>
              <header className="document-head">
                <div className="document-kicker">
                  <DocumentStatus status={currentDoc.status} />
                  <a href={currentDoc.finalUrl || currentDoc.sourceUrl} target="_blank" rel="noreferrer noopener">{sourceName(currentDoc.finalUrl || currentDoc.sourceUrl)}<Icon size={13}><path d="M14 5h5v5M10 14 19 5M19 14v5H5V5h5" /></Icon></a>
                  <span>{formatDate(currentDoc.updatedAt)}</span>
                </div>
                <label className="title-field"><span className="sr-only">文档标题</span><textarea rows={2} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} disabled={currentDoc.status !== "ready"} /></label>
                <div className="document-meta">
                  <label className="tag-field"><span>标签</span><input value={tagText} onChange={(event) => { setTagText(event.target.value); setDraft({ ...draft, tags: parseTags(event.target.value) }); }} placeholder="用逗号分隔" disabled={currentDoc.status !== "ready"} /></label>
                  <dl><div><dt>作者</dt><dd>{currentDoc.author || "未识别"}</dd></div><div><dt>收取</dt><dd>{currentDoc.captureMode === "browser" ? "浏览器" : currentDoc.captureMode === "http" ? "直接读取" : "—"}</dd></div></dl>
                </div>
              </header>

              {currentDoc.warning && <div className="notice warning" role="status"><strong>注意</strong><span>{currentDoc.warning}</span></div>}
              {detailError && <div className="notice error" role="alert"><strong>请求失败</strong><span>{detailError}</span></div>}

              {activeCapture ? (
                <div className="capture-progress" aria-live="polite">
                  <div className="progress-orbit"><i /><i /><span>织</span></div>
                  <span className="eyebrow">{currentDoc.status.toUpperCase()}</span>
                  <h3>{STATUS_LABEL[currentDoc.status]}</h3>
                  <p>这通常只需片刻。你可以去看其他织片，完成后会自动刷新。</p>
                  <div className="progress-line"><span /></div>
                </div>
              ) : currentDoc.status === "failed" ? (
                <div className="capture-failed" role="alert">
                  <span className="failure-code">{currentDoc.errorCode || "CAPTURE_FAILED"}</span>
                  <h3>这张网页没有收进来</h3>
                  <p>{currentDoc.errorMessage || "请检查链接后再试一次。"}</p>
                  <button type="button" className="primary-button" onClick={retryCapture} disabled={retrying}>{retrying ? <><Spinner />重试中</> : "重新抓取"}</button>
                </div>
              ) : (
                <div className="editor-workbench">
                  <div className="editor-toolbar">
                    <div className="mode-switch" aria-label="编辑器显示模式">
                      {(["edit", "split", "preview"] as EditorMode[]).map((value) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{value === "edit" ? "编辑" : value === "split" ? "对照" : "预览"}</button>)}
                    </div>
                    <div className="editor-stats">{draft.markdown.length.toLocaleString("zh-CN")} 字符</div>
                    <div className={`save-indicator save-${saveState}`} aria-live="polite">
                      {saveState === "saving" ? <><Spinner />正在保存</> : saveState === "saved" ? "已保存" : saveState === "error" ? "保存失败" : saveState === "conflict" ? "版本冲突" : dirty ? "未保存" : "已同步"}
                    </div>
                    {saveState === "error" && <button type="button" className="text-button danger" onClick={() => void saveNow()}>重试</button>}
                    <button type="button" className="text-button save-button" onClick={() => void saveNow()} disabled={!dirty || saveState === "saving" || saveState === "conflict"} title="保存（⌘S）">保存</button>
                    <a className="export-button" href={api.exportUrl(currentDoc.id)} download><Icon size={15}><path d="M12 3v12M7 10l5 5 5-5M5 20h14" /></Icon>导出 .md</a>
                  </div>

                  {saveState === "error" && <div className="inline-error" role="alert">{saveError}</div>}
                  {conflict && <div className="conflict-banner" role="alert"><div><strong>这篇知识在别处被修改过</strong><span>选择保留服务器新版，或基于新版继续保存你的文字。</span></div><div><button type="button" onClick={acceptServerVersion}>使用新版</button><button type="button" className="primary-button" onClick={keepLocalVersion}>保留我的修改</button></div></div>}

                  <div className={`editor-grid mode-${mode}`}>
                    {mode !== "preview" && <section className="editor-pane" aria-label="Markdown 源文编辑"><div className="pane-label">MARKDOWN</div><MarkdownEditor value={draft.markdown} onChange={(markdown) => setDraft((value) => value ? { ...value, markdown } : value)} /></section>}
                    {mode !== "edit" && <section className="preview-pane" aria-label="Markdown 预览"><div className="pane-label">PREVIEW</div>{draft.markdown.trim() ? <MarkdownPreview markdown={draft.markdown} sourceUrl={currentDoc.finalUrl || currentDoc.sourceUrl} /> : <StatePanel kind="empty" title="这里还没有文字">在编辑区写下 Markdown，预览会同步出现。</StatePanel>}</section>}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </section>
      </main>
    </div>
  );
}
