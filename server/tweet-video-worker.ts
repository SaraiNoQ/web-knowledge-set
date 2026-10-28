import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { MAX_TWEET_VIDEO_BYTES, type TweetVideoJob } from "../shared/tweet-video.js";
import { fetchTweetVideos, videoSourceFallback, videoSourceUrl } from "./x-video-source.js";

export type VideoJob = TweetVideoJob;
export interface VideoWorkerConfig { endpoint: string; token: string; temporaryDirectory: string }
type Fetcher = typeof fetch;

export class VideoDownloadError extends Error {
  constructor(readonly code: string) { super(code); }
}

function workerUrl(config: VideoWorkerConfig, path: string) {
  return `${config.endpoint.replace(/\/$/u, "")}/${path}`;
}
function authorization(config: VideoWorkerConfig) { return { Authorization: `Bearer ${config.token}` }; }

/** Bytes are counted across the whole tweet, not independently for each video. */
export async function saveVideoResponse(response: Response, path: string, remaining: number) {
  const length = Number(response.headers.get("content-length"));
  if (response.status === 413 || length > remaining) {
    await response.body?.cancel(); throw new VideoDownloadError("VIDEO_TOO_LARGE");
  }
  if (!response.ok || !response.body) throw new VideoDownloadError("VIDEO_DOWNLOAD_FAILED");
  const file = await open(path, "wx", 0o600);
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let bytes = 0, prefix = Buffer.alloc(0);
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > remaining) throw new VideoDownloadError("VIDEO_TOO_LARGE");
      if (prefix.length < 16) prefix = Buffer.concat([prefix, part.value.subarray(0, 16 - prefix.length)]);
      hash.update(part.value);
      for (let offset = 0; offset < part.value.length;) {
        const written = await file.write(part.value, offset, part.value.length - offset);
        if (!written.bytesWritten) throw new VideoDownloadError("VIDEO_DISK_WRITE_FAILED");
        offset += written.bytesWritten;
      }
    }
    if (prefix.length < 12 || prefix.toString("ascii", 4, 8) !== "ftyp") throw new VideoDownloadError("VIDEO_FORMAT_UNSUPPORTED");
    if (length > 0 && bytes !== length) throw new VideoDownloadError("VIDEO_DOWNLOAD_INCOMPLETE");
    return { path, bytes, hash: hash.digest("hex") };
  } finally {
    await reader.cancel().catch(() => undefined);
    await file.close();
  }
}

/** The server downloads through a job-scoped edge bridge because X is unreachable directly from this host. */
function sourceFetcher(config: VideoWorkerConfig, job: VideoJob, fetcher: Fetcher): Fetcher {
  return async (input, init = {}) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const headers = new Headers({ ...authorization(config), "X-Video-Lease": job.leaseToken });
    const range = new Headers(init.headers).get("range");
    if (range) headers.set("Range", range);
    return fetcher(workerUrl(config, `jobs/${encodeURIComponent(job.id)}/source?url=${encodeURIComponent(url)}`), {
      method: init.method ?? "GET", headers, signal: init.signal, redirect: "error",
    });
  };
}

