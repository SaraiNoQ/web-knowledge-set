import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, readerDataApi, type ReaderDataSnapshot } from "../api";
import { builtinReaderTools, readerTools } from "./runtime";
import { revealReaderAnchor } from "./selection";
import { ReaderToolBoundary } from "./ReaderToolsHost";
import { Button, IconButton, Input } from "../components/ui/Controls";
import { useDialogs, useToast } from "../components/ui/Feedback";
import type { DocumentSummary } from "../../shared/types";
import type { ReadingAnnotation } from "../../shared/reader-tools";

export function ReaderToolSettings() {
  const state = useSyncExternalStore(readerTools.subscribe, readerTools.getSnapshot);
  const toast = useToast();
  return <section className="reader-tool-settings" aria-label="阅读工具设置"><h2>阅读工具</h2>{builtinReaderTools.map(({ manifest }) => <div key={manifest.id}>
    <label><input type="checkbox" checked={state.enabled.includes(manifest.id)} onChange={(event) => { try { readerTools.enable(manifest.id, event.target.checked); } catch { toast.error("设置已生效，但未能保存。刷新后可能恢复原设置。"); } }} />{manifest.name}</label>
    <p>选择文字后翻译，也可按 Alt+T。仅翻译选中文字。</p>
    {state.errors[manifest.id] && <p role="status">{state.errors[manifest.id]} <Button onClick={() => readerTools.retry(manifest.id)}>重试</Button></p>}
  </div>)}</section>;
}

