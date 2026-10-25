import { resolveSourceAnchor, sourceAnchorRange, type ReaderSelection, type SourceAnchor } from "../../shared/reader-tools";
import { readerTools } from "./runtime";

export function captureReaderSelection(event?: Event) {
  const context = readerTools.getSnapshot().context, selection = window.getSelection();
  if (!context || !selection) return;
  if (selection.isCollapsed || !selection.rangeCount) {
    if (event?.target instanceof Element && event.target.closest(".markdown-preview, .cm-content, .paper-text-layer, .paper-reader-block")) readerTools.setSelection(null);
    return;
  }
  const range = selection.getRangeAt(0);
  const element = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  if (element?.closest(".cm-content")) return;
  const root = element?.closest<HTMLElement>(".reader-main .markdown-preview, .paper-text-layer, .paper-reader-block[data-reader-block]");
  if (!root || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
  const quote = selection.toString();
  if (!quote.trim()) return;
  const before = range.cloneRange(), after = range.cloneRange();
  before.selectNodeContents(root); before.setEnd(range.startContainer, range.startOffset);
  after.selectNodeContents(root); after.setStart(range.endContainer, range.endOffset);
  const page = Number(root.closest<HTMLElement>("[data-reader-page]")?.dataset.readerPage);
  const rect = range.getBoundingClientRect();
  const source: SourceAnchor["source"] = root.matches(".paper-text-layer") ? "paper-original" : root.hasAttribute("data-reader-block") ? "paper-translation" : "preview";
  readerTools.setSelection({ documentId: context.id, revision: context.revision,
    anchor: { quote, prefix: before.toString().slice(-80), suffix: after.toString().slice(0, 80), source,
      ...(page > 0 ? { pageNumber: page } : {}), ...(root.dataset.readerBlock ? { blockId: root.dataset.readerBlock } : {}) },
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
}

export function publishEditorSelection(text: string, from: number, to: number, rect: ReaderSelection["rect"]) {
  const context = readerTools.getSnapshot().context;
  if (!context || from === to) return;
  readerTools.setSelection({ documentId: context.id, revision: context.revision,
    anchor: { quote: text.slice(from, to), prefix: text.slice(Math.max(0, from - 80), from), suffix: text.slice(to, to + 80), source: "editor" }, rect });
}
export function clearEditorSelection() {
  if (readerTools.getSnapshot().selection?.anchor.source === "editor") readerTools.setSelection(null);
}

export function locateReaderAnchor(anchor: SourceAnchor) {
  if (anchor.source === "editor" && readerTools.locateEditor(anchor)) return true;
  const roots = [...document.querySelectorAll<HTMLElement>(anchor.source === "paper-original" ? ".paper-text-layer" : anchor.source === "paper-translation" ? ".paper-reader-block[data-reader-block]" : ".reader-main .markdown-preview")];
  const candidates = roots.filter((root) => (!anchor.pageNumber || Number(root.closest<HTMLElement>("[data-reader-page]")?.dataset.readerPage) === anchor.pageNumber) && (!anchor.blockId || root.dataset.readerBlock === anchor.blockId))
    .filter((root) => resolveSourceAnchor(root.textContent ?? "", anchor) !== null);
  if (candidates.length !== 1) return false;
  const root = candidates[0]!;
  const offsets = sourceAnchorRange(root.textContent ?? "", anchor)!;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0, started = false, node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!started && offsets.from < offset + length) { range.setStart(node, offsets.from - offset); started = true; }
    if (started && offsets.to <= offset + length) { range.setEnd(node, offsets.to - offset); break; }
    offset += length;
  }
  if (!started || !node) return false;
  const target = range.startContainer.parentElement;
  target?.scrollIntoView({ block: "center", behavior: "auto" });
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  return true;
}

export async function revealReaderAnchor(anchor: SourceAnchor) {
  if (locateReaderAnchor(anchor)) return true;
  const context = readerTools.getSnapshot().context;
  if (!context || !anchor.pageNumber || !anchor.source.startsWith("paper-")) return false;
  const request = new CustomEvent("zhiye:reveal-paper-page", { cancelable: true, detail: { documentId: context.id, pageNumber: anchor.pageNumber } });
  window.dispatchEvent(request);
  if (!request.defaultPrevented) return false;
  return new Promise<boolean>((resolve) => {
    const finish = (found: boolean) => { observer.disconnect(); clearTimeout(timer); unsubscribe(); resolve(found); };
    const observer = new MutationObserver(() => { if (locateReaderAnchor(anchor)) finish(true); });
    const timer = window.setTimeout(() => finish(false), 5000);
    const unsubscribe = readerTools.subscribe(() => { if (readerTools.getSnapshot().context?.id !== context.id) finish(false); });
    observer.observe(document.querySelector(".paper-reader") ?? document.body, { childList: true, subtree: true });
    if (locateReaderAnchor(anchor)) finish(true);
  });
}
