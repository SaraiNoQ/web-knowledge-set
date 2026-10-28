import { DEFAULT_TWEET_VIDEO_MAX_BYTES, normalizeTweetUrl, MAX_TWEET_VIDEO_BYTES, MIN_TWEET_VIDEO_BYTES, type TweetVideoJob, type TweetVideoSettings, type TweetVideoState, type TweetVideoStatus } from "../shared/tweet-video";
import { CloudHttpError, epochGuardedDatabase, jsonObject, MAX_CLOUD_ROW_TEXT_BYTES, recoverExpiredRestore, type D1Database } from "./extension";
import type { R2Bucket } from "./backup";

interface VideoEnv { DB: D1Database; IMAGES: R2Bucket }
interface UploadedVideo { index: number; hash: string; bytes: number; ready: boolean }
interface JobRow { id: string; document_id: string; source_url: string; epoch: string; max_bytes: number; status: TweetVideoStatus; lease_token: string | null; lease_until: number; attempts: number; uploaded_json: string; error_code: string | null }
const encoder = new TextEncoder();
const LEASE_SECONDS = 15 * 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function tweetVideoSettings(db: D1Database): Promise<TweetVideoSettings> {
  const row = await db.prepare("SELECT value, revision FROM app_settings WHERE key='tweet_video_settings'").first<{ value: string; revision: number }>();
  const maxBytes = row ? JSON.parse(row.value).maxBytes : DEFAULT_TWEET_VIDEO_MAX_BYTES;
  return { maxBytes, revision: row?.revision ?? 0 };
}

export async function saveTweetVideoSettings(db: D1Database, body: Record<string, unknown>) {
  if (Object.keys(body).length !== 2 || !Number.isSafeInteger(body.maxBytes) || Number(body.maxBytes) < MIN_TWEET_VIDEO_BYTES || Number(body.maxBytes) > MAX_TWEET_VIDEO_BYTES || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) {
    throw new CloudHttpError(400, "INVALID_VIDEO_SETTINGS", "Video limit must be between 1 and 100 MB with a valid revision");
  }
  const result = await db.prepare(`INSERT INTO app_settings(key,value,revision,updated_at) SELECT 'tweet_video_settings',?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM app_settings WHERE key='tweet_video_settings' AND revision=?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, revision=app_settings.revision+1, updated_at=excluded.updated_at WHERE app_settings.revision=?`)
    .bind(JSON.stringify({ maxBytes: body.maxBytes }), new Date().toISOString(), body.revision, body.revision, body.revision).run();
  if (result.meta.changes !== 1) throw new CloudHttpError(409, "VIDEO_SETTINGS_CONFLICT", "Video settings changed; reload before saving");
  return await tweetVideoSettings(db);
}

