import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SourceAnchor, ReadingAnnotation } from "../../shared/reader-tools";
import type { DuplicateCandidate, LinkHealth, MergeRecord, ReviewGrade, ReviewItem, StudyAnswer, StudyDocument, StudyTopic, StudyTopicDetail } from "../../shared/study-types";
import { Button, Checkbox, Input, Select, Textarea } from "../components/ui/Controls";
import { useDialogs } from "../components/ui/Feedback";
import { studyApi } from "./api";

type OpenDocument = (id: string, anchor?: SourceAnchor) => void;
const message = (cause: unknown) => cause instanceof Error ? cause.message : "操作失败，请重试。";
const title = (document: Pick<StudyDocument, "title">) => document.title || "未命名资料";
const date = (value: string) => new Date(value).toLocaleString("zh-CN");

function CitedAnswerText({ answer, onOpenDocument }: { answer: StudyAnswer; onOpenDocument: OpenDocument }) {
  const parts: ReactNode[] = [];
  let start = 0;
  while (start < answer.answer.length) {
    let next = -1, selected = -1, length = 0;
    for (const [index, citation] of answer.citations.entries()) {
      if (!citation.id) continue;
      const token = `[${citation.id}]`, position = answer.answer.indexOf(token, start);
      if (position >= 0 && (next < 0 || position < next || (position === next && token.length > length))) { next = position; selected = index; length = token.length; }
    }
    if (selected < 0) { parts.push(answer.answer.slice(start)); break; }
    if (next > start) parts.push(answer.answer.slice(start, next));
    const citation = answer.citations[selected]!, label = `[${selected + 1}]`;
    parts.push(<Button key={`${next}:${citation.id}`} variant="ghost" className="study-inline-citation" aria-label={`${label} 引用：${citation.title || "原资料"}`} onClick={() => onOpenDocument(citation.documentId, citation.anchor)}>{label}</Button>);
    start = next + length;
  }
  return <>{parts}</>;
}

