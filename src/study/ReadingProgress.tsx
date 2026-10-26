import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ReadingProgress as Progress } from "../../shared/study-types";
import { currentDataEpoch } from "../api";
import { useToast } from "../components/ui/Feedback";
import { readerTools } from "../reader-tools/runtime";
import { studyApi } from "./api";

const panes = ".reader-main, .preview-pane, .cm-scroller, .cloud-reader, .cloud-article-body, .paper-reader-pdf-scroll, .paper-reader-translation-scroll";
const writes = new Map<string, Promise<void>>();
function paneFraction(pane: HTMLElement) { return Math.max(0, Math.min(1, pane.scrollTop / Math.max(1, pane.scrollHeight - pane.clientHeight))); }
function paperPages() { return [...document.querySelectorAll<HTMLButtonElement>(".reader-main .paper-reader-pages button")]; }
function fractionAt(pane: HTMLElement, paper: boolean) {
  const local = paneFraction(pane);
  if (!paper) return local;
  const pages = paperPages(), index = pages.findIndex((button) => button.getAttribute("aria-current") === "page");
  return pages.length && index >= 0 ? (index + local) / pages.length : local;
}
const conflict = (cause: unknown) => cause instanceof Error && "status" in cause && cause.status === 409 && !("code" in cause && ["STALE_DATA_EPOCH", "DATA_CHANGED"].includes(String(cause.code)));

