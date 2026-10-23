import type { PaperDocument } from "../shared/types";

export function paperTranslationMarkdown(paper: PaperDocument) {
  const pages = [...paper.pages].sort((a, b) => a.pageNumber - b.pageNumber);
  if (paper.status !== "ready" || !paper.pageCount || pages.length !== paper.pageCount || pages.some((page, index) => page.pageNumber !== index + 1 || !page.translationBlocks.length || page.translationBlocks.some((block) => !block.translation.trim()))) {
    throw new Error("中文对照尚不完整，请完成所有页面后再整理为文章。");
  }
  return pages.map((page) => `## 第 ${page.pageNumber} 页\n\n${page.translationBlocks.map((block) => block.type === "heading" ? `### ${block.translation}` : block.translation).join("\n\n")}`).join("\n\n");
}
