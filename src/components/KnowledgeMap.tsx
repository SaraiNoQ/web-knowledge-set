import { SegmentedControl } from "./ui/SegmentedControl";
import { Button, Checkbox, Input, Range, Select } from "./ui/Controls";
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import ForceGraph2D from "react-force-graph-2d";

import type { SemanticGraphResult } from "../../shared/semantic-graph";
import { SEMANTIC_GRAPH_MAX_NODES, semanticVectorKey } from "../../shared/semantic-graph";
import type { KnowledgeMapNode, LibraryItemKind, SemanticVectorEntry } from "../../shared/types";
import { api, readerDataApi, type ReaderDataSnapshot } from "../api";
import { studyApi } from "../study/api";
import { readerTools } from "../reader-tools/runtime";
import type { RelatedResult, RelationType } from "../../shared/related";
import type { Map3DHandle, Map3DState } from "./KnowledgeMap3D";

const KnowledgeMap3D = lazy(() => import("./KnowledgeMap3D"));

class Map3DBoundary extends Component<{ children: ReactNode; onUnavailable: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onUnavailable(); }
  render() { return this.state.failed ? null : this.props.children; }
}

interface Props {
  active: boolean;
  cloud: boolean;
  libraryView: "all" | "favorites" | "paper";
  refreshKey: number;
  query: string;
  onQueryChange: (value: string) => void;
  onOpenDocument: (id: string) => void;
}

type MapItem = KnowledgeMapNode & { type: "document"; color: string };
type FolderItem = { id: string; folderId: string; name: string; count: number; type: "folder"; color: string };
export type MapNode = (MapItem | FolderItem) & { x?: number; y?: number; vx?: number; vy?: number };
export type MapLink = { source: string; target: string; type: Exclude<RelationType, "semantic"> } | { source: string; target: string; type: "semantic"; score: number };
const RELATION_LABELS: Record<RelationType, string> = { folder: "分组归属", manual: "人工关联", semantic: "内容相近", tag: "共同标签", citation: "引用", lexical: "词项匹配" };
type ForceStrength = number | ((value: unknown, index: number, values: unknown[]) => number);
type D3Force = ((alpha: number) => void) & {
  strength?: {
    (): ForceStrength;
    (value: ForceStrength): unknown;
  };
  distanceMax?: {
    (): number;
    (value: number): unknown;
  };
};
type GraphMethods = {
  centerAt: { (): { x: number; y: number }; (x: number, y: number, duration?: number): void };
  zoom: { (): number; (value: number, duration?: number): void };
  zoomToFit: (duration?: number, padding?: number) => void;
  pauseAnimation: () => void;
  resumeAnimation: () => void;
  d3Force: {
    (name: string): D3Force | undefined;
    (name: string, force: D3Force | null): unknown;
  };
  d3ReheatSimulation: () => unknown;
};
type SemanticVectorVersion = { id: string; sourceHash: string | null; model: string | null; formatVersion: string | null };
type SemanticGraphWorkerMessage = { requestId: number; graphKey?: string; result?: SemanticGraphResult; error?: string };
const EMPTY_SEMANTIC_GRAPH: SemanticGraphResult = { edges: [], neighbors: {} };
const MAP_VISIBLE_DOCUMENTS = 1_000;
const MAP_LIST_PAGE_SIZE = 50;

const folderColors = ["#9e493d", "#687c59", "#637d93", "#a77d46", "#816b91", "#47827e", "#ae674a"];

function folderColor(id: string) {
  const sum = [...id].reduce((value, char) => value + char.charCodeAt(0), 0);
  return folderColors[sum % folderColors.length]!;
}

function statusLabel(node: KnowledgeMapNode) {
  const labels: Record<string, string> = node.kind === "paper"
    ? { queued: "待处理", extracting: "提取中", ready: "可阅读", failed: "提取失败" }
    : { queued: "排队中", fetching: "读取中", extracting: "提取中", ready: "可阅读", failed: "读取失败" };
  return labels[node.status] || "状态未知";
}

function semanticStateLabel(node: KnowledgeMapNode) {
  if (node.semanticState === "unavailable") return "未启用";
  if (node.kind === "paper" && node.status !== "ready") return "等待提取";
  return ({ unavailable: "未启用", pending: "待建立", indexing: "处理中", ready: "已建立", failed: "处理失败" })[node.semanticState];
}

function shortTitle(value: string) {
  const title = value.trim() || "未命名资料";
  return title.length > 28 ? title.slice(0, 27) + "…" : title;
}

function sameVectorVersion(left: SemanticVectorVersion | SemanticVectorEntry, right: SemanticVectorVersion | SemanticVectorEntry) {
  return left.id === right.id && left.sourceHash === right.sourceHash && left.model === right.model && left.formatVersion === right.formatVersion;
}

function appendedVectors(previous: SemanticVectorEntry[], current: SemanticVectorEntry[]) {
  if (!previous.length || current.length <= previous.length) return null;
  const currentById = new Map(current.map((entry) => [entry.id, entry]));
  if (previous.some((entry) => {
    const currentEntry = currentById.get(entry.id);
    return !currentEntry || !sameVectorVersion(entry, currentEntry);
  })) return null;
  const previousIds = new Set(previous.map(({ id }) => id));
  return current.filter(({ id }) => !previousIds.has(id));
}