export async function enqueueTweetVideos(db: D1Database, documentId: string, sourceUrl: string, epoch: string) {
  const source = normalizeTweetUrl(sourceUrl);
  if (!source) return;
  const settings = await tweetVideoSettings(db);
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO cloud_tweet_video_jobs(id,document_id,epoch,source_url,max_bytes,status,created_at,updated_at)
    SELECT ?,?,?,?,?,'queued',?,? WHERE EXISTS(SELECT 1 FROM cloud_documents WHERE id=? AND deleted_at IS NULL)`)
    .bind(crypto.randomUUID(), documentId, epoch, source, settings.maxBytes, now, now, documentId).run();
}

export async function documentTweetVideos(db: D1Database, documentId: string): Promise<TweetVideoState | null> {
  const document = await db.prepare("SELECT id FROM cloud_documents WHERE id=? AND deleted_at IS NULL").bind(documentId).first();
  if (!document) throw new CloudHttpError(404, "DOCUMENT_NOT_FOUND", "Document not found");
  const job = await db.prepare("SELECT status,error_code,max_bytes FROM cloud_tweet_video_jobs WHERE document_id=?").bind(documentId).first<JobRow>();
  return job ? { status: job.status, errorCode: job.error_code, maxBytes: job.max_bytes } : null;
}

async function authenticate(request: Request, db: D1Database) {
  if (request.headers.has("Origin")) throw new CloudHttpError(403, "VIDEO_WORKER_ORIGIN_REJECTED", "Server requests only");
  const token = /^Bearer ([A-Za-z0-9_-]{43,128})$/u.exec(request.headers.get("Authorization") ?? "")?.[1];
  const row = await db.prepare("SELECT value FROM app_settings WHERE key='tweet_video_worker_key_hash'").first<{ value: string }>();
  if (!token || !row || !/^[a-f0-9]{64}$/u.test(row.value)) throw new CloudHttpError(401, "VIDEO_WORKER_UNAUTHORIZED", "Video worker token required");
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  let mismatch = 0;
  for (let i = 0; i < 64; i += 1) mismatch |= digest.charCodeAt(i) ^ row.value.charCodeAt(i);
  if (mismatch) throw new CloudHttpError(401, "VIDEO_WORKER_UNAUTHORIZED", "Video worker token rejected");
}

async function activeJob(env: VideoEnv, id: string, leaseToken: string, epoch: string) {
  const row = await env.DB.prepare(`SELECT j.* FROM cloud_tweet_video_jobs j JOIN cloud_documents d ON d.id=j.document_id
    WHERE j.id=? AND j.lease_token=? AND j.epoch=? AND j.status='processing' AND j.lease_until>? AND d.deleted_at IS NULL`)
    .bind(id, leaseToken, epoch, nowSeconds()).first<JobRow>();
  if (!row) throw new CloudHttpError(409, "VIDEO_JOB_STALE", "Video job or lease is no longer current");
  return row;
}

function lease(body: Record<string, unknown>) {
  if (typeof body.leaseToken !== "string" || !/^[a-f0-9-]{36}$/u.test(body.leaseToken)) throw new CloudHttpError(400, "INVALID_VIDEO_LEASE", "Video lease required");
  return body.leaseToken;
}

async function claim(env: VideoEnv, epoch: string) {
  const db = epochGuardedDatabase(env.DB, epoch);
  const now = nowSeconds(), updated = new Date().toISOString(), leaseToken = crypto.randomUUID();
  await db.prepare("UPDATE cloud_tweet_video_jobs SET status='failed',error_code='VIDEO_RETRIES_EXHAUSTED',updated_at=? WHERE status='processing' AND lease_until<=? AND attempts>=3 AND epoch=?").bind(updated, now, epoch).run();
  const job = await env.DB.prepare(`UPDATE cloud_tweet_video_jobs SET status='processing',lease_token=?,lease_until=?,attempts=attempts+1,uploaded_json='[]',updated_at=?
    WHERE id=(SELECT j.id FROM cloud_tweet_video_jobs j JOIN cloud_documents d ON d.id=j.document_id
      WHERE j.epoch=? AND d.deleted_at IS NULL AND j.attempts<3 AND j.lease_until<=? AND j.status IN ('queued','processing') ORDER BY j.created_at,j.id LIMIT 1)
    AND EXISTS(SELECT 1 FROM app_settings WHERE key='data_epoch' AND value=?) RETURNING *`)
    .bind(leaseToken, now + LEASE_SECONDS, updated, epoch, now, epoch).first<JobRow>();
  const value: TweetVideoJob | null = job ? { id: job.id, documentId: job.document_id, sourceUrl: job.source_url, maxBytes: job.max_bytes, epoch, leaseToken } : null;
  return json({ job: value });
}

async function upload(request: Request, env: VideoEnv, url: URL, id: string, epoch: string) {
  const token = request.headers.get("X-Video-Lease") ?? "";
  const job = await activeJob(env, id, token, epoch);
  const hash = request.headers.get("X-Video-Hash") ?? "";
  const length = request.headers.get("Content-Length") ?? "";
  const indexText = url.searchParams.get("index") ?? "";
  if (!/^[a-f0-9]{64}$/u.test(hash) || !/^[1-9]\d*$/u.test(length) || !/^[0-3]$/u.test(indexText) || request.headers.get("Content-Type") !== "video/mp4" || !request.body) throw new CloudHttpError(400, "INVALID_VIDEO_UPLOAD", "A bounded MP4 upload is required");
  const bytes = Number(length), index = Number(indexText);
  if (!Number.isSafeInteger(bytes) || bytes > job.max_bytes) throw new CloudHttpError(413, "VIDEO_TOO_LARGE", "Tweet video budget exceeded");
  const uploaded: UploadedVideo = { index, hash, bytes, ready: false };
  const db = epochGuardedDatabase(env.DB, epoch);
  const reserved = await db.prepare(`UPDATE cloud_tweet_video_jobs SET uploaded_json=json_insert(uploaded_json,'$[#]',json(?))
    WHERE id=? AND status='processing' AND lease_token=? AND lease_until>? AND epoch=?
    AND NOT EXISTS(SELECT 1 FROM json_each(uploaded_json) WHERE json_extract(value,'$.index')=?)
    AND COALESCE((SELECT SUM(json_extract(value,'$.bytes')) FROM json_each(uploaded_json)),0)+?<=max_bytes`)
    .bind(JSON.stringify(uploaded), id, token, nowSeconds(), epoch, index, bytes).run();
  if (reserved.meta.changes !== 1) throw new CloudHttpError(409, "VIDEO_UPLOAD_CONFLICT", "Video upload already exists or exceeds the tweet budget");
  const existing = await env.IMAGES.head(hash);
  if (existing && (existing.size !== bytes || existing.httpMetadata?.contentType !== "video/mp4")) throw new CloudHttpError(409, "VIDEO_HASH_CONFLICT", "Existing asset metadata differs");
  let count = 0;
  let prefix = new Uint8Array();
  const bounded = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      count += chunk.byteLength;
      if (count > bytes) throw new CloudHttpError(413, "VIDEO_TOO_LARGE", "Video exceeds declared size");
      if (prefix.byteLength < 12) {
        const next = new Uint8Array(Math.min(12, prefix.byteLength + chunk.byteLength));
        next.set(prefix); next.set(chunk.subarray(0, next.byteLength - prefix.byteLength), prefix.byteLength); prefix = next;
        if (prefix.byteLength === 12 && String.fromCharCode(...prefix.subarray(4, 8)) !== "ftyp") throw new CloudHttpError(400, "INVALID_VIDEO_UPLOAD", "MP4 signature required");
      }
      controller.enqueue(chunk);
    },
    flush() { if (count !== bytes || prefix.byteLength < 12) throw new CloudHttpError(400, "INVALID_VIDEO_UPLOAD", "Video length mismatch"); },
  }));
  if (!existing) {
    // R2 requires a known length even after validation wraps the request stream.
    const FixedLength = (globalThis as unknown as { FixedLengthStream?: new(length: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
    const transfer = FixedLength ? new FixedLength(bytes) : new TransformStream<Uint8Array, Uint8Array>();
    await Promise.all([
      bounded.pipeTo(transfer.writable),
      env.IMAGES.put(hash, transfer.readable, { httpMetadata: { contentType: "video/mp4" }, onlyIf: { etagDoesNotMatch: "*" } }),
    ]);
  }
  else { const reader = bounded.getReader(); try { while (!(await reader.read()).done) { /* Validate a repeated content-addressed upload. */ } } finally { reader.releaseLock(); } }
  await activeJob(env, id, token, epoch);
  const current = await env.DB.prepare("SELECT uploaded_json FROM cloud_tweet_video_jobs WHERE id=?").bind(id).first<{ uploaded_json: string }>();
  const videos = JSON.parse(current!.uploaded_json) as UploadedVideo[];
  const item = videos.find(video => video.index === index)!;
  item.ready = true;
  const written = await db.prepare("UPDATE cloud_tweet_video_jobs SET uploaded_json=? WHERE id=? AND lease_token=? AND status='processing' AND uploaded_json=?")
    .bind(JSON.stringify(videos), id, token, current!.uploaded_json).run();
  if (written.meta.changes !== 1) throw new CloudHttpError(409, "VIDEO_UPLOAD_CONFLICT", "Video uploads changed concurrently");
  return json({ hash, bytes });
}

async function complete(request: Request, env: VideoEnv, id: string, epoch: string) {
  const body = await jsonObject(request, 4096), token = lease(body);
  if (!["ready", "skipped", "failed"].includes(String(body.status)) || (body.errorCode !== undefined && (typeof body.errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(body.errorCode)))) throw new CloudHttpError(400, "INVALID_VIDEO_RESULT", "Invalid video task result");
  const job = await activeJob(env, id, token, epoch);
  const db = epochGuardedDatabase(env.DB, epoch);
  const now = new Date().toISOString();
  if (body.status !== "ready") {
    const status = body.status === "failed" && job.attempts < 3 ? "queued" : body.status;
    const retryAt = status === "queued" ? nowSeconds() + 60 : 0;
    await db.prepare("UPDATE cloud_tweet_video_jobs SET status=?,lease_until=?,error_code=?,updated_at=? WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?")
      .bind(status, retryAt, body.errorCode ?? null, now, id, token, nowSeconds()).run();
    return json({ status });
  }
  const videos = JSON.parse(job.uploaded_json) as UploadedVideo[];
  if (!videos.length || videos.some(video => !video.ready) || videos.reduce((sum, video) => sum + video.bytes, 0) > job.max_bytes) throw new CloudHttpError(409, "VIDEO_UPLOAD_INCOMPLETE", "Video uploads are incomplete");
  const suffix = "\n\n" + videos.sort((a, b) => a.index - b.index).map((video, index) => `![推文视频 ${index + 1}](zhiye://asset/${video.hash})`).join("\n\n");
  await db.batch!([
    db.prepare(`UPDATE cloud_documents SET markdown=markdown || ?, revision=revision+1, updated_at=? WHERE id=? AND deleted_at IS NULL
      AND length(CAST(markdown AS BLOB))+?<=? AND EXISTS(SELECT 1 FROM cloud_tweet_video_jobs WHERE id=? AND epoch=? AND status='processing' AND lease_token=? AND lease_until>?)`)
      .bind(suffix, now, job.document_id, encoder.encode(suffix).byteLength, MAX_CLOUD_ROW_TEXT_BYTES, id, epoch, token, nowSeconds()),
    db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('video document changed') END AS guarded"),
    db.prepare("UPDATE cloud_tweet_video_jobs SET status='ready',error_code=NULL,updated_at=? WHERE id=? AND status='processing' AND lease_token=?").bind(now, id, token),
  ]);
  return json({ status: "ready" });
}

async function source(request: Request, env: VideoEnv, url: URL, id: string, epoch: string) {
  const job = await activeJob(env, id, request.headers.get("X-Video-Lease") ?? "", epoch);
  const value = url.searchParams.get("url") ?? "";
  let target: URL;
  try { target = new URL(value); } catch { throw new CloudHttpError(400, "INVALID_VIDEO_SOURCE", "Invalid video source"); }
  if (value.length > 8192 || target.protocol !== "https:" || target.username || target.password || target.port || target.hash) throw new CloudHttpError(400, "INVALID_VIDEO_SOURCE", "Invalid video source");
  const metadata = target.hostname === "cdn.syndication.twimg.com";
  if (metadata) {
    const tweetId = /\/status\/(\d+)/u.exec(new URL(job.source_url).pathname)?.[1];
    if (target.pathname !== "/tweet-result" || target.searchParams.get("id") !== tweetId || !/^[a-z0-9]{1,64}$/u.test(target.searchParams.get("token") ?? "") ||
      [...target.searchParams.keys()].some(key => !["id", "token"].includes(key)) || target.searchParams.getAll("id").length !== 1 || target.searchParams.getAll("token").length !== 1) throw new CloudHttpError(400, "INVALID_VIDEO_SOURCE", "Video metadata must match the current tweet");
  } else if (!["video.twimg.com", "video-s.twimg.com"].includes(target.hostname) || !target.pathname.endsWith(".mp4")) throw new CloudHttpError(400, "INVALID_VIDEO_SOURCE", "Only X MP4 sources are allowed");
  const headers = new Headers({ "User-Agent": "Googlebot", "Accept-Encoding": "identity" });
  const range = request.headers.get("Range");
  if (range) {
    if (metadata || !/^bytes=\d+-\d*$/u.test(range)) throw new CloudHttpError(400, "INVALID_VIDEO_RANGE", "Invalid source range");
    headers.set("Range", range);
  }
  let response: Response;
  try { response = await fetch(target, { method: request.method, headers, redirect: "manual", signal: AbortSignal.timeout(60_000) }); }
  catch { throw new CloudHttpError(502, "VIDEO_SOURCE_UNAVAILABLE", "Video source is unavailable"); }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new CloudHttpError(502, "VIDEO_SOURCE_REDIRECT", "Video source redirect rejected"); }
  const length = response.headers.get("Content-Length");
  if (length && /^\d+$/u.test(length) && Number(length) > (metadata ? 512 * 1024 : job.max_bytes)) {
    await response.body?.cancel(); throw new CloudHttpError(413, metadata ? "VIDEO_METADATA_TOO_LARGE" : "VIDEO_TOO_LARGE", "Video source exceeds its budget");
  }
  const resultHeaders = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  for (const name of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]) { const value = response.headers.get(name); if (value) resultHeaders.set(name, value); }
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers: resultHeaders });
}

