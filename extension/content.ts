import Defuddle from "defuddle/full";
import { protectRenderedMath, restoreProtectedMath } from "../shared/rendered-math.js";

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const NON_DRAWING_SVG_CHILDREN = new Set(["title", "desc", "metadata"]);

/** The markup of an inline `data:image/svg+xml` source, or null when there is none. */
function inlineSvgSource(src: string) {
  const match = /^data:image\/svg\+xml([^,]*),(.*)$/isu.exec(src.trim());
  if (!match) return null;
  const [, meta, body] = match;
  try {
    return /;base64/iu.test(meta!) ? atob(body!) : decodeURIComponent(body!);
  } catch {
    return null;
  }
}

/** Whether an inline SVG draws nothing at all, which makes it a lazy-load placeholder. */
function paintsNothing(source: string) {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement as Element | null;
  if (root?.localName !== "svg") return false;
  return ![...root.children].some((child) => !NON_DRAWING_SVG_CHILDREN.has(child.localName.toLowerCase()));
}

async function extract(): Promise<ZhiyeClipResult> {
  const page = document.cloneNode(true) as Document;
  const xArticleId = /(?:^|\.)(?:x\.com|twitter\.com)$/u.test(location.hostname)
    ? /\/(?:status|article)\/(\d+)(?:\/|$)/u.exec(location.pathname)?.[1]
    : null;
  const xArticle = xArticleId
    ? [...page.querySelectorAll('[itemtype="https://schema.org/Article"]')].find((article) => (
      article.getAttribute("itemid")?.endsWith(`/article/${xArticleId}`)
    ))
    : null;
  if (xArticleId && !xArticle && (
    location.pathname.includes("/article/") || [...page.querySelectorAll<HTMLAnchorElement>('a[href*="/article/"]')].some((link) => (
      link.pathname.endsWith(`/article/${xArticleId}`)
    )) || page.querySelector('article[data-testid="tweet"]')?.querySelector('img[alt="Article cover image"]')
  )) throw new Error("X 文章正文尚未加载，请等待页面显示正文后重试。");
  if (xArticle) {
    const body = xArticle.querySelector(".x-article-body");
    if (!body || ![...body.querySelectorAll("p, li, blockquote")].some((element) => element.textContent?.trim())) {
      throw new Error("X 文章正文尚未加载，请等待页面显示正文后重试。");
    }
    page.body.replaceChildren(xArticle);
    for (const tweet of page.querySelectorAll('article[data-testid="tweet"]')) tweet.removeAttribute("data-testid");
  }
  for (const element of page.querySelectorAll("script, style, noscript, iframe, object, embed, form, input, textarea, select, [contenteditable]")) {
    const presentationOnly = element.getAttribute("contenteditable")?.toLowerCase() === "false"
      && !element.matches("script, style, noscript, iframe, object, embed, form, input, textarea, select");
    if (!presentationOnly) element.remove();
  }
  // Zhihu's GIF player covers an unhydrated animation with an `<img>` whose only
  // paint is an empty inline SVG, and parks the real picture in a sibling that is
  // hidden until it loads. Such a placeholder shows nothing, but a clip taken
  // before hydration would hand the image cache a destination it can never fetch,
  // leaving a broken image where the picture belongs. Give the placeholder the
  // sibling's picture and drop the sibling rather than un-hiding it: Defuddle
  // removes hidden elements through several channels of its own, so a sibling
  // left in place would be lost along with the figure.
  for (const element of [...page.querySelectorAll("img")]) {
    const source = inlineSvgSource(element.getAttribute("src") ?? "");
    if (!source || !paintsNothing(source)) continue;
    const picture = [...(element.parentElement?.children ?? [])].find((sibling) => (
      sibling !== element
      && sibling.localName === "img"
      && /^https?:/iu.test((sibling.getAttribute("src") ?? "").trim())
    ));
    if (!picture) {
      element.remove();
      continue;
    }
    element.setAttribute("src", picture.getAttribute("src")!);
    if (!element.getAttribute("alt")) element.setAttribute("alt", picture.getAttribute("alt") ?? "");
    picture.remove();
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
  const result = new Defuddle(page, {
    url: location.href, markdown: true, useAsync: false,
    ...(xArticle ? { contentSelector: ".x-article-body" } : {}),
  }).parse();
  const extracted = text(result.contentMarkdown) ?? text(result.content);
  const markdown = extracted && restoreProtectedMath(extracted, protectedMath);
  if (!markdown) throw new Error("页面没有可剪藏的正文，请使用织页的手动摘录。");
  const cover = text(xArticle?.querySelector('img[itemprop="image"]')?.getAttribute("src"));
  const published = text(xArticle?.querySelector('[itemprop="datePublished"]')?.getAttribute("content")) ?? text(result.published);
  return {
    title: text(xArticle?.querySelector("h1")?.textContent) ?? text(result.title) ?? text(page.title) ?? location.hostname,
    sourceUrl: location.href,
    author: text(xArticle?.querySelector('[itemprop~="author"] [itemprop="name"]')?.textContent) ?? text(result.author),
    publishedAt: published && /^\d{4}-\d{2}-\d{2}/u.test(published) ? published.slice(0, 10) : null,
    markdown: cover && /^https?:\/\/[^\s<>]+$/u.test(cover) && !markdown.includes(cover)
      ? `![文章封面](<${cover}>)\n\n${markdown}` : markdown,
  };
}

window.__ZHIYE_CLIP_RESULT__ = extract();
