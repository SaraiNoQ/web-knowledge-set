import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";

import type { AssetMimeType, DocumentAsset } from "../shared/types.js";
import type { KnowledgeDatabase } from "./db.js";
import { safeFetchBinary, type BinaryFetchResult } from "./safe-fetch.js";
import { validateUrl } from "./url-security.js";

export type AssetFetchFunction = (url: string, maxBytes: number) => Promise<BinaryFetchResult>;

const defaultFetchAsset: AssetFetchFunction = (url, maxBytes) => safeFetchBinary(url, { maxBytes });

class AssetCacheError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AssetCacheError";
    this.code = code;
  }
}

export function extractImageUrls(markdown: string, baseUrl: string) {
  interface Node { type: string; url?: string; identifier?: string; children?: Node[] }
  const root = fromMarkdown(markdown) as Node;
  const definitions = new Map<string, string>();
  const candidates: string[] = [];
  const visit = (node: Node, collect: boolean) => {
    if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier, node.url);
    if (collect && node.type === "image" && node.url) candidates.push(node.url);
    if (collect && node.type === "imageReference" && node.identifier) {
      const url = definitions.get(node.identifier);
      if (url) candidates.push(url);
    }
    for (const child of node.children ?? []) visit(child, collect);
  };
  visit(root, false);
  visit(root, true);

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    try {
      const url = validateUrl(new URL(candidate, baseUrl)).href;
      if (url.length > 8192) continue;
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    } catch {
      // Invalid and non-network image sources stay in Markdown but are never requested.
    }
  }
  return urls;
}

export function detectImageMime(body: Uint8Array): AssetMimeType | null {
  const bytes = Buffer.from(body);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 16 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const boxSize = bytes.readUInt32BE(0);
    if (boxSize >= 16 && boxSize <= bytes.length) {
      const brands = [bytes.subarray(8, 12).toString("ascii")];
      for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
        brands.push(bytes.subarray(offset, offset + 4).toString("ascii"));
      }
      if (brands.some((brand) => brand === "avif" || brand === "avis")) return "image/avif";
    }
  }
  return null;
}

function assetFailure(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code).slice(0, 100)
      : "ASSET_CACHE_FAILED";
  const message = error instanceof Error ? error.message : "Image caching failed";
  return { code, message: message.slice(0, 2000) || "Image caching failed" };
}

async function storeAssetFile(db: KnowledgeDatabase, hash: string, body: Buffer) {
  const destination = db.assetFilePath(hash);
  try {
    if (!lstatSync(destination).isFile()) {
      throw new AssetCacheError("ASSET_PATH_UNSAFE", "Asset path is not a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(db.assetsDir, `.asset-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, body, { mode: 0o600, flag: "wx", flush: true });
    await rename(temporary, destination);
    const descriptor = openSync(db.assetsDir, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function cacheDocumentAssets(
  db: KnowledgeDatabase,
  documentId: string,
  markdown: string,
  baseUrl: string,
  fetchAsset: AssetFetchFunction = defaultFetchAsset,
): Promise<DocumentAsset[]> {
  const settings = db.getAssetSettings();
  const urls = extractImageUrls(markdown, baseUrl).slice(0, settings.maxAssetsPerDocument);
  if (!db.prepareDocumentAssets(documentId, urls)) return [];
  const pending = (db.listDocumentAssets(documentId) ?? []).filter(
    (asset) => asset.status === "queued" && urls.includes(asset.sourceUrl),
  );
  let next = 0;
  let receivedBytes = 0;
  let reservedBytes = 0;

  const run = async () => {
    while (next < pending.length) {
      const asset = pending[next++]!;
      if (!db.markAssetFetching(documentId, asset.sourceUrl)) continue;
      try {
        const remaining = settings.maxDocumentAssetBytes - receivedBytes - reservedBytes;
        if (remaining <= 0) {
          throw new AssetCacheError("RESPONSE_TOO_LARGE", "Document images exceed the total cache limit");
        }
        const allocation = Math.min(settings.maxAssetBytes, remaining);
        reservedBytes += allocation;
        let fetched: BinaryFetchResult;
        try {
          fetched = await fetchAsset(asset.sourceUrl, allocation);
          receivedBytes += fetched.body.length;
        } catch (error) {
          receivedBytes += allocation;
          throw error;
        } finally {
          reservedBytes -= allocation;
        }
        if (fetched.body.length > settings.maxAssetBytes) {
          throw new AssetCacheError("RESPONSE_TOO_LARGE", "Image exceeds the per-file cache limit");
        }
        if (receivedBytes > settings.maxDocumentAssetBytes) {
          throw new AssetCacheError("RESPONSE_TOO_LARGE", "Document images exceed the total cache limit");
        }
        const detected = detectImageMime(fetched.body);
        const contentType = fetched.contentType.split(";", 1)[0]?.trim().toLowerCase();
        if (!detected || detected !== contentType) {
          throw new AssetCacheError("UNSUPPORTED_CONTENT_TYPE", "Image Content-Type does not match its file signature");
        }
        const hash = createHash("sha256").update(fetched.body).digest("hex");
        await storeAssetFile(db, hash, fetched.body);
        if (!db.completeAsset(documentId, asset.sourceUrl, hash, detected, fetched.body.length)) {
          throw new AssetCacheError("ASSET_MAPPING_CHANGED", "Image mapping changed while it was cached");
        }
      } catch (error) {
        const failure = assetFailure(error);
        db.failAsset(documentId, asset.sourceUrl, failure.code, failure.message);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(settings.concurrency, pending.length) }, run));
  return db.listDocumentAssets(documentId) ?? [];
}