export function ReadingProgress({ documentId, restorePosition }: { documentId: string; restorePosition: boolean }) {
  const context = useSyncExternalStore(readerTools.subscribe, readerTools.getSnapshot).context;
  const current = useRef(context); current.current = context;
  const visit = useRef<{ id: string; restored: boolean; fraction: number | null } | null>(null);
  const attemptRestore = useRef<(() => void) | null>(null);
  const toast = useToast(), notify = useRef(toast.error); notify.current = toast.error;
  useEffect(() => {
    if (visit.current?.id !== documentId) visit.current = null;
    if (!context || context.id !== documentId) return;
    const selected = context, epoch = currentDataEpoch(), paper = selected.kind === "paper";
    const continuing = visit.current?.id === selected.id;
    if (visit.current?.id !== selected.id) visit.current = { id: selected.id, restored: false, fraction: null };
    const entry = visit.current;
    let active = true, record: Progress | null = null, loaded = false, errorShown = false;
    let pending: number | null = null, timer = 0, frame = 0, restoreTimer = 0;
    let restoring = false, restorePending = restorePosition && !entry.restored, interacted = false;
    let queue = Promise.resolve();
    const validEpoch = () => currentDataEpoch() === epoch;
    const reading = () => active && validEpoch() && current.current?.id === selected.id && current.current.revision === selected.revision && !current.current.blockedReason;
    const report = (cause: unknown) => { if (active && !errorShown) { errorShown = true; notify.current(cause instanceof Error ? cause.message : "未能保存阅读位置，请稍后重试。"); } };
    const ready = (writes.get(selected.id) ?? Promise.resolve()).then(() => validEpoch() ? studyApi.progress(selected.id) : null).then((value) => {
      if (!validEpoch()) return;
      record = value; loaded = true;
      if (active && continuing && !interacted && entry.fraction !== null && (record?.documentRevision !== selected.revision || Math.abs(record.fraction - entry.fraction) >= .01)) enqueue(entry.fraction);
      scheduleRestore();
    }).catch((cause) => { stopRestore(); report(cause); });
    const enqueue = (fraction: number) => {
      queue = queue.catch(() => undefined).then(async () => {
        if (!validEpoch()) return;
        try {
          await ready;
          if (!validEpoch()) return;
          if (!loaded) { record = await studyApi.progress(selected.id); loaded = true; }
          if (!validEpoch()) return;
          const send = () => studyApi.saveProgress(selected.id, { documentRevision: selected.revision, revision: record?.revision ?? 0, fraction, anchor: null, read: fraction >= .95 || record?.read === true });
          let result: Progress;
          try { result = await send(); }
          catch (cause) {
            if (!conflict(cause)) throw cause;
            record = await studyApi.progress(selected.id);
            if (!validEpoch()) return;
            result = await send();
          }
          if (validEpoch()) { record = result; errorShown = false; window.dispatchEvent(new Event("zhiye:study-progress-changed")); }
        } catch (cause) { report(cause); }
      });
      const writing = queue;
      writes.set(selected.id, writing);
      void writing.finally(() => { if (writes.get(selected.id) === writing) writes.delete(selected.id); });
    };
    const flush = () => { clearTimeout(timer); timer = 0; const fraction = pending; pending = null; if (fraction !== null) enqueue(fraction); };
    const root = document.querySelector<HTMLElement>(".reader-main");
    const observer = new MutationObserver(() => scheduleRestore());
    const resize = new ResizeObserver(() => scheduleRestore());
    function stopRestore(complete = true) {
      if (active && complete) entry.restored = true;
      restorePending = false; restoring = false;
      clearTimeout(restoreTimer); cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect();
      root?.removeEventListener("load", scheduleRestore, true);
    }
    function scheduleRestore() {
      if (!active || !restorePending || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; tryRestore(); });
    }
    attemptRestore.current = scheduleRestore;
    function tryRestore() {
      if (!reading() || !loaded || !restorePending) return;
      if (interacted || !record || record.fraction === 0) { stopRestore(); return; }
      let fraction = record.fraction;
      if (paper) {
        const pages = paperPages();
        if (!pages.length) return;
        const index = Math.min(pages.length - 1, Math.floor(fraction * pages.length));
        fraction = Math.min(1, fraction * pages.length - index);
        if (pages[index]?.getAttribute("aria-current") !== "page") { restoring = true; pages[index]?.click(); return; }
        if (!root?.querySelector(`canvas[data-rendered-page="${index + 1}"]`) && !root?.querySelector(".paper-reader-pdf-error")) return;
      } else if (!root?.querySelector(".markdown-preview, .cm-content")) return;
      const candidates = [...(root?.querySelectorAll<HTMLElement>(paper ? ".paper-reader-pdf-scroll, .paper-reader-translation-scroll" : ".preview-pane, .cm-scroller, .cloud-reader, .cloud-article-body") ?? [])].filter((pane) => pane.getClientRects().length);
      const source = candidates.find((pane) => pane.scrollHeight > pane.clientHeight) ?? candidates[0] ?? root;
      if (!source) return;
      restoring = true;
      for (const pane of paper ? candidates : [source]) pane.scrollTop = fraction * Math.max(0, pane.scrollHeight - pane.clientHeight);
      // Ignore the scroll event generated by restoration, then leave tracking active.
      frame = requestAnimationFrame(() => { frame = 0; stopRestore(); });
    }
    const capture = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement) || !target.matches(panes) || !target.closest(".reader-main") || !reading() || restoring || restorePending || !interacted) return;
      const fraction = Math.round(fractionAt(target, paper) * 1000) / 1000;
      entry.fraction = fraction;
      if (record?.documentRevision === selected.revision && Math.abs(record.fraction - fraction) < .01) return;
      pending = fraction;
      if (!timer) timer = window.setTimeout(flush, 800);
    };
    const scroll = (event: Event) => capture(event.target);
    const intent = (event: Event) => {
      if (event instanceof KeyboardEvent && !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      if (!(event.target instanceof Element) || !event.target.closest(".reader-panel")) return;
      interacted = true; stopRestore();
    };
    const anchor = (event: Event) => { if ((event as CustomEvent<{ documentId: string }>).detail.documentId === selected.id) { interacted = true; stopRestore(); } };
    const page = (event: MouseEvent) => {
      if (!paper || restoring || !(event.target instanceof Element) || !event.target.closest(".paper-reader-pages button, .paper-reader-page-toolbar button")) return;
      interacted = true; stopRestore();
      frame = requestAnimationFrame(() => { frame = 0; capture(root?.querySelector(".paper-reader-pdf-scroll") ?? null); });
    };
    if (root && restorePending) {
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-rendered-page", "aria-current"] });
      resize.observe(root); root.addEventListener("load", scheduleRestore, true);
      restoreTimer = window.setTimeout(stopRestore, 10_000);
    }
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("click", page);
    for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) document.addEventListener(name, intent, { capture: true, passive: true });
    window.addEventListener("zhiye:reader-anchor", anchor);
    return () => {
      // Flush the last captured position to its original document even on a quick tab switch.
      active = false; stopRestore(false); flush();
      if (attemptRestore.current === scheduleRestore) attemptRestore.current = null;
      document.removeEventListener("scroll", scroll, true); document.removeEventListener("click", page);
      for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) document.removeEventListener(name, intent, true);
      window.removeEventListener("zhiye:reader-anchor", anchor);
    };
  }, [documentId, context?.id, context?.revision, restorePosition]);
  useEffect(() => { attemptRestore.current?.(); }, [context?.blockedReason]);
  return null;
}
