import { fetchWithBrowser } from "./browser.js";
import { extractHtml, type ExtractedPage } from "./extract.js";
import { safeFetchHtml } from "./safe-fetch.js";
import { CapturePipelineError, validateUrl } from "./url-security.js";

export interface CaptureResult extends ExtractedPage {
  finalUrl: string;
  mode: "http" | "browser";
  warning: string | null;
  rawHtml: string;
  httpStatus: number | null;
}

interface Candidate extends CaptureResult {
  length: number;
}

function candidate(
  page: ExtractedPage,
  rawHtml: string,
  finalUrl: string,
  mode: "http" | "browser",
  httpStatus: number | null,
): Candidate {
  const length = page.markdown.replace(/\s/g, "").length;
  return {
    ...page,
    finalUrl,
    mode,
    warning: length < 200 ? "正文可能不完整" : null,
    rawHtml,
    httpStatus,
    length,
  };
}

export async function captureUrl(input: string): Promise<CaptureResult> {
  const url = validateUrl(input).href;
  let staticCandidate: Candidate | null = null;
  let staticError: unknown;

  try {
    const fetched = await safeFetchHtml(url);
    staticCandidate = candidate(
      await extractHtml(fetched.html, fetched.finalUrl),
      fetched.html,
      fetched.finalUrl,
      "http",
      fetched.status,
    );
    if (staticCandidate.length >= 200) {
      const { length: _, ...result } = staticCandidate;
      return result;
    }
  } catch (cause) {
    if (cause instanceof CapturePipelineError && ["INVALID_URL", "BLOCKED_ADDRESS"].includes(cause.code)) {
      throw cause;
    }
    staticError = cause;
  }

  try {
    const fetched = await fetchWithBrowser(url);
    const browserCandidate = candidate(
      await extractHtml(fetched.html, fetched.finalUrl),
      fetched.html,
      fetched.finalUrl,
      "browser",
      fetched.status,
    );
    const best = !staticCandidate || browserCandidate.length >= staticCandidate.length
      ? browserCandidate
      : staticCandidate;
    if (best.length > 0) {
      const { length: _, ...result } = best;
      return result;
    }
  } catch (cause) {
    if (!staticCandidate?.length) {
      if (cause instanceof CapturePipelineError) throw cause;
      if (staticError instanceof CapturePipelineError) throw staticError;
      throw new CapturePipelineError("BROWSER_FAILED", "浏览器抓取失败", { cause });
    }
  }

  if (staticCandidate?.length) {
    const { length: _, ...result } = staticCandidate;
    return result;
  }
  throw new CapturePipelineError("EXTRACTION_EMPTY", "未能从网页中提取正文", { cause: staticError });
}
