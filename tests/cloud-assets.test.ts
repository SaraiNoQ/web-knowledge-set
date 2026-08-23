import assert from "node:assert/strict";
import test from "node:test";

import {
  assetHashFromUri,
  assetUri,
  detectImageMime,
  fetchDocumentAssets,
  handleAssetRequest,
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
  const markdown = `Intro ![first](${firstUrl}) end\n\n![second](${secondUrl})\n\n[^1]: note`;
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
  assert.match(rewritten, /!\[first\]\(zhiye:\/\/asset\/[a-f0-9]{64}\)/u);
  assert.match(rewritten, /!\[second\]\(zhiye:\/\/asset\/[a-f0-9]{64}\)/u);
  const keys = [...(images as unknown as { objects: Map<string, unknown> }).objects.keys()];
  assert.equal(keys.length, 2);
  for (const hash of keys) assert.match(hash, /^[a-f0-9]{64}$/u);
  assert.notEqual(keys[0], keys[1]);
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
