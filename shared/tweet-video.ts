export const DEFAULT_TWEET_VIDEO_MAX_BYTES = 20_000_000;
export const MAX_TWEET_VIDEO_BYTES = 100_000_000;
export const MIN_TWEET_VIDEO_BYTES = 1_000_000;
export type TweetVideoStatus = "queued" | "processing" | "ready" | "skipped" | "failed";
export interface TweetVideoSettings { maxBytes: number; revision: number }
export interface TweetVideoState { status: TweetVideoStatus; errorCode: string | null; maxBytes: number }
export interface TweetVideoJob { id: string; documentId: string; sourceUrl: string; maxBytes: number; epoch: string; leaseToken: string }

const TWEET_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "m.twitter.com"]);

/** Only a single post is in scope: never a profile, article, quoted post or external card. */
export function normalizeTweetUrl(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 8_192) return null;
  try {
    const url = new URL(input);
    const id = /^\/(?:[^/]+\/status|i\/web\/status|statuses)\/([1-9]\d{0,24})(?:\/(?:video|photo)\/[1-9]\d*)?\/?$/u.exec(url.pathname)?.[1];
    if (url.protocol !== "https:" || !TWEET_HOSTS.has(url.hostname) || url.username || url.password || url.port || !id) return null;
    return `https://x.com/i/status/${id}`;
  } catch { return null; }
}

