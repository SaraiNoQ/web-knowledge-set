import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";

import type { SemanticGraphResult } from "../../shared/semantic-graph";
import { SEMANTIC_GRAPH_MAX_NODES, semanticVectorKey } from "../../shared/semantic-graph";
import type { KnowledgeMapNode, LibraryItemKind, SemanticVectorEntry } from "../../shared/types";
import { api } from "../api";

interface Props {
  active: boolean;
  cloud: boolean;
  libraryView: "all" | "favorites" | "paper";
  refreshKey: number;
  query: string;
  onQueryChange: (value: string) => void;
  onBack: () => void;
  onOpenDocument: (id: string) => void;
}

type MapItem = KnowledgeMapNode & { type: "document"; color: string };
type FolderItem = { id: string; name: string; type: "folder"; color: string };
type MapNode = MapItem | FolderItem;
type MapLink = { source: string; target: string; type: "folder" } | { source: string; target: string; type: "semantic"; score: number };
type GraphMethods = { zoomToFit: (duration?: number, padding?: number) => void; pauseAnimation: () => void; resumeAnimation: () => void };
type SemanticVectorVersion = { id: string; sourceHash: string | null; model: string | null; formatVersion: string | null };
type SemanticGraphWorkerMessage = { requestId: number; graphKey?: string; result?: SemanticGraphResult; error?: string };
const EMPTY_SEMANTIC_GRAPH: SemanticGraphResult = { edges: [], neighbors: {} };

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

