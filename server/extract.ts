import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";

export const EXTRACTOR_VERSION = "defuddle@0.19.2";

export interface ExtractedPage {
  extractorVersion: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  canonicalUrl: string;
  markdown: string;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function extractHtml(html: string, sourceUrl: string): Promise<ExtractedPage> {
  const { document } = parseHTML(html);
  const canonicalHref = document.querySelector('link[rel~="canonical"]')?.getAttribute("href");
  for (const element of document.querySelectorAll(
    'link[rel~="canonical"][href], meta[property="og:url"][content], meta[property="twitter:url"][content]',
  )) {
    const attribute = element.localName === "link" ? "href" : "content";
    const value = element.getAttribute(attribute);
    if (!value) continue;
    try {
      element.setAttribute(attribute, new URL(value, sourceUrl).href);
    } catch {
      // Invalid publisher metadata is ignored by the extractor.
    }
  }
  const result = await Defuddle(document as unknown as Document, sourceUrl, {
    markdown: true,
    useAsync: false,
  });
  let canonicalUrl = sourceUrl;
  if (canonicalHref) {
    try {
      const candidate = new URL(canonicalHref, sourceUrl);
      if (candidate.protocol === "http:" || candidate.protocol === "https:") canonicalUrl = candidate.href;
    } catch {
      // Invalid publisher metadata is ignored.
    }
  }
  return {
    extractorVersion: EXTRACTOR_VERSION,
    title: optionalText(result.title) ?? optionalText(document.title) ?? new URL(sourceUrl).hostname,
    author: optionalText(result.author),
    publishedAt: optionalText(result.published),
    canonicalUrl,
    markdown: optionalText(result.content) ?? "",
  };
}
