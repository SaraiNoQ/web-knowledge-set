import { useEffect, useId, useState } from "react";
import type { ReactNode, Ref } from "react";
import type { DocumentListResponse, DocumentSearchScope, DocumentSort, KnowledgeFolder } from "../../shared/types";
import { searchTerms } from "../../shared/search";
import { api } from "../api";
import { Button, IconButton, Select } from "./ui/Controls";
import { WorkspaceIcon } from "./ui/WorkspaceIcon";
import "../library-search.css";

export interface LibrarySearchProps {
  folders: KnowledgeFolder[];
  refreshKey: number;
  inputRef?: Ref<HTMLInputElement>;
  onOpen: (id: string) => Promise<boolean>;
  active: boolean;
}

function highlight(text: string, query: string, caseSensitive: boolean): ReactNode {
  if (!query) return text;
  const terms = searchTerms(query).sort((a, b) => b.length - a.length).map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const pattern = new RegExp(terms.join("|"), caseSensitive ? "gu" : "giu");
  const parts: ReactNode[] = [];
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > start) parts.push(text.slice(start, match.index));
    parts.push(<mark key={match.index}>{match[0]}</mark>);
    start = match.index + match[0].length;
  }
  parts.push(text.slice(start));
  return parts;
}

export function LibrarySearch({ folders, refreshKey, inputRef, onOpen, active }: LibrarySearchProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<DocumentSearchScope>("all");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [folderId, setFolderId] = useState("");
  const [kind, setKind] = useState<"" | "article" | "paper">("");
  const [favorite, setFavorite] = useState(false);
  const [sort, setSort] = useState<DocumentSort>("updated");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<DocumentListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapseResults, setCollapseResults] = useState(false);
  const [moreContext, setMoreContext] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const term = query.trim();

  useEffect(() => {
    if (!active || !term) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setResult(null);
    const timer = window.setTimeout(() => {
      void api.listDocuments({ q: term, scope, caseSensitive, folderId: folderId || undefined, kind: kind || undefined, favorite: favorite || undefined, sort, page }, controller.signal).then((response) => {
        if (controller.signal.aborted) return;
        setResult(response);
        setHistory((previous) => [term, ...previous.filter((value) => value !== term)].slice(0, 6));
        setLoading(false);
      }).catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "搜索失败，请稍后重试。");
        setLoading(false);
      });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [term, scope, caseSensitive, folderId, kind, favorite, sort, page, active, refreshKey, retryKey]);

  async function openDocument(documentId: string) {
    if (openingId) return;
    setOpeningId(documentId);
    try { await onOpen(documentId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法打开文档，请稍后重试。"); }
    finally { setOpeningId(null); }
  }

  function changeQuery(value: string) { setQuery(value); setPage(1); }

  return <section className="library-search" aria-label="搜索文档">
    <div className="library-search-controls">
      <div className="library-search-input">
        <WorkspaceIcon name="search" size={18} />
        <input ref={inputRef} aria-label="搜索文档" type="search" maxLength={200} placeholder="输入并开始搜索…" value={query} onChange={(event) => changeQuery(event.target.value)} />
        <Button type="button" variant="ghost" density="compact" className="library-search-icon library-search-case" aria-label="区分大小写" aria-pressed={caseSensitive} title="区分大小写" onClick={() => { setCaseSensitive(!caseSensitive); setPage(1); }}>Aa</Button>
        {query && <IconButton className="library-search-icon" label="清空搜索" title="清空搜索" onClick={() => changeQuery("")}><WorkspaceIcon name="close" size={16} /></IconButton>}
      </div>
      <IconButton className="library-search-icon library-search-settings-button" label="搜索设置" aria-expanded={settingsOpen} aria-controls={`${id}-settings`} onClick={() => setSettingsOpen(!settingsOpen)}>
        <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18M8 3v6M16 9v6M9 15v6" /></svg>
      </IconButton>
    </div>
    {settingsOpen && <div className="library-search-settings" id={`${id}-settings`}>
      <label className="library-search-switch"><span>折叠搜索结果</span><input type="checkbox" role="switch" checked={collapseResults} onChange={(event) => { setCollapseResults(event.target.checked); setExpanded({}); }} /></label>
      <label className="library-search-switch"><span>显示更多上下文</span><input type="checkbox" role="switch" checked={moreContext} onChange={(event) => setMoreContext(event.target.checked)} /></label>
      <div className="library-search-filters">
        <label>搜索范围<Select density="compact" aria-label="搜索范围" value={scope} onChange={(event) => { setScope(event.target.value as DocumentSearchScope); setPage(1); }}><option value="all">全部字段</option><option value="title">标题</option><option value="body">正文</option><option value="source">来源信息</option></Select></label>
        <label>文件夹<Select density="compact" aria-label="搜索文件夹" value={folderId} onChange={(event) => { setFolderId(event.target.value); setPage(1); }}><option value="">全部文件夹</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</Select></label>
        <label>文档类型<Select density="compact" aria-label="搜索文档类型" value={kind} onChange={(event) => { setKind(event.target.value as typeof kind); setPage(1); }}><option value="">全部类型</option><option value="article">文章</option><option value="paper">论文</option></Select></label>
        <label className="library-search-checkbox"><input type="checkbox" checked={favorite} onChange={(event) => { setFavorite(event.target.checked); setPage(1); }} />仅搜索收藏</label>
      </div>
    </div>}
    {!term ? <div className="library-search-start">
      <h3>搜索选项</h3>
      <p>输入关键词搜索文档，在搜索设置中缩小范围。</p>
      <dl><div><dt>标题</dt><dd>匹配文章与论文标题</dd></div><div><dt>正文</dt><dd>匹配已保存的文档正文</dd></div><div><dt>来源信息</dt><dd>匹配网址、作者与来源备注</dd></div><div><dt>文件夹 / 类型 / 收藏</dt><dd>筛选对应文档</dd></div></dl>
      {history.length > 0 && <div className="library-search-history"><div className="library-search-history-heading"><h3>搜索历史</h3><IconButton className="library-search-icon" label="清除搜索历史" onClick={() => setHistory([])}><WorkspaceIcon name="close" size={16} /></IconButton></div>{history.map((value) => <Button type="button" key={value} onClick={() => changeQuery(value)}><WorkspaceIcon name="search" size={14} /><span>{value}</span></Button>)}</div>}
    </div> : <>
      <div className="library-search-summary"><span role="status" aria-live="polite">{loading ? "正在搜索…" : result ? `${result.total} 篇结果` : "搜索结果"}</span><label><span className="sr-only">搜索结果排序</span><Select density="compact" aria-label="搜索结果排序" value={sort} onChange={(event) => { setSort(event.target.value as DocumentSort); setPage(1); }}><option value="updated">最近修改</option><option value="created">最近添加</option><option value="title">标题 (A–Z)</option></Select></label></div>
      {error && <div className="library-search-message" role="alert"><p>{error}</p><Button type="button" onClick={() => setRetryKey((value) => value + 1)}>重试搜索</Button></div>}
      {!loading && result?.total === 0 && <p className="library-search-message">没有找到匹配文档。试试其他关键词或调整搜索设置。</p>}
      {!loading && result && <div className="library-search-results">{result.items.map((document) => {
        const isExpanded = expanded[document.id] ?? !collapseResults;
        const snippets = document.searchMatches?.length ? document.searchMatches : [document.sourceUrl].filter(Boolean);
        return <article className="library-search-result" key={document.id}>
          <div className="library-search-result-heading"><IconButton className={`library-search-icon library-search-expand${isExpanded ? " is-expanded" : ""}`} label={`${isExpanded ? "折叠" : "展开"} ${document.title} 的搜索结果`} aria-expanded={isExpanded} aria-controls={`${id}-${document.id}`} onClick={() => setExpanded((previous) => ({ ...previous, [document.id]: !isExpanded }))}><WorkspaceIcon name="chevron" size={14} /></IconButton><Button type="button" className="library-search-result-title" disabled={openingId !== null} onClick={() => void openDocument(document.id)} title={document.title}>{highlight(document.title, term, caseSensitive)}</Button><span className="library-search-kind">{document.kind === "paper" ? "论文" : "文章"}</span></div>
          {isExpanded && <div className={`library-search-snippets${moreContext ? " has-more-context" : ""}`} id={`${id}-${document.id}`}>{snippets.length ? snippets.slice(0, moreContext ? 5 : 2).map((snippet, index) => <Button type="button" key={index} disabled={openingId !== null} onClick={() => void openDocument(document.id)}>{highlight(snippet, term, caseSensitive)}</Button>) : <p>标题匹配，点击打开文档。</p>}</div>}
        </article>;
      })}</div>}
      {result && result.total > result.pageSize && <nav className="library-search-pagination" aria-label="搜索结果分页"><Button type="button" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><span>{page} / {Math.ceil(result.total / result.pageSize)}</span><Button type="button" disabled={loading || page * result.pageSize >= result.total} onClick={() => setPage(page + 1)}>下一页</Button></nav>}
    </>}
  </section>;
}
