import assert from "node:assert/strict";
import test from "node:test";

import {
  assetHashFromUri,
  assetUri,
  detectImageMime,
  fetchDocumentAssets,
  handleAssetRequest,
  MAX_ASSET_BYTES,
  MAX_ASSETS_PER_DOCUMENT,
  MAX_DOCUMENT_ASSET_BYTES,
} from "../cloud/assets.js";

function png() {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
}

class MemoryImages {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: new Response(object.bytes).body!,
      size: object.bytes.byteLength,
      httpEtag: `"${key}"`,
      httpMetadata: { contentType: object.contentType },
      async arrayBuffer() { return object.bytes.buffer.slice(object.bytes.byteOffset, object.bytes.byteOffset + object.bytes.byteLength); },
    };
  }
}

test("detectImageMime identifies known image signatures and rejects others", () => {
  assert.equal(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  assert.equal(detectImageMime(png()), "image/png");
  assert.equal(detectImageMime(new Uint8Array([71, 73, 70, 56, 57, 97])), "image/gif");
  assert.equal(detectImageMime(new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])), "image/webp");
  assert.equal(detectImageMime(new TextEncoder().encode("not an image")), null);
});

test("assetUri and assetHashFromUri round-trip a content hash", () => {
  const hash = "a".repeat(64);
  const uri = assetUri(hash);
  assert.equal(uri, `zhiye://asset/${hash}`);
  assert.equal(assetHashFromUri(uri), hash);
  assert.equal(assetHashFromUri("https://example.com/a.png"), null);
});

test("fetchDocumentAssets caches images and rewrites Markdown to zhiye asset URIs", async () => {
  const images = new MemoryImages();
  const firstUrl = "https://example.com/a.png";
  const secondUrl = "https://example.com/b.png";
  const repeated = Array.from({ length: 32 }, (_, index) => `![duplicate-${index}](${firstUrl})`).join("\n");
  const markdown = `${repeated}\n\n![second](${secondUrl})\n\n[^1]: note`;
  const { markdown: rewritten, fetched } = await fetchDocumentAssets(
    { IMAGES: images as never },
    markdown,
    "https://example.com/",
    {
      resolve: async () => {},
      fetch: async (url) => {
        // Distinct bytes per URL so their content hashes differ.
        return { bytes: new Uint8Array(url === firstUrl ? [1] : [2]), mime: "image/png" };
      },
    },
  );

  assert.equal(fetched, 2);
  assert.match(rewritten, /!\[duplicate-0\]\(zhiye:\/\/asset\/[a-f0-9]{64}\)/u);
  assert.match(rewritten, /!\[second\]\(zhiye:\/\/asset\/[a-f0-9]{64}\)/u);
  const keys = [...(images as unknown as { objects: Map<string, unknown> }).objects.keys()];
  assert.equal(keys.length, 2);
  for (const hash of keys) assert.match(hash, /^[a-f0-9]{64}$/u);
  assert.notEqual(keys[0], keys[1]);
});

test("fetchDocumentAssets handles reference images and destinations with parentheses", async () => {
  const images = new MemoryImages();
  const markdown = [
    `![parent [nested]](<https://example.com/image_(one).png> "caption")`,
    "![reference][hero]",
    "",
    '[hero]: https://example.com/hero.png "hero caption"',
  ].join("\n");
  const { markdown: rewritten, fetched } = await fetchDocumentAssets(
    { IMAGES: images as never },
    markdown,
    "https://example.com/",
    {
      resolve: async () => {},
      fetch: async (url) => ({ bytes: new Uint8Array([url.includes("hero") ? 2 : 1]), mime: "image/png" }),
    },
  );

  assert.equal(fetched, 2);
  assert.ok(rewritten.includes("![parent \\[nested\\]](zhiye://asset/"));
  assert.match(rewritten, /zhiye:\/\/asset\/[a-f0-9]{64} "caption"\)/u);
  assert.match(rewritten, /!\[reference\]\(zhiye:\/\/asset\/[a-f0-9]{64} "hero caption"\)/u);
});

test("fetchDocumentAssets leaves failing and internal references untouched", async () => {
  const images = new MemoryImages();
  const markdown = `Keep ![remote](https://example.com/a.png) and ![internal](zhiye://article/00000000-0000-0000-0000-000000000000)`;
  const { markdown: rewritten, fetched } = await fetchDocumentAssets(
    { IMAGES: images as never },
    markdown,
    "https://example.com/",
    { resolve: async () => {}, fetch: async () => { throw new Error("cannot fetch"); } },
  );
  assert.equal(fetched, 0);
  assert.match(rewritten, /!\[remote\]\(https:\/\/example\.com\/a\.png\)/u);
  assert.match(rewritten, /!\[internal\]\(zhiye:\/\/article\/00000000-0000-0000-0000-000000000000\)/u);
});

