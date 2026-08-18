import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { AsyncUnzipInflate, strToU8, Unzip, zip, type UnzipFile } from "fflate";
import { fromMarkdown } from "mdast-util-from-markdown";

import type { AssetMimeType, ImportPreview, KnowledgeDocument } from "../shared/types.js";
import { detectImageMime } from "./assets.js";
import type { ImportPayload, KnowledgeDatabase, PreparedImportItem } from "./db.js";

const FORMAT = "zhiye-portable";
const FORMAT_VERSION = 1;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_DOCUMENTS = 10_000;
const MAX_RATIO = 200;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const mimeExtensions: Record<AssetMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

interface PortableAsset {
  path: string;
  sha256: string;
  mimeType: AssetMimeType;
  sourceUrl: string;
  originalUrl: string;
  byteSize: number;
}

interface PortableDocument {
  id: string;
  path: string;
  sha256: string;
  originalSha256: string;
  title: string;
  sourceUrl: string;
  finalUrl: string | null;
  canonicalUrl: string | null;
  author: string | null;
  publishedAt: string | null;
  capturedAt: string;
  tags: string[];
  collections: string[];
  folder?: string | null;
  favorite: boolean;
  archivedAt: string | null;
  sourceNote: string;
  assets: PortableAsset[];
}

interface PortableManifest {
  format: typeof FORMAT;
  version: typeof FORMAT_VERSION;
  createdAt: string;
  documents: PortableDocument[];
}

interface ParsedPortableDocument extends PortableDocument {
  originalMarkdown: string;
}

export class PortableError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeArchivePath(path: string) {
  if (
    !path || path.length > 1_024 || path.includes("\0") || path.includes("\\") || path.startsWith("/") ||
    /^[a-z]:/iu.test(path) || path.split("/").some((part) =>
      !part || part === "." || part === ".." || ["__proto__", "prototype", "constructor"].includes(part)
    )
  ) throw new PortableError(400, "UNSAFE_ZIP_PATH", "ZIP contains an unsafe path");
}

function slug(title: string, id: string) {
  const value = title.normalize("NFKD").replace(/\p{Mark}/gu, "").toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 80) || "document";
  return `${value}-${id.replaceAll("-", "").slice(0, 8)}`;
}

