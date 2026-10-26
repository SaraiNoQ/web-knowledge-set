import type { ComponentType } from "react";
import type { ReaderSelection, SourceAnchor, TranslationGlossaryEntry } from "../../shared/reader-tools";
import type { TranslationLanguage } from "../../shared/types";
import type { QuestionCitation } from "../../shared/study-types";
import { createReaderToolStorage, type ToolStorageMigrations, type ToolStorageBackend } from "./tool-storage";

export interface ReaderContext { id: string; title: string; revision: number; kind: "article" | "paper"; folderId: string | null; blockedReason: string | null; }
export interface ReaderToolManifest {
  id: string; name: string; version: string; hostApiVersion: 1;
  storageVersion?: number;
  permissions: Array<"selection.read" | "translation.request" | "storage.own" | "annotations.create">;
}
export interface ReaderToolCapabilities {
  platform: "local" | "cloud" | "desktop";
  hostApiVersion: 1;
  permissions: ReaderToolManifest["permissions"];
  maxSelectionCharacters: number;
  storageSchemaVersion: number;
  storageQuotaBytes: number;
  translationCache: { entries: number; bytes: number; ttlMs: number };
}
export interface ReaderTranslationOptions { glossary?: TranslationGlossaryEntry[]; glossaryRevision?: number }
export interface ReaderToolApi {
  selection(): ReaderSelection | null;
  capabilities(): Promise<ReaderToolCapabilities>;
  translate(selection: ReaderSelection, language: TranslationLanguage, onText: (text: string) => void, signal: AbortSignal, options?: ReaderTranslationOptions): Promise<void>;
  storage: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void; subscribe(listener: () => void): () => void };
  saveExcerpt(selection: ReaderSelection, translation: string, note: string): Promise<void>;
  close(): void;
}
export interface ReaderToolViewProps { api: ReaderToolApi; selection: ReaderSelection | null; active?: boolean; }
export interface ReaderToolModule {
  manifest: ReaderToolManifest;
  storageMigrations?: ToolStorageMigrations;
  command: { id: string; title: string; key?: string; altKey?: boolean };
  selectionAction: { title: string };
  Overlay: ComponentType<ReaderToolViewProps>;
  Panel: ComponentType<ReaderToolViewProps>;
}
export const builtinReaderTools = [{ manifest: { id: "translation", name: "划词翻译", version: "1.0.0", hostApiVersion: 1, storageVersion: 1,
  permissions: ["selection.read", "translation.request", "storage.own", "annotations.create"] } satisfies ReaderToolManifest,
  load: () => import("./translation").then((module) => module.translationTool) }];

interface Snapshot {
  contextVersion: number;
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
let snapshot: Snapshot = { contextVersion: 0, context: null, selection: null, enabled: initial, overlay: null, tools: {}, errors: {}, retries: {} };
const listeners = new Set<() => void>();
const publish = (change: Partial<Snapshot>) => { snapshot = { ...snapshot, ...change }; for (const listener of listeners) listener(); };
let actions: {openDocument:(id:string)=>void;locateEditor:(anchor:SourceAnchor)=>boolean;openEvidence?:(citation:QuestionCitation)=>void} = { openDocument: (_id: string) => {}, locateEditor: (_anchor: SourceAnchor) => false };
export const readerTools = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => snapshot,
  setContext(context: ReaderContext | null) {
    if (JSON.stringify(snapshot.context) === JSON.stringify(context)) return;
    publish({ contextVersion: snapshot.contextVersion + 1, context, selection: null, overlay: null });
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
    localStorage.setItem("zhiye.reader-tools.enabled", JSON.stringify(ids.filter((id) => builtinReaderTools.some((item) => item.manifest.id === id))));
  },
  syncExternalEnabled(ids: string[]) {
    const enabled = [...snapshot.enabled.filter((id) => builtinReaderTools.some((item) => item.manifest.id === id)), ...ids];
    if (JSON.stringify(enabled) !== JSON.stringify(snapshot.enabled)) publish({ enabled });
  },
  open(id: string) { if (snapshot.enabled.includes(id) && snapshot.context) publish({ overlay: id }); },
  close() { if (snapshot.overlay) publish({ overlay: null }); },
  register(id: string, module: ReaderToolModule, api: ReaderToolApi) { publish({ tools: { ...snapshot.tools, [id]: { module, api } }, errors: { ...snapshot.errors, [id]: "" } }); },
  unregister(id: string) { const tools = { ...snapshot.tools }; delete tools[id]; publish({ tools, overlay: snapshot.overlay === id ? null : snapshot.overlay }); },
  fail(id: string) { publish({ errors: { ...snapshot.errors, [id]: "工具加载失败，请重试。" } }); },
  retry(id: string) { publish({ retries: { ...snapshot.retries, [id]: (snapshot.retries[id] ?? 0) + 1 } }); },
  configure(value: typeof actions) { actions = value; },
  openDocument(id: string) { actions.openDocument(id); },
  openEvidence(citation:QuestionCitation) { if(actions.openEvidence)actions.openEvidence(citation);else actions.openDocument(citation.documentId); },
  locateEditor(anchor: SourceAnchor) { return actions.locateEditor(anchor); },
};

export function readerToolStorage(id: string, schemaVersion = 1, migrations: ToolStorageMigrations = {}, backend: ToolStorageBackend = {
  get length() { return localStorage.length; }, key: (index) => localStorage.key(index), getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value), removeItem: (key) => localStorage.removeItem(key),
}): ReaderToolApi["storage"] {
  const store = createReaderToolStorage(id, backend, schemaVersion, migrations), prefix = `zhiye.reader-tool.${id}.`;
  return {
    get: store.get,
    set(key, value) { store.set(key, value); window.dispatchEvent(new CustomEvent("zhiye:reader-tool-settings", { detail: id })); },
    subscribe(listener) {
      const local = (event: Event) => { if ((event as CustomEvent<string>).detail === id) listener(); };
      const external = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(prefix)) listener(); };
      window.addEventListener("zhiye:reader-tool-settings", local); window.addEventListener("storage", external);
      return () => { window.removeEventListener("zhiye:reader-tool-settings", local); window.removeEventListener("storage", external); };
    },
  };
}
