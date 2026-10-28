import { normalizeTweetUrl } from "../shared/tweet-video.js";
export { normalizeTweetUrl } from "../shared/tweet-video.js";
const MAX_METADATA_BYTES = 1_000_000;
const VIDEO_HOSTS = new Set(["video.twimg.com", "video-s.twimg.com"]);

export class XVideoSourceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "XVideoSourceError";
    this.code = code;
  }
}

export interface XVideoSource { url: string; bitrate: number }

export function tweetSyndicationUrl(input: string): string {
  const canonical = normalizeTweetUrl(input);
  if (!canonical) throw new XVideoSourceError("INVALID_TWEET_URL", "Only an HTTPS X post URL is supported");
  const id = canonical.split("/").at(-1)!;
  // X's public embed token uses JS number/base-36 semantics, not integer arithmetic.
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/gu, "");
  return `https://cdn.syndication.twimg.com/tweet-result?${new URLSearchParams({ id, token })}`;
}

export function videoSourceUrl(input: unknown): string {
  if (typeof input !== "string" || input.length > 8_192) throw new XVideoSourceError("VIDEO_SOURCE_INVALID", "Invalid X video source");
  let url: URL;
  try { url = new URL(input); }
  catch { throw new XVideoSourceError("VIDEO_SOURCE_INVALID", "Invalid X video source"); }
  if (url.protocol !== "https:" || !VIDEO_HOSTS.has(url.hostname) || url.username || url.password || url.port ||
    !/^\/(?:ext_tw_video|amplify_video|tweet_video)\/.+\.mp4$/u.test(url.pathname)) {
    throw new XVideoSourceError("VIDEO_SOURCE_INVALID", "Only an X CDN MP4 source is supported");
  }
  url.hash = "";
  return url.href;
}

export function videoSourceFallback(input: string): string | null {
  const url = new URL(videoSourceUrl(input));
  if (url.hostname !== "video.twimg.com") return null;
  url.hostname = "video-s.twimg.com";
  return url.href;
}

function record(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
}

export function parseTweetVideos(input: unknown, requestedId?: string): XVideoSource[] {
  const metadata = record(input);
  if (!metadata || (requestedId !== undefined && metadata.id_str !== requestedId)) {
    throw new XVideoSourceError("VIDEO_SOURCE_UNAVAILABLE", "X did not return this post's public metadata");
  }
  if (metadata.mediaDetails === undefined) return [];
  if (!Array.isArray(metadata.mediaDetails)) throw new XVideoSourceError("VIDEO_SOURCE_INVALID", "X media metadata is invalid");
  const sources: XVideoSource[] = [];
  const seen = new Set<string>();
  for (const item of metadata.mediaDetails) {
    const media = record(item);
    if (media?.type !== "video" && media?.type !== "animated_gif") continue;
    const variants = record(media.video_info)?.variants;
    const candidates: XVideoSource[] = [];
    if (Array.isArray(variants)) for (const item of variants) {
      const variant = record(item);
      if (variant?.content_type !== "video/mp4") continue;
      try {
        candidates.push({ url: videoSourceUrl(variant.url), bitrate: typeof variant.bitrate === "number" && Number.isFinite(variant.bitrate) && variant.bitrate >= 0 ? variant.bitrate : 0 });
      } catch { /* Ignore unusable variants, never fetch an untrusted host. */ }
    }
    const best = candidates.sort((left, right) => right.bitrate - left.bitrate)[0];
    if (!best) throw new XVideoSourceError("VIDEO_FORMAT_UNSUPPORTED", "An X video has no downloadable MP4 variant");
    if (seen.has(best.url)) continue;
    seen.add(best.url);
    sources.push(best);
    if (sources.length > 4) throw new XVideoSourceError("VIDEO_SOURCE_INVALID", "X returned too many videos for one post");
  }
  return sources;
}

export async function fetchTweetVideos(input: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<XVideoSource[]> {
  const endpoint = tweetSyndicationUrl(input);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  signal.throwIfAborted();
  const response = await (options.fetch ?? fetch)(endpoint, { headers: { "User-Agent": "Googlebot", "Accept": "application/json" }, redirect: "manual", signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new XVideoSourceError("VIDEO_SOURCE_UNAVAILABLE", "X public video metadata is unavailable");
  }
  if (Number(response.headers.get("Content-Length")) > MAX_METADATA_BYTES) {
    await response.body.cancel();
    throw new XVideoSourceError("VIDEO_METADATA_TOO_LARGE", "X video metadata exceeds its size limit");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_METADATA_BYTES) throw new XVideoSourceError("VIDEO_METADATA_TOO_LARGE", "X video metadata exceeds its size limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let metadata: unknown;
  try { metadata = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new XVideoSourceError("VIDEO_SOURCE_INVALID", "X video metadata is not valid JSON"); }
  return parseTweetVideos(metadata, new URL(endpoint).searchParams.get("id")!);
}
