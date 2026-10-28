import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processVideoJob, saveVideoResponse, type VideoJob } from "../server/tweet-video-worker.js";
const mp4 = new Uint8Array([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0]);

test("video download rejects declared, actual, truncated and non-MP4 bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-budget-"));
  try {
    for (const [index, response] of [
      new Response(mp4, { headers: { "Content-Length": "20" } }),
      new Response(mp4), new Response("not a video body"),
      new Response(mp4, { headers: { "Content-Length": "17" } }),
    ].entries()) {
      await assert.rejects(saveVideoResponse(response, join(root, String(index)), index < 2 ? 15 : 100));
    }
    const saved = await saveVideoResponse(new Response(mp4), join(root, "ok"), 16);
    assert.equal(saved.bytes, 16);
    assert.deepEqual(new Uint8Array(await readFile(saved.path)), mp4);
    assert.match(saved.hash, /^[a-f0-9]{64}$/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const knownLength of [false, true]) test(`tweet aggregate budget skips every video (${knownLength ? "known" : "streamed"} size)`, async () => {
  const root = await mkdtemp(join(tmpdir(), "video-job-"));
  let uploads = 0; let completion: Record<string, unknown> = {};
  const job: VideoJob = { id: "00000000-0000-4000-8000-000000000001", documentId: "doc", sourceUrl: "https://x.com/i/status/1577719286659006464", maxBytes: 31, epoch: "test", leaseToken: "lease" };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/source")) {
      const source = new URL(url.searchParams.get("url")!);
      if (source.hostname === "cdn.syndication.twimg.com") return Response.json({ id_str: "1577719286659006464", mediaDetails: [1, 2].map(i => ({ type: "video", video_info: { variants: [{ content_type: "video/mp4", bitrate: 1, url: `https://video.twimg.com/ext_tw_video/test-${i}.mp4` }] } })) });
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${"a".repeat(43)}`);
      if (init?.method === "HEAD") return new Response(null, { headers: knownLength ? { "Content-Length": "16" } : {} });
      return new Response(mp4);
    }
    if (url.pathname.endsWith("/asset")) uploads++;
    if (url.pathname.endsWith("/complete")) completion = JSON.parse(String(init?.body));
    return Response.json({ ok: true });
  };
  try {
    const result = await processVideoJob({ endpoint: "https://clip.sarainoq.cn/api/browser-extension/video-worker", token: "a".repeat(43), temporaryDirectory: root }, job, fetcher);
    assert.equal(result.status, "skipped"); assert.equal(result.errorCode, "VIDEO_TOO_LARGE");
    assert.equal(uploads, 0); assert.equal(completion.status, "skipped");
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("successful tweet uploads only after every MP4 fits and then completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-success-"));
  let downloaded = 0, uploads = 0;
  let completion: Record<string, unknown> = {};
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/source")) {
      const source = new URL(url.searchParams.get("url")!);
      if (source.hostname === "cdn.syndication.twimg.com") return Response.json({ id_str: "1577719286659006464", mediaDetails: [1, 2].map(i => ({ type: "video", video_info: { variants: [{ content_type: "video/mp4", bitrate: 1, url: `https://video.twimg.com/ext_tw_video/test-${i}.mp4` }] } })) });
      if (init?.method === "HEAD") return new Response(null, { headers: { "Content-Length": "16" } });
      downloaded++; return new Response(mp4);
    }
    if (url.pathname.endsWith("/asset")) {
      assert.equal(downloaded, 2); uploads++;
      assert.equal(new Headers(init?.headers).get("Content-Length"), "16");
      const body = await new Response(init?.body).arrayBuffer();
      assert.deepEqual(new Uint8Array(body), mp4);
    }
    if (url.pathname.endsWith("/complete")) completion = JSON.parse(String(init?.body));
    return Response.json({ ok: true });
  };
  try {
    const result = await processVideoJob({ endpoint: "https://clip.sarainoq.cn/api/browser-extension/video-worker", token: "a".repeat(43), temporaryDirectory: root },
      { id: "00000000-0000-4000-8000-000000000001", documentId: "doc", sourceUrl: "https://x.com/i/status/1577719286659006464", maxBytes: 32, epoch: "test", leaseToken: "lease" }, fetcher);
    assert.equal(result.status, "ready"); assert.equal(uploads, 2); assert.equal(completion.status, "ready");
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
