import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { DocumentSummary } from "../../shared/types";
import { api } from "../api";
import "../quick-actions.css";
import { Modal } from "./ui/Modal";
import { WorkspaceIcon } from "./ui/WorkspaceIcon";

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenDocument: (id: string) => Promise<boolean>;
  onCreateArticle: (title: string) => Promise<boolean>;
}

export function QuickActions({ open, onClose, onOpenDocument, onCreateArticle }: Props) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<DocumentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const term = query.trim();
  const canCreate = !loading && !error && items.length === 0;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setItems([]);
    setTotal(0);
    setActiveIndex(0);
    setError("");
    const frame = window.requestAnimationFrame(() => input.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open || !term) {
      setItems([]);
      setTotal(0);
      setLoading(false);
      setError("");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setItems([]);
    setTotal(0);
    setActiveIndex(0);
    const timer = window.setTimeout(() => {
      void api.listDocuments({ q: term, scope: "all", sort: "updated", page: 1 }, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setItems(result.items.slice(0, 7));
          setTotal(result.total);
          setActiveIndex(0);
          setLoading(false);
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted) return;
          setError(reason instanceof Error ? reason.message : "搜索失败，请稍后重试。");
          setLoading(false);
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, term]);

  async function createArticle() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (await onCreateArticle(term)) onClose();
      else {
        setError("尚未创建文章；未保存内容和当前输入都已保留，可继续搜索或重试。");
        window.requestAnimationFrame(() => input.current?.focus());
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建文章，请稍后重试。");
      window.requestAnimationFrame(() => input.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  async function openDocument(item: DocumentSummary) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (await onOpenDocument(item.id)) onClose();
      else window.requestAnimationFrame(() => input.current?.focus());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法打开资料，请稍后重试。");
      window.requestAnimationFrame(() => input.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (loading) return;
      const count = items.length || Number(canCreate);
      if (!count) return;
      event.preventDefault();
      setActiveIndex((current) => (current + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) void createArticle();
      else if (loading) return;
      else if (items[activeIndex]) void openDocument(items[activeIndex]!);
      else if (canCreate) void createArticle();
    }
  }

  const createOptionId = `${id}-create`;
  const activeDescendant = items.length
    ? `${id}-result-${activeIndex}`
    : canCreate ? createOptionId : undefined;

  return <Modal open={open} title="快捷搜索与新建" onClose={onClose} panel={false} className="quick-actions-backdrop">
    <section className="quick-actions-panel" aria-label="快捷搜索与新建文章">
      <header className="quick-actions-header">
        <WorkspaceIcon name="quickSearch" size={23} />
        <input
          ref={input}
          role="combobox"
          aria-label="搜索资料或输入文章标题"
          aria-autocomplete="list"
          aria-expanded={loading || Boolean(items.length) || canCreate}
          aria-controls={loading || error || (!items.length && !canCreate) ? undefined : `${id}-results`}
          aria-activedescendant={activeDescendant}
          autoComplete="off"
          maxLength={200}
          placeholder="搜索资料，或输入文章标题…"
          value={query}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            setQuery(value);
            if (value.trim() === term) return;
            setItems([]);
            setTotal(0);
            setActiveIndex(0);
            setLoading(Boolean(value.trim()));
            setError("");
          }}
          onKeyDown={handleKeyDown}
        />
        <button type="button" aria-label="关闭快捷面板" onClick={onClose}><WorkspaceIcon name="close" size={19} /></button>
      </header>

      <div className="quick-actions-results" aria-busy={loading}>
        {loading && <div className="quick-actions-skeleton" role="status" aria-label="正在搜索资料"><i /><i /><i /></div>}
        {!loading && error && <p className="quick-actions-message" role="alert">{error}</p>}
        {!loading && !error && items.length > 0 && <div id={`${id}-results`} role="listbox" aria-label="资料搜索结果">{items.map((item, index) => <button
          type="button"
          role="option"
          id={`${id}-result-${index}`}
          aria-selected={activeIndex === index}
          className="quick-actions-result"
          key={item.id}
          disabled={busy}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => void openDocument(item)}
        >
          <WorkspaceIcon name={item.kind === "paper" ? "paper" : "document"} size={19} />
          <span className="quick-actions-result-copy">
            <strong>{item.title || "未命名资料"}</strong>
            <small>{item.searchMatches?.[0] || (item.kind === "paper" ? "论文 · 标题匹配" : "文章 · 标题匹配")}</small>
          </span>
          <span className="quick-actions-result-kind">{item.kind === "paper" ? "论文" : "文章"}</span>
        </button>)}</div>}
        {!loading && !error && items.length > 0 && <>
          {total > items.length && <p className="quick-actions-more">还有 {total - items.length} 篇匹配资料</p>}
          <p className="quick-actions-more">按 ⇧ Enter 用“{term}”创建新文章</p>
        </>}
        {!loading && !error && canCreate && <div id={`${id}-results`} role="listbox" aria-label="快捷操作"><button
          type="button"
          role="option"
          id={createOptionId}
          aria-selected={activeIndex === 0}
          className="quick-actions-create"
          disabled={busy}
          onClick={() => void createArticle()}
        >
          <span className="quick-actions-create-mark"><WorkspaceIcon name="plus" size={18} /></span>
          <span><strong>{term ? `新建文章“${term}”` : "新建空白文章"}</strong><small>{term ? "按回车创建并开始编辑" : "输入标题后按 ⇧ Enter 创建"}</small></span>
          {term && <kbd>↵</kbd>}
        </button></div>}
      </div>

      <footer className="quick-actions-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> 导航</span>
        <span><kbd>↵</kbd> {items.length ? "打开" : canCreate ? "创建" : "打开"}</span>
        <span><kbd>⇧ ↵</kbd> 创建文章</span>
        <span><kbd>esc</kbd> 退出</span>
      </footer>
    </section>
  </Modal>;
}
