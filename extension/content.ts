import Defuddle from "defuddle/full";
import { protectRenderedMath, restoreProtectedMath } from "../shared/rendered-math.js";

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const NON_DRAWING_SVG_CHILDREN = new Set(["title", "desc", "metadata"]);
const X_ARTICLE_BODY = '.x-article-body, [data-testid="twitterArticleRichTextView"]';

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
  let xArticle = xArticleId
    ? [...page.querySelectorAll('[itemtype="https://schema.org/Article"]')].find((article) => (
      article.getAttribute("itemid")?.endsWith(`/article/${xArticleId}`)
    ))
    : null;
  if (xArticleId && !xArticle) {
    const readers = [...page.querySelectorAll('[data-testid="twitterArticleRichTextView"]')].flatMap((body) => {
      const root = body.closest('[data-testid="twitterArticleReadView"]')
        ?? body.closest('article[data-testid="tweet"], [data-testid="cellInnerDiv"]') ?? body.parentElement;
      return root ? [root] : [];
    })
      .filter((root) => !root.closest('aside, [hidden], [aria-hidden="true"]'));
    xArticle = readers.find((root) => {
      const scope = root.closest('article[data-testid="tweet"], [data-testid="cellInnerDiv"]') ?? root;
      return [...scope.querySelectorAll<HTMLAnchorElement>("a[href]")].some((link) => (
        (link.pathname.endsWith(`/status/${xArticleId}`) && !link.closest(X_ARTICLE_BODY))
        || (location.pathname.includes("/article/") && (link.pathname.endsWith(`/article/${xArticleId}`)
          || (link.pathname.includes(`/article/${xArticleId}/media/`) && link.querySelector("img"))))
      ));
    }) ?? (readers.length === 1 && readers[0]!.closest('main, [data-testid="primaryColumn"]')
      && !readers[0]!.closest('article[data-testid="tweet"], [data-testid="cellInnerDiv"]')
      && ![...readers[0]!.querySelectorAll<HTMLAnchorElement>("a[href]")].some((link) => (
        /\/(?:status|article)\/\d+/u.test(link.pathname) && !link.closest(X_ARTICLE_BODY)
      )) ? readers[0] : null);
  }
  if (xArticleId && !xArticle) {
    // X also renders longform without schema metadata. Match its own title and
    // current post/cover links so a quoted or recommended article cannot win.
    const candidates = [...page.querySelectorAll(".x-article-body")].flatMap((body) => {
      const root = body.parentElement;
      return root?.querySelector(":scope > h1") ? [root] : [];
    });
    xArticle = candidates.find((root) => [...root.querySelectorAll<HTMLAnchorElement>("a[href]")].some((link) => (
      (link.pathname.endsWith(`/status/${xArticleId}`) && !link.closest(".x-article-body"))
      || (link.pathname.includes(`/article/${xArticleId}/media/`) && link.querySelector("img"))
    ))) ?? (location.pathname.includes("/article/") && candidates.length === 1
      && !candidates[0]!.querySelector('a[href*="/article/"]') ? candidates[0] : null);
  }
  if (xArticleId && !xArticle && (
    location.pathname.includes("/article/") || page.querySelector('[data-testid="twitterArticleReadView"], [data-testid="twitterArticleRichTextView"]')
    || [...page.querySelectorAll<HTMLAnchorElement>('a[href*="/article/"]')].some((link) => (
      link.pathname.endsWith(`/article/${xArticleId}`)
    )) || page.querySelector('article[data-testid="tweet"]')?.querySelector('img[alt="Article cover image"]')
  )) throw new Error("X 文章正文尚未加载，请等待页面显示正文后重试。");
  if (xArticle) {
    const body = xArticle.querySelector(X_ARTICLE_BODY);
    if (!body) throw new Error("X 文章正文尚未加载，请等待页面显示正文后重试。");
    // Draft.js marks the published reader (and code blocks) read-only. It is
    // article content, so keep it out of the formula/control cleanup below.
    for (const element of [body, ...body.querySelectorAll("[contenteditable]")]) {
      if (element.getAttribute("contenteditable")?.toLowerCase() === "false") element.removeAttribute("contenteditable");
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
  const xBody = xArticle?.querySelector(X_ARTICLE_BODY);
  if (xArticle && (!xBody || ![...xBody.querySelectorAll("p, li, blockquote, pre, .longform-unstyled, .public-DraftStyleDefault-block")]
    .some((element) => element.textContent?.trim()))) {
    throw new Error("X 文章正文尚未加载，请等待页面显示正文后重试。");
  }
  const result = new Defuddle(page, {
    url: location.href, markdown: true, useAsync: false,
    ...(xArticle ? { contentSelector: ".x-article-body", removeLowScoring: false, removeContentPatterns: false } : {}),
  }).parse();
  const extracted = text(result.contentMarkdown) ?? text(result.content);
  const markdown = extracted && restoreProtectedMath(extracted, protectedMath);
  if (!markdown) throw new Error("页面没有可剪藏的正文，请使用织页的手动摘录。");
  const cover = text((xArticle?.querySelector('img[itemprop="image"]')
    ?? xArticle?.querySelector(":scope > img, :scope > a > img")
    ?? [...(xArticle?.querySelectorAll('[data-testid="tweetPhoto"] img') ?? [])].find((image) => !image.closest(X_ARTICLE_BODY)))?.getAttribute("src"));
  // The native extractor upgrades the same twimg asset from medium to large.
  const hasCover = cover && (markdown.includes(cover) || (
    xBody?.matches('[data-testid="twitterArticleRichTextView"]') && /^https:\/\/pbs\.twimg\.com\/media\//u.test(cover)
    && markdown.includes(cover.split("?")[0]!)
  ));
  const published = text(xArticle?.querySelector('[itemprop="datePublished"]')?.getAttribute("content")) ?? text(result.published);
  return {
    title: text(xArticle?.querySelector('[data-testid="twitter-article-title"]')?.textContent)
      ?? text(xArticle?.querySelector("h1")?.textContent) ?? text(result.title) ?? text(page.title) ?? location.hostname,
    sourceUrl: location.href,
    author: text(xArticle?.querySelector('[itemprop~="author"] [itemprop="name"]')?.textContent) ?? text(result.author),
    publishedAt: published && /^\d{4}-\d{2}-\d{2}/u.test(published) ? published.slice(0, 10) : null,
    markdown: cover && /^https?:\/\/[^\s<>]+$/u.test(cover) && !hasCover
      ? `![文章封面](<${cover}>)\n\n${markdown}` : markdown,
  };
}

window.__ZHIYE_CLIP_RESULT__ = extract();
