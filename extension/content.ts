import Defuddle from "defuddle/full";
import { protectRenderedMath, restoreProtectedMath } from "../shared/rendered-math.js";

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function extract(): Promise<ZhiyeClipResult> {
  const page = document.cloneNode(true) as Document;
  for (const element of page.querySelectorAll("script, style, noscript, iframe, object, embed, form, input, textarea, select, [contenteditable]")) {
    const presentationOnly = element.getAttribute("contenteditable")?.toLowerCase() === "false"
      && !element.matches("script, style, noscript, iframe, object, embed, form, input, textarea, select");
    if (!presentationOnly) element.remove();
  }
  const protectedMath = protectRenderedMath(page);
  for (const element of page.querySelectorAll("button, [contenteditable]")) {
    if (!page.documentElement.contains(element)) continue;
    if (element.localName !== "button" && element.getAttribute("contenteditable")?.toLowerCase() !== "false") continue;
    const content = element.textContent ?? "";
    const formulas = protectedMath.filter(({ token }) => content.includes(token)).sort((left, right) => content.indexOf(left.token) - content.indexOf(right.token));
    if (formulas.length) element.replaceWith(page.createTextNode(formulas.map(({ token }) => token).join("\n\n")));
    else {
      const math = (element.matches("math") ? [element] : [...element.querySelectorAll("math")]).filter((value) => (
        !value.parentElement?.closest("math")
        && !value.getAttribute("data-latex")?.trim()
        && !value.getAttribute("alttext")?.trim()
        && ![...value.querySelectorAll("annotation[encoding]")].some((annotation) => (
          annotation.getAttribute("encoding")?.toLowerCase() === "application/x-tex" && annotation.textContent?.trim()
        ))
      ));
      if (math.length) element.replaceWith(...math.map((value) => {
        const clone = value.cloneNode(true) as Element;
        if (!clone.hasAttribute("display")) clone.setAttribute("display", value.closest(".katex-display, .MathJax_Display") ? "block" : "inline");
        return clone;
      }));
      else element.remove();
    }
  }
  const result = new Defuddle(page, { url: location.href, markdown: true, useAsync: false }).parse();
  const extracted = text(result.contentMarkdown) ?? text(result.content);
  const markdown = extracted && restoreProtectedMath(extracted, protectedMath);
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
