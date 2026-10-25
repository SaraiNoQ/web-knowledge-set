import { Component, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api as coreApi, readerDataApi, streamSelectionTranslation } from "../api";
import { READER_SELECTION_MAX_CHARS, type ReaderSelection } from "../../shared/reader-tools";
import { builtinReaderTools, readerTools, readerToolStorage, type ReaderToolApi, type ReaderToolManifest } from "./runtime";
import { captureReaderSelection } from "./selection";
import { Button, IconButton } from "../components/ui/Controls";
import { useToast } from "../components/ui/Feedback";

export class ReaderToolBoundary extends Component<{ children: ReactNode; onClose?: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div role="alert"><p>工具遇到问题，正文仍可继续阅读。</p><Button onClick={this.props.onClose}>关闭工具</Button></div> : this.props.children; }
}

function FloatingTool({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null), opener = useRef(document.activeElement);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => {
    const position = () => { const node = panel.current; if (!node) return; const rect = node.getBoundingClientRect(); node.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - rect.width - 8))}px`; node.style.top = `${Math.max(8, Math.min(rect.top, innerHeight - rect.height - 8))}px`; };
    position(); window.addEventListener("resize", position);
    panel.current?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position); if (panel.current) observer.observe(panel.current);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector("dialog[open]")) { event.preventDefault(); event.stopImmediatePropagation(); onClose(); } };
    document.addEventListener("keydown", escape, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); document.removeEventListener("keydown", escape, true); if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus({ preventScroll: true }); };
  }, [onClose]);
  return <div className="reader-tool-float" ref={panel} role="dialog" aria-modal="false" aria-label={title} style={{ left: Math.max(8, innerWidth - 420), top: 104 }}>
    <header onPointerDown={(event) => { if ((event.target as Element).closest("button")) return; const rect = panel.current!.getBoundingClientRect(); drag.current = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => {
      const start = drag.current, node = panel.current; if (!start || !node) return;
      node.style.left = `${Math.max(8, Math.min(innerWidth - node.offsetWidth - 8, start.left + event.clientX - start.x))}px`;
      node.style.top = `${Math.max(8, Math.min(innerHeight - node.offsetHeight - 8, start.top + event.clientY - start.y))}px`;
    }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}><h2 tabIndex={-1}>{title}</h2><IconButton label="关闭阅读工具" onClick={onClose}>×</IconButton></header>
    <div className="reader-tool-float-body">{children}</div>
  </div>;
}

export function ReaderToolsHost() {
  const state = useSyncExternalStore(readerTools.subscribe, readerTools.getSnapshot);
  const toast = useToast();
  const [modal, setModal] = useState(false);
  const active = useRef(new Map<string, { controller: AbortController; retry: number }>());
  useEffect(() => {
    const update = () => setModal(Boolean(document.querySelector("dialog[open]")));
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.type === "attributes" || [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && (node.matches("dialog") || node.querySelector("dialog"))))) update();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] }); update();
    document.addEventListener("pointerup", captureReaderSelection);
    document.addEventListener("keyup", captureReaderSelection);
    const scroll = () => { if (!readerTools.getSnapshot().overlay) readerTools.setSelection(null); };
    document.addEventListener("scroll", scroll, true);
    return () => { observer.disconnect(); document.removeEventListener("pointerup", captureReaderSelection); document.removeEventListener("keyup", captureReaderSelection); document.removeEventListener("scroll", scroll, true); };
  }, []);
  useEffect(() => {
    for (const [id, value] of active.current) if (!state.enabled.includes(id) || value.retry !== (state.retries[id] ?? 0)) { value.controller.abort(); active.current.delete(id); readerTools.unregister(id); }
    for (const item of builtinReaderTools) {
      const id = item.manifest.id;
      if (!state.enabled.includes(id) || active.current.has(id)) continue;
      const controller = new AbortController(); active.current.set(id, { controller, retry: state.retries[id] ?? 0 });
      const permit = (permission: ReaderToolManifest["permissions"][number]) => { if (!item.manifest.permissions.includes(permission)) throw new Error("工具未声明所需权限。"); controller.signal.throwIfAborted(); };
      const valid = (selection: ReaderSelection) => {
        controller.signal.throwIfAborted();
        const current = readerTools.getSnapshot();
        if (!current.context || current.context.id !== selection.documentId || current.context.revision !== selection.revision || current.context.blockedReason || JSON.stringify(current.selection?.anchor) !== JSON.stringify(selection.anchor)) throw new Error(current.context?.blockedReason || "文档或选区已变化，请重新选择文字。");
      };
      const storage = readerToolStorage(id);
      const toolApi: ReaderToolApi = {
        selection: () => { permit("selection.read"); return readerTools.getSnapshot().selection; },
        storage: { get: (key, fallback) => { permit("storage.own"); return storage.get(key, fallback); }, set: (key, value) => { permit("storage.own"); storage.set(key, value); } },
        close: readerTools.close,
        async saveExcerpt(selection, translation, note) { permit("annotations.create"); valid(selection); await readerDataApi.annotate(selection.documentId, selection.revision, selection.anchor, note, translation); window.dispatchEvent(new Event("zhiye:reading-data-changed")); },
        async translate(selection, language, onText, signal) {
          permit("translation.request"); valid(selection);
          if (selection.anchor.quote.length > READER_SELECTION_MAX_CHARS) throw new Error(`每次最多翻译 ${READER_SELECTION_MAX_CHARS} 个字符，请缩短选区。`);
          const requestSignal = AbortSignal.any([signal, controller.signal]);
          const settings = await coreApi.getLlmSettings(requestSignal);
          if (!settings.enabled) throw new Error("请先在智能设置中启用 AI。");
          valid(selection); requestSignal.throwIfAborted();
          await streamSelectionTranslation(selection.documentId, { text: selection.anchor.quote, revision: selection.revision, language, settingsRevision: settings.revision }, (text) => { valid(selection); requestSignal.throwIfAborted(); onText(text); }, requestSignal);
        },
      };
      void item.load().then((module) => {
        if (controller.signal.aborted) return;
        if (module.manifest.id !== id || module.manifest.hostApiVersion !== 1 || module.manifest.permissions.some((permission) => !item.manifest.permissions.includes(permission))) throw new Error("Incompatible reader tool");
        readerTools.register(id, module, toolApi);
      }).catch(() => { if (!controller.signal.aborted) readerTools.fail(id); });
    }
  }, [state.enabled, state.retries]);
  useEffect(() => () => { for (const value of active.current.values()) value.controller.abort(); active.current.clear(); for (const item of builtinReaderTools) readerTools.unregister(item.manifest.id); readerTools.setContext(null); }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]") || !readerTools.getSnapshot().context) return;
      for (const [id, tool] of Object.entries(state.tools)) {
        const command = tool.module.command;
        if (command.key && event.key.toLowerCase() === command.key && Boolean(event.altKey) === Boolean(command.altKey) && !event.ctrlKey && !event.metaKey) { event.preventDefault(); readerTools.open(id); return; }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [state.tools]);
  const selection = state.selection, tool = state.overlay ? state.tools[state.overlay] : null;
  const ribbon = selection && state.context && !state.context.blockedReason && !state.overlay && !modal ? <div className="reader-selection-actions" role="toolbar" aria-label="选区操作" style={{ left: Math.max(8, Math.min(selection.rect.left, innerWidth - 230)), top: Math.max(8, Math.min(innerHeight - 50, selection.rect.top + selection.rect.height + 8)) }} onPointerDown={(event) => event.preventDefault()}>
    <Button onClick={() => void readerDataApi.annotate(selection.documentId, selection.revision, selection.anchor).then(() => { toast.success("摘录已保存。"); window.dispatchEvent(new Event("zhiye:reading-data-changed")); }, (cause) => toast.error((cause as Error).message))}>保存摘录</Button>
    {Object.entries(state.tools).map(([id, entry]) => <Button key={id} onClick={() => readerTools.open(id)}>{entry.module.selectionAction.title}</Button>)}
  </div> : null;
  return createPortal(<div className="reader-overlay-host" style={{ visibility: modal ? "hidden" : undefined }}>{ribbon}{tool && state.context && <FloatingTool key={`${state.overlay}:${state.context.id}:${state.context.revision}`} title={tool.module.manifest.name} onClose={readerTools.close}><ReaderToolBoundary onClose={readerTools.close}><tool.module.Overlay api={tool.api} selection={selection} /></ReaderToolBoundary></FloatingTool>}</div>, document.body);
}