function rewriteImageUrls(markdown: string, replacement: (url: string) => string | null) {
  interface Node {
    type: string;
    url?: string;
    identifier?: string;
    children?: Node[];
    position?: { start: { offset?: number }; end: { offset?: number } };
  }
  const root = fromMarkdown(markdown) as Node;
  const imageReferences = new Set<string>();
  const linkReferences = new Set<string>();
  const collect = (node: Node) => {
    if (node.type === "imageReference" && node.identifier) imageReferences.add(node.identifier);
    if (node.type === "linkReference" && node.identifier) linkReferences.add(node.identifier);
    for (const child of node.children ?? []) collect(child);
  };
  collect(root);
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const visit = (node: Node) => {
    const eligible = node.type === "image" || (
      node.type === "definition" && node.identifier && imageReferences.has(node.identifier) && !linkReferences.has(node.identifier)
    );
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (eligible && node.url && start !== undefined && end !== undefined) {
      const value = replacement(node.url);
      if (value) {
        const segment = markdown.slice(start, end);
        const delimiter = node.type === "image" ? segment.lastIndexOf("](") : segment.indexOf("]:");
        const relative = delimiter < 0 ? -1 : segment.indexOf(node.url, delimiter + 2);
        if (relative >= 0) edits.push({ start: start + relative, end: start + relative + node.url.length, value });
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  edits.sort((left, right) => right.start - left.start);
  return edits.reduce((value, edit) => `${value.slice(0, edit.start)}${edit.value}${value.slice(edit.end)}`, markdown);
}

function regularFile(path: string) {
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function documentAssets(database: KnowledgeDatabase, document: KnowledgeDocument) {
  return (database.listDocumentAssets(document.id) ?? []).filter(
    (asset): asset is typeof asset & { assetHash: string; mimeType: AssetMimeType; byteSize: number } =>
      asset.status === "ready" && Boolean(asset.assetHash && asset.mimeType && asset.byteSize !== null),
  );
}

function aborted() {
  return new PortableError(499, "REQUEST_ABORTED", "Request was aborted");
}

function asyncZip(entries: Record<string, Uint8Array>, signal?: AbortSignal) {
  return new Promise<Buffer>((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    let terminate: (() => void) | undefined;
    const onAbort = () => {
      terminate?.();
      reject(aborted());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    terminate = zip(entries, { level: 6 }, (error, archive) => {
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(Buffer.from(archive));
    });
  });
}

export async function createPortableBundle(database: KnowledgeDatabase, documentIds?: string[], signal?: AbortSignal) {
  const documents = database.documentsForPortableExport(documentIds);
  const entries: Record<string, Uint8Array> = {};
  const manifestDocuments: PortableDocument[] = [];
  let totalBytes = 0;
  let entryCount = 0;
  const addEntry = (path: string, body: Uint8Array, expectedBytes = body.length) => {
    if (entries[path]) return;
    if (expectedBytes > MAX_ENTRY_BYTES || totalBytes + expectedBytes > MAX_TOTAL_BYTES || entryCount >= MAX_ENTRIES) {
      throw new PortableError(413, "EXPORT_LIMIT", "Portable export exceeds the entry or size limit");
    }
    entries[path] = body;
    totalBytes += body.length;
    entryCount += 1;
  };
  const bodies = new Map<string, Buffer>();
  for (const document of documents) {
    if (signal?.aborted) throw aborted();
    if (manifestDocuments.length >= MAX_DOCUMENTS) throw new PortableError(413, "EXPORT_LIMIT", "Portable export has too many documents");
    if (Buffer.byteLength(document.markdown) > MAX_ENTRY_BYTES) throw new PortableError(413, "EXPORT_LIMIT", "Portable document exceeds the entry size limit");
    const cachedAssets = documentAssets(database, document);
    const bySource = new Map(cachedAssets.map((asset) => [asset.sourceUrl, asset]));
    const assets = new Map<string, PortableAsset>();
    const markdown = rewriteImageUrls(document.markdown, (url) => {
      try {
        const cached = bySource.get(new URL(url, document.finalUrl ?? document.sourceUrl).href);
        if (!cached) return null;
        const path = `assets/${cached.assetHash}-${sha256(url)}.${mimeExtensions[cached.mimeType]}`;
        assets.set(path, { path, sha256: cached.assetHash, mimeType: cached.mimeType, sourceUrl: cached.sourceUrl, originalUrl: url, byteSize: cached.byteSize });
        return `../${path}`;
      }
      catch { return null; }
    });
    if (assets.size > 100) throw new PortableError(413, "EXPORT_LIMIT", "Portable document has too many image references");
    const path = `documents/${slug(document.title, document.id)}.md`;
    const markdownBytes = strToU8(markdown);
    addEntry(path, markdownBytes);
    for (const asset of assets.values()) {
      if (signal?.aborted) throw aborted();
      if (entries[asset.path]) continue;
      if (asset.byteSize > MAX_ENTRY_BYTES || totalBytes + asset.byteSize > MAX_TOTAL_BYTES || entryCount >= MAX_ENTRIES) {
        throw new PortableError(413, "EXPORT_LIMIT", "Portable export exceeds the entry or size limit");
      }
      let body = bodies.get(asset.sha256);
      if (!body) {
        const assetPath = database.assetFilePath(asset.sha256);
        if (!regularFile(assetPath)) throw new PortableError(422, "ASSET_MISSING", `Cached asset is missing: ${asset.sourceUrl}`);
        body = readFileSync(assetPath);
        if (body.length !== asset.byteSize || sha256(body) !== asset.sha256 || detectImageMime(body) !== asset.mimeType) {
          throw new PortableError(422, "ASSET_INVALID", `Cached asset is invalid: ${asset.sourceUrl}`);
        }
        bodies.set(asset.sha256, body);
      }
      addEntry(asset.path, body, asset.byteSize);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    manifestDocuments.push({
      id: document.id,
      path,
      sha256: sha256(markdownBytes),
      originalSha256: sha256(document.markdown),
      title: document.title,
      sourceUrl: document.sourceUrl,
      finalUrl: document.finalUrl,
      canonicalUrl: document.canonicalUrl,
      author: document.author,
      publishedAt: document.publishedAt,
      capturedAt: document.createdAt,
      tags: document.tags,
      collections: document.collections.map(({ name }) => name),
      folder: document.folderId ? database.getFolder(document.folderId)?.name ?? null : null,
      favorite: document.favorite,
      archivedAt: document.archivedAt,
      sourceNote: document.sourceNote,
      assets: [...assets.values()],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const manifest: PortableManifest = {
    format: FORMAT,
    version: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    documents: manifestDocuments,
  };
  if (documentIds && manifestDocuments.length !== documentIds.length) throw new PortableError(404, "DOCUMENT_NOT_FOUND", "One or more selected documents do not exist or are in trash");
  addEntry("manifest.json", strToU8(JSON.stringify(manifest, null, 2)));
  const archive = await asyncZip(entries, signal);
  if (archive.length > MAX_ARCHIVE_BYTES) throw new PortableError(413, "EXPORT_LIMIT", "Portable export exceeds 100 MiB");
  return archive;
}

interface CentralEntry { name: string; compressed: number; uncompressed: number; localOffset: number }

class WorkerUnzipInflate extends AsyncUnzipInflate {
  static compression = 8;

  constructor(name: string, size?: number, _originalSize?: number) {
    // fflate otherwise inflates small compressed inputs synchronously, which is unsafe when ZIP sizes are forged.
    super(name, Math.max(size ?? 0, 320_000));
  }
}

export function inspectPortableZip(archive: Uint8Array) {
  const data = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  if (data.length > MAX_ARCHIVE_BYTES) throw new PortableError(413, "IMPORT_LIMIT", "ZIP exceeds 100 MiB");
  let eocd = data.length - 22;
  while (eocd >= 0 && data.readUInt32LE(eocd) !== 0x06054b50 && data.length - eocd <= 65_557) eocd -= 1;
  if (eocd < 0 || eocd + 22 + data.readUInt16LE(eocd + 20) !== data.length) {
    throw new PortableError(400, "INVALID_ZIP", "ZIP end record is invalid");
  }
  const entriesCount = data.readUInt16LE(eocd + 10);
  const centralSize = data.readUInt32LE(eocd + 12);
  const centralOffset = data.readUInt32LE(eocd + 16);
  if (
    data.readUInt16LE(eocd + 4) || data.readUInt16LE(eocd + 6) ||
    entriesCount !== data.readUInt16LE(eocd + 8) || entriesCount === 0 || entriesCount > MAX_ENTRIES ||
    entriesCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff ||
    centralOffset + centralSize !== eocd
  ) throw new PortableError(400, "INVALID_ZIP", "ZIP structure or entry count is unsupported");
  const entries: CentralEntry[] = [];
  const intervals: Array<{ start: number; end: number }> = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < entriesCount; index += 1) {
    if (offset + 46 > eocd || data.readUInt32LE(offset) !== 0x02014b50) {
      throw new PortableError(400, "INVALID_ZIP", "ZIP central directory is invalid");
    }
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const crc = data.readUInt32LE(offset + 16);
    const compressed = data.readUInt32LE(offset + 20);
    const uncompressed = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const madeBy = data.readUInt16LE(offset + 4) >>> 8;
    const external = data.readUInt32LE(offset + 38);
    const localOffset = data.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || (flags & 9) || ![0, 8].includes(method) || [compressed, uncompressed, localOffset].includes(0xffffffff)) {
      throw new PortableError(400, "INVALID_ZIP", "ZIP entry is unsupported");
    }
    let name: string;
    try {
      name = textDecoder.decode(data.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      throw new PortableError(400, "INVALID_ZIP", "ZIP path is not valid UTF-8");
    }
    safeArchivePath(name);
    if (names.has(name)) throw new PortableError(400, "DUPLICATE_ZIP_PATH", "ZIP contains a duplicate path");
    names.add(name);
    if (((external >>> 16) & 0o170000) === 0o120000) {
      throw new PortableError(400, "ZIP_SYMLINK", "ZIP symbolic links are not allowed");
    }
    total += uncompressed;
    if (
      uncompressed > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES ||
      (uncompressed > 0 && (compressed === 0 || uncompressed / compressed > MAX_RATIO))
    ) throw new PortableError(413, "ZIP_BOMB", "ZIP exceeds decompression limits");
    if (localOffset + 30 > centralOffset || data.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new PortableError(400, "INVALID_ZIP", "ZIP local entry is invalid");
    }
    if (data.readUInt16LE(localOffset + 6) !== flags || data.readUInt16LE(localOffset + 8) !== method) {
      throw new PortableError(400, "INVALID_ZIP", "ZIP local and central entry methods disagree");
    }
    if (
      data.readUInt32LE(localOffset + 14) !== crc ||
      data.readUInt32LE(localOffset + 18) !== compressed ||
      data.readUInt32LE(localOffset + 22) !== uncompressed
    ) throw new PortableError(400, "INVALID_ZIP", "ZIP local and central entry metadata disagree");
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const localName = data.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (
      !localName.equals(data.subarray(offset + 46, offset + 46 + nameLength)) ||
      localOffset + 30 + localNameLength + localExtraLength + compressed > centralOffset
    ) throw new PortableError(400, "INVALID_ZIP", "ZIP local and central entries disagree");
    intervals.push({ start: localOffset, end: localOffset + 30 + localNameLength + localExtraLength + compressed });
    entries.push({ name, compressed, uncompressed, localOffset });
    offset = end;
  }
  intervals.sort((left, right) => left.start - right.start);
  if (intervals.some((interval, index) => index > 0 && interval.start < intervals[index - 1]!.end)) {
    throw new PortableError(400, "INVALID_ZIP", "ZIP local entries overlap");
  }
  if (offset !== eocd) throw new PortableError(400, "INVALID_ZIP", "ZIP central directory length is invalid");
  return entries;
}

async function unzipPortable(archive: Uint8Array, entries: CentralEntry[], signal?: AbortSignal) {
  if (signal?.aborted) throw aborted();
  const expected = new Map(entries.map((entry) => [entry.name, entry]));
  const files: Record<string, Uint8Array> = {};
  const active = new Set<UnzipFile>();
  const queued: UnzipFile[] = [];
  let completed = 0;
  let total = 0;
  let settled = false;
  let feedFinished = false;
  let resolveDone!: (files: Record<string, Uint8Array>) => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  void done.catch(() => undefined);
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    for (const file of active) file.terminate();
    for (const file of queued) file.terminate();
    queued.length = 0;
    rejectDone(error);
  };
  const onAbort = () => fail(aborted());
  signal?.addEventListener("abort", onAbort, { once: true });
  const finishOrStart = () => {
    if (settled) return;
    while (active.size < 4 && queued.length) {
      const next = queued.shift()!;
      active.add(next);
      next.start();
    }
    if (completed === entries.length) {
      settled = true;
      resolveDone(files);
    } else if (feedFinished && active.size === 0 && queued.length === 0) {
      fail(new PortableError(400, "INVALID_ZIP", "ZIP output is missing entries"));
    }
  };
  const unzipper = new Unzip((file) => {
    const entry = expected.get(file.name);
    if (!entry || files[file.name]) return fail(new PortableError(400, "INVALID_ZIP", "ZIP output does not match its central directory"));
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (settled) return;
      if (error) return fail(new PortableError(400, "INVALID_ZIP", "ZIP could not be decompressed"));
      size += chunk.length;
      total += chunk.length;
      if (size > entry.uncompressed || size > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) {
        return fail(new PortableError(413, "ZIP_BOMB", "ZIP actual output exceeds decompression limits"));
      }
      chunks.push(chunk);
      if (!final) return;
      active.delete(file);
      if (size !== entry.uncompressed) return fail(new PortableError(400, "INVALID_ZIP", "ZIP output size does not match its central directory"));
      files[file.name] = Buffer.concat(chunks.map((value) => Buffer.from(value)), size);
      completed += 1;
      finishOrStart();
    };
    queued.push(file);
    finishOrStart();
  });
  unzipper.register(WorkerUnzipInflate);
  try {
    for (let offset = 0; offset < archive.length && !settled; offset += 64 * 1024) {
      if (signal?.aborted) throw aborted();
      const end = Math.min(offset + 64 * 1024, archive.length);
      unzipper.push(archive.subarray(offset, end), end === archive.length);
      if (end === archive.length) {
        feedFinished = true;
        finishOrStart();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return await done;
  } catch (error) {
    fail(error);
    return await done;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function stringValue(value: unknown, field: string, max = 50_000) {
  if (typeof value !== "string" || !value || value.length > max) throw new PortableError(400, "INVALID_MANIFEST", `${field} is invalid`);
  return value;
}

function nullableString(value: unknown, field: string, max = 50_000) {
  return value === null ? null : stringValue(value, field, max);
}

function sourceUrlValue(value: unknown, field: string, nullable = false) {
  if (value === null && nullable) return null;
  const url = stringValue(value, field, 8_192);
  try {
    const parsed = new URL(url);
    if (!["http:", "https:", "zhiye:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
  } catch {
    throw new PortableError(400, "INVALID_MANIFEST", `${field} is invalid`);
  }
  return url;
}

function namesValue(value: unknown, field: "tags" | "collections") {
  const limit = field === "tags" ? 50 : 100;
  if (!Array.isArray(value) || value.length > limit) throw new PortableError(400, "INVALID_MANIFEST", `${field} is invalid`);
  const names = value.map((name) => stringValue(name, field, 100).normalize("NFKC").trim());
  if (names.some((name) => !name) || new Set(names.map((name) => name.toLocaleLowerCase())).size !== names.length) {
    throw new PortableError(400, "INVALID_MANIFEST", `${field} contains invalid or duplicate names`);
  }
  return names;
}

function folderValue(value: unknown) {
  if (value === null) return null;
  const name = stringValue(value, "folder", 100).normalize("NFKC").trim();
  if (!name || name.length > 100 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(name)) {
    throw new PortableError(400, "INVALID_MANIFEST", "folder is invalid");
  }
  return name;
}

function hashValue(value: unknown, field: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new PortableError(400, "INVALID_MANIFEST", `${field} is invalid`);
  return value;
}

async function parseManifest(files: Record<string, Uint8Array>, signal?: AbortSignal) {
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new PortableError(400, "MANIFEST_MISSING", "manifest.json is missing");
  let raw: unknown;
  try {
    raw = JSON.parse(textDecoder.decode(manifestBytes));
  } catch {
    throw new PortableError(400, "INVALID_MANIFEST", "manifest.json is not valid UTF-8 JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PortableError(400, "INVALID_MANIFEST", "Manifest must be an object");
  const input = raw as Record<string, unknown>;
  if (input.format !== FORMAT || input.version !== FORMAT_VERSION || !Array.isArray(input.documents) || input.documents.length > MAX_DOCUMENTS) {
    throw new PortableError(400, "UNSUPPORTED_BUNDLE", "Portable bundle format or version is unsupported");
  }
  stringValue(input.createdAt, "createdAt", 50);
  const expected = new Set(["manifest.json"]);
  const documents: ParsedPortableDocument[] = [];
  for (const [index, value] of input.documents.entries()) {
    if (signal?.aborted) throw aborted();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PortableError(400, "INVALID_MANIFEST", `documents[${index}] is invalid`);
    const document = value as Record<string, unknown>;
    const path = stringValue(document.path, "document.path", 1_024);
    safeArchivePath(path);
    if (!/^documents\/[^/]+\.md$/u.test(path) || expected.has(path)) throw new PortableError(400, "INVALID_MANIFEST", "Document path is invalid or duplicated");
    expected.add(path);
    const markdown = files[path];
    if (!markdown || sha256(markdown) !== hashValue(document.sha256, "document.sha256")) throw new PortableError(400, "CHECKSUM_MISMATCH", `Document checksum mismatch: ${path}`);
    let exportedMarkdown: string;
    try { exportedMarkdown = textDecoder.decode(markdown); }
    catch { throw new PortableError(400, "INVALID_MARKDOWN", `Document is not valid UTF-8: ${path}`); }
    const documentSourceUrl = sourceUrlValue(document.sourceUrl, "document.sourceUrl")!;
    const documentFinalUrl = sourceUrlValue(document.finalUrl, "document.finalUrl", true);
    const assetsInput = document.assets;
    if (!Array.isArray(assetsInput) || assetsInput.length > 100) throw new PortableError(400, "INVALID_MANIFEST", "Document assets are invalid");
    const canonicalAssets = new Map<string, string>();
    const assets = assetsInput.map((assetValue) => {
      if (!assetValue || typeof assetValue !== "object" || Array.isArray(assetValue)) throw new PortableError(400, "INVALID_MANIFEST", "Asset metadata is invalid");
      const asset = assetValue as Record<string, unknown>;
      const assetPath = stringValue(asset.path, "asset.path", 1_024);
      safeArchivePath(assetPath);
      if (!/^assets\/[a-f0-9]{64}-[a-f0-9]{64}\.(?:jpg|png|gif|webp|avif)$/u.test(assetPath)) throw new PortableError(400, "INVALID_MANIFEST", "Asset path is invalid");
      expected.add(assetPath);
      const body = files[assetPath];
      const digest = hashValue(asset.sha256, "asset.sha256");
      const mimeType = asset.mimeType as AssetMimeType;
      if (
        !Number.isSafeInteger(asset.byteSize) || (asset.byteSize as number) < 0 ||
        assetPath.slice(7, 71) !== digest || !body || sha256(body) !== digest ||
        body.length !== asset.byteSize || detectImageMime(body) !== mimeType || !mimeExtensions[mimeType]
      ) {
        throw new PortableError(400, "CHECKSUM_MISMATCH", `Asset is missing, invalid, or has a checksum mismatch: ${assetPath}`);
      }
      const sourceUrl = sourceUrlValue(asset.sourceUrl, "asset.sourceUrl")!;
      const originalUrl = stringValue(asset.originalUrl, "asset.originalUrl", 8_192);
      try {
        if (new URL(originalUrl, documentFinalUrl ?? documentSourceUrl).href !== sourceUrl) throw new Error();
      } catch {
        throw new PortableError(400, "INVALID_MANIFEST", "Asset originalUrl does not resolve to sourceUrl");
      }
      const metadata = `${digest}\0${mimeType}\0${body.length}`;
      if (canonicalAssets.has(sourceUrl) && canonicalAssets.get(sourceUrl) !== metadata) {
        throw new PortableError(400, "INVALID_MANIFEST", "One asset sourceUrl has conflicting metadata");
      }
      canonicalAssets.set(sourceUrl, metadata);
      return {
        path: assetPath,
        sha256: digest,
        mimeType,
        sourceUrl,
        originalUrl,
        byteSize: body.length,
      };
    });
    const capturedAt = stringValue(document.capturedAt, "document.capturedAt", 50);
    const archivedAt = nullableString(document.archivedAt, "document.archivedAt", 50);
    const publishedAt = nullableString(document.publishedAt, "document.publishedAt", 50);
    const folder = Object.hasOwn(document, "folder") ? folderValue(document.folder) : undefined;
    if (!Number.isFinite(Date.parse(capturedAt)) || (archivedAt && !Number.isFinite(Date.parse(archivedAt)))) {
      throw new PortableError(400, "INVALID_MANIFEST", "Document dates are invalid");
    }
    if (publishedAt && (
      !/^\d{4}-\d{2}-\d{2}$/u.test(publishedAt) ||
      new Date(`${publishedAt}T00:00:00.000Z`).toISOString().slice(0, 10) !== publishedAt
    )) throw new PortableError(400, "INVALID_MANIFEST", "publishedAt is invalid");
    const restoredMarkdown = rewriteImageUrls(
      exportedMarkdown,
      (url) => assets.find(({ path: assetPath }) => url === `../${assetPath}`)?.originalUrl ?? null,
    );
    if (sha256(restoredMarkdown) !== hashValue(document.originalSha256, "document.originalSha256")) {
      throw new PortableError(400, "CHECKSUM_MISMATCH", "Restored Markdown checksum mismatch");
    }
    documents.push({
      id: stringValue(document.id, "document.id", 200), path,
      sha256: document.sha256 as string, originalSha256: document.originalSha256 as string,
      title: stringValue(document.title, "document.title", 1_000),
      sourceUrl: documentSourceUrl,
      finalUrl: documentFinalUrl,
      canonicalUrl: sourceUrlValue(document.canonicalUrl, "document.canonicalUrl", true),
      author: nullableString(document.author, "document.author", 1_000),
      publishedAt, capturedAt,
      tags: namesValue(document.tags, "tags"), collections: namesValue(document.collections, "collections"),
      ...(folder === undefined ? {} : { folder }),
      favorite: typeof document.favorite === "boolean" ? document.favorite : (() => { throw new PortableError(400, "INVALID_MANIFEST", "favorite is invalid"); })(), archivedAt,
      sourceNote: typeof document.sourceNote === "string" && document.sourceNote.length <= 50_000 ? document.sourceNote : (() => { throw new PortableError(400, "INVALID_MANIFEST", "sourceNote is invalid"); })(),
      assets,
      originalMarkdown: restoredMarkdown,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (expected.size !== Object.keys(files).length || Object.keys(files).some((path) => !expected.has(path))) {
    throw new PortableError(400, "UNEXPECTED_ZIP_ENTRY", "ZIP contains files not declared by the manifest");
  }
  return { documents, assetPaths: [...new Set(documents.flatMap(({ assets }) => assets.map(({ path }) => path)))] };
}

export async function stagePortableBundle(database: KnowledgeDatabase, archive: Uint8Array, signal?: AbortSignal): Promise<ImportPreview> {
  const inspected = inspectPortableZip(archive);
  const files = await unzipPortable(archive, inspected, signal);
  if (Object.keys(files).length !== inspected.length) throw new PortableError(400, "INVALID_ZIP", "ZIP entries changed during decompression");
  const parsed = await parseManifest(files, signal);
  if (signal?.aborted) throw aborted();
  const stagingName = database.createImportStaging();
  const stagingPath = database.importStagingPath(stagingName);
  try {
    const stagedHashes = new Set<string>();
    for (const path of parsed.assetPaths) {
      if (signal?.aborted) throw aborted();
      const asset = parsed.documents.flatMap(({ assets }) => assets).find((candidate) => candidate.path === path)!;
      if (stagedHashes.has(asset.sha256)) continue;
      writeFileSync(join(stagingPath, asset.sha256), files[path]!, { mode: 0o600, flag: "wx", flush: true });
      stagedHashes.add(asset.sha256);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const descriptor = openSync(stagingPath, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    const items: PreparedImportItem[] = parsed.documents.map((document) => ({
      label: document.title,
      sourceUrl: document.sourceUrl,
      warnings: [],
      error: null,
      payload: {
        type: "markdown",
        title: document.title,
        sourceUrl: document.sourceUrl,
        finalUrl: document.finalUrl,
        canonicalUrl: document.canonicalUrl,
        author: document.author,
        publishedAt: document.publishedAt,
        capturedAt: document.capturedAt,
        tags: document.tags,
        collections: document.collections,
        ...(document.folder === undefined ? {} : { folder: document.folder }),
        favorite: document.favorite,
        archivedAt: document.archivedAt,
        sourceNote: document.sourceNote,
        markdown: document.originalMarkdown,
        assets: [...new Map(document.assets.map((asset) => [asset.sourceUrl, asset])).values()],
      } satisfies Extract<ImportPayload, { type: "markdown" }>,
    }));
    return database.createImportBatch("bundle", items, { stagingPath: stagingName, assetCount: stagedHashes.size });
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

export function promotePortableAssets(database: KnowledgeDatabase, batchId: string) {
  const staging = database.getImportBundleStaging(batchId);
  if (!staging) return [];
  const created: string[] = [];
  try {
    for (const name of readdirSync(staging)) {
      if (!/^[a-f0-9]{64}$/u.test(name) || name !== basename(name)) throw new PortableError(422, "STAGING_INVALID", "Bundle staging contains an unsafe file");
      const source = join(staging, name);
      if (!lstatSync(source).isFile()) throw new PortableError(422, "STAGING_INVALID", "Bundle staging entry is not a regular file");
      const body = readFileSync(source);
      if (sha256(body) !== name || !detectImageMime(body)) throw new PortableError(422, "STAGING_INVALID", "Bundle staging asset changed after preview");
      const destination = database.assetFilePath(name);
      if (regularFile(destination)) {
        if (sha256(readFileSync(destination)) !== name) throw new PortableError(422, "ASSET_INVALID", "Existing asset file is invalid");
        continue;
      }
      const temporary = join(database.assetsDir, `.asset-${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, body, { mode: 0o600, flag: "wx", flush: true });
        renameSync(temporary, destination);
        created.push(name);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
  } catch (error) {
    for (const hash of created) rmSync(database.assetFilePath(hash), { force: true });
    throw error;
  }
  const descriptor = openSync(database.assetsDir, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  return created;
}
