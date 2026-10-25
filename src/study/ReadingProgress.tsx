import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReadingProgress as Progress } from "../../shared/study-types";
import { Button } from "../components/ui/Controls";
import { readerTools, type ReaderContext } from "../reader-tools/runtime";
import { studyApi } from "./api";

const panes = ".reader-main, .preview-pane, .cm-scroller, .cloud-reader, .cloud-article-body, .paper-reader-pdf-scroll, .paper-reader-translation-scroll";
type Intent = { context: ReaderContext; fraction: number; read?: boolean };
function paneFraction(pane: HTMLElement) { return Math.max(0, Math.min(1, pane.scrollTop / Math.max(1, pane.scrollHeight - pane.clientHeight))); }
function paperPages() { return [...document.querySelectorAll<HTMLButtonElement>(".reader-main .paper-reader-pages button")]; }
function fractionAt(pane: HTMLElement, context: ReaderContext) {
  const local = paneFraction(pane);
  if (context.kind !== "paper") return local;
  const pages = paperPages(), index = pages.findIndex((button) => button.getAttribute("aria-current") === "page");
  return pages.length && index >= 0 ? (index + local) / pages.length : local;
}
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : "未能保存阅读位置，请重试。";
const conflict = (cause: unknown) => cause instanceof Error && "status" in cause && cause.status === 409 && !("code" in cause && ["STALE_DATA_EPOCH", "DATA_CHANGED"].includes(String(cause.code)));