function TopicQuestion({ topic, onOpenDocument }: { topic: StudyTopicDetail; onOpenDocument: OpenDocument }) {
  const [question, setQuestion] = useState(""), [answer, setAnswer] = useState<StudyAnswer | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const request = useRef<AbortController | null>(null), generation = useRef(0);
  const cancel = () => { request.current?.abort(); generation.current += 1; setBusy(false); };
  useEffect(() => { cancel(); setAnswer(null); setError(""); return () => { request.current?.abort(); generation.current += 1; }; }, [topic.id, topic.revision]);
  const ask = async () => {
    if (!question.trim() || busy || !topic.documents.length) return;
    request.current?.abort(); const controller = new AbortController(), current = ++generation.current; request.current = controller;
    setBusy(true); setError(""); setAnswer(null);
    try { const result = await studyApi.ask(topic.id, question.trim(), controller.signal, topic.revision, topic.documents.map(({ id, revision }) => ({ id, revision }))); if (!controller.signal.aborted && generation.current === current) setAnswer(result); }
    catch (cause) { if (!controller.signal.aborted && generation.current === current) setError(message(cause)); }
    finally { if (generation.current === current) setBusy(false); }
  };
  return <section className="study-question" aria-label="专题问答">
    <h3>向专题提问</h3>
    <p>问题和相关原文片段将发送给已配置的模型。</p>
    <details><summary>使用资料（{topic.documents.length} 篇）</summary><ul>{topic.documents.map((document) => <li key={document.id}><Button onClick={() => onOpenDocument(document.id)}>{title(document)}</Button></li>)}</ul></details>
    <label>问题<Textarea value={question} maxLength={2000} rows={3} onChange={(event) => { cancel(); setQuestion(event.target.value); setAnswer(null); setError(""); }} placeholder="你想从这些资料中核实什么？" /></label>
    <div className="study-actions"><Button variant="primary" disabled={!question.trim() || busy || !topic.documents.length} onClick={() => void ask()}>基于专题提问</Button>{busy && <Button onClick={cancel}>取消回答</Button>}</div>
    {busy && <p role="status">正在检索原文并生成回答…</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
    {answer && <div className="study-answer" aria-label="专题回答"><p role={answer.refused ? "status" : undefined}><CitedAnswerText answer={answer} onOpenDocument={onOpenDocument} /></p>{answer.citations.length > 0 && <><h4>核实原文</h4><ol>{answer.citations.map((citation) => <li key={citation.id}><Button onClick={() => onOpenDocument(citation.documentId, citation.anchor)}>{citation.title || "原资料"}{citation.anchor.pageNumber ? ` · 第 ${citation.anchor.pageNumber} 页` : ""}</Button><blockquote>{citation.anchor.quote}</blockquote></li>)}</ol></>}</div>}
  </section>;
}

function TopicDetail({ topicId, onOpenDocument, onChanged, onDirtyChange, onBusyChange }: { topicId: string; onOpenDocument: OpenDocument; onChanged: () => void; onDirtyChange: (value: boolean) => void; onBusyChange: (value: boolean) => void }) {
  const dialogs = useDialogs();
  const [topic, setTopic] = useState<StudyTopicDetail | null>(null), [note, setNote] = useState(""), [name, setName] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(""), [matches, setMatches] = useState<StudyDocument[]>([]), [annotations, setAnnotations] = useState<ReadingAnnotation[]>([]), [annotationPage, setAnnotationPage] = useState(1), [annotationTotal, setAnnotationTotal] = useState(0);
  const dirty = useRef(false);
  useEffect(() => { onDirtyChange(Boolean(topic && (note !== topic.note || name !== topic.name))); }, [topic, note, name, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    void studyApi.topic(topicId).then((value) => { if (!active) return; setTopic(value); if (!dirty.current) { setNote(value.note); setName(value.name); } }).catch((cause) => { if (active) setError(message(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [topicId, refresh]);
  useEffect(() => {
    if (!search.trim()) { setMatches([]); return; }
    let active = true; const timer = window.setTimeout(() => { void studyApi.documents({ q: search, page: 1 }).then((value) => { if (active) setMatches(value.items); }).catch((cause) => { if (active) setError(message(cause)); }); }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [search]);
  useEffect(() => { let active = true; void studyApi.annotations(annotationPage).then((value) => { if (active) { setAnnotations(value.items); setAnnotationTotal(value.total); } }).catch((cause) => { if (active) setError(message(cause)); }); return () => { active = false; }; }, [annotationPage]);
  const perform = async (operation: () => Promise<unknown>, savedNote = false) => {
    setBusy(true); setError("");
    try { await operation(); if (savedNote) dirty.current = false; setRefresh((value) => value + 1); onChanged(); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };
  if (!topic) return <div>{loading ? <p role="status">正在读取专题…</p> : <p role="alert">{error || "专题已不存在。"} <Button onClick={() => setRefresh((value) => value + 1)}>重新读取</Button></p>}</div>;
  return <div className="study-topic-detail">
    <header><h2>{topic.name}</h2><small>{topic.documents.length} 篇资料 · {topic.annotations.length} 条摘录</small></header>
    {error && <p role="alert" className="error-text">{error} <Button disabled={busy} onClick={() => { void (async () => { if (dirty.current && !await dialogs.confirm("载入最新专题会丢弃尚未保存的编辑。", { title: "重新载入专题", confirmLabel: "丢弃并载入" })) return; dirty.current = false; setRefresh((value) => value + 1); })(); }}>重新载入</Button></p>}
    <section aria-label="综合笔记"><h3>综合笔记</h3><label>专题名称<Input value={name} maxLength={100} disabled={busy} onChange={(event) => { dirty.current = true; setName(event.target.value); }} /></label><label>笔记<Textarea value={note} maxLength={40000} rows={8} disabled={busy} onChange={(event) => { dirty.current = true; setNote(event.target.value); }} placeholder="围绕这个问题，记录你的判断与待核实之处。" /></label><Button variant="primary" disabled={busy || !name.trim() || (note === topic.note && name === topic.name)} onClick={() => void perform(() => studyApi.updateTopic(topic.id, topic.revision, { name: name.trim(), note }), true)}>保存专题笔记</Button></section>
    <section aria-label="专题资料"><h3>专题资料</h3>{topic.documents.length ? <ul className="study-document-list">{topic.documents.map((document) => <li key={document.id}><Button variant="ghost" className="study-document-title" onClick={() => onOpenDocument(document.id)}>{title(document)}</Button><small>{document.kind === "paper" ? "论文" : "文章"}</small><Button disabled={busy} aria-label={`移出专题：${title(document)}`} onClick={() => void perform(() => studyApi.updateTopic(topic.id, topic.revision, { removeDocumentId: document.id }))}>移出</Button></li>)}</ul> : <p>暂无资料。</p>}
      <label>查找资料<Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题" /></label>{search.trim() && <ul className="study-search-results">{matches.filter((document) => !topic.documentIds.includes(document.id)).slice(0, 10).map((document) => <li key={document.id}><span>{title(document)}</span><Button disabled={busy} aria-label={`加入专题资料：${title(document)}`} onClick={() => void perform(async () => { await studyApi.updateTopic(topic.id, topic.revision, { documentId: document.id }); setSearch(""); })}>加入专题</Button></li>)}</ul>}
    </section>
    <section aria-label="专题摘录"><h3>专题摘录</h3>{topic.annotations.length ? <ul className="study-excerpt-list">{topic.annotations.map((annotation) => <li key={annotation.id}><blockquote>{annotation.anchor.quote}</blockquote>{annotation.translation && <p className="study-preserve-lines">{annotation.translation}</p>}{annotation.note && <p>{annotation.note}</p>}<div className="study-actions"><Button onClick={() => onOpenDocument(annotation.documentId, annotation.anchor)}>定位原文</Button><Button disabled={busy} aria-label={`移出专题摘录：${annotation.anchor.quote.slice(0, 20)}`} onClick={() => void perform(() => studyApi.updateTopic(topic.id, topic.revision, { removeAnnotationId: annotation.id }))}>移出专题</Button><Button disabled={busy} onClick={() => void perform(() => studyApi.scheduleReview(annotation.id))}>加入复习</Button></div></li>)}</ul> : <p>暂无摘录。</p>}
      <details><summary>从已有摘录加入</summary><ul className="study-excerpt-list">{annotations.filter((annotation) => !topic.annotationIds.includes(annotation.id)).map((annotation) => <li key={annotation.id}><blockquote>{annotation.anchor.quote}</blockquote><Button disabled={busy} aria-label={`加入专题摘录：${annotation.anchor.quote.slice(0, 20)}`} onClick={() => void perform(() => studyApi.updateTopic(topic.id, topic.revision, { annotationId: annotation.id }))}>加入专题</Button></li>)}</ul><div className="study-actions"><Button disabled={annotationPage === 1} onClick={() => setAnnotationPage((value) => value - 1)}>上一页摘录</Button><span>{annotationPage} / {Math.max(1, Math.ceil(annotationTotal / 20))}</span><Button disabled={annotationPage * 20 >= annotationTotal} onClick={() => setAnnotationPage((value) => value + 1)}>下一页摘录</Button></div></details>
    </section>
    <TopicQuestion topic={topic} onOpenDocument={onOpenDocument} />
    <section className="study-delete-topic"><Button variant="danger" disabled={busy} onClick={() => void dialogs.confirm("删除此专题及综合笔记？其中的原资料和摘录会保留。", { title: "删除专题", confirmLabel: "删除专题", tone: "danger" }).then((confirmed) => { if (confirmed) void perform(() => studyApi.deleteTopic(topic.id, topic.revision)); })}>删除专题</Button></section>
  </div>;
}

function StudyLibrary({ topics, onOpenDocument, currentDocumentId, onTopicChanged, onDirtyChange, onBusyChange }: { topics: StudyTopic[]; onOpenDocument: OpenDocument; currentDocumentId?: string; onTopicChanged: () => void; onDirtyChange: (value: boolean) => void; onBusyChange: (value: boolean) => void }) {
  const [query, setQuery] = useState(""), [unread, setUnread] = useState(false), [page, setPage] = useState(1), [items, setItems] = useState<StudyDocument[]>([]), [total, setTotal] = useState(0), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [topicId, setTopicId] = useState(""), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState("");
  const [health, setHealth] = useState<Record<string, LinkHealth>>({}), [tags, setTags] = useState<Record<string, string>>({});
  const healthRequest = useRef<AbortController | null>(null), tagRevisions = useRef<Record<string, number>>({});
  useEffect(() => { onDirtyChange(Object.keys(tags).length > 0); }, [tags, onDirtyChange]);
  useEffect(() => { onBusyChange(Boolean(busy) && !busy.startsWith("check:")); }, [busy, onBusyChange]);
  useEffect(() => () => { onDirtyChange(false); onBusyChange(false); }, [onDirtyChange, onBusyChange]);
  useEffect(() => { setPage(1); }, [query, unread]);
  useEffect(() => { if (!topics.some((topic) => topic.id === topicId)) setTopicId(topics[0]?.id ?? ""); }, [topics, topicId]);
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    const timer = window.setTimeout(() => { void studyApi.documents({ q: query, unread, page }).then((value) => { if (active) { setItems(value.items); setTotal(value.total); } }).catch((cause) => { if (active) setError(message(cause)); }).finally(() => { if (active) setLoading(false); }); }, query ? 180 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [query, unread, page, refresh]);
  useEffect(() => { const changed = () => setRefresh((value) => value + 1); window.addEventListener("zhiye:study-progress-changed", changed); return () => { window.removeEventListener("zhiye:study-progress-changed", changed); healthRequest.current?.abort(); }; }, []);
  const add = async (document: StudyDocument) => { setBusy(document.id); setError(""); try { const topic = await studyApi.topic(topicId); await studyApi.updateTopic(topic.id, topic.revision, { documentId: document.id }); onTopicChanged(); } catch (cause) { setError(message(cause)); } finally { setBusy(""); } };
  const check = async (document: StudyDocument) => {
    healthRequest.current?.abort(); const controller = new AbortController(); healthRequest.current = controller; setBusy(`check:${document.id}`); setError("");
    try { const result = await studyApi.checkSource(document.id, document.revision, controller.signal); if (!controller.signal.aborted) setHealth((value) => ({ ...value, [document.id]: result })); }
    catch (cause) { if (!controller.signal.aborted) setError(message(cause)); }
    finally { if (!controller.signal.aborted) setBusy(""); }
  };
  const saveTags = async (document: StudyDocument) => { setBusy(document.id); setError(""); try { await studyApi.tags(document.id, tagRevisions.current[document.id] ?? document.revision, (tags[document.id] ?? document.tags.join(", ")).split(/[,，]/u).map((value) => value.trim()).filter(Boolean)); delete tagRevisions.current[document.id]; setTags((current) => { const next = { ...current }; delete next[document.id]; return next; }); setRefresh((value) => value + 1); } catch (cause) { setError(message(cause)); } finally { setBusy(""); } };
  return <section className="study-library" aria-label="研究资料">
    <header><h2>研究资料</h2><span>{total} 篇</span></header>
    <div className="study-library-filters"><label>搜索资料<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="标题" /></label><Checkbox label="只看未读" checked={unread} onChange={(event) => setUnread(event.target.checked)} /><label>加入专题<Select value={topicId} disabled={!topics.length} onChange={(event) => setTopicId(event.target.value)}>{topics.length ? topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>) : <option value="">先创建专题</option>}</Select></label></div>
    {error && <p role="alert" className="error-text">{error} <Button onClick={() => setRefresh((value) => value + 1)}>重新载入</Button></p>}{loading && <p role="status">正在查找资料…</p>}
    {!loading && !items.length && <p>没有符合条件的资料。</p>}
    <ul className="study-document-list">{items.map((document) => <li key={document.id} className={document.id === currentDocumentId ? "is-current" : ""}><div className="study-document-main"><div className="study-document-heading"><Button variant="ghost" className="study-document-title" onClick={() => onOpenDocument(document.id)}>{title(document)}</Button><small>{document.kind === "paper" ? "论文" : "文章"} · {/^https?:\/\//u.test(document.sourceUrl) ? <a href={document.sourceUrl} rel="noreferrer" target="_blank">查看来源</a> : "本地资料"}</small></div><div className="study-document-controls"><label>主题标签<Input value={tags[document.id] ?? document.tags.join(", ")} maxLength={600} disabled={Boolean(busy)} onChange={(event) => { const text = event.target.value; tagRevisions.current[document.id] ??= document.revision; setTags((value) => { const next = { ...value }; if (text === document.tags.join(", ")) { delete next[document.id]; delete tagRevisions.current[document.id]; } else next[document.id] = text; return next; }); }} placeholder="用逗号分隔" /></label><Button disabled={Boolean(busy) || tags[document.id] === undefined} onClick={() => void saveTags(document)}>保存标签</Button><div className="study-actions"><Button disabled={!topicId || Boolean(busy)} onClick={() => void add(document)}>加入专题</Button><Button disabled={Boolean(busy) || !/^https?:\/\//u.test(document.sourceUrl)} onClick={() => void check(document)}>检查来源</Button></div></div>{health[document.id] && <p role="status" className={`study-source-status is-${health[document.id].state}`}>{health[document.id].state === "restricted" ? "来源需要登录或限制访问，不能据此判定失效。" : health[document.id].message}{health[document.id].status ? `（HTTP ${health[document.id].status}）` : ""}</p>}</div></li>)}</ul>
    {total > 20 && <nav className="study-actions" aria-label="研究资料分页"><Button disabled={page === 1 || loading} onClick={() => setPage((value) => value - 1)}>上一页</Button><span>{page} / {Math.ceil(total / 20)}</span><Button disabled={page * 20 >= total || loading} onClick={() => setPage((value) => value + 1)}>下一页</Button></nav>}
  </section>;
}

function StudyReviews({ onOpenDocument }: { onOpenDocument: OpenDocument }) {
  const [items, setItems] = useState<ReviewItem[]>([]), [all, setAll] = useState(false), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true), [busy, setBusy] = useState(""), [error, setError] = useState(""), [revealed, setRevealed] = useState<string[]>([]);
  useEffect(() => { let active = true; setLoading(true); setError(""); void studyApi.reviews({ all }).then((value) => { if (active) setItems(value); }).catch((cause) => { if (active) setError(message(cause)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [all, refresh]);
  const perform = async (item: ReviewItem, grade?: ReviewGrade) => { setBusy(item.annotation.id); setError(""); try { if (grade) await studyApi.gradeReview(item.annotation.id, item.revision, grade); else await studyApi.scheduleReview(item.annotation.id); setRevealed((value) => value.filter((id) => id !== item.annotation.id)); setRefresh((value) => value + 1); } catch (cause) { setError(message(cause)); } finally { setBusy(""); } };
  return <section aria-label="摘录复习"><header><h2>摘录复习</h2><Checkbox label="查看全部摘录" checked={all} onChange={(event) => setAll(event.target.checked)} /></header>{error && <p className="error-text" role="alert">{error} <Button onClick={() => setRefresh((value) => value + 1)}>重新载入</Button></p>}{loading ? <p role="status">正在读取复习安排…</p> : !items.length ? <p>今天没有待复习摘录。选择“查看全部摘录”可以加入新的摘录。</p> : <ul className="study-excerpt-list">{items.map((item) => <li key={item.annotation.id}><Button onClick={() => onOpenDocument(item.annotation.documentId, item.annotation.anchor)}>{item.documentTitle || "原资料"}</Button><blockquote>{item.annotation.anchor.quote}</blockquote>{item.annotation.sourceRevision !== item.documentRevision && <p className="study-notice">原文已更新，复习前请定位核对。</p>}{item.dueAt && <small>安排：{date(item.dueAt)} · 已复习 {item.repetitions} 次</small>}{!item.dueAt ? <Button disabled={Boolean(busy)} onClick={() => void perform(item)}>加入复习</Button> : <><Button aria-expanded={revealed.includes(item.annotation.id)} onClick={() => setRevealed((value) => value.includes(item.annotation.id) ? value.filter((id) => id !== item.annotation.id) : [...value, item.annotation.id])}>查看笔记与译文</Button>{revealed.includes(item.annotation.id) && <div className="study-review-answer">{item.annotation.translation && <p className="study-preserve-lines">{item.annotation.translation}</p>}{item.annotation.note && <p>{item.annotation.note}</p>}{!item.annotation.translation && !item.annotation.note && <p>这条摘录尚未添加笔记或译文。</p>}<div className="study-actions">{([["again", "再看一次"], ["hard", "较难"], ["good", "记得"], ["easy", "熟悉"]] as const).map(([grade, label]) => <Button key={grade} disabled={Boolean(busy)} onClick={() => void perform(item, grade)}>{label}</Button>)}</div></div>}</>}</li>)}</ul>}</section>;
}

function StudyGovernance({ onOpenDocument }: { onOpenDocument: OpenDocument }) {
  const dialogs = useDialogs();
  const [candidates, setCandidates] = useState<DuplicateCandidate[]>([]), [history, setHistory] = useState<MergeRecord[]>([]), [keep, setKeep] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null), [scanned, setScanned] = useState(0);
  useEffect(() => { let active = true; setLoading(true); setError(""); void Promise.all([studyApi.duplicates(), studyApi.mergeHistory()]).then(([next, records]) => { if (active) { setCandidates(next.items); setCursor(next.nextCursor); setScanned(next.scanned); setHistory(records); } }).catch((cause) => { if (active) setError(message(cause)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [refresh]);
  const more = async () => { if (!cursor || busy) return; setBusy(true); setError(""); try { const next = await studyApi.duplicates(cursor); setCandidates((current) => [...new Map([...current, ...next.items].map((item) => [[item.source.id, item.target.id].sort().join(":"), item])).values()]); setCursor(next.nextCursor); setScanned((value) => value + next.scanned); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } };
  const merge = async (candidate: DuplicateCandidate, key: string) => {
    const kept = keep[key] === candidate.source.id ? candidate.source : candidate.target, removed = kept.id === candidate.source.id ? candidate.target : candidate.source;
    if (!await dialogs.confirm(`保留「${title(kept)}」，合并「${title(removed)}」？另一篇会进入回收站，原记录和来源会保留在合并历史中。`, { title: "确认合并资料", confirmLabel: "合并资料" })) return;
    setBusy(true); setError(""); try { await studyApi.merge(kept.id, removed.id, kept.revision, removed.revision); setRefresh((value) => value + 1); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const undo = async (record: MergeRecord) => { if (!await dialogs.confirm("撤回这次合并，恢复两篇资料的原记录？如果资料后来已修改，系统会拒绝覆盖。", { title: "撤回合并", confirmLabel: "撤回合并" })) return; setBusy(true); setError(""); try { await studyApi.undoMerge(record.id); setRefresh((value) => value + 1); } catch (cause) { setError(message(cause)); } finally { setBusy(false); } };
  return <section className="study-governance" aria-label="资料治理">
    <header><h2>资料治理</h2><Button disabled={loading || busy} onClick={() => setRefresh((value) => value + 1)}>刷新候选</Button></header>
    {error && <p role="alert" className="error-text">{error}</p>}
    {loading ? <p role="status">正在比较资料内容…</p> : !candidates.length ? <p>当前没有需要核实的重复候选。</p> : <>
      <p>相似内容只是候选，请打开核实后再合并。来源是否失效，可在“资料”中手动检查。</p>
      <ul className="study-duplicate-list">{candidates.map((candidate) => {
        const key = `${candidate.source.id}:${candidate.target.id}`;
        return <li key={key}><p>{candidate.reason} · 相近程度 {Math.round(candidate.score * 100)}%</p>
          <fieldset><legend>选择要保留的资料</legend>{[candidate.target, candidate.source].map((document) => <div className="study-duplicate-choice" key={document.id}>
            <label className="ui-checkbox-field"><input className="ui-checkbox" type="radio" name={`keep-${key}`} value={document.id} checked={(keep[key] ?? candidate.target.id) === document.id} onChange={() => setKeep((value) => ({ ...value, [key]: document.id }))} /><span><span className="ui-checkbox-label">{title(document)}</span><small>{document.sourceUrl}</small></span></label>
            <Button aria-label={`查看候选：${title(document)}`} onClick={() => onOpenDocument(document.id)}>查看资料</Button>
          </div>)}</fieldset>
          <Button disabled={busy} onClick={() => void merge(candidate, key)}>合并所选资料</Button>
        </li>;
      })}</ul>
    </>}
    <p role="status">已检查 {scanned} 篇资料</p>{cursor && <Button disabled={busy || loading} onClick={() => void more()}>继续检查</Button>}
    <section aria-label="合并历史"><h3>合并历史</h3>{history.length ? <ul className="study-history-list">{history.map((record) => <li key={record.id}><span>{record.sourceTitle || "原资料"} → {record.keepTitle || "保留资料"}<small>{date(record.createdAt)}{record.undone ? " · 已撤回" : ""}</small></span><div className="study-actions"><Button onClick={() => onOpenDocument(record.keepId)}>查看资料</Button><Button disabled={busy || record.undone} onClick={() => void undo(record)}>撤回合并</Button></div></li>)}</ul> : <p>尚无合并记录。</p>}</section>
  </section>;
}

export function StudyWorkspace({ onOpenDocument, currentDocumentId, onDirtyChange }: { onOpenDocument: OpenDocument; currentDocumentId?: string; onDirtyChange?: (value: boolean) => void }) {
  const dialogs = useDialogs();
  const [tab, setTab] = useState<"topics" | "library" | "reviews" | "governance">("topics"), [topics, setTopics] = useState<StudyTopic[]>([]), [selected, setSelected] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0);
  const [noteDirty, setNoteDirty] = useState(false), [noteBusy, setNoteBusy] = useState(false), [libraryDirty, setLibraryDirty] = useState(false), [libraryBusy, setLibraryBusy] = useState(false);
  const [sources, setSources] = useState<Awaited<ReturnType<typeof studyApi.sourceCollections>>>([]), [sourceId, setSourceId] = useState(""), [sourceName, setSourceName] = useState(""), [sourceRefresh, setSourceRefresh] = useState(0), [copyBusy, setCopyBusy] = useState(false);
  const sourceNameEdited = useRef(false), source = sources.find((item) => item.id === sourceId) ?? sources[0];
  useEffect(() => { let active = true; void studyApi.sourceCollections().then((value) => { if (active) setSources(value); }).catch((cause) => { if (active) setError(message(cause)); }); return () => { active = false; }; }, [sourceRefresh]);
  useEffect(() => { if (!sourceNameEdited.current) setSourceName(source ? `${source.name.slice(0, 95)}（研究）` : ""); }, [source?.id, source?.name]);
  useEffect(() => { onDirtyChange?.(noteDirty || noteBusy || libraryDirty || libraryBusy || copyBusy); }, [noteDirty, noteBusy, libraryDirty, libraryBusy, copyBusy, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const navigate = async (next: () => void) => { if (noteBusy || libraryBusy || copyBusy) return; if ((noteDirty || libraryDirty) && !await dialogs.confirm("当前编辑还未保存，离开会丢弃它。", { title: noteDirty ? "未保存的专题笔记" : "未保存的主题标签", confirmLabel: "放弃并离开" })) return; next(); };
  const openDocument: OpenDocument = (id, anchor) => { void navigate(() => onOpenDocument(id, anchor)); };
  useEffect(() => { let active = true; setLoading(true); setError(""); void studyApi.listTopics().then((value) => { if (!active) return; setTopics(value); setSelected((id) => value.some((topic) => topic.id === id) ? id : value[0]?.id ?? ""); }).catch((cause) => { if (active) setError(message(cause)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [refresh]);
  const create = async () => { const name = await dialogs.prompt("给你正在研究的问题取一个名字。", { title: "新建专题", label: "专题名称", maxLength: 100 }); if (!name?.trim()) return; setError(""); try { const topic = await studyApi.createTopic(name.trim()); setSelected(topic.id); setRefresh((value) => value + 1); setTab("topics"); } catch (cause) { setError(message(cause)); } };
  const copySource = async () => { if (!source || !sourceName.trim() || copyBusy) return; setCopyBusy(true); setError(""); try { const topic = await studyApi.fromCollection(source, sourceName.trim()); setSelected(topic.id); setRefresh((value) => value + 1); setTab("topics"); } catch (cause) { setError(message(cause)); } finally { setCopyBusy(false); } };
  return <section className="study-workspace" aria-label="研究工作台"><header className="study-workspace-head"><h1>研究</h1><Button variant="primary" disabled={noteBusy || libraryBusy || copyBusy} onClick={() => void navigate(() => { void create(); })}>新建专题</Button></header><nav className="study-navigation" aria-label="研究功能">{([["topics", "专题"], ["library", "资料"], ["reviews", "复习"], ["governance", "治理"]] as const).map(([value, label]) => <Button key={value} disabled={noteBusy || libraryBusy || copyBusy} aria-current={tab === value ? "page" : undefined} onClick={() => { if (value !== tab) void navigate(() => setTab(value)); }}>{label}</Button>)}</nav>
    <div className="study-content" key={tab}>
    {error && <p className="error-text" role="alert">{error} <Button onClick={() => setRefresh((value) => value + 1)}>重新载入</Button></p>}
    {tab === "topics" && sources.length > 0 && <details className="study-copy-source"><summary>从现有集合建立专题</summary><p>复制当前资料清单，之后独立维护。</p><label>来源集合<Select value={source?.id ?? ""} disabled={copyBusy} onChange={(event) => { sourceNameEdited.current = false; setSourceId(event.target.value); }}>{sources.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.documents.length} 篇）</option>)}</Select></label><label>新研究专题名称<Input value={sourceName} maxLength={100} disabled={copyBusy} onChange={(event) => { sourceNameEdited.current = true; setSourceName(event.target.value); }} /></label>{source && <><p>当前资料（{source.documents.length} 篇）</p><ul>{source.documents.slice(0, 100).map((document) => <li key={document.id}>{document.title || "未命名资料"}</li>)}</ul>{source.documents.length > 100 && <p role="status">该集合超过单次 100 篇上限，仅预览前 100 篇。请先缩小来源清单。</p>}</>}<div className="study-actions"><Button disabled={!source || !sourceName.trim() || copyBusy || source.documents.length > 100} onClick={() => void navigate(() => { void copySource(); })}>建立研究专题</Button><Button disabled={copyBusy} onClick={() => setSourceRefresh((value) => value + 1)}>刷新来源清单</Button></div></details>}
    {tab === "topics" ? topics.length ? <div className="study-topics-layout"><aside aria-label="专题列表"><ul>{topics.map((topic) => <li key={topic.id}><Button disabled={noteBusy || libraryBusy || copyBusy} aria-pressed={selected === topic.id} onClick={() => { if (topic.id !== selected) void navigate(() => setSelected(topic.id)); }}>{topic.name}</Button></li>)}</ul></aside>{selected && <TopicDetail key={selected} topicId={selected} onOpenDocument={openDocument} onChanged={() => setRefresh((value) => value + 1)} onDirtyChange={setNoteDirty} onBusyChange={setNoteBusy} />}</div> : <p className="study-empty" role="status">{loading ? "正在载入…" : "暂无专题"}</p> : tab === "library" ? <StudyLibrary topics={topics} currentDocumentId={currentDocumentId} onOpenDocument={openDocument} onTopicChanged={() => setRefresh((value) => value + 1)} onDirtyChange={setLibraryDirty} onBusyChange={setLibraryBusy} /> : tab === "reviews" ? <StudyReviews onOpenDocument={openDocument} /> : <StudyGovernance onOpenDocument={openDocument} />}
    </div>
  </section>;
}
