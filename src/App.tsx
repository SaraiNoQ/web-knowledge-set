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
  DocumentRevision,
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

function formatDateTime(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
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

function revisionPreview(markdown: string) {
  return markdown.replace(/[#*_`>\[\]()~-]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 150) || "空白正文";
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

function needsCapturePolling(document: Pick<DocumentSummary, "status" | "deletedAt">) {
  return ACTIVE_STATUSES.has(document.status) && !(document.deletedAt && document.status === "queued");
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
          img: ({ node: _node, alt }) => (
            <span className="external-image-note" role="note">外部图片已隐藏{alt ? `：${alt}` : ""}</span>
          ),
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
  const [inTrash, setInTrash] = useState(false);
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
  const [importNotice, setImportNotice] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState<KnowledgeDocument | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [lifecycleAction, setLifecycleAction] = useState<"delete" | "restore" | "permanent" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [revisions, setRevisions] = useState<DocumentRevision[]>([]);
  const [restoringRevision, setRestoringRevision] = useState<number | null>(null);

  const selectedIdRef = useRef(selectedId);
  const draftRef = useRef(draft);
  const saveInFlight = useRef(false);
  const readerPanelRef = useRef<HTMLElement>(null);
  selectedIdRef.current = selectedId;
  draftRef.current = draft;

  const persistedDraft = currentDoc ? draftOf(currentDoc) : null;
  const dirty = Boolean(draft && persistedDraft && !draftsEqual(draft, persistedDraft));
  const activeCapture = currentDoc ? ACTIVE_STATUSES.has(currentDoc.status) : false;
  const editorLocked = Boolean(lifecycleAction) || restoringRevision !== null || Boolean(conflict && saveState === "saving");
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const refreshKnownTags = useCallback((signal?: AbortSignal) => {
    void api.listTags(inTrash ? "only" : undefined, signal).then(setKnownTags).catch(() => {
      // Keep the last complete tag list when this secondary refresh fails.
    });
  }, [inTrash]);

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
      deletedAt: document.deletedAt,
      updatedAt: document.updatedAt,
    } : item));
  }, []);

  const focusReader = useCallback(() => {
    window.requestAnimationFrame(() => readerPanelRef.current?.focus());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setListLoading(true);
      setListError("");
      try {
        const result = await api.listDocuments(
          { q: query, tag, status, page, trash: inTrash ? "only" : undefined },
          controller.signal,
        );
        setItems(result.items);
        setTotal(result.total);
        setPageSize(result.pageSize || 30);
        refreshKnownTags(controller.signal);
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
  }, [inTrash, page, query, refreshKnownTags, status, tag]);

  useEffect(() => {
    if (!items.some(needsCapturePolling)) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await api.listDocuments({
          q: query,
          tag,
          status,
          page,
          trash: inTrash ? "only" : undefined,
        });
        setItems(result.items);
        setTotal(result.total);
        refreshKnownTags();
      } catch {
        // Background refresh failures should not replace the current workspace.
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [inTrash, items, page, query, refreshKnownTags, status, tag]);

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
    setHistoryOpen(false);
    setHistoryLoading(false);
    setHistoryError("");
    setRevisions([]);
    setRestoringRevision(null);
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
    if (!selectedId || !currentDoc || !needsCapturePolling(currentDoc)) return;
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
      refreshKnownTags();
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
  }, [conflict, currentDoc, dirty, draft, refreshKnownTags, updateListItem]);

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
    // ponytail: warning only; persistent draft recovery and the Tauri close handshake belong to the next M1 slice.
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
    setImportNotice("");
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
      const duplicateInTrash = Boolean(created.deletedAt);
      setInTrash(duplicateInTrash);
      const refreshed = await api.listDocuments({ page: 1, trash: duplicateInTrash ? "only" : undefined });
      setItems(refreshed.items);
      setTotal(refreshed.total);
      setPageSize(refreshed.pageSize || 30);
      setSelectedId(created.id);
      if (duplicateInTrash) setImportNotice("这张网页已在回收站中，已为你打开，可在右侧恢复。");
    } catch (error) {
      setImportError((error as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const selectDocument = (id: string) => {
    if (id === selectedId || lifecycleAction || restoringRevision !== null) return;
    if (dirty && !window.confirm("当前修改尚未保存，确定离开吗？")) return;
    setSelectedId(id);
  };

  const closeDocument = () => {
    if (lifecycleAction || restoringRevision !== null) return;
    if (dirty && !window.confirm("当前修改尚未保存，确定离开吗？")) return;
    setSelectedId(null);
  };

  const switchLibrary = (trashView: boolean) => {
    if (trashView === inTrash || lifecycleAction || restoringRevision !== null) return;
    if (dirty && !window.confirm("当前修改尚未保存，确定离开吗？")) return;
    setInTrash(trashView);
    setPage(1);
    setItems([]);
    setSelectedId(null);
    setTag("");
    setImportNotice("");
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

  const moveToTrash = async () => {
    if (!currentDoc || dirty || !window.confirm(`把“${currentDoc.title || "未命名网页"}”移入回收站？之后可以恢复。`)) return;
    setLifecycleAction("delete");
    setDetailError("");
    try {
      const deleted = await api.deleteDocument(currentDoc.id);
      setCurrentDoc(deleted);
      setDraft(draftOf(deleted));
      setTagText(deleted.tags.join(", "));
      setInTrash(true);
      setPage(1);
      setItems([]);
      setHistoryOpen(false);
      focusReader();
    } catch (error) {
      setDetailError((error as Error).message);
    } finally {
      setLifecycleAction(null);
    }
  };

  const restoreFromTrash = async () => {
    if (!currentDoc) return;
    setLifecycleAction("restore");
    setDetailError("");
    try {
      const restored = await api.restoreDocument(currentDoc.id);
      setCurrentDoc(restored);
      setDraft(draftOf(restored));
      setTagText(restored.tags.join(", "));
      setInTrash(false);
      setPage(1);
      setItems([]);
      focusReader();
    } catch (error) {
      setDetailError((error as Error).message);
    } finally {
      setLifecycleAction(null);
    }
  };

  const permanentlyDelete = async () => {
    if (!currentDoc || !window.confirm(`永久删除“${currentDoc.title || "未命名网页"}”？抓取快照和历史版本也会被删除，此操作无法撤销。`)) return;
    setLifecycleAction("permanent");
    setDetailError("");
    try {
      await api.permanentlyDeleteDocument(currentDoc.id, currentDoc.revision);
      setItems((previous) => previous.filter((item) => item.id !== currentDoc.id));
      setTotal((value) => Math.max(0, value - 1));
      setPage(1);
      setSelectedId(null);
      focusReader();
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409 && error.document) {
        setCurrentDoc(error.document);
        setDraft(draftOf(error.document));
        setTagText(error.document.tags.join(", "));
      }
      setDetailError((error as Error).message);
    } finally {
      setLifecycleAction(null);
    }
  };

  const toggleHistory = async () => {
    if (!currentDoc || historyOpen) {
      setHistoryOpen(false);
      return;
    }
    const documentId = currentDoc.id;
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const result = await api.listDocumentRevisions(documentId);
      if (selectedIdRef.current === documentId) setRevisions(result);
    } catch (error) {
      if (selectedIdRef.current === documentId) setHistoryError((error as Error).message);
    } finally {
      if (selectedIdRef.current === documentId) setHistoryLoading(false);
    }
  };

  const restoreRevision = async (revision: DocumentRevision) => {
    if (!currentDoc || dirty) return;
    setRestoringRevision(revision.revision);
    setHistoryError("");
    try {
      const restored = await api.restoreDocumentRevision(currentDoc.id, revision.revision, currentDoc.revision);
      setCurrentDoc(restored);
      setDraft(draftOf(restored));
      setTagText(restored.tags.join(", "));
      updateListItem(restored);
      refreshKnownTags();
      setHistoryOpen(false);
      setSaveState("saved");
      focusReader();
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409 && error.document) {
        setDraft({ title: revision.title, markdown: revision.markdown, tags: [...revision.tags] });
        setTagText(revision.tags.join(", "));
        setConflict(error.document);
        setSaveState("conflict");
        setHistoryOpen(false);
        focusReader();
      } else {
        setHistoryError((error as Error).message);
      }
    } finally {
      setRestoringRevision(null);
    }
  };

  const acceptServerVersion = () => {
    if (!conflict) return;
    setCurrentDoc(conflict);
    setDraft(draftOf(conflict));
    setTagText(conflict.tags.join(", "));
    updateListItem(conflict);
    if (conflict.deletedAt) {
      setInTrash(true);
      setTag("");
      setPage(1);
      setItems([]);
    }
    setConflict(null);
    setSaveState("idle");
    focusReader();
  };

  const keepLocalVersion = async () => {
    if (!conflict || !draft) return;
    const local = { ...draft, tags: [...draft.tags] };
    const wasDeleted = Boolean(conflict.deletedAt);
    setSaveState("saving");
    setSaveError("");
    try {
      const base = wasDeleted ? await api.restoreDocument(conflict.id) : conflict;
      const updated = await api.updateDocument(base.id, { ...local, revision: base.revision });
      setCurrentDoc(updated);
      setDraft(draftOf(updated));
      setTagText(updated.tags.join(", "));
      setConflict(null);
      setSaveState("saved");
      setPage(1);
      if (wasDeleted) {
        setInTrash(false);
        setTag("");
      }
      const refreshed = await api.listDocuments({ q: query, tag: wasDeleted ? "" : tag, status, page: 1 });
      setItems(refreshed.items);
      setTotal(refreshed.total);
      setPageSize(refreshed.pageSize || 30);
      void api.listTags().then(setKnownTags).catch(() => undefined);
      focusReader();
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409 && error.document) {
        setConflict(error.document);
      } else {
        setDetailError((error as Error).message);
      }
      setSaveState("conflict");
    }
  };

  const filteredDescription = useMemo(() => {
    const parts = [query && `“${query}”`, tag && `#${tag}`, status && STATUS_LABEL[status]].filter(Boolean);
    return parts.length ? parts.join(" · ") : inTrash ? "已移除的网页" : "全部网页";
  }, [inTrash, query, status, tag]);

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
        <div className="form-message" aria-live="polite">
          {importError ? <span className="error-text">{importError}</span> : importNotice && <span className="notice-text">{importNotice}</span>}
        </div>
      </section>

      <main className={`workspace ${selectedId ? "has-selection" : ""}`}>
        <aside className="library-panel" aria-label="知识列表">
          <div className="panel-heading">
            <div><span className="eyebrow">02 · {inTrash ? "TRASH" : "LIBRARY"}</span><h2>{inTrash ? "回收站" : "知识织片"}</h2></div>
            <span className="total-count">{total}<small>篇</small></span>
          </div>

          <nav className="library-tabs" aria-label="资料库视图">
            <button type="button" aria-pressed={!inTrash} onClick={() => switchLibrary(false)}>资料库</button>
            <button type="button" aria-pressed={inTrash} onClick={() => switchLibrary(true)}>回收站</button>
          </nav>

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

          <div className="result-caption"><span>{filteredDescription}</span>{items.some(needsCapturePolling) && <span className="polling-mark"><i />更新中</span>}</div>

          <div className="document-list" onKeyDown={handleListKeyDown}>
            {listLoading && !items.length ? <StatePanel kind="loading" title="正在翻阅知识库" /> : listError ? <StatePanel kind="error" title="无法读取列表">{listError}</StatePanel> : !items.length ? <StatePanel kind="empty" title={inTrash ? "回收站是空的" : "还没有找到织片"}>{query || tag || status ? "试试放宽筛选条件。" : inTrash ? "移除的网页会暂存在这里。" : "从上方收藏第一张网页。"}</StatePanel> : items.map((item, index) => (
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

        <section ref={readerPanelRef} className="reader-panel" aria-label="文档工作台" tabIndex={-1}>
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
                <label className="title-field"><span className="sr-only">文档标题</span><textarea rows={2} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} disabled={Boolean(currentDoc.deletedAt) || currentDoc.status !== "ready" || editorLocked} /></label>
                <div className="document-meta">
                  <label className="tag-field"><span>标签</span><input value={tagText} onChange={(event) => { setTagText(event.target.value); setDraft({ ...draft, tags: parseTags(event.target.value) }); }} placeholder="用逗号分隔" disabled={Boolean(currentDoc.deletedAt) || currentDoc.status !== "ready" || editorLocked} /></label>
                  <dl><div><dt>作者</dt><dd>{currentDoc.author || "未识别"}</dd></div><div><dt>收取</dt><dd>{currentDoc.captureMode === "browser" ? "浏览器" : currentDoc.captureMode === "http" ? "直接读取" : "—"}</dd></div></dl>
                </div>
                {!currentDoc.deletedAt && (
                  <div className="document-actions">
                    <button type="button" className="text-button danger" onClick={() => void moveToTrash()} disabled={Boolean(lifecycleAction) || dirty || saveState === "saving"} title={dirty ? "请先保存当前修改" : undefined}>
                      {lifecycleAction === "delete" ? "正在移除…" : "移入回收站"}
                    </button>
                  </div>
                )}
              </header>

              {currentDoc.warning && <div className="notice warning" role="status"><strong>注意</strong><span>{currentDoc.warning}</span></div>}
              {detailError && <div className="notice error" role="alert"><strong>请求失败</strong><span>{detailError}</span></div>}

              {currentDoc.deletedAt ? (
                <div className="trash-workbench">
                  <div className="trash-callout">
                    <div><span className="eyebrow">READ ONLY · {formatDateTime(currentDoc.deletedAt)}</span><h3>这张织片在回收站中</h3><p>正文与历史版本仍完整保留。恢复后才能继续编辑。</p></div>
                    <div className="trash-actions">
                      <button type="button" className="primary-button" onClick={() => void restoreFromTrash()} disabled={Boolean(lifecycleAction)}>{lifecycleAction === "restore" ? <><Spinner />恢复中</> : "恢复到资料库"}</button>
                      <button type="button" className="text-button danger" onClick={() => void permanentlyDelete()} disabled={Boolean(lifecycleAction)}>{lifecycleAction === "permanent" ? "删除中…" : "永久删除"}</button>
                    </div>
                  </div>
                  <section className="trash-preview" aria-label="回收站文档预览">
                    <div className="pane-label">READ ONLY</div>
                    {draft.markdown.trim() ? <MarkdownPreview markdown={draft.markdown} sourceUrl={currentDoc.finalUrl || currentDoc.sourceUrl} /> : <StatePanel kind="empty" title="这张织片没有正文" />}
                  </section>
                </div>
              ) : activeCapture ? (
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
                    <button type="button" className="history-button" onClick={() => void toggleHistory()} disabled={dirty || saveState === "saving"} aria-expanded={historyOpen} aria-controls="revision-history">修订历史</button>
                    <a className="export-button" href={api.exportUrl(currentDoc.id)} download><Icon size={15}><path d="M12 3v12M7 10l5 5 5-5M5 20h14" /></Icon>导出 .md</a>
                  </div>

                  {saveState === "error" && <div className="inline-error" role="alert">{saveError}</div>}
                  {conflict && <div className="conflict-banner" role="alert"><div><strong>{conflict.deletedAt ? "这篇知识已被移入回收站" : "这篇知识在别处被修改过"}</strong><span>{conflict.deletedAt ? "可接受回收站状态，或恢复文档后保存你的本地修改。" : "选择保留服务器新版，或基于新版继续保存你的文字。"}</span></div><div><button type="button" onClick={acceptServerVersion} disabled={saveState === "saving"}>{conflict.deletedAt ? "查看回收站版本" : "使用新版"}</button><button type="button" className="primary-button" onClick={() => void keepLocalVersion()} disabled={saveState === "saving"}>{saveState === "saving" ? "处理中…" : "保留我的修改"}</button></div></div>}

                  {historyOpen && (
                    <aside id="revision-history" className="revision-panel" aria-label="修订历史">
                      <header><div><span className="eyebrow">VERSION THREAD</span><h3>修订历史</h3></div><button type="button" onClick={() => setHistoryOpen(false)} aria-label="关闭修订历史">×</button></header>
                      {historyLoading ? <StatePanel kind="loading" title="正在查找历史版本" /> : historyError ? <StatePanel kind="error" title="无法读取修订历史">{historyError}</StatePanel> : !revisions.length ? <StatePanel kind="empty" title="还没有修订记录">人工编辑并保存后，版本会出现在这里。</StatePanel> : (
                        <ol>
                          {revisions.map((revision) => {
                            const isCurrent = revision.revision === currentDoc.revision;
                            return <li key={revision.revision} className={isCurrent ? "is-current" : undefined}><div className="revision-meta"><strong>版本 {revision.revision}</strong><time dateTime={revision.createdAt}>{formatDateTime(revision.createdAt)}</time></div><h4>{revision.title || "未命名网页"}</h4><p>{revisionPreview(revision.markdown)}</p><div className="revision-foot"><span>{revision.tags.length ? revision.tags.map((value) => `#${value}`).join(" ") : "无标签"}</span><button type="button" onClick={() => void restoreRevision(revision)} disabled={isCurrent || dirty || restoringRevision !== null}>{isCurrent ? "当前版本" : restoringRevision === revision.revision ? "恢复中…" : "恢复此版本"}</button></div></li>;
                          })}
                        </ol>
                      )}
                    </aside>
                  )}

                  <div className={`editor-grid mode-${mode}`}>
                    {mode !== "preview" && <section className="editor-pane" aria-label="Markdown 源文编辑"><div className="pane-label">MARKDOWN</div><MarkdownEditor value={draft.markdown} onChange={(markdown) => setDraft((value) => value ? { ...value, markdown } : value)} readOnly={editorLocked} /></section>}
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