export function KnowledgeMap({ active, cloud, libraryView, query, onQueryChange, onBack, onOpenDocument, refreshKey }: Props) {
  const [items, setItems] = useState<KnowledgeMapNode[]>([]);
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [total, setTotal] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  const [mapLoadRevision, setMapLoadRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<LibraryItemKind | "">(libraryView === "paper" ? "paper" : "");
  const [folderId, setFolderId] = useState("");
  const [favorite, setFavorite] = useState<boolean | undefined>(libraryView === "favorites" ? true : undefined);
  const [includeArchived, setIncludeArchived] = useState(true);
  const [showFolders, setShowFolders] = useState(true);
  const [localMode, setLocalMode] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [semanticVectors, setSemanticVectors] = useState<SemanticVectorEntry[]>([]);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState("");
  const [semanticGraph, setSemanticGraph] = useState(EMPTY_SEMANTIC_GRAPH);
  const [semanticThreshold, setSemanticThreshold] = useState(0.6);
  const [paused, setPaused] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const graph = useRef<GraphMethods | null>(null);
  const mapLoading = useRef(false);
  const graphWorker = useRef<Worker | null>(null);
  const graphRequestId = useRef(0);
  const latestGraphRequestId = useRef(0);
  const latestGraphKey = useRef("");
  const postedVectors = useRef<SemanticVectorEntry[]>([]);
  const semanticVectorsRef = useRef(semanticVectors);
  semanticVectorsRef.current = semanticVectors;
  const vectorCache = useRef(new Map<string, SemanticVectorEntry>());
  const [semanticGraphKey, setSemanticGraphKey] = useState("");
  const filters = useRef({ kind, folderId, favorite, includeArchived, query });
  filters.current = { kind, folderId, favorite, includeArchived, query };

  useEffect(() => {
    if (libraryView === "paper") setKind("paper");
    else if (libraryView === "all") setKind("");
    if (libraryView === "favorites") setFavorite(true);
    else if (libraryView === "all" || libraryView === "paper") setFavorite(undefined);
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
          folderId: current.folderId || undefined, favorite: current.favorite,
          includeArchived: !cloud && current.includeArchived,
        }, signal);
        if (signal.aborted) return;
        values.push(...page.items);
        resultFolders = page.folders;
        expectedTotal = page.total;
        cursor = page.nextCursor ?? undefined;
        setItems([...values]);
        setTotal(expectedTotal);
        setFolders(resultFolders);
      } while (cursor && !signal.aborted);
      if (!signal.aborted && values.length !== expectedTotal) throw new Error("资料地图分页不完整，请重试。");
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
  }, [active, kind, folderId, favorite, includeArchived, query, loadMap, refreshKey, retryCount]);

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
            throw new Error("语义索引已更新，请重新载入地图后再查看关联。");
          }
          groupEntries.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        if (groupEntries.length !== total || groupEntries.length !== ids.length || new Set(groupEntries.map(({ id }) => id)).size !== ids.length) {
          throw new Error("部分语义索引刚刚失效，请重新载入地图。");
        }
        for (const entry of groupEntries) vectorCache.current.set(entry.id, entry);
      }
      if (!controller.signal.aborted) {
        const entries = readyVectorRefs.map(({ id }) => vectorCache.current.get(id))
          .filter((entry): entry is SemanticVectorEntry => Boolean(entry));
        if (entries.length !== readyVectorRefs.length) throw new Error("部分语义索引刚刚失效，请重新载入地图。");
        setSemanticVectors(entries);
      }
    })().catch((cause) => {
      if (!controller.signal.aborted) {
        setSemanticVectors([]);
        setSemanticGraph(EMPTY_SEMANTIC_GRAPH);
        setSemanticGraphKey("");
        setSemanticError((cause as Error).message || "无法载入语义向量；文件夹地图仍可使用。");
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
      if (message.error === "SEMANTIC_GRAPH_BASE_MISMATCH" ||
        (message.result && message.graphKey !== latestGraphKey.current)) {
        const vectors = semanticVectorsRef.current;
        const requestId = ++graphRequestId.current;
        const graphKey = semanticVectorKey(vectors);
        latestGraphRequestId.current = requestId;
        latestGraphKey.current = graphKey;
        postedVectors.current = vectors;
        worker.postMessage(vectors.length ? { requestId, mode: "replace", vectors } : { requestId, mode: "reset" });
        return;
      }
      if (message.error) {
        setSemanticGraph(EMPTY_SEMANTIC_GRAPH);
        setSemanticGraphKey("");
        setSemanticError("语义向量无法比较；文件夹地图仍可使用。");
      } else if (message.result) {
        setSemanticGraph(message.result);
        setSemanticGraphKey(message.graphKey ?? "");
        setSemanticError("");
      }
    };
    worker.onerror = () => {
      setSemanticGraph(EMPTY_SEMANTIC_GRAPH);
      setSemanticGraphKey("");
      setSemanticError("语义关联计算失败；文件夹地图仍可使用。");
    };
    return () => {
      worker.terminate();
      if (graphWorker.current === worker) graphWorker.current = null;
    };
  }, []);

  useEffect(() => {
    const worker = graphWorker.current;
    if (!worker) return;
    const requestId = ++graphRequestId.current;
    if (!active || !semanticVectors.length) {
      setSemanticGraph(EMPTY_SEMANTIC_GRAPH);
      setSemanticGraphKey("");
      postedVectors.current = [];
      latestGraphRequestId.current = requestId;
      latestGraphKey.current = "";
      worker.postMessage({ requestId, mode: "reset" });
      return;
    }
    const graphKey = semanticVectorKey(semanticVectors);
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

  const documents = useMemo<MapItem[]>(() => items.map((item) => {
    return { ...item, type: "document", color: item.folderId ? folderColor(item.folderId) : "#77766f" };
  }), [items]);

  const selected = documents.find((item) => item.id === selectedId) ?? null;
  const selectedSemanticPeers = useMemo(() => selected?.semanticState === "ready"
    && semanticGraphCurrent
    ? (semanticGraph.neighbors[selected.id] ?? [])
      .filter((neighbor) => neighbor.score >= semanticThreshold)
      .slice(0, 10)
      .flatMap((neighbor) => {
        const item = documents.find((candidate) => candidate.id === neighbor.id);
        return item?.semanticState === "ready" ? [{ item, score: neighbor.score }] : [];
      })
    : [], [documents, selected, semanticGraph, semanticGraphCurrent, semanticThreshold]);

  const visibleDocuments = useMemo(() => {
    if (!localMode || !selectedId) return documents;
    const selected = documents.find((item) => item.id === selectedId);
    if (!selected) return documents;
    if (selected.semanticState !== "ready" || !semanticGraphCurrent) return [selected];
    const neighborIds = new Set((semanticGraph.neighbors[selectedId] ?? [])
      .filter((neighbor) => neighbor.score >= semanticThreshold)
      .slice(0, 10)
      .map(({ id }) => id));
    return [selected, ...documents.filter((item) => neighborIds.has(item.id))];
  }, [documents, localMode, selectedId, semanticGraph, semanticGraphCurrent, semanticThreshold]);

  const graphData = useMemo(() => {
    const visibleFolderIds = new Set(visibleDocuments.map((item) => item.folderId).filter((id): id is string => Boolean(id)));
    const folderItems: FolderItem[] = showFolders ? folders.filter((folder) => visibleFolderIds.has(folder.id)).map((folder) => ({
      id: "folder:" + folder.id, name: folder.name, type: "folder", color: folderColor(folder.id),
    })) : [];
    const folderLinks: MapLink[] = showFolders ? visibleDocuments.filter((item) => item.folderId && folders.some((folder) => folder.id === item.folderId))
      .map((item) => ({ source: item.id, target: "folder:" + item.folderId, type: "folder" })) : [];
    const visibleIds = new Set(visibleDocuments.map(({ id }) => id));
    const readyVisibleIds = new Set(visibleDocuments.filter(({ semanticState }) => semanticState === "ready").map(({ id }) => id));
    const semanticLinks: MapLink[] = !semanticGraphCurrent ? [] : localMode && selectedId
      ? selectedSemanticPeers.filter(({ item }) => visibleIds.has(item.id) && readyVisibleIds.has(selectedId))
        .map(({ item, score }) => ({ source: selectedId, target: item.id, type: "semantic", score }))
      : semanticGraph.edges.filter((edge) => edge.score >= semanticThreshold && visibleIds.has(edge.source) && visibleIds.has(edge.target) &&
        readyVisibleIds.has(edge.source) && readyVisibleIds.has(edge.target))
        .map((edge) => ({ ...edge, type: "semantic" as const }));
    return { nodes: [...folderItems, ...visibleDocuments] as MapNode[], links: [...folderLinks, ...semanticLinks] };
  }, [folders, localMode, selectedId, selectedSemanticPeers, semanticGraph, semanticGraphCurrent, semanticThreshold, showFolders, visibleDocuments]);

  const semanticCalculationPending = semanticLoading || (readyVectorIds.length > 0 && !semanticGraphCurrent && !semanticError);

  const selectedFolderPeers = selected?.folderId
    ? documents.filter((item) => item.id !== selected.id && item.folderId === selected.folderId).slice(0, 8)
    : [];

  const fit = () => graph.current?.zoomToFit(420, 34);
  const togglePause = () => {
    if (paused) graph.current?.resumeAnimation();
    else graph.current?.pauseAnimation();
    setPaused(!paused);
  };

  const drawNode = useCallback((raw: object, ctx: CanvasRenderingContext2D, scale: number) => {
    const node = raw as MapNode & { x?: number; y?: number };
    if (node.x === undefined || node.y === undefined) return;
    const isSelected = node.id === selectedId;
    const size = node.type === "folder" ? 5.2 : node.kind === "paper" ? 4.4 : 3.8;
    ctx.beginPath();
    if (node.type === "folder") ctx.rect(node.x - size, node.y - size, size * 2, size * 2);
    else if (node.kind === "paper") ctx.rect(node.x - size * .8, node.y - size * .8, size * 1.6, size * 1.6);
    else ctx.arc(node.x, node.y, size, 0, Math.PI * 2);
    ctx.fillStyle = node.type === "folder" ? "#f4f0e7" : node.color;
    ctx.fill();
    ctx.strokeStyle = isSelected ? "#b64b3b" : "rgba(43, 42, 37, .72)";
    ctx.lineWidth = (isSelected ? 2.4 : 1.1) / Math.max(scale, .35);
    ctx.stroke();
    if (isSelected || node.id === hoveredId) {
      ctx.font = (isSelected ? "600 " : "450 ") + Math.max(10, 12 / Math.max(scale, .7)) + "px Georgia, serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = node.type === "folder" ? "#55483a" : "#2d2a25";
      ctx.fillText(node.type === "folder" ? shortTitle(node.name) : shortTitle(node.title), node.x + size + 4, node.y);
    }
  }, [hoveredId, selectedId]);

  const openSelected = () => { if (selected) onOpenDocument(selected.id); };

  return (
    <section className="knowledge-map" aria-label="知识地图">
      <header className="knowledge-map-head">
        <div><span className="eyebrow">03 · ATLAS</span><h2>知识地图</h2><p>实线表示文件夹归属；虚线是模型语义推荐。</p></div>
        <div className="knowledge-map-head-actions"><span className="map-total">{total.toLocaleString("zh-CN")} 篇</span><button type="button" onClick={onBack}>返回列表</button></div>
      </header>
      <div className="knowledge-map-layout">
        <aside className="knowledge-map-filters" aria-label="地图筛选">
          <label className="map-search"><span>搜索标题</span><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="输入关键词" /></label>
          <label><span>资料类型</span><select value={kind} onChange={(event) => setKind(event.target.value as LibraryItemKind | "")}><option value="">文章与论文</option><option value="article">文章</option><option value="paper">论文</option></select></label>
          <label><span>文件夹</span><select value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="">全部文件夹</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
          <label><span>收藏</span><select value={favorite === undefined ? "all" : String(favorite)} onChange={(event) => setFavorite(event.target.value === "all" ? undefined : event.target.value === "true")}><option value="all">全部</option><option value="true">仅收藏</option><option value="false">排除收藏</option></select></label>
          {!cloud && <label className="map-check"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /><span>显示归档</span></label>}
          <label className="map-check"><input type="checkbox" checked={showFolders} onChange={(event) => setShowFolders(event.target.checked)} /><span>显示文件夹关系</span></label>
          <label className="map-threshold"><span>语义阈值 · {semanticThreshold.toFixed(2)}</span><input aria-label="语义推荐阈值" type="range" min="0.3" max="0.9" step="0.01" value={semanticThreshold} disabled={!semanticEnabled || semanticLoading || items.length > SEMANTIC_GRAPH_MAX_NODES} onChange={(event) => setSemanticThreshold(Number(event.target.value))} /></label>
          <div className="map-view-switch" role="group" aria-label="图谱范围"><button type="button" aria-pressed={!localMode} onClick={() => setLocalMode(false)}>全库</button><button type="button" aria-pressed={localMode} disabled={!selected} onClick={() => setLocalMode(true)}>单篇关联</button></div>
          <div className="map-key"><span><i className="map-key-article" />文章</span><span><i className="map-key-paper" />论文</span><span><i className="map-key-folder" />文件夹</span><span><i className="map-key-line" />文件夹归属</span><span><i className="map-key-semantic" />语义推荐</span></div>
          <p className="map-privacy-note">语义分数是模型相似度，不是正确率；连线不表示引用或事实关系。</p>
          {semanticEnabled && items.length > SEMANTIC_GRAPH_MAX_NODES && <p className="map-semantic-status" role="status">当前包含 {items.length.toLocaleString("zh-CN")} 篇，超过首版 1,000 篇语义计算规模；全部节点仍会显示，请搜索或筛选后查看语义推荐。</p>}
          {semanticCalculationPending && <p className="map-semantic-status" role="status">正在加载向量并计算语义关联…</p>}
          {semanticEnabled && items.length <= SEMANTIC_GRAPH_MAX_NODES && !semanticCalculationPending && !readyVectorIds.length && !semanticError && <p className="map-semantic-status" role="status">资料索引完成后会显示语义推荐。</p>}
          {semanticError && <p className="map-semantic-status is-error" role="status">{semanticError}</p>}
          <details className="map-accessible-list"><summary>节点列表（{documents.length}）</summary><ul>{documents.map((item) => <li key={item.id}><button type="button" aria-pressed={selectedId === item.id} onClick={() => { setSelectedId(item.id); setLocalMode(true); }}>{item.title || "未命名资料"}<small>{item.kind === "paper" ? "论文" : "文章"}</small></button></li>)}</ul></details>
        </aside>
        <div className="knowledge-map-canvas" role="region" aria-label="资料关联画布">
          {loading && <p className="map-loading" role="status">正在展开资料节点…</p>}
          {error ? <div className="map-state"><span className="eyebrow">MAP · ERROR</span><h3>无法载入知识地图</h3><p>{error}</p><button type="button" onClick={() => setRetryCount((value) => value + 1)}>重试</button></div>
            : !loading && !documents.length ? <div className="map-state"><span className="eyebrow">MAP · EMPTY</span><h3>{query || kind || folderId || favorite !== undefined ? "没有匹配的资料" : "知识地图还是空的"}</h3><p>保存文章或论文后，它们会在这里出现。</p></div>
              : <div className="map-canvas-inner" ref={observeHost}>
                {width > 0 && height > 0 && <ForceGraph2D
                  ref={graph as never}
                  width={width}
                  height={height}
                  graphData={graphData}
                  backgroundColor="rgba(0,0,0,0)"
                  nodeId="id"
                  nodeLabel={(node: object) => { const item = node as MapNode; return item.type === "folder" ? "文件夹：" + item.name : (item.kind === "paper" ? "论文：" : "文章：") + item.title; }}
                  nodeCanvasObject={drawNode}
                  nodePointerAreaPaint={(raw: object, color: string, ctx: CanvasRenderingContext2D) => {
                    const node = raw as MapNode & { x?: number; y?: number };
                    if (node.x === undefined || node.y === undefined) return;
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(node.x, node.y, 13, 0, Math.PI * 2);
                    ctx.fill();
                  }}
                  linkColor={(link: object) => (link as MapLink).type === "semantic" ? "rgba(103, 93, 133, .58)" : "rgba(109, 103, 88, .44)"}
                  linkWidth={(link: object) => (link as MapLink).type === "semantic" ? 1.35 : 1.1}
                  linkLineDash={(link: object) => (link as MapLink).type === "semantic" ? [4, 3] : []}
                  d3AlphaDecay={0.06}
                  cooldownTicks={130}
                  enableNodeDrag
                  onNodeClick={(node: object) => { const item = node as MapNode; if (item.type === "document") { setSelectedId(item.id); setLocalMode(true); } }}
                  onNodeHover={(node: object | null) => setHoveredId(node && "id" in node ? String((node as MapNode).id) : null)}
                />}
                <div className="map-canvas-toolbar"><button type="button" onClick={fit} aria-label="适应画布">适应画布</button><button type="button" onClick={togglePause} aria-pressed={paused}>{paused ? "继续布局" : "暂停布局"}</button></div>
                <span className="map-coordinate-note">位置仅用于排布，不代表相似度。</span>
              </div>}
        </div>
        <aside className={"knowledge-map-detail " + (selected ? "is-open" : "")} aria-label="资料详情">
          <div className="map-detail-head"><span className="eyebrow">SELECTED NODE</span>{selected && <button type="button" className="map-detail-close" onClick={() => { setSelectedId(null); setLocalMode(false); }} aria-label="关闭详情">×</button>}</div>
          {selected ? <>
            <span className={"map-kind-mark " + selected.kind} aria-hidden="true" />
            <h3>{selected.title || "未命名资料"}</h3>
            <dl className="map-metadata"><div><dt>类型</dt><dd>{selected.kind === "paper" ? "论文" : "文章"}</dd></div><div><dt>文件夹</dt><dd>{selected.folderName || "未分类"}</dd></div><div><dt>状态</dt><dd>{statusLabel(selected)}</dd></div><div><dt>语义索引</dt><dd>{semanticStateLabel(selected)}</dd></div></dl>
            <section className="map-detail-related"><h4>语义推荐</h4>{selectedSemanticPeers.length ? <ul>{selectedSemanticPeers.map(({ item, score }) => <li key={item.id}><button type="button" onClick={() => { setSelectedId(item.id); setLocalMode(true); }}>{item.title || "未命名资料"}<small>{item.kind === "paper" ? "论文" : "文章"} · 模型分数 {score.toFixed(2)}</small></button></li>)}</ul> : <p>{selected.semanticState === "ready" ? "当前阈值下没有语义推荐。" : "索引建立后会显示语义推荐。"}</p>}<small className="map-model-score-note">模型分数不代表正确率。</small></section>
            <section className="map-detail-related"><h4>文件夹中的其他资料</h4>{selectedFolderPeers.length ? <ul>{selectedFolderPeers.map((peer) => <li key={peer.id}><button type="button" onClick={() => setSelectedId(peer.id)}>{peer.title || "未命名资料"}<small>{peer.kind === "paper" ? "论文" : "文章"}</small></button></li>)}</ul> : <p>目前没有其他同文件夹资料。</p>}</section>
            <button className="map-open-reader" type="button" onClick={openSelected}>打开阅读 <span aria-hidden="true">↗</span></button>
          </> : <p className="map-empty-detail">选择一个节点查看资料信息。</p>}
        </aside>
      </div>
    </section>
  );
}

export default KnowledgeMap;
