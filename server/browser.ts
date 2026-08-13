import type { Browser } from "playwright";

import { CapturePipelineError, resolvePublicTarget, validateUrl } from "./url-security.js";
import { createSafeProxy } from "./safe-proxy.js";

export interface BrowserResult {
  html: string;
  finalUrl: string;
  status: number | null;
}

export function browserLaunchOptions(proxyServer: string) {
  return {
    headless: true,
    chromiumSandbox: true,
    proxy: { server: proxyServer, bypass: "<-loopback>" },
    args: [
      "--proxy-bypass-list=<-loopback>",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  };
}

async function loadInBrowser(
  input: string,
  signal: AbortSignal,
  resolveTarget: typeof resolvePublicTarget,
  deadline: number,
): Promise<BrowserResult> {
  const throwIfTimedOut = () => {
    if (signal.aborted || Date.now() >= deadline) {
      throw new CapturePipelineError("BROWSER_FAILED", "浏览器抓取超时");
    }
  };
  let proxy: Awaited<ReturnType<typeof createSafeProxy>> | undefined;
  let browser: Browser | undefined;
  let browserClose: Promise<void> | undefined;
  const closeBrowser = () => {
    if (!browser) return Promise.resolve();
    return browserClose ??= browser.close();
  };
  const closeOnAbort = () => void closeBrowser().catch(() => undefined);
  signal.addEventListener("abort", closeOnAbort, { once: true });
  try {
    await resolveTarget(input);
    throwIfTimedOut();
    const { chromium } = await import("playwright");
    throwIfTimedOut();
    proxy = await createSafeProxy(resolveTarget);
    throwIfTimedOut();
    try {
      browser = await chromium.launch({
        ...browserLaunchOptions(proxy.url),
        timeout: Math.max(1, deadline - Date.now()),
      });
    } catch (cause) {
      throwIfTimedOut();
      throw cause;
    }
    throwIfTimedOut();
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
        await resolveTarget(requestUrl);
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
    await resolveTarget(finalUrl);
    const html = await page.content();
    if (Buffer.byteLength(html) > 5 * 1024 * 1024) {
      throw new CapturePipelineError("RESPONSE_TOO_LARGE", "浏览器生成的网页超过 5 MiB");
    }
    if (proxy.limitExceeded()) {
      throw new CapturePipelineError("RESPONSE_TOO_LARGE", "浏览器抓取的网络数据超过 25 MiB");
    }
    throwIfTimedOut();
    return { html, finalUrl, status: response?.status() ?? null };
  } catch (cause) {
    if (proxy?.limitExceeded()) {
      throw new CapturePipelineError("RESPONSE_TOO_LARGE", "浏览器抓取的网络数据超过 25 MiB", { cause });
    }
    throw cause;
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    try {
      await closeBrowser();
    } finally {
      await proxy?.close();
    }
  }
}

export async function fetchWithBrowser(
  input: string,
  options: { resolveTarget?: typeof resolvePublicTarget; timeoutMs?: number } = {},
): Promise<BrowserResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new RangeError("browser timeout must be an integer from 1 to 30000 milliseconds");
  }
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await loadInBrowser(
      input,
      controller.signal,
      options.resolveTarget ?? resolvePublicTarget,
      deadline,
    );
    if (controller.signal.aborted || Date.now() >= deadline) {
      throw new CapturePipelineError("BROWSER_FAILED", "浏览器抓取超时");
    }
    return result;
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new CapturePipelineError("BROWSER_FAILED", "浏览器抓取超时", { cause });
    }
    if (cause instanceof CapturePipelineError) throw cause;
    throw new CapturePipelineError("BROWSER_FAILED", "浏览器抓取失败", { cause });
  } finally {
    clearTimeout(timer);
  }
}