export function ReadingProgress() {
  const context = useSyncExternalStore(readerTools.subscribe, readerTools.getSnapshot).context;
  const current = useRef(context); current.current = context;
  const record = useRef<Progress | null>(null), loaded = useRef(false), generation = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve()), pending = useRef<Intent | null>(null), timer = useRef(0), activePane = useRef<HTMLElement | null>(null), restoring = useRef(false);
  const [progress, setProgress] = useState<Progress | null>(null), [error, setError] = useState(""), [saving, setSaving] = useState(false), [refresh, setRefresh] = useState(0);
  const matches = (target: ReaderContext) => current.current?.id === target.id && current.current.revision === target.revision && !current.current.blockedReason;
  const enqueue = (intent: Intent) => {
    const epoch = generation.current;
    queue.current = queue.current.catch(() => undefined).then(async () => {
      if (!matches(intent.context) || epoch !== generation.current) return;
      setSaving(true);
      try {
        if (!loaded.current) { const value = await studyApi.progress(intent.context.id); if (!matches(intent.context) || epoch !== generation.current) return; record.current = value; loaded.current = true; }
        if (!matches(intent.context) || epoch !== generation.current) return;
        const send = () => studyApi.saveProgress(intent.context.id, { documentRevision: intent.context.revision, revision: record.current?.revision ?? 0, fraction: intent.fraction, anchor: null, read: intent.read ?? (intent.fraction >= .95 || record.current?.read === true) });
        let result: Progress;
        try { result = await send(); }
        catch (cause) {
          if (!conflict(cause)) throw cause;
          const value = await studyApi.progress(intent.context.id);
          if (!matches(intent.context) || epoch !== generation.current) return;
          record.current = value;
          result = await send();
        }
        if (matches(intent.context) && epoch === generation.current) { record.current = result; setProgress(result); setError(""); window.dispatchEvent(new Event("zhiye:study-progress-changed")); }
      } catch (cause) { if (matches(intent.context) && epoch === generation.current) setError(errorMessage(cause)); }
      finally { if (epoch === generation.current) setSaving(false); }
    });
  };
  useEffect(() => {
    const epoch = ++generation.current;
    record.current = null; loaded.current = false; activePane.current = null; pending.current = null; clearTimeout(timer.current); timer.current = 0;
    setProgress(null); setError(""); setSaving(false);
    if (!context) return;
    let active = true;
    void studyApi.progress(context.id).then((value) => { if (active && epoch === generation.current && !loaded.current) { record.current = value; loaded.current = true; setProgress(value); } }).catch((cause) => { if (active && epoch === generation.current && !loaded.current) setError(errorMessage(cause)); });
    return () => { active = false; generation.current += 1; clearTimeout(timer.current); timer.current = 0; pending.current = null; };
  }, [context?.id, context?.revision, refresh]);
  useEffect(() => {
    const capture = (target: EventTarget | null) => {
      const selected = current.current;
      if (!(target instanceof HTMLElement) || !target.matches(panes) || !target.closest(".reader-main") || !selected || selected.blockedReason || restoring.current) return;
      activePane.current = target;
      const fraction = Math.round(fractionAt(target, selected) * 1000) / 1000;
      if (record.current?.documentRevision === selected.revision && Math.abs(record.current.fraction - fraction) < .01) return;
      pending.current = { context: selected, fraction };
      if (!timer.current) timer.current = window.setTimeout(() => { timer.current = 0; const value = pending.current; pending.current = null; if (value) enqueue(value); }, 800);
    };
    const scroll = (event: Event) => capture(event.target);
    let frame = 0;
    const page = (event: MouseEvent) => { if (current.current?.kind !== "paper" || !(event.target instanceof Element) || !event.target.closest(".paper-reader-pages button, .paper-reader-page-toolbar button")) return; cancelAnimationFrame(frame); frame = requestAnimationFrame(() => capture(activePane.current?.isConnected ? activePane.current : document.querySelector(".reader-main .paper-reader-pdf-scroll"))); };
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("click", page);
    return () => { document.removeEventListener("scroll", scroll, true); document.removeEventListener("click", page); cancelAnimationFrame(frame); clearTimeout(timer.current); timer.current = 0; pending.current = null; };
  }, []);
  const mark = (read: boolean) => {
    const selected = current.current; if (!selected || selected.blockedReason) return;
    clearTimeout(timer.current); timer.current = 0;
    const latest = pending.current; pending.current = null;
    enqueue({ context: selected, fraction: latest?.context.id === selected.id ? latest.fraction : record.current?.fraction ?? 0, read });
  };
  const restore = async () => {
    const selected = current.current, saved = record.current;
    if (!selected || selected.blockedReason || !saved) return;
    const epoch = generation.current;
    restoring.current = true;
    try {
      let fraction = saved.fraction;
      if (selected.kind === "paper") {
        const pages = paperPages();
        if (pages.length) { const index = Math.min(pages.length - 1, Math.floor(saved.fraction * pages.length)); pages[index]?.click(); fraction = saved.fraction * pages.length - index; }
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!matches(selected) || epoch !== generation.current) return;
      const source = activePane.current?.isConnected ? activePane.current : [...document.querySelectorAll<HTMLElement>(selected.kind === "paper" ? ".reader-main .paper-reader-pdf-scroll, .reader-main .paper-reader-translation-scroll" : ".reader-main .preview-pane, .reader-main .cm-scroller, .reader-main .cloud-reader, .reader-main .cloud-article-body")].find((pane) => pane.getClientRects().length) ?? document.querySelector<HTMLElement>(".reader-main");
      if (source) source.scrollTop = fraction * Math.max(0, source.scrollHeight - source.clientHeight);
    } finally { requestAnimationFrame(() => { restoring.current = false; }); }
  };
  if (!context) return null;
  return <div className="study-reading-progress" aria-label="阅读进度">
    <span>{progress?.read ? "已读" : "未读"}{progress ? ` · ${Math.round(progress.fraction * 100)}%` : ""}</span>
    <Button density="compact" disabled={!progress || Boolean(context.blockedReason) || saving} onClick={() => void restore()}>恢复阅读位置</Button>
    <Button density="compact" disabled={Boolean(context.blockedReason) || saving} onClick={() => mark(!progress?.read)}>{progress?.read ? "标为未读" : "标为已读"}</Button>
    {saving && <small role="status">保存位置…</small>}
    {progress && progress.documentRevision !== context.revision && <small>原文已更新，记录的是此前的阅读位置。</small>}
    {error && <span role="status" className="error-text">{error}<Button density="compact" onClick={() => setRefresh((value) => value + 1)}>重新载入</Button></span>}
  </div>;
}