export async function processVideoJob(config: VideoWorkerConfig, job: VideoJob, fetcher: Fetcher = fetch) {
  if (!Number.isSafeInteger(job.maxBytes) || job.maxBytes < 1 || job.maxBytes > MAX_TWEET_VIDEO_BYTES || !/^[a-f0-9-]{36}$/u.test(job.id)) throw new VideoDownloadError("INVALID_VIDEO_JOB");
  const signal = AbortSignal.timeout(12 * 60_000);
  const source = sourceFetcher(config, job, fetcher);
  let directory: string | undefined;
  let status: "ready" | "skipped" | "failed" = "failed";
  let errorCode: string | undefined;
  try {
    await mkdir(config.temporaryDirectory, { recursive: true, mode: 0o700 });
    const space = await statfs(config.temporaryDirectory);
    if (space.bavail * space.bsize < job.maxBytes + 64 * 1024 * 1024) throw new VideoDownloadError("VIDEO_STORAGE_FULL");
    const videos = await fetchTweetVideos(job.sourceUrl, { fetch: source, signal });
    if (!videos.length) throw new VideoDownloadError("NO_PUBLIC_VIDEO");
    // Reject a known aggregate overflow without downloading any video bytes.
    let knownBytes = 0;
    for (const video of videos) {
      const response = await source(videoSourceUrl(video.url), { method: "HEAD", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }).catch(() => null);
      if (!response) continue;
      if (response.status === 413) throw new VideoDownloadError("VIDEO_TOO_LARGE");
      const length = Number(response.headers.get("content-length"));
      if (response.ok && Number.isSafeInteger(length) && length > 0) knownBytes += length;
      await response.body?.cancel();
      if (knownBytes > job.maxBytes) throw new VideoDownloadError("VIDEO_TOO_LARGE");
    }
    directory = await mkdtemp(join(config.temporaryDirectory, "tweet-"));
    const files: Array<{ path: string; bytes: number; hash: string }> = [];
    let total = 0;
    for (const [index, video] of videos.entries()) {
      const url = videoSourceUrl(video.url);
      const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) };
      let response: Response;
      try { response = await source(url, options); }
      catch {
        const fallback = videoSourceFallback(url);
        if (!fallback) throw new VideoDownloadError("VIDEO_DOWNLOAD_FAILED");
        response = await source(fallback, options);
      }
      if (!response.ok && response.status !== 413) {
        await response.body?.cancel();
        const fallback = videoSourceFallback(url);
        if (fallback) response = await source(fallback, options);
      }
      const file = await saveVideoResponse(response, join(directory, `${index}.mp4`), job.maxBytes - total);
      total += file.bytes;
      files.push(file);
    }
    // No partial tweet is uploaded: all downloads must fit the aggregate budget first.
    for (const [index, file] of files.entries()) {
      const fileStream = createReadStream(file.path);
      const body = Readable.toWeb(fileStream) as ReadableStream<Uint8Array>;
      let response: Response;
      try { response = await fetcher(workerUrl(config, `jobs/${encodeURIComponent(job.id)}/asset?index=${index}`), {
        method: "POST", headers: { ...authorization(config), "X-Video-Lease": job.leaseToken, "X-Video-Hash": file.hash,
          "Content-Type": "video/mp4", "Content-Length": String(file.bytes) },
        body, duplex: "half", signal, redirect: "error",
      } as RequestInit & { duplex: "half" }); }
      finally { fileStream.destroy(); }
      if (!response.ok) { await response.body?.cancel(); throw new VideoDownloadError("VIDEO_UPLOAD_FAILED"); }
      await response.body?.cancel();
    }
    status = "ready";
  } catch (error) {
    const code = error instanceof VideoDownloadError ? error.code : (error as { code?: string })?.code;
    errorCode = ["VIDEO_TOO_LARGE", "NO_PUBLIC_VIDEO", "VIDEO_FORMAT_UNSUPPORTED", "VIDEO_STORAGE_FULL"].includes(code ?? "") ? code : "VIDEO_DOWNLOAD_FAILED";
    status = ["VIDEO_TOO_LARGE", "NO_PUBLIC_VIDEO", "VIDEO_FORMAT_UNSUPPORTED"].includes(errorCode ?? "") ? "skipped" : "failed";
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  const response = await fetcher(workerUrl(config, `jobs/${encodeURIComponent(job.id)}/complete`), {
    method: "POST", headers: { ...authorization(config), "Content-Type": "application/json" },
    body: JSON.stringify({ leaseToken: job.leaseToken, status, ...(errorCode ? { errorCode } : {}) }),
    signal: AbortSignal.timeout(30_000), redirect: "error",
  });
  if (!response.ok) { await response.body?.cancel(); throw new VideoDownloadError("VIDEO_COMPLETION_FAILED"); }
  await response.body?.cancel();
  return { status, errorCode };
}

export async function runVideoWorker(config: VideoWorkerConfig, fetcher: Fetcher = fetch) {
  if (config.endpoint !== "https://clip.sarainoq.cn/api/browser-extension/video-worker" || !/^[A-Za-z0-9_-]{43}$/u.test(config.token)) throw new VideoDownloadError("INVALID_VIDEO_WORKER_CONFIG");
  await mkdir(config.temporaryDirectory, { recursive: true, mode: 0o700 });
  // Only our abandoned private temporary directories are eligible for cleanup.
  for (const entry of await readdir(config.temporaryDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("tweet-")) continue;
    const path = join(config.temporaryDirectory, entry.name);
    if (Date.now() - (await stat(path)).mtimeMs > 24 * 60 * 60_000) await rm(path, { recursive: true, force: true });
  }
  // A cron invocation is bounded; flock prevents overlapping download processes.
  for (let index = 0; index < 3; index++) {
    const response = await fetcher(workerUrl(config, "claim"), { method: "POST", headers: authorization(config), signal: AbortSignal.timeout(30_000), redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new VideoDownloadError("VIDEO_CLAIM_FAILED"); }
    const { job } = await response.json() as { job: VideoJob | null };
    if (!job) break;
    const result = await processVideoJob(config, job, fetcher);
    console.log(JSON.stringify({ event: "tweet_video_job", jobId: job.id, ...result }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const index = process.argv.indexOf("--config");
  const path = process.argv[index + 1];
  if (index < 0 || !path) throw new Error("Pass --config <private-file>");
  const attributes = await stat(path);
  if (attributes.mode & 0o077) throw new Error("Video worker config must be private");
  const config = JSON.parse(await readFile(path, "utf8")) as VideoWorkerConfig;
  runVideoWorker(config).catch(() => { console.error("tweet_video_worker_failed"); process.exitCode = 1; });
}
