import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "./ui/Controls";
import { WorkspaceIcon } from "./ui/WorkspaceIcon";

export interface OpenDocumentTab { id: string; title: string }

export function DocumentTabs({ documents, selectedId, dirty, disabled, onSelect, onClose, toolsOpen, onToggleTools }: {
  documents: OpenDocumentTab[];
  selectedId: string | null;
  dirty: boolean;
  disabled: boolean;
  onSelect: (id: string) => Promise<boolean>;
  onClose: (id: string) => Promise<void>;
  toolsOpen: boolean;
  onToggleTools: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(Infinity);
  const [evicting, setEvicting] = useState(false);
  const attempted = useRef("");
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setCapacity(Math.max(1, Math.floor(entry.contentRect.width / 120)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (disabled) { attempted.current = ""; return; }
    if (evicting || documents.length <= capacity) return;
    const oldest = documents.find((document) => !(dirty && document.id === selectedId));
    if (!oldest) return;
    const signature = `${capacity}:${documents.map((document) => document.id).join(",")}:${dirty}`;
    if (attempted.current === signature) return;
    attempted.current = signature;
    setEvicting(true);
    void onClose(oldest.id).finally(() => setEvicting(false));
  }, [documents, capacity, dirty, selectedId, disabled, evicting, onClose]);
  return <div className="document-tabbar">
    <div ref={list} className="document-tabs" role="navigation" aria-label="已打开的文章">
      {documents.map((document, index) => <div key={document.id} className={`document-tab ${selectedId === document.id ? "is-active" : ""}`}>
        <Button type="button" className="document-tab-select" aria-pressed={selectedId === document.id} aria-controls="reader-panel" disabled={disabled} title={document.title} tabIndex={selectedId === document.id || (!selectedId && index === 0) ? 0 : -1} onClick={() => void onSelect(document.id)} onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? documents.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + documents.length) % documents.length;
          void onSelect(documents[next].id).then((selected) => { if (selected || documents[next].id === selectedId) list.current?.querySelectorAll<HTMLButtonElement>('.document-tab-select')[next]?.focus(); });
        }}><WorkspaceIcon name="document" size={17} /><span>{document.title || "未命名织片"}</span>{selectedId === document.id && dirty && <i className="tab-dirty" aria-label="有未保存修改" />}</Button>
        <IconButton label={`关闭文章：${document.title || "未命名织片"}`} disabled={disabled} onClick={(event) => { const button = event.currentTarget; void onClose(document.id).then(() => window.requestAnimationFrame(() => { if (!button.isConnected) { const target = list.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? globalThis.document.querySelector<HTMLInputElement>('#library-panel input'); target?.focus(); } })); }}><WorkspaceIcon name="close" size={14} /></IconButton>
      </div>)}
    </div>
    <IconButton label={toolsOpen ? "收起侧栏" : "展开侧栏"} aria-expanded={toolsOpen} aria-controls={toolsOpen ? "document-tools" : undefined} onClick={onToggleTools}><WorkspaceIcon name="panelRight" size={19} /></IconButton>
  </div>;
}