test("handleAssetRequest serves a cached asset with immutable caching and a content type", async () => {
  const images = new MemoryImages();
  const hash = "b".repeat(64);
  await images.put(hash, png(), { httpMetadata: { contentType: "image/png" } });

  const ok = await handleAssetRequest(images as never, new URL(`https://app.example.com/api/assets/${hash}`));
  assert.ok(ok);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(ok.headers.get("Content-Type"), "image/png");
  assert.ok(ok.headers.get("ETag"));
  assert.equal((await ok.arrayBuffer()).byteLength, png().byteLength);

  const notFound = await handleAssetRequest(images as never, new URL(`https://app.example.com/api/assets/${"c".repeat(64)}`));
  assert.equal(notFound?.status, 404);

  const notAnAsset = await handleAssetRequest(images as never, new URL("https://app.example.com/api/documents"));
  assert.equal(notAnAsset, null);
});

test("fetchDocumentAssets caches every image of a media-heavy document up to the count limit", async () => {
  const images = new MemoryImages();
  // A GIF-heavy article carried 39 images; exceeding the old 32-image ceiling
  // left its tail without a cached copy and therefore unrenderable.
  const count = MAX_ASSETS_PER_DOCUMENT + 6;
  const markdown = Array.from({ length: count }, (_, index) => `![shot-${index}](https://example.com/${index}.png)`).join("\n\n");
  const { markdown: rewritten, fetched } = await fetchDocumentAssets(
    { IMAGES: images as never },
    markdown,
    "https://example.com/",
    { resolve: async () => {}, fetch: async (url) => ({ bytes: new TextEncoder().encode(url), mime: "image/png" }) },
  );

  // Tiny images never fill the byte budget, so the count is the binding limit.
  assert.equal(fetched, MAX_ASSETS_PER_DOCUMENT);
  assert.equal([...rewritten.matchAll(/zhiye:\/\/asset\//gu)].length, MAX_ASSETS_PER_DOCUMENT);
  assert.match(rewritten, /!\[shot-0\]\(zhiye:\/\/asset\//u);
  assert.match(rewritten, new RegExp(`!\\[shot-${MAX_ASSETS_PER_DOCUMENT - 1}\\]\\(zhiye:\\/\\/asset\\/`, "u"));
  assert.match(rewritten, new RegExp(`!\\[shot-${MAX_ASSETS_PER_DOCUMENT}\\]\\(https:\\/\\/example\\.com\\/`, "u"));
});

test("fetchDocumentAssets stops caching once the per-document byte budget is spent", async () => {
  const images = new MemoryImages();
  const markdown = Array.from({ length: 12 }, (_, index) => `![large-${index}](https://example.com/large-${index}.png)`).join("\n\n");
  // One maximum-size buffer, reused: the budget counts `bytes.length`, so a
  // shared instance keeps the test's memory flat while still filling the budget.
  const large = new Uint8Array(MAX_ASSET_BYTES);
  const { fetched } = await fetchDocumentAssets(
    { IMAGES: images as never },
    markdown,
    "https://example.com/",
    {
      resolve: async () => {},
      fetch: async (_url, maxBytes) => {
        if (large.byteLength > maxBytes) throw new Error("RESPONSE_TOO_LARGE");
        return { bytes: large, mime: "image/png" };
      },
    },
  );

  assert.equal(fetched, Math.floor(MAX_DOCUMENT_ASSET_BYTES / MAX_ASSET_BYTES));
});

test("fetchDocumentAssets returns a failed bucket write's reservation to the budget", async () => {
  const markdown = Array.from({ length: 8 }, (_, index) => `![large-${index}](https://example.com/large-${index}.png)`).join("\n\n");
  const large = new Uint8Array(MAX_ASSET_BYTES);
  let writes = 0;
  const images = {
    async put() {
      writes += 1;
      if (writes === 2) throw new Error("R2_WRITE_FAILED");
    },
  };
  const { fetched } = await fetchDocumentAssets(
    { IMAGES: images as never },
    markdown,
    "https://example.com/",
    {
      resolve: async () => {},
      fetch: async (_url, maxBytes) => {
        if (large.byteLength > maxBytes) throw new Error("RESPONSE_TOO_LARGE");
        return { bytes: large, mime: "image/png" };
      },
    },
  );

  // Eight candidates, one failed write: a reservation leaked by the failed
  // write would leave the whole document one image short.
  assert.equal(fetched, Math.floor(MAX_DOCUMENT_ASSET_BYTES / MAX_ASSET_BYTES));
});
