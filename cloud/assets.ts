import type { R2Bucket } from "./backup";
import { CloudHttpError } from "./extension";
import { publicUrl } from "./net";

/**
 * Cloud-side document image cache.
 *
 * A cloud document's Markdown references remote images by URL. To keep those
 * images available without re-hitting the origin (and without leaking the
 * reader's IP to a third party), capture and clip fetch the image bytes once,
 * store them in an R2 bucket keyed by their SHA-256 content hash, and rewrite
 * the Markdown image destination to the portable `zhiye://asset/<hash>` scheme.
 * That scheme is origin-agnostic: the web worker serves it as
 * `/api/assets/<hash>` and the desktop app resolves it to a local asset.
 *
 * The cloud never stores an image if it could not be fetched or does not pass
 * its content-type/signature check; such images keep their original URL so a
 * single failing asset never breaks the whole document. The D1 schema is
 * unchanged — references live in `markdown` and the bytes live in R2.
 */

export const MAX_ASSETS_PER_DOCUMENT = 32;
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_ASSET_BYTES = 20 * 1024 * 1024;
export const ASSET_CONCURRENCY = 4;
const ASSET_HOST = "asset";
const ASSET_URI = /^zhiye:\/\/asset\/([a-f0-9]{64})$/u;
const HASH = /^[a-f0-9]{64}$/u;
const IMAGE_REFERENCE = /!\[([^\]]*)\]\(([^)\s]+)\)/gu;
const encoder = new TextEncoder();

export type AssetMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/avif";

export function assetUri(hash: string): string {
  return `zhiye://${ASSET_HOST}/${hash}`;
}

export function assetHashFromUri(uri: string): string | null {
  if (typeof uri !== "string") return null;
  const match = ASSET_URI.exec(uri.trim());
  return match ? match[1]! : null;
}

export function detectImageMime(body: Uint8Array): AssetMimeType | null {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.length >= 8 && body.subarray(0, 8).join(",") === "137,80,78,71,13,10,26,10") return "image/png";
  if (body.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...body.subarray(0, 6)))) return "image/gif";
  if (body.length >= 12 &&
    body.subarray(0, 4).every((byte, index) => byte === [82, 73, 70, 70][index]!) &&
    body.subarray(8, 12).every((byte, index) => byte === [87, 69, 66, 80][index]!)) return "image/webp";
  const isFtyp = body.length >= 16 &&
    body.subarray(4, 8).every((byte, index) => byte === [102, 116, 121, 112][index]!);
  if (isFtyp) {
    const boxSize = (body[0]! << 24) | (body[1]! << 16) | (body[2]! << 8) | body[3]!;
    if (boxSize >= 16 && boxSize <= body.length) {
      const brands: string[] = [String.fromCharCode(...body.subarray(8, 12))];
      for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
        brands.push(String.fromCharCode(...body.subarray(offset, offset + 4)));
      }
      if (brands.some((brand) => brand === "avif" || brand === "avis")) return "image/avif";
    }
  }
  return null;
}

/** Allow common content-type aliases so a valid image is not rejected over header wording. */
function contentTypeMatches(mime: AssetMimeType, contentType: string): boolean {
  if (mime === "image/jpeg") return ["image/jpeg", "image/jpg", "image/pjpeg", "image/x-jpeg"].includes(contentType);
  if (mime === "image/png") return ["image/png", "image/x-png"].includes(contentType);
  if (mime === "image/gif") return contentType === "image/gif";
  if (mime === "image/webp") return contentType === "image/webp";
  if (mime === "image/avif") return contentType === "image/avif";
  return false;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether a Markdown image destination should be fetched (http/https, not an internal reference). */
function fetchableUrl(destination: string, baseUrl: string): string | null {
  if (!destination || destination.startsWith("zhiye:") || destination.startsWith("data:")) return null;
  const trimmed = destination.trim();
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    if (resolved.username || resolved.password || resolved.port === "0") return null;
    return resolved.href;
  } catch {
    return null;
  }
}

export interface FetchedAsset {
  bytes: Uint8Array;
  mime: AssetMimeType;
}

export type AssetResolver = (url: string) => Promise<void>;
export type AssetFetcher = (url: string, maxBytes: number) => Promise<FetchedAsset>;