function ReadingDataPanel() {
  const state = useSyncExternalStore(readerTools.subscribe, readerTools.getSnapshot), context = state.context;
  const toast = useToast(), dialogs = useDialogs();
  const [data, setData] = useState<ReaderDataSnapshot | null>(null), [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0), [page, setPage] = useState(1);
  const [search, setSearch] = useState(""), [results, setResults] = useState<DocumentSummary[]>([]), [target, setTarget] = useState<DocumentSummary | null>(null), [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [related, setRelated] = useState<DocumentSummary[]>([]);
  useEffect(() => {
    if (!context?.folderId) { setRelated([]); return; }
    const controller = new AbortController();
    void api.listDocuments({ folderId: context.folderId, page: 1 }, controller.signal).then((value) => { if (!controller.signal.aborted) setRelated(value.items.filter((item) => item.id !== context.id).slice(0, 5)); }).catch(() => { if (!controller.signal.aborted) setRelated([]); });
    return () => controller.abort();
  }, [context?.id, context?.folderId]);
  useEffect(() => { setPage(1); setTarget(null); setSearch(""); setNote(""); }, [context?.id]);
  useEffect(() => {
    const changed = () => setRefresh((value) => value + 1);
    window.addEventListener("zhiye:reading-data-changed", changed);
    return () => window.removeEventListener("zhiye:reading-data-changed", changed);
  }, []);
  useEffect(() => {
    if (!context) { setData(null); return; }
    const controller = new AbortController();
    setError("");
    void readerDataApi.list(context.id, controller.signal, page).then((value) => {
      if (controller.signal.aborted) return;
      const last = Math.max(1, Math.ceil(Math.max(value.totalAnnotations, value.totalConnections) / 20));
      if (page > last) setPage(last); else setData(value);
    }).catch((cause) => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [context?.id, context?.revision, refresh, page]);
  useEffect(() => {
    if (!search.trim()) { setResults([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => void api.listDocuments({ q: search, scope: "title", page: 1 }, controller.signal).then((value) => { if (!controller.signal.aborted) setResults(value.items.filter((item) => item.id !== context?.id).slice(0, 8)); }).catch((cause) => { if (!controller.signal.aborted) setError((cause as Error).message); }), 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search, context?.id]);
  if (!context) return <p>打开资料后，可查看摘录与关联。</p>;
  const perform = async (operation: () => Promise<unknown>) => { setBusy(true); setError(""); try { await operation(); setRefresh((value) => value + 1); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } };
  const edit = async (entry: ReadingAnnotation) => {
    const value = await dialogs.prompt("修改这条摘录的笔记，原始引文和译文保持不变。", { title: "编辑笔记", label: "笔记", initialValue: entry.note, maxLength: 4000 });
    if (value !== null) await perform(() => readerDataApi.update(context.id, entry, value));
  };
  return <div className="reading-data-panel">
    {context.blockedReason && <p role="status">{context.blockedReason}</p>}
    {related.length > 0 && <section><h3>同组资料</h3><p>来自你的同一分组，可打开核实后建立关联。</p><ul>{related.map((item) => <li key={item.id}><Button onClick={() => readerTools.openDocument(item.id)}>{item.title || "未命名资料"}</Button></li>)}</ul></section>}
    {error && <p role="alert" className="error-text">{error} <Button onClick={() => setRefresh((value) => value + 1)}>重新载入</Button></p>}
    <section><h3>摘录与笔记 {data?.totalAnnotations ?? ""}</h3>{data?.annotations.length ? <ul>{data.annotations.map((entry) => <li key={entry.id}>
      <blockquote>{entry.anchor.quote}</blockquote>{entry.translation && <pre>{entry.translation}</pre>}{entry.note && <p>{entry.note}</p>}
      {entry.sourceRevision !== context.revision && <small>原文版本已更新，定位时会重新校验。</small>}
      <div className="reader-tool-actions"><Button onClick={() => void revealReaderAnchor(entry.anchor).then((found) => { if (!found) toast.error("无法唯一定位原文；内容可能已修改，或当前页面无法读取文字。"); })}>定位原文</Button><Button disabled={busy} onClick={() => void edit(entry)}>编辑笔记</Button><Button disabled={busy} onClick={() => void dialogs.confirm("删除此摘录、译文及笔记？", { title: "删除摘录", tone: "danger", confirmLabel: "删除" }).then((ok) => { if (ok) void perform(() => readerDataApi.remove(context.id, entry)); })}>删除</Button></div>
    </li>)}</ul> : <p>本页暂无摘录。在正文中选择文字后可保存。</p>}</section>
    <section><h3>人工关联 {data?.totalConnections ?? ""}</h3>{data?.connections.length ? <ul>{data.connections.map((entry) => <li key={entry.id}><Button onClick={() => readerTools.openDocument(entry.peer.id)}>{entry.peer.title || "未命名资料"}</Button>{entry.note && <p>{entry.note}</p>}<Button disabled={busy} onClick={() => void dialogs.confirm("解除这两篇资料的关联？正文不会删除。", { title: "解除关联", confirmLabel: "解除关联" }).then((ok) => { if (ok) void perform(() => readerDataApi.disconnect(context.id, entry)); })}>解除关联</Button></li>)}</ul> : <p>本页暂无人工关联。</p>}
      <label>查找要关联的资料<Input value={search} onChange={(event) => { setSearch(event.target.value); setTarget(null); }} placeholder="搜索标题" /></label>
      {results.length > 0 && !target && <ul className="connection-search">{results.map((item) => <li key={item.id}><Button onClick={() => setTarget(item)}>{item.title || "未命名资料"}</Button></li>)}</ul>}
      {target && <p>关联到：{target.title}</p>}<label>关联说明<textarea value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} /></label>
      <Button disabled={!target || busy || Boolean(context.blockedReason)} onClick={() => void perform(async () => { await readerDataApi.connect(context.id, context.revision, target!.id, note); setTarget(null); setSearch(""); setNote(""); toast.success("双向关联已保存。"); })}>建立关联</Button>
    </section>
    {data && Math.max(data.totalAnnotations, data.totalConnections) > 20 && <nav aria-label="摘录关联分页"><Button disabled={page === 1} onClick={() => setPage((value) => value - 1)}>上一页</Button><span>{page} / {Math.ceil(Math.max(data.totalAnnotations, data.totalConnections) / 20)}</span><Button disabled={page * 20 >= Math.max(data.totalAnnotations, data.totalConnections)} onClick={() => setPage((value) => value + 1)}>下一页</Button></nav>}
  </div>;
}

export function ReaderSidebar({ outline, onClose }: { outline: ReactNode; onClose: () => void }) {
  const state = useSyncExternalStore(readerTools.subscribe, readerTools.getSnapshot);
  const [tab, setTab] = useState("outline");
  const tool = state.tools[tab];
  return <aside id="document-tools" className="document-tools reader-sidebar" aria-label="右侧功能区">
    <header><h2>{tab === "outline" ? "大纲" : tab === "notes" ? "摘录与关联" : tool?.module.manifest.name ?? "阅读工具"}</h2><IconButton label={tab === "outline" ? "收起大纲" : "收起阅读工具"} onClick={onClose}>×</IconButton></header>
    <nav className="reader-sidebar-tabs" aria-label="阅读功能"><Button aria-pressed={tab === "outline"} onClick={() => setTab("outline")}>大纲</Button><Button aria-pressed={tab === "notes"} onClick={() => setTab("notes")}>摘录关联</Button>{Object.entries(state.tools).map(([id, entry]) => <Button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{entry.module.manifest.name}</Button>)}</nav>
    <div className="reader-sidebar-content">{tab === "outline" ? outline : tab === "notes" ? <ReadingDataPanel key={state.context?.id ?? "empty"} /> : tool ? <ReaderToolBoundary key={tab} onClose={() => setTab("outline")}><tool.module.Panel api={tool.api} selection={state.selection} /></ReaderToolBoundary> : <ReaderToolSettings />}</div>
  </aside>;
}
