import { CapturePipelineError, resolvePublicTarget, validateUrl } from "./url-security.js";
import { createSafeProxy } from "./safe-proxy.js";

export interface BrowserResult {
  html: string;
  finalUrl: string;
  status: number | null;
}

async function loadInBrowser(input: string, signal: AbortSignal): Promise<BrowserResult> {
  await resolvePublicTarget(input);
  if (signal.aborted) throw new CapturePipelineError("BROWSER_FAILED", "浏览器抓取超时");
  const { chromium } = await import("playwright");
  const proxy = await createSafeProxy();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const closeOnAbort = () => void browser?.close();
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: { server: proxy.url, bypass: "<-loopback>" },
      args: ["--proxy-bypass-list=<-loopback>"],
    });
    signal.addEventListener("abort", closeOnAbort, { once: true });
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    await context.clearPermissions();
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (!requestUrl.startsWith("http://") && !requestUrl.startsWith("https://")) {
        await route.abort("blockedbyclient");
        return;
      }
      try {
        await resolvePublicTarget(requestUrl);
        if (["font", "image", "media"].includes(route.request().resourceType())) {
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });

    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.dismiss());
    const response = await page.goto(validateUrl(input).href, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });
    if (response && (response.status() < 200 || response.status() >= 300)) {
      throw new CapturePipelineError("HTTP_ERROR", `网页返回 HTTP ${response.status()}`);
    }
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
    const finalUrl = validateUrl(page.url()).href;
    await resolvePublicTarget(finalUrl);
    const html = await page.content();
    if (Buffer.byteLength(html) > 5 * 1024 * 1024) {
      throw new CapturePipelineError("RESPONSE_TOO_LARGE", "浏览器生成的网页超过 5 MiB");
    }
    if (proxy.limitExceeded()) {
      throw new CapturePipelineError("RESPONSE_TOO_LARGE", "浏览器抓取的网络数据超过 25 MiB");
    }
    return { html, finalUrl, status: response?.status() ?? null };
  } catch (cause) {
    if (proxy.limitExceeded()) {
      throw new CapturePipelineError("RESPONSE_TOO_LARGE", "浏览器抓取的网络数据超过 25 MiB", { cause });
    }
    throw cause;
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    await browser?.close();
    await proxy.close();
  }
}

export async function fetchWithBrowser(input: string): Promise<BrowserResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      loadInBrowser(input, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new CapturePipelineError("BROWSER_FAILED", "浏览器抓取超时"));
        }, 30_000);
      }),
    ]);
  } catch (cause) {
    if (cause instanceof CapturePipelineError) throw cause;
    throw new CapturePipelineError("BROWSER_FAILED", "浏览器抓取失败", { cause });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
