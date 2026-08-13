import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { CapturePipelineError, resolvePublicTarget } from "./url-security.js";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;

export interface FetchResult {
  html: string;
  finalUrl: string;
  status: number;
}

export interface BinaryFetchResult {
  body: Buffer;
  contentType: string;
  finalUrl: string;
  status: number;
}

export interface BinaryFetchOptions {
  maxBytes: number;
  resolveTarget?: typeof resolvePublicTarget;
}

function decodedStream(response: IncomingMessage): Readable {
  const encoding = response.headers["content-encoding"]?.toLowerCase().trim();
  if (!encoding || encoding === "identity") return response;
  if (encoding === "gzip" || encoding === "x-gzip") return response.pipe(createGunzip());
  if (encoding === "deflate") return response.pipe(createInflate());
  if (encoding === "br") return response.pipe(createBrotliDecompress());
  response.destroy();
  throw new CapturePipelineError("UNSUPPORTED_CONTENT_TYPE", `不支持响应编码: ${encoding}`);
}

async function readHtml(response: IncomingMessage, contentType: string): Promise<string> {
  const stream = decodedStream(response);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > MAX_BYTES) {
      stream.destroy();
      throw new CapturePipelineError("RESPONSE_TOO_LARGE", "网页解压后超过 5 MiB");
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const headerCharset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1];
  const metaCharset = /<meta[^>]+charset\s*=\s*["']?([^"'\s/>]+)/i.exec(body.subarray(0, 4096).toString("latin1"))?.[1];
  try {
    return new TextDecoder(headerCharset || metaCharset || "utf-8").decode(body);
  } catch {
    return body.toString("utf8");
  }
}

function requestOnce(
  url: URL,
  address: string,
  family: 4 | 6,
  timeout: number,
  signal: AbortSignal,
  headers: Record<string, string>,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      family,
      headers,
      lookup: (_hostname, _options, callback) => callback(null, address, family),
      signal,
    }, resolve);
    request.setTimeout(timeout, () => request.destroy(
      new CapturePipelineError("FETCH_TIMEOUT", "网页抓取超时"),
    ));
    request.once("error", reject);
    request.end();
  });
}

async function fetchHtml(
  input: string | URL,
  signal: AbortSignal,
  resolveTarget: typeof resolvePublicTarget,
): Promise<FetchResult> {
  const deadline = Date.now() + TIMEOUT_MS;
  let current = input;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const target = await resolveTarget(current);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CapturePipelineError("FETCH_TIMEOUT", "网页抓取超时");
    const response = await requestOnce(target.url, target.address, target.family, remaining, signal, {
      Accept: "text/html,application/xhtml+xml;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "User-Agent": "Zhiye/0.1 (+local knowledge capture)",
    }).catch((cause: unknown) => {
      if (cause instanceof CapturePipelineError) throw cause;
      throw new CapturePipelineError("HTTP_ERROR", "网页请求失败", { cause });
    });
    const status = response.statusCode ?? 0;
    const location = response.headers.location;

    if (status >= 300 && status < 400 && location) {
      response.destroy();
      if (redirect === MAX_REDIRECTS) {
        throw new CapturePipelineError("HTTP_ERROR", `网页重定向超过 ${MAX_REDIRECTS} 次`);
      }
      try {
        current = new URL(location, target.url);
      } catch (cause) {
        throw new CapturePipelineError("HTTP_ERROR", "网页返回了无效的重定向 URL", { cause });
      }
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new CapturePipelineError("HTTP_ERROR", `网页返回 HTTP ${status}`);
    }

    const contentLength = Number(response.headers["content-length"] ?? 0);
    if (contentLength > MAX_BYTES) {
      response.destroy();
      throw new CapturePipelineError("RESPONSE_TOO_LARGE", "网页超过 5 MiB");
    }
    const contentType = response.headers["content-type"]?.toLowerCase() ?? "";
    if (!contentType.startsWith("text/html") && !contentType.startsWith("application/xhtml+xml")) {
      response.destroy();
      throw new CapturePipelineError("UNSUPPORTED_CONTENT_TYPE", `不支持的内容类型: ${contentType || "unknown"}`);
    }
    return { html: await readHtml(response, contentType), finalUrl: target.url.href, status };
  }

  throw new CapturePipelineError("HTTP_ERROR", "网页重定向过多");
}

async function fetchBinary(
  input: string | URL,
  options: BinaryFetchOptions,
  signal: AbortSignal,
): Promise<BinaryFetchResult> {
  const deadline = Date.now() + TIMEOUT_MS;
  let current = input;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const target = await (options.resolveTarget ?? resolvePublicTarget)(current);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CapturePipelineError("FETCH_TIMEOUT", "图片抓取超时");
    const response = await requestOnce(target.url, target.address, target.family, remaining, signal, {
      Accept: "image/jpeg,image/png,image/gif,image/webp,image/avif",
      "Accept-Encoding": "identity",
      "User-Agent": "Zhiye/0.1 (+local knowledge capture)",
    }).catch((cause: unknown) => {
      if (cause instanceof CapturePipelineError) throw cause;
      throw new CapturePipelineError("HTTP_ERROR", "图片请求失败", { cause });
    });
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && location) {
      response.destroy();
      if (redirect === MAX_REDIRECTS) {
        throw new CapturePipelineError("HTTP_ERROR", `图片重定向超过 ${MAX_REDIRECTS} 次`);
      }
      try {
        current = new URL(location, target.url);
      } catch (cause) {
        throw new CapturePipelineError("HTTP_ERROR", "图片返回了无效的重定向 URL", { cause });
      }
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new CapturePipelineError("HTTP_ERROR", `图片返回 HTTP ${status}`);
    }
    const encoding = response.headers["content-encoding"]?.toLowerCase().trim();
    if (encoding && encoding !== "identity") {
      response.destroy();
      throw new CapturePipelineError("UNSUPPORTED_CONTENT_TYPE", `不支持图片响应编码: ${encoding}`);
    }
    const declared = Number(response.headers["content-length"] ?? 0);
    if (declared > options.maxBytes) {
      response.destroy();
      throw new CapturePipelineError("RESPONSE_TOO_LARGE", "图片超过本地缓存大小限制");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const value of response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      if (bytes + chunk.length > options.maxBytes) {
        response.destroy();
        throw new CapturePipelineError("RESPONSE_TOO_LARGE", "图片超过本地缓存大小限制");
      }
      bytes += chunk.length;
      chunks.push(chunk);
    }
    return {
      body: Buffer.concat(chunks),
      contentType: response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "",
      finalUrl: target.url.href,
      status,
    };
  }
  throw new CapturePipelineError("HTTP_ERROR", "图片重定向过多");
}

export async function safeFetchHtml(
  input: string | URL,
  options: { resolveTarget?: typeof resolvePublicTarget } = {},
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchHtml(input, controller.signal, options.resolveTarget ?? resolvePublicTarget);
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new CapturePipelineError("FETCH_TIMEOUT", "网页抓取超时", { cause });
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

export async function safeFetchBinary(
  input: string | URL,
  options: BinaryFetchOptions,
): Promise<BinaryFetchResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchBinary(input, options, controller.signal);
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new CapturePipelineError("FETCH_TIMEOUT", "图片抓取超时", { cause });
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}
