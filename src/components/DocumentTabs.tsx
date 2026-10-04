import { useEffect, useRef } from "react";
import { IconButton } from "./ui/Controls";
import { WorkspaceIcon } from "./ui/WorkspaceIcon";

export interface OpenDocumentTab { id: string; title: string }

export function DocumentTabs({ documents, selectedId, dirty, disabled, onSelect, onClose, onCreate }: {
  documents: OpenDocumentTab[];
  selectedId: string | null;
  dirty: boolean;
  disabled: boolean;
  onSelect: (id: string) => Promise<boolean>;
  onClose: (id: string) => Promise<void>;
  onCreate: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId, documents.length]);
  return <div className="document-tabbar">
    <div ref={list} className="document-tabs" role="navigation" aria-label="已打开的文章">
      {documents.map((document, index) => <div key={document.id} className={`document-tab ${selectedId === document.id ? "is-active" : ""}`}>
        <button type="button" className="document-tab-select" aria-pressed={selectedId === document.id} aria-controls="reader-panel" disabled={disabled} title={document.title} tabIndex={selectedId === document.id || (!selectedId && index === 0) ? 0 : -1} onClick={() => void onSelect(document.id)} onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? documents.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + documents.length) % documents.length;
          void onSelect(documents[next].id).then((selected) => { if (selected || documents[next].id === selectedId) list.current?.querySelectorAll<HTMLButtonElement>('.document-tab-select')[next]?.focus(); });
        }}><WorkspaceIcon name="document" size={17} /><span>{document.title || "未命名网页"}</span>{selectedId === document.id && dirty && <i className="tab-dirty" aria-label="有未保存修改" />}</button>
        <IconButton label={`关闭文章：${document.title || "未命名网页"}`} disabled={disabled} onClick={(event) => { const button = event.currentTarget; void onClose(document.id).then(() => window.requestAnimationFrame(() => { if (!button.isConnected) { const target = list.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? globalThis.document.querySelector<HTMLInputElement>('#library-panel input'); target?.focus(); } })); }}><WorkspaceIcon name="close" size={14} /></IconButton>
      </div>)}
    </div>
    <IconButton label="新建文章标签" disabled={disabled} onClick={onCreate}><WorkspaceIcon name="plus" size={19} /></IconButton>
  </div>;
}
