import type { ComponentType } from "react";
import type { ReaderSelection, SourceAnchor } from "../../shared/reader-tools";
import type { TranslationLanguage } from "../../shared/types";

export interface ReaderContext { id: string; title: string; revision: number; kind: "article" | "paper"; folderId: string | null; blockedReason: string | null; }
export interface ReaderToolManifest {
  id: string; name: string; version: string; hostApiVersion: 1;
  permissions: Array<"selection.read" | "translation.request" | "storage.own" | "annotations.create">;
}
export interface ReaderToolApi {
  selection(): ReaderSelection | null;
  translate(selection: ReaderSelection, language: TranslationLanguage, onText: (text: string) => void, signal: AbortSignal): Promise<void>;
  storage: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void };
  saveExcerpt(selection: ReaderSelection, translation: string, note: string): Promise<void>;
  close(): void;
}
export interface ReaderToolViewProps { api: ReaderToolApi; selection: ReaderSelection | null; }
export interface ReaderToolModule {
  manifest: ReaderToolManifest;
  command: { id: string; title: string; key?: string; altKey?: boolean };
  selectionAction: { title: string };
  Overlay: ComponentType<ReaderToolViewProps>;
  Panel: ComponentType<ReaderToolViewProps>;
}
export const builtinReaderTools = [{ manifest: { id: "translation", name: "划词翻译", version: "1.0.0", hostApiVersion: 1,
  permissions: ["selection.read", "translation.request", "storage.own", "annotations.create"] } satisfies ReaderToolManifest,
  load: () => import("./translation").then((module) => module.translationTool) }];

interface Snapshot {
  context: ReaderContext | null;
  selection: ReaderSelection | null;
  enabled: string[];
  overlay: string | null;
  tools: Record<string, { module: ReaderToolModule; api: ReaderToolApi }>;
  errors: Record<string, string>;
  retries: Record<string, number>;
}
let initial: string[] = [];
try { initial = JSON.parse(localStorage.getItem("zhiye.reader-tools.enabled") ?? "[]").filter((id: unknown) => builtinReaderTools.some((tool) => tool.manifest.id === id)); } catch {}
let snapshot: Snapshot = { context: null, selection: null, enabled: initial, overlay: null, tools: {}, errors: {}, retries: {} };
const listeners = new Set<() => void>();
const publish = (change: Partial<Snapshot>) => { snapshot = { ...snapshot, ...change }; for (const listener of listeners) listener(); };
let actions = { openDocument: (_id: string) => {}, locateEditor: (_anchor: SourceAnchor) => false };
export const readerTools = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => snapshot,
  setContext(context: ReaderContext | null) {
    if (JSON.stringify(snapshot.context) === JSON.stringify(context)) return;
    publish({ context, selection: null, overlay: null });
  },
  setSelection(selection: ReaderSelection | null) {
    if (selection && (selection.documentId !== snapshot.context?.id || selection.revision !== snapshot.context.revision)) return;
    if (snapshot.selection?.anchor.quote === selection?.anchor.quote && snapshot.selection?.anchor.source === selection?.anchor.source &&
      snapshot.selection?.anchor.pageNumber === selection?.anchor.pageNumber && snapshot.selection?.anchor.prefix === selection?.anchor.prefix && snapshot.selection?.anchor.suffix === selection?.anchor.suffix && snapshot.selection?.anchor.blockId === selection?.anchor.blockId && JSON.stringify(snapshot.selection?.rect) === JSON.stringify(selection?.rect)) return;
    publish({ selection });
  },
  enable(id: string, enabled: boolean) {
    if (!builtinReaderTools.some((tool) => tool.manifest.id === id)) throw new Error("Unknown built-in reader tool");
    const ids = enabled ? [...new Set([...snapshot.enabled, id])] : snapshot.enabled.filter((item) => item !== id);
    publish({ enabled: ids, overlay: snapshot.overlay === id && !enabled ? null : snapshot.overlay });
    localStorage.setItem("zhiye.reader-tools.enabled", JSON.stringify(ids));
  },
  open(id: string) { if (snapshot.enabled.includes(id) && snapshot.context) publish({ overlay: id }); },
  close() { if (snapshot.overlay) publish({ overlay: null }); },
  register(id: string, module: ReaderToolModule, api: ReaderToolApi) { publish({ tools: { ...snapshot.tools, [id]: { module, api } }, errors: { ...snapshot.errors, [id]: "" } }); },
  unregister(id: string) { const tools = { ...snapshot.tools }; delete tools[id]; publish({ tools, overlay: snapshot.overlay === id ? null : snapshot.overlay }); },
  fail(id: string) { publish({ errors: { ...snapshot.errors, [id]: "工具加载失败，请重试。" } }); },
  retry(id: string) { publish({ retries: { ...snapshot.retries, [id]: (snapshot.retries[id] ?? 0) + 1 } }); },
  configure(value: typeof actions) { actions = value; },
  openDocument(id: string) { actions.openDocument(id); },
  locateEditor(anchor: SourceAnchor) { return actions.locateEditor(anchor); },
};

export function readerToolStorage(id: string): ReaderToolApi["storage"] {
  const prefix = `zhiye.reader-tool.${id}.`;
  return {
    get<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(prefix + key) ?? "null") ?? fallback; } catch { return fallback; } },
    set(key, value) { const text = JSON.stringify(value); if (text.length > 16_384 || key.length > 100) throw new Error("工具设置过大。"); localStorage.setItem(prefix + key, text); },
  };
}