async function defaultFetchImage(url: string, maxBytes: number): Promise<FetchedAsset> {
  // The caller already SSRF-validates the initial URL. Each redirect hop must
  // also be re-validated (mirrors cloud/capture.ts) so a public image server
  // cannot bounce the worker to a private/link-local address.
  let current = url;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      if (!location || redirects === 5) {
        throw new CloudHttpError(502, "ASSET_FETCH_FAILED", "Image redirect is invalid or excessive");
      }
      current = await publicUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) throw new CloudHttpError(502, "ASSET_FETCH_FAILED", "Image fetch returned a non-success status");
    const contentType = (response.headers.get("Content-Type") || "").split(";", 1)[0]?.trim().toLowerCase();
    if (!contentType || !contentType.startsWith("image/")) {
      throw new CloudHttpError(415, "UNSUPPORTED_CONTENT_TYPE", "Image target did not return an image content type");
    }
    const declared = Number(response.headers.get("Content-Length") || 0);
    if (declared > maxBytes) throw new CloudHttpError(413, "RESPONSE_TOO_LARGE", "Image exceeds the per-file limit");
    const reader = response.body?.getReader();
    if (!reader) throw new CloudHttpError(502, "ASSET_FETCH_FAILED", "Image response had no body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new CloudHttpError(413, "RESPONSE_TOO_LARGE", "Image exceeds the per-file limit");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const detected = detectImageMime(bytes);
    if (!detected || !contentTypeMatches(detected, contentType)) {
      throw new CloudHttpError(415, "UNSUPPORTED_CONTENT_TYPE", "Image content type does not match its file signature");
    }
    return { bytes, mime: detected };
  }
  throw new CloudHttpError(502, "ASSET_FETCH_FAILED", "Image redirect loop did not terminate");
}

interface ImageDestination {
  raw: string;
  url: string | null;
}

function imageDestinations(markdown: string, baseUrl: string): ImageDestination[] {
  const destinations: ImageDestination[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    if (seen.has(raw)) return;
    seen.add(raw);
    destinations.push({ raw, url: fetchableUrl(raw, baseUrl) });
  };
  for (const match of markdown.matchAll(IMAGE_REFERENCE)) push(match[2]!);
  return destinations;
}

function rewriteMarkdown(markdown: string, rewritten: Map<string, string>): string {
  if (!rewritten.size) return markdown;
  return markdown.replace(IMAGE_REFERENCE, (whole, alt: string, destination: string) => {
    const replacement = rewritten.get(destination);
    return replacement ? `![${alt}](${replacement})` : whole;
  });
}

export async function fetchDocumentAssets(
  env: { IMAGES: R2Bucket },
  markdown: string,
  baseUrl: string,
  options: { resolve?: AssetResolver; fetch?: AssetFetcher } = {},
): Promise<{ markdown: string; fetched: number }> {
  const resolve = options.resolve ?? (async (url: string) => { await publicUrl(url); });
  const fetchAsset = options.fetch ?? defaultFetchImage;
  // Filter to fetchable http(s) URLs first so internal/scheme references do not
  // consume the per-document budget.
  const fetcheable = imageDestinations(markdown, baseUrl)
    .filter((destination): destination is ImageDestination & { url: string } => destination.url !== null)
    .slice(0, MAX_ASSETS_PER_DOCUMENT);
  const rewritten = new Map<string, string>();
  let fetched = 0;
  let totalBytes = 0;
  const rawByUrl = new Map<string, ImageDestination[]>();
  for (const destination of fetcheable) {
    const list = rawByUrl.get(destination.url!) ?? [];
    list.push(destination);
    rawByUrl.set(destination.url!, list);
  }

  let next = 0;
  const run = async () => {
    while (next < fetcheable.length) {
      const destination = fetcheable[next++]!;
      const url = destination.url!;
      if (rewritten.has(url)) continue;
      const remaining = MAX_DOCUMENT_ASSET_BYTES - totalBytes;
      if (remaining <= 0) break;
      const allocation = Math.min(MAX_ASSET_BYTES, remaining);
      totalBytes += allocation;
      try {
        await resolve(url);
        const asset = await fetchAsset(url, allocation);
        const hash = await sha256(asset.bytes);
        await env.IMAGES.put(hash, asset.bytes, { httpMetadata: { contentType: asset.mime } });
        totalBytes = totalBytes - allocation + asset.bytes.length;
        rewritten.set(url, assetUri(hash));
        for (const item of rawByUrl.get(url) ?? []) rewritten.set(item.raw, assetUri(hash));
        fetched += 1;
      } catch {
        totalBytes -= allocation;
        // A failing image keeps its original URL so the document stays usable.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ASSET_CONCURRENCY, fetcheable.length) }, run));

  return { markdown: rewriteMarkdown(markdown, rewritten), fetched };
}

export async function handleAssetRequest(
  images: R2Bucket,
  url: URL,
): Promise<Response | null> {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/assets/")) return null;
  const hash = pathname.slice("/api/assets/".length);
  if (!HASH.test(hash)) return new Response(null, { status: 404 });
  const object = await images.get(hash);
  if (!object) return new Response(null, { status: 404 });
  const headers = new Headers({
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
  });
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}
