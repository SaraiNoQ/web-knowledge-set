import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { markdownOutline } from "../markdown-outline";
import { WorkspaceIcon } from "./ui/WorkspaceIcon";
import { IconButton } from "./ui/Controls";

export function DocumentOutline({ markdown, onNavigate, onClose }: { markdown: string; onNavigate: (offset: number) => void; onClose: () => void }) {
  const deferred = useDeferredValue(markdown);
  const headings = useMemo(() => markdownOutline(deferred), [deferred]);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => { setCollapsed(new Set()); setActive(null); }, [deferred]);
  return <aside id="document-tools" className="document-tools" aria-label="右侧功能区">
    <header><h2>大纲</h2><IconButton label="收起大纲" onClick={onClose}><WorkspaceIcon name="close" size={17} /></IconButton></header>
    {headings.length ? <nav aria-label="Markdown 大纲"><ul>{headings.map((heading, index) => {
      if (heading.ancestors.some((offset) => collapsed.has(offset))) return null;
      const hasChildren = headings[index + 1]?.depth > heading.depth;
      return <li key={heading.offset} style={{ paddingLeft: `${heading.ancestors.length * 14}px` }}>
        {hasChildren ? <button type="button" className="outline-fold" aria-label={`${collapsed.has(heading.offset) ? "展开" : "折叠"} ${heading.title}`} aria-expanded={!collapsed.has(heading.offset)} onClick={() => setCollapsed((previous) => { const next = new Set(previous); if (next.has(heading.offset)) next.delete(heading.offset); else next.add(heading.offset); return next; })}><WorkspaceIcon name="chevron" size={13} /></button> : <span className="outline-fold-space" />}
        <button type="button" className="outline-heading" aria-current={active === heading.offset ? "location" : undefined} title={heading.title} onClick={() => { setActive(heading.offset); onNavigate(heading.offset); }}>{heading.title}</button>
      </li>;
    })}</ul></nav> : <p className="outline-empty">当前文档没有 Markdown 标题。</p>}
  </aside>;
}