export async function handleVideoWorkerRequest(request: Request, env: VideoEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/browser-extension/video-worker/")) return null;
  try {
    await authenticate(request, env.DB);
    const stored = await env.DB.prepare("SELECT value FROM app_settings WHERE key='data_epoch'").first<{ value: string }>();
    const epoch = stored && await recoverExpiredRestore(env.DB, stored.value);
    if (!epoch || epoch.startsWith("restore:")) throw new CloudHttpError(503, "CLOUD_MAINTENANCE", "Cloud restore is in progress");
    if (url.pathname === "/api/browser-extension/video-worker/health" && request.method === "GET") {
      await env.DB.prepare("SELECT id FROM cloud_tweet_video_jobs LIMIT 1").first();
      return json({ ok: true });
    }
    if (url.pathname === "/api/browser-extension/video-worker/claim" && request.method === "POST") return await claim(env, epoch);
    const match = /^\/api\/browser-extension\/video-worker\/jobs\/([a-f0-9-]{36})\/(asset|complete|source)$/u.exec(url.pathname);
    if (match?.[2] === "source" && ["GET", "HEAD"].includes(request.method)) return await source(request, env, url, match[1], epoch);
    if (match && request.method === "POST") return match[2] === "asset" ? await upload(request, env, url, match[1], epoch) : await complete(request, env, match[1], epoch);
    throw new CloudHttpError(404, "NOT_FOUND", "Video endpoint not found");
  } catch (cause) {
    const error = cause instanceof CloudHttpError ? cause : new CloudHttpError(500, "VIDEO_WORKER_ERROR", "Video task failed");
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
}
