import Defuddle from "defuddle/full";

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function extract(): Promise<ZhiyeClipResult> {
  const page = document.cloneNode(true) as Document;
  page.querySelectorAll("script, style, noscript, iframe, object, embed, form, input, textarea, select, button, [contenteditable]")
    .forEach((element) => element.remove());
  const result = new Defuddle(page, { url: location.href, markdown: true, useAsync: false }).parse();
  const markdown = text(result.contentMarkdown) ?? text(result.content);
  if (!markdown) throw new Error("页面没有可剪藏的正文，请使用织页的手动摘录。");
  const published = text(result.published);
  return {
    title: text(result.title) ?? text(page.title) ?? location.hostname,
    sourceUrl: location.href,
    author: text(result.author),
    publishedAt: published && /^\d{4}-\d{2}-\d{2}/u.test(published) ? published.slice(0, 10) : null,
    markdown,
  };
}

window.__ZHIYE_CLIP_RESULT__ = extract();

