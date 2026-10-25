import { useEffect, useRef, useState } from "react";
import { readerDataApi } from "../api";
import { studyApi } from "../study/api";
import { readerTools } from "./runtime";
import { Button, Select } from "../components/ui/Controls";
import { useToast } from "../components/ui/Feedback";
import type { RelatedResult, RelatedItem } from "../../shared/related";
import type { DocumentConnection, ReadingAnnotation } from "../../shared/reader-tools";
import type { StudyTopic } from "../../shared/study-types";
import "./recommendations.css";

export function ReaderRecommendations({ documentId, revision }: { documentId: string; revision: number }) {
  const [result, setResult] = useState<RelatedResult | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [topics, setTopics] = useState<StudyTopic[]>([]), [topicId, setTopicId] = useState("");
  const request = useRef<AbortController | null>(null), toast = useToast();
  const load = async (cursor?: string) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setBusy(true); setError("");
    try {
      const value = await studyApi.related(documentId, { limit: 10, ...(cursor ? { cursor } : {}) }, controller.signal);
      if (controller.signal.aborted) return;
      if (value.sourceRevision !== revision) { setError("原文版本已变化，请重新打开资料。"); return; }
      setResult((previous) => {
        if (!cursor || !previous) return value;
        const items = new Map<string, RelatedItem>();
        for (const item of [...previous.items, ...value.items]) if (!items.has(item.document.id) || items.get(item.document.id)!.score < item.score) items.set(item.document.id, item);
        return { ...value, scannedDocuments: previous.scannedDocuments + value.scannedDocuments, items: [...items.values()].sort((a, b) => b.score - a.score).slice(0, 20) };
      });
    } catch (cause) { if (!controller.signal.aborted) setError((cause as Error).message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  useEffect(() => { setResult(null); void load(); return () => request.current?.abort(); }, [documentId, revision]);
  useEffect(() => {
    const controller = new AbortController();
    void studyApi.listTopics(controller.signal).then((value) => { if (!controller.signal.aborted) setTopics(value); }).catch(() => {});
    return () => controller.abort();
  }, [documentId]);
  const add = async (id: string) => {
    const topic = topics.find((entry) => entry.id === topicId); if (!topic) return;
    try { const updated = await studyApi.addDocument(topic, id); setTopics((values) => values.map((entry) => entry.id === updated.id ? updated : entry)); toast.success("已加入专题。"); }
    catch (cause) { toast.error((cause as Error).message); }
  };
  return <section className="reader-recommendations" aria-label="相关资料推荐">
    <h3>相关资料</h3>
    {topics.length > 0 && <div className="reader-topic-target"><Select aria-label="推荐资料加入的专题" value={topicId} onChange={(event) => setTopicId(event.target.value)}><option value="">选择专题</option>{topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</Select><Button disabled={!topicId} onClick={() => void add(documentId)}>加入当前资料</Button></div>}
    {error && <p role="alert">{error} <Button onClick={() => void load()}>重试推荐</Button></p>}
    {!result && busy && <p role="status">正在查找相关资料…</p>}
    {result && !result.items.length && <p>本次检索没有找到关联资料。</p>}
    {result && <ul>{result.items.map((item) => <li key={item.document.id}>
      <Button className="reader-related-title" onClick={() => readerTools.openDocument(item.document.id)}>{item.document.title || "未命名资料"}</Button>
      <p className="reader-related-reasons">{item.reasons.map((reason) => reason.type === "semantic" ? `正文向量相近 · ${reason.score!.toFixed(2)}` : reason.label).join("；")}</p>
      {item.evidence.map((entry, index) => <div className="reader-related-evidence" key={`${entry.id}:${index}`}><blockquote>{entry.anchor.quote}</blockquote><Button onClick={() => readerTools.openEvidence(entry)}>查看原文：{entry.title}{entry.anchor.pageNumber ? ` · 第 ${entry.anchor.pageNumber} 页` : ""}</Button></div>)}
      {topicId && <Button onClick={() => void add(item.document.id)}>加入所选专题</Button>}
    </li>)}</ul>}
    {result?.nextCursor && <p><small>已比较 {result.scannedDocuments} 篇，保留最相关的 20 条。</small><Button disabled={busy} onClick={() => void load(result.nextCursor!)}>{busy ? "查找中…" : "继续查找相关资料"}</Button></p>}
    {result?.items.some((item) => item.reasons.some((reason) => reason.type === "semantic")) && <small>相似分数用于推荐，原文片段供核实，不表示事实正确。</small>}
  </section>;
}

export function ConnectionEvidenceEditor({ documentId, revision, connection, annotations, onSaved }: {
  documentId: string; revision: number; connection: DocumentConnection & { peer: { id: string; title: string } }; annotations: ReadingAnnotation[]; onSaved: () => void;
}) {
  const [open, setOpen] = useState(false), [page, setPage] = useState(1), [peerNotes, setPeerNotes] = useState<ReadingAnnotation[]>([]), [total, setTotal] = useState(0);
  const [currentId, setCurrentId] = useState(""), [peerId, setPeerId] = useState(""), [relationType, setRelationType] = useState<"manual" | "citation">("manual");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setLoaded(false); setError("");
    void Promise.all([readerDataApi.list(connection.peer.id, controller.signal, page), studyApi.connectionEvidence(connection.id, controller.signal)]).then(([data, evidence]) => {
      if (controller.signal.aborted) return;
      setPeerNotes(data.annotations); setTotal(data.totalAnnotations);
      if (evidence) { const source = connection.sourceId === documentId; setCurrentId((source ? evidence.sourceAnnotationId : evidence.targetAnnotationId) ?? ""); setPeerId((source ? evidence.targetAnnotationId : evidence.sourceAnnotationId) ?? ""); setRelationType(evidence.relationType); }
      setLoaded(true);
    }).catch((cause) => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [open, connection.id, connection.revision, page, documentId]);
  const save = async () => {
    setBusy(true); setError("");
    try {
      const source = connection.sourceId === documentId;
      await studyApi.setConnectionEvidence(documentId, connection.id, { revision: connection.revision, relationType, sourceAnnotationId: (source ? currentId : peerId) || null, targetAnnotationId: (source ? peerId : currentId) || null });
      onSaved();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const options = (notes: ReadingAnnotation[], value: string, current: boolean) => [
    <option key="unbound" value="">不绑定摘录</option>,
    ...(value && !notes.some((note) => note.id === value) ? [<option key="other-page" value={value}>已绑定的其他页摘录</option>] : []),
    ...notes.map((note) => <option key={note.id} value={note.id} disabled={current && note.sourceRevision !== revision}>{note.anchor.quote.slice(0, 60)}{current && note.sourceRevision !== revision ? "（原文已更新）" : ""}</option>),
  ];
  return <details className="reader-evidence-editor" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>绑定摘录证据</summary>{open && <div>
    <label>这篇资料的摘录<Select value={currentId} onChange={(event) => setCurrentId(event.target.value)} disabled={!loaded}>{options(annotations, currentId, true)}</Select></label>
    <small>本篇摘录随上方分页切换。</small>
    <label>关联资料的摘录<Select value={peerId} onChange={(event) => setPeerId(event.target.value)} disabled={!loaded}>{options(peerNotes, peerId, false)}</Select></label>
    {total > 20 && <nav aria-label="关联资料摘录分页"><Button disabled={page === 1} onClick={() => setPage((value) => value - 1)}>上一页</Button><span>{page}</span><Button disabled={page * 20 >= total} onClick={() => setPage((value) => value + 1)}>下一页</Button></nav>}
    <label>关系类型<Select value={relationType} onChange={(event) => setRelationType(event.target.value as "manual" | "citation")}><option value="manual">人工关联</option><option value="citation">我确认这是引用关系</option></Select></label>
    {error && <p role="alert">{error}</p>}
    <Button disabled={!loaded || busy || (relationType === "citation" && !currentId && !peerId)} onClick={() => void save()}>{busy ? "保存中…" : "保存关联证据"}</Button>
  </div>}</details>;
}
