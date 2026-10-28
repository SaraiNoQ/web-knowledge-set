import assert from "node:assert/strict";
import test from "node:test";
import { fetchTweetVideos, normalizeTweetUrl, parseTweetVideos, tweetSyndicationUrl, videoSourceFallback, videoSourceUrl, XVideoSourceError } from "../server/x-video-source.js";

const id = "1577719286659006464";
const source = `https://x.com/UltimaShadowX/status/${id}`;
const video = (name: string, bitrate = 256_000) => ({ content_type: "video/mp4", bitrate, url: `https://video.twimg.com/ext_tw_video/123/pu/vid/480x270/${name}.mp4?tag=12` });
const fixture = { id_str: id, mediaDetails: [
  { type: "photo", media_url_https: "https://pbs.twimg.com/media/photo.jpg" },
  { type: "video", video_info: { variants: [{ content_type: "application/x-mpegURL", url: "https://video.twimg.com/ext_tw_video/123/pu/pl/index.m3u8" }, video("low"), video("high", 2_176_000)] } },
  { type: "animated_gif", video_info: { variants: [video("animation", 0)] } },
], quoted_tweet: { mediaDetails: [{ type: "video", video_info: { variants: [video("quoted")] } }] }, video: { variants: [video("duplicate-root")] } };
const isCode = (code: string) => (error: unknown) => error instanceof XVideoSourceError && error.code === code;

test("X post normalization and embed token preserve JS number semantics", () => {
  for (const url of [source, `https://twitter.com/a/status/${id}/video/2?x=1#video`, `https://x.com/i/web/status/${id}`, `https://mobile.twitter.com/a/status/${id}`]) {
    assert.equal(normalizeTweetUrl(url), `https://x.com/i/status/${id}`);
    assert.equal(tweetSyndicationUrl(url), `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=3tojuiek1l`);
  }
  for (const url of ["http://x.com/a/status/1", "https://x.com.evil/a/status/1", "https://a:x@x.com/a/status/1", "https://x.com:444/a/status/1", "https://x.com/a", "https://x.com/i/article/123", "https://x.com/a/status/0", "https://x.com/a/status/123/anything"]) assert.equal(normalizeTweetUrl(url), null, url);
});

test("video parsing chooses the highest-bitrate MP4 per attached video and ignores quotes/cards", () => {
  assert.deepEqual(parseTweetVideos(fixture, id), [
    { url: video("high").url, bitrate: 2_176_000 }, { url: video("animation").url, bitrate: 0 },
  ]);
  assert.deepEqual(parseTweetVideos({ id_str: id, card: { mediaDetails: fixture.mediaDetails }, quoted_tweet: fixture.quoted_tweet }, id), []);
  assert.throws(() => parseTweetVideos(fixture, "1"), isCode("VIDEO_SOURCE_UNAVAILABLE"));
  assert.throws(() => parseTweetVideos({ id_str: id, mediaDetails: [{ type: "video", video_info: { variants: [{ content_type: "application/x-mpegURL", url: "https://video.twimg.com/video.m3u8" }] } }] }, id), isCode("VIDEO_FORMAT_UNSUPPORTED"));
});

test("video URLs and the single alternate-host fallback cannot escape the trusted MP4 CDN", () => {
  assert.equal(videoSourceFallback(video("high").url), video("high").url.replace("video.twimg.com", "video-s.twimg.com"));
  assert.equal(videoSourceFallback(video("high").url.replace("video.twimg.com", "video-s.twimg.com")), null);
  for (const url of ["https://video.twimg.com.evil/ext_tw_video/a.mp4", "https://127.0.0.1/a.mp4", "https://video.twimg.com:444/ext_tw_video/a.mp4", "http://video.twimg.com/ext_tw_video/a.mp4", "https://user:password@video.twimg.com/ext_tw_video/a.mp4", "https://video.twimg.com/ext_tw_video/a.m3u8", "https://video.twimg.com/dm_video/a.mp4"]) assert.throws(() => videoSourceUrl(url), isCode("VIDEO_SOURCE_INVALID"));
  assert.deepEqual(parseTweetVideos({ id_str: id, mediaDetails: [{ type: "video", video_info: { variants: [video("safe"), { ...video("evil", 9999999), url: "https://evil.example/file.mp4" }] } }] }, id), [{ url: video("safe").url, bitrate: 256_000 }]);
  assert.throws(() => parseTweetVideos({ id_str: id, mediaDetails: Array.from({ length: 5 }, (_, index) => ({ type: "video", video_info: { variants: [video(`item-${index}`)] } })) }, id), isCode("VIDEO_SOURCE_INVALID"));
});

test("public metadata fetching is bounded even without a trustworthy Content-Length", async () => {
  let called = 0;
  const get: typeof fetch = async (url, init) => {
    called += 1;
    assert.equal(String(url), tweetSyndicationUrl(source));
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return Response.json(fixture);
  };
  assert.equal((await fetchTweetVideos(source, { fetch: get })).length, 2);
  assert.equal(called, 1);
  for (const response of [new Response(new Uint8Array(1_000_001)), new Response("{}", { headers: { "Content-Length": "1000001" } })]) {
    await assert.rejects(fetchTweetVideos(source, { fetch: async () => response }), isCode("VIDEO_METADATA_TOO_LARGE"));
  }
  await assert.rejects(fetchTweetVideos(source, { fetch: async () => new Response(null, { status: 302, headers: { Location: "http://localhost/" } }) }), isCode("VIDEO_SOURCE_UNAVAILABLE"));
  await assert.rejects(fetchTweetVideos(source, { fetch: async () => new Response("not-json") }), isCode("VIDEO_SOURCE_INVALID"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchTweetVideos(source, { fetch: get, signal: controller.signal }));
  assert.equal(called, 1);
});