export function KnowledgeMap({ active, cloud, libraryView, query, onQueryChange, onOpenDocument, refreshKey }: Props) {
  const labelFont = useMemo(() => getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim() || "sans-serif", []);
  const [darkTheme, setDarkTheme] = useState(() => document.documentElement.dataset.theme === "dark");
  useEffect(() => {
    const updateTheme = () => setDarkTheme(document.documentElement.dataset.theme === "dark");
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const [items, setItems] = useState<KnowledgeMapNode[]>([]);
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [total, setTotal] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  const [mapLoadRevision, setMapLoadRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<LibraryItemKind | "">(libraryView === "paper" ? "paper" : "");
  const [folderId, setFolderId] = useState("");
  const [includeArchived, setIncludeArchived] = useState(true);
  const [showFolders, setShowFolders] = useState(true);
  const [relationTypes, setRelationTypes] = useState<Record<RelationType, boolean>>({ folder: true, manual: true, semantic: true, tag: true, citation: true, lexical: true });
  const enabledRelationTypes = useMemo(() => (Object.keys(RELATION_LABELS) as RelationType[]).filter((type) => relationTypes[type]), [relationTypes]);
  const [localMode, setLocalMode] = useState(false);
  const [focusedGroup, setFocusedGroup] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [listPage, setListPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manualData, setManualData] = useState<{ id: string; data?: ReaderDataSnapshot; error?: string } | null>(null);
  const [relatedData, setRelatedData] = useState<{ id: string; key: string; data?: RelatedResult; error?: string } | null>(null);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const relatedRequest = useRef<AbortController | null>(null);
  const relatedQueryKey = JSON.stringify([selectedId, enabledRelationTypes, mapLoadRevision]);
  const relatedScope = useRef({ key: relatedQueryKey, active });
  relatedScope.current = { key: relatedQueryKey, active };
  const [semanticVectors, setSemanticVectors] = useState<SemanticVectorEntry[]>([]);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState("");
  const [semanticGraph, setSemanticGraph] = useState(EMPTY_SEMANTIC_GRAPH);
  const [semanticThreshold, setSemanticThreshold] = useState(0.6);
  const [paused, setPaused] = useState(false);
  const [dimension, setDimension] = useState<"2d" | "3d">("2d");
  const [renderError, setRenderError] = useState("");
  const visibleLabels = useRef(new Set<string>());
  const [draggingNode, setDraggingNode] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const graph = useRef<GraphMethods | null>(null);
  const canvases2D = useRef(new Set<HTMLCanvasElement>());
  const graph3D = useRef<Map3DHandle | null>(null);
  const saved2DView = useRef<{ center: { x: number; y: number }; zoom: number } | null>(null);
  const state3D = useRef<Map3DState>({ positions: new Map(), camera: null, overview: null, scope: "all", layoutKey: "" });
  const captureGraph = useCallback((instance: GraphMethods | null) => {
    if (!instance && graph.current) {
      saved2DView.current = { center: graph.current.centerAt(), zoom: graph.current.zoom() };
      graph.current.pauseAnimation();
      for (const canvas of canvases2D.current) canvas.width = canvas.height = 0;
      canvases2D.current.clear();
    }
    graph.current = instance;
    if (instance && saved2DView.current) {
      instance.centerAt(saved2DView.current.center.x, saved2DView.current.center.y);
      instance.zoom(saved2DView.current.zoom);
    }
  }, []);
  const unavailable3D = useCallback(() => {
    setDimension("2d");
    setRenderError("3D 暂不可用，已返回 2D；筛选和选中资料已保留。");
  }, []);
  const mapLoading = useRef(false);
  const metadataKey = useRef("");
  const nodeCache = useRef(new Map<string, MapNode>());
  const overview = useRef<{ center: { x: number; y: number }; zoom: number; positions: Map<string, { x?: number; y?: number }> } | null>(null);
  const restoreOverview = useRef(false);
  const fitFocusedScope = useRef(false);
  const draggingNodeRef = useRef(false);
  const dragForceSnapshot = useRef<{
    linkStrength?: ForceStrength;
    chargeStrength?: ForceStrength;
    chargeDistanceMax?: number;
    centerForce?: D3Force;
  } | null>(null);
  const graphWorker = useRef<Worker | null>(null);
  const workerPending = useRef(false);
  const graphRequestId = useRef(0);
  const latestGraphRequestId = useRef(0);
  const latestGraphKey = useRef("");
  const postedVectors = useRef<SemanticVectorEntry[]>([]);
  const semanticVectorsRef = useRef(semanticVectors);
  semanticVectorsRef.current = semanticVectors;
  const vectorCache = useRef(new Map<string, SemanticVectorEntry>());
  const [semanticGraphKey, setSemanticGraphKey] = useState("");
  const filters = useRef({ kind, folderId, includeArchived, query });
  filters.current = { kind, folderId, includeArchived, query };

  useEffect(() => {
    if (libraryView === "paper") setKind("paper");
    else if (libraryView === "all") setKind("");
  }, [libraryView]);

  useEffect(() => {
    if (cloud) setIncludeArchived(false);
  }, [cloud]);

  const observeHost = useCallback((node: HTMLDivElement | null) => {
    resizeObserver.current?.disconnect();
    host.current = node;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.floor(entry.contentRect.width));
      setHeight(Math.floor(entry.contentRect.height));
    });
    resizeObserver.current = observer;
    observer.observe(node);
    setWidth(Math.floor(node.getBoundingClientRect().width));
    setHeight(Math.floor(node.getBoundingClientRect().height));
  }, []);

  useEffect(() => () => resizeObserver.current?.disconnect(), []);

  const loadMap = useCallback(async (signal: AbortSignal) => {
    mapLoading.current = true;
    setLoading(true);
    setError("");
    try {
      const current = filters.current;
      const values: KnowledgeMapNode[] = [];
      let cursor: string | undefined;
      let resultFolders: Array<{ id: string; name: string }> = [];
      let expectedTotal = 0;
      do {
        const page = await api.listKnowledgeMap({
          cursor, q: current.query, kind: current.kind || undefined,
          folderId: current.folderId || undefined,
          includeArchived: !cloud && current.includeArchived,
        }, signal);
        if (signal.aborted) return;
        values.push(...page.items);
        resultFolders = page.folders;
        expectedTotal = page.total;
        cursor = page.nextCursor ?? undefined;
        setTotal(expectedTotal);
      } while (cursor && !signal.aborted);
      if (!signal.aborted && values.length !== expectedTotal) throw new Error("资料地图分页不完整，请重试。");
      const key = JSON.stringify([values, resultFolders]);
      if (!signal.aborted && key !== metadataKey.current) {
        metadataKey.current = key;
        setItems(values);
        setFolders(resultFolders);
      }
    } catch (cause) {
      if (!signal.aborted) setError((cause as Error).message || "无法载入知识地图");
    } finally {
      if (!signal.aborted) {
        mapLoading.current = false;
        setLoading(false);
        setMapLoadRevision((value) => value + 1);
      }
    }
  }, [cloud]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadMap(controller.signal), query.trim() ? 180 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [active, kind, folderId, includeArchived, query, loadMap, refreshKey, retryCount]);

  useEffect(() => {
    setFocusedGroup(null);
    setLocalMode(false);
    overview.current = null;
    restoreOverview.current = false;
    fitFocusedScope.current = false;
  }, [kind, folderId, includeArchived, query]);

  const semanticEnabled = items.some((item) => item.semanticState !== "unavailable");
  const readyVectorRefs = useMemo(() => items.filter((item) => item.semanticState === "ready")
    .map(({ id, semanticSourceHash, semanticModel, semanticFormatVersion }) => ({
      id, sourceHash: semanticSourceHash, model: semanticModel, formatVersion: semanticFormatVersion,
    }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0), [items]);
  const readyVectorIds = useMemo(() => readyVectorRefs.map(({ id }) => id), [readyVectorRefs]);
  const readyVectorIdsKey = semanticVectorKey(readyVectorRefs);
  const loadedVectorKey = semanticVectorKey(semanticVectors);
  const semanticVectorsCurrent = loadedVectorKey === readyVectorIdsKey;
  const semanticGraphCurrent = semanticVectorsCurrent && semanticGraphKey === loadedVectorKey;

  useEffect(() => {
    const controller = new AbortController();
    if (!active || mapLoading.current || error) return () => controller.abort();
    if (semanticEnabled && items.length > SEMANTIC_GRAPH_MAX_NODES) {
      vectorCache.current.clear();
      setSemanticVectors([]);
      setSemanticGraph(EMPTY_SEMANTIC_GRAPH);
      setSemanticGraphKey("");
      setSemanticError("");
      setSemanticLoading(false);
      return () => controller.abort();
    }
    if (!semanticEnabled || !readyVectorIds.length) {
      vectorCache.current.clear();
      setSemanticVectors([]);
      setSemanticGraph(EMPTY_SEMANTIC_GRAPH);
      setSemanticGraphKey("");
      setSemanticError("");
      setSemanticLoading(false);
      return () => controller.abort();
    }

    const expectedVersions = new Map(readyVectorRefs.map((version) => [version.id, version]));
    for (const [id, entry] of vectorCache.current) {
      const expected = expectedVersions.get(id);
      if (!expected || !sameVectorVersion(entry, expected)) vectorCache.current.delete(id);
    }
    const cached = readyVectorRefs.map(({ id }) => vectorCache.current.get(id));
    const missing = readyVectorRefs.filter((version, index) => !cached[index] || !sameVectorVersion(cached[index]!, version));
    if (!missing.length) {
      const entries = cached.filter((entry): entry is SemanticVectorEntry => Boolean(entry));
      if (semanticVectorsCurrent) return () => controller.abort();
      setSemanticVectors(entries);
      setSemanticLoading(false);
      return () => controller.abort();
    }

    setSemanticLoading(true);
    setSemanticError("");
    void (async () => {
      for (let offset = 0; offset < missing.length; offset += 100) {
        const batch = missing.slice(offset, offset + 100);
        const ids = batch.map(({ id }) => id);
        const allowed = new Set(ids);
        const batchVersions = new Map(batch.map((version) => [version.id, version]));
        const groupEntries: SemanticVectorEntry[] = [];
        let cursor: string | undefined;
        let total = 0;
        do {
          const page = await api.listKnowledgeMapVectors(cursor, controller.signal, ids);
          if (controller.signal.aborted) return;
          total = page.total;
          if (page.items.some((item) => !allowed.has(item.id) || !sameVectorVersion(item, batchVersions.get(item.id)!))) {
            throw new Error("推荐处理已更新，请重新载入地图后再查看关联。");
          }
          groupEntries.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        if (groupEntries.length !== total || groupEntries.length !== ids.length || new Set(groupEntries.map(({ id }) => id)).size !== ids.length) {
          throw new Error("部分推荐处理刚刚失效，请重新载入地图。");
        }
        for (const entry of groupEntries) vectorCache.current.set(entry.id, entry);
      }
      if (!controller.signal.aborted) {
        const entries = readyVectorRefs.map(({ id }) => vectorCache.current.get(id))
          .filter((entry): entry is SemanticVectorEntry => Boolean(entry));
        if (entries.length !== readyVectorRefs.length) throw new Error("部分推荐处理刚刚失效，请重新载入地图。");
        setSemanticVectors(entries);
      }
    })().catch((cause) => {
      if (!controller.signal.aborted) {
        setSemanticVectors([]);
        setSemanticGraph(EMPTY_SEMANTIC_GRAPH);
        setSemanticGraphKey("");
        setSemanticError((cause as Error).message || "推荐暂不可用，分组地图仍可查看。");
      }
    }).finally(() => { if (!controller.signal.aborted) setSemanticLoading(false); });
    return () => controller.abort();
  }, [active, error, items.length, mapLoadRevision, readyVectorIdsKey, semanticEnabled]);

  useEffect(() => {
    const worker = new Worker(new URL("../semantic-graph-worker.ts", import.meta.url), { type: "module" });
    graphWorker.current = worker;
    worker.onmessage = (event: MessageEvent<SemanticGraphWorkerMessage>) => {
      const message = event.data;
      if (message.requestId !== latestGraphRequestId.current) return;
      workerPending.current = false;
      if (message.error === "SEMANTIC_GRAPH_BASE_MISMATCH" ||
        (message.result && message.graphKey !== latestGraphKey.current)) {
        const vectors = semanticVectorsRef.current;
        const requestId = ++graphRequestId.current;
        const graphKey = semanticVectorKey(vectors);
        latestGraphRequestId.current = requestId;
        latestGraphKey.current = graphKey;
        postedVectors.current = vectors;
        workerPending.current = true;
        graphWorker.current?.postMessage(vectors.length ? { requestId, mode: "replace", vectors } : { requestId, mode: "reset" });
        return;
      }
      if (message.error) {
        setSemanticGraph(EMPTY_SEMANTIC_GRAPH);
        setSemanticGraphKey("");
        setSemanticError("暂时无法比较内容，分组地图仍可用。");
      } else if (message.result) {
        setSemanticGraph(message.result);
        setSemanticGraphKey(message.graphKey ?? "");
        setSemanticError("");
      }
    };
    worker.onerror = () => {
      workerPending.current = false;
      setSemanticGraph(EMPTY_SEMANTIC_GRAPH);
      setSemanticGraphKey("");
      setSemanticError("查找相近织片失败，分组地图仍可用。");
    };
    return () => {
      graphWorker.current?.terminate();
      graphWorker.current = null;
    };
  }, []);

  useEffect(() => {
    let worker = graphWorker.current;
    if (!worker) return;
    if (!active) return;
    if (!semanticVectors.length && !postedVectors.current.length) return;
    const graphKey = semanticVectorKey(semanticVectors);
    if (latestGraphKey.current === graphKey && postedVectors.current === semanticVectors) return;
    if (workerPending.current && latestGraphKey.current !== graphKey) {
      const replacement = new Worker(new URL("../semantic-graph-worker.ts", import.meta.url), { type: "module" });
      replacement.onmessage = worker.onmessage;
      replacement.onerror = worker.onerror;
      worker.terminate();
      graphWorker.current = replacement;
      worker = replacement;
      postedVectors.current = [];
    }
    workerPending.current = true;
    const requestId = ++graphRequestId.current;
    if (!semanticVectors.length) {
      setSemanticGraph(EMPTY_SEMANTIC_GRAPH);
      setSemanticGraphKey("");
      postedVectors.current = [];
      latestGraphRequestId.current = requestId;
      latestGraphKey.current = "";
      worker.postMessage({ requestId, mode: "reset" });
      return;
    }
    const previous = postedVectors.current;
    const added = appendedVectors(previous, semanticVectors);
    latestGraphRequestId.current = requestId;
    latestGraphKey.current = graphKey;
    postedVectors.current = semanticVectors;
    setSemanticError("");
    if (added?.length) {
      worker.postMessage({ requestId, mode: "append", baseKey: semanticVectorKey(previous), vectors: added });
    } else {
      worker.postMessage({ requestId, mode: "replace", vectors: semanticVectors });
    }
  }, [active, loadedVectorKey, semanticVectors]);

  useEffect(() => {
    if (!loading && selectedId && !items.some((item) => item.id === selectedId)) {
      setSelectedId(null);
      setLocalMode(false);
    }
  }, [items, loading, selectedId]);

  const documents = useMemo(() => {
    const ids = new Set(items.map(({ id }) => id));
    for (const [id, node] of nodeCache.current) {
      if (node.type === "document" && !ids.has(id)) nodeCache.current.delete(id);
    }
    return items.map((item) => {
      const node = Object.assign(nodeCache.current.get(item.id) ?? {}, item, {
        type: "document" as const, color: item.folderId ? folderColor(item.folderId) : "#77766f",
      }) as MapItem & MapNode;
      nodeCache.current.set(item.id, node);
      return node;
    });
  }, [items]);
  const documentsById = useMemo(() => new Map(documents.map((item) => [item.id, item])), [documents]);
  useEffect(() => setListPage(0), [documents]);

  const selected = selectedId ? documentsById.get(selectedId) ?? null : null;
  useEffect(() => {
    if (!active || !selectedId) return;
    const controller = new AbortController();
    void readerDataApi.connections(selectedId, controller.signal).then((data) => { if (!controller.signal.aborted) setManualData({ id: selectedId, data }); }, () => { if (!controller.signal.aborted) setManualData({ id: selectedId, error: "人工关联暂不可用，请重新选择或刷新。" }); });
    return () => controller.abort();
  }, [active, selectedId, mapLoadRevision]);
  const manual = manualData?.id === selectedId ? manualData : null;
  useEffect(() => {
    relatedRequest.current?.abort();
    if (!active || !selectedId || !enabledRelationTypes.length) { setRelatedLoading(false); return; }
    const controller = new AbortController();
    relatedRequest.current = controller; setRelatedLoading(true);
    const key = relatedQueryKey, id = selectedId;
    const current = () => !controller.signal.aborted && relatedScope.current.active && relatedScope.current.key === key;
    const timer = window.setTimeout(() => {
      void studyApi.related(id, { limit: 20, types: enabledRelationTypes }, controller.signal).then((data) => { if (current()) setRelatedData({ id, key, data }); }, () => { if (current()) setRelatedData({ id, key, error: "关联证据暂不可用。" }); }).finally(() => { if (current()) setRelatedLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); relatedRequest.current?.abort(); };
  }, [active, relatedQueryKey]);
  const remoteRelated = relatedData?.id === selectedId && relatedData.key === relatedQueryKey ? relatedData : null;
  const continueRelated = async () => {
    const previous = remoteRelated?.data;
    if (!active || !selectedId || !previous?.nextCursor || relatedLoading) return;
    const controller = new AbortController(), key = relatedQueryKey, id = selectedId;
    relatedRequest.current?.abort(); relatedRequest.current = controller; setRelatedLoading(true);
    const current = () => !controller.signal.aborted && relatedScope.current.active && relatedScope.current.key === key;
    try {
      const next = await studyApi.related(id, { limit: 20, cursor: previous.nextCursor, types: enabledRelationTypes }, controller.signal);
      if (!current()) return;
      setRelatedData((stored) => {
        if (stored?.key !== key || !stored.data) return stored;
        const entries = new Map([...stored.data.items, ...next.items].map((entry) => [entry.document.id, entry]));
        return { id, key, data: { ...next, scannedDocuments: stored.data.scannedDocuments + next.scannedDocuments, items: [...entries.values()].sort((a, b) => b.score - a.score).slice(0, 20) } };
      });
    } catch { if (current()) setRelatedData((stored) => stored?.key === key ? { ...stored, error: "继续检索失败，请重试。" } : stored); }
    finally { if (current()) setRelatedLoading(false); }
  };
  const remotePeers = useMemo(() => (remoteRelated?.data?.items ?? []).flatMap((entry) => { const item = documentsById.get(entry.document.id); return item && entry.reasons.some((reason) => relationTypes[reason.type] && (reason.type !== "semantic" || (reason.score ?? 0) >= semanticThreshold)) ? [item] : []; }), [remoteRelated, documentsById, relationTypes, semanticThreshold]);
  const selectedManualPeers = useMemo(() => (manual?.data?.connections ?? []).flatMap((entry) => { const item = documentsById.get(entry.peer.id); return item ? [{ item, note: entry.note }] : []; }), [documentsById, manual]);
  const selectedSemanticPeers = useMemo(() => selected?.semanticState === "ready"
    && semanticGraphCurrent
    ? (semanticGraph.neighbors[selected.id] ?? [])
      .filter((neighbor) => neighbor.score >= semanticThreshold)
      .slice(0, 10)
      .flatMap((neighbor) => {
        const item = documentsById.get(neighbor.id);
        return item?.semanticState === "ready" ? [{ item, score: neighbor.score }] : [];
      })
    : [], [documentsById, selected, semanticGraph, semanticGraphCurrent, semanticThreshold]);

  const selectedFolderPeers = useMemo(() => selected?.folderId
    ? documents.filter((item) => item.id !== selected.id && item.folderId === selected.folderId).slice(0, 8)
    : [], [documents, selected]);
  const scopedDocuments = useMemo(() => focusedGroup === null ? documents
    : documents.filter((item) => (item.folderId ?? "") === focusedGroup), [documents, focusedGroup]);
  const summaryMode = !localMode && focusedGroup === null && documents.length > MAP_VISIBLE_DOCUMENTS;
  const overviewDocuments = useMemo(() => summaryMode ? [] : scopedDocuments.slice(0, MAP_VISIBLE_DOCUMENTS), [scopedDocuments, summaryMode]);

  const visibleDocuments = useMemo(() => {
    if (!localMode || !selected) return overviewDocuments;
    const peers = new Map([...(relationTypes.folder ? selectedFolderPeers : []), ...(relationTypes.semantic ? selectedSemanticPeers.map(({ item }) => item) : []), ...(relationTypes.manual || relationTypes.citation ? selectedManualPeers.map(({ item }) => item) : []), ...remotePeers].map((item) => [item.id, item]));
    return [selected, ...peers.values()];
  }, [localMode, selected, selectedFolderPeers, selectedSemanticPeers, selectedManualPeers, overviewDocuments, relationTypes, remotePeers]);

  const groupNodes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of documents) counts.set(item.folderId ?? "", (counts.get(item.folderId ?? "") ?? 0) + 1);
    const groups = [...folders, { id: "", name: "未分类" }];
    const ids = new Set(groups.map(({ id }) => "folder:" + id));
    for (const [id, node] of nodeCache.current) if (node.type === "folder" && !ids.has(id)) nodeCache.current.delete(id);
    return groups.filter(({ id }) => counts.has(id)).map(({ id, name }) => {
      const node = Object.assign(nodeCache.current.get("folder:" + id) ?? {}, {
        id: "folder:" + id, folderId: id, name, count: counts.get(id)!, type: "folder" as const,
        color: id ? folderColor(id) : "#77766f",
      }) as FolderItem & MapNode;
      nodeCache.current.set(node.id, node);
      return node;
    });
  }, [documents, folders]);

  useEffect(() => {
    for (const id of state3D.current.positions.keys()) if (!nodeCache.current.has(id)) state3D.current.positions.delete(id);
  }, [documents, groupNodes]);

  const localSelectedId = localMode ? selectedId : null;

  const graphData = useMemo(() => {
    const visibleFolderIds = new Set(visibleDocuments.map((item) => item.folderId ?? ""));
    const folderItems = summaryMode ? groupNodes : showFolders ? groupNodes.filter((folder) => visibleFolderIds.has(folder.folderId)) : [];
    const folderIds = new Set(folderItems.map(({ folderId }) => folderId));
    const folderLinks: MapLink[] = showFolders && relationTypes.folder ? visibleDocuments.filter((item) => item.folderId && folderIds.has(item.folderId))
      .map((item) => ({ source: item.id, target: "folder:" + item.folderId, type: "folder" })) : [];
    const visibleIds = new Set(visibleDocuments.map(({ id }) => id));
    const readyVisibleIds = new Set(visibleDocuments.filter(({ semanticState }) => semanticState === "ready").map(({ id }) => id));
    const semanticLinks: MapLink[] = !semanticGraphCurrent || !relationTypes.semantic ? [] : localSelectedId
      ? (semanticGraph.neighbors[localSelectedId] ?? []).filter(({ id, score }) => score >= semanticThreshold && visibleIds.has(id))
        .map(({ id, score }) => ({ source: localSelectedId, target: id, type: "semantic", score }))
      : semanticGraph.edges.filter((edge) => edge.score >= semanticThreshold && visibleIds.has(edge.source) && visibleIds.has(edge.target) &&
        readyVisibleIds.has(edge.source) && readyVisibleIds.has(edge.target))
        .map((edge) => ({ ...edge, type: "semantic" as const }));
    const nodes = [...folderItems, ...visibleDocuments];
    if (restoreOverview.current) {
      for (const node of nodes) {
        const position = overview.current?.positions.get(node.id);
        if (position) Object.assign(node, position, { vx: 0, vy: 0 });
      }
    }
    const manualLinks: MapLink[] = (manual?.data?.connections ?? []).filter((edge) => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId)).map((edge) => ({ source: edge.sourceId, target: edge.targetId, type: (remoteRelated?.data?.items.some((item) => item.reasons.some((reason) => reason.connectionId === edge.id && reason.type === "citation")) ? "citation" : "manual") as "citation" | "manual" })).filter((edge) => relationTypes[edge.type]);
    const remoteLinks: MapLink[] = selectedId ? (remoteRelated?.data?.items ?? []).flatMap<MapLink>((entry) => {
      if (!visibleIds.has(selectedId) || !visibleIds.has(entry.document.id)) return [];
      const reason = [...entry.reasons].sort((a, b) => ["manual", "citation", "tag", "semantic", "folder", "lexical"].indexOf(a.type) - ["manual", "citation", "tag", "semantic", "folder", "lexical"].indexOf(b.type)).find((value) => relationTypes[value.type]);
      if (!reason || (reason.type === "semantic" && (reason.score ?? 0) < semanticThreshold)) return [];
      return [reason.type === "semantic" ? { source: selectedId, target: entry.document.id, type: "semantic", score: reason.score! } : { source: selectedId, target: entry.document.id, type: reason.type }];
    }) : [];
    const unique = new Map<string, MapLink>();
    for (const link of [...folderLinks, ...semanticLinks, ...manualLinks, ...remoteLinks]) unique.set(`${link.type}:${[link.source, link.target].sort().join(":")}`, link);
    return { nodes, links: [...unique.values()] };
  }, [groupNodes, localSelectedId, semanticGraph, semanticGraphCurrent, semanticThreshold, showFolders, summaryMode, visibleDocuments, manual, remoteRelated, relationTypes, selectedId]);

  const semanticCalculationPending = documents.length <= SEMANTIC_GRAPH_MAX_NODES && (semanticLoading || (readyVectorIds.length > 0 && !semanticGraphCurrent && !semanticError));
  const semanticEmptyMessage = !selected || selected.semanticState === "unavailable" ? "尚未启用语义推荐，可先浏览同组资料。"
    : documents.length > SEMANTIC_GRAPH_MAX_NODES ? "大范围资料使用服务端邻域推荐，可在关联证据中查看。"
    : semanticError ? semanticError
    : selected.semanticState === "failed" ? "这篇资料的语义索引失败，请到智能设置重试。"
    : selected.kind === "paper" && selected.status !== "ready" ? "论文提取完成后才能建立语义索引。"
    : selected.semanticState === "pending" ? "这篇资料尚待建立语义索引。"
    : selected.semanticState === "indexing" ? "正在建立这篇资料的语义索引。"
    : semanticCalculationPending ? "正在比较内容，稍后显示推荐。"
    : "暂无符合相似要求的资料，可以调低相似要求。";

  const changeScope = (local: boolean, group: string | null = focusedGroup) => {
    if (!localMode && focusedGroup === null && (local || group !== null) && graph.current) {
      overview.current = { center: graph.current.centerAt(), zoom: graph.current.zoom(),
        positions: new Map(graphData.nodes.map(({ id, x, y }) => [id, { x, y }])) };
    }
    if (!local && group === null && (localMode || focusedGroup !== null)) restoreOverview.current = true;
    fitFocusedScope.current = local || group !== null;
    setLocalMode(local);
    setFocusedGroup(group);
  };

  useEffect(() => {
    if (restoreOverview.current) {
      if (overview.current) {
        saved2DView.current = { center: overview.current.center, zoom: overview.current.zoom };
        graph.current?.centerAt(overview.current.center.x, overview.current.center.y);
        graph.current?.zoom(overview.current.zoom);
      }
      restoreOverview.current = false;
    }
  }, [graphData]);

  useEffect(() => {
    if (active && !paused && dimension === "2d") graph.current?.resumeAnimation();
    else graph.current?.pauseAnimation();
  }, [active, paused, width, height, graphData, dimension]);

  const fit = () => dimension === "3d" ? graph3D.current?.fit() : graph.current?.zoomToFit(420, 34);
  const togglePause = () => {
    if (paused) graph.current?.resumeAnimation();
    else graph.current?.pauseAnimation();
    setPaused(!paused);
  };
  const labelNodesById = useMemo(() => new Map(graphData.nodes.map((node) => [node.id, node])), [graphData]);
  const labelGroupIds = useMemo(() => graphData.nodes.filter((node) => node.type === "folder").slice(0, 20).map((node) => node.id), [graphData]);
  const labelPeerIds = useMemo(() => {
    const peers: string[] = [];
    for (const edge of graphData.links) {
      const source = typeof edge.source === "string" ? edge.source : (edge.source as MapNode).id, target = typeof edge.target === "string" ? edge.target : (edge.target as MapNode).id;
      if (source === selectedId) peers.push(target); else if (target === selectedId) peers.push(source);
      if (peers.length === 8) break;
    }
    return peers;
  }, [graphData, selectedId]);

  const prepareLabels = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
    canvases2D.current.add(ctx.canvas);
    const candidates = [...new Set([selectedId, hoveredId, ...(!draggingNode && scale > .6 ? labelPeerIds : []), ...(!draggingNode ? labelGroupIds : [])].filter((id): id is string => Boolean(id)))];
    const rectangles: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    visibleLabels.current.clear(); ctx.save();
    for (const id of candidates) {
      const node = labelNodesById.get(id); if (!node || node.x === undefined || node.y === undefined) continue;
      const selected = id === selectedId, size = node.type === "folder" ? 5.2 : node.kind === "paper" ? 4.4 : 3.8;
      const fontSize = Math.max(10, 12 / Math.max(scale, .7)); ctx.font = `${selected ? "600" : "400"} ${fontSize}px ${labelFont}`;
      const text = node.type === "folder" ? `${shortTitle(node.name)} · ${node.count}` : shortTitle(node.title);
      const rect = { left: node.x + size + 4, top: node.y - fontSize * .6, right: node.x + size + 8 + ctx.measureText(text).width, bottom: node.y + fontSize * .6 };
      if (rectangles.some((other) => rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top)) continue;
      rectangles.push(rect); visibleLabels.current.add(id);
    }
    ctx.restore();
  }, [labelNodesById, labelGroupIds, labelPeerIds, selectedId, hoveredId, draggingNode, labelFont]);

  const drawNode = useCallback((raw: object, ctx: CanvasRenderingContext2D, scale: number) => {
    const node = raw as MapNode & { x?: number; y?: number };
    if (node.x === undefined || node.y === undefined) return;
    const isSelected = node.id === selectedId;
    const size = node.type === "folder" ? 5.2 : node.kind === "paper" ? 4.4 : 3.8;
    ctx.beginPath();
    if (node.type === "folder") ctx.rect(node.x - size, node.y - size, size * 2, size * 2);
    else if (node.kind === "paper") ctx.rect(node.x - size * .8, node.y - size * .8, size * 1.6, size * 1.6);
    else ctx.arc(node.x, node.y, size, 0, Math.PI * 2);
    ctx.fillStyle = node.type === "folder" ? (darkTheme ? "#2d2a25" : "#f4f0e7") : node.color;
    ctx.fill();
    if (!draggingNode || isSelected || node.id === hoveredId) {
      ctx.strokeStyle = isSelected ? (darkTheme ? "#f08a72" : "#b64b3b") : (darkTheme ? "#c5bdae" : "rgba(43, 42, 37, .72)");
      ctx.lineWidth = (isSelected ? 2.4 : 1.1) / Math.max(scale, .35);
      ctx.stroke();
    }
    if (visibleLabels.current.has(node.id)) {
      ctx.font = (isSelected ? "600 " : "400 ") + Math.max(10, 12 / Math.max(scale, .7)) + `px ${labelFont}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = darkTheme ? "#eee8dd" : node.type === "folder" ? "#55483a" : "#2d2a25";
      ctx.fillText(node.type === "folder" ? `${shortTitle(node.name)} · ${node.count}` : shortTitle(node.title), node.x + size + 4, node.y);
    }
  }, [darkTheme, draggingNode, hoveredId, selectedId, labelFont]);

  const openSelected = () => { if (selected) onOpenDocument(selected.id); };
  const selectNode = (item: MapNode) => {
    if (item.type === "document") setSelectedId(item.id);
    else { changeScope(false, item.folderId); setSelectedId(null); }
  };

  return (
    <section className="knowledge-map" aria-label="知识地图">
      <div className="knowledge-map-actions"><SegmentedControl label="地图维度" className="map-dimension-switch" value={dimension} options={[{ value: "2d", label: "2D" }, { value: "3d", label: "3D" }]} onChange={(value) => { if (value === "3d") graph.current?.pauseAnimation(); setDimension(value as "2d" | "3d"); setRenderError(""); }} /><span className="map-total">{total.toLocaleString("zh-CN")} 篇</span></div>
      <div className={"knowledge-map-layout" + (selected ? " has-detail" : "")}>
        <aside className="knowledge-map-filters" aria-label="地图筛选">
          <h2 className="knowledge-map-title">知识地图</h2>
          <label className="map-search"><span>搜索标题</span><Input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="输入关键词" /></label>
          <label><span>资料类型</span><Select aria-label="资料类型" value={kind} onChange={(event) => setKind(event.target.value as LibraryItemKind | "")}><option value="">文章与论文</option><option value="article">文章</option><option value="paper">论文</option></Select></label>
          <label><span>分组</span><Select aria-label="分组" value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="">全部分组</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</Select></label>
          <div className="map-display-options">
            {!cloud && <label className="map-check"><Checkbox checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /><span>显示归档</span></label>}
            <label className="map-check"><Checkbox checked={showFolders || summaryMode} disabled={summaryMode} onChange={(event) => setShowFolders(event.target.checked)} /><span>显示分组</span></label>
          </div>
          <fieldset className="map-relations"><legend>关系类型</legend>{(Object.entries(RELATION_LABELS) as Array<[RelationType, string]>).map(([type, label]) => <label key={type}><Checkbox checked={relationTypes[type]} onChange={(event) => setRelationTypes((values) => ({ ...values, [type]: event.target.checked }))} />{label}</label>)}</fieldset>
          <label className="map-threshold"><span>相似要求<span className="map-threshold-value" aria-hidden="true">{semanticThreshold.toFixed(2)}</span></span><Range aria-label="相似要求" min="0.3" max="0.9" step="0.01" value={semanticThreshold} disabled={!semanticEnabled || semanticLoading} onChange={(event) => setSemanticThreshold(Number(event.target.value))} /></label>
          <SegmentedControl label="查看范围" className="map-view-switch" value={localMode ? "local" : "all"} options={[{ value: "all", label: "全部资料" }, { value: "local", label: "当前关联", disabled: !selected }]} onChange={(value) => changeScope(value === "local", null)} />
          <div className="map-legend">
            <div className="map-key"><span><i className="map-key-article" />文章</span><span><i className="map-key-paper" />论文</span><span><i className="map-key-folder" />分组</span><span><i className="map-key-line" />所属分组</span><span><i className="map-key-semantic" />内容相近</span></div>
            <p className="map-privacy-note">{dimension === "3d" ? "节点与连线按关系分布在三维空间；虚线表示内容相近。" : "实线表示分组，虚线表示内容相近。"}</p>
          </div>
          {items.length > MAP_VISIBLE_DOCUMENTS && <p className="map-budget-note" role="status">{summaryMode ? "已按分组汇总，点击分组展开。" : !localMode && scopedDocuments.length > MAP_VISIBLE_DOCUMENTS ? "当前分组仅绘制前 1,000 篇，请搜索或从资料列表选择。" : "选中资料后使用服务端邻域推荐；全库向量比较限 1,000 篇。"}</p>}
          {semanticCalculationPending && <p className="map-semantic-status" role="status">正在查找相近织片…</p>}
          {semanticEnabled && items.length <= SEMANTIC_GRAPH_MAX_NODES && !semanticCalculationPending && !readyVectorIds.length && !semanticError && <p className="map-semantic-status" role="status">处理完成后，会显示相近织片。</p>}
          {semanticError && <p className="map-semantic-status is-error" role="status">{semanticError}</p>}
          <details className="map-accessible-list" open={listOpen} onToggle={(event) => setListOpen(event.currentTarget.open)}><summary>资料列表（{documents.length}）</summary>{listOpen && <>
            <ul>{documents.slice(listPage * MAP_LIST_PAGE_SIZE, (listPage + 1) * MAP_LIST_PAGE_SIZE).map((item) => <li key={item.id}><Button type="button" aria-pressed={selectedId === item.id} onClick={() => setSelectedId(item.id)}>{item.title || "未命名资料"}<small>{item.kind === "paper" ? "论文" : "文章"}</small></Button></li>)}</ul>
            {documents.length > MAP_LIST_PAGE_SIZE && <nav className="map-list-pages" aria-label="地图资料分页"><Button disabled={listPage === 0} onClick={() => setListPage((value) => value - 1)}>上一页</Button><span>{listPage + 1} / {Math.ceil(documents.length / MAP_LIST_PAGE_SIZE)}</span><Button disabled={(listPage + 1) * MAP_LIST_PAGE_SIZE >= documents.length} onClick={() => setListPage((value) => value + 1)}>下一页</Button></nav>}
          </>}</details>
        </aside>
        <div className="knowledge-map-canvas" role="region" aria-label="资料关联画布">
          {loading && <p className="map-loading" role="status">正在加载资料地图…</p>}
          {renderError && <p className="map-render-error" role="status">{renderError}</p>}
          {error ? <div className="map-state"><span className="eyebrow">MAP · ERROR</span><h3>加载失败</h3><p>{error}</p><Button type="button" onClick={() => setRetryCount((value) => value + 1)}>重试</Button></div>
            : !loading && !documents.length ? <div className="map-state"><span className="eyebrow">MAP · EMPTY</span><h3>{query || kind || folderId ? "没有匹配的资料" : "知识地图还是空的"}</h3><p>添加文章或论文后，这里会显示。</p></div>
              : <div className="map-canvas-inner" ref={observeHost}>
                {width > 0 && height > 0 && (dimension === "3d" ? <Map3DBoundary onUnavailable={unavailable3D}><Suspense fallback={<p className="map-loading" role="status">正在准备 3D 地图…</p>}><KnowledgeMap3D ref={graph3D} data={graphData} state={state3D} width={width} height={height} active={active} paused={paused} dark={darkTheme} selectedId={selectedId} scope={localMode ? `local:${selectedId}` : focusedGroup !== null ? `folder:${focusedGroup}` : "all"} onSelect={selectNode} onUnavailable={unavailable3D} /></Suspense></Map3DBoundary> : <ForceGraph2D
                  ref={captureGraph as never}
                  width={width}
                  height={height}
                  graphData={graphData}
                  backgroundColor="rgba(0,0,0,0)"
                  nodeId="id"
                  nodeLabel={(node: object) => { const item = node as MapNode; return item.type === "folder" ? `分组：${item.name} · ${item.count} 篇，点击展开` : (item.kind === "paper" ? "论文：" : "文章：") + item.title; }}
                  nodeCanvasObject={drawNode}
                  onRenderFramePre={prepareLabels}
                  nodePointerAreaPaint={(raw: object, color: string, ctx: CanvasRenderingContext2D) => {
                    canvases2D.current.add(ctx.canvas);
                    const node = raw as MapNode & { x?: number; y?: number };
                    if (node.x === undefined || node.y === undefined) return;
                    const radius = node.type === "folder" ? 9 : node.kind === "paper" ? 8 : 7;
                    ctx.fillStyle = color;
                    ctx.fillRect(node.x - radius, node.y - radius, radius * 2, radius * 2);
                  }}
                  linkColor={(link: object) => ({ manual: darkTheme ? "#f08a72" : "#b64b3b", semantic: darkTheme ? "#bba2d5" : "#675d85", citation: darkTheme ? "#8fb9df" : "#32678f", tag: darkTheme ? "#a9c39b" : "#537343", lexical: darkTheme ? "#d6ba87" : "#846832", folder: darkTheme ? "rgba(197, 189, 174, .5)" : "rgba(109, 103, 88, .44)" })[(link as MapLink).type]}
                  linkWidth={(link: object) => (link as MapLink).type === "manual" ? 2 : (link as MapLink).type === "semantic" ? 1.35 : 1.1}
                  linkLineDash={(link: object) => (link as MapLink).type === "semantic" ? [4, 3] : []}
                  linkVisibility={() => !draggingNode}
                  linkPointerAreaPaint={() => {}}
                  d3AlphaDecay={0.06}
                  cooldownTicks={130}
                  onEngineStop={() => {
                    if (fitFocusedScope.current) {
                      fitFocusedScope.current = false;
                      graph.current?.zoomToFit(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420, 34);
                    }
                  }}
                  enableNodeDrag
                  onNodeClick={(node: object) => selectNode(node as MapNode)}
                  onNodeHover={(node: object | null) => setHoveredId(node && "id" in node ? String((node as MapNode).id) : null)}
                  onNodeDrag={() => {
                    if (draggingNodeRef.current) return;
                    draggingNodeRef.current = true;
                    setDraggingNode(true);
                    const linkForce = graph.current?.d3Force("link");
                    const chargeForce = graph.current?.d3Force("charge");
                    dragForceSnapshot.current = {
                      linkStrength: linkForce?.strength?.(),
                      chargeStrength: chargeForce?.strength?.(),
                      chargeDistanceMax: chargeForce?.distanceMax?.(),
                      centerForce: graph.current?.d3Force("center"),
                    };
                    linkForce?.strength?.(0);
                    chargeForce?.strength?.(0);
                    graph.current?.d3Force("center", null);
                    if (paused) graph.current?.resumeAnimation();
                  }}
                  onNodeDragEnd={() => {
                    if (!draggingNodeRef.current) return;
                    draggingNodeRef.current = false;
                    setDraggingNode(false);
                    const snapshot = dragForceSnapshot.current;
                    const linkForce = graph.current?.d3Force("link");
                    const chargeForce = graph.current?.d3Force("charge");
                    if (snapshot?.linkStrength !== undefined) linkForce?.strength?.(snapshot.linkStrength);
                    if (snapshot?.chargeStrength !== undefined) chargeForce?.strength?.(snapshot.chargeStrength);
                    if (snapshot?.chargeDistanceMax !== undefined) chargeForce?.distanceMax?.(snapshot.chargeDistanceMax);
                    if (snapshot?.centerForce) graph.current?.d3Force("center", snapshot.centerForce);
                    dragForceSnapshot.current = null;
                    if (!paused) graph.current?.d3ReheatSimulation();
                    else graph.current?.pauseAnimation();
                  }}
                />)}
                <div className="map-canvas-toolbar">{(localMode || focusedGroup !== null) && <Button type="button" onClick={() => changeScope(false, null)}>返回总览</Button>}<Button type="button" onClick={fit} aria-label="显示全图">显示全图</Button><Button type="button" onClick={togglePause} aria-pressed={paused}>{paused ? "继续移动" : "暂停移动"}</Button></div>
                <span className="map-coordinate-note">{dimension === "3d" ? "拖动空白旋转，滚轮缩放；拖动节点调整位置。" : draggingNode ? "拖动时暂时隐藏连线，松开后恢复。" : "位置远近不表示内容相似程度。"}</span>
              </div>}
        </div>
        <aside className={"knowledge-map-detail " + (selected ? "is-open" : "")} aria-label="资料详情">
          {selected && <div className="map-detail-head"><Button type="button" className="map-detail-close" onClick={() => { changeScope(false, null); setSelectedId(null); }} aria-label="关闭详情">×</Button></div>}
          {selected ? <>
            <span className={"map-kind-mark " + selected.kind} aria-hidden="true" />
            <h3>{selected.title || "未命名资料"}</h3>
            <dl className="map-metadata"><div><dt>类型</dt><dd>{selected.kind === "paper" ? "论文" : "文章"}</dd></div><div><dt>分组</dt><dd>{selected.folderName || "未分类"}</dd></div><div><dt>状态</dt><dd>{statusLabel(selected)}</dd></div><div><dt>推荐处理</dt><dd>{semanticStateLabel(selected)}</dd></div></dl>
            <Button type="button" className="map-focus-related" aria-pressed={localMode} onClick={() => changeScope(!localMode, null)}>{localMode ? "返回总览" : "聚焦关联"}</Button>
            <section className="map-detail-related" aria-label="关联证据"><h4>关联证据</h4>
              {remoteRelated?.data?.items.length ? <ul>{remoteRelated.data.items.filter((entry) => entry.reasons.some((reason) => relationTypes[reason.type])).map((entry) => <li key={entry.document.id}><div>
                <Button onClick={() => documentsById.has(entry.document.id) ? setSelectedId(entry.document.id) : onOpenDocument(entry.document.id)}>{entry.document.title || "未命名资料"}</Button>
                <p>{entry.reasons.filter((reason) => relationTypes[reason.type]).map((reason) => reason.type === "semantic" ? `正文向量相近 · ${reason.score!.toFixed(2)}` : reason.label).join("；")}</p>
                {entry.evidence.slice(0, 2).map((evidence, index) => <div key={`${evidence.id}:${index}`}><blockquote>{evidence.anchor.quote}</blockquote><Button onClick={() => readerTools.openEvidence(evidence)}>查看原文：{evidence.title}</Button></div>)}
              </div></li>)}</ul> : <p>{!enabledRelationTypes.length ? "请选择要展示的关系类型。" : remoteRelated?.error || (remoteRelated?.data ? "本次检索没有找到关联证据。" : "正在读取关联证据…")}</p>}
              {remoteRelated?.error && remoteRelated.data && <p role="status">{remoteRelated.error}</p>}
              {remoteRelated?.data?.nextCursor && <Button disabled={relatedLoading} onClick={() => void continueRelated()}>{relatedLoading ? "查找中…" : "继续查找关联证据"}</Button>}
            </section>
            <section className="map-detail-related"><h4>人工关联</h4>{selectedManualPeers.length ? <ul>{selectedManualPeers.map(({ item, note }) => <li key={item.id}><Button onClick={() => setSelectedId(item.id)}><span>{item.title || "未命名资料"}<small>{note || "你建立的双向关联"}</small></span></Button></li>)}</ul> : <p>{manual?.error || (manual?.data ? "当前筛选范围内暂无人工关联。" : "正在读取人工关联…")}</p>}{manual?.data && manual.data.totalConnections > 20 && <small>地图展示最近 20 条，阅读器中可查看全部关联。</small>}<small>红色实线表示人工关联，不代表引用关系。</small></section>
            <section className="map-detail-related"><h4>内容相近</h4>{selectedSemanticPeers.length ? <ul>{selectedSemanticPeers.map(({ item, score }) => <li key={item.id}><Button type="button" onClick={() => setSelectedId(item.id)}><span>{item.title || "未命名资料"}<small>模型推荐{item.folderId && item.folderId === selected.folderId ? ` · 同属「${selected.folderName}」` : item.folderName ? ` · 来自「${item.folderName}」` : ""}</small></span><small>相似分数 {score.toFixed(2)}</small></Button></li>)}</ul> : <p>{semanticEmptyMessage}</p>}<small className="map-model-score-note">依据已保存正文的向量相似度推荐，不表示引用或内容正确。</small></section>
            <section className="map-detail-related"><h4>同组资料</h4>{selectedFolderPeers.length ? <><p>同属「{selected.folderName}」，依据你的分组。</p><ul>{selectedFolderPeers.map((peer) => <li key={peer.id}><Button type="button" onClick={() => setSelectedId(peer.id)}>{peer.title || "未命名资料"}<small>{peer.kind === "paper" ? "论文" : "文章"}</small></Button></li>)}</ul></> : <p>{selected.folderId ? "目前没有其他同分组资料。" : "这篇资料尚未分组。"}</p>}</section>
            <Button className="map-open-reader" type="button" onClick={openSelected}>打开资料 <span aria-hidden="true">↗</span></Button>
          </> : <p className="map-empty-detail">选择一张织片，查看详情。</p>}
        </aside>
      </div>
    </section>
  );
}

export default KnowledgeMap;
